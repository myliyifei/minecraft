import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { FLAT_GROUND_Y, flatTestTerrain, solidUpToSurface } from './flat-terrain';

/**
 * 原点是大海的假地形（#84）。
 *
 * 真实地形造不出这种种子：Perlin 噪声在整数格点为 0，三层群系参数在原点都取 0，任何种子下原点都是平原（#75 的报告）。
 * 出生列离开原点的情形因此只能用假地形测：原点周围一块方形的大海，外面是与 `flatTerrain` 相同的平原平地。
 */

/** 与原点的切比雪夫距离小于它的列是大海。取得比视距 2 覆盖的范围（约 ±40 格）大得多，出生列所在区块一开始不会同时加载。 */
export const OCEAN_HALF_WIDTH = 100;

/** 大海海底那一格（石头）的 y，低于海平面；其上到海平面是水。 */
export const OCEAN_FLOOR_Y = 45;

/**
 * 这份假地形的出生列：螺旋搜索在第 7 圈（距离 112）上第一次碰到平原，是那一圈第一段（x = 112，z 从 −96 起）的
 * 第一列，区块 (7, −6)。固定为这个值而不是每次重算，核心的测试因此不依赖搜索的实现；它与搜索结果一致由
 * tests/core/spawn-column.test.ts 断言。x 正、z 负，坐标写反或符号写错都会不一致。
 */
export const OCEAN_ORIGIN_SPAWN: ColumnCoord = Object.freeze({ x: 112, z: -96 });

/** 那一列是不是大海。 */
export function isOceanColumn(x: number, z: number): boolean {
  return Math.max(Math.abs(x), Math.abs(z)) < OCEAN_HALF_WIDTH;
}

/** 三个查询：大海那片给大海、海底高度与石头，其余与平地相同。 */
export const oceanOriginQueries: Pick<Terrain, 'biomeAt' | 'surfaceHeightAt' | 'surfaceBlockAt'> = {
  biomeAt: (x, z) => (isOceanColumn(x, z) ? Biome.Ocean : Biome.Plains),
  surfaceHeightAt: (x, z) => (isOceanColumn(x, z) ? OCEAN_FLOOR_Y : FLAT_GROUND_Y),
  surfaceBlockAt: (x, z) => (isOceanColumn(x, z) ? BlockType.Stone : BlockType.Grass),
};

/** 与查询一致的区块生成器：大海的列是基岩、石头到海底、水到海平面；其余列与平地相同。 */
export function oceanOriginChunk(cx: number, cz: number): Chunk {
  const chunk = flatTestTerrain(cx, cz);
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      if (!isOceanColumn(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)) continue;
      chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, OCEAN_FLOOR_Y, BlockType.Stone);
      chunk.fillColumn(lx, lz, OCEAN_FLOOR_Y + 1, SEA_LEVEL, BlockType.Water);
      chunk.fillColumn(lx, lz, SEA_LEVEL + 1, FLAT_GROUND_Y, BlockType.Air);
    }
  }
  return chunk;
}

/** 原点是大海的地形对象。签名与 `GameCoreOptions.terrain` 相同。 */
export function oceanOriginTerrain(seed: number): Terrain {
  return {
    seed,
    ...oceanOriginQueries,
    generateChunk: oceanOriginChunk,
    spawnColumn: OCEAN_ORIGIN_SPAWN,
    isSolidSpan: solidUpToSurface(oceanOriginQueries.surfaceHeightAt),
  };
}
