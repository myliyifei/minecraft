import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, SEA_LEVEL, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { oreVeinsTouching } from '../../src/core/ore';
import { isColdAt, MOUNTAIN_RELIEF, reliefAt } from '../../src/core/terrain-density';
import type { ChunkCoord } from '../../src/core/world';
import {
  boundariesOn,
  chunkCache,
  chunkOfColumn,
  columnIn,
  gridColumns,
  isInterior,
  isPondColumn,
  isTerrainBlock,
  SURVEY_SEEDS,
  surveyLines,
  type BiomeBoundary,
} from '../helpers/terrain-survey';
import {
  BEACH_MAX_ABOVE_SEA,
  BEACH_SAND_LAYERS_MAX,
  BEACH_SAND_LAYERS_MIN,
  blockName,
  DIRT_LAYERS_MAX,
  DIRT_LAYERS_MIN,
  expectSurfaceBlocksDefined,
  GRAVEL,
  isSteep,
  SAND,
  SHALLOW_MIN_Y,
  SNOW_LINE_Y,
  SNOWY_GRASS,
  underwaterFloorAt,
} from '../helpers/surface-rules';

/**
 * 地表铺法（#76）：上方是空气或水的每一段实心方块按群系与坡度铺地表，列顶地表方块查询用同一套规则。
 *
 * 阈值（测试设定，常量在 tests/helpers/surface-rules.ts）：
 * - 陡坡：与东南西北四个相邻列的地表高度差最大的那个 ≥ 3，顶层石头，紧挨着的下一格不是泥土。只看最高的那一段。
 * - 雪线：高山顶面 y ≥ 150 铺雪草方块，以下铺草方块；冰雪任何高度都是雪草方块。悬垂下方的段按那一段顶面的 y 判断。
 * - 被水覆盖（上方是水或冰）：顶面 y ≥ 56 铺沙子，y ≤ 55 铺沙砾，不论群系。
 * - 沙滩（#76 修订）：只在平原与大海之间，从陆地一侧约 4 格一直铺到水边，地表在 y 63 到 67。陆地一侧是平原 4 格内
 *   有大海的列；大海一侧是大海群系里露出水面、地表不高于 y 67 的列，按这一列自身的起伏与温度判断：起伏高于高山阈值
 *   （与群系判断同一个 MOUNTAIN_RELIEF）是石头，否则寒冷处（与结冰同一个温度阈值）是雪草方块，其余是沙子。
 *   顶层与其下至少 2 层沙子；交界两侧 6 格内有，宽度随岸坡变化，中位数在 4 到 20、九成不超过 30；九成以上的
 *   交界从陆地一侧到水边之间没有草方块；离大海 12 格以外没有露天的沙子。高山群系的列不铺沙子，高山临海是石头岸。
 * - 冰雪临海（#76 第二次修订，用户决定）：冰雪群系的列不铺沙子，临海也按冰雪的常规铺法（雪草方块，其下 3 到 4 层
 *   泥土）；寒冷处从冰雪陆地一侧到水边都是雪草方块（陡坡与起伏高的列是石头）。
 * - 优先次序：被水覆盖 → 陡坡 → 海岸（平原一侧沙滩或高山石头岸；大海一侧起伏高于高山阈值的列是石头，否则寒冷处
 *   雪草方块、其余沙子）→ 雪线以上与冰雪 → 草方块。
 *
 * 采样：每个种子在 ±2560 格、步长 64 的网格上找各群系内部的列（东南西北 32 格外同群系），取平原、冰雪、最深的大海
 * 各 1 个区块，高山 6 个区块加地表 ≥ 165 的高山 3 个区块；沿 `surveyLines(8)` 找平原、冰雪、高山与大海的交界各取
 * 2 个区块。每个种子约 20 个区块，按 (种子, cx, cz) 缓存。沙滩的统计只调查询，不生成区块。
 */

const FIND_HALF = 2560;
const FIND_STEP = 64;
const INTERIOR_REACH = 32;

/** 每个种子取几个高山区块、几个地表很高的高山区块。 */
const MOUNTAIN_CHUNKS = 6;
const HIGH_MOUNTAIN_CHUNKS = 3;
/** 「地表很高」：比雪线高 15 格，那一块里雪线以上的列才多。 */
const HIGH_MOUNTAIN_Y = 165;

/** 每种交界取几个区块。 */
const COAST_CHUNKS = 2;

/** 挑大海区块时比较几列大海内部的列的海底。 */
const OCEAN_CANDIDATES = 40;

/** 区块离大海多远才按「不在海边」断言：区块四周这么多格内的采样点都不是大海。 */
const FAR_FROM_OCEAN = 24;

/** 沙滩：交界两侧几格内要有露天的沙子。 */
const BEACH_SEARCH = 6;
/** 交界处有沙子的比例下限。 */
const BEACH_PRESENT_SHARE = 0.9;
/**
 * 沙滩宽度的中位数范围与九成分位的上限（#76 修订，用户定「约 4 到 20 格」）。三个种子的原型实测：平原临海中位数
 * 12 到 14、九成分位 19 到 27（岸坡缓的地方更宽）。冰雪临海没有沙滩（#76 第二次修订），不量宽度。
 */
const BEACH_WIDTH_MEDIAN_MIN = 4;
const BEACH_WIDTH_MEDIAN_MAX = 20;
const BEACH_WIDTH_P90_MAX = 30;
/** 量宽度时沿一个方向最多数几格。 */
const BEACH_RUN_LIMIT = 40;
/** 露天的沙子离大海最远几格（切比雪夫距离）。 */
const BEACH_MAX_REACH = 12;

/** 从交界往海里最多走几格找水边（第一列地表低于海平面的列）：三个种子的水边九成在大海群系里 26 格以内。 */
const WATER_EDGE_SEARCH = 60;
/** 陆地一侧到水边之间没有草方块的交界、水边那一列是规定方块的交界，各自的比例下限。 */
const SHORE_TO_WATER_SHARE = 0.9;
/** 冰雪临海：从陆地一侧这么多格到水边之间都是雪草方块或石头的交界，比例下限。 */
const SNOWY_SHORE_SHARE = 0.9;
/** 冰雪临海：陆地一侧看多远内冰雪群系的列没有沙子（比陆地一侧的沙滩判定距离 4 格宽）。 */
const SNOWY_COAST_WINDOW = 8;

/** 高山临海：交界两侧几格内看；交界周围这么远内没有平原与冰雪才算「高山直接临海」。 */
const ROCKY_COAST_WINDOW = 8;
const ROCKY_COAST_CLEAR = 16;
/** 高山临海处有石头的比例下限。 */
const ROCKY_COAST_STONE_SHARE = 0.8;

const TERRAIN_SURFACE: ReadonlySet<BlockType> = new Set([
  BlockType.Grass,
  BlockType.Stone,
  // 新方块在编号未定义时是 undefined，集合仍能构造；用到它们的用例先调 expectSurfaceBlocksDefined
  SAND,
  GRAVEL,
  SNOWY_GRASS,
]);

const chunkAt = chunkCache(createTerrain);

