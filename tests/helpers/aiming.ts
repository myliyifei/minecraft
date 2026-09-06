import type { BlockType } from '../../src/core/block';
import type { Vec3 } from '../../src/core/vec3';
import { World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestWorld } from './flat-terrain';

/**
 * 瞄准类测试共用的一层：平地上方几格的空中。
 *
 * 方块都摆在这一层，水平方向的射线就在一个平面里走；离地留够高度，朝下的射线也是撞到
 * 摆出来的方块，而不是先撞地面。
 */
export const AIM_LAYER_Y = FLAT_GROUND_Y + 5;

/** 瞄准类测试的眼睛位置：落在 (0, AIM_LAYER_Y, 0) 那一格的中心。 */
export const AIM_EYE: Vec3 = { x: 0.5, y: AIM_LAYER_Y + 0.5, z: 0.5 };

/** 一格的方块坐标。摆方块与断言命中都用它。 */
export type BlockCoord = [number, number, number];

/** 空中摆好几块方块的平地世界。 */
export function worldWithBlocks(...placements: Array<[BlockCoord, BlockType]>): World {
  const world = flatTestWorld();
  for (const [[x, y, z], block] of placements) world.setBlock(x, y, z, block);
  return world;
}

/** 归一化，好把「朝哪儿看」写成好读的整数分量。 */
export function unit({ x, y, z }: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}
