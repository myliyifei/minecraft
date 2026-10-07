import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, SEA_LEVEL } from '../../src/core/constants';
import { SNOW_LINE_Y } from '../../src/core/surface';
import { Biome, createTerrain, type Terrain } from '../../src/core/terrain';
import { treesTouching } from '../../src/core/tree';
import { chunkOf, type ChunkCoord } from '../../src/core/world';
import {
  DANDELION,
  FERN,
  POPPY,
  SHORT_GRASS,
  expectPlantsDefined,
  isPlantBlock,
} from '../helpers/plants';
import { SURVEY_SEEDS } from '../helpers/terrain-survey';
import { LOGS } from '../helpers/trees';

/**
 * 地表植物的生成（#80，父 spec #72「地表植物」、ADR-0021「在树之后放」）。
 *
 * 只经地形对象的公共查询与生成器：`createTerrain(seed)` 的 `generateChunk`、`biomeAt`、`surfaceHeightAt`、`spawnColumn`，
 * 树的位置用 `treesTouching`。
 *
 * 采样方法：三个种子（314159、777、−42），在 cx、cz ∈ [−96, 96]、步长 8 的 25×25 个区块格点上按区块中心那一列的群系挑
 * 区块，平原、高山、冰雪各取前 12 个，另用查询找至多 6 个含大海群系露出水面的草方块或雪草方块列的海岸区块
 * （`oceanGroundChunks`）；生成这些区块后逐列统计，每一列按它自己的群系归类（区块里可能混着别的群系）。出生列另取它周围
 * ±16 格覆盖到的区块。
 *
 * 合格列：地表高度那一格是草方块或雪草方块，它上面那一格现在是空气或植物（植物只放进空气里）。
 *
 * 分布阈值是测试设定（父 spec「白桦与花的比例……留到实现时定」）：平原合格列里长植物的占 5% 到 80%，花占平原植物的 1% 到 40%，
 * 两种花都出现，花成片（花那一列周围 8 列里花的比例至少是平原合格列里花的比例的 3 倍）；高山与冰雪合格列里长蕨的占 1% 以上。
 *
 * 两个未定点按 #80 的字面意思定：高山雪线以上的雪草方块照常长蕨；大海群系露出水面的列不长植物。
 */

const GROUND: ReadonlySet<BlockType> = new Set([BlockType.Grass, (BlockType as Readonly<Record<string, BlockType>>)['SnowyGrass']!]);

/** 平原长的三种植物；高山与冰雪只长蕨。 */
const PLAINS_PLANTS = (): ReadonlySet<BlockType> => new Set([SHORT_GRASS, DANDELION, POPPY]);

const GRID_HALF = 96;
const GRID_STEP = 8;
const PER_BIOME = 12;
const COAST_CHUNKS = 6;

/** 一列的统计结果。 */
interface Column {
  readonly x: number;
  readonly z: number;
  readonly biome: Biome;
  readonly surface: number;
  /** 地表高度那一格的方块。 */
  readonly ground: BlockType;
  /** 整列里所有植物格：y 与方块。 */
  readonly plants: ReadonlyArray<readonly [number, BlockType]>;
  /** 合格列：地表高度那一格是草方块或雪草方块，上面那一格是空气或植物。 */
  readonly eligible: boolean;
  /** 地表高度之上那一格的方块。 */
  readonly above: BlockType;
}

/** 一个种子的样本。 */
interface Sample {
  readonly seed: number;
  readonly terrain: Terrain;
  /** 按群系挑出的区块。 */
  readonly chunks: readonly ChunkCoord[];
  /** 这些区块里的每一列，键是「x,z」。 */
  readonly columns: ReadonlyMap<string, Column>;
}

