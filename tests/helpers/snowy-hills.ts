import { BlockType } from '../../src/core/block';
import { Biome, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { SNOW_LINE_Y, STEEP_RISE } from '../../src/core/surface';

/**
 * 温度随高度下降（#87）的大范围采样：找冰雪旁的山丘与远离冰雪的平原小山。
 *
 * 只经地形对象的公共查询（`biomeAt`、`surfaceHeightAt`）。选列的条件只用地表高度与「低处冰雪列」：密度不依赖温度，
 * 地表高度在改前改后相同；低处（地表不高于 LOW_SNOWY_MAX_Y）的冰雪列按海平面附近的温度判出，温度随高度下降只会让
 * 它们更冷，不会变回平原。所以同一套条件在 main 与改后选出的山丘基本是同一批列，断言可以只看改后。
 */

/** 环上的采样半径（格）与 8 个方向：每列四周 16 个采样点。 */
const RING_RADII = [16, 32] as const;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 四周采样点：半径 radii 上 8 个方向各一点。 */
function ring(radii: readonly number[]): ReadonlyArray<readonly [number, number]> {
  return radii.flatMap((r) => DIRECTIONS.map(([dx, dz]) => [dx * r, dz * r] as const));
}

/** 比四周高出几格看的 32 格内 16 个采样点。 */
export const HILL_RING = ring(RING_RADII);

/** 紧挨冰雪看的 16 格处 8 个采样点：有一个是低处冰雪列就算紧挨。 */
export const NEAR_RING = ring([16]);

/** 平原内部看的 128 格内 24 个采样点（半径 32、64、128）。 */
export const FAR_RING = ring([32, 64, 128]);

/**
 * 低处冰雪列的地表上限：平原内陆的基准高度约 y 69，起伏幅度 5，所以 y 72 以下的冰雪列是按低处温度判出的，
 * 不是山丘被高度项变冷后才成为冰雪。
 */
export const LOW_SNOWY_MAX_Y = 72;

/** 冰雪旁的山丘：地表不低于它。main 上平原地表最高不到 y 80，紧挨冰雪的山丘都是高山群系的低处。 */
export const HILL_MIN_Y = 80;

/** 冰雪旁的山丘：地表比四周 16 个采样点的地表中位数高出至少这么多格。 */
export const HILL_RISE = 5;

/** 远离冰雪的平原小山：地表比四周 16 个采样点的地表中位数高出至少这么多格。平原起伏幅度 5，再高的几乎没有。 */
export const PLAINS_HILL_RISE = 2;

/** 中位数。 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 一列比四周 16 个采样点的地表中位数高出几格。 */
export function riseAboveSurroundings(terrain: Terrain, { x, z }: ColumnCoord): number {
  return terrain.surfaceHeightAt(x, z) - median(HILL_RING.map(([dx, dz]) => terrain.surfaceHeightAt(x + dx, z + dz)));
}

/** 采样的一列。 */
export interface SampledColumn extends ColumnCoord {
  readonly surface: number;
  readonly rise: number;
}

/** 网格上的列：x、z 从 -half 到 half（含），步长 step。 */
function* grid(half: number, step: number): Generator<ColumnCoord> {
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) yield { x, z };
  }
}

/** 这一列 16 格处的 8 个采样点里有没有低处冰雪列。 */
function nearLowSnowy(terrain: Terrain, { x, z }: ColumnCoord): boolean {
  return NEAR_RING.some(([dx, dz]) => {
    const px = x + dx;
    const pz = z + dz;
    return terrain.biomeAt(px, pz) === Biome.Snowy && terrain.surfaceHeightAt(px, pz) <= LOW_SNOWY_MAX_Y;
  });
}

/**
 * 冰雪旁的山丘：网格上地表在 HILL_MIN_Y 到雪线之间（不含雪线）、不是大海、16 格处有低处冰雪列、比四周高出至少
 * HILL_RISE 格的列。先按地表高度筛，再看群系，最后才求四周 16 个采样点的地表高度。
 */
