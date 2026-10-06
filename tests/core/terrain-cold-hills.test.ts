import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_SIZE, DEFAULT_SEED, SEA_LEVEL } from '../../src/core/constants';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { chunkOf, localOf } from '../../src/core/world';
import { COLD_TEMPERATURE, MOUNTAIN_RELIEF, reliefAt, temperatureAt } from '../../src/core/terrain-density';
import {
  expectedSnowyTop,
  plainsInteriorHillColumns,
  snowyHillColumns,
  type SampledColumn,
} from '../helpers/snowy-hills';
import { isPondColumn, SURVEY_SEEDS } from '../helpers/terrain-survey';

/**
 * 温度随高度下降（#87）：高处更冷，冰雪旁的山丘进入冰雪群系、铺雪草方块；平原内部不变；海平面那层结冰不变。
 *
 * 测试边界：只经地形对象的公共接口（`createTerrain(seed)` 的 `generateChunk`、`biomeAt`、`surfaceHeightAt`、
 * `surfaceBlockAt`）断言，不测温度函数本身。固定坐标的两条用例用 `terrain-density.ts` 的起伏与温度噪声核对前提
 * （这一列为什么会落在那条路径上），断言仍只看地形对象。
 *
 * 采样与阈值（main 01a0996 实测，选列条件在 tests/helpers/snowy-hills.ts）：
 * - 冰雪旁的山丘：±3072 格、步长 16 的网格上，地表 y 80 到 149、不是大海、16 格处 8 个采样点里有地表不高于 y 72 的
 *   冰雪列、比 32 格内 16 个采样点的地表中位数高出至少 5 格的列。main 上三个种子各 43、52、42 列，全是高山群系，
 *   列顶是草方块（陡坡是石头）。issue 写的「高出周围 30 格以上」在 main 上取不到样本（紧挨冰雪的列最多高出约 26 格，
 *   平原地表最高不到 y 80），所以按实测放宽到 5 格、另加地表不低于 y 80。
 * - 平原内部的小山：±3072 格、步长 32 的网格上，不是大海也不是高山、地表不高于 y 80、比四周高出至少 2 格，且 128 格内
 *   24 个采样点里没有大海、没有地表高于 y 80 的列、没有低处冰雪列的列。main 上三个种子各 60、70、72 列，全是平原、
 *   草方块，地表不超过 y 72。
 * - 实机视点 01（#82：默认种子，(−150, 150, 40) 看向 (30, 70, 150)）看到的山丘：x 0 到 140、z 120 到 220 里地表不低于
 *   y 78 的列。main 上步长 4 取 538 列，全是高山群系、草方块，地表 y 78 到 90；区块 (2..5, 9..11) 的 3072 列也是。
 *
 * 与 issue 写法的偏差：issue 说冰雪旁是「平原小山」，main 上这些山丘其实是高山群系的低处（起伏刚过高山阈值），
 * 温度多已低于寒冷阈值。群系按大海、高山、冰雪的次序判，只给温度减高度项改不了它们。「群系是冰雪」的两条（多种子一条、视点一条）按
 * 用户决定（做法 A）写：寒冷处雪线以下的高山判为冰雪。
 *
 * 四种群系都出现、一片群系的宽度约 300 到 600 格由 tests/core/terrain-biomes.test.ts 照旧断言，这里不重复。
 */

/** 网格半宽（格）与步长。 */
const SURVEY_HALF = 3072;
const HILL_STEP = 16;
const PLAINS_STEP = 32;

/** 每个种子至少要选出这么多冰雪旁的山丘，选列条件才不是空集（main 上 42 到 52 列）。 */
const MIN_HILLS = 30;

/**
 * 平原内部小山里仍是平原草方块的列数下限：main 实测的九成（三个种子各 60、70、72 列）。平原小山若被高度项变冷，
 * 它四周的平原也会变成冰雪、自己就选不进来，所以按列数断言，不只看选进来的列。留一成余量：选进来的列里温度
 * 最低约 −0.08，离寒冷阈值只差 0.02，高度项在 y 70 附近哪怕很小也会使几列改为冰雪，这几列不算「温度高于阈值较多」。
 * 选列条件不看列自身与采样点是不是平原（见 `plainsInteriorHillColumns`），所以改后多选进来的列不影响这个下限。
 */
