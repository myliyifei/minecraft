import { BLOCKS, BlockType, isAir, type BlockView } from '../core/block';
import {
  BLOCK_LIGHT_MASK,
  CHUNK_BLOCK_COUNT,
  SKY_LIGHT_SHIFT,
  blockIndex,
  type ChunkView,
} from '../core/chunk';
import {
  CHUNK_AREA,
  CHUNK_SIZE,
  MAX_LIGHT_LEVEL,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../core/constants';
import { BLOCK_TILES, faceTile, tileAtUv, tileUvRect, type FaceTiles } from './atlas';
import { CUBE_FACES, type FaceSpec } from './cube-faces';
import { SELF_LIT_BLOCK_LIGHT } from './shading';
import { torchModel } from './torch-model';

/**
 * 一个区块的网格数据。纯 TypedArray，不含任何 three.js 类型——
 * 这样面剔除与贴图映射能在 Node 里测，Three.js 只负责把它包成 BufferGeometry。
 */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /**
   * 每个顶点两个数：天光、方块光（ADR-0016），按平滑光照取的是 4 格的平均，所以是 0.25 的倍数。
   * 存原始等级而不是折算后的亮度：世界时刻与闪烁都只是着色器每帧的输入，网格不必为它们重建。
   */
  readonly light: Float32Array;
  readonly indices: Uint32Array;
  /**
   * 这个区块里的发光方块（火把、燃烧中的熔炉）：粒子系统从这里挑出玩家附近的，让它们冒火焰与烟（#59）。
   * 跟着网格一起建：方块一变区块就重建网格，列表也就跟着变，熄火的熔炉下一次重建就不在了。
   */
  readonly glowingBlocks: readonly GlowingBlock[];
}

