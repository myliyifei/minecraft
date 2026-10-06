import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, createTerrain, type Terrain } from '../../src/core/terrain';
import type { ChunkCoord } from '../../src/core/world';
import { analyzeConnectivity, type ConnectivityReport, type FloatingBlock } from '../helpers/floating-terrain';
import {
  chunkCache,
  chunkOfColumn,
  columnIn,
  gridColumns,
  hasOverhang,
  highestTerrainY,
  isInterior,
  isPondColumn,
  isTerrainBlock,
  SURVEY_SEEDS,
} from '../helpers/terrain-survey';

/**
 * 高山悬空地形块（#86）：三维连通分析下没有不与地面相连的地形块，高山里仍有悬垂，四个查询仍与生成结果一致。
 *
 * 采样（QA 定，见 .scratch/seams-86.md）：每个种子在 ±2560 格、步长 64 的网格上找高山内部的列（东南西北 32 格外
 * 也是高山），按地表高度从高到低取 WINDOWS_PER_SEED 个山顶，彼此相隔至少 WINDOW 个区块；以每个山顶所在区块为中心
 * 取 WINDOW×WINDOW 个区块合成一块做连通分析（`tests/helpers/floating-terrain.ts`）。悬空块多在山顶一带，所以按山顶取。
 * 碰到合并体侧面的连通块判不定、不计入；没碰到侧面的连通块在整个世界里也是孤立的，不会误报。
 * 改前三个种子 9 个合并体里有 11 块悬空块，最大 2380 格（y 179 到 194），水平外接矩形最大 26 格。
 *
 * 阈值：悬空块数量为 0（#86「去掉」的字面）。
 * 耗时：每个合并体 100 个区块，生成加连通分析约 0.8 秒；查询一致的用例只抽查部分列。本文件在当前机器上合计约 16 秒（上限 30 秒）。
 */

/** 合并体边长（区块）。160 格，比改前最大的悬空块（水平 26 格）大得多。 */
const WINDOW = 10;

/** 每个种子取几个山顶。 */
const WINDOWS_PER_SEED = 3;

const FIND_HALF = 2560;
const FIND_STEP = 64;
const INTERIOR_REACH = 32;

/**
 * 高山列里悬垂列占比的下限。ADR-0021 #75 补记：随机取的高山区块里 2% 到 11%（随种子）；改前这些山顶合并体里的
 * 高山列合计约 13%。去掉悬空块只删掉不与山体相连的格，与山体相连的悬垂仍在，按 ADR 的下端 2% 断言。
 */
const MIN_OVERHANG_SHARE = 0.02;

/** 回归用例：#82 实机验收找到最大那块悬空块（136 格，y 183 到 186，中心约 (720, −122)）的种子与位置。 */
const REGRESSION_SEED = 20_261_772;
const REGRESSION_CENTER: ChunkCoord = { cx: 45, cz: -8 };

const chunkAt = chunkCache(createTerrain);

/** 以 center 为中心的合并体 cx、cz 最小一角的区块。 */
function originOf(center: ChunkCoord): ChunkCoord {
  return { cx: center.cx - (WINDOW >> 1), cz: center.cz - (WINDOW >> 1) };
}

/** 合并体里的区块坐标。 */
function* chunksOf(origin: ChunkCoord): Generator<ChunkCoord> {
  for (let i = 0; i < WINDOW; i++) {
    for (let k = 0; k < WINDOW; k++) yield { cx: origin.cx + k, cz: origin.cz + i };
  }
}

const peaksBySeed = new Map<number, ChunkCoord[]>();
/** 一个种子的山顶合并体 cx、cz 最小一角的区块：高山内部按地表高度从高到低，彼此相隔至少 WINDOW 个区块。 */
function windowsOf(seed: number): ChunkCoord[] {
  const cached = peaksBySeed.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);
  const peaks = [...gridColumns(FIND_HALF, FIND_STEP)]
    .filter((c) => terrain.biomeAt(c.x, c.z) === Biome.Mountains && isInterior(terrain, c, INTERIOR_REACH))
    .map((c) => ({ c, h: terrain.surfaceHeightAt(c.x, c.z) }))
    .sort((a, b) => b.h - a.h);
  const centers: ChunkCoord[] = [];
  for (const { c } of peaks) {
    if (centers.length >= WINDOWS_PER_SEED) break;
    const chunk = chunkOfColumn(c);
    const apart = centers.every((p) => Math.max(Math.abs(p.cx - chunk.cx), Math.abs(p.cz - chunk.cz)) >= WINDOW);
    if (apart) centers.push(chunk);
  }
  const origins = centers.map(originOf);
  peaksBySeed.set(seed, origins);
  return origins;
}

