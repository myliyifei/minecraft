import { BlockType } from './block';
import { CHUNK_AREA, CHUNK_SIZE, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';

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
 * 之所以把底层数组摊开而不是只给一个 `get()`：网格生成对每个方块要问 6 个邻居，
 * 一个区块下来二十多万次查询，走 `World.getBlock`（三次取整 + Map 查找）实测 22ms，
 * 在这块内存上直接做下标算术是 4ms。一帧要建一两个区块的网格，22ms 一个就超出了
 * 60fps 的每帧预算。写这块内存的只有区块自己。
 */
export interface ChunkView {
  readonly cx: number;
  readonly cz: number;
  readonly blocks: ChunkBlocks;
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

  /** 把一整层填成同一种方块。整层同高的东西（基岩层、测试用的平地）用它。 */
  fillLayer(y: number, block: BlockType): void {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const start = blockIndex(0, y, 0);
    this.blocks.fill(block, start, start + CHUNK_AREA);
  }

  /**
   * 把 (lx, lz) 这一列上 [yFrom, yTo] 的一段填成同一种方块，越界的部分被裁掉。
   *
   * 地形生成的主力：地表高度按列变化，铺石头这类活儿一列就是一段。
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
