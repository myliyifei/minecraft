import { BlockType, blockDrop, blockStateKind, isOpaque, type BlockEdit } from './block';
import {
  blockStateFromRecord,
  blockStateRecord,
  initialBlockState,
  type BlockState,
  type BlockStateEntry,
  type BlockStateView,
} from './block-state';
import { Chunk } from './chunk';
import { CHUNK_SHIFT, CHUNK_SIZE, MAX_LIGHT_LEVEL, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';
import type { DropSink } from './drop';
import { BARE_HAND } from './item';
import { Lighting } from './light';
import type { BlockStateRecord, ChunkRecord } from './snapshot';
import { TORCH_ATTACH_OFFSETS, isTorch, torchSupportCell } from './torch';

export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
}

/**
 * 自上次取走以来网格过期了的区块，按原因分两组（见 `World.takeStaleChunks`）。
 *
 * 分开报是因为两者等得起的时间不同：方块变了的区块不当帧重建，放下的方块要晚几帧才出现，挖掉的方块那里会
 * 透出一个洞；只有光照变了的区块推迟几帧，画面上只是那几帧还是旧的明暗（#62）。
 */
export interface StaleChunks {
  /** 方块变了、网格的面跟着变的区块。 */
  readonly blocks: readonly ChunkCoord[];
  /** 只有光照变了的区块，不含 `blocks` 里已有的。 */
  readonly light: readonly ChunkCoord[];
}

/**
 * 区块的来源。
 *
 * 返回 `undefined` 表示「这个区块还没准备好」，核心不当作错误，下一个 tick 再问一次。
 * 浏览器里区块由 Web Worker 生成，主线程问的时候往往还没生成好；测试与 Node 里
 * 同一个地形函数当场就能给出区块（`TerrainGenerator` 因此天然是一种区块来源）。
 * 无论哪一种，同一个种子与区块坐标给出的内容都必须一样——见 ADR-0003。
 */
export type ChunkSource = (cx: number, cz: number) => Chunk | undefined;

/**
 * 由种子造出区块来源。
 * 核心只认这个类型，因此换地形算法（测试用的假地形、将来的多群系地形）或者换生成的
 * 去处（Worker）都不必改动核心的接线。
 */
export type ChunkSourceFactory = (seed: number) => ChunkSource;

/**
 * 已加载区块的集合，按世界坐标读写方块。
 *
 * 未加载的区块视为边界：读到空气，写入被丢弃。这与连锁挖掘「未加载区块视为边界」
 * 的规则一致，也让区块流式加载不必给读写路径加特例。
 *
 * 玩家改过的区块卸载之后仍由世界持有（见 `editedChunks` 与 ADR-0008）。方块的额外状态
 * （熔炉里的东西）存在世界的一张按坐标索引的表里，不进区块数据（见 `blockStates` 与 ADR-0011）。
 */
