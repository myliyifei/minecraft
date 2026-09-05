import { BlockType } from './block';
import { CHUNK_SIZE, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';

const AREA = CHUNK_SIZE * CHUNK_SIZE;

/**
 * 一个 16×16 水平、完整世界高度的方块柱体。
 *
 * 坐标约定：lx / lz 是区块内局部坐标 [0, 16)，y 是世界坐标 [WORLD_MIN_Y, WORLD_MAX_Y]。
 * 越界读返回空气，越界写被忽略——这样调用方不必在每个边界上写判断。
 */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  private readonly blocks: Uint8Array;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint8Array(AREA * WORLD_HEIGHT);
  }

  get(lx: number, y: number, lz: number): BlockType {
    if (!inside(lx, y, lz)) return BlockType.Air;
    return this.blocks[index(lx, y, lz)] as BlockType;
  }

  set(lx: number, y: number, lz: number, block: BlockType): void {
    if (!inside(lx, y, lz)) return;
    this.blocks[index(lx, y, lz)] = block;
  }

  /** 把一整层填成同一种方块。地形生成用它铺平地。 */
  fillLayer(y: number, block: BlockType): void {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const start = (y - WORLD_MIN_Y) * AREA;
    this.blocks.fill(block, start, start + AREA);
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

/** y 在最外层：网格生成按 y 递增扫描，顺序访问对缓存友好。 */
function index(lx: number, y: number, lz: number): number {
  return (y - WORLD_MIN_Y) * AREA + lz * CHUNK_SIZE + lx;
}
