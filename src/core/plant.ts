import { BlockType, isFlower, isPlant } from './block';
import type { Hitbox } from './physics';

/**
 * 地表植物（见 CONTEXT.md「地表植物」，#80）的几何：视线碰的命中盒。方块表那一行与支撑表在 `block.ts`，生成在
 * `plant-generation.ts`。
 */

/** 矮草与蕨的命中盒：水平方向 2/16 到 14/16，高 13/16（原版数值）。 */
const GRASS_MIN = 2 / 16;
const GRASS_MAX = 14 / 16;
const GRASS_HEIGHT = 13 / 16;

/** 两种花的命中盒：水平方向 5/16 到 11/16，高 10/16（原版数值）。 */
const FLOWER_MIN = 5 / 16;
const FLOWER_MAX = 11 / 16;
const FLOWER_HEIGHT = 10 / 16;

/**
 * (x, y, z) 那一格植物的命中盒（世界坐标），立在格底、比整格小；不是植物时 undefined。视线只碰得到它
 * （`raycastBlocks`），碰不到时穿过这一格打到后面的方块；选框也套它。
 */
export function plantHitbox(block: BlockType, x: number, y: number, z: number): Hitbox | undefined {
  if (!isPlant(block)) return undefined;
  const flower = isFlower(block);
  const lo = flower ? FLOWER_MIN : GRASS_MIN;
  const hi = flower ? FLOWER_MAX : GRASS_MAX;
  const height = flower ? FLOWER_HEIGHT : GRASS_HEIGHT;
  return { min: { x: x + lo, y, z: z + lo }, max: { x: x + hi, y: y + height, z: z + hi } };
}