/** 一格发光方块：编号与世界坐标（方块的最小角）。编号里带着火把的朝向，冒粒子的位置按它算。 */
export interface GlowingBlock {
  readonly block: BlockType;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 网格构建按世界坐标读区块之外的那些格子：方块，加两个光照等级。
 * 区块边上的面要问隔壁区块的方块，边上的角还要读隔壁（含斜对角）区块的光照。
 *
 * `chunkAt` 给出隔壁区块的数据，边上那些六面都被挡住的格直接在它上面做下标算术排除，不必逐格问 `getBlock`。
 * 它与 `getBlock` 读到的必须是同一份方块；给不出（没加载、测试里的假视图）时返回 undefined，那些格照常逐格问。
 */
export interface MeshView extends BlockView {
  skyLightAt(x: number, y: number, z: number): number;
  blockLightAt(x: number, y: number, z: number): number;
  chunkAt(cx: number, cz: number): ChunkView | undefined;
}

/** 六个面的法线分量，摊成三条扁平数组：内层循环里取分量不必解构对象。 */
const FACE_DX = Int8Array.from(CUBE_FACES, (spec) => spec.normal[0]);
const FACE_DY = Int8Array.from(CUBE_FACES, (spec) => spec.normal[1]);
const FACE_DZ = Int8Array.from(CUBE_FACES, (spec) => spec.normal[2]);

/**
 * 邻居方块在区块数据里的下标偏移，与 CUBE_FACES 一一对应。
 * 区块内的邻居因此是一次加法，不必重算下标——见 `blockIndex` 的排布约定。
 */
const FACE_OFFSETS = Int32Array.from(
  CUBE_FACES,
  (spec) => spec.normal[1] * CHUNK_AREA + spec.normal[2] * CHUNK_SIZE + spec.normal[0],
);

/**
 * 平滑光照取样的格子：第 f 面第 v 个角挨着的 4 格，相对方块本身的偏移，摊成 `[f][v * 12 + k * 3 + axis]`。
 *
 * 4 格都在这一面外侧那一层（方块加上法线），是那一层里围着这个角的 2×2：沿这一面的两条边各往角
 * 那一侧走 0 或 1 格。角坐标是 1 的那条轴往 +1 走，是 0 的往 −1 走。
 */
const CORNER_SAMPLES = CUBE_FACES.map((spec) => {
  const offsets: number[] = [];
  for (const corner of spec.corners) {
    const toward = corner.map((c) => (c === 1 ? 1 : -1));
    const tangents = [0, 1, 2].filter((axis) => spec.normal[axis] === 0);
    for (const [stepU, stepV] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const offset = [...spec.normal];
      offset[tangents[0]!]! += stepU! * toward[tangents[0]!]!;
      offset[tangents[1]!]! += stepV! * toward[tangents[1]!]!;
      offsets.push(...offset);
    }
  }
  return Int8Array.from(offsets);
});

/** 方块编号 → 不透明、发光、是不是火把，摊成按编号索引的表：内层循环每格都要问（同 `light.ts` 的做法）。 */
const OPAQUE = new Uint8Array(256);
const GLOWS = new Uint8Array(256);
const TORCHES = new Uint8Array(256);
for (const [id, def] of Object.entries(BLOCKS)) {
  OPAQUE[Number(id)] = def.opaque ? 1 : 0;
  GLOWS[Number(id)] = def.lightEmission > 0 ? 1 : 0;
  TORCHES[Number(id)] = torchModel(Number(id) as BlockType) ? 1 : 0;
}

const LAST = CHUNK_SIZE - 1;
/** 区块数据里 lz = 0 与 lz = 15 两行之间的下标差：−Z、+Z 两侧的隔壁区块里同一格差这么多。 */
const EDGE_ROW = LAST * CHUNK_SIZE;

/** 世界最高一层之上是天空：天光 15、方块光 0，按光照数组的格式打包。 */
const OPEN_SKY = MAX_LIGHT_LEVEL << SKY_LIGHT_SHIFT;

/**
 * 一份网格的 uv 用到了哪些贴图格号。
 *
 * 每个面 4 个顶点、每顶点一对 uv，取四个顶点的中点反查（`tileAtUv`）：四个角正落在格的
 * 边界上，会算进相邻的格里。端到端测试靠它确认画布上那块熔炉贴的是熄火还是燃烧的正面——
 * 读回的是送上显卡的 uv，不必去比像素颜色。
 */
export function meshTiles(uvs: ArrayLike<number>): Set<number> {
  const tiles = new Set<number>();
  for (let i = 0; i + 7 < uvs.length; i += 8) {
    const u = (uvs[i]! + uvs[i + 2]! + uvs[i + 4]! + uvs[i + 6]!) / 4;
    const v = (uvs[i + 1]! + uvs[i + 3]! + uvs[i + 5]! + uvs[i + 7]!) / 4;
    tiles.add(tileAtUv(u, v));
  }
  return tiles;
}

/**
 * 为一个区块生成网格：只有暴露面进网格，被不透明方块挡住的面直接跳过。
 *
 * 每个顶点带天光与方块光（ADR-0016），按**平滑光照**取：这一面外侧那一层里挨着这个角的 4 格，
 * 两个等级各自平均，不透明的格子按 0 计入，墙脚与凹处因此偏暗。4 格可以落在隔壁区块里，
 * 所以要等周围 8 个区块都加载、光照算好再建（`planChunkMeshes`）。
 *
 * 顶点用区块局部的 x/z（[0, 16]）与世界 y，渲染层把网格整体平移到区块位置。
 * 区块内的邻居直接在区块数据上做下标算术；只有跨出区块边界的那些才走 `view`，
 * 因此边界上的面是否生成取决于相邻区块是否已加载——未加载的相邻区块读到空气，
 * 边界面会暴露（一个四邻皆空的区块因此产生 8842 个面，四邻齐全时只有 273 个，
 * 流式加载据此只给周围 8 个邻居齐全的区块建网格，见 `planChunkMeshes`）。
 *
 * 这个函数是每帧预算的大头：一个区块要问二十多万次邻居，逐格走 `view.getBlock`
 * （三次取整 + Map 查找）实测 22ms，下标算术是 4ms（都是在 Vitest 里测的）。先把六面都被挡住的格排除
 * 之后，打包后的代码在 Node 里每个区块约 0.4ms，Windows 上的 Edge 里连着建是约 0.5ms，夹在画面的帧之间是 0.5–1ms（#62）。
 */
export function buildChunkMesh(chunk: ChunkView, view: MeshView): MeshData {
  meshBuffers.reset();
  glowing.reset();
  torches.reset();
  scanChunk(chunk, view);
  emitTorches(chunk.blocks);
  return {
    ...meshBuffers.take(),
    glowingBlocks: glowingBlocksIn(chunk.blocks, chunk.cx * CHUNK_SIZE, chunk.cz * CHUNK_SIZE),
  };
}

/**
 * 扫一遍区块：整格方块的暴露面写进 `meshBuffers`，发光方块与火把的下标记进 `glowing`、`torches`。
 *
 * 单独一个函数，只做整数与 TypedArray 上的事：建火把细杆、建发光方块的对象都在它外面（见 `warmUpChunkMeshes`）。
 */
function scanChunk(chunk: ChunkView, view: MeshView): void {
  const blocks = chunk.blocks;
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;
  // 四个侧向邻居的方块数据：+X、−X、+Z、−Z。同一 y、同一行的格子在隔壁数据里差一个固定的下标。
  const east = view.chunkAt(chunk.cx + 1, chunk.cz)?.blocks;
  const west = view.chunkAt(chunk.cx - 1, chunk.cz)?.blocks;
  const south = view.chunkAt(chunk.cx, chunk.cz + 1)?.blocks;
  const north = view.chunkAt(chunk.cx, chunk.cz - 1)?.blocks;

  for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      // 一行 16 格在数据里是连着的，下标随 lx 递增即可。
      let i = blockIndex(0, y, lz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++, i++) {
        const block = blocks[i] as BlockType;
        if (isAir(block)) continue;
        const tiles = BLOCK_TILES[block];
        if (!tiles) continue;
        // 发光方块与火把在这里只记下下标，扫完整个区块再处理（见 `IndexList`）。
        if (GLOWS[block]) glowing.push(i);
        if (TORCHES[block]) {
          torches.push(i);
          continue;
        }

        // 六个邻格都不透明的格一个面都不出。地下的石头大多是这种，先用六次查表把它们跳过，不进下面
        // 逐面判断边界的循环（#62）。区块边上的那一侧读隔壁区块的数据，读不到的当作空气，交给下面的循环。
        if (
          y > WORLD_MIN_Y &&
          y < WORLD_MAX_Y &&
          OPAQUE[blocks[i + CHUNK_AREA]!] &&
          OPAQUE[blocks[i - CHUNK_AREA]!] &&
          OPAQUE[lx < LAST ? blocks[i + 1]! : east ? east[i - LAST]! : BlockType.Air] &&
          OPAQUE[lx > 0 ? blocks[i - 1]! : west ? west[i + LAST]! : BlockType.Air] &&
          OPAQUE[lz < LAST ? blocks[i + CHUNK_SIZE]! : south ? south[i - EDGE_ROW]! : BlockType.Air] &&
          OPAQUE[lz > 0 ? blocks[i - CHUNK_SIZE]! : north ? north[i + EDGE_ROW]! : BlockType.Air]
        ) {
          continue;
        }

        for (let f = 0; f < CUBE_FACES.length; f++) {
          const dy = FACE_DY[f]!;
          const ny = y + dy;
          // 世界底面之下永远看不见，省掉每个区块 256 个无用面。
          if (ny < WORLD_MIN_Y) continue;

          const nlx = lx + FACE_DX[f]!;
          const nlz = lz + FACE_DZ[f]!;
          let neighbor: BlockType;
          if (ny > WORLD_MAX_Y) {
            // 世界顶面之上什么都没有，那一层的顶面因此是暴露的。
            neighbor = BlockType.Air;
          } else if (nlx >= 0 && nlx < CHUNK_SIZE && nlz >= 0 && nlz < CHUNK_SIZE) {
            neighbor = blocks[i + FACE_OFFSETS[f]!] as BlockType;
          } else {
            neighbor = view.getBlock(originX + nlx, ny, originZ + nlz);
          }

          if (OPAQUE[neighbor]) continue;
          // 走到这里说明邻居不遮挡视线（空气或树叶）。同种方块相邻时两个面完全重合：
          // 留着只会 z-fighting、还让树冠内部的几何翻倍。整片树叶因此只保留最外层的面。
          if (neighbor === block) continue;

          meshBuffers.quad(CUBE_FACES[f]!, lx, y, lz, tiles);
          const samples = CORNER_SAMPLES[f]!;
          for (let v = 0; v < 4; v++) {
            let sky = 0;
            let blockLight = 0;
            for (let k = v * 12; k < v * 12 + 12; k += 3) {
              const s = sampleLight(chunk, view, lx + samples[k]!, y + samples[k + 1]!, lz + samples[k + 2]!);
              sky += s >> SKY_LIGHT_SHIFT;
              blockLight += s & BLOCK_LIGHT_MASK;
            }
            // 乘 0.25 而不是除以 4，理由见 warmUpChunkMeshes。
            meshBuffers.light(sky * 0.25, blockLight * 0.25);
          }
        }
      }
    }
  }
}