export function snowyHillColumns(terrain: Terrain, half: number, step: number): SampledColumn[] {
  const found: SampledColumn[] = [];
  for (const column of grid(half, step)) {
    const surface = terrain.surfaceHeightAt(column.x, column.z);
    if (surface < HILL_MIN_Y || surface >= SNOW_LINE_Y) continue;
    if (terrain.biomeAt(column.x, column.z) === Biome.Ocean) continue;
    if (!nearLowSnowy(terrain, column)) continue;
    const rise = riseAboveSurroundings(terrain, column);
    if (rise >= HILL_RISE) found.push({ ...column, surface, rise });
  }
  return found;
}

/** 平原内部：四周采样点地表都不高于它（高山、山丘都比它高），列自身也不高于它。 */
export const PLAINS_INTERIOR_MAX_Y = 80;

/**
 * 远离冰雪的平原小山：网格上不是大海也不是高山、地表不高于 PLAINS_INTERIOR_MAX_Y、比四周高出至少 PLAINS_HILL_RISE 格，
 * 且 128 格内 24 个采样点里没有大海、没有地表高于 PLAINS_INTERIOR_MAX_Y 的列、没有低处冰雪列的列。
 *
 * 只看「附近没有冰雪」不够：寒冷处的高山与大海不是冰雪群系，离冰雪 256 格的平原温度也能低到 −0.1 附近
 * （main 01a0996 实测）。离大海、高处与低处冰雪都远的列在平原内部。条件只用地表高度、大海（只看大陆度）与低处冰雪列，
 * 不看采样点与列自身是不是平原：温度随高度下降可以让 y 73 到 80 的采样点合理地变成冰雪，不该因此把列剔掉；
 * 列自身变成冰雪正是要查的，所以也不按它的群系选。main 上这样选出的列全是平原、草方块。
 */
export function plainsInteriorHillColumns(terrain: Terrain, half: number, step: number): SampledColumn[] {
  const found: SampledColumn[] = [];
  const disqualifies = (x: number, z: number): boolean => {
    const surface = terrain.surfaceHeightAt(x, z);
    if (surface > PLAINS_INTERIOR_MAX_Y) return true;
    const biome = terrain.biomeAt(x, z);
    return biome === Biome.Ocean || (biome === Biome.Snowy && surface <= LOW_SNOWY_MAX_Y);
  };
  for (const column of grid(half, step)) {
    const biome = terrain.biomeAt(column.x, column.z);
    if (biome === Biome.Ocean || biome === Biome.Mountains) continue;
    const surface = terrain.surfaceHeightAt(column.x, column.z);
    if (surface > PLAINS_INTERIOR_MAX_Y) continue;
    if (FAR_RING.some(([dx, dz]) => disqualifies(column.x + dx, column.z + dz))) continue;
    const rise = riseAboveSurroundings(terrain, column);
    if (rise >= PLAINS_HILL_RISE) found.push({ ...column, surface, rise });
  }
  return found;
}

/** 陡坡（GLOSSARY.md「陡坡」）：与东南西北相邻列的地表高度差最大的那个不小于 STEEP_RISE。只用地表高度查询。 */
export function isSteep(terrain: Terrain, { x, z }: ColumnCoord): boolean {
  const h = terrain.surfaceHeightAt(x, z);
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dx, dz]) => Math.abs(terrain.surfaceHeightAt(x + dx!, z + dz!) - h) >= STEEP_RISE);
}

/**
 * 冰雪群系雪线以下、露出水面、不是水塘的列该铺的列顶地表方块（GLOSSARY.md「群系」「陡坡」）：陡坡是石头，其余是
 * 雪草方块。冰雪不算海岸，所以不看大海。
 */
export function expectedSnowyTop(terrain: Terrain, column: ColumnCoord): BlockType {
  return isSteep(terrain, column) ? BlockType.Stone : BlockType.SnowyGrass;
}
