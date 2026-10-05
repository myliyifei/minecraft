import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, SEA_LEVEL, WORLD_MAX_Y } from '../../src/core/constants';
import { SNOW_LINE_Y } from '../../src/core/surface';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { treesTouching } from '../../src/core/tree';
import { chunkOf, localOf, type ChunkCoord } from '../../src/core/world';
import { solidUpToSurface } from '../helpers/flat-terrain';
import { isPlantBlock } from '../helpers/plants';
import { columnKey, pondKey, pondsTouching, type Pond, type PondPlacement } from '../helpers/ponds';
import { gridColumns, highestTerrainY, isInterior, isTerrainBlock, SURVEY_SEEDS } from '../helpers/terrain-survey';
import { LEAVES, LOGS, worldCells } from '../helpers/trees';

/**
 * 水塘（#81，父 spec #72「湖泊、冰面与水塘」，CONTEXT.md「水塘」）。
 *
 * 只经测试边界：`createTerrain(seed)` 的生成器与三个查询、出生列，`treesTouching`，与新接口 `pondsTouching`
 * （经 tests/helpers/ponds.ts 取）。不测噪声与密度的内部。
 *
 * 采样方法：三个种子（314159、777、−42）各在 ±2560 格、步长 64 的网格上取第一列平原内部的列（东南西北 64 格外仍是平原），
 * 以它所在区块为中心取 8×8 个区块（cx − 4 到 cx + 3），全部生成。区域里的「水塘列」按生成结果判定：地表高度那一格是水。
 * 水塘列 4 邻接连成的一片是一个水塘；碰到区域最外一圈列的那几片不完整，不参与形状的统计。
 *
 * 判定方式：
 * - 水面高度：水塘列里最上面那一格水的 y；同一片水塘的各列相同，即水面是平的。
 * - 塘底：水塘列最高的地形方块（水、冰、树、植物之外的方块），要求是沙子；塘底之上到水面全是水，水面之上没有水。
 * - 直径：水面那一层连通水格（即那一片水塘列）沿 x、沿 z 的跨度（格数）取较大的那个，在 5 到 10。
 * - 深度：水面到塘底的格数（水面 y − 塘底 y，即这一列水的格数）。每一列在 1 到 4，每个水塘最深的一列在 2 到 4。
 * - 边缘不缺口：水塘里每一格水的东南西北四邻是水或地形方块，没有空气。
 * - 盆地边缘保持原样：与水塘列相邻、本身不是水塘列的列，最高的地形方块仍在地表高度，地表高度不低于水面。
 * - 数量：约每 8 个区块一个（平原；高山多陡坡，水塘少，不计数量）。只用 pondsTouching、按中心列去重计数，
 *   每个种子 24×24 个平原区块，三个种子合计每 8 个区块 1/3 到 3 个（与 1 同一量级，容差 3 倍）。
 *   pondsTouching 给出的就是世界里的水塘这一点由「生成结果里的水塘列正好是 pondsTouching 的水塘列」那条断言保证。
 * - 地表高度不随水塘变：区域里每一列的地表高度查询与 main（提交 7511106，还没有水塘）上同一区域的指纹相同。
 */

/** 区块区域的边长与相对中心区块的起点。 */
const REGION_CHUNKS = 8;
const REGION_FROM = -4;

const FIND_HALF = 2560;
const FIND_STEP = 64;
const INTERIOR_REACH = 64;

/** issue 给的范围。 */
const DIAMETER_MIN = 5;
const DIAMETER_MAX = 10;
const DEPTH_MAX = 4;
const DEEPEST_MIN = 2;
/** 出生列周围不出现水塘的半径（切比雪夫距离，含边界）。 */
const SPAWN_CLEARANCE = 7;

/** 数量：每 8 个区块一个，容差 3 倍。 */
const CHUNKS_PER_POND = 8;
const COUNT_TOLERANCE = 3;
/** 数水塘时每个种子取的平原区块边长。 */
const COUNT_CHUNKS = 24;

/**
 * main（7511106）上各种子采样区域里地表高度查询的指纹（`heightFingerprint`）：那时还没有水塘，所以等于「挖水塘之前」的值。
 * 换了地形密度（不是水塘）时要按新的 main 重算。
 */
const PRE_POND_FINGERPRINTS: Readonly<Record<number, string>> = {
  314_159: '2ae06179',
  777: '8b0632c8',
  [-42]: 'c6be5b04',
};

/** 区域里的一列水塘列（生成结果）。 */
interface PondColumn {
  readonly x: number;
  readonly z: number;
  /** 最上面那格水的 y。 */
  readonly waterTop: number;
  /** 塘底：最高的地形方块的 y。 */
  readonly floor: number;
}

/** 生成结果里的一片水塘。 */
interface GeneratedPond {
  readonly columns: readonly PondColumn[];
  /** 是否碰到区域最外一圈。 */
  readonly truncated: boolean;
}

interface Survey {
  readonly terrain: Terrain;
  /** 区域里的区块坐标，按 cz、cx 排好。 */
  readonly coords: readonly ChunkCoord[];
  readonly x0: number;
  readonly z0: number;
  readonly size: number;
  readonly chunks: ReadonlyMap<string, Chunk>;
  /** 水塘列，键是 `columnKey`。 */
  readonly pondColumns: ReadonlyMap<string, PondColumn>;
  readonly ponds: readonly GeneratedPond[];
}

const chunkKeyOf = ({ cx, cz }: ChunkCoord): string => `${cx},${cz}`;

/** 第一列平原内部的列所在的区块。 */
function plainsCenter(terrain: Terrain): ChunkCoord {
  for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
    if (terrain.biomeAt(column.x, column.z) !== Biome.Plains) continue;
    if (isInterior(terrain, column, INTERIOR_REACH)) return { cx: chunkOf(column.x), cz: chunkOf(column.z) };
  }
  throw new Error(`种子 ${terrain.seed} 找不到平原内部的列`);
}