const MAIN_PLAINS_HILLS: ReadonlyMap<number, number> = new Map([
  [314_159, 60],
  [777, 70],
  [-42, 72],
]);
const PLAINS_HILLS_SHARE = 0.9;

/** 实机视点 01 的山丘：默认种子里这一片地表不低于 VIEW_HILL_MIN_Y 的列。 */
const VIEW_HILL_BOX = { minX: 0, maxX: 140, minZ: 120, maxZ: 220, step: 4 };
const VIEW_HILL_MIN_Y = 78;
/** 这片山丘里的区块：每一列地表都不低于 y 78。 */
const VIEW_HILL_CHUNKS = { minCx: 2, maxCx: 5, minCz: 9, maxCz: 11 };

/** 每个种子的采样只做一次，几条断言共用。 */
const terrains = new Map<number, Terrain>();
function terrainOf(seed: number): Terrain {
  let terrain = terrains.get(seed);
  if (!terrain) {
    terrain = createTerrain(seed);
    terrains.set(seed, terrain);
  }
  return terrain;
}

const hillSurveys = new Map<number, SampledColumn[]>();
function hillsOf(seed: number): SampledColumn[] {
  let hills = hillSurveys.get(seed);
  if (!hills) {
    hills = snowyHillColumns(terrainOf(seed), SURVEY_HALF, HILL_STEP).filter(
      (column) => !isPondColumn(terrainOf(seed), column.x, column.z),
    );
    hillSurveys.set(seed, hills);
  }
  return hills;
}

function viewHillColumns(): ColumnCoord[] {
  const terrain = terrainOf(DEFAULT_SEED);
  const { minX, maxX, minZ, maxZ, step } = VIEW_HILL_BOX;
  const columns: ColumnCoord[] = [];
  for (let x = minX; x <= maxX; x += step) {
    for (let z = minZ; z <= maxZ; z += step) {
      if (terrain.surfaceHeightAt(x, z) < VIEW_HILL_MIN_Y || isPondColumn(terrain, x, z)) continue;
      columns.push({ x, z });
    }
  }
  return columns;
}

/** 列的说明：坐标、地表高度、群系、列顶地表方块。 */
function describeColumn(terrain: Terrain, { x, z }: ColumnCoord): string {
  return `(${x}, ${z}) y ${terrain.surfaceHeightAt(x, z)} ${terrain.biomeAt(x, z)} 列顶 ${terrain.surfaceBlockAt(x, z)}`;
}

describe('冰雪旁的山丘进入冰雪群系、铺雪草方块（#87 验收第一条）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：紧挨冰雪群系的山丘列顶是雪草方块（陡坡是石头），没有草方块', (seed) => {
    const terrain = terrainOf(seed);
    const hills = hillsOf(seed);
    expect(hills.length, '冰雪旁的山丘列数').toBeGreaterThanOrEqual(MIN_HILLS);
    const wrong = hills
      .filter((column) => terrain.surfaceBlockAt(column.x, column.z) !== expectedSnowyTop(terrain, column))
      .map((column) => describeColumn(terrain, column));
    expect(wrong, `${hills.length} 列里列顶不对的`).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：紧挨冰雪群系的山丘群系是冰雪', (seed) => {
    const terrain = terrainOf(seed);
    const hills = hillsOf(seed);
    expect(hills.length, '冰雪旁的山丘列数').toBeGreaterThanOrEqual(MIN_HILLS);
    const wrong = hills
      .filter((column) => terrain.biomeAt(column.x, column.z) !== Biome.Snowy)
      .map((column) => describeColumn(terrain, column));
    expect(wrong, `${hills.length} 列里群系不是冰雪的`).toEqual([]);
  });
});

describe('平原内部的小山仍是平原、草方块（#87 验收第一条）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：离大海、高处与低处冰雪都在 128 格以外的小山，群系是平原且列顶是草方块的不少于 main 的九成', (seed) => {
    const terrain = terrainOf(seed);
    const hills = plainsInteriorHillColumns(terrain, SURVEY_HALF, PLAINS_STEP).filter(
      (column) => !isPondColumn(terrain, column.x, column.z),
    );
    const mainCount = MAIN_PLAINS_HILLS.get(seed)!;
    const unchanged = hills.filter(
      ({ x, z }) => terrain.biomeAt(x, z) === Biome.Plains && terrain.surfaceBlockAt(x, z) === BlockType.Grass,
    );
    const changed = hills.filter((column) => !unchanged.includes(column)).map((column) => describeColumn(terrain, column));
    expect(
      unchanged.length,
      `仍是平原草方块的列数（main ${mainCount}，选进 ${hills.length}），变了的：${changed.join('；')}`,
    ).toBeGreaterThanOrEqual(Math.floor(mainCount * PLAINS_HILLS_SHARE));
  });
});

