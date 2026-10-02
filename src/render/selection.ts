import type { BlockType } from '../core/block';
import { blockHitbox, type Hitbox } from '../core/physics';
import { torchHitbox } from '../core/torch';

/**
 * 选框（见 CONTEXT.md）套住的范围，世界坐标：整格方块是那一格，火把只套那根细杆——就是视线碰的那个
 * 轴对齐盒子（`torchHitbox`），不另记尺寸。墙上火把的盒子包住整根斜杆。
 */
export function selectionBounds(block: BlockType, x: number, y: number, z: number): Hitbox {
  return torchHitbox(block, x, y, z) ?? blockHitbox(x, y, z);
}