/** 以 center 为中心、边长 n 的区块方阵（cx、cz 从 center + from 起）。 */
function chunkSquare(center: ChunkCoord, n: number, from: number): ChunkCoord[] {
  const coords: ChunkCoord[] = [];
  for (let dz = 0; dz < n; dz++) {
    for (let dx = 0; dx < n; dx++) coords.push({ cx: center.cx + from + dx, cz: center.cz + from + dz });
  }
  return coords;
}

/** 一个区块方阵的列范围。 */
function columnsOfSquare(center: ChunkCoord, n: number, from: number): { x0: number; z0: number; size: number } {
  return { x0: (center.cx + from) * CHUNK_SIZE, z0: (center.cz + from) * CHUNK_SIZE, size: n * CHUNK_SIZE };
}

/** 区域里每一列的地表高度查询，按 z、x 顺序做 FNV-1a，写成十六进制。 */
function heightFingerprint(terrain: Terrain, x0: number, z0: number, size: number): string {
  let h = 0x811c_9dc5;
  for (let z = z0; z < z0 + size; z++) {
    for (let x = x0; x < x0 + size; x++) {
      const y = terrain.surfaceHeightAt(x, z);
      h = Math.imul(h ^ (y & 0xff), 0x0100_0193);
      h = Math.imul(h ^ ((y >> 8) & 0xff), 0x0100_0193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const surveys = new Map<number, Survey>();
function surveyOf(seed: number): Survey {
  const cached = surveys.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);
  const center = plainsCenter(terrain);
  const coords = chunkSquare(center, REGION_CHUNKS, REGION_FROM);
  const { x0, z0, size } = columnsOfSquare(center, REGION_CHUNKS, REGION_FROM);
  const chunks = new Map<string, Chunk>();
  for (const coord of coords) chunks.set(chunkKeyOf(coord), terrain.generateChunk(coord.cx, coord.cz));

  const pondColumns = new Map<string, PondColumn>();
  for (const coord of coords) {
    const chunk = chunks.get(chunkKeyOf(coord))!;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = coord.cx * CHUNK_SIZE + lx;
        const z = coord.cz * CHUNK_SIZE + lz;
        const surface = terrain.surfaceHeightAt(x, z);
        if (chunk.get(lx, surface, lz) !== BlockType.Water) continue;
        let waterTop = surface;
        while (waterTop < WORLD_MAX_Y && chunk.get(lx, waterTop + 1, lz) === BlockType.Water) waterTop++;
        pondColumns.set(columnKey({ x, z }), { x, z, waterTop, floor: highestTerrainY(chunk, lx, lz) });
      }
    }
  }

  const ponds: GeneratedPond[] = [];
  const seen = new Set<string>();
  const onBorder = ({ x, z }: ColumnCoord): boolean =>
    x === x0 || z === z0 || x === x0 + size - 1 || z === z0 + size - 1;
  for (const [key, start] of pondColumns) {
    if (seen.has(key)) continue;
    seen.add(key);
    const columns: PondColumn[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const column = queue.pop()!;
      columns.push(column);
      for (const [dx, dz] of NEIGHBORS) {
        const next = columnKey({ x: column.x + dx, z: column.z + dz });
        const found = pondColumns.get(next);
        if (!found || seen.has(next)) continue;
        seen.add(next);
        queue.push(found);
      }
    }
    ponds.push({ columns, truncated: columns.some(onBorder) });
  }
  const survey: Survey = { terrain, coords, x0, z0, size, chunks, pondColumns, ponds };
  surveys.set(seed, survey);
  return survey;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 区域里世界坐标那一格的方块；区域外返回 undefined。 */
function blockIn(survey: Survey, x: number, y: number, z: number): BlockType | undefined {
  const chunk = survey.chunks.get(chunkKeyOf({ cx: chunkOf(x), cz: chunkOf(z) }));
  return chunk?.get(localOf(x), y, localOf(z));
}

/** 完整的水塘（没有碰到区域最外一圈）。 */
function completePonds(survey: Survey): GeneratedPond[] {
  return survey.ponds.filter((pond) => !pond.truncated);
}

/** 水塘列所在的区块数。 */
function chunksOfPond(pond: GeneratedPond): number {
  return new Set(pond.columns.map(({ x, z }) => `${chunkOf(x)},${chunkOf(z)}`)).size;
}

/** 水塘列沿 x、沿 z 的跨度取较大的那个。 */
function diameterOf(columns: readonly ColumnCoord[]): number {
  const xs = columns.map((c) => c.x);
  const zs = columns.map((c) => c.z);
  return Math.max(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...zs) - Math.min(...zs) + 1);
}

function describePond(pond: GeneratedPond): string {
  const { x, z } = pond.columns[0]!;
  return `水塘（含 ${x}, ${z}，${pond.columns.length} 列）`;
}

/** 三个种子的完整水塘。 */
function allCompletePonds(): Array<{ seed: number; pond: GeneratedPond }> {
  return SURVEY_SEEDS.flatMap((seed) => completePonds(surveyOf(seed)).map((pond) => ({ seed, pond })));
}

/** 至少要有几个完整水塘才谈得上形状统计。 */
const MIN_COMPLETE_PONDS = 6;

function expectEnoughPonds(): Array<{ seed: number; pond: GeneratedPond }> {
  const all = allCompletePonds();
  const report = SURVEY_SEEDS.map((seed) => `种子 ${seed}：${completePonds(surveyOf(seed)).length}`).join('；');
  expect(all.length, `三个种子 8×8 个平原区块里的完整水塘（${report}）`).toBeGreaterThanOrEqual(MIN_COMPLETE_PONDS);
  return all;
}

/** 平地的放置输入：地表处处同高，群系由调用方给。 */
function flatPlacement(seed: number, biomeAt: (x: number, z: number) => Biome, surfaceY: number, spawn: ColumnCoord): PondPlacement {
  return { seed, spawnColumn: spawn, biomeAt, surfaceHeightAt: () => surfaceY, isSolidSpan: solidUpToSurface(() => surfaceY) };
}

/** 一片区块里 pondsTouching 给出的水塘，按 pondKey 去重。 */
function pondsIn(placement: PondPlacement, coords: Iterable<ChunkCoord>): Pond[] {
  const found = new Map<string, Pond>();
  for (const { cx, cz } of coords) {
    for (const pond of pondsTouching(placement, cx, cz)) found.set(pondKey(pond), pond);
  }
  return [...found.values()];
}

/** 远离原点的出生列：原点附近的平地照常有水塘。 */
const FAR_SPAWN: ColumnCoord = { x: -100_000, z: -100_000 };

/** 平地上测试用的区块：原点周围 12×12 个。 */
const FLAT_CHUNKS = chunkSquare({ cx: 0, cz: 0 }, 12, -6);

const chebyshev = (a: ColumnCoord, b: ColumnCoord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

describe('水塘的形状（#81）', () => {
  it('三个种子的平原里都有水塘，至少一个的水面高于海平面', () => {
    const all = expectEnoughPonds();
    for (const seed of SURVEY_SEEDS) {
      expect(surveyOf(seed).ponds.length, `种子 ${seed} 的水塘`).toBeGreaterThan(0);
    }
    const above = all.filter(({ pond }) => pond.columns[0]!.waterTop > SEA_LEVEL);
    expect(above.length, '水面高于海平面的水塘').toBeGreaterThan(0);
  });

  it(`水面是平的：同一个水塘各列最上面那格水在同一层；直径（水面那层连通水格的较大跨度）在 ${DIAMETER_MIN} 到 ${DIAMETER_MAX}`, () => {
    const wrong: string[] = [];
    for (const { seed, pond } of expectEnoughPonds()) {
      const tops = new Set(pond.columns.map((c) => c.waterTop));
      if (tops.size !== 1) wrong.push(`种子 ${seed} ${describePond(pond)} 水面高度有 ${[...tops].join('、')}`);
      const diameter = diameterOf(pond.columns);
      if (diameter < DIAMETER_MIN || diameter > DIAMETER_MAX) wrong.push(`种子 ${seed} ${describePond(pond)} 直径 ${diameter}`);
    }
    expect(wrong).toEqual([]);
  });

  it(`深度：每列水面到塘底 1 到 ${DEPTH_MAX} 格，每个水塘最深的一列 ${DEEPEST_MIN} 到 ${DEPTH_MAX} 格`, () => {
    const wrong: string[] = [];
    for (const { seed, pond } of expectEnoughPonds()) {
      const depths = pond.columns.map((c) => c.waterTop - c.floor);
      const shallow = pond.columns.filter((c) => c.waterTop - c.floor < 1 || c.waterTop - c.floor > DEPTH_MAX);
      for (const c of shallow) wrong.push(`种子 ${seed} (${c.x}, ${c.z}) 深 ${c.waterTop - c.floor}`);
      const deepest = Math.max(...depths);
      if (deepest < DEEPEST_MIN || deepest > DEPTH_MAX) wrong.push(`种子 ${seed} ${describePond(pond)} 最深 ${deepest}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('塘底是沙子，塘底之上到水面全是水，水面之上没有水', () => {
    const wrong: string[] = [];
    for (const { seed, pond } of expectEnoughPonds()) {
      const survey = surveyOf(seed);
      for (const { x, z, floor, waterTop } of pond.columns) {
        const bottom = blockIn(survey, x, floor, z);
        if (bottom !== BlockType.Sand) wrong.push(`种子 ${seed} (${x}, ${floor}, ${z}) 塘底是 ${bottom}`);
        for (let y = floor + 1; y <= waterTop; y++) {
          const block = blockIn(survey, x, y, z);
          if (block !== BlockType.Water) wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 在水里却是 ${block}`);
        }
        for (let y = waterTop + 1; y <= WORLD_MAX_Y; y++) {
          if (blockIn(survey, x, y, z) === BlockType.Water) wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 水面之上有水`);
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('边缘不缺口：水塘里每一格水的东南西北四邻是水或地形方块，没有空气', () => {
    const wrong: string[] = [];
    for (const { seed, pond } of expectEnoughPonds()) {
      const survey = surveyOf(seed);
      for (const { x, z, floor, waterTop } of pond.columns) {
        for (let y = floor + 1; y <= waterTop; y++) {
          for (const [dx, dz] of NEIGHBORS) {
            const block = blockIn(survey, x + dx, y, z + dz)!;
            if (block !== BlockType.Water && !isTerrainBlock(block)) {
              wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 旁边 (${x + dx}, ${y}, ${z + dz}) 是 ${block}`);
            }
          }
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('边缘不缺口（高山，含悬垂）：三个种子雪线以下的高山内部各 12×12 个区块，pondsTouching 给出的每个水塘里每一格水的四邻是水或地形方块', () => {
    const wrong: string[] = [];
    let ponds = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      let center: ChunkCoord | undefined;
      for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
        if (terrain.biomeAt(column.x, column.z) !== Biome.Mountains) continue;
        if (terrain.surfaceHeightAt(column.x, column.z) >= SNOW_LINE_Y - 30 || !isInterior(terrain, column, 32)) continue;
        center = { cx: chunkOf(column.x), cz: chunkOf(column.z) };
        break;
      }
      expect(center, `种子 ${seed} 找不到雪线以下的高山`).toBeDefined();
      const chunks = new Map<string, Chunk>();
      const blockAt = (x: number, y: number, z: number): BlockType => {
        const coord = { cx: chunkOf(x), cz: chunkOf(z) };
        let chunk = chunks.get(chunkKeyOf(coord));
        if (!chunk) {
          chunk = terrain.generateChunk(coord.cx, coord.cz);
          chunks.set(chunkKeyOf(coord), chunk);
        }
        return chunk.get(localOf(x), y, localOf(z));
      };
      for (const pond of pondsIn(terrain, chunkSquare(center!, 12, -6))) {
        ponds++;
        for (const { x, z } of pond.columns) {
          for (let y = pond.waterY; blockAt(x, y, z) === BlockType.Water; y--) {
            for (const [dx, dz] of NEIGHBORS) {
              const block = blockAt(x + dx, y, z + dz);
              if (block !== BlockType.Water && !isTerrainBlock(block)) wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 旁边是 ${block}`);
            }
          }
        }
      }
    }
    expect(ponds, '高山里的水塘').toBeGreaterThan(5);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('盆地边缘保持原样：紧挨水塘、本身不是水塘列的列，最高的地形方块仍在地表高度，不低于水面，列顶地表方块与查询一致', () => {
    const wrong: string[] = [];
    let rims = 0;
    for (const { seed, pond } of expectEnoughPonds()) {
      const survey = surveyOf(seed);
      const { terrain } = survey;
      const waterY = pond.columns[0]!.waterTop;
      const rim = new Map<string, ColumnCoord>();
      for (const { x, z } of pond.columns) {
        for (const [dx, dz] of NEIGHBORS) {
          const next = { x: x + dx, z: z + dz };
          if (!survey.pondColumns.has(columnKey(next))) rim.set(columnKey(next), next);
        }
      }
      for (const { x, z } of rim.values()) {
        rims++;
        const chunk = survey.chunks.get(chunkKeyOf({ cx: chunkOf(x), cz: chunkOf(z) }))!;
        const surface = terrain.surfaceHeightAt(x, z);
        const highest = highestTerrainY(chunk, localOf(x), localOf(z));
        if (highest !== surface) wrong.push(`种子 ${seed} (${x}, ${z}) 最高的地形方块 ${highest}，地表高度 ${surface}`);
        if (surface < waterY) wrong.push(`种子 ${seed} (${x}, ${z}) 地表 ${surface} 低于水面 ${waterY}`);
        const top = chunk.get(localOf(x), surface, localOf(z));
        if (top !== terrain.surfaceBlockAt(x, z)) wrong.push(`种子 ${seed} (${x}, ${z}) 生成 ${top}，查询 ${terrain.surfaceBlockAt(x, z)}`);
      }
    }
    expect(rims).toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('水塘列上方没有原木与地表植物', () => {
    const wrong: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      for (const { x, z, waterTop } of survey.pondColumns.values()) {
        for (let y = waterTop + 1; y <= WORLD_MAX_Y; y++) {
          const block = blockIn(survey, x, y, z)!;
          if (LOGS.has(block) || isPlantBlock(block)) wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 是 ${block}`);
        }
      }
    }
    expectEnoughPonds();
    expect(wrong).toEqual([]);
  });
});

describe('水塘的位置由种子决定，生成结果就是 pondsTouching 给出的水塘', () => {
  it('每个区块里的水塘列正好是 pondsTouching 给出的水塘落在这个区块里的列，水面那一层一致；中心列是水塘列', () => {
    const wrong: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      for (const coord of survey.coords) {
        const expected = new Map<string, number>();
        for (const pond of pondsTouching(survey.terrain, coord.cx, coord.cz)) {
          if (!pond.columns.some((c) => c.x === pond.x && c.z === pond.z)) wrong.push(`种子 ${seed} ${pondKey(pond)} 中心列不是水塘列`);
          for (const column of pond.columns) {
            if (chunkOf(column.x) === coord.cx && chunkOf(column.z) === coord.cz) expected.set(columnKey(column), pond.waterY);
          }
        }
        const actual = new Map<string, number>();
        for (const column of survey.pondColumns.values()) {
          if (chunkOf(column.x) === coord.cx && chunkOf(column.z) === coord.cz) actual.set(columnKey(column), column.waterTop);
        }
        const keys = new Set([...expected.keys(), ...actual.keys()]);
        for (const key of keys) {
          if (expected.get(key) !== actual.get(key)) {
            wrong.push(`种子 ${seed} 区块 (${coord.cx}, ${coord.cz}) 列 ${key}：pondsTouching ${expected.get(key)}，生成 ${actual.get(key)}`);
          }
        }
      }
    }
    expectEnoughPonds();
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('两个独立构造的地形对象给出同样的水塘', () => {
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      const a = pondsIn(createTerrain(seed), survey.coords).map(pondKey).sort();
      const b = pondsIn(createTerrain(seed), survey.coords).map(pondKey).sort();
      expect(a.length, `种子 ${seed}`).toBeGreaterThan(0);
      expect(a).toEqual(b);
    }
  });

  it(`数量：平原里约每 ${CHUNKS_PER_POND} 个区块一个（三个种子各 ${COUNT_CHUNKS}×${COUNT_CHUNKS} 个平原区块合计，容差 ${COUNT_TOLERANCE} 倍）`, () => {
    let ponds = 0;
    let chunks = 0;
    const report: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      const square = chunkSquare(plainsCenter(terrain), COUNT_CHUNKS, -COUNT_CHUNKS / 2);
      const plainsChunks = square.filter(({ cx, cz }) => terrain.biomeAt(cx * CHUNK_SIZE + 8, cz * CHUNK_SIZE + 8) === Biome.Plains);
      const inSquare = new Set(plainsChunks.map(chunkKeyOf));
      // 按中心列所在的区块计数：每个水塘只算一次
      const centers = pondsIn(terrain, plainsChunks).filter((pond) => inSquare.has(chunkKeyOf({ cx: chunkOf(pond.x), cz: chunkOf(pond.z) })));
      ponds += centers.length;
      chunks += plainsChunks.length;
      report.push(`种子 ${seed}：${centers.length} 个 / ${plainsChunks.length} 区块`);
    }
    const per8 = (ponds / chunks) * CHUNKS_PER_POND;
    expect(chunks, report.join('；')).toBeGreaterThan(COUNT_CHUNKS * COUNT_CHUNKS);
    expect(per8, `每 ${CHUNKS_PER_POND} 个区块 ${per8.toFixed(2)} 个（${report.join('；')}）`).toBeGreaterThanOrEqual(1 / COUNT_TOLERANCE);
    expect(per8, `每 ${CHUNKS_PER_POND} 个区块 ${per8.toFixed(2)} 个（${report.join('；')}）`).toBeLessThanOrEqual(COUNT_TOLERANCE);
  });

  it(`pondsTouching 给出的每个水塘（三个种子各 ${COUNT_CHUNKS}×${COUNT_CHUNKS} 个平原区块）：水塘列 4 邻接连成一片、含中心列，直径 ${DIAMETER_MIN} 到 ${DIAMETER_MAX}，水面高于海平面的占多数`, () => {
    const wrong: string[] = [];
    let total = 0;
    let above = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const pond of pondsIn(terrain, chunkSquare(plainsCenter(terrain), COUNT_CHUNKS, -COUNT_CHUNKS / 2))) {
        total++;
        if (pond.waterY > SEA_LEVEL) above++;
        const keys = new Set(pond.columns.map(columnKey));
        const start = columnKey(pond);
        if (!keys.has(start)) wrong.push(`种子 ${seed} ${pondKey(pond)} 不含中心列`);
        const reached = new Set([start]);
        const queue = [{ x: pond.x, z: pond.z }];
        while (queue.length > 0) {
          const { x, z } = queue.pop()!;
          for (const [dx, dz] of NEIGHBORS) {
            const next = columnKey({ x: x + dx, z: z + dz });
            if (keys.has(next) && !reached.has(next)) {
              reached.add(next);
              queue.push({ x: x + dx, z: z + dz });
            }
          }
        }
        if (reached.size !== keys.size) wrong.push(`种子 ${seed} ${pondKey(pond)} 不连成一片`);
        const diameter = diameterOf(pond.columns);
        if (diameter < DIAMETER_MIN || diameter > DIAMETER_MAX) wrong.push(`种子 ${seed} ${pondKey(pond)} 直径 ${diameter}`);
      }
    }
    expect(total, '水塘数').toBeGreaterThan(30);
    expect(above * 2, `水面高于海平面的 ${above}/${total}`).toBeGreaterThan(total);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('换种子水塘就在别处', () => {
    const a = pondsIn(flatPlacement(1, () => Biome.Plains, 80, FAR_SPAWN), FLAT_CHUNKS).map(pondKey).sort();
    const b = pondsIn(flatPlacement(2, () => Biome.Plains, 80, FAR_SPAWN), FLAT_CHUNKS).map(pondKey).sort();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toEqual(b);
  });
});

