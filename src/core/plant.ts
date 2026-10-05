import { BlockType, isFlower, isPlant } from './block';
import { Biome } from './biome';
import type { Chunk } from './chunk';
import { CHUNK_SIZE } from './constants';
import { hashCoords, perlin2 } from './noise';
import type { Hitbox } from './physics';
import { TREE_SPAWN_CLEARANCE, type TreePlacement } from './tree';

/**
 * 地表植物（见 CONTEXT.md「地表植物」，#80）的几何与生成：视线碰的命中盒、区块生成的最后一步按群系放植物。
 * 方块表那一行与支撑表在 `block.ts`。
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

/** 出生列周围多少格内不长植物（切比雪夫距离，含边界）：与树取同一个距离（CONTEXT.md「出生点」），出生时脚边没有植物。 */
export const PLANT_SPAWN_CLEARANCE = TREE_SPAWN_CLEARANCE;

/** 植物长得上去的列顶地表方块：草方块与雪草方块（沙子、沙砾、石头列顶不长）。 */
const PLANT_GROUND: ReadonlySet<BlockType> = new Set([BlockType.Grass, BlockType.SnowyGrass]);

/** 每列长不长、长哪种的哈希盐，与树、矿脉的盐错开。 */
const ROLL_SALT = 0x2f6b_1d93;
/** 花丛分布那一层噪声的盐。 */
const FLOWER_PATCH_SALT = 0x51ed_270b;
/** 花丛里长哪种花那一层噪声的盐。 */
const FLOWER_KIND_SALT = 0x7a3c_94e1;

/** 平原合格列里长矮草的比例。 */
const SHORT_GRASS_CHANCE = 0.25;
/**
 * 花丛：花丛噪声高于这个值的列在花丛里。噪声的尺度是 `FLOWER_PATCH_SCALE` 格，高于 0.45 的地方是零散的几格到十几格宽
 * 的一块块，花因此成片，而不是均匀撒在整片平原上。
 */
const FLOWER_PATCH_THRESHOLD = 0.45;
const FLOWER_PATCH_SCALE = 10;
/** 花丛里的合格列长花的比例；没长花的列照常按 `SHORT_GRASS_CHANCE` 长矮草。 */
const FLOWER_CHANCE = 0.35;
/** 高山与冰雪的合格列里长蕨的比例。 */
const FERN_CHANCE = 0.08;

/**
 * 区块生成的最后一步（ADR-0021「在树之后放」）：在这个区块里逐列放地表植物，不跨区块。
 *
 * 一列长植物的条件：离出生列超过 `PLANT_SPAWN_CLEARANCE` 格；地表高度那一格是草方块或雪草方块；它上面那一格是空气
 * （树干、树叶都排除在外，所以不长在原木的格里，也不长进树冠）；群系不是大海。长不长、长哪种只由种子与列坐标决定：
 * - 平原：花丛噪声高于阈值的列按 `FLOWER_CHANCE` 长花，蒲公英与虞美人由另一层噪声分片；其余按 `SHORT_GRASS_CHANCE` 长矮草。
 * - 高山与冰雪：按 `FERN_CHANCE` 长蕨，高山雪线以上的雪草方块也长（与树不同）。
 * - 大海：不长，大海群系露出水面的草方块与雪草方块也不长（与树相同）。
 *
 * 只看地表高度那一格，所以植物只长在每列最高的那段地面上，悬垂底下不长。
 */
export function plantSurfacePlants(
  placement: Pick<TreePlacement, 'seed' | 'spawnColumn' | 'biomeAt' | 'surfaceHeightAt'>,
  chunk: Chunk,
): void {
  const { seed, spawnColumn: spawn } = placement;
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const x = originX + lx;
      const z = originZ + lz;
      if (Math.max(Math.abs(x - spawn.x), Math.abs(z - spawn.z)) <= PLANT_SPAWN_CLEARANCE) continue;
      const y = placement.surfaceHeightAt(x, z);
      if (!PLANT_GROUND.has(chunk.get(lx, y, lz)) || chunk.get(lx, y + 1, lz) !== BlockType.Air) continue;
      const plant = plantFor(seed, placement.biomeAt(x, z), x, z);
      if (plant !== undefined) chunk.set(lx, y + 1, lz, plant);
    }
  }
}

/** 一列合格列长哪种植物，不长时 undefined。 */
function plantFor(seed: number, biome: Biome, x: number, z: number): BlockType | undefined {
  if (biome === Biome.Ocean) return undefined;
  const roll = hashCoords(seed ^ ROLL_SALT, x, z) / 2 ** 32;
  if (biome !== Biome.Plains) return roll < FERN_CHANCE ? BlockType.Fern : undefined;
  if (roll < FLOWER_CHANCE && perlin2(seed ^ FLOWER_PATCH_SALT, x / FLOWER_PATCH_SCALE, z / FLOWER_PATCH_SCALE) > FLOWER_PATCH_THRESHOLD) {
    return perlin2(seed ^ FLOWER_KIND_SALT, x / FLOWER_PATCH_SCALE, z / FLOWER_PATCH_SCALE) < 0 ? BlockType.Dandelion : BlockType.Poppy;
  }
  // 与花用同一个哈希值的另一段，长花的列与长矮草的列互不重叠
  return roll >= 1 - SHORT_GRASS_CHANCE ? BlockType.ShortGrass : undefined;
}