/** 区块局部坐标那一格的光照（可以出界，那时读隔壁），按光照数组的格式打包；不透明的格子读作 0。 */
function sampleLight(chunk: ChunkView, view: MeshView, lx: number, y: number, lz: number): number {
  if (y > WORLD_MAX_Y) return OPEN_SKY;
  // 世界底面之下当作不透明：只有贴着最底层的侧面会读到这里。
  if (y < WORLD_MIN_Y) return 0;
  if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
    const j = blockIndex(lx, y, lz);
    if (OPAQUE[chunk.blocks[j]!]) return 0;
    return chunk.light ? chunk.light[j]! : 0;
  }
  const x = chunk.cx * CHUNK_SIZE + lx;
  const z = chunk.cz * CHUNK_SIZE + lz;
  if (OPAQUE[view.getBlock(x, y, z)]) return 0;
  return (view.skyLightAt(x, y, z) << SKY_LIGHT_SHIFT) | view.blockLightAt(x, y, z);
}

/**
 * 记下的那些火把（`torches`）的细杆。火把不走六面剔除：细杆碰不到邻格，五个面总要画。两个等级写满，方块光那一项
 * 同时是着色器认的标记（`SELF_LIT_BLOCK_LIGHT`）：火把本身不受光照影响，按贴图本色画。
 */
