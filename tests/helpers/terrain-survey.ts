import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import type { Biome, ColumnCoord, Terrain } from '../../src/core/terrain';
import { chunkOf, localOf, type ChunkCoord } from '../../src/core/world';

/**
 * 三维密度地形（#75）的大范围采样工具：沿采样线读群系、找群系交界、按群系找列、读区块里一列的结构。
 *
 * 只经地形对象的公共查询与生成器，不碰密度函数。各测试文件共用，采样范围与步长由调用方给。
 */

/** 大范围采样用的几个种子，与 tests/core/terrain-object.test.ts 相同，都与 DEFAULT_SEED 无关。 */
export const SURVEY_SEEDS: readonly number[] = [314_159, 777, -42];

/**
 * 不是地形方块的方块：空气、水、冰、树（见 CONTEXT.md「地表高度」：水、冰、树与地表植物不算）。
 * #80 加地表植物时要把矮草、蕨、两种花加进来；沙子、沙砾、雪草方块是地形方块，不用加。
 */
export const NON_TERRAIN: ReadonlySet<BlockType> = new Set([
  BlockType.Air,
  BlockType.Water,
  BlockType.Ice,
  BlockType.OakLog,
  BlockType.OakLeaves,
  BlockType.BirchLog,
  BlockType.BirchLeaves,
  BlockType.SpruceLog,
  BlockType.SpruceLeaves,
]);

/** 是不是地形方块。 */
export function isTerrainBlock(block: BlockType): boolean {
  return !NON_TERRAIN.has(block);
}

/** 采样线沿哪个轴走。 */
export type Axis = 'x' | 'z';

/** 采样线上第 i 个点的列坐标。 */
function pointOn(axis: Axis, fixed: number, along: number): ColumnCoord {
  return axis === 'x' ? { x: along, z: fixed } : { x: fixed, z: along };
}

/** 一条采样线：沿 axis 从 from 到 to（含），步长 step；另一轴固定在 fixed。 */
export interface SurveyLine {
  readonly axis: Axis;
  readonly fixed: number;
  readonly from: number;
  readonly to: number;
  readonly step: number;
}

/** 采样线上一段连续同一群系的点。 */
export interface BiomeRun {
  readonly biome: Biome;
  /** 长度（格）：点数乘步长。 */
  readonly length: number;
}

/**
 * 采样线上连续同一群系的各段，去掉碰到线两端的那两段（它们被截断了，长度不准）。
 */
export function completeRuns(terrain: Terrain, line: SurveyLine): BiomeRun[] {
  const runs: BiomeRun[] = [];
  let current: Biome | undefined;
  let count = 0;
  for (let along = line.from; along <= line.to; along += line.step) {
    const { x, z } = pointOn(line.axis, line.fixed, along);
    const biome = terrain.biomeAt(x, z);
    if (biome === current) {
      count++;
      continue;
    }
    if (current !== undefined) runs.push({ biome: current, length: count * line.step });
    current = biome;
    count = 1;
  }
  if (current !== undefined) runs.push({ biome: current, length: count * line.step });
  return runs.slice(1, -1);
}

/** 两列相邻（沿 axis 差 1）、群系不同的一对。`a` 在前，`b = a + 1`。 */
export interface BiomeBoundary {
  readonly axis: Axis;
  readonly a: ColumnCoord;
  readonly b: ColumnCoord;
  readonly biomes: readonly [Biome, Biome];
}

/** 交界两侧群系的无序组合，写成可比较的字符串，如「ocean|plains」。 */
export function boundaryKind(boundary: BiomeBoundary): string {
  return [...boundary.biomes].sort().join('|');
}

/**
 * 采样线上的群系交界，最多 limit 个。按步长粗扫，群系变了再在那一段里逐格找第一对不同的相邻列。
 */
export function boundariesOn(terrain: Terrain, line: SurveyLine, limit = Infinity): BiomeBoundary[] {
  const found: BiomeBoundary[] = [];
  const biomeAt = (along: number): Biome => {
    const { x, z } = pointOn(line.axis, line.fixed, along);
    return terrain.biomeAt(x, z);
  };
  let previous = biomeAt(line.from);
  for (let along = line.from + line.step; along <= line.to && found.length < limit; along += line.step) {
    const here = biomeAt(along);
    if (here === previous) continue;
    for (let k = along - line.step; k < along; k++) {
      const left = biomeAt(k);
      const right = biomeAt(k + 1);
      if (left === right) continue;
      found.push({
        axis: line.axis,
        a: pointOn(line.axis, line.fixed, k),
        b: pointOn(line.axis, line.fixed, k + 1),
        biomes: [left, right],
      });
      break;
    }
    previous = here;
  }
  return found;
}

