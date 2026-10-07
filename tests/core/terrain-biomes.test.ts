import { describe, expect, it } from 'vitest';
import { Biome, createTerrain, type ColumnCoord } from '../../src/core/terrain';
import {
  boundariesOn,
  boundaryKind,
  chunkCache,
  completeRuns,
  gridColumns,
  hasOverhang,
  isInterior,
  SURVEY_SEEDS,
  surveyLines,
  weightedMedianLength,
  chunkOfColumn,
  type BiomeBoundary,
  type BiomeRun,
} from '../helpers/terrain-survey';
import { localOf } from '../../src/core/world';
import { SEA_LEVEL } from '../../src/core/constants';
import { SNOW_LINE_Y } from '../../src/core/surface';

/**
 * 群系的分布与各群系的高度（#75 验收条件第二、三条）。
 *
 * 只调地形对象的 `biomeAt` 与 `surfaceHeightAt`，只有判「悬垂除外」时才生成区块。数值断言都是统计或范围，
 * 期望值来自 issue 与 GLOSSARY.md「群系」：一片 300 到 600 格宽、高山最高约 y 200、海底 y 40 到 55。
 *
 * 采样：群系沿每个种子 8 条跨 ±8192 格的采样线、步长 8；高度在 ±4096 格、步长 128 的网格上，另在最高的
 * 10 个高山采样点周围各取 9×9、步长 8 的小网格找山顶。
 */

/** 四种群系（GLOSSARY.md「群系」）。 */
const ALL_BIOMES = [Biome.Plains, Biome.Mountains, Biome.Snowy, Biome.Ocean];

/** 采样线的步长（格）。 */
const LINE_STEP = 8;

/** 高度网格的半宽与步长（格）。 */
const GRID_HALF = 4096;
const GRID_STEP = 128;

/** 找山顶：取最高的几个高山采样点，在每个周围铺一张小网格。 */
const PEAK_PROBES = 10;
const PEAK_RADIUS = 4;
const PEAK_STEP = 8;

/** issue 给的高度界限。 */
const MAX_SURFACE_Y = 210;
const PEAK_AT_LEAST_Y = 170;
const OCEAN_FLOOR_MIN_Y = 40;
const OCEAN_FLOOR_MAX_Y = 55;

/**
 * 冰雪列里最高的地表离雪线不超过几格（#87）。寒冷处的山坡在雪线以下都是冰雪，大范围采样里最高的冰雪列应贴近雪线；
 * 三个种子实测都是 y 149，留 10 格余量。改前冰雪只在起伏不大的陆地上，最高只到 y 77。
 */
const SNOWY_BELOW_SNOW_LINE = 10;

/** 「高山列的平均地表比平原高出若干格」里的若干格。 */
const MOUNTAIN_ABOVE_PLAINS = 20;

/** 判「大海内部」：东南西北各这么远的列也是大海。 */
const INTERIOR_REACH = 64;

/** 每条采样线最多取几个交界。8 条线一共约 60 个。 */
const BOUNDARIES_PER_LINE = 8;

/** 交界那一对两侧各看几列。 */
const BOUNDARY_WINDOW = 4;

/**
 * 群系交界处相邻两列地表高度差的上限（QA 定）。平滑过渡下交界处的坡与群系内部一样缓，陡壁与悬垂来自三维噪声，
 * 窗口里有悬垂列时豁免。
 */
const BOUNDARY_STEP_CAP = 12;

/** 一列的采样结果。 */
interface ColumnSample extends ColumnCoord {
  readonly biome: Biome;
  readonly surface: number;
}

/** 每个种子的高度采样只算一次，几条断言共用。 */
const heightSurveys = new Map<number, { grid: ColumnSample[]; peaks: ColumnSample[] }>();
function heightSurvey(seed: number): { grid: ColumnSample[]; peaks: ColumnSample[] } {
  const cached = heightSurveys.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);
  const sample = ({ x, z }: ColumnCoord): ColumnSample => ({
    x,
    z,
    biome: terrain.biomeAt(x, z),
    surface: terrain.surfaceHeightAt(x, z),
  });
  const grid = [...gridColumns(GRID_HALF, GRID_STEP)].map(sample);
  const highest = grid
    .filter(({ biome }) => biome === Biome.Mountains)
    .sort((a, b) => b.surface - a.surface)
    .slice(0, PEAK_PROBES);
  const peaks: ColumnSample[] = [];
  for (const top of highest) {
    for (let dx = -PEAK_RADIUS; dx <= PEAK_RADIUS; dx++) {
      for (let dz = -PEAK_RADIUS; dz <= PEAK_RADIUS; dz++) {
        peaks.push(sample({ x: top.x + dx * PEAK_STEP, z: top.z + dz * PEAK_STEP }));
      }
    }
  }
  const survey = { grid, peaks };
  heightSurveys.set(seed, survey);
  return survey;
}

