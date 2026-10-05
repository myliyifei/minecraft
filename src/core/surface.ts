import { BlockType } from './block';
import { Biome } from './biome';
import type { Chunk } from './chunk';
import { SEA_LEVEL } from './constants';
import { OCEAN_CONTINENTALNESS } from './terrain-density';

/**
 * 地表铺法（#76，CONTEXT.md「沙滩」「雪线」「群系」）：上方是空气或水的每一段地形方块，顶层按群系与坡度换成
 * 草方块、雪草方块、石头、沙子或沙砾，其下几层换成泥土或沙子。
 *
 * 规则只读「样本」：任意一列的地表高度、群系与大陆度。列顶地表方块查询从地形对象的纯函数取样本，区块生成从
 * 区块里已算好的数（区块连同四周一圈的地表高度、按列缓存的群系）取样本，两边调同一个 `highestTopBlock`，
 * 所以查询值与生成结果逐列一致，区块边缘的列也是。
 *
 * 最高那一段（地表高度那一格）的优先次序：
 * 1. 被水盖住（地表低于海平面）：顶面 y ≥ SHALLOW_FLOOR_MIN_Y 是沙子，更低是沙砾，不论群系。
 * 2. 陡坡：与东南西北四个相邻列的地表高度差最大的那个 ≥ STEEP_RISE，石头，不铺泥土。
 * 3. 海岸：地表不高于 BEACH_MAX_Y 的列，平原与冰雪在 BEACH_REACH 格内有大海时是沙滩（沙子），高山是石头岸；
 *    大海群系里露出水面的列在 BEACH_SEAWARD_REACH 格内与平原或冰雪相邻时也是沙子，沙滩向海一侧延伸两格。
 * 4. 雪线以上的高山、任意高度的冰雪、寒冷处大海群系里露出水面的列：雪草方块。
 * 5. 其余：草方块。
 *
 * 悬垂下方的段只按 1、4、5 铺（陡坡与海岸只看最高那一段），雪线按那一段顶面的 y 判断。
 */

/** 陡坡：与相邻列的地表高度差的绝对值最大的那个不小于它。四个种子的大范围采样里平原与冰雪几乎没有，高山约 13%。 */
export const STEEP_RISE = 3;

/** 雪线：高山的顶面 y 不小于它铺雪草方块（CONTEXT.md「雪线」约 y 150）。 */
export const SNOW_LINE_Y = 150;

/** 被水盖住的顶面 y 不小于它铺沙子（上面最多 7 格水），更低铺沙砾。 */
export const SHALLOW_FLOOR_MIN_Y = 56;

/** 沙滩与石头岸的地表最高 y：海平面之上 4 格。岸边的平原基准高度是海平面之上 1 到 5 格，这一条几乎不起作用。 */
export const BEACH_MAX_Y = SEA_LEVEL + 4;

/**
 * 海岸的判定距离（格）：平原、冰雪与高山的列沿 x、沿 z 四个方向各看 1 到 BEACH_REACH 格，有大海的列就是临海；
 * 大海群系里露出水面的列各看 1 到 BEACH_SEAWARD_REACH 格，与平原或冰雪相邻就铺沙子，沙滩向海一侧延伸。
 * 沙滩因此最宽 BEACH_REACH + BEACH_SEAWARD_REACH 格。
 *
 * 大海一侧只铺两格：三维密度地形的岸边是缓坡，水边多在大海群系里约 10 格处（三个种子的中位数 9 到 11 格），
 * 一直铺到水边沙滩就有十几格宽，所以沙滩与水边之间仍会留一条大海群系的草方块（寒冷处是雪草方块）。
 */
export const BEACH_REACH = 4;
export const BEACH_SEAWARD_REACH = 2;

/**
 * 大陆度离大海阈值不超过这么多的列才去找附近的大海。大陆度每格最多变 0.0035（四个种子的大范围采样），
 * 0.02 至少相当于 5.7 格，比 BEACH_REACH 宽，所以不会漏掉该找的列；内陆的列因此一次邻列也不看。
 */