function emitTorches(blocks: ChunkView['blocks']): void {
  for (let k = 0; k < torches.length; k++) {
    const i = torches.at(k);
    const block = blocks[i] as BlockType;
    const { lx, y, lz } = cellOf(i);
    for (const spec of torchModel(block)!) {
      meshBuffers.quad(spec, lx, y, lz, BLOCK_TILES[block]!);
      for (let v = 0; v < 4; v++) meshBuffers.light(MAX_LIGHT_LEVEL, SELF_LIT_BLOCK_LIGHT);
    }
  }
}

/** 记下的那些发光方块（`glowing`），按扫描的顺序。 */
function glowingBlocksIn(blocks: ChunkView['blocks'], originX: number, originZ: number): GlowingBlock[] {
  const found: GlowingBlock[] = [];
  for (let k = 0; k < glowing.length; k++) {
    const i = glowing.at(k);
    const { lx, y, lz } = cellOf(i);
    found.push({ block: blocks[i] as BlockType, x: originX + lx, y, z: originZ + lz });
  }
  return found;
}

/** 区块数据里第 i 格的局部坐标，`blockIndex` 的反函数。 */
function cellOf(i: number): { lx: number; y: number; lz: number } {
  return { lx: i & LAST, y: Math.floor(i / CHUNK_AREA) + WORLD_MIN_Y, lz: (i >> 4) & LAST };
}