describe('实机视点 01 看到的山丘铺雪（默认种子，#82 截图 01）', () => {
  it('x 0 到 140、z 120 到 220 里地表不低于 y 78 的列：列顶是雪草方块（陡坡是石头）', () => {
    const terrain = terrainOf(DEFAULT_SEED);
    const columns = viewHillColumns();
    expect(columns.length, '山丘列数（main 538）').toBeGreaterThanOrEqual(500);
    const wrong = columns
      .filter((column) => terrain.surfaceBlockAt(column.x, column.z) !== expectedSnowyTop(terrain, column))
      .map((column) => describeColumn(terrain, column));
    expect(wrong.length, `${columns.length} 列里列顶不对的，前几列：${wrong.slice(0, 5).join('；')}`).toBe(0);
  });

  it('同一片列的群系是冰雪', () => {
    const terrain = terrainOf(DEFAULT_SEED);
    const columns = viewHillColumns();
    const wrong = columns
      .filter(({ x, z }) => terrain.biomeAt(x, z) !== Biome.Snowy)
      .map((column) => describeColumn(terrain, column));
    expect(wrong.length, `${columns.length} 列里群系不是冰雪的，前几列：${wrong.slice(0, 5).join('；')}`).toBe(0);
  });

  it('生成的区块 (2..5, 9..11) 里每一列地表高度那一格是雪草方块（陡坡是石头），与列顶地表方块查询相同', () => {
    const terrain = terrainOf(DEFAULT_SEED);
    const { minCx, maxCx, minCz, maxCz } = VIEW_HILL_CHUNKS;
    const wrong: string[] = [];
    const mismatched: string[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const chunk = terrain.generateChunk(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const column = { x: cx * CHUNK_SIZE + lx, z: cz * CHUNK_SIZE + lz };
            if (isPondColumn(terrain, column.x, column.z)) continue;
            const generated = chunk.get(lx, terrain.surfaceHeightAt(column.x, column.z), lz);
            if (generated !== terrain.surfaceBlockAt(column.x, column.z)) mismatched.push(describeColumn(terrain, column));
            if (generated !== expectedSnowyTop(terrain, column)) wrong.push(`${describeColumn(terrain, column)} 生成 ${generated}`);
          }
        }
      }
    }
    expect(mismatched, '生成结果与查询不一致的列').toEqual([]);
    expect(wrong.length, `列顶不对的列，前几列：${wrong.slice(0, 5).join('；')}`).toBe(0);
  });
});

/**
 * 群系与列顶的对应（CONTEXT.md「群系」「陡坡」「沙滩」）：露出水面、不是水塘的列，冰雪群系的列顶只能是雪草方块或
 * 石头（陡坡）；平原的列顶不会是雪草方块。生成器若用的群系与查询不同（例如区块里按列缓存的温度没算高度项），
 * 生成出的列顶就会与查询的群系对不上。
 */
function topFitsBiome(biome: Biome, top: BlockType): boolean {
  if (biome === Biome.Snowy) return top === BlockType.SnowyGrass || top === BlockType.Stone;
  if (biome === Biome.Plains) return top !== BlockType.SnowyGrass;
  return true;
}