const terrains = new Map<number, Terrain>();
function terrainOf(seed: number): Terrain {
  let terrain = terrains.get(seed);
  if (!terrain) {
    terrain = createTerrain(seed);
    terrains.set(seed, terrain);
  }
  return terrain;
}

/** 交界的种类。 */
type CoastKind = typeof Biome.Plains | typeof Biome.Snowy | typeof Biome.Mountains;

/** 一个种子下要检查的区块与交界。 */
interface Sites {
  readonly plains?: ChunkCoord;
  readonly snowy?: ChunkCoord;
  readonly ocean?: ChunkCoord;
  readonly mountains: ChunkCoord[];
  readonly highMountains: ChunkCoord[];
  /** 陆地群系与大海的交界，按陆地群系分。 */
  readonly coasts: ReadonlyMap<CoastKind, BiomeBoundary[]>;
  /** 每种交界取的区块。 */
  readonly coastChunks: ChunkCoord[];
}

function distinct(coords: readonly ChunkCoord[]): ChunkCoord[] {
  const seen = new Map<string, ChunkCoord>();
  for (const coord of coords) seen.set(`${coord.cx},${coord.cz}`, coord);
  return [...seen.values()];
}

function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

/** 交界那一对之后沿轴再走 d 格的列（d 可以为负）：d = 0 是 `b`，d = −1 是 `a`。 */
function alongBoundary(boundary: BiomeBoundary, d: number): ColumnCoord {
  const { b } = boundary;
  return boundary.axis === 'x' ? { x: b.x + d, z: b.z } : { x: b.x, z: b.z + d };
}

/** 交界那一对里陆地一侧朝陆地方向走 d（≥ 0）格的列。 */
function landSide(boundary: BiomeBoundary, d: number): ColumnCoord {
  return boundary.biomes[1] === Biome.Ocean ? alongBoundary(boundary, -1 - d) : alongBoundary(boundary, d);
}

/** 交界那一对里大海一侧朝海里走 d（≥ 0）格的列。 */
function oceanSide(boundary: BiomeBoundary, d: number): ColumnCoord {
  return boundary.biomes[1] === Biome.Ocean ? alongBoundary(boundary, d) : alongBoundary(boundary, -1 - d);
}

/**
 * 交界往海里第一列地表低于海平面的列离交界几格（`oceanSide` 的 d），WATER_EDGE_SEARCH 格内没有时返回 undefined。
 * 水边那一列是 d − 1（d = 0 时水边就在交界上，大海一侧没有露出水面的列）。
 */
function waterEdgeOf(terrain: Terrain, boundary: BiomeBoundary): number | undefined {
  for (let d = 0; d < WATER_EDGE_SEARCH; d++) {
    const { x, z } = oceanSide(boundary, d);
    if (terrain.surfaceHeightAt(x, z) < SEA_LEVEL) return d;
  }
  return undefined;
}

/**
 * 大海群系里露出水面、地表不高于 y 67、不是陡坡的列按新规则应铺的方块（#76 修订）：起伏高于高山阈值是石头，
 * 否则寒冷处是雪草方块，其余是沙子。起伏与温度直接取群系参数，地形对象的查询里看不到。
 */
function oceanShoreTop(seed: number, { x, z }: ColumnCoord): BlockType {
  if (reliefAt(seed, x, z) > MOUNTAIN_RELIEF) return BlockType.Stone;
  return isColdAt(seed, x, z) ? SNOWY_GRASS : SAND;
}

/** 这一列是大海群系里露出水面、地表在 y 63 到 67 的列。 */
function isLowExposedOcean(terrain: Terrain, { x, z }: ColumnCoord): boolean {
  const surface = terrain.surfaceHeightAt(x, z);
  return terrain.biomeAt(x, z) === Biome.Ocean && surface >= SEA_LEVEL && surface <= SEA_LEVEL + BEACH_MAX_ABOVE_SEA;
}

const sitesBySeed = new Map<number, Sites>();
function sitesOf(seed: number): Sites {
  const cached = sitesBySeed.get(seed);
  if (cached) return cached;
  const terrain = terrainOf(seed);

  const interior = new Map<Biome, ColumnCoord[]>();
  for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
    if (!isInterior(terrain, column, INTERIOR_REACH)) continue;
    const biome = terrain.biomeAt(column.x, column.z);
    interior.set(biome, [...(interior.get(biome) ?? []), column]);
  }
  const first = (biome: Biome): ChunkCoord | undefined => {
    const column = interior.get(biome)?.[0];
    return column && chunkOfColumn(column);
  };
  const mountainColumns = interior.get(Biome.Mountains) ?? [];
  const deepestOcean = spread(interior.get(Biome.Ocean) ?? [], OCEAN_CANDIDATES).sort(
    (a, b) => terrain.surfaceHeightAt(a.x, a.z) - terrain.surfaceHeightAt(b.x, b.z),
  )[0];

  const coasts = new Map<CoastKind, BiomeBoundary[]>();
  for (const boundary of surveyLines(8).flatMap((line) => boundariesOn(terrain, line))) {
    if (!boundary.biomes.includes(Biome.Ocean)) continue;
    const land = boundary.biomes.find((biome) => biome !== Biome.Ocean) as CoastKind | undefined;
    if (land === undefined) continue;
    coasts.set(land, [...(coasts.get(land) ?? []), boundary]);
  }
  const coastChunks = distinct(
    [...coasts.values()].flatMap((list) => list.slice(0, COAST_CHUNKS).map((b) => chunkOfColumn(b.b))),
  );

  const sites: Sites = {
    plains: first(Biome.Plains),
    snowy: first(Biome.Snowy),
    ocean: deepestOcean && chunkOfColumn(deepestOcean),
    mountains: distinct(spread(mountainColumns, MOUNTAIN_CHUNKS).map(chunkOfColumn)),
    highMountains: distinct(
      spread(
        mountainColumns.filter(({ x, z }) => terrain.surfaceHeightAt(x, z) >= HIGH_MOUNTAIN_Y),
        HIGH_MOUNTAIN_CHUNKS,
      ).map(chunkOfColumn),
    ),
    coasts,
    coastChunks,
  };
  sitesBySeed.set(seed, sites);
  return sites;
}

function expectSitesFound(seed: number): Sites {
  const s = sitesOf(seed);
  expect(s.plains, `种子 ${seed} 找不到平原内部的列`).toBeDefined();
  expect(s.snowy, `种子 ${seed} 找不到冰雪内部的列`).toBeDefined();
  expect(s.ocean, `种子 ${seed} 找不到大海内部的列`).toBeDefined();
  expect(s.mountains.length, `种子 ${seed} 的高山区块数`).toBeGreaterThan(0);
  expect(s.highMountains.length, `种子 ${seed} 地表 ≥ ${HIGH_MOUNTAIN_Y} 的高山区块数`).toBeGreaterThan(0);
  return s;
}

/** 远离大海的区块：平原、冰雪、高山内部。 */
function inlandChunks(s: Sites): ChunkCoord[] {
  return distinct([s.plains!, s.snowy!, ...s.mountains, ...s.highMountains]);
}

/** 一个种子下要检查的全部区块。 */
function allChunks(s: Sites): ChunkCoord[] {
  return distinct([...inlandChunks(s), s.ocean!, ...s.coastChunks]);
}

