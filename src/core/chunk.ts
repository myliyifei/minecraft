import { BlockType } from './block';
import { CHUNK_AREA, CHUNK_SIZE, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';

/** 光照数组里一格的天光在高 4 位：右移这么多位读出天光。方块光在低 4 位，见 `BLOCK_LIGHT_MASK`。 */
export const SKY_LIGHT_SHIFT = 4;

/** 光照数组里一格的方块光：与这个掩码按位与。 */
export const BLOCK_LIGHT_MASK = 0x0f;

/** 一个区块的方块数据长度。 */
export const CHUNK_BLOCK_COUNT = CHUNK_AREA * WORLD_HEIGHT;

/**
 * 一个区块的方块数据。
 * 写明 `ArrayBuffer` 而不是默认的 `ArrayBufferLike`：Worker 生成的区块要把这块内存
 * 转移（transfer）给主线程，而 SharedArrayBuffer 不能转移。
 */
export type ChunkBlocks = Uint8Array<ArrayBuffer>;

/**
 * 网格生成看到的区块：区块坐标，加它那块方块内存。
 *
 * 之所以直接暴露底层数组而不是只给一个 `get()`：网格生成对每个方块要问 6 个邻居，
 * 一个区块下来二十多万次查询，走 `World.getBlock`（三次取整 + Map 查找）实测 22ms，
 * 在这块内存上直接做下标算术是 4ms。一帧要建一两个区块的网格，22ms 一个就超出了
 * 60fps 的每帧预算。写这块内存的只有区块自己。
 */
export interface ChunkView {
  readonly cx: number;
  readonly cz: number;
  readonly blocks: ChunkBlocks;
  /** 光照数组（见 `Chunk.light`）。网格构建读它给顶点取光照，理由与 `blocks` 相同。 */
  readonly light: Uint8Array | undefined;
}

/**
 * 一个 16×16 水平、完整世界高度的方块柱体。
 *
 * 坐标约定：lx / lz 是区块内局部坐标 [0, 16)，y 是世界坐标 [WORLD_MIN_Y, WORLD_MAX_Y]。
 * 越界读返回空气，越界写被忽略——这样调用方不必在每个边界上写判断。
 */
export class Chunk implements ChunkView {
  readonly cx: number;
  readonly cz: number;
  readonly blocks: ChunkBlocks;
  /**
   * 光照数组（ADR-0017）：与 `blocks` 同样长，每格 1 字节，天光占高 4 位、方块光占低 4 位。
   *
   * 只在区块已加载期间有：世界加载区块时 `resetLight` 建一份全 0 的，交给 `light.ts` 算；
   * 卸载时 `discardLight` 丢掉，已改区块也一样，玩家走回来时按方块重算。没有光照数组时两个等级读作 0。
   * 写它的只有 `light.ts`：它在这块内存上直接做下标算术，理由与 `blocks` 直接暴露相同。
   */
  light: Uint8Array | undefined;
  /**
   * 每一列天光开始变弱的高度（ADR-0017）：最高的一个不是「不衰减」的方块（不透明或树叶）的 y，
   * 整列都不衰减时是 WORLD_MIN_Y − 1。下标是 `lz * CHUNK_SIZE + lx`。
   *
   * 它以上整段天光都是 15。传播只需要从它往下找光源，平地区块因此只做竖直填充。
   * 与光照数组一起建、一起丢，由 `light.ts` 维护。
   */
  skyTops: Int16Array | undefined;

  /**
   * `blocks` 可以传一段现成的方块数据：Worker 生成的区块把 ArrayBuffer 转移到主线程，
   * 主线程直接接管这块内存，不再复制一遍。
   */
  constructor(cx: number, cz: number, blocks = new Uint8Array(CHUNK_BLOCK_COUNT)) {
    if (blocks.length !== CHUNK_BLOCK_COUNT) {
      throw new Error(
        `区块数据长度应为 ${CHUNK_BLOCK_COUNT}，收到 ${blocks.length}`,
      );
    }
    this.cx = cx;
    this.cz = cz;
    this.blocks = blocks;
  }

  get(lx: number, y: number, lz: number): BlockType {
    if (!inside(lx, y, lz)) return BlockType.Air;
    return this.blocks[blockIndex(lx, y, lz)] as BlockType;
  }

  set(lx: number, y: number, lz: number, block: BlockType): void {
    if (!inside(lx, y, lz)) return;
    this.blocks[blockIndex(lx, y, lz)] = block;
  }

  /** (lx, y, lz) 的天光等级。越界或没有光照数组时读作 0。 */
  skyLight(lx: number, y: number, lz: number): number {
    if (!this.light || !inside(lx, y, lz)) return 0;
    return this.light[blockIndex(lx, y, lz)] >> SKY_LIGHT_SHIFT;
  }

  /** (lx, y, lz) 的方块光等级。越界或没有光照数组时读作 0。 */
  blockLight(lx: number, y: number, lz: number): number {
    if (!this.light || !inside(lx, y, lz)) return 0;
    return this.light[blockIndex(lx, y, lz)] & BLOCK_LIGHT_MASK;
  }

  /** 建一份全 0 的光照数组，旧的（如果有）丢掉。区块加载时调用，随后由 `light.ts` 填。 */
  resetLight(): void {
    this.light = new Uint8Array(CHUNK_BLOCK_COUNT);
    this.skyTops = new Int16Array(CHUNK_AREA);
  }

  /** 丢掉光照数组。区块卸载时调用（ADR-0017：卸载即丢）。 */
  discardLight(): void {
    this.light = undefined;
    this.skyTops = undefined;
  }

  /** 把一整层填成同一种方块。整层同高的东西（基岩层、测试用的平地）用它。 */
  fillLayer(y: number, block: BlockType): void {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const start = blockIndex(0, y, 0);
    this.blocks.fill(block, start, start + CHUNK_AREA);
  }

  /**
   * 把 (lx, lz) 这一列上 [yFrom, yTo] 的一段填成同一种方块，越界的部分被裁掉。
   *
   * 地形生成主要用它：地表高度按列变化，铺石头这类操作一列就是一段。
   * 每段只做一次边界检查、下标按层距递增，而不是每格走一遍 `set()`——
   * 一个区块要写近十万格。
   */
  fillColumn(lx: number, lz: number, yFrom: number, yTo: number, block: BlockType): void {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
    const from = Math.max(yFrom, WORLD_MIN_Y);
    const to = Math.min(yTo, WORLD_MAX_Y);
    // from > to（空区间）时 start > end，循环一次都不走。
    const end = blockIndex(lx, to, lz);
    for (let i = blockIndex(lx, from, lz); i <= end; i += CHUNK_AREA) {
      this.blocks[i] = block;
    }
  }
}

function inside(lx: number, y: number, lz: number): boolean {
  return (
    lx >= 0 &&
    lx < CHUNK_SIZE &&
    lz >= 0 &&
    lz < CHUNK_SIZE &&
    y >= WORLD_MIN_Y &&
    y <= WORLD_MAX_Y
  );
}

/**
 * 方块在区块数据里的下标。y 在最外层：网格生成按 y 递增扫描，顺序访问对缓存友好。
 *
 * 相邻方块的下标差因此是常量：±1 是 x、±CHUNK_SIZE 是 z、±CHUNK_AREA 是 y。
 * 网格生成靠这几个偏移量走邻居，不再重算下标。
 */
export function blockIndex(lx: number, y: number, lz: number): number {
  return (y - WORLD_MIN_Y) * CHUNK_AREA + lz * CHUNK_SIZE + lx;
}
