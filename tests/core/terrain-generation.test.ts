import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { ORE_KINDS, oreVeinsTouching } from '../../src/core/ore';
import { Biome, createTerrain, type ColumnCoord } from '../../src/core/terrain';
import { OAK_CANOPY_RADIUS, oakTreesTouching, oakTrunkTopY, type OakTree } from '../../src/core/tree';
import { chunkOf, chunksAround, localOf, type ChunkCoord } from '../../src/core/world';
import {
  boundariesOn,
  boundaryKind,
  chunkCache,
  chunkOfColumn,
  columnIn,
  gridColumns,
  hasOverhang,
  highestTerrainY,
  isInterior,
  isTerrainBlock,
  SURVEY_SEEDS,
  surveyLines,
  type BiomeBoundary,
} from '../helpers/terrain-survey';

/**
 * 三维密度地形生成出的区块（#75）：按群系各找几个区块，断言方块与三个查询一致。
 *
 * 区块怎么找：只调 `biomeAt` 与 `surfaceHeightAt`。每个种子在 ±2560 格、步长 64 的网格上找各群系内部的列
 * （东南西北 32 格外也是同一群系），沿采样线找冰雪与大海、平原与大海的交界，再在陆地一侧找低于海平面的列。
 * 每个种子约生成 30 个区块，按 (种子, cx, cz) 缓存，只有确定性那几条另建地形对象重算。
 *
 * 判定方式（QA 定，见 .scratch/seams-75.md）：海平面那一层是 y = SEA_LEVEL（63），y ≤ 63 的空气灌水，
 * 冰在 y = 63；冰雪群系的列寒冷，平原的列不寒冷。
 */

const FIND_HALF = 2560;
const FIND_STEP = 64;
const INTERIOR_REACH = 32;

/** 每个种子取几个高山区块找悬垂。 */
const MOUNTAIN_CHUNKS = 6;

/** 挑大海区块时比较几列大海内部的列的海底。 */
const OCEAN_CANDIDATES = 40;

/** 冰雪临海、内陆低于海平面，每个种子各取几处。 */
const COAST_SITES = 3;

/** 从交界往陆地一侧找低于海平面的列，最多走几格。 */
const INLAND_WALK = 48;

/** issue 给的地表高度上界。 */
const MAX_SURFACE_Y = 210;

/** 草方块之下的泥土层数（本 issue 的铺法沿用平原的 3 到 4 层）。 */
const DIRT_LAYERS_MIN = 3;
const DIRT_LAYERS_MAX = 4;

const ORE_BLOCKS: ReadonlySet<BlockType> = new Set(ORE_KINDS.map((kind) => kind.block));
const LOGS: ReadonlySet<BlockType> = new Set([BlockType.OakLog, BlockType.BirchLog, BlockType.SpruceLog]);

const chunkAt = chunkCache(createTerrain);

/** 一个种子下要检查的区块。 */
interface Sites {
  readonly ocean?: ChunkCoord;
  readonly plains?: ChunkCoord;
  readonly snowy?: ChunkCoord;
  readonly mountains: ChunkCoord[];
  /** 冰雪与大海交界、大海一侧的区块。 */
  readonly snowyCoast: ChunkCoord[];
  /** 不是大海、地表低于海平面的列。 */
  readonly inlandBelowSea: ColumnCoord[];
}

/** 一串区块坐标去重。 */
function distinct(coords: readonly ChunkCoord[]): ChunkCoord[] {
  const seen = new Map<string, ChunkCoord>();
  for (const coord of coords) seen.set(`${coord.cx},${coord.cz}`, coord);
  return [...seen.values()];
}

/** 从一串里均匀挑 n 个。 */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(items[Math.floor((i * items.length) / n)]!);
  return picked;
}

/** 交界那一对里属于某个群系的那一列，与另一列朝那一侧再走 d 格的列。 */
function sideOf(boundary: BiomeBoundary, biome: Biome, d: number): ColumnCoord {
  const towardB = boundary.biomes[1] === biome;
  const base = towardB ? boundary.b : boundary.a;
  const offset = towardB ? d : -d;
  return boundary.axis === 'x' ? { x: base.x + offset, z: base.z } : { x: base.x, z: base.z + offset };
}