/** 某个种子里拿来核对生成的区块：前 3 列冰雪旁山丘所在的区块，连同它东边与南边的区块（跨区块边缘）。 */
function hillChunks(seed: number): Array<readonly [number, number]> {
  const seen = new Set<string>();
  const chunks: Array<readonly [number, number]> = [];
  for (const { x, z } of hillsOf(seed).slice(0, 3)) {
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const cx = chunkOf(x) + dx;
      const cz = chunkOf(z) + dz;
      const key = `${cx},${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push([cx, cz]);
    }
  }
  return chunks;
}

describe('群系查询与生成结果一致，含区块边缘（#87 验收第二条）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：冰雪旁山丘一带的区块逐列核对：地表高度那一格等于列顶地表方块查询，且与查询的群系相符', (seed) => {
    const terrain = terrainOf(seed);
    const mismatched: string[] = [];
    const misfit: string[] = [];
    for (const [cx, cz] of hillChunks(seed)) {
      const chunk = terrain.generateChunk(cx, cz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const x = cx * CHUNK_SIZE + lx;
          const z = cz * CHUNK_SIZE + lz;
          const surface = terrain.surfaceHeightAt(x, z);
          const generated = chunk.get(lx, surface, lz);
          if (generated !== terrain.surfaceBlockAt(x, z)) mismatched.push(`${describeColumn(terrain, { x, z })} 生成 ${generated}`);
          if (surface < SEA_LEVEL || isPondColumn(terrain, x, z)) continue;
          if (!topFitsBiome(terrain.biomeAt(x, z), generated)) misfit.push(`${describeColumn(terrain, { x, z })} 生成 ${generated}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
    expect(misfit).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：同一种子构造两次生成同一区块逐字节相同，先 A 后 B 与先 B 后 A 也相同', (seed) => {
    const [a, b] = hillChunks(seed);
    const first = createTerrain(seed);
    const firstA = first.generateChunk(...a!);
    const firstB = first.generateChunk(...b!);
    const second = createTerrain(seed);
    const secondB = second.generateChunk(...b!);
    const secondA = second.generateChunk(...a!);
    expect(Buffer.from(secondA.blocks).equals(Buffer.from(firstA.blocks))).toBe(true);
    expect(Buffer.from(secondB.blocks).equals(Buffer.from(firstB.blocks))).toBe(true);
  });
});

/**
 * 海平面那层结冰的列（main 01a0996 实测）：每个区块 16 行，第 lz 行的第 lx 位是 1 表示 (lx, SEA_LEVEL, lz) 是冰。
 * 挑的是冷暖交界穿过的大海区块与寒冷处的内陆湖区块：结冰若改看地表高度，交界会挪动，湖面结冰的列也会变。
 */