const reports = new Map<string, ConnectivityReport>();
function reportOf(seed: number, origin: ChunkCoord): ConnectivityReport {
  const key = `${seed}:${origin.cx},${origin.cz}`;
  let report = reports.get(key);
  if (!report) {
    report = analyzeConnectivity((coord) => chunkAt(seed, coord), origin, WINDOW);
    reports.set(key, report);
  }
  return report;
}

function describeBlock(seed: number, block: FloatingBlock): string {
  const { size, minY, maxY, extent, center } = block;
  return `种子 ${seed}：${size} 格，y ${minY} 到 ${maxY}，水平 ${extent} 格，中心约 (${center.x}, ${center.y}, ${center.z})`;
}

/** 合并体里每个区块的每一列。 */
function eachColumn(
  seed: number,
  origin: ChunkCoord,
  visit: (chunk: Chunk, lx: number, lz: number, x: number, z: number) => void,
): void {
  for (const coord of chunksOf(origin)) {
    const chunk = chunkAt(seed, coord);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const { x, z } = columnIn(coord, lx, lz);
        visit(chunk, lx, lz, x, z);
      }
    }
  }
}

/** 抽查的列：区块边缘一圈全取，内部隔一列取一列。 */
function sampled(lx: number, lz: number): boolean {
  const edge = lx === 0 || lz === 0 || lx === CHUNK_SIZE - 1 || lz === CHUNK_SIZE - 1;
  return edge || ((lx & 1) === 0 && (lz & 1) === 0);
}

function sameBlocks(a: Chunk, b: Chunk): boolean {
  return Buffer.from(a.blocks).equals(Buffer.from(b.blocks));
}

describe('不与地面相连的地形块', () => {
  it.each(SURVEY_SEEDS)(
    `种子 %i：${WINDOWS_PER_SEED} 个山顶各 ${WINDOW}×${WINDOW} 个区块的合并体里，不与地面相连的地形块数量为 0`,
    (seed) => {
      const origins = windowsOf(seed);
      expect(origins.length, `种子 ${seed} 找到的山顶数`).toBe(WINDOWS_PER_SEED);
      const floating: string[] = [];
      for (const origin of origins) {
        const report = reportOf(seed, origin);
        expect(report.terrainBlocks, `合并体 (${origin.cx}, ${origin.cz}) 的地形方块数`).toBeGreaterThan(0);
        for (const block of report.floating) floating.push(describeBlock(seed, block));
      }
      expect(floating).toEqual([]);
    },
  );

  it(`回归：种子 ${REGRESSION_SEED} 原 (720, −122) 一带 y 183 到 186 没有不与地面相连的地形块`, () => {
    const report = reportOf(REGRESSION_SEED, originOf(REGRESSION_CENTER));
    const inBand = report.floating.filter((block) => block.minY <= 186 && block.maxY >= 183);
    expect(inBand.map((block) => describeBlock(REGRESSION_SEED, block))).toEqual([]);
    expect(report.floating.map((block) => describeBlock(REGRESSION_SEED, block))).toEqual([]);
  });
});

describe('与山体相连的悬垂仍在', () => {
  it(`山顶合并体里的高山列（隔一列取一列），悬垂列（上方实心、中间空气、下方又是实心）合计占比不低于 ${MIN_OVERHANG_SHARE * 100}%`, () => {
    let columns = 0;
    let overhangs = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const origin of windowsOf(seed)) {
        eachColumn(seed, origin, (chunk, lx, lz, x, z) => {
          if ((lx & 1) !== 0 || (lz & 1) !== 0 || terrain.biomeAt(x, z) !== Biome.Mountains) return;
          columns++;
          if (hasOverhang(chunk, lx, lz)) overhangs++;
        });
      }
    }
    expect(columns, '查过的高山列数').toBeGreaterThan(0);
    expect(overhangs / columns, `悬垂列 ${overhangs}/${columns}`).toBeGreaterThanOrEqual(MIN_OVERHANG_SHARE);
  });
});