const sitesBySeed = new Map<number, Sites>();
function sitesOf(seed: number): Sites {
  const cached = sitesBySeed.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);

  const interior = new Map<Biome, ColumnCoord[]>();
  for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
    if (!isInterior(terrain, column, INTERIOR_REACH)) continue;
    const biome = terrain.biomeAt(column.x, column.z);
    interior.set(biome, [...(interior.get(biome) ?? []), column]);
  }
  const firstChunk = (biome: Biome): ChunkCoord | undefined => {
    const column = interior.get(biome)?.[0];
    return column && chunkOfColumn(column);
  };
  // 大海取海底最深的那一列：靠岸的大海列海底往上抬，挑深的才测得到「海平面以下是水」
  const deepestOcean = spread(interior.get(Biome.Ocean) ?? [], OCEAN_CANDIDATES).sort(
    (a, b) => terrain.surfaceHeightAt(a.x, a.z) - terrain.surfaceHeightAt(b.x, b.z),
  )[0];

  const boundaries = surveyLines(8).flatMap((line) => boundariesOn(terrain, line));
  const snowyCoast = distinct(
    boundaries
      .filter((b) => boundaryKind(b) === [Biome.Ocean, Biome.Snowy].sort().join('|'))
      .map((b) => chunkOfColumn(sideOf(b, Biome.Ocean, 8))),
  ).slice(0, COAST_SITES);

  const inlandBelowSea: ColumnCoord[] = [];
  for (const boundary of boundaries) {
    if (inlandBelowSea.length >= COAST_SITES) break;
    const land = boundary.biomes.find((biome) => biome !== Biome.Ocean);
    if (!boundary.biomes.includes(Biome.Ocean) || land === undefined) continue;
    for (let d = 0; d <= INLAND_WALK; d++) {
      const column = sideOf(boundary, land, d);
      if (terrain.biomeAt(column.x, column.z) === Biome.Ocean) continue;
      if (terrain.surfaceHeightAt(column.x, column.z) < SEA_LEVEL) {
        inlandBelowSea.push(column);
        break;
      }
    }
  }

  const sites: Sites = {
    ocean: deepestOcean && chunkOfColumn(deepestOcean),
    plains: firstChunk(Biome.Plains),
    snowy: firstChunk(Biome.Snowy),
    mountains: distinct(spread(interior.get(Biome.Mountains) ?? [], MOUNTAIN_CHUNKS).map(chunkOfColumn)),
    snowyCoast,
    inlandBelowSea,
  };
  sitesBySeed.set(seed, sites);
  return sites;
}

/** 一个种子下要检查的全部区块：各群系、临海、内陆低于海平面，加平原那一块周围 3×3。 */
function allChunks(seed: number): ChunkCoord[] {
  const s = sitesOf(seed);
  return distinct([
    ...(s.ocean ? [s.ocean] : []),
    ...(s.snowy ? [s.snowy] : []),
    ...(s.plains ? chunksAround(s.plains, 1) : []),
    ...s.mountains,
    ...s.snowyCoast,
    ...s.inlandBelowSea.map(chunkOfColumn),
  ]);
}

/** 要检查的区块都找到了：没有某个群系时，后面的断言读不到东西，先在这里报清楚。 */
function expectAllBiomesFound(seed: number): void {
  const s = sitesOf(seed);
  expect(s.ocean, `种子 ${seed} 找不到大海内部的列`).toBeDefined();
  expect(s.plains, `种子 ${seed} 找不到平原内部的列`).toBeDefined();
  expect(s.snowy, `种子 ${seed} 找不到冰雪内部的列`).toBeDefined();
  expect(s.mountains.length, `种子 ${seed} 的高山区块数`).toBeGreaterThan(0);
}