/** 区块四周 FAR_FROM_OCEAN 格内的采样点都不是大海。 */
function chunkFarFromOcean(terrain: Terrain, { cx, cz }: ChunkCoord): boolean {
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  for (let x = x0 - FAR_FROM_OCEAN; x <= x0 + CHUNK_SIZE + FAR_FROM_OCEAN; x += 4) {
    for (let z = z0 - FAR_FROM_OCEAN; z <= z0 + CHUNK_SIZE + FAR_FROM_OCEAN; z += 4) {
      if (terrain.biomeAt(x, z) === Biome.Ocean) return false;
    }
  }
  return true;
}

/** 区块里的一列：局部坐标与世界坐标。 */
interface ColumnInChunk {
  readonly chunk: Chunk;
  readonly lx: number;
  readonly lz: number;
  readonly x: number;
  readonly z: number;
}

function* columnsOf(seed: number, coords: readonly ChunkCoord[]): Generator<ColumnInChunk> {
  for (const coord of coords) {
    const chunk = chunkAt(seed, coord);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const { x, z } = columnIn(coord, lx, lz);
        yield { chunk, lx, lz, x, z };
      }
    }
  }
}

/** 一段露天的顶面：y、它上面那一格、是不是最高的那一段。 */
interface SegmentTop {
  readonly y: number;
  readonly above: BlockType;
  readonly highest: boolean;
}

/**
 * 一列里每一段露天的顶面：最高的那一段在地表高度（上面可能是树）；其下每一格地形方块、上面是空气、水或冰的，
 * 是悬垂下方那一段（或洞里）的顶面。
 *
 * 水塘列（#81）地表高度那一格挖成了水，没有「最高那一段」：塘底是上面是水的一段，与水下的段一样按深浅铺沙子。
 */
function segmentTops(terrain: Terrain, { chunk, lx, lz, x, z }: ColumnInChunk): SegmentTop[] {
  const surface = terrain.surfaceHeightAt(x, z);
  const pond = isPondColumn(terrain, x, z);
  const tops: SegmentTop[] = pond ? [] : [{ y: surface, above: chunk.get(lx, surface + 1, lz), highest: true }];
  for (let y = pond ? surface : surface - 1; y > WORLD_MIN_Y; y--) {
    if (!isTerrainBlock(chunk.get(lx, y, lz))) continue;
    const above = chunk.get(lx, y + 1, lz);
    if (above === BlockType.Air || above === BlockType.Water || above === BlockType.Ice) {
      tops.push({ y, above, highest: false });
    }
  }
  return tops;
}

function isCoveredByWater(above: BlockType): boolean {
  return above === BlockType.Water || above === BlockType.Ice;
}

/** 顶面之下连着几格某种方块。 */
function layersBelow(chunk: Chunk, lx: number, y: number, lz: number, block: BlockType): number {
  let n = 0;
  while (y - n - 1 > WORLD_MIN_Y && chunk.get(lx, y - n - 1, lz) === block) n++;
  return n;
}

/**
 * 草方块或雪草方块之下 3 到 4 层泥土，那一段不够厚时到段底为止。不对时返回说明。
 */
function dirtProblem(chunk: Chunk, lx: number, y: number, lz: number): string | undefined {
  const dirt = layersBelow(chunk, lx, y, lz, BlockType.Dirt);
  const next = chunk.get(lx, y - dirt - 1, lz);
  const segmentEnded = !isTerrainBlock(next);
  if (dirt > DIRT_LAYERS_MAX || (dirt < DIRT_LAYERS_MIN && !segmentEnded)) {
    return `下面 ${dirt} 层泥土，再下面是 ${blockName(next)}`;
  }
  return undefined;
}

/** 远离大海、不是陡坡、露出水面时，最高那一段的顶面按群系与高度应铺的方块。 */
function inlandTopBlock(biome: Biome, y: number): BlockType {
  if (biome === Biome.Snowy) return SNOWY_GRASS;
  if (biome === Biome.Mountains && y >= SNOW_LINE_Y) return SNOWY_GRASS;
  return BlockType.Grass;
}