describe('跨区块边界的水塘（ADR-0005）', () => {
  /** 三个种子里横跨区块边界的完整水塘。 */
  function crossingPonds(): Array<{ seed: number; pond: GeneratedPond }> {
    return allCompletePonds().filter(({ pond }) => chunksOfPond(pond) > 1);
  }

  it('有横跨区块边界的完整水塘，它们在几个区块里的部分合起来满足上面每一条（形状的断言都含这些水塘）', () => {
    const crossing = crossingPonds();
    expect(crossing.length, '横跨区块边界的完整水塘').toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const { seed, pond } of crossing) {
      const tops = new Set(pond.columns.map((c) => c.waterTop));
      if (tops.size !== 1) wrong.push(`种子 ${seed} ${describePond(pond)} 两边水面不在同一层：${[...tops].join('、')}`);
      const diameter = diameterOf(pond.columns);
      if (diameter < DIAMETER_MIN) wrong.push(`种子 ${seed} ${describePond(pond)} 合起来直径只有 ${diameter}`);
    }
    expect(wrong).toEqual([]);
  });

  it('先 A 后 B 与先 B 后 A 结果相同：横跨边界的水塘所在的几个区块，两种顺序各用一个新地形对象生成，逐字节相同', () => {
    const crossing = crossingPonds();
    expect(crossing.length).toBeGreaterThan(0);
    for (const { seed, pond } of crossing.slice(0, 6)) {
      const coords = [...new Set(pond.columns.map(({ x, z }) => `${chunkOf(x)},${chunkOf(z)}`))].map((key) => {
        const [cx, cz] = key.split(',').map(Number) as [number, number];
        return { cx, cz };
      });
      const forwards = createTerrain(seed);
      const a = coords.map(({ cx, cz }) => forwards.generateChunk(cx, cz));
      const backwards = createTerrain(seed);
      const b = [...coords].reverse().map(({ cx, cz }) => backwards.generateChunk(cx, cz)).reverse();
      for (let i = 0; i < coords.length; i++) {
        expect(Buffer.from(a[i]!.blocks).equals(Buffer.from(b[i]!.blocks)), `种子 ${seed} 区块 (${coords[i]!.cx}, ${coords[i]!.cz})`).toBe(true);
      }
    }
  });

  it('pondsTouching 只调查询、不生成区块：区块外的列也经地表高度查询，结果与直接传地形对象相同', () => {
    const crossing = crossingPonds();
    expect(crossing.length).toBeGreaterThan(0);
    let outside = 0;
    for (const { seed, pond } of crossing.slice(0, 6)) {
      const terrain = createTerrain(seed);
      const { x, z } = pond.columns[0]!;
      const cx = chunkOf(x);
      const cz = chunkOf(z);
      const asked: ColumnCoord[] = [];
      const counting = {
        ...terrain,
        surfaceHeightAt: (qx: number, qz: number) => {
          asked.push({ x: qx, z: qz });
          return terrain.surfaceHeightAt(qx, qz);
        },
        generateChunk: () => {
          throw new Error('pondsTouching 不该生成区块');
        },
      };
      const viaQueries = pondsTouching(counting, cx, cz).map(pondKey).sort();
      expect(viaQueries).toEqual(pondsTouching(createTerrain(seed), cx, cz).map(pondKey).sort());
      outside += asked.filter((c) => chunkOf(c.x) !== cx || chunkOf(c.z) !== cz).length;
    }
    expect(outside, '问到的区块外的列').toBeGreaterThan(0);
  });
});