export const COAST_CONTINENTALNESS_BAND = 0.02;

/** 规则读的样本：任意一列的地表高度、群系、大陆度，与是不是寒冷处（与海平面那层结冰同一个阈值）。 */
export interface SurfaceSamples {
  readonly heightAt: (x: number, z: number) => number;
  readonly biomeAt: (x: number, z: number) => Biome;
  readonly continentalnessAt: (x: number, z: number) => number;
  readonly isColdAt: (x: number, z: number) => boolean;
}

/** 沿 x、沿 z 四个方向各 1 到 reach 格的偏移，近的在前，找到就停。 */
function axisOffsets(reach: number): ReadonlyArray<readonly [number, number]> {
  return Array.from({ length: reach }, (_, i) => i + 1).flatMap(
    (k) =>
      [
        [k, 0],
        [-k, 0],
        [0, k],
        [0, -k],
      ] as const,
  );
}

const LANDWARD_OFFSETS = axisOffsets(BEACH_REACH);
const SEAWARD_OFFSETS = axisOffsets(BEACH_SEAWARD_REACH);

/** 被水盖住的顶面：浅处沙子，深处沙砾。 */
export function underwaterFloorAt(y: number): BlockType {
  return y >= SHALLOW_FLOOR_MIN_Y ? BlockType.Sand : BlockType.Gravel;
}

/**
 * 露出水面、不是陡坡也不在海岸的顶面：冰雪、雪线以上的高山与寒冷处的大海群系是雪草方块，其余是草方块。
 * cold 只对大海群系起作用：陆地上的寒冷处已经分成了冰雪群系，海面结冰的地方露出水面的列也该是雪。
 */
export function exposedTopAt(biome: Biome, y: number, cold: boolean): BlockType {
  if (biome === Biome.Snowy || (biome === Biome.Mountains && y >= SNOW_LINE_Y)) return BlockType.SnowyGrass;
  if (biome === Biome.Ocean && cold) return BlockType.SnowyGrass;
  return BlockType.Grass;
}

/** 这一列是不是寒冷处的大海群系：只有大海群系才问温度。 */
function isColdOcean(samples: SurfaceSamples, x: number, z: number, biome: Biome): boolean {
  return biome === Biome.Ocean && samples.isColdAt(x, z);
}

/** 与东南西北四个相邻列的地表高度差的绝对值里最大的那个。 */
function maxNeighborRise(samples: SurfaceSamples, x: number, z: number, h: number): number {
  return Math.max(
    Math.abs(samples.heightAt(x + 1, z) - h),
    Math.abs(samples.heightAt(x - 1, z) - h),
    Math.abs(samples.heightAt(x, z + 1) - h),
    Math.abs(samples.heightAt(x, z - 1) - h),
  );
}

/** 这几个偏移上有没有满足条件的列。 */
function anyNear(
  offsets: ReadonlyArray<readonly [number, number]>,
  x: number,
  z: number,
  test: (x: number, z: number) => boolean,
): boolean {
  for (const [dx, dz] of offsets) if (test(x + dx, z + dz)) return true;
  return false;
}

/** 海岸上的列顶：沙子或石头；不在海岸返回 undefined。地表已知露出水面且不高于 BEACH_MAX_Y。 */
function coastTop(samples: SurfaceSamples, x: number, z: number, biome: Biome): BlockType | undefined {
  const c = samples.continentalnessAt(x, z);
  const ocean = OCEAN_CONTINENTALNESS;
  if (biome === Biome.Ocean) {
    // 大海一侧露出水面的列：与平原或冰雪相邻时铺沙子，沙滩向海一侧延伸两格。
    if (c < ocean - COAST_CONTINENTALNESS_BAND) return undefined;
    const beachLand = (bx: number, bz: number): boolean => {
      const b = samples.biomeAt(bx, bz);
      return b === Biome.Plains || b === Biome.Snowy;
    };
    return anyNear(SEAWARD_OFFSETS, x, z, beachLand) ? BlockType.Sand : undefined;
  }
  if (c >= ocean + COAST_CONTINENTALNESS_BAND) return undefined;
  if (!anyNear(LANDWARD_OFFSETS, x, z, (ox, oz) => samples.continentalnessAt(ox, oz) < ocean)) return undefined;
  return biome === Biome.Mountains ? BlockType.Stone : BlockType.Sand;
}