describe('查询与生成结果一致（山顶合并体）', () => {
  /** 查询用另一个地形对象：没有生成过任何区块，查询不能依赖生成器留下的状态。 */
  const queriesOf = (seed: number): Terrain => createTerrain(seed);

  it.each(SURVEY_SEEDS)('种子 %i：区块边缘一圈与内部隔一列取一列，地表高度查询等于最高的地形方块，列顶地表方块查询等于那一格', (seed) => {
    const terrain = queriesOf(seed);
    const wrong: string[] = [];
    for (const origin of windowsOf(seed)) {
      eachColumn(seed, origin, (chunk, lx, lz, x, z) => {
        if (!sampled(lx, lz)) return;
        const expected = terrain.surfaceHeightAt(x, z);
        const actual = highestTerrainY(chunk, lx, lz);
        const block = terrain.surfaceBlockAt(x, z);
        if (block === BlockType.Water) {
          // 水塘列（#81，列顶地表方块查询是水）：地表高度是挖之前的值，那一格是水，最高的地形方块是塘底
          if (actual > expected || chunk.get(lx, expected, lz) !== BlockType.Water) {
            wrong.push(`水塘列 (${x}, ${z})：查询 ${expected}，最高的地形方块 ${actual}`);
          }
          return;
        }
        if (actual !== expected) wrong.push(`(${x}, ${z})：地表高度查询 ${expected}，生成 ${actual}`);
        if (chunk.get(lx, expected, lz) !== block) {
          wrong.push(`(${x}, ${z})：列顶地表方块查询 ${block}，生成 ${chunk.get(lx, expected, lz)}`);
        }
      });
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：单列实心段查询与生成一致：最高那一段地形方块是实心段，再往下一格不是（隔一列取一列）', (seed) => {
    const terrain = queriesOf(seed);
    const wrong: string[] = [];
    for (const origin of windowsOf(seed)) {
      eachColumn(seed, origin, (chunk, lx, lz, x, z) => {
        if ((lx & 1) !== 0 || (lz & 1) !== 0 || isPondColumn(terrain, x, z)) return;
        const top = highestTerrainY(chunk, lx, lz);
        let bottom = top;
        while (bottom > WORLD_MIN_Y && isTerrainBlock(chunk.get(lx, bottom - 1, lz))) bottom--;
        if (!terrain.isSolidSpan(x, z, bottom, top)) wrong.push(`(${x}, ${z})：y ${bottom} 到 ${top} 应是实心段`);
        if (bottom > WORLD_MIN_Y && terrain.isSolidSpan(x, z, bottom - 1, bottom - 1)) {
          wrong.push(`(${x}, ${z})：y ${bottom - 1} 不是地形方块，查询说是`);
        }
      });
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('单列实心段查询逐格与生成一致（回归一带）', () => {
  it(`种子 ${REGRESSION_SEED}：原悬空块所在区块与周围 8 个区块，y 150 到 210 每一格查询是否实心等于生成后那一格是不是地形方块`, () => {
    // 原 136 格那块悬空块在区块 (45, −8)：那些格密度为正，查询若不按去掉悬空块的判定回答，会说它们是实心
    const terrain = createTerrain(REGRESSION_SEED);
    const wrong: string[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const coord: ChunkCoord = { cx: REGRESSION_CENTER.cx + dx, cz: REGRESSION_CENTER.cz + dz };
        const chunk = chunkAt(REGRESSION_SEED, coord);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const { x, z } = columnIn(coord, lx, lz);
            if (isPondColumn(terrain, x, z)) continue;
            for (let y = 150; y <= 210; y++) {
              const generated = isTerrainBlock(chunk.get(lx, y, lz));
              if (terrain.isSolidSpan(x, z, y, y) !== generated) {
                wrong.push(`(${x}, ${y}, ${z})：查询 ${!generated}，生成 ${generated}`);
              }
            }
          }
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('确定性（山顶合并体）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：合并体里生成过整片之后的区块，与新地形对象只生成那一个区块逐字节相同', (seed) => {
    for (const origin of windowsOf(seed)) {
      // 合并体中心与四个角上的区块：悬空块的判断若依赖生成顺序或相邻区块，边上的区块最先暴露
      const picks: ChunkCoord[] = [
        { cx: origin.cx + (WINDOW >> 1), cz: origin.cz + (WINDOW >> 1) },
        origin,
        { cx: origin.cx + WINDOW - 1, cz: origin.cz },
        { cx: origin.cx, cz: origin.cz + WINDOW - 1 },
        { cx: origin.cx + WINDOW - 1, cz: origin.cz + WINDOW - 1 },
      ];
      for (const coord of picks) {
        const warm = chunkAt(seed, coord);
        const fresh = createTerrain(seed).generateChunk(coord.cx, coord.cz);
        expect(sameBlocks(warm, fresh), `种子 ${seed} 区块 (${coord.cx}, ${coord.cz})`).toBe(true);
      }
    }
  });

  it.each(SURVEY_SEEDS)('种子 %i：山顶区块与相邻区块，先 A 后 B 与先 B 后 A 结果相同', (seed) => {
    const origin = windowsOf(seed)[0]!;
    const a: ChunkCoord = { cx: origin.cx + (WINDOW >> 1), cz: origin.cz + (WINDOW >> 1) };
    const b: ChunkCoord = { cx: a.cx + 1, cz: a.cz };
    const forwards = createTerrain(seed);
    const a1 = forwards.generateChunk(a.cx, a.cz);
    const b1 = forwards.generateChunk(b.cx, b.cz);
    const backwards = createTerrain(seed);
    const b2 = backwards.generateChunk(b.cx, b.cz);
    const a2 = backwards.generateChunk(a.cx, a.cz);
    expect(sameBlocks(a1, a2)).toBe(true);
    expect(sameBlocks(b1, b2)).toBe(true);
  });
});