/** 逐区块、逐列走一遍。 */
function eachColumn(seed: number, visit: (chunk: Chunk, lx: number, lz: number, column: ColumnCoord) => void): void {
  for (const coord of allChunks(seed)) {
    const chunk = chunkAt(seed, coord);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) visit(chunk, lx, lz, columnIn(coord, lx, lz));
    }
  }
}

function sameBlocks(a: Chunk, b: Chunk): boolean {
  return Buffer.from(a.blocks).equals(Buffer.from(b.blocks));
}

describe('确定性：各群系的区块', () => {
  it.each(SURVEY_SEEDS)('种子 %i：两个独立构造的地形对象生成同一区块逐字节相同', (seed) => {
    expectAllBiomesFound(seed);
    const s = sitesOf(seed);
    for (const coord of [s.ocean!, s.plains!, s.snowy!, s.mountains[0]!]) {
      const a = createTerrain(seed).generateChunk(coord.cx, coord.cz);
      const b = createTerrain(seed).generateChunk(coord.cx, coord.cz);
      expect(sameBlocks(a, b), `区块 (${coord.cx}, ${coord.cz})`).toBe(true);
    }
  });

  it.each(SURVEY_SEEDS)('种子 %i：同一个地形对象先 A 后 B 与先 B 后 A 结果相同', (seed) => {
    expectAllBiomesFound(seed);
    const { ocean, mountains } = sitesOf(seed);
    const a = ocean!;
    const b = mountains[0]!;
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

describe('地表高度查询与生成结果一致', () => {
  it.each(SURVEY_SEEDS)('种子 %i：每个区块 256 列（含区块边缘），地表高度查询等于那一列最高的地形方块', (seed) => {
    expectAllBiomesFound(seed);
    const terrain = createTerrain(seed);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      const expected = terrain.surfaceHeightAt(x, z);
      const actual = highestTerrainY(chunk, lx, lz);
      if (actual !== expected) wrong.push(`(${x}, ${z})：查询 ${expected}，生成 ${actual}`);
    });
    expect(wrong).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：列顶地表方块查询等于地表高度那一格，本 issue 仍总是草方块（#76 改）', (seed) => {
    expectAllBiomesFound(seed);
    const terrain = createTerrain(seed);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      const queried = terrain.surfaceBlockAt(x, z);
      const generated = chunk.get(lx, terrain.surfaceHeightAt(x, z), lz);
      if (queried !== BlockType.Grass || generated !== queried) wrong.push(`(${x}, ${z})：查询 ${queried}，生成 ${generated}`);
    });
    expect(wrong).toEqual([]);
  });
});

describe('区块里的高度范围', () => {
  it.each(SURVEY_SEEDS)(`种子 %i：y ${MAX_SURFACE_Y} 以上没有地形方块，最底层整层是基岩，别处没有基岩`, (seed) => {
    expectAllBiomesFound(seed);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      if (chunk.get(lx, WORLD_MIN_Y, lz) !== BlockType.Bedrock) wrong.push(`(${x}, ${z}) 最底层不是基岩`);
      for (let y = WORLD_MIN_Y + 1; y <= WORLD_MAX_Y; y++) {
        const block = chunk.get(lx, y, lz);
        if (block === BlockType.Bedrock) wrong.push(`(${x}, ${y}, ${z}) 是基岩`);
        if (y > MAX_SURFACE_Y && isTerrainBlock(block)) wrong.push(`(${x}, ${y}, ${z}) 高于 ${MAX_SURFACE_Y}`);
      }
    });
    expect(wrong).toEqual([]);
  });
});