describe('列顶地表方块查询与生成一致（#76）', () => {
  it.each(SURVEY_SEEDS)(
    '种子 %i：各群系与海边的区块每列 256 列（含区块边缘），查询等于生成结果里地表高度那一格；五种地表方块都出现',
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      const seen = new Set<BlockType>();
      let edgeColumns = 0;
      for (const column of columnsOf(seed, allChunks(s))) {
        const { chunk, lx, lz, x, z } = column;
        const queried = terrain.surfaceBlockAt(x, z);
        const generated = chunk.get(lx, terrain.surfaceHeightAt(x, z), lz);
        seen.add(queried);
        if (lx === 0 || lx === CHUNK_SIZE - 1 || lz === 0 || lz === CHUNK_SIZE - 1) edgeColumns++;
        if (queried !== generated) wrong.push(`(${x}, ${z})：查询 ${blockName(queried)}，生成 ${blockName(generated)}`);
      }
      expect(edgeColumns, '查过的区块边缘列').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
      for (const block of [BlockType.Grass, SNOWY_GRASS, BlockType.Stone, SAND, GRAVEL]) {
        expect(seen.has(block), `查询结果里没有 ${blockName(block)}`).toBe(true);
      }
    },
  );

  it.each(SURVEY_SEEDS)('种子 %i：区块边缘的陡坡列，查询与生成一致（陡坡要看相邻区块的列）', (seed) => {
    expectSurfaceBlocksDefined();
    const s = expectSitesFound(seed);
    const terrain = terrainOf(seed);
    const wrong: string[] = [];
    let steepEdge = 0;
    for (const column of columnsOf(seed, [...s.mountains, ...s.highMountains])) {
      const { chunk, lx, lz, x, z } = column;
      const onEdge = lx === 0 || lx === CHUNK_SIZE - 1 || lz === 0 || lz === CHUNK_SIZE - 1;
      // 水塘列（#81）列顶是水，不是陡坡的石头
      if (!onEdge || !isSteep(terrain, x, z) || isPondColumn(terrain, x, z)) continue;
      const surface = terrain.surfaceHeightAt(x, z);
      if (surface < SEA_LEVEL) continue;
      steepEdge++;
      const generated = chunk.get(lx, surface, lz);
      if (generated !== BlockType.Stone || terrain.surfaceBlockAt(x, z) !== BlockType.Stone) {
        wrong.push(`(${x}, ${z})：查询 ${blockName(terrain.surfaceBlockAt(x, z))}，生成 ${blockName(generated)}`);
      }
    }
    expect(steepEdge, '区块边缘的陡坡列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('露天、不是陡坡的顶面按群系铺（#76）', () => {
  /**
   * 远离大海的区块里，最高那一段露出水面、不是陡坡的列：顶层按群系与高度，其下 3 到 4 层泥土。
   * 返回各种群系与顶层的计数，以便断言要测的情形确实出现了。
   */
  function checkInland(seed: number, coords: readonly ChunkCoord[]): { wrong: string[]; counts: Map<string, number> } {
    const terrain = terrainOf(seed);
    const wrong: string[] = [];
    const counts = new Map<string, number>();
    const far = coords.filter((coord) => chunkFarFromOcean(terrain, coord));
    for (const column of columnsOf(seed, far)) {
      const { chunk, lx, lz, x, z } = column;
      const surface = terrain.surfaceHeightAt(x, z);
      if (surface < SEA_LEVEL || isSteep(terrain, x, z) || isPondColumn(terrain, x, z)) continue;
      const biome = terrain.biomeAt(x, z);
      const expected = inlandTopBlock(biome, surface);
      const actual = chunk.get(lx, surface, lz);
      const key = `${biome}:${blockName(expected)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (actual !== expected) {
        wrong.push(`(${x}, ${surface}, ${z}) ${biome}：应为 ${blockName(expected)}，生成 ${blockName(actual)}`);
        continue;
      }
      const dirt = dirtProblem(chunk, lx, surface, lz);
      if (dirt) wrong.push(`(${x}, ${surface}, ${z}) ${biome} ${blockName(actual)}：${dirt}`);
    }
    return { wrong, counts };
  }

  it.each(SURVEY_SEEDS)('种子 %i：平原的列顶是草方块，其下 3 到 4 层泥土', (seed) => {
    const s = expectSitesFound(seed);
    const { wrong, counts } = checkInland(seed, [s.plains!]);
    expect(counts.get(`${Biome.Plains}:Grass`) ?? 0, '查过的平原列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：冰雪的列顶是雪草方块，其下 3 到 4 层泥土', (seed) => {
    expectSurfaceBlocksDefined();
    const s = expectSitesFound(seed);
    const { wrong, counts } = checkInland(seed, [s.snowy!]);
    expect(counts.get(`${Biome.Snowy}:SnowyGrass`) ?? 0, '查过的冰雪列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)(
    `种子 %i：高山 y ${SNOW_LINE_Y} 以上的列顶是雪草方块、以下是草方块，其下都是 3 到 4 层泥土`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const { wrong, counts } = checkInland(seed, [...s.mountains, ...s.highMountains]);
      expect(counts.get(`${Biome.Mountains}:SnowyGrass`) ?? 0, '查过的雪线以上的高山列').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );
});

describe('陡坡露石头（#76）', () => {
  it.each(SURVEY_SEEDS)(
    '种子 %i：与相邻列地表高度差 ≥ 3 的列，顶层是石头，紧挨着的下一格不是泥土',
    (seed) => {
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      let steep = 0;
      for (const column of columnsOf(seed, [...s.mountains, ...s.highMountains])) {
        const { chunk, lx, lz, x, z } = column;
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface < SEA_LEVEL || !isSteep(terrain, x, z) || isPondColumn(terrain, x, z)) continue;
        steep++;
        const top = chunk.get(lx, surface, lz);
        const below = chunk.get(lx, surface - 1, lz);
        if (top !== BlockType.Stone) wrong.push(`(${x}, ${surface}, ${z}) 顶层是 ${blockName(top)}`);
        else if (below === BlockType.Dirt) wrong.push(`(${x}, ${surface}, ${z}) 石头下面是泥土`);
      }
      expect(steep, '查过的陡坡列').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );
});

describe('悬垂下方那段的顶层也按群系铺（#76）', () => {
  it.each(SURVEY_SEEDS)(
    `种子 %i：高山区块里最高那一段之下、上方是空气的顶面，y ${SNOW_LINE_Y} 以上是雪草方块、以下是草方块，其下 3 到 4 层泥土；上方是水的按深浅是沙子或沙砾`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      let lower = 0;
      for (const column of columnsOf(seed, [...s.mountains, ...s.highMountains])) {
        const { chunk, lx, lz, x, z } = column;
        const biome = terrain.biomeAt(x, z);
        for (const { y, above, highest } of segmentTops(terrain, column)) {
          if (highest) continue;
          lower++;
          const expected = isCoveredByWater(above) ? underwaterFloorAt(y) : inlandTopBlock(biome, y);
          const actual = chunk.get(lx, y, lz);
          if (actual !== expected) {
            wrong.push(`(${x}, ${y}, ${z}) ${biome} 上方 ${blockName(above)}：应为 ${blockName(expected)}，生成 ${blockName(actual)}`);
            continue;
          }
          if (actual === BlockType.Grass || actual === SNOWY_GRASS) {
            const dirt = dirtProblem(chunk, lx, y, lz);
            if (dirt) wrong.push(`(${x}, ${y}, ${z}) ${blockName(actual)}：${dirt}`);
          }
        }
      }
      expect(lower, '查过的悬垂下方的顶面').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );
});

describe('每一段露天的顶面都铺了地表（#76）', () => {
  it.each(SURVEY_SEEDS)(
    '种子 %i：每一段上方是空气、水或冰的顶面都是草方块、雪草方块、石头、沙子、沙砾之一；草方块与雪草方块之下 3 到 4 层泥土',
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      const seen = new Set<BlockType>();
      for (const column of columnsOf(seed, allChunks(s))) {
        const { chunk, lx, lz, x, z } = column;
        for (const { y } of segmentTops(terrain, column)) {
          const block = chunk.get(lx, y, lz);
          seen.add(block);
          if (!TERRAIN_SURFACE.has(block)) {
            wrong.push(`(${x}, ${y}, ${z}) 顶面是 ${blockName(block)}`);
            continue;
          }
          if (block === BlockType.Grass || block === SNOWY_GRASS) {
            const dirt = dirtProblem(chunk, lx, y, lz);
            if (dirt) wrong.push(`(${x}, ${y}, ${z}) ${blockName(block)}：${dirt}`);
          }
        }
      }
      expect(wrong.slice(0, 20)).toEqual([]);
      for (const block of [BlockType.Grass, SNOWY_GRASS, BlockType.Stone, SAND, GRAVEL]) {
        expect(seen.has(block), `生成结果的顶面里没有 ${blockName(block)}`).toBe(true);
      }
    },
  );
});

describe('水下的沙子与沙砾（#76）', () => {
  it.each(SURVEY_SEEDS)(
    `种子 %i：上方是水或冰的顶面不论群系，y ${SHALLOW_MIN_Y} 以上是沙子，更低是沙砾；没有草方块与雪草方块`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      const counts = new Map<BlockType, number>();
      for (const column of columnsOf(seed, allChunks(s))) {
        const { chunk, lx, lz, x, z } = column;
        for (const { y, above } of segmentTops(terrain, column)) {
          if (!isCoveredByWater(above)) continue;
          const expected = underwaterFloorAt(y);
          const actual = chunk.get(lx, y, lz);
          counts.set(expected, (counts.get(expected) ?? 0) + 1);
          if (actual !== expected) {
            wrong.push(`(${x}, ${y}, ${z}) ${terrain.biomeAt(x, z)}：应为 ${blockName(expected)}，生成 ${blockName(actual)}`);
          }
        }
      }
      expect(counts.get(SAND) ?? 0, '查过的浅处水底').toBeGreaterThan(0);
      expect(counts.get(GRAVEL) ?? 0, '查过的深处水底').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );

  it.each(SURVEY_SEEDS)('种子 %i：地表低于海平面的列，列顶地表方块查询按深浅是沙子或沙砾', (seed) => {
    expectSurfaceBlocksDefined();
    const terrain = terrainOf(seed);
    const wrong: string[] = [];
    let underwater = 0;
    for (const { x, z } of gridColumns(2048, 61)) {
      const surface = terrain.surfaceHeightAt(x, z);
      if (surface >= SEA_LEVEL) continue;
      underwater++;
      const queried = terrain.surfaceBlockAt(x, z);
      if (queried !== underwaterFloorAt(surface)) {
        wrong.push(`(${x}, ${surface}, ${z}) ${terrain.biomeAt(x, z)}：查询 ${blockName(queried)}`);
      }
    }
    expect(underwater, '采样到的低于海平面的列').toBeGreaterThan(100);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('沙滩（#76）', () => {
  /** 这一列露出水面、列顶地表方块是沙子。 */
  function isExposedSand(terrain: Terrain, { x, z }: ColumnCoord): boolean {
    return terrain.surfaceHeightAt(x, z) >= SEA_LEVEL && terrain.surfaceBlockAt(x, z) === SAND;
  }

  /** 交界两侧 BEACH_SEARCH 格内离交界最近的露天沙子列。 */
  function beachNear(terrain: Terrain, boundary: BiomeBoundary): ColumnCoord | undefined {
    for (let k = 0; k <= BEACH_SEARCH; k++) {
      for (const d of [k, -1 - k]) {
        const column = alongBoundary(boundary, d);
        if (isExposedSand(terrain, column)) return column;
      }
    }
    return undefined;
  }

  /** 过这一列沿 (dx, dz) 方向连续露天沙子列的长度（含它自己）。 */
  function sandRun(terrain: Terrain, { x, z }: ColumnCoord, dx: number, dz: number): number {
    let n = 1;
    for (let k = 1; k < BEACH_RUN_LIMIT && isExposedSand(terrain, { x: x + dx * k, z: z + dz * k }); k++) n++;
    for (let k = 1; k < BEACH_RUN_LIMIT && isExposedSand(terrain, { x: x - dx * k, z: z - dz * k }); k++) n++;
    return n;
  }

  /** 沙滩宽度：沿 x、沿 z 各数一次，取较小的（交界斜着走时，较小的那个最接近垂直于岸的宽度）。 */
  function beachWidth(terrain: Terrain, column: ColumnCoord): number {
    return Math.min(sandRun(terrain, column, 1, 0), sandRun(terrain, column, 0, 1));
  }

  /** 一列周围切比雪夫距离 reach 格内有大海的列（步长 2 采样）。 */
  function oceanWithin(terrain: Terrain, { x, z }: ColumnCoord, reach: number): boolean {
    for (let dx = -reach; dx <= reach; dx += 2) {
      for (let dz = -reach; dz <= reach; dz += 2) {
        if (terrain.biomeAt(x + dx, z + dz) === Biome.Ocean) return true;
      }
    }
    return false;
  }

  describe('平原与大海交界', () => {
    const land = Biome.Plains;

    it.each(SURVEY_SEEDS)(
      `种子 %i：九成以上的交界，两侧 ${BEACH_SEARCH} 格内有露出水面的沙子`,
      (seed) => {
        expectSurfaceBlocksDefined();
        const terrain = terrainOf(seed);
        const coasts = sitesOf(seed).coasts.get(land) ?? [];
        expect(coasts.length, '采样线上的交界数').toBeGreaterThanOrEqual(20);
        const missing = coasts.filter((boundary) => beachNear(terrain, boundary) === undefined);
        expect(
          1 - missing.length / coasts.length,
          `没有沙子的交界：${missing.slice(0, 5).map((b) => `(${b.b.x}, ${b.b.z})`).join('、')}`,
        ).toBeGreaterThanOrEqual(BEACH_PRESENT_SHARE);
      },
    );

    it.each(SURVEY_SEEDS)(
      `种子 %i：沙滩宽约 4 到 20 格（各交界宽度的中位数在 ${BEACH_WIDTH_MEDIAN_MIN} 到 ${BEACH_WIDTH_MEDIAN_MAX}，九成不超过 ${BEACH_WIDTH_P90_MAX}）`,
      (seed) => {
        expectSurfaceBlocksDefined();
        const terrain = terrainOf(seed);
        const widths = (sitesOf(seed).coasts.get(land) ?? [])
          .map((boundary) => beachNear(terrain, boundary))
          .filter((column): column is ColumnCoord => column !== undefined)
          .map((column) => beachWidth(terrain, column))
          .sort((a, b) => a - b);
        expect(widths.length, '量到宽度的交界数').toBeGreaterThanOrEqual(10);
        const median = widths[Math.floor((widths.length - 1) / 2)]!;
        const p90 = widths[Math.floor(0.9 * (widths.length - 1))]!;
        expect(median, `宽度：${widths.join(' ')}`).toBeGreaterThanOrEqual(BEACH_WIDTH_MEDIAN_MIN);
        expect(median, `宽度：${widths.join(' ')}`).toBeLessThanOrEqual(BEACH_WIDTH_MEDIAN_MAX);
        expect(p90, `宽度：${widths.join(' ')}`).toBeLessThanOrEqual(BEACH_WIDTH_P90_MAX);
      },
    );

    it.each(SURVEY_SEEDS)(
      `种子 %i：生成结果里沙滩的顶层与其下至少 ${BEACH_SAND_LAYERS_MIN - 1} 层是沙子，连续不超过 ${BEACH_SAND_LAYERS_MAX} 层，上面是空气或树`,
      (seed) => {
        expectSurfaceBlocksDefined();
        const terrain = terrainOf(seed);
        const beaches = (sitesOf(seed).coasts.get(land) ?? [])
          .map((boundary) => beachNear(terrain, boundary))
          .filter((column): column is ColumnCoord => column !== undefined)
          .slice(0, COAST_CHUNKS);
        expect(beaches.length, '找到的沙滩列').toBe(COAST_CHUNKS);
        const wrong: string[] = [];
        for (const column of beaches) {
          const chunk = chunkAt(seed, chunkOfColumn(column));
          const lx = column.x - chunk.cx * CHUNK_SIZE;
          const lz = column.z - chunk.cz * CHUNK_SIZE;
          const surface = terrain.surfaceHeightAt(column.x, column.z);
          const where = `(${column.x}, ${surface}, ${column.z})`;
          if (chunk.get(lx, surface, lz) !== SAND) wrong.push(`${where} 顶层是 ${blockName(chunk.get(lx, surface, lz))}`);
          const sand = 1 + layersBelow(chunk, lx, surface, lz, SAND);
          if (sand < BEACH_SAND_LAYERS_MIN || sand > BEACH_SAND_LAYERS_MAX) wrong.push(`${where} 连续 ${sand} 层沙子`);
          if (isTerrainBlock(chunk.get(lx, surface + 1, lz))) wrong.push(`${where} 上面是 ${blockName(chunk.get(lx, surface + 1, lz))}`);
        }
        expect(wrong).toEqual([]);
      },
    );
  });

  describe.each([
    ['平原', Biome.Plains],
    ['冰雪', Biome.Snowy],
  ] as const)('%s与大海交界', (_name, land) => {
    it.each(SURVEY_SEEDS)(
      `种子 %i：${SHORE_TO_WATER_SHARE * 100}% 以上的交界，从陆地一侧 4 格到水边之间露出水面的列没有草方块（#76 修订）`,
      (seed) => {
        expectSurfaceBlocksDefined();
        const terrain = terrainOf(seed);
        let reached = 0;
        const grassy: string[] = [];
        for (const boundary of sitesOf(seed).coasts.get(land) ?? []) {
          const edge = waterEdgeOf(terrain, boundary);
          if (edge === undefined) continue;
          reached++;
          const span = [
            ...Array.from({ length: 4 }, (_, d) => landSide(boundary, d)),
            ...Array.from({ length: edge }, (_, d) => oceanSide(boundary, d)),
          ];
          const grass = span.find(
            ({ x, z }) => terrain.surfaceHeightAt(x, z) >= SEA_LEVEL && terrain.surfaceBlockAt(x, z) === BlockType.Grass,
          );
          if (grass) grassy.push(`(${grass.x}, ${grass.z})`);
        }
        expect(reached, '往海里走到了水边的交界数').toBeGreaterThanOrEqual(20);
        expect(1 - grassy.length / reached, `陆地一侧到水边之间有草方块的交界：${grassy.slice(0, 10).join('、')}`).toBeGreaterThanOrEqual(
          SHORE_TO_WATER_SHARE,
        );
      },
    );
  });

  it.each(SURVEY_SEEDS)(
    `种子 %i：平原临海处，非寒冷处的水边（往海里最后一列露出水面的列）${SHORE_TO_WATER_SHARE * 100}% 以上是沙子或石头（#76 修订）`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const edges: string[] = [];
      let warm = 0;
      for (const boundary of sitesOf(seed).coasts.get(Biome.Plains) ?? []) {
        const edge = waterEdgeOf(terrain, boundary);
        if (edge === undefined || edge === 0) continue;
        const column = oceanSide(boundary, edge - 1);
        if (isColdAt(seed, column.x, column.z)) continue;
        warm++;
        const block = terrain.surfaceBlockAt(column.x, column.z);
        if (block !== SAND && block !== BlockType.Stone) edges.push(`(${column.x}, ${column.z}) ${blockName(block)}`);
      }
      expect(warm, '非寒冷处的水边').toBeGreaterThanOrEqual(20);
      expect(1 - edges.length / warm, `水边不是沙子或石头：${edges.slice(0, 10).join('、')}`).toBeGreaterThanOrEqual(
        SHORE_TO_WATER_SHARE,
      );
    },
  );

  it.each(SURVEY_SEEDS)(
    `种子 %i：冰雪临海处，寒冷处的水边 ${SHORE_TO_WATER_SHARE * 100}% 以上是雪草方块（#76 复审，修订后保留）`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const edges: string[] = [];
      let cold = 0;
      for (const boundary of sitesOf(seed).coasts.get(Biome.Snowy) ?? []) {
        const edge = waterEdgeOf(terrain, boundary);
        if (edge === undefined || edge === 0) continue;
        const column = oceanSide(boundary, edge - 1);
        if (!isColdAt(seed, column.x, column.z)) continue;
        cold++;
        const block = terrain.surfaceBlockAt(column.x, column.z);
        if (block !== SNOWY_GRASS) edges.push(`(${column.x}, ${column.z}) ${blockName(block)}`);
      }
      expect(cold, '寒冷处的水边').toBeGreaterThanOrEqual(20);
      expect(1 - edges.length / cold, `水边不是雪草方块：${edges.slice(0, 10).join('、')}`).toBeGreaterThanOrEqual(
        SHORE_TO_WATER_SHARE,
      );
    },
  );

  it.each(SURVEY_SEEDS)(
    `种子 %i：大海群系里露出水面、地表在 y ${SEA_LEVEL} 到 ${SEA_LEVEL + BEACH_MAX_ABOVE_SEA}、不是陡坡的列，起伏高于高山阈值是石头，否则寒冷处是雪草方块、其余是沙子（#76 修订）`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      const counts = new Map<BlockType, number>();
      const seen = new Set<string>();
      const coasts = [...sitesOf(seed).coasts.values()].flat();
      for (const boundary of coasts) {
        for (let d = 0; d < WATER_EDGE_SEARCH; d++) {
          const column = oceanSide(boundary, d);
          const key = `${column.x},${column.z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!isLowExposedOcean(terrain, column) || isSteep(terrain, column.x, column.z)) continue;
          const expected = oceanShoreTop(seed, column);
          counts.set(expected, (counts.get(expected) ?? 0) + 1);
          const actual = terrain.surfaceBlockAt(column.x, column.z);
          if (actual !== expected) {
            wrong.push(`(${column.x}, ${terrain.surfaceHeightAt(column.x, column.z)}, ${column.z})：应为 ${blockName(expected)}，查询 ${blockName(actual)}`);
          }
        }
      }
      for (const block of [SAND, SNOWY_GRASS, BlockType.Stone]) {
        expect(counts.get(block) ?? 0, `应为 ${blockName(block)} 的列`).toBeGreaterThan(0);
      }
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );

  it.each(SURVEY_SEEDS)(
    `种子 %i：露出水面的沙子只在离大海 ${BEACH_MAX_REACH} 格以内、地表在 y ${SEA_LEVEL} 到 ${SEA_LEVEL + BEACH_MAX_ABOVE_SEA} 的平原或大海列上（#76 第二次修订：冰雪群系的列没有沙子）`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const s = expectSitesFound(seed);
      const terrain = terrainOf(seed);
      const wrong: string[] = [];
      let exposedSand = 0;
      for (const { x, z } of columnsOf(seed, allChunks(s))) {
        if (!isExposedSand(terrain, { x, z })) continue;
        exposedSand++;
        const surface = terrain.surfaceHeightAt(x, z);
        const biome = terrain.biomeAt(x, z);
        if (biome === Biome.Mountains) wrong.push(`(${x}, ${z}) 高山列是沙子`);
        if (biome === Biome.Snowy) wrong.push(`(${x}, ${z}) 冰雪列是沙子`);
        if (surface > SEA_LEVEL + BEACH_MAX_ABOVE_SEA) wrong.push(`(${x}, ${z}) 地表 ${surface} 是沙子`);
        if (!oceanWithin(terrain, { x, z }, BEACH_MAX_REACH)) wrong.push(`(${x}, ${z}) 离大海超过 ${BEACH_MAX_REACH} 格`);
      }
      // 远离大海的平原、冰雪内部（网格采样）：露出水面的列一列沙子都没有
      for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
        const biome = terrain.biomeAt(column.x, column.z);
        if (biome !== Biome.Plains && biome !== Biome.Snowy) continue;
        if (oceanWithin(terrain, column, BEACH_MAX_REACH)) continue;
        if (isExposedSand(terrain, column)) wrong.push(`(${column.x}, ${column.z}) 内陆是沙子`);
      }
      expect(exposedSand, '海边区块里露出水面的沙子列').toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );

  it.each(SURVEY_SEEDS)(
    `种子 %i：高山直接临海处是石头岸：交界两侧 ${ROCKY_COAST_WINDOW} 格内高山群系的列没有沙子，大海一侧起伏高于高山阈值的低处列是石头，八成以上的交界在高山一侧有石头`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const clear = (sitesOf(seed).coasts.get(Biome.Mountains) ?? []).filter((boundary) => {
        for (let dx = -ROCKY_COAST_CLEAR; dx <= ROCKY_COAST_CLEAR; dx += 4) {
          for (let dz = -ROCKY_COAST_CLEAR; dz <= ROCKY_COAST_CLEAR; dz += 4) {
            const biome = terrain.biomeAt(boundary.b.x + dx, boundary.b.z + dz);
            if (biome === Biome.Plains || biome === Biome.Snowy) return false;
          }
        }
        return true;
      });
      expect(clear.length, '高山直接临海的交界数').toBeGreaterThanOrEqual(5);
      const sandy: string[] = [];
      const notStone: string[] = [];
      let rocky = 0;
      let seaward = 0;
      for (const boundary of clear) {
        for (let d = -ROCKY_COAST_WINDOW - 1; d <= ROCKY_COAST_WINDOW; d++) {
          const { x, z } = alongBoundary(boundary, d);
          if (terrain.biomeAt(x, z) !== Biome.Mountains) continue;
          if (terrain.surfaceHeightAt(x, z) >= SEA_LEVEL && terrain.surfaceBlockAt(x, z) === SAND) {
            sandy.push(`(${x}, ${z})`);
          }
        }
        for (let d = 0; d <= ROCKY_COAST_WINDOW; d++) {
          const column = oceanSide(boundary, d);
          if (!isLowExposedOcean(terrain, column) || reliefAt(seed, column.x, column.z) <= MOUNTAIN_RELIEF) continue;
          seaward++;
          const block = terrain.surfaceBlockAt(column.x, column.z);
          if (block !== BlockType.Stone) notStone.push(`(${column.x}, ${column.z}) ${blockName(block)}`);
        }
        for (let d = 0; d <= ROCKY_COAST_WINDOW; d++) {
          const { x, z } = landSide(boundary, d);
          if (terrain.surfaceHeightAt(x, z) >= SEA_LEVEL && terrain.surfaceBlockAt(x, z) === BlockType.Stone) {
            rocky++;
            break;
          }
        }
      }
      expect(sandy.slice(0, 20)).toEqual([]);
      expect(seaward, '大海一侧起伏高于高山阈值的低处列').toBeGreaterThan(0);
      expect(notStone.slice(0, 20)).toEqual([]);
      expect(rocky / clear.length, '高山一侧有石头的交界占比').toBeGreaterThanOrEqual(ROCKY_COAST_STONE_SHARE);
    },
  );
});