export class World implements BlockEdit, BlockStateView {
  private readonly chunks = new Map<number, Chunk>();
  /**
   * 玩家改过的区块，卸载之后仍留在这里。这条规则本身见 CONTEXT.md 的「已改区块」。
   *
   * 里面的区块与 `chunks` 里的是同一个对象：`loadChunk` 把留着的那一份放回 `chunks`，
   * 因此后来的写入改的仍是这一份。
   *
   * 一个区块 96KB，这张表只增不减：丢掉哪一个都等于丢掉玩家的修改。为什么留整块而不是
   * 只留那几处改动、为什么不给它设上限，见 ADR-0008。
   */
  private readonly editedChunks = new Map<number, Chunk>();
  /**
   * 上次写盘之后改过的区块（ADR-0018），按区块键去重。存档只写这些，不写全部已改区块。
   *
   * 与 `editedChunks` 分开：那张表只增不减，这一张每次取快照时取走清空（`takeUnsavedChunks`），写盘失败时
   * 放回（`returnUnsavedChunks`）。由 `setBlock` 在方块真的变了时登记，与 `editedChunks` 同一处。
   */
  private readonly unsavedChunks = new Map<number, ChunkCoord>();
  /**
   * 自上次取走以来方块变了的区块，按区块键去重（见 `StaleChunks.blocks`）。
   *
   * 由 `setBlock` 记：方块自己的区块一定在里面；它坐在区块边界上、而且隔壁的面因它而变（它从挡住隔壁的面
   * 变成不挡，或者反过来，见 `faceCulling`）时，那一侧的邻居也在里面——只重建自己就会在挖开的地方留下一个
   * 看穿到虚空的洞，或者留下一堵本该消失的墙。只记四个侧向的邻居，不记斜角：面的剔除只问六个轴向的邻居。
   *
   * 没加载的邻居也记：要不要重建网格由渲染层判断。没人来取时记录会一直累积——浏览器里渲染层
   * 每帧取一次（见 `WorldRenderer.syncChunkMeshes`），核心层测试里世界是一次性的。
   */
  private readonly staleBlocks = new Map<number, ChunkCoord>();
  /**
   * 自上次取走以来光照变过的区块（见 `StaleChunks.light`），规则同上。
   *
   * `Lighting` 经 `markStale` 记（ADR-0017）：光照变了的那一格的区块，它在区块边缘 1 格内时含对角在内挨着它的
   * 区块——平滑光照读对角格。`setBlock` 带来的光照变化、新区块加载时传进邻居的光、区块卸载时从邻居撤掉的光
   * 都走这条路。
   */
  private readonly staleLight = new Map<number, ChunkCoord>();
  /**
   * 方块状态表（见 CONTEXT.md 的「方块状态」、ADR-0011）：键是世界坐标，值是那一格方块的额外状态。
   *
   * 由 `setBlock` 维护：放下带状态的方块建一条，换成别的方块删一条，同一种状态的两个编号之间
   * 切换（熄火与燃烧中的熔炉）那条不动。区块卸载不删这里的条目——带状态的方块一定是玩家放的，
   * 那个区块因此是已改区块，卸载后整块留着（ADR-0008），走回来时方块与状态都还在。
   *
   * 键用 `"x,y,z"` 字符串而不是像 `chunkKey` 那样打包成数字：放下、挖掉每 tick 最多几次，不是网格生成
   * 那种每帧几十万次的热路径，而三个无界的整数打包成安全整数并不划算。值连坐标一起存（`BlockStateEntry`），
   * 每 tick 推进熔炉（`loadedBlockStates`）时不必再从键里解出坐标。
   */
  private readonly blockStates = new Map<string, BlockStateEntry>();
  private readonly source: ChunkSource;
  /**
   * 支撑没了的火把变成的掉落物交给谁（见 `dropDetachedTorches`）。核心里是 `Drops`；只测方块与光照的
   * 世界不接，那时火把照样改成空气，只是没有掉落物。
   */
  private readonly drops: DropSink;
  /** 光照的计算（ADR-0017）。光照数组本身在各区块上，这里只有算法与它的工作量计数。 */
  private readonly lighting: Lighting;

  constructor(source: ChunkSource, drops: DropSink = NO_DROPS) {
    this.source = source;
    this.drops = drops;
    this.lighting = new Lighting({
      chunkAt: (cx, cz) => this.chunks.get(chunkKey(cx, cz)),
      markStale: (cx, cz) => this.staleLight.set(chunkKey(cx, cz), { cx, cz }),
    });
  }