/**
 * 列顶地表方块：一列地表高度那一格铺什么（优先次序见本模块开头）。列在水塘里给出水由水塘那一步（#81）加。
 */
export function highestTopBlock(samples: SurfaceSamples, x: number, z: number): BlockType {
  const h = samples.heightAt(x, z);
  if (h < SEA_LEVEL) return underwaterFloorAt(h);
  if (maxNeighborRise(samples, x, z, h) >= STEEP_RISE) return BlockType.Stone;
  const biome = samples.biomeAt(x, z);
  if (h <= BEACH_MAX_Y) {
    const coast = coastTop(samples, x, z, biome);
    if (coast !== undefined) return coast;
  }
  return exposedTopAt(biome, h, isColdOcean(samples, x, z, biome));
}

/** 顶层之下铺几层什么：草方块与雪草方块下是泥土，沙子、沙砾下是同一种，石头下不铺。 */
function fillerBelow(top: BlockType): BlockType | undefined {
  switch (top) {
    case BlockType.Grass:
    case BlockType.SnowyGrass:
      return BlockType.Dirt;
    case BlockType.Sand:
    case BlockType.Gravel:
      return top;
    default:
      return undefined;
  }
}

/** 一列铺地表要的输入。 */
export interface ColumnCover {
  /** 自这一格往下扫，之上没有地形方块。 */
  readonly top: number;
  /** 这一格及以下整段是石头，扫到这里且下层铺完就停。 */
  readonly solidTop: number;
  /** 顶层之下铺几层。 */
  readonly depth: number;
  /** 最高那一段的顶层（`highestTopBlock`）。 */
  readonly highest: BlockType;
  /** 这一列的群系：悬垂下方的段按它铺。 */
  readonly biome: Biome;
  /** 这一列是不是寒冷处的大海群系（`exposedTopAt` 的 cold）。 */
  readonly coldOcean: boolean;
}

/**
 * 铺一列的地表：自上而下，上方不是石头（空气、水或冰）的每一段石头，顶层换成规则给的方块，其下 depth 层换成
 * 泥土或沙子，那一段不够厚时到段底为止。第一段是最高那一段，顶层用 `highest`；其下各段被水盖住时按深浅铺沙子
 * 或沙砾，否则按群系与那一段顶面的 y 铺。
 */
export function coverColumn(chunk: Chunk, lx: number, lz: number, cover: ColumnCover): void {
  const { top, solidTop, depth, highest, biome, coldOcean: cold } = cover;
  let aboveSolid = false;
  let first = true;
  let filler: BlockType | undefined;
  let left = 0;
  for (let y = top; y > solidTop || left > 0; y--) {
    const solid = chunk.get(lx, y, lz) === BlockType.Stone;
    if (solid && !aboveSolid) {
      let block: BlockType;
      if (first) {
        block = highest;
        first = false;
      } else {
        const above = chunk.get(lx, y + 1, lz);
        block = above === BlockType.Water || above === BlockType.Ice ? underwaterFloorAt(y) : exposedTopAt(biome, y, cold);
      }
      chunk.set(lx, y, lz, block);
      filler = fillerBelow(block);
      left = filler === undefined ? 0 : depth;
    } else if (solid && left > 0) {
      chunk.set(lx, y, lz, filler!);
      left--;
    } else if (!solid) {
      left = 0;
    }
    aboveSolid = solid;
  }
}
