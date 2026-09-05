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

  /** 把一整层填成同一种方块。整层同高的东西（基岩层、测试用的平地）用它。 */
  fillLayer(y: number, block: BlockType): void {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const start = (y - WORLD_MIN_Y) * AREA;
    this.blocks.fill(block, start, start + AREA);
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
    const end = index(lx, to, lz);
    for (let i = index(lx, from, lz); i <= end; i += AREA) {
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

/** y 在最外层：网格生成按 y 递增扫描，顺序访问对缓存友好。 */
function index(lx: number, y: number, lz: number): number {
  return (y - WORLD_MIN_Y) * AREA + lz * CHUNK_SIZE + lx;
}