  /** 光照传播访问过的格子数，只增不减（见 `Lighting.visits`）。工作量测试用它。 */
  get lightVisits(): number {
    return this.lighting.visits;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  loadedChunks(): ChunkCoord[] {
    return [...this.chunks.values()].map(({ cx, cz }) => ({ cx, cz }));
  }

  /**
   * 卸载所有离中心区块超过 keepRadius 的区块（切比雪夫距离，即方形范围之外）。
   * 多远算太远由流式加载决定，见 `streamChunks`；这里只负责走一遍自己那张表。
   */
  unloadOutside(center: ChunkCoord, keepRadius: number): void {
    for (const { cx, cz } of this.chunks.values()) {
      const distance = Math.max(Math.abs(cx - center.cx), Math.abs(cz - center.cz));
      if (distance > keepRadius) this.unloadChunk(cx, cz);
    }
  }

  isChunkLoaded(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** 已加载的区块，未加载则 undefined。网格生成要直读区块数据。 */
  chunkAt(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /**
   * 加载区块。
   *
   * 已加载则原样返回，不向来源重新要一份，玩家的修改因此不会被覆盖。改过又卸载了的区块
   * 复用留着的那一份，同样不问来源——浏览器里因此连 Worker 都不必跑一趟，玩家走回来
   * 那一格当场就在。来源说「还没准备好」时返回 undefined，世界保持不变。
   */
  loadChunk(cx: number, cz: number): Chunk | undefined {
    const key = chunkKey(cx, cz);
    const loaded = this.chunks.get(key);
    if (loaded) return loaded;
    const chunk = this.editedChunks.get(key) ?? this.source(cx, cz);
    if (!chunk) return undefined;
    this.chunks.set(key, chunk);
    this.lighting.chunkLoaded(chunk);
    return chunk;
  }

  /**
   * 卸载区块。
   * 改过的区块只是不再算「已加载」，数据仍留在 `editedChunks` 里；没改过的到这里就
   * 没人引用了，交给垃圾回收。两者的光照数组都丢掉（ADR-0017），它传给邻居的光也撤掉：
   * 没加载的格子不贡献光。
   */
  unloadChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    this.lighting.chunkUnloaded(chunk);
    chunk.discardLight();
  }

  getBlock(x: number, y: number, z: number): BlockType {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return BlockType.Air;
    return chunk.get(localOf(bx), by, localOf(bz));
  }

  /**
   * 某一列最高的非空气方块的 y。整列都是空气（或区块未加载）时返回 WORLD_MIN_Y − 1。
   */
  highestBlockY(x: number, z: number): number {
    for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
      if (this.getBlock(x, y, z) !== BlockType.Air) return y;
    }
    return WORLD_MIN_Y - 1;
  }

  /**
   * 写入方块。返回值表示这次写入是否落到了世界里：
   * 坐标所在区块未加载、或 y 超出世界高度时不做任何事并返回 false。
   *
   * 一格从不透明方块换成非不透明方块（挖掉、换成树叶）之后，贴着它的火把在原位变成掉落物（`dropDetachedTorches`）。
   * 连锁挖掘逐块写入，自然覆盖。
   */
  setBlock(x: number, y: number, z: number, block: BlockType): boolean {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    if (by < WORLD_MIN_Y || by > WORLD_MAX_Y) return false;
    const key = chunkKey(chunkOf(bx), chunkOf(bz));
    const chunk = this.chunks.get(key);
    if (!chunk) return false;
    const lx = localOf(bx);
    const lz = localOf(bz);
    // 写成同样的方块不算变过：网格没必要为一次空写重建。
    const previous = chunk.get(lx, by, lz);
    if (previous === block) return true;
    chunk.set(lx, by, lz, block);
    this.syncBlockState(bx, by, bz, previous, block);
    // 这一下让它成了已改区块，卸载后不再丢弃；下次写盘要写它。
    this.editedChunks.set(key, chunk);
    this.unsavedChunks.set(key, { cx: chunk.cx, cz: chunk.cz });
    this.markStale(bx, bz, previous, block);
    // 同步更新光照，不等下一 tick：同一 tick 之后的步骤读到的就是新值（ADR-0017）。
    this.lighting.blockChanged(chunk, lx, by, lz, previous, block);
    if (isOpaque(previous) && !isOpaque(block)) this.dropDetachedTorches(bx, by, bz);
    return true;
  }

  /**
   * (x, y, z) 那一格刚不再是不透明方块：上方与四侧贴着它的火把（见 CONTEXT.md 的「火把」）各改成空气，
   * 在原位掉出一支火把。改成空气走 `setBlock`，光照随之更新。要求整数输入。
   *
   * 只在「不透明 → 非不透明」时查：火把只放得上不透明方块，原本就不是不透明的那一格上不会贴着火把。
   */
  private dropDetachedTorches(x: number, y: number, z: number): void {
    for (const offset of TORCH_ATTACH_OFFSETS) {
      const tx = x + offset.x;
      const ty = y + offset.y;
      const tz = z + offset.z;
      const torch = this.getBlock(tx, ty, tz);
      const support = torchSupportCell(torch, tx, ty, tz);
      if (!support || support.x !== x || support.y !== y || support.z !== z) continue;
      if (!this.setBlock(tx, ty, tz, BlockType.Air)) continue;
      const drop = blockDrop(torch, BARE_HAND);
      if (drop) this.drops.spawnInBlock(drop, tx, ty, tz);
    }
  }

  blockStateAt(x: number, y: number, z: number): BlockState | undefined {
    return this.blockStates.get(blockKey(Math.floor(x), Math.floor(y), Math.floor(z)))?.state;
  }

  /** 状态表里有几条。调试句柄与测试用它确认放下、挖掉之后表的增减。 */
  get blockStateCount(): number {
    return this.blockStates.size;
  }

  /** 整张状态表：每一条带着它的世界坐标。调试句柄读它看世界里有哪些带状态的方块。 */
  allBlockStates(): BlockStateEntry[] {
    return [...this.blockStates.values()];
  }

  /**
   * 整张状态表按快照的形状给出（`BlockStateRecord`）：不带种类，物品堆与进度是复制出来的值，之后熔炉怎么烧
   * 都不影响它。
   */
  blockStateRecords(): BlockStateRecord[] {
    return [...this.blockStates.values()].map(({ x, y, z, state }) => ({ x, y, z, state: blockStateRecord(state) }));
  }

  /**
   * 取走上次写盘之后改过的那些区块并清空记录，每个复制一份方块数组。只复制这些而不是全部已改区块，
   * 取快照的同步耗时因此与改过的区块数成正比（ADR-0018）。
   */
  takeUnsavedChunks(): ChunkRecord[] {
    const records: ChunkRecord[] = [];
    for (const [key, { cx, cz }] of this.unsavedChunks) {
      // 登记过的一定在已改区块表里：两张表在 `setBlock` 的同一处写，已改区块表只增不减。
      records.push({ cx, cz, blocks: this.editedChunks.get(key)!.blocks.slice() });
    }
    this.unsavedChunks.clear();
    return records;
  }

  /** 上次写盘之后改过的区块有几个。 */
  get unsavedChunkCount(): number {
    return this.unsavedChunks.size;
  }

  /** 写盘失败时把那次取走的区块放回去，下次写盘再写。不是已改区块的坐标不登记。 */
  returnUnsavedChunks(coords: readonly ChunkCoord[]): void {
    for (const { cx, cz } of coords) {
      const key = chunkKey(cx, cz);
      if (this.editedChunks.has(key)) this.unsavedChunks.set(key, { cx, cz });
    }
  }

  /**
   * 从快照放回存档里的全部已改区块与方块状态表（ADR-0018）。构造之后、加载任何区块之前调：放回的区块进已改
   * 区块表，加载时就复用它们，不向来源要。放回的不算上次写盘之后改过的：它们就是从盘上读出来的。
   *
   * 方块数组直接接管，不复制。状态表的每一条按那一格在已改区块里的方块编号补回种类；那一格不是带状态的方块
   * （存档与方块对不上）时那一条丢掉：带状态的方块被换掉时，状态表本来就会删掉那一条。
   */
  restore(chunks: readonly ChunkRecord[], states: readonly BlockStateRecord[]): void {
    for (const { cx, cz, blocks } of chunks) {
      this.editedChunks.set(chunkKey(cx, cz), new Chunk(cx, cz, blocks));
    }
    for (const { x, y, z, state: record } of states) {
      const chunk = this.editedChunks.get(chunkKey(chunkOf(x), chunkOf(z)));
      if (!chunk) continue;
      const state = blockStateFromRecord(chunk.get(localOf(x), y, localOf(z)), record);
      if (state) this.blockStates.set(blockKey(x, y, z), { x, y, z, state });
    }
  }

  /**
   * 所在区块已加载的那些状态表条目。熔炉每 tick 按它推进（`stepFurnaces`）：卸载了的区块里的熔炉
   * 不在其中，暂停到区块重新加载。
   *
   * 逐条判区块而不是按区块分桶：整张表也就几十条，每 tick 走一遍的开销可以忽略。
   */
  *loadedBlockStates(): IterableIterator<BlockStateEntry> {
    for (const entry of this.blockStates.values()) {
      if (this.isChunkLoaded(chunkOf(entry.x), chunkOf(entry.z))) yield entry;
    }
  }

  /**
   * 一格从 `previous` 换成 `block` 之后状态表该怎么改：种类没变就不动（熄火的熔炉点着了，
   * 里面的东西还在）；变了就删掉旧种类那条、给新种类建一条空的。没有状态的方块（`None`）
   * 两头都什么都不做。
   */
  private syncBlockState(x: number, y: number, z: number, previous: BlockType, block: BlockType): void {
    if (blockStateKind(previous) === blockStateKind(block)) return;
    const key = blockKey(x, y, z);
    const state = initialBlockState(block);
    if (state) this.blockStates.set(key, { x, y, z, state });
    else this.blockStates.delete(key);
  }

  /**
   * (bx, bz) 那一列的一格从 `previous` 换成了 `block`：它的区块的方块变了；它坐在区块边界上、隔壁的面又因此而变时，
   * 那一侧的邻居也算方块变了（见 `staleBlocks`）。要求整数输入。
   */
  private markStale(bx: number, bz: number, previous: BlockType, block: BlockType): void {
    const cx = chunkOf(bx);
    const cz = chunkOf(bz);
    this.markBlocksStale(cx, cz);
    if (faceCulling(previous) === faceCulling(block)) return;
    const lx = localOf(bx);
    const lz = localOf(bz);
    if (lx === 0) this.markBlocksStale(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this.markBlocksStale(cx + 1, cz);
    if (lz === 0) this.markBlocksStale(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markBlocksStale(cx, cz + 1);
  }

  private markBlocksStale(cx: number, cz: number): void {
    this.staleBlocks.set(chunkKey(cx, cz), { cx, cz });
  }

  /**
   * 取走「哪些区块的网格过期了」的记录并清空。渲染层每帧取一次，重建其中已有网格的那些：方块变了的当帧重建，
   * 只有光照变了的可以推迟（见 `planChunkMeshes`）。
   */
  takeStaleChunks(): StaleChunks {
    const blocks = [...this.staleBlocks.values()];
    const light: ChunkCoord[] = [];
    for (const [key, coord] of this.staleLight) {
      if (!this.staleBlocks.has(key)) light.push(coord);
    }
    this.staleBlocks.clear();
    this.staleLight.clear();
    return { blocks, light };
  }

  /**
   * (x, y, z) 那一格的天光等级（见 CONTEXT.md 的「天光」），坐标按 floor 取整。
   *
   * 没加载的格子读作 0。世界最高一层之上是天空，已加载的那一列在那里读作 15。
   */
  skyLightAt(x: number, y: number, z: number): number {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return 0;
    if (by > WORLD_MAX_Y) return MAX_LIGHT_LEVEL;
    return chunk.skyLight(localOf(bx), by, localOf(bz));
  }

  /**
   * (x, y, z) 那一格的方块光等级（见 CONTEXT.md 的「方块光」），坐标按 floor 取整，没加载的格子读作 0。
   *
   * 读的是光照数组的方块光那几位：发光方块那一格是它的发光等级，往外每格减 1（见 `light.ts`）。
   */
  blockLightAt(x: number, y: number, z: number): number {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return 0;
    return chunk.blockLight(localOf(bx), Math.floor(y), localOf(bz));
  }
}

/** 不接掉落物的世界用的那一份：收到什么都丢掉。 */
const NO_DROPS: DropSink = Object.freeze({ spawnInBlock: () => {} });

/** `faceCulling` 里不透明方块的那一档：比任何方块编号都小。 */
const OPAQUE_FACES = -1;

/**
 * 隔壁区块的网格从这一格读到的东西（见 `buildChunkMesh`）：不透明方块挡住隔壁贴着它的面；不是不透明的方块不挡，
 * 但与隔壁那一格同种时两个面重合、都不画（树叶），所以按编号区分。空气与火把对隔壁一样——不挡，也不会与隔壁那一格
 * 同种：火把不走六面剔除，它从不让别的方块少画一个面。
 *
 * 这一格换了方块之后，这个值不变的话隔壁的面就一个都不变，隔壁要重建只可能是因为光照变了。
 */
function faceCulling(block: BlockType): number {
  if (isOpaque(block)) return OPAQUE_FACES;
  if (isTorch(block)) return BlockType.Air;
  return block;
}

/** 方块状态表的坐标键。要求整数输入。 */
function blockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** 区块键的一维跨度，决定了世界的区块坐标范围：±2²⁵ 个区块。 */
const CHUNK_KEY_STRIDE = 1 << 26;

/** 区块坐标的绝对值小于它（`chunkKey` 的取值范围）。导入的文件按它校验区块与实体坐标。 */
export const CHUNK_COORD_LIMIT = CHUNK_KEY_STRIDE / 2;

/**
 * 区块的 Map 键。
 *
 * 用数字而不是 `"cx,cz"` 字符串：这个键在每 tick 的碰撞扫掠、每帧的网格计划里都要算
 * 成千上万次，模板字符串会在这些路径上不停分配。cx 乘一个比 cz 取值范围更大的跨度，
 * 不同 cx 的区间因此不重叠，结果始终在安全整数内。
 */
export function chunkKey(cx: number, cz: number): number {
  return cx * CHUNK_KEY_STRIDE + cz;
}

/** 世界坐标所属的区块坐标。要求整数输入；右移对负数也是向下取整。 */
export function chunkOf(worldCoord: number): number {
  return worldCoord >> CHUNK_SHIFT;
}

/** 世界坐标在区块内的局部坐标，负坐标也落在 [0, 16)。 */
export function localOf(worldCoord: number): number {
  return worldCoord & (CHUNK_SIZE - 1);
}

/** 世界原点所在的区块。出生点在这一列上。 */
export const ORIGIN_CHUNK: ChunkCoord = { cx: 0, cz: 0 };

/**
 * 以中心区块为中心、半径 radius 的方形范围内的全部区块坐标。
 * 加载范围、网格范围、引导阶段要等的那一片，说的都是这个形状。
 */
export function chunksAround(center: ChunkCoord, radius: number): ChunkCoord[] {
  const coords: ChunkCoord[] = [];
  for (let cx = center.cx - radius; cx <= center.cx + radius; cx++) {
    for (let cz = center.cz - radius; cz <= center.cz + radius; cz++) {
      coords.push({ cx, cz });
    }
  }
  return coords;
}

/**
 * 按到中心的距离由近到远排的比较函数。
 *
 * 用欧氏距离，而不是决定加载范围的那个切比雪夫距离：这样补齐的顺序是以玩家为中心由近到
 * 远，而不是先补满一个方环。比平方就够，不必开根号。
 */
export function byDistanceTo(center: ChunkCoord): (a: ChunkCoord, b: ChunkCoord) => number {
  const squared = ({ cx, cz }: ChunkCoord): number =>
    (cx - center.cx) ** 2 + (cz - center.cz) ** 2;
  return (a, b) => squared(a) - squared(b);
}
