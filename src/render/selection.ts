import type { BlockType } from '../core/block';
import { blockHitbox, type Hitbox } from '../core/physics';
import { partialHitbox } from '../core/raycast';

/**
 * 选框（见 CONTEXT.md）套住的范围，世界坐标：整格方块是那一格；火把只套那根细杆，地表植物只套它比整格小的命中盒（#80）——
 * 就是视线碰的那个轴对齐盒子（`partialHitbox`），不另记尺寸。墙上火把的盒子包住整根斜杆。
 */
export function selectionBounds(block: BlockType, x: number, y: number, z: number): Hitbox {
  return partialHitbox(block, x, y, z) ?? blockHitbox(x, y, z);
}