const ICE_BASELINE: ReadonlyArray<{ seed: number; chunk: readonly [number, number]; rows: readonly number[] }> = [
  { seed: 314_159, chunk: [-150, 87], rows: [0x001f, 0x000f, 0x0007, 0x0003, 0x0001, 0x0001, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  {
    seed: 314_159,
    chunk: [-147, 81],
    rows: [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0x7fff, 0x3fff, 0x3fff, 0x1fff, 0x0fff, 0x07ff, 0x07ff, 0x03ff, 0x01ff, 0x01ff],
  },
  {
    seed: 314_159,
    chunk: [-6, 117],
    rows: [0xfff8, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0xfff0, 0xfff0, 0x3f80, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    seed: 777,
    chunk: [-141, 129],
    rows: [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0x7fff, 0x3fff, 0x1fff, 0x0fff, 0x07ff, 0x03ff, 0x01ff, 0x00ff, 0x00ff, 0x007f, 0x003f],
  },
  {
    seed: 777,
    chunk: [-129, 18],
    rows: [0xfc00, 0xfc00, 0xfc00, 0xfe00, 0xfe00, 0xff00, 0x7f00, 0x7f80, 0x7f80, 0x7fc0, 0x7fc0, 0x7fe0, 0x7fe0, 0x7fe0, 0x3fc0, 0x1f80],
  },
  {
    seed: -42,
    chunk: [-150, -27],
    rows: [0, 0, 0, 0, 0, 0xc000, 0xe000, 0xf800, 0xfe00, 0xff00, 0xffc0, 0xffe0, 0xfff8, 0xfffe, 0xffff, 0xffff],
  },
  {
    seed: -42,
    chunk: [-123, -48],
    rows: [0, 0, 0, 0, 0, 0, 0, 0x7800, 0xfe00, 0xfe00, 0xfe00, 0xfe00, 0xfe00, 0xfc00, 0xf000, 0xc000],
  },
  {
    seed: DEFAULT_SEED,
    chunk: [-144, 84],
    rows: [0xffff, 0xfffe, 0xfffc, 0xfff8, 0xfff0, 0xffc0, 0xff80, 0xff00, 0xfe00, 0xf800, 0xf000, 0xc000, 0x8000, 0, 0, 0],
  },
  {
    seed: DEFAULT_SEED,
    chunk: [-108, -21],
    rows: [0x1ff0, 0x1ff0, 0x1ff0, 0x1ff0, 0x1fe0, 0x0fc0, 0x0f80, 0x0700, 0x0100, 0, 0, 0, 0, 0, 0, 0],
  },
];

/** 区块海平面那层结冰的列，按 ICE_BASELINE 的写法。 */
function iceRows(terrain: Terrain, cx: number, cz: number): number[] {
  const chunk = terrain.generateChunk(cx, cz);
  const rows: number[] = [];
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    let bits = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) if (chunk.get(lx, SEA_LEVEL, lz) === BlockType.Ice) bits |= 1 << lx;
    rows.push(bits);
  }
  return rows;
}

describe('海平面结冰范围与改前相同（#87 验收第三条）', () => {
  it.each(ICE_BASELINE)('种子 $seed 区块 $chunk：海平面那层结冰的列与 main 相同', ({ seed, chunk, rows }) => {
    const [cx, cz] = chunk;
    const hex = (values: readonly number[]): string[] => values.map((v) => `0x${v.toString(16).padStart(4, '0')}`);
    expect(hex(iceRows(terrainOf(seed), cx, cz))).toEqual(hex(rows));
  });

  it('默认种子的出生列仍是原点，原点仍是平原', () => {
    const terrain = terrainOf(DEFAULT_SEED);
    expect(terrain.spawnColumn).toEqual({ x: 0, z: 0 });
    expect(terrain.biomeAt(0, 0)).toBe(Biome.Plains);
  });
});

describe('高度项的固定坐标（#87 审查补充）', () => {
  /**
   * 种子 314159 的 (−2872, 688)：起伏不大的陆地（不是高山），地表 y 75，温度噪声 −0.096 高于寒冷阈值，减去高度项
   * 0.018 后 −0.114，低于阈值。高度项只作用于高山时它会是平原。
   */
  it('起伏不大的陆地列因地表高于基准而变冷：群系是冰雪，列顶查询与生成结果都是雪草方块', () => {
    const seed = 314_159;
    const { x, z } = { x: -2872, z: 688 };
    const terrain = terrainOf(seed);
    const h = terrain.surfaceHeightAt(x, z);
    expect(h, '地表高度').toBe(75);
    expect(reliefAt(seed, x, z), '起伏').toBeLessThanOrEqual(MOUNTAIN_RELIEF);
    expect(temperatureAt(seed, x, z), '温度噪声').toBeGreaterThan(COLD_TEMPERATURE);
    expect(terrain.biomeAt(x, z)).toBe(Biome.Snowy);
    expect(terrain.surfaceBlockAt(x, z)).toBe(BlockType.SnowyGrass);
    const chunk = terrain.generateChunk(chunkOf(x), chunkOf(z));
    expect(chunk.get(localOf(x), h, localOf(z))).toBe(BlockType.SnowyGrass);
  });

  /**
   * 种子 314159 的 (−3912, −3184)：高山，地表 y 65，温度噪声 −0.113 低于寒冷阈值。地表低于基准 y 72，高度项为 0，
   * 温度不升高，仍是寒冷处、雪线以下，所以是冰雪；若低处按负的高度项升温（+0.042），它会是高山。
   */
  it('地表低于基准的列温度不升高：寒冷处低处的高山列仍是冰雪、雪草方块', () => {
    const seed = 314_159;
    const { x, z } = { x: -3912, z: -3184 };
    const terrain = terrainOf(seed);
    const h = terrain.surfaceHeightAt(x, z);
    expect(h, '地表高度').toBe(65);
    expect(reliefAt(seed, x, z), '起伏').toBeGreaterThan(MOUNTAIN_RELIEF);
    expect(temperatureAt(seed, x, z), '温度噪声').toBeLessThan(COLD_TEMPERATURE);
    expect(terrain.biomeAt(x, z)).toBe(Biome.Snowy);
    expect(terrain.surfaceBlockAt(x, z)).toBe(BlockType.SnowyGrass);
    const chunk = terrain.generateChunk(chunkOf(x), chunkOf(z));
    expect(chunk.get(localOf(x), h, localOf(z))).toBe(BlockType.SnowyGrass);
  });
});
