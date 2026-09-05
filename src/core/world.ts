import { BlockType, type BlockView } from './block';
import { Chunk } from './chunk';
import { CHUNK_SHIFT, CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';

export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
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
 */
export class World implements BlockView {
  private readonly chunks = new Map<number, Chunk>();
  private readonly source: ChunkSource;

  constructor(source: ChunkSource) {
    this.source = source;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  loadedChunks(): ChunkCoord[] {
    return [...this.chunks.values()].map(({ cx, cz }) => ({ cx, cz }));
  }

  /**
   * 遍历已加载的区块。
   * 流式加载每 tick 都要走一遍全部已加载区块，用它就不必每次建一个中间数组。
   * 遍历途中卸载区块是安全的。
   */
  forEachChunk(visit: (chunk: Chunk) => void): void {
    for (const chunk of this.chunks.values()) visit(chunk);
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
   * 已加载则原样返回，不向来源重新要一份，玩家的修改因此不会被覆盖。
   * 来源说「还没准备好」时返回 undefined，世界保持不变。
   */
  loadChunk(cx: number, cz: number): Chunk | undefined {
    const key = chunkKey(cx, cz);
    const loaded = this.chunks.get(key);
    if (loaded) return loaded;
    const chunk = this.source(cx, cz);
    if (!chunk) return undefined;
    this.chunks.set(key, chunk);
    return chunk;
  }

  /**
   * 卸载区块。
   * 本切片直接丢弃区块数据；把修改过的区块留在内存里以便走远再回来仍是改过的样子，
   * 是 issue #13 的事。
   */
  unloadChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
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
   */
  setBlock(x: number, y: number, z: number, block: BlockType): boolean {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    if (by < WORLD_MIN_Y || by > WORLD_MAX_Y) return false;
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return false;
    chunk.set(localOf(bx), by, localOf(bz), block);
    return true;
  }
}

/** 区块键的一维跨度，决定了世界的区块坐标范围：±2²⁵ 个区块。 */
const CHUNK_KEY_STRIDE = 1 << 26;

/**
 * 区块的 Map 键。
 *
 * 用数字而不是 `"cx,cz"` 字符串：`getBlock` 是全局最热的调用，网格生成一个区块要走
 * 近 70 万次，模板字符串会在这条路径上不停分配。cx 乘一个比 cz 取值范围更大的跨度，
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