describe('树只长在列顶地表方块是草方块或雪草方块的列上（#76）', () => {
  const LOGS: ReadonlySet<BlockType> = new Set([BlockType.OakLog, BlockType.BirchLog, BlockType.SpruceLog]);

  it.each(SURVEY_SEEDS)('种子 %i：每根树干最下面那格原木的正下方是草方块或雪草方块，那一列的列顶地表方块也是', (seed) => {
    const s = expectSitesFound(seed);
    const terrain = terrainOf(seed);
    const allowed = new Set<BlockType>([BlockType.Grass, SNOWY_GRASS]);
    const wrong: string[] = [];
    let trunks = 0;
    for (const { chunk, lx, lz, x, z } of columnsOf(seed, allChunks(s))) {
      for (let y = WORLD_MIN_Y + 1; y <= WORLD_MAX_Y; y++) {
        if (!LOGS.has(chunk.get(lx, y, lz))) continue;
        const below = chunk.get(lx, y - 1, lz);
        if (!isTerrainBlock(below)) break;
        trunks++;
        const queried = terrain.surfaceBlockAt(x, z);
        if (!allowed.has(below) || !allowed.has(queried)) {
          wrong.push(`(${x}, ${y}, ${z})：树干下面是 ${blockName(below)}，列顶地表方块查询是 ${blockName(queried)}`);
        }
        break;
      }
    }
    expect(trunks, '查过的树干').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('冰雪临海的大海一侧（#76 按审查补）', () => {
  /** 往海里看多远：水边多在大海群系里 10 格左右。 */
  const OCEAN_SIDE_REACH = 16;

  it.each(SURVEY_SEEDS)('种子 %i：冰雪与大海交界处，大海一侧露出水面的列不是草方块', (seed) => {
    expectSurfaceBlocksDefined();
    const terrain = terrainOf(seed);
    const wrong: string[] = [];
    let exposed = 0;
    for (const boundary of sitesOf(seed).coasts.get(Biome.Snowy) ?? []) {
      for (let d = 0; d < OCEAN_SIDE_REACH; d++) {
        const { x, z } = oceanSide(boundary, d);
        if (terrain.biomeAt(x, z) !== Biome.Ocean || terrain.surfaceHeightAt(x, z) < SEA_LEVEL) continue;
        exposed++;
        if (terrain.surfaceBlockAt(x, z) === BlockType.Grass) wrong.push(`(${x}, ${z})`);
      }
    }
    expect(exposed, '大海一侧露出水面的列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('冰雪临海不铺沙子（#76 第二次修订，用户决定）', () => {
  /** 冰雪与大海交界那一对里陆地一侧 SNOWY_COAST_WINDOW 格内、群系是冰雪、露出水面的列。 */
  function snowyLandColumns(terrain: Terrain, boundary: BiomeBoundary): ColumnCoord[] {
    return Array.from({ length: SNOWY_COAST_WINDOW }, (_, d) => landSide(boundary, d)).filter(
      ({ x, z }) => terrain.biomeAt(x, z) === Biome.Snowy && terrain.surfaceHeightAt(x, z) >= SEA_LEVEL,
    );
  }

  it.each(SURVEY_SEEDS)(
    `种子 %i：冰雪与大海交界处，陆地一侧 ${SNOWY_COAST_WINDOW} 格内冰雪群系露出水面的列没有沙子，不是陡坡的列顶是雪草方块`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const coasts = sitesOf(seed).coasts.get(Biome.Snowy) ?? [];
      expect(coasts.length, '采样线上冰雪与大海的交界数').toBeGreaterThanOrEqual(20);
      const wrong: string[] = [];
      let checked = 0;
      let lowShore = 0;
      for (const boundary of coasts) {
        for (const { x, z } of snowyLandColumns(terrain, boundary)) {
          checked++;
          const surface = terrain.surfaceHeightAt(x, z);
          if (surface <= SEA_LEVEL + BEACH_MAX_ABOVE_SEA) lowShore++;
          const block = terrain.surfaceBlockAt(x, z);
          const expected = isSteep(terrain, x, z) ? BlockType.Stone : SNOWY_GRASS;
          if (block !== expected) wrong.push(`(${x}, ${surface}, ${z})：应为 ${blockName(expected)}，查询 ${blockName(block)}`);
        }
      }
      expect(checked, '查过的冰雪陆地列').toBeGreaterThan(0);
      // 地表不高于 y 67 的列是原来铺沙子的那些，要确实查到
      expect(lowShore, `查过的地表在 y ${SEA_LEVEL} 到 ${SEA_LEVEL + BEACH_MAX_ABOVE_SEA} 的冰雪陆地列`).toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );

  it.each(SURVEY_SEEDS)(
    '种子 %i：冰雪临海的区块里，冰雪群系露出水面、不是陡坡的列，生成结果顶层是雪草方块，其下 3 到 4 层泥土',
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      const coords = distinct(
        (sitesOf(seed).coasts.get(Biome.Snowy) ?? []).slice(0, COAST_CHUNKS).map((b) => chunkOfColumn(b.b)),
      );
      expect(coords.length, '冰雪临海的区块').toBeGreaterThan(0);
      const wrong: string[] = [];
      let checked = 0;
      let lowShore = 0;
      for (const { chunk, lx, lz, x, z } of columnsOf(seed, coords)) {
        if (terrain.biomeAt(x, z) !== Biome.Snowy) continue;
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface < SEA_LEVEL || isSteep(terrain, x, z)) continue;
        checked++;
        if (surface <= SEA_LEVEL + BEACH_MAX_ABOVE_SEA) lowShore++;
        const actual = chunk.get(lx, surface, lz);
        if (actual !== SNOWY_GRASS) {
          wrong.push(`(${x}, ${surface}, ${z})：应为雪草方块，生成 ${blockName(actual)}`);
          continue;
        }
        const dirt = dirtProblem(chunk, lx, surface, lz);
        if (dirt) wrong.push(`(${x}, ${surface}, ${z}) 雪草方块：${dirt}`);
      }
      expect(checked, '查过的冰雪列').toBeGreaterThan(0);
      expect(lowShore, `查过的地表在 y ${SEA_LEVEL} 到 ${SEA_LEVEL + BEACH_MAX_ABOVE_SEA} 的冰雪列`).toBeGreaterThan(0);
      expect(wrong.slice(0, 20)).toEqual([]);
    },
  );

  it.each(SURVEY_SEEDS)(
    `种子 %i：寒冷处的冰雪海岸，${SNOWY_SHORE_SHARE * 100}% 以上的交界从陆地一侧 4 格到水边之间露出水面的列全是雪草方块或石头`,
    (seed) => {
      expectSurfaceBlocksDefined();
      const terrain = terrainOf(seed);
      let reached = 0;
      const mixed: string[] = [];
      for (const boundary of sitesOf(seed).coasts.get(Biome.Snowy) ?? []) {
        const edge = waterEdgeOf(terrain, boundary);
        if (edge === undefined || edge === 0) continue;
        const shore = oceanSide(boundary, edge - 1);
        if (!isColdAt(seed, shore.x, shore.z)) continue;
        reached++;
        const span = [
          ...Array.from({ length: 4 }, (_, d) => landSide(boundary, d)),
          ...Array.from({ length: edge }, (_, d) => oceanSide(boundary, d)),
        ];
        const other = span.find(({ x, z }) => {
          if (terrain.surfaceHeightAt(x, z) < SEA_LEVEL) return false;
          const block = terrain.surfaceBlockAt(x, z);
          return block !== SNOWY_GRASS && block !== BlockType.Stone;
        });
        if (other) mixed.push(`(${other.x}, ${other.z}) ${blockName(terrain.surfaceBlockAt(other.x, other.z))}`);
      }
      expect(reached, '水边在寒冷处的冰雪交界数').toBeGreaterThanOrEqual(20);
      expect(1 - mixed.length / reached, `陆地一侧到水边之间有别的方块的交界：${mixed.slice(0, 10).join('、')}`).toBeGreaterThanOrEqual(
        SNOWY_SHORE_SHARE,
      );
    },
  );
});

describe('矿脉不替换列顶的石头（#76 按变异测试补）', () => {
  /** 高山临海交界附近这么多个区块里找矿脉格落在列顶石头上的列。 */
  const COAST_CHUNK_REACH = 2;

  it.each(SURVEY_SEEDS)('种子 %i：矿脉经过列顶是石头的那一格时，生成结果里那一格仍是石头，与列顶地表方块查询一致', (seed) => {
    const terrain = terrainOf(seed);
    const checked = new Set<string>();
    const wrong: string[] = [];
    let hits = 0;
    // 石头岸与靠近海平面的陡坡在 y 63 到 67，煤矿脉最高到 y 64，只有高山临海处会经过列顶的石头
    for (const boundary of sitesOf(seed).coasts.get(Biome.Mountains) ?? []) {
      const center = chunkOfColumn(boundary.b);
      for (let dcx = -COAST_CHUNK_REACH; dcx <= COAST_CHUNK_REACH; dcx++) {
        for (let dcz = -COAST_CHUNK_REACH; dcz <= COAST_CHUNK_REACH; dcz++) {
          const coord = { cx: center.cx + dcx, cz: center.cz + dcz };
          const key = `${coord.cx},${coord.cz}`;
          if (checked.has(key)) continue;
          checked.add(key);
          const cells = new Set(oreVeinsTouching(seed, coord.cx, coord.cz).flatMap((vein) => vein.cells.map(({ x, y, z }) => `${x},${y},${z}`)));
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
              const { x, z } = columnIn(coord, lx, lz);
              const surface = terrain.surfaceHeightAt(x, z);
              if (!cells.has(`${x},${surface},${z}`) || terrain.surfaceBlockAt(x, z) !== BlockType.Stone) continue;
              hits++;
              const generated = chunkAt(seed, coord).get(lx, surface, lz);
              if (generated !== BlockType.Stone) wrong.push(`(${x}, ${surface}, ${z})：生成 ${blockName(generated)}`);
            }
          }
        }
      }
      if (hits >= 3) break;
    }
    expect(hits, '矿脉格落在列顶石头上的列').toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

describe('冰雪的树长在雪草方块上（#76 按变异测试补）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：冰雪内部的区块与周围 8 个区块里有树干立在雪草方块上', (seed) => {
    expectSurfaceBlocksDefined();
    const s = expectSitesFound(seed);
    const LOGS: ReadonlySet<BlockType> = new Set([BlockType.OakLog, BlockType.BirchLog, BlockType.SpruceLog]);
    const around: ChunkCoord[] = [];
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcz = -1; dcz <= 1; dcz++) around.push({ cx: s.snowy!.cx + dcx, cz: s.snowy!.cz + dcz });
    }
    let onSnowyGrass = 0;
    for (const { chunk, lx, lz, x, z } of columnsOf(seed, around)) {
      const surface = terrainOf(seed).surfaceHeightAt(x, z);
      if (LOGS.has(chunk.get(lx, surface + 1, lz)) && chunk.get(lx, surface, lz) === SNOWY_GRASS) onSnowyGrass++;
    }
    expect(onSnowyGrass, '立在雪草方块上的树干').toBeGreaterThan(0);
  });
});

describe('出生列仍落在草方块上（#76，#84 的螺旋搜索下同样成立）', () => {
  it.each([...SURVEY_SEEDS, DEFAULT_SEED])('种子 %i：出生列的群系是平原，列顶地表方块是草方块', (seed) => {
    const terrain = createTerrain(seed);
    const { x, z } = terrain.spawnColumn;
    expect(terrain.biomeAt(x, z)).toBe(Biome.Plains);
    expect(blockName(terrain.surfaceBlockAt(x, z))).toBe(blockName(BlockType.Grass));
  });
});