/** 某个种子全部的高度采样。 */
function allSamples(seed: number): ColumnSample[] {
  const { grid, peaks } = heightSurvey(seed);
  return [...grid, ...peaks];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

describe('群系常量', () => {
  it('有且只有四种群系：平原、高山、冰雪、大海，值互不相同', () => {
    expect(new Set(Object.values(Biome)).size).toBe(4);
    expect(new Set(Object.values(Biome))).toEqual(new Set(ALL_BIOMES));
  });
});

describe('四种群系都出现', () => {
  it.each(SURVEY_SEEDS)('种子 %i：±8192 格、步长 64 的网格上四种群系都有', (seed) => {
    const terrain = createTerrain(seed);
    const seen = new Set<Biome>();
    for (const { x, z } of gridColumns(8192, 64)) seen.add(terrain.biomeAt(x, z));
    expect(seen).toEqual(new Set(ALL_BIOMES));
  });
});

describe('连续一片同一群系的宽度大多在 300 到 600 格', () => {
  /*
   * 采样线穿过一片群系截出的是弦，不是宽度：穿过直径 D 的圆，按长度加权有 94% 的弦不短于 D/2，平均约 0.8D。
   * 所以判据是：按长度加权的弦长中位数在 240 到 900 格（0.8 × 300 到 1.5 × 600，上限给狭长的片留余地），
   * 且至少六成的总长度落在 150 到 1200 格的段里（交界处一两格的来回跳动不能多）。
   */
  const MEDIAN_MIN = 240;
  const MEDIAN_MAX = 900;
  const TYPICAL_MIN = 150;
  const TYPICAL_MAX = 1200;
  const TYPICAL_SHARE = 0.6;
  /** 每个种子 8 条线、每条 16384 格，一片 300 到 600 格的话至少有几十段。 */
  const MIN_RUNS = 40;

  function runsOf(seed: number): BiomeRun[] {
    const terrain = createTerrain(seed);
    return surveyLines(LINE_STEP).flatMap((line) => completeRuns(terrain, line));
  }

  it.each(SURVEY_SEEDS)('种子 %i：段数够多，弦长中位数与常见长度都在范围里', (seed) => {
    const runs = runsOf(seed);
    expect(runs.length).toBeGreaterThanOrEqual(MIN_RUNS);

    const median = weightedMedianLength(runs);
    expect(median).toBeGreaterThanOrEqual(MEDIAN_MIN);
    expect(median).toBeLessThanOrEqual(MEDIAN_MAX);

    const total = runs.reduce((sum, run) => sum + run.length, 0);
    const typical = runs
      .filter(({ length }) => length >= TYPICAL_MIN && length <= TYPICAL_MAX)
      .reduce((sum, run) => sum + run.length, 0);
    expect(typical / total).toBeGreaterThanOrEqual(TYPICAL_SHARE);
  });
});

describe('各群系的高度', () => {
  it(`地表高度不超过 y ${MAX_SURFACE_Y}`, () => {
    const tooHigh: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      for (const { x, z, surface } of allSamples(seed)) {
        if (surface > MAX_SURFACE_Y) tooHigh.push(`种子 ${seed} (${x}, ${z}) → ${surface}`);
      }
    }
    expect(tooHigh).toEqual([]);
  });

  it.each(SURVEY_SEEDS)(`种子 %i：高山列的平均地表比平原高出至少 ${MOUNTAIN_ABOVE_PLAINS} 格`, (seed) => {
    const { grid } = heightSurvey(seed);
    const mountains = grid.filter(({ biome }) => biome === Biome.Mountains).map(({ surface }) => surface);
    const plains = grid.filter(({ biome }) => biome === Biome.Plains).map(({ surface }) => surface);
    expect(mountains.length, '高山采样列数').toBeGreaterThanOrEqual(30);
    expect(plains.length, '平原采样列数').toBeGreaterThanOrEqual(30);
    expect(mean(mountains) - mean(plains)).toBeGreaterThanOrEqual(MOUNTAIN_ABOVE_PLAINS);
  });

  it(`最高的地表不低于 y ${PEAK_AT_LEAST_Y}`, () => {
    const highest = Math.max(
      ...SURVEY_SEEDS.flatMap((seed) =>
        allSamples(seed)
          .filter(({ biome }) => biome === Biome.Mountains)
          .map(({ surface }) => surface),
      ),
    );
    expect(highest).toBeGreaterThanOrEqual(PEAK_AT_LEAST_Y);
  });

  it.each(SURVEY_SEEDS)('种子 %i：大海与陆地按海平面分开，平原与冰雪的列地表低于海平面的不到 5%', (seed) => {
    // 先按大陆度分海与陆，地形的海陆也由大陆度决定：两者不一致时，陆地群系里会有成片的海底
    const land = heightSurvey(seed).grid.filter(({ biome }) => biome === Biome.Plains || biome === Biome.Snowy);
    expect(land.length, '平原与冰雪的采样列数').toBeGreaterThanOrEqual(30);
    const below = land.filter(({ surface }) => surface < SEA_LEVEL);
    expect(below.length / land.length).toBeLessThan(0.05);
  });

  // #87 用户决定：寒冷处地表在雪线以下的高山判为冰雪，寒冷处的高山只剩雪线以上的部分。改前起伏大的陆地不论冷暖都是
  // 高山，冰雪列的地表最高只到 y 75 到 77；改后寒冷处的山坡一直到雪线下一格都是冰雪（三个种子都到 y 149）。
  it.each(SURVEY_SEEDS)(
    `种子 %i：冰雪列的地表都在雪线 y ${SNOW_LINE_Y} 以下、最高到雪线下 ${SNOWY_BELOW_SNOW_LINE} 格以内，地表在雪线及以上的陆地列都是高山`,
    (seed) => {
      const samples = allSamples(seed);
      const snowyTop = Math.max(...samples.filter(({ biome }) => biome === Biome.Snowy).map(({ surface }) => surface));
      expect(snowyTop, '冰雪列里最高的地表').toBeLessThan(SNOW_LINE_Y);
      expect(snowyTop, '冰雪列里最高的地表').toBeGreaterThanOrEqual(SNOW_LINE_Y - SNOWY_BELOW_SNOW_LINE);
      const aboveSnowLine = samples.filter(({ surface }) => surface >= SNOW_LINE_Y);
      expect(aboveSnowLine.length, '地表在雪线及以上的采样列数').toBeGreaterThanOrEqual(30);
      expect(aboveSnowLine.filter(({ biome }) => biome !== Biome.Mountains)).toEqual([]);
    },
  );

  it(`大海内部的列，海底至少 95% 在 y ${OCEAN_FLOOR_MIN_Y} 到 ${OCEAN_FLOOR_MAX_Y}`, () => {
    // 靠岸的大海列海底往上抬（群系之间平滑过渡），所以只看四周 64 格外也是大海的列
    const floors: number[] = [];
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const sample of heightSurvey(seed).grid) {
        if (sample.biome === Biome.Ocean && isInterior(terrain, sample, INTERIOR_REACH)) floors.push(sample.surface);
      }
    }
    expect(floors.length, '大海内部的采样列数').toBeGreaterThanOrEqual(30);
    const inRange = floors.filter((y) => y >= OCEAN_FLOOR_MIN_Y && y <= OCEAN_FLOOR_MAX_Y);
    expect(inRange.length / floors.length).toBeGreaterThanOrEqual(0.95);
  });
});