/** 每个种子共用的采样线：东西向与南北向各 4 条，跨 ±8192 格。 */
export function surveyLines(step: number): SurveyLine[] {
  const lines: SurveyLine[] = [];
  for (const fixed of [-3072, -1024, 1024, 3072]) {
    lines.push({ axis: 'x', fixed, from: -8192, to: 8192, step });
    lines.push({ axis: 'z', fixed, from: -8192, to: 8192, step });
  }
  return lines;
}

/** 方形网格上的列：x、z 都从 -half 到 half（含），步长 step。 */
export function* gridColumns(half: number, step: number): Generator<ColumnCoord> {
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) yield { x, z };
  }
}

/** 这一列与它东南西北各 reach 格外的列群系都相同：这一列在那片群系里头，不在边上。 */
export function isInterior(terrain: Terrain, { x, z }: ColumnCoord, reach: number): boolean {
  const biome = terrain.biomeAt(x, z);
  return (
    terrain.biomeAt(x + reach, z) === biome &&
    terrain.biomeAt(x - reach, z) === biome &&
    terrain.biomeAt(x, z + reach) === biome &&
    terrain.biomeAt(x, z - reach) === biome
  );
}

/** 列所在的区块。 */
export function chunkOfColumn({ x, z }: ColumnCoord): ChunkCoord {
  return { cx: chunkOf(x), cz: chunkOf(z) };
}

/** 区块里第 (lx, lz) 列的世界坐标。 */
export function columnIn({ cx, cz }: ChunkCoord, lx: number, lz: number): ColumnCoord {
  return { x: cx * CHUNK_SIZE + lx, z: cz * CHUNK_SIZE + lz };
}

/** 区块里一列（世界坐标）的方块。列必须落在这个区块里。 */
export function blockAt(chunk: Chunk, { x, z }: ColumnCoord, y: number): BlockType {
  return chunk.get(localOf(x), y, localOf(z));
}

/** 区块里一列最高的地形方块的 y；整列都不是地形方块时是 WORLD_MIN_Y − 1。 */
export function highestTerrainY(chunk: Chunk, lx: number, lz: number): number {
  for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
    if (isTerrainBlock(chunk.get(lx, y, lz))) return y;
  }
  return WORLD_MIN_Y - 1;
}

/**
 * 悬垂列：从最高的地形方块往下，先遇到空气（不是水），再往下又遇到地形方块。
 * 即「上方实心、中间空气、下方又是实心」。
 */
export function hasOverhang(chunk: Chunk, lx: number, lz: number): boolean {
  let y = highestTerrainY(chunk, lx, lz);
  while (y > WORLD_MIN_Y && isTerrainBlock(chunk.get(lx, y, lz))) y--;
  if (chunk.get(lx, y, lz) !== BlockType.Air) return false;
  for (; y > WORLD_MIN_Y; y--) {
    if (isTerrainBlock(chunk.get(lx, y, lz))) return true;
  }
  return false;
}

/** 按 (种子, cx, cz) 缓存生成好的区块：同一个文件里几条断言看同一个区块时不重复生成。 */
export function chunkCache(terrainOf: (seed: number) => Terrain): (seed: number, coord: ChunkCoord) => Chunk {
  const cache = new Map<string, Chunk>();
  return (seed, { cx, cz }) => {
    const key = `${seed}:${cx},${cz}`;
    let chunk = cache.get(key);
    if (!chunk) {
      chunk = terrainOf(seed).generateChunk(cx, cz);
      cache.set(key, chunk);
    }
    return chunk;
  };
}

/** 中位数（按长度加权）：至少一半的总长度落在不短于它的段里。 */
export function weightedMedianLength(runs: readonly BiomeRun[]): number {
  const sorted = [...runs].sort((a, b) => a.length - b.length);
  const total = sorted.reduce((sum, run) => sum + run.length, 0);
  let acc = 0;
  for (const run of sorted) {
    acc += run.length;
    if (acc * 2 >= total) return run.length;
  }
  return 0;
}