/**
 * 一串区块数据下标，模块共用一份，不够就翻倍。扫区块的循环遇到发光方块与火把只往这里记一个整数，建火把细杆、
 * 建发光方块的对象挪到循环之后的两个函数里（`emitTorches`、`glowingBlocksIn`），扫描循环本身不必为它们走别的
 * 分支（见 `warmUpChunkMeshes`）。两个函数每次都调，没有火把时只是循环一次都不走。
 */
class IndexList {
  private data = new Int32Array(64);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  push(i: number): void {
    if (this.length === this.data.length) {
      const wider = new Int32Array(this.data.length * 2);
      wider.set(this.data);
      this.data = wider;
    }
    this.data[this.length++] = i;
  }

  at(k: number): number {
    return this.data[k]!;
  }
}

const glowing = new IndexList();
const torches = new IndexList();

/**
 * 建网格时往里写顶点的缓冲，整个模块共用一份，不够就翻倍；建完一个区块按实际长度复制出去（`take`）。
 *
 * 写进定长的 TypedArray 而不是 `number[]`：元素的存法是定的，不会因为写进第一个小数（火把细杆的坐标、方块光的
 * 平均）而换一种，写入它的那段优化代码也就不会因此作废（见 `warmUpChunkMeshes`）。共用一份还省掉每个区块的几次
 * 扩容：`buildChunkMesh` 是同步的，不会重入。五个数组一起翻倍，每个顶点占得最多的是位置与法线（3 个数），只按它查。
 */
class MeshBuffers {
  private positions = new Float32Array(1 << 14);
  private normals = new Float32Array(1 << 14);
  private uvs = new Float32Array(1 << 14);
  private lights = new Float32Array(1 << 14);
  private indices = new Uint32Array(1 << 14);
  /** 写了几个顶点、几个下标，几个顶点补上了光照。 */
  private vertices = 0;
  private indexCount = 0;
  private lit = 0;

  reset(): void {
    this.vertices = 0;
    this.indexCount = 0;
    this.lit = 0;
  }

  /** 区块局部坐标那一格的一个面：位置、法线、uv 与两个三角形。光照由调用处按顶点顺序补上（`light`）。 */
  quad(spec: FaceSpec, lx: number, y: number, lz: number, tiles: FaceTiles): void {
    if ((this.vertices + 4) * 3 > this.positions.length) this.grow();
    const base = this.vertices;
    const rect = tileUvRect(faceTile(tiles, spec.face));
    const [nx, ny, nz] = spec.normal;
    for (let v = 0; v < 4; v++) {
      const [ox, oy, oz] = spec.corners[v]!;
      const p = (base + v) * 3;
      this.positions[p] = lx + ox;
      this.positions[p + 1] = y + oy;
      this.positions[p + 2] = lz + oz;
      this.normals[p] = nx;
      this.normals[p + 1] = ny;
      this.normals[p + 2] = nz;
      const [du, dv] = spec.uv[v]!;
      const t = (base + v) * 2;
      this.uvs[t] = rect.u0 + du * (rect.u1 - rect.u0);
      this.uvs[t + 1] = rect.v0 + dv * (rect.v1 - rect.v0);
    }
    const n = this.indexCount;
    this.indices[n] = base;
    this.indices[n + 1] = base + 1;
    this.indices[n + 2] = base + 2;
    this.indices[n + 3] = base;
    this.indices[n + 4] = base + 2;
    this.indices[n + 5] = base + 3;
    this.indexCount = n + 6;
    this.vertices = base + 4;
  }