describe('列顶地表方块查询在水塘里给出水，地表高度不随水塘变', () => {
  it('区域里每一列：列顶地表方块查询是水当且仅当生成结果里地表高度那一格是水；区块边缘的水塘列也一致', () => {
    const wrong: string[] = [];
    let edgePondColumns = 0;
    let pondColumns = 0;
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      const { terrain, x0, z0, size } = survey;
      for (let x = x0; x < x0 + size; x++) {
        for (let z = z0; z < z0 + size; z++) {
          const generated = survey.pondColumns.has(columnKey({ x, z }));
          const queried = terrain.surfaceBlockAt(x, z) === BlockType.Water;
          if (generated) pondColumns++;
          const lx = localOf(x);
          const lz = localOf(z);
          if (generated && (lx === 0 || lz === 0 || lx === CHUNK_SIZE - 1 || lz === CHUNK_SIZE - 1)) edgePondColumns++;
          if (generated !== queried) wrong.push(`种子 ${seed} (${x}, ${z})：生成${generated ? '' : '不'}是水，查询${queried ? '' : '不'}是水`);
        }
      }
    }
    expect(pondColumns, '水塘列').toBeGreaterThan(0);
    expect(edgePondColumns, '区块边缘的水塘列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('地表高度查询仍是挖水塘之前的值：区域里每一列与 main 上的指纹相同；水塘列的地表高度不低于塘底、不高于水面', () => {
    const wrong: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      const { terrain, x0, z0, size } = survey;
      expect(heightFingerprint(terrain, x0, z0, size), `种子 ${seed}`).toBe(PRE_POND_FINGERPRINTS[seed]);
      for (const { x, z, floor, waterTop } of survey.pondColumns.values()) {
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface < floor || surface > waterTop) wrong.push(`种子 ${seed} (${x}, ${z}) 地表 ${surface}，塘底 ${floor}，水面 ${waterTop}`);
      }
    }
    expectEnoughPonds();
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('有地表高度高于塘底的水塘列：挖下去的那几格地表高度查询照旧，不是塘底', () => {
    let dug = 0;
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      for (const { x, z, floor } of survey.pondColumns.values()) {
        if (survey.terrain.surfaceHeightAt(x, z) > floor) dug++;
      }
    }
    expect(dug).toBeGreaterThan(0);
  });

  it('树不长在水塘里：treesTouching 给出的树根不在水塘列上；区域里每一格原木与树叶都属于 treesTouching 给出的某棵树', () => {
    const wrong: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const survey = surveyOf(seed);
      for (const coord of survey.coords) {
        const chunk = survey.chunks.get(chunkKeyOf(coord))!;
        const cells = new Set<string>();
        for (const tree of treesTouching(survey.terrain, coord.cx, coord.cz)) {
          if (survey.pondColumns.has(columnKey(tree)) || survey.terrain.surfaceBlockAt(tree.x, tree.z) === BlockType.Water) {
            wrong.push(`种子 ${seed} 树根 (${tree.x}, ${tree.z}) 在水塘里`);
          }
          for (const cell of worldCells(tree).keys()) cells.add(cell);
        }
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const x = coord.cx * CHUNK_SIZE + lx;
            const z = coord.cz * CHUNK_SIZE + lz;
            for (let y = SEA_LEVEL; y <= WORLD_MAX_Y; y++) {
              const block = chunk.get(lx, y, lz);
              if ((LOGS.has(block) || LEAVES.has(block)) && !cells.has(`${x},${y},${z}`)) {
                wrong.push(`种子 ${seed} (${x}, ${y}, ${z}) 的 ${block} 不属于 treesTouching 给出的树`);
              }
            }
          }
        }
      }
    }
    expectEnoughPonds();
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('区块内外对水塘列给同一结论：水塘里本来会长的树', () => {
  /** 每个种子找水塘的范围（区块），以平原中心区块为中心。 */
  const SEARCH_CHUNKS = 48;
  /** 要找到几棵树冠伸出树根所在区块的。 */
  const WANTED = 6;

  /**
   * 「水塘里本来会长的树」：把列顶地表方块的水当成草方块时 treesTouching 给出的、树根在水塘列上的树。
   * 树冠伸进相邻区块时，相邻区块判断树根那一列要调查询（区块外的列），树根所在区块读自己铺好的顶层；
   * 两边都得认定那里是水塘、不长这棵树。
   */
  function wouldBeTrees(): Array<{ seed: number; tree: ReturnType<typeof treesTouching>[number]; chunks: ChunkCoord[] }> {
    const found: Array<{ seed: number; tree: ReturnType<typeof treesTouching>[number]; chunks: ChunkCoord[] }> = [];
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      const asGrass = {
        ...terrain,
        surfaceBlockAt: (x: number, z: number) => {
          const block = terrain.surfaceBlockAt(x, z);
          return block === BlockType.Water ? BlockType.Grass : block;
        },
      };
      const square = chunkSquare(plainsCenter(terrain), SEARCH_CHUNKS, -SEARCH_CHUNKS / 2);
      const pondColumns = new Set(pondsIn(terrain, square).flatMap((pond) => pond.columns.map(columnKey)));
      const pondChunks = new Set([...pondColumns].map((key) => {
        const [x, z] = key.split(',').map(Number) as [number, number];
        return chunkKeyOf({ cx: chunkOf(x), cz: chunkOf(z) });
      }));
      const seen = new Set<string>();
      for (const key of pondChunks) {
        const [cx, cz] = key.split(',').map(Number) as [number, number];
        for (const tree of treesTouching(asGrass, cx, cz)) {
          const treeId = `${tree.x},${tree.z}`;
          if (seen.has(treeId) || !pondColumns.has(columnKey(tree))) continue;
          seen.add(treeId);
          const chunks = new Map<string, ChunkCoord>();
          for (const cell of worldCells(tree).keys()) {
            const [x, , z] = cell.split(',').map(Number) as [number, number, number];
            chunks.set(chunkKeyOf({ cx: chunkOf(x), cz: chunkOf(z) }), { cx: chunkOf(x), cz: chunkOf(z) });
          }
          if (chunks.size > 1) found.push({ seed, tree, chunks: [...chunks.values()] });
        }
      }
    }
    return found;
  }

  it(`树冠本会伸出树根所在区块的那些树，在它伸进的每个区块里都不出现：原木与树叶都属于 treesTouching 给出的树（至少 ${WANTED} 棵）`, () => {
    const found = wouldBeTrees();
    expect(found.length, '水塘里本来会长、树冠伸出区块的树').toBeGreaterThanOrEqual(WANTED);
    const wrong: string[] = [];
    for (const { seed, tree, chunks } of found) {
      const terrain = createTerrain(seed);
      const canopy = worldCells(tree);
      for (const coord of chunks) {
        const chunk = terrain.generateChunk(coord.cx, coord.cz);
        const real = new Set<string>();
        for (const other of treesTouching(terrain, coord.cx, coord.cz)) for (const cell of worldCells(other).keys()) real.add(cell);
        for (const cell of canopy.keys()) {
          const [x, y, z] = cell.split(',').map(Number) as [number, number, number];
          if (chunkOf(x) !== coord.cx || chunkOf(z) !== coord.cz || real.has(cell)) continue;
          const block = chunk.get(localOf(x), y, localOf(z));
          if (LOGS.has(block) || LEAVES.has(block)) wrong.push(`种子 ${seed} 树根 (${tree.x}, ${tree.z}) 的 (${cell}) 在区块 (${coord.cx}, ${coord.cz}) 里是 ${block}`);
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('大海、冰雪、高山雪线以上没有水塘', () => {
  it('平地上：处处平原或雪线以下的高山时有水塘，处处冰雪、大海或雪线以上的高山时一个都没有', () => {
    const count = (biome: Biome, surfaceY: number): number =>
      pondsIn(flatPlacement(314_159, () => biome, surfaceY, FAR_SPAWN), FLAT_CHUNKS).length;
    expect(count(Biome.Plains, 80), '平原').toBeGreaterThan(0);
    expect(count(Biome.Mountains, 120), '雪线以下的高山').toBeGreaterThan(0);
    expect(count(Biome.Snowy, 80), '冰雪').toBe(0);
    expect(count(Biome.Ocean, 80), '大海').toBe(0);
    expect(count(Biome.Mountains, SNOW_LINE_Y + 10), '雪线以上的高山').toBe(0);
  });

  it('平地上平原与冰雪（或大海）沿 x 每 12 格交替成条：没有哪一列水塘列落在冰雪或大海里，平原那几条照常有水塘', () => {
    // 条带比水塘的直径上限略宽，水塘的中心落在平原条里时常常伸进旁边那一条：只看中心列的群系是不够的
    const STRIPE = 12;
    const isPlainsStripe = (x: number): boolean => Math.floor(x / STRIPE) % 2 === 0;
    for (const other of [Biome.Snowy, Biome.Ocean]) {
      const biomeAt = (x: number): Biome => (isPlainsStripe(x) ? Biome.Plains : other);
      const ponds = pondsIn(flatPlacement(777, biomeAt, 80, FAR_SPAWN), FLAT_CHUNKS);
      expect(ponds.length, `平原与${other}`).toBeGreaterThan(0);
      const wrong = ponds.flatMap((pond) => pond.columns.filter((c) => !isPlainsStripe(c.x)).map((c) => `${other} (${c.x}, ${c.z})`));
      expect(wrong).toEqual([]);
    }
  });

  it('真实地形：生成结果里的水塘列都不在大海与冰雪里，在高山里的地表低于雪线', () => {
    const wrong: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const { terrain, pondColumns } = surveyOf(seed);
      for (const { x, z } of pondColumns.values()) {
        const biome = terrain.biomeAt(x, z);
        if (biome === Biome.Ocean || biome === Biome.Snowy) wrong.push(`种子 ${seed} (${x}, ${z}) 在 ${biome}`);
        if (biome === Biome.Mountains && terrain.surfaceHeightAt(x, z) >= SNOW_LINE_Y) wrong.push(`种子 ${seed} (${x}, ${z}) 在雪线以上`);
      }
    }
    expectEnoughPonds();
    expect(wrong).toEqual([]);
  });

  it('真实地形：冰雪、大海与雪线以上的高山内部各 8×8 个区块，pondsTouching 给出的水塘没有一列落在冰雪、大海或雪线以上', () => {
    const report: string[] = [];
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      const centers = new Map<string, ChunkCoord>();
      for (const column of gridColumns(FIND_HALF, FIND_STEP)) {
        const biome = terrain.biomeAt(column.x, column.z);
        const kind = biome === Biome.Mountains ? (terrain.surfaceHeightAt(column.x, column.z) >= SNOW_LINE_Y + 20 ? 'high' : '') : biome;
        if (kind === '' || kind === Biome.Plains || centers.has(kind)) continue;
        if (!isInterior(terrain, column, biome === Biome.Mountains ? 8 : INTERIOR_REACH)) continue;
        centers.set(kind, { cx: chunkOf(column.x), cz: chunkOf(column.z) });
      }
      for (const kind of [Biome.Snowy, Biome.Ocean, 'high']) {
        const center = centers.get(kind);
        expect(center, `种子 ${seed} 找不到 ${kind} 的列`).toBeDefined();
        const coords = chunkSquare(center!, REGION_CHUNKS, REGION_FROM);
        // 高山只看雪线以上的区块：区块中心那一列的地表在雪线以上 8 格
        const picked =
          kind === 'high'
            ? coords.filter(({ cx, cz }) => terrain.surfaceHeightAt(cx * CHUNK_SIZE + 8, cz * CHUNK_SIZE + 8) >= SNOW_LINE_Y + 8)
            : coords;
        const ponds = pondsIn(terrain, picked).filter((pond) =>
          pond.columns.some(({ x, z }) => {
            const biome = terrain.biomeAt(x, z);
            return biome === Biome.Ocean || biome === Biome.Snowy || terrain.surfaceHeightAt(x, z) >= SNOW_LINE_Y;
          }),
        );
        report.push(`种子 ${seed} ${kind}：${picked.length} 区块`);
        expect(ponds.map(pondKey), `种子 ${seed} ${kind}`).toEqual([]);
      }
    }
    expect(report.length).toBe(SURVEY_SEEDS.length * 3);
  });
});

describe('出生列周围 7 格内没有水塘', () => {
  /** 出生列周围 7 格内的水塘列。 */
  function pondColumnsNear(ponds: readonly Pond[], spawn: ColumnCoord): string[] {
    return ponds.flatMap((pond) => pond.columns.filter((c) => chebyshev(c, spawn) <= SPAWN_CLEARANCE).map(columnKey));
  }

  /** 出生列周围 7 格（及外面一圈水塘伸得到的距离）覆盖到的区块。 */
  function chunksNear(spawn: ColumnCoord): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    const reach = SPAWN_CLEARANCE + DIAMETER_MAX;
    for (let cx = chunkOf(spawn.x - reach); cx <= chunkOf(spawn.x + reach); cx++) {
      for (let cz = chunkOf(spawn.z - reach); cz <= chunkOf(spawn.z + reach); cz++) coords.push({ cx, cz });
    }
    return coords;
  }

  it('平地上把出生列移到某个水塘的中心列：那个水塘不再出现，出生列周围 7 格内没有水塘列', () => {
    const far = pondsIn(flatPlacement(314_159, () => Biome.Plains, 80, FAR_SPAWN), FLAT_CHUNKS);
    expect(far.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const pond of far.slice(0, 8)) {
      const spawn = { x: pond.x, z: pond.z };
      const near = pondsIn(flatPlacement(314_159, () => Biome.Plains, 80, spawn), chunksNear(spawn));
      for (const key of pondColumnsNear(near, spawn)) wrong.push(`出生列 (${spawn.x}, ${spawn.z}) 旁的水塘列 ${key}`);
    }
    expect(wrong).toEqual([]);
  });

  it('真实地形上把出生列移到某个水塘的中心列：出生列周围 7 格内没有水塘列', () => {
    const wrong: string[] = [];
    let moved = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      for (const pond of pondsIn(terrain, surveyOf(seed).coords).slice(0, 3)) {
        moved++;
        const spawn = { x: pond.x, z: pond.z };
        const near = pondsIn({ ...createTerrain(seed), spawnColumn: spawn }, chunksNear(spawn));
        for (const key of pondColumnsNear(near, spawn)) wrong.push(`种子 ${seed} 出生列 (${spawn.x}, ${spawn.z}) 旁的水塘列 ${key}`);
      }
    }
    expect(moved).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it('避让只到 7 格附近：平地上出生列移到水塘中心后，8 到 24 格（切比雪夫距离）之间仍有水塘列', () => {
    const far = pondsIn(flatPlacement(314_159, () => Biome.Plains, 80, FAR_SPAWN), FLAT_CHUNKS);
    let ringColumns = 0;
    for (const pond of far.slice(0, 8)) {
      const spawn = { x: pond.x, z: pond.z };
      const near = pondsIn(flatPlacement(314_159, () => Biome.Plains, 80, spawn), chunksNear({ x: spawn.x, z: spawn.z }));
      ringColumns += near.flatMap((p) => p.columns).filter((c) => chebyshev(c, spawn) > SPAWN_CLEARANCE && chebyshev(c, spawn) <= 24).length;
    }
    expect(ringColumns).toBeGreaterThan(0);
  });

  it.each([...SURVEY_SEEDS, DEFAULT_SEED])('种子 %i：出生列周围 7 格内列顶地表方块查询都不是水，生成结果里也没有水塘列', (seed) => {
    const terrain = createTerrain(seed);
    const spawn = terrain.spawnColumn;
    const wrong: string[] = [];
    const chunks = new Map<string, Chunk>();
    for (let x = spawn.x - SPAWN_CLEARANCE; x <= spawn.x + SPAWN_CLEARANCE; x++) {
      for (let z = spawn.z - SPAWN_CLEARANCE; z <= spawn.z + SPAWN_CLEARANCE; z++) {
        if (terrain.surfaceBlockAt(x, z) === BlockType.Water) wrong.push(`查询 (${x}, ${z}) 是水`);
        const key = chunkKeyOf({ cx: chunkOf(x), cz: chunkOf(z) });
        let chunk = chunks.get(key);
        if (!chunk) {
          chunk = terrain.generateChunk(chunkOf(x), chunkOf(z));
          chunks.set(key, chunk);
        }
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface >= SEA_LEVEL && chunk.get(localOf(x), surface, localOf(z)) === BlockType.Water) wrong.push(`生成 (${x}, ${z}) 是水`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