describe('水与冰', () => {
  it.each(SURVEY_SEEDS)('种子 %i：查到大海的列，地表之上到海平面是水（海平面那层可以是冰），再往上没有水与冰', (seed) => {
    expectAllBiomesFound(seed);
    const terrain = createTerrain(seed);
    const { ocean } = sitesOf(seed);
    const chunk = chunkAt(seed, ocean!);
    const wrong: string[] = [];
    let deep = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const { x, z } = columnIn(ocean!, lx, lz);
        if (terrain.biomeAt(x, z) !== Biome.Ocean) continue;
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface < SEA_LEVEL - 5) deep++;
        for (let y = surface + 1; y <= SEA_LEVEL; y++) {
          const block = chunk.get(lx, y, lz);
          const ok = block === BlockType.Water || (y === SEA_LEVEL && block === BlockType.Ice);
          if (!ok) wrong.push(`(${x}, ${y}, ${z}) 是 ${block}`);
        }
        for (let y = Math.max(surface, SEA_LEVEL) + 1; y <= WORLD_MAX_Y; y++) {
          const block = chunk.get(lx, y, lz);
          if (block === BlockType.Water || block === BlockType.Ice) wrong.push(`(${x}, ${y}, ${z}) 海平面之上是 ${block}`);
        }
      }
    }
    // 是真的海：区块里有海底低于海平面 5 格以上的列
    expect(deep).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：海平面以下没有空气，低于海平面的空气格都灌了水', (seed) => {
    expectAllBiomesFound(seed);
    const wrong: string[] = [];
    let water = 0;
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      for (let y = WORLD_MIN_Y; y <= SEA_LEVEL; y++) {
        const block = chunk.get(lx, y, lz);
        if (block === BlockType.Water) water++;
        if (block === BlockType.Air) wrong.push(`(${x}, ${y}, ${z})`);
      }
    });
    expect(water).toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('不是大海、地表低于海平面的列（内陆洼地与岸边），地表之上到海平面是水，海平面那层可以是冰', () => {
    const wrong: string[] = [];
    let found = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const column of sitesOf(seed).inlandBelowSea) {
        found++;
        const chunk = chunkAt(seed, chunkOfColumn(column));
        const surface = terrain.surfaceHeightAt(column.x, column.z);
        for (let y = surface + 1; y <= SEA_LEVEL; y++) {
          const block = chunk.get(localOf(column.x), y, localOf(column.z));
          const ok = block === BlockType.Water || (y === SEA_LEVEL && block === BlockType.Ice);
          if (!ok) wrong.push(`种子 ${seed} (${column.x}, ${y}, ${column.z}) 是 ${block}`);
        }
      }
    }
    expect(found, '三个种子里找到的内陆低于海平面的列').toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：冰只在海平面那一层，冰下是水或地形方块', (seed) => {
    expectAllBiomesFound(seed);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
        if (chunk.get(lx, y, lz) !== BlockType.Ice) continue;
        if (y !== SEA_LEVEL) wrong.push(`(${x}, ${y}, ${z}) 冰不在海平面`);
        const below = chunk.get(lx, y - 1, lz);
        if (below !== BlockType.Water && !isTerrainBlock(below)) wrong.push(`(${x}, ${y}, ${z}) 冰下是 ${below}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：冰雪群系里低于海平面的列，海平面那层是冰；平原的列里没有冰', (seed) => {
    expectAllBiomesFound(seed);
    const terrain = createTerrain(seed);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      const biome = terrain.biomeAt(x, z);
      if (biome === Biome.Snowy && terrain.surfaceHeightAt(x, z) < SEA_LEVEL) {
        if (chunk.get(lx, SEA_LEVEL, lz) !== BlockType.Ice) wrong.push(`冰雪 (${x}, ${z}) 海平面那层不是冰`);
      }
      if (biome === Biome.Plains) {
        for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
          if (chunk.get(lx, y, lz) === BlockType.Ice) wrong.push(`平原 (${x}, ${y}, ${z}) 是冰`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });

  it('冰雪与大海交界处，大海一侧的海面整片结冰：至少有一个区块里每一列低于海平面的水，海平面那层都是冰', () => {
    const report: string[] = [];
    let frozenChunks = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const coord of sitesOf(seed).snowyCoast) {
        const chunk = chunkAt(seed, coord);
        let open = 0;
        let iced = 0;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const { x, z } = columnIn(coord, lx, lz);
            if (terrain.surfaceHeightAt(x, z) >= SEA_LEVEL) continue;
            open++;
            if (chunk.get(lx, SEA_LEVEL, lz) === BlockType.Ice) iced++;
          }
        }
        report.push(`种子 ${seed} 区块 (${coord.cx}, ${coord.cz})：${iced}/${open}`);
        if (open >= 20 && iced === open) frozenChunks++;
      }
    }
    expect(frozenChunks, report.join('；')).toBeGreaterThan(0);
  });
});

describe('寒冷处结冰与冰雪群系用同一个温度阈值', () => {
  /** 从交界往大海一侧最多走几格找水面。 */
  const OFFSHORE_WALK = 8;
  /** 交界两侧的温度几乎相同，只有交界恰好挨着冷暖分界时才会不一致，所以留 5% 的余地。 */
  const TOLERANCE = 0.05;

  /** 某种陆地群系与大海交界处，大海一侧离岸最近的水面列（地表低于海平面）。 */
  function offshoreColumns(seed: number, land: Biome): ColumnCoord[] {
    const terrain = createTerrain(seed);
    const kind = [Biome.Ocean, land].sort().join('|');
    const columns: ColumnCoord[] = [];
    for (const boundary of surveyLines(8).flatMap((line) => boundariesOn(terrain, line))) {
      if (boundaryKind(boundary) !== kind) continue;
      for (let d = 0; d <= OFFSHORE_WALK; d++) {
        const column = sideOf(boundary, Biome.Ocean, d);
        if (terrain.biomeAt(column.x, column.z) !== Biome.Ocean) continue;
        if (terrain.surfaceHeightAt(column.x, column.z) >= SEA_LEVEL) continue;
        columns.push(column);
        break;
      }
    }
    return columns;
  }

  /** 这些列里海平面那层是冰的有几列。 */
  function icedCount(seed: number, columns: readonly ColumnCoord[]): number {
    return columns.filter(
      (column) => chunkAt(seed, chunkOfColumn(column)).get(localOf(column.x), SEA_LEVEL, localOf(column.z)) === BlockType.Ice,
    ).length;
  }

  it('平原岸边的海面不结冰，冰雪岸边的海面结冰（三个种子合计）', () => {
    const warm = { columns: 0, iced: 0 };
    const cold = { columns: 0, iced: 0 };
    for (const seed of SURVEY_SEEDS) {
      const plainsCoast = offshoreColumns(seed, Biome.Plains);
      const snowyCoast = offshoreColumns(seed, Biome.Snowy);
      warm.columns += plainsCoast.length;
      warm.iced += icedCount(seed, plainsCoast);
      cold.columns += snowyCoast.length;
      cold.iced += icedCount(seed, snowyCoast);
    }
    expect(warm.columns, '平原岸边的水面列').toBeGreaterThanOrEqual(30);
    expect(cold.columns, '冰雪岸边的水面列').toBeGreaterThanOrEqual(30);
    expect(warm.iced / warm.columns, `平原岸边 ${warm.iced}/${warm.columns} 列结冰`).toBeLessThanOrEqual(TOLERANCE);
    expect(cold.iced / cold.columns, `冰雪岸边 ${cold.iced}/${cold.columns} 列结冰`).toBeGreaterThanOrEqual(1 - TOLERANCE);
  });
});

describe('悬垂', () => {
  it('高山区块里存在「上方实心、中间空气、下方又是实心」的列', () => {
    let overhangs = 0;
    let columns = 0;
    for (const seed of SURVEY_SEEDS) {
      for (const coord of sitesOf(seed).mountains) {
        const chunk = chunkAt(seed, coord);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            columns++;
            if (hasOverhang(chunk, lx, lz)) overhangs++;
          }
        }
      }
    }
    expect(columns, '查过的高山列数').toBeGreaterThan(0);
    expect(overhangs).toBeGreaterThan(0);
  });
});

describe('地表铺法（本 issue 最简单的一种，#76 改）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：上方是空气、水或冰的地形方块都是草方块，其下 3 到 4 层泥土（那一段不够厚时到段底为止）', (seed) => {
    expectAllBiomesFound(seed);
    const exposedAbove: ReadonlySet<BlockType> = new Set([BlockType.Air, BlockType.Water, BlockType.Ice]);
    const wrong: string[] = [];
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      for (let y = WORLD_MIN_Y + 1; y < WORLD_MAX_Y; y++) {
        const block = chunk.get(lx, y, lz);
        if (!isTerrainBlock(block) || !exposedAbove.has(chunk.get(lx, y + 1, lz))) continue;
        if (block !== BlockType.Grass) {
          wrong.push(`(${x}, ${y}, ${z}) 露天的顶面是 ${block}`);
          continue;
        }
        let dirt = 0;
        while (chunk.get(lx, y - dirt - 1, lz) === BlockType.Dirt) dirt++;
        const next = chunk.get(lx, y - dirt - 1, lz);
        const segmentEnded = !isTerrainBlock(next);
        if (dirt > DIRT_LAYERS_MAX || (dirt < DIRT_LAYERS_MIN && !segmentEnded)) {
          wrong.push(`(${x}, ${y}, ${z}) 草方块下 ${dirt} 层泥土，再下面是 ${next}`);
        }
      }
    });
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('树', () => {
  it('大海群系的列即使地表高于海平面也没有原木', () => {
    // 岸边的大海列基准高度贴着海平面，叠上起伏会露出水面；按父 spec，大海里不长树
    const MIN_EXPOSED = 24;
    const wrong: string[] = [];
    let exposed = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      const coasts = surveyLines(8)
        .flatMap((line) => boundariesOn(terrain, line))
        .filter((boundary) => boundary.biomes.includes(Biome.Ocean));
      const chunks = distinct(coasts.map((boundary) => chunkOfColumn(sideOf(boundary, Biome.Ocean, 0))));
      for (const coord of chunks) {
        const chunk = chunkAt(seed, coord);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const { x, z } = columnIn(coord, lx, lz);
            if (terrain.biomeAt(x, z) !== Biome.Ocean || terrain.surfaceHeightAt(x, z) <= SEA_LEVEL) continue;
            exposed++;
            for (let y = SEA_LEVEL + 1; y <= WORLD_MAX_Y; y++) {
              if (LOGS.has(chunk.get(lx, y, lz))) wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 大海里有原木`);
            }
          }
        }
      }
    }
    expect(exposed, '露出海面的大海列').toBeGreaterThanOrEqual(MIN_EXPOSED);
    expect(wrong).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：海平面以下没有原木，原木所在列的地表高于海平面', (seed) => {
    expectAllBiomesFound(seed);
    const terrain = createTerrain(seed);
    const wrong: string[] = [];
    let lowColumns = 0;
    eachColumn(seed, (chunk, lx, lz, { x, z }) => {
      const surface = terrain.surfaceHeightAt(x, z);
      if (surface <= SEA_LEVEL) lowColumns++;
      for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
        if (!LOGS.has(chunk.get(lx, y, lz))) continue;
        if (y <= SEA_LEVEL) wrong.push(`(${x}, ${y}, ${z}) 原木在海平面以下`);
        if (surface <= SEA_LEVEL) wrong.push(`(${x}, ${y}, ${z}) 原木所在列地表 ${surface}`);
      }
    });
    // 查过的区块里确实有低于海平面的列，否则这条测不到东西
    expect(lowColumns).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it('平原里跨区块边界的橡树，几个区块里的部分合起来是完整的树', () => {
    /** 世界坐标的一格，从缓存的区块里读。 */
    const blockIn = (seed: number, x: number, y: number, z: number): BlockType =>
      chunkAt(seed, { cx: chunkOf(x), cz: chunkOf(z) }).get(localOf(x), y, localOf(z));
    /** 树冠的一格：长出了树叶，或被地形方块占着（树叶只往空气里长）。 */
    const canopyOk = (block: BlockType): boolean => block === BlockType.OakLeaves || isTerrainBlock(block);

    const wrong: string[] = [];
    let crossing = 0;
    for (const seed of SURVEY_SEEDS) {
      const center = sitesOf(seed).plains;
      expect(center, `种子 ${seed} 找不到平原内部的列`).toBeDefined();
      const terrain = createTerrain(seed);
      // 3×3 区块里树冠整个落在这片之内的树：树根离外沿至少一个树冠半径
      const minX = (center!.cx - 1) * CHUNK_SIZE + OAK_CANOPY_RADIUS;
      const maxX = (center!.cx + 2) * CHUNK_SIZE - 1 - OAK_CANOPY_RADIUS;
      const minZ = (center!.cz - 1) * CHUNK_SIZE + OAK_CANOPY_RADIUS;
      const maxZ = (center!.cz + 2) * CHUNK_SIZE - 1 - OAK_CANOPY_RADIUS;
      const byRoot = new Map<string, OakTree>();
      for (const { cx, cz } of chunksAround(center!, 1)) {
        for (const tree of oakTreesTouching(terrain, cx, cz)) byRoot.set(`${tree.x},${tree.z}`, tree);
      }
      const trees = [...byRoot.values()].filter(
        (tree) =>
          tree.x >= minX &&
          tree.x <= maxX &&
          tree.z >= minZ &&
          tree.z <= maxZ &&
          terrain.surfaceHeightAt(tree.x, tree.z) > SEA_LEVEL,
      );
      for (const tree of trees) {
        const lx = localOf(tree.x);
        const lz = localOf(tree.z);
        const crosses =
          lx < OAK_CANOPY_RADIUS || lx >= CHUNK_SIZE - OAK_CANOPY_RADIUS || lz < OAK_CANOPY_RADIUS || lz >= CHUNK_SIZE - OAK_CANOPY_RADIUS;
        if (!crosses) continue;
        crossing++;
        const where = `种子 ${seed} 树 (${tree.x}, ${tree.z})`;
        const top = oakTrunkTopY(tree);
        for (let y = tree.rootY; y <= top; y++) {
          if (blockIn(seed, tree.x, y, tree.z) !== BlockType.OakLog) wrong.push(`${where} 树干 y ${y}`);
        }
        // 原版式树冠：最宽两层 5×5 去掉四角，树干顶那层 3×3，顶上一层十字
        const layers: Array<[y: number, radius: number, corners: boolean]> = [
          [top - 2, 2, false],
          [top - 1, 2, false],
          [top, 1, true],
          [top + 1, 1, false],
        ];
        for (const [y, r, corners] of layers) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (!corners && Math.abs(dx) === r && Math.abs(dz) === r) continue;
              if (y <= top && dx === 0 && dz === 0) continue;
              const block = blockIn(seed, tree.x + dx, y, tree.z + dz);
              if (!canopyOk(block)) wrong.push(`${where} 树冠 (${dx}, ${y}, ${dz}) 是 ${block}`);
            }
          }
        }
      }
    }
    expect(crossing, '跨边界的树').toBeGreaterThanOrEqual(3);
    expect(wrong).toEqual([]);
  });
});