describe('群系交界处相邻列的地表高度差有上限（悬垂除外）', () => {
  /** 交界那一对两侧各 BOUNDARY_WINDOW 列，共 2 × BOUNDARY_WINDOW + 2 列，按 axis 排好。 */
  function windowOf({ axis, a }: BiomeBoundary): ColumnCoord[] {
    const columns: ColumnCoord[] = [];
    for (let d = -BOUNDARY_WINDOW; d <= BOUNDARY_WINDOW + 1; d++) {
      columns.push(axis === 'x' ? { x: a.x + d, z: a.z } : { x: a.x, z: a.z + d });
    }
    return columns;
  }

  it.each(SURVEY_SEEDS)(`种子 %i：交界两侧各 ${BOUNDARY_WINDOW} 列里，相邻列高差不超过 ${BOUNDARY_STEP_CAP}`, (seed) => {
    const terrain = createTerrain(seed);
    const chunkAt = chunkCache(createTerrain);
    const boundaries = surveyLines(LINE_STEP).flatMap((line) => boundariesOn(terrain, line, BOUNDARIES_PER_LINE));
    expect(boundaries.length, '交界数').toBeGreaterThanOrEqual(30);
    expect(new Set(boundaries.map(boundaryKind)).size, '交界的种类').toBeGreaterThanOrEqual(3);

    const overhangIn = (columns: ColumnCoord[]): boolean =>
      columns.some((column) => hasOverhang(chunkAt(seed, chunkOfColumn(column)), localOf(column.x), localOf(column.z)));

    const violations: string[] = [];
    for (const boundary of boundaries) {
      const columns = windowOf(boundary);
      const heights = columns.map(({ x, z }) => terrain.surfaceHeightAt(x, z));
      for (let i = 0; i + 1 < columns.length; i++) {
        const step = Math.abs(heights[i + 1]! - heights[i]!);
        if (step <= BOUNDARY_STEP_CAP) continue;
        if (overhangIn(columns)) break;
        const { x, z } = columns[i]!;
        violations.push(`${boundaryKind(boundary)} 交界 (${x}, ${z}) 沿 ${boundary.axis}：${heights[i]} → ${heights[i + 1]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