  /** 下一个还没有光照的顶点的两个等级。每个顶点在 `quad` 之后按顺序补一次。 */
  light(sky: number, block: number): void {
    this.lights[this.lit * 2] = sky;
    this.lights[this.lit * 2 + 1] = block;
    this.lit++;
  }

  take(): Omit<MeshData, 'glowingBlocks'> {
    const vertices = this.vertices;
    return {
      positions: this.positions.slice(0, vertices * 3),
      normals: this.normals.slice(0, vertices * 3),
      uvs: this.uvs.slice(0, vertices * 2),
      light: this.lights.slice(0, vertices * 2),
      indices: this.indices.slice(0, this.indexCount),
    };
  }

  private grow(): void {
    const widen = <T extends Float32Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.positions = widen(this.positions);
    this.normals = widen(this.normals);
    this.uvs = widen(this.uvs);
    this.lights = widen(this.lights);
    this.indices = widen(this.indices);
  }
}

const meshBuffers = new MeshBuffers();

/** 预热用的视图：区块之外处处是空气，没有光，也没有隔壁区块的数据。 */
const EMPTY_VIEW: MeshView = {
  getBlock: () => BlockType.Air,
  skyLightAt: () => 0,
  blockLightAt: () => 0,
  chunkAt: () => undefined,
};

/**
 * 开局先建一次假区块的网格：每种画得出来的方块各放一格（含 5 个朝向的火把与燃烧中的熔炉），再加两格挨着的树叶、
 * 一格贴着区块边的石头，光照数组里各种等级都有，让网格构建的每一条路在真正的区块之前都走过一遍。渲染层构造时调一次，
 * 只花几毫秒，建出的网格丢掉。
 *
 * 为什么要它：V8 按函数实际走过的分支与见过的值优化它。开局的地形里没有火把，也没有方块光，优化出来的代码里没有建
 * 火把细杆的那几步，光照的平均也总是整数；玩家第一次放下火把时这份优化代码作废，退回未优化的代码，要过几百毫秒才重新
 * 优化好。这段时间里建一个区块的网格要 3–5ms，平时 0.5ms，Windows 上的 Edge 里放下第一、第二支火把的那一帧因此超出
 * 预算（#62）。只预热还不够，另外三样一起做了，放下第一支火把之后才不再作废重来（Node 的 `--trace-deopt` 里一次都
 * 没有，Edge 里放下第一支火把那一帧建网格与之后的一样快）：扫描循环单独一个函数（`scanChunk`），发光方块与火把在
 * 循环里只记下标（`IndexList`）；顶点写进 TypedArray（`MeshBuffers`）；平滑光照的平均乘 0.25 而不是除以 4（乘数是
 * 小数，V8 一开始就按小数算）。
 */
export function warmUpChunkMeshes(): void {
  const blocks = new Uint8Array(CHUNK_BLOCK_COUNT);
  // 两种光各 0 到 15 都有
  const light = Uint8Array.from({ length: CHUNK_BLOCK_COUNT }, (_, i) => i & 0xff);
  const y = WORLD_MIN_Y + 1;
  let spot = 0;
  for (const [id, tiles] of Object.entries(BLOCK_TILES)) {
    if (!tiles) continue;
    // 隔一格放一个，各自的面都露在外面；底下垫一层石头，火把有地方立
    const lx = (spot % 7) * 2 + 1;
    const lz = Math.floor(spot / 7) * 2 + 1;
    blocks[blockIndex(lx, y - 1, lz)] = BlockType.Stone;
    blocks[blockIndex(lx, y, lz)] = Number(id);
    spot++;
  }
  blocks[blockIndex(LAST, y, LAST)] = BlockType.OakLeaves;
  blocks[blockIndex(LAST - 1, y, LAST)] = BlockType.OakLeaves;
  blocks[blockIndex(0, y, LAST)] = BlockType.Stone;
  buildChunkMesh({ cx: 0, cz: 0, blocks, light }, EMPTY_VIEW);
}