describe('矿石只替换石头', () => {
  it.each(SURVEY_SEEDS)('种子 %i：每一格矿石都属于算出来的矿脉，矿脉落在区块里的格不会还是石头', (seed) => {
    expectAllBiomesFound(seed);
    const wrong: string[] = [];
    let ores = 0;
    for (const coord of allChunks(seed)) {
      const chunk = chunkAt(seed, coord);
      const veinCells = new Set<string>();
      for (const vein of oreVeinsTouching(seed, coord.cx, coord.cz)) {
        for (const { x, y, z } of vein.cells) {
          if (chunkOf(x) !== coord.cx || chunkOf(z) !== coord.cz) continue;
          veinCells.add(`${x},${y},${z}`);
          if (chunk.get(localOf(x), y, localOf(z)) === BlockType.Stone) wrong.push(`(${x}, ${y}, ${z}) 在矿脉里却是石头`);
        }
      }
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const { x, z } = columnIn(coord, lx, lz);
          for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
            if (!ORE_BLOCKS.has(chunk.get(lx, y, lz))) continue;
            ores++;
            if (!veinCells.has(`${x},${y},${z}`)) wrong.push(`(${x}, ${y}, ${z}) 矿石不在任何矿脉里`);
          }
        }
      }
    }
    expect(ores).toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});