function columnsOf(terrain: Terrain, chunk: Chunk, out: Map<string, Column>): void {
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const x = chunk.cx * CHUNK_SIZE + lx;
      const z = chunk.cz * CHUNK_SIZE + lz;
      const surface = terrain.surfaceHeightAt(x, z);
      const plants: Array<readonly [number, BlockType]> = [];
      for (let y = surface - 40; y <= surface + 40; y++) {
        const block = chunk.get(lx, y, lz);
        if (isPlantBlock(block)) plants.push([y, block]);
      }
      const ground = chunk.get(lx, surface, lz);
      const above = chunk.get(lx, surface + 1, lz);
      const eligible = GROUND.has(ground) && (above === BlockType.Air || isPlantBlock(above));
      out.set(`${x},${z}`, { x, z, biome: terrain.biomeAt(x, z), surface, ground, plants, eligible, above });
    }
  }
}

/**
 * 含有大海群系露出水面的草方块或雪草方块列的区块，至多 `COAST_CHUNKS` 个。这样的列很少（#76：大海群系里地表高于 y 67 的列），
 * 按区块中心的群系挑不出来，所以只用查询找：网格上中心是大海、东南西北某个格点不是大海的海岸格点，朝那个方向逐个区块
 * 每隔一列查群系、地表高度与列顶地表方块。
 */
function oceanGroundChunks(terrain: Terrain): ChunkCoord[] {
  const center = (c: number) => c * CHUNK_SIZE + CHUNK_SIZE / 2;
  const found = new Map<string, ChunkCoord>();
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let cz = -GRID_HALF; cz <= GRID_HALF; cz += GRID_STEP) {
    for (let cx = -GRID_HALF; cx <= GRID_HALF; cx += GRID_STEP) {
      if (terrain.biomeAt(center(cx), center(cz)) !== Biome.Ocean) continue;
      for (const [dx, dz] of directions) {
        if (terrain.biomeAt(center(cx + dx * GRID_STEP), center(cz + dz * GRID_STEP)) === Biome.Ocean) continue;
        for (let k = 0; k <= GRID_STEP; k++) {
          const coord = { cx: cx + dx * k, cz: cz + dz * k };
          if (found.has(`${coord.cx},${coord.cz}`)) continue;
          let hit = false;
          for (let lz = 0; lz < CHUNK_SIZE && !hit; lz += 2) {
            for (let lx = 0; lx < CHUNK_SIZE && !hit; lx += 2) {
              const x = coord.cx * CHUNK_SIZE + lx;
              const z = coord.cz * CHUNK_SIZE + lz;
              if (terrain.biomeAt(x, z) !== Biome.Ocean || terrain.surfaceHeightAt(x, z) <= SEA_LEVEL) continue;
              hit = GROUND.has(terrain.surfaceBlockAt(x, z));
            }
          }
          if (hit) found.set(`${coord.cx},${coord.cz}`, coord);
          if (found.size >= COAST_CHUNKS) return [...found.values()];
        }
      }
    }
  }
  return [...found.values()];
}

const samples = new Map<number, Sample>();

function sample(seed: number): Sample {
  const cached = samples.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);
  const center = (c: number) => c * CHUNK_SIZE + CHUNK_SIZE / 2;
  const biomeOfChunk = (cx: number, cz: number) => terrain.biomeAt(center(cx), center(cz));
  const picked = new Map<string, ChunkCoord>();
  const counts = new Map<string, number>();
  const take = (kind: string, limit: number, coord: ChunkCoord) => {
    const n = counts.get(kind) ?? 0;
    if (n >= limit) return;
    counts.set(kind, n + 1);
    picked.set(`${coord.cx},${coord.cz}`, coord);
  };
  for (let cz = -GRID_HALF; cz <= GRID_HALF; cz += GRID_STEP) {
    for (let cx = -GRID_HALF; cx <= GRID_HALF; cx += GRID_STEP) {
      const biome = biomeOfChunk(cx, cz);
      if (biome !== Biome.Ocean) take(biome, PER_BIOME, { cx, cz });
    }
  }
  for (const coord of oceanGroundChunks(terrain)) picked.set(`${coord.cx},${coord.cz}`, coord);
  const columns = new Map<string, Column>();
  const chunks = [...picked.values()];
  for (const { cx, cz } of chunks) columnsOf(terrain, terrain.generateChunk(cx, cz), columns);
  const result = { seed, terrain, chunks, columns };
  samples.set(seed, result);
  return result;
}

function columnsIn(seed: number, biome?: Biome): Column[] {
  return [...sample(seed).columns.values()].filter((column) => biome === undefined || column.biome === biome);
}

describe.each(SURVEY_SEEDS)('种子 %i 的地表植物', (seed) => {
  it('每一列至多一格植物，就在地表高度那一格之上；植物下面是草方块或雪草方块', () => {
    expectPlantsDefined();
    const wrong: string[] = [];
    for (const { x, z, surface, ground, plants } of columnsIn(seed)) {
      if (plants.length === 0) continue;
      if (plants.length > 1 || plants[0]![0] !== surface + 1 || !GROUND.has(ground)) {
        wrong.push(`(${x}, ${z}) 地表 ${surface}：植物在 ${plants.map(([y]) => y).join('、')}，下面是 ${ground}`);
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('平原有矮草与两种花，花占平原植物的 1% 到 40%；平原合格列里长植物的占 5% 到 80%；平原不长蕨', () => {
    expectPlantsDefined();
    const plains = columnsIn(seed, Biome.Plains).filter((column) => column.eligible);
    expect(plains.length).toBeGreaterThan(1000);
    const grown = plains.filter((column) => column.plants.length > 0);
    const kinds = (block: BlockType) => grown.filter((column) => column.plants[0]![1] === block).length;
    expect(kinds(FERN)).toBe(0);
    for (const column of grown) expect(PLAINS_PLANTS().has(column.plants[0]![1]), `(${column.x}, ${column.z})`).toBe(true);
    expect(kinds(SHORT_GRASS)).toBeGreaterThan(0);
    expect(kinds(DANDELION)).toBeGreaterThan(0);
    expect(kinds(POPPY)).toBeGreaterThan(0);
    const flowers = kinds(DANDELION) + kinds(POPPY);
    expect(flowers / grown.length).toBeGreaterThanOrEqual(0.01);
    expect(flowers / grown.length).toBeLessThanOrEqual(0.4);
    expect(grown.length / plains.length).toBeGreaterThanOrEqual(0.05);
    expect(grown.length / plains.length).toBeLessThanOrEqual(0.8);
  });

  it('花成片：花那一列周围 8 列里花的比例，至少是平原合格列里花的比例的 3 倍', () => {
    expectPlantsDefined();
    const { columns } = sample(seed);
    const isFlower = (column: Column | undefined) =>
      column !== undefined && column.plants.length > 0 && [DANDELION, POPPY].includes(column.plants[0]![1]);
    const plains = columnsIn(seed, Biome.Plains).filter((column) => column.eligible);
    const flowerColumns = plains.filter(isFlower);
    expect(flowerColumns.length).toBeGreaterThan(0);
    const overall = flowerColumns.length / plains.length;

    let neighbors = 0;
    let flowerNeighbors = 0;
    for (const { x, z } of flowerColumns) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const neighbor = columns.get(`${x + dx},${z + dz}`);
          if (!neighbor?.eligible || neighbor.biome !== Biome.Plains) continue;
          neighbors++;
          if (isFlower(neighbor)) flowerNeighbors++;
        }
      }
    }
    expect(neighbors).toBeGreaterThan(0);
    expect(flowerNeighbors / neighbors).toBeGreaterThanOrEqual(3 * overall);
  });

  it.each([
    ['高山', Biome.Mountains],
    ['冰雪', Biome.Snowy],
  ] as const)('%s只长蕨，合格列里长蕨的占 1% 以上', (_name, biome) => {
    expectPlantsDefined();
    const eligible = columnsIn(seed, biome).filter((column) => column.eligible);
    expect(eligible.length).toBeGreaterThan(200);
    const grown = eligible.filter((column) => column.plants.length > 0);
    for (const column of grown) expect(column.plants[0]![1], `(${column.x}, ${column.z})`).toBe(FERN);
    expect(grown.length / eligible.length).toBeGreaterThanOrEqual(0.01);
  });

  it('高山雪线以上的雪草方块照常长蕨（与树不同）', () => {
    expectPlantsDefined();
    // 高山雪线以上的列在一个种子里可能很少，三个种子合起来判断，见下面「三个种子合计」
    for (const column of columnsIn(seed, Biome.Mountains)) {
      if (column.surface < SNOW_LINE_Y || column.plants.length === 0) continue;
      expect(column.plants[0]![1]).toBe(FERN);
    }
  });

  it('大海群系的列不长植物，露出水面的草方块与雪草方块也不长', () => {
    expectPlantsDefined();
    // 样本里确有这样的列，否则这条断言什么都没测
    expect(columnsIn(seed, Biome.Ocean).filter((column) => column.eligible).length).toBeGreaterThan(0);
    const grown = columnsIn(seed, Biome.Ocean).filter((column) => column.plants.length > 0);
    expect(grown.map(({ x, z }) => `(${x}, ${z})`).slice(0, 10)).toEqual([]);
  });

  it('在树之后放：没有植物长在原木的格里，每棵树的树干格都还是原木', () => {
    expectPlantsDefined();
    const { terrain, chunks } = sample(seed);
    let trunks = 0;
    for (const { cx, cz } of chunks) {
      const chunk = terrain.generateChunk(cx, cz);
      for (const tree of treesTouching(terrain, cx, cz)) {
        if (chunkOf(tree.x) !== cx || chunkOf(tree.z) !== cz) continue;
        trunks++;
        for (let y = tree.rootY; y < tree.rootY + tree.trunkHeight; y++) {
          const block = chunk.get(tree.x - cx * CHUNK_SIZE, y, tree.z - cz * CHUNK_SIZE);
          expect(LOGS.has(block), `树 (${tree.x}, ${tree.z}) 的树干 y ${y} 是 ${block}`).toBe(true);
        }
      }
    }
    expect(trunks).toBeGreaterThan(10);
  });

  it('出生列周围 7 格内没有植物', () => {
    expectPlantsDefined();
    const terrain = createTerrain(seed);
    const { x: sx, z: sz } = terrain.spawnColumn;
    const near: string[] = [];
    for (let cz = chunkOf(sz - 7); cz <= chunkOf(sz + 7); cz++) {
      for (let cx = chunkOf(sx - 7); cx <= chunkOf(sx + 7); cx++) {
        const columns = new Map<string, Column>();
        columnsOf(terrain, terrain.generateChunk(cx, cz), columns);
        for (const { x, z, plants } of columns.values()) {
          if (plants.length > 0 && Math.max(Math.abs(x - sx), Math.abs(z - sz)) <= 7) near.push(`(${x}, ${z})`);
        }
      }
    }
    expect(near).toEqual([]);
  });
});

describe('三个种子合计', () => {
  it('出生列周围 8 到 16 格（切比雪夫距离）有植物：避让只到 7 格', () => {
    expectPlantsDefined();
    let found = 0;
    for (const seed of SURVEY_SEEDS) {
      const terrain = createTerrain(seed);
      const { x: sx, z: sz } = terrain.spawnColumn;
      for (let cz = chunkOf(sz - 16); cz <= chunkOf(sz + 16); cz++) {
        for (let cx = chunkOf(sx - 16); cx <= chunkOf(sx + 16); cx++) {
          const columns = new Map<string, Column>();
          columnsOf(terrain, terrain.generateChunk(cx, cz), columns);
          for (const { x, z, plants } of columns.values()) {
            const d = Math.max(Math.abs(x - sx), Math.abs(z - sz));
            if (plants.length > 0 && d >= 8 && d <= 16) found++;
          }
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('高山雪线以上的合格列里有蕨', () => {
    expectPlantsDefined();
    let eligible = 0;
    let ferns = 0;
    for (const seed of SURVEY_SEEDS) {
      for (const column of columnsIn(seed, Biome.Mountains)) {
        if (column.surface < SNOW_LINE_Y || !column.eligible) continue;
        eligible++;
        if (column.plants.length > 0) ferns++;
      }
    }
    expect(eligible).toBeGreaterThan(0);
    expect(ferns).toBeGreaterThan(0);
  });
});
