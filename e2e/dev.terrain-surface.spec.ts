import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { CHUNK_SIZE, SEA_LEVEL } from '../src/core/constants';
import { Biome, createTerrain, type ColumnCoord } from '../src/core/terrain';
import { chunkOf, type ChunkCoord } from '../src/core/world';
import { createWorld, ignorePause, waitForWorldList } from './world-list';

/**
 * #76 地表铺法的端到端核对：在 Node 里用同一份地形对象、固定种子算出一处沙滩与一处雪线以上的列，
 * 经调试句柄确认页面里那几格的方块。
 *
 * 调试句柄只读得到已加载区块里的方块，也没有把玩家挪到远处的指令，所以选一个两处都在默认视距以内的种子：
 * 种子 940 的原点是平原草方块，切比雪夫距离约 42 格处有沙滩、约 82 格处有雪线以上的高山。找列以页面里玩家所在的
 * 区块与视距为准（留 1 个区块的边），出生列改为螺旋搜索（#84）之后仍然成立。
 * Windows 浏览器实机截图不在这里，留给实机验收。
 */

/**
 * 新方块按字符串键取编号：编号未定义时类型检查仍然通过（生产预览的 `npm run build` 要先过类型检查），用例按断言失败。
 */
const SAND = (BlockType as Readonly<Record<string, number>>)['Sand'];
const SNOWY_GRASS = (BlockType as Readonly<Record<string, number>>)['SnowyGrass'];

const SEED = 940;
const TERRAIN = createTerrain(SEED);

/** 雪线（QA 定，见 tests/helpers/surface-rules.ts）。 */
const SNOW_LINE_Y = 150;
/** 沙滩的地表最高在海平面之上几格。 */
const BEACH_MAX_ABOVE_SEA = 4;

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  expect(typeof SAND, '沙子的方块编号未定义').toBe('number');
  expect(typeof SNOWY_GRASS, '雪草方块的方块编号未定义').toBe('number');
  await page.goto('/');
  await waitForWorldList(page);
  await createWorld(page, { seed: String(SEED) });
  await ignorePause(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** 从 center 那一列起按切比雪夫距离由近到远找第一列满足 match 的，最远 reach 格。 */
function nearestColumn(center: ColumnCoord, reach: number, match: (x: number, z: number) => boolean): ColumnCoord | undefined {
  for (let d = 0; d <= reach; d++) {
    for (let dx = -d; dx <= d; dx++) {
      for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        const x = center.x + dx;
        const z = center.z + dz;
        if (match(x, z)) return { x, z };
      }
    }
  }
  return undefined;
}

/** 露出水面的沙滩列：平原或冰雪，地表在海平面到海平面上 4 格之间，列顶地表方块是沙子。 */
function isBeach(x: number, z: number): boolean {
  const biome = TERRAIN.biomeAt(x, z);
  if (biome !== Biome.Plains && biome !== Biome.Snowy) return false;
  const surface = TERRAIN.surfaceHeightAt(x, z);
  if (surface < SEA_LEVEL || surface > SEA_LEVEL + BEACH_MAX_ABOVE_SEA) return false;
  return TERRAIN.surfaceBlockAt(x, z) === SAND;
}

/** 雪线以上的高山列：列顶地表方块是雪草方块。 */
function isAboveSnowLine(x: number, z: number): boolean {
  if (TERRAIN.biomeAt(x, z) !== Biome.Mountains) return false;
  if (TERRAIN.surfaceHeightAt(x, z) < SNOW_LINE_Y) return false;
  return TERRAIN.surfaceBlockAt(x, z) === SNOWY_GRASS;
}

function chunkOfColumn({ x, z }: ColumnCoord): ChunkCoord {
  return { cx: chunkOf(x), cz: chunkOf(z) };
}

/** Node 侧同一份地形对象生成的那一列在这几个 y 上的方块。 */
function generatedColumn(column: ColumnCoord, ys: readonly number[]): number[] {
  const { cx, cz } = chunkOfColumn(column);
  const chunk = TERRAIN.generateChunk(cx, cz);
  return ys.map((y) => chunk.get(column.x - cx * CHUNK_SIZE, y, column.z - cz * CHUNK_SIZE));
}

/** 等这几个区块都加载好。 */
async function waitForChunks(page: Page, chunks: readonly ChunkCoord[]): Promise<void> {
  await expect
    .poll(
      () => page.evaluate((list) => list.every(({ cx, cz }) => window.__VOXEL__!.core.isChunkLoaded(cx, cz)), chunks),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('Node 里算出的一处沙滩与一处雪线以上的列，页面里那几格的方块相同：沙滩顶层与其下两层是沙子，雪线以上是雪草方块、其下是泥土（#76）', async ({
  page,
}) => {
  const { cx, cz, radius } = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    return { ...core.playerChunk, radius: core.viewRadius };
  });
  // 玩家所在区块的中心；视距内的区块留 1 个区块的边，找到的列一定会加载
  const center = { x: cx * CHUNK_SIZE + CHUNK_SIZE / 2, z: cz * CHUNK_SIZE + CHUNK_SIZE / 2 };
  const reach = (radius - 1) * CHUNK_SIZE;
  const beach = nearestColumn(center, reach, isBeach);
  const snow = nearestColumn(center, reach, isAboveSnowLine);
  expect(beach, `种子 ${SEED} 在玩家区块 (${cx}, ${cz}) 周围 ${reach} 格内找不到沙滩列`).toBeDefined();
  expect(snow, `种子 ${SEED} 在玩家区块 (${cx}, ${cz}) 周围 ${reach} 格内找不到雪线以上的雪草方块列`).toBeDefined();

  await waitForChunks(page, [chunkOfColumn(beach!), chunkOfColumn(snow!)]);
  const beachY = TERRAIN.surfaceHeightAt(beach!.x, beach!.z);
  const snowY = TERRAIN.surfaceHeightAt(snow!.x, snow!.z);
  const beachYs = [beachY + 1, beachY, beachY - 1, beachY - 2];
  const snowYs = [snowY + 1, snowY, snowY - 1];
  const seen = await page.evaluate(
    ({ beach, beachYs, snow, snowYs }) => {
      const core = window.__VOXEL__!.core;
      const column = ({ x, z }: { x: number; z: number }, ys: number[]) => ys.map((y) => core.getBlock(x, y, z));
      return { beach: column(beach, beachYs), snow: column(snow, snowYs) };
    },
    { beach: beach!, beachYs, snow: snow!, snowYs },
  );

  const where = `沙滩 (${beach!.x}, ${beachY}, ${beach!.z})，雪线以上 (${snow!.x}, ${snowY}, ${snow!.z})`;
  // 页面里那几格与 Node 侧同一份地形对象生成的区块逐格相同（地表之上那一格也比：可能是空气，也可能是树）
  expect(seen, where).toEqual({ beach: generatedColumn(beach!, beachYs), snow: generatedColumn(snow!, snowYs) });
  // 沙滩顶层与其下两层是沙子；雪线以上顶层是雪草方块，其下是泥土
  expect(seen.beach.slice(1), where).toEqual([SAND, SAND, SAND]);
  expect(seen.snow.slice(1), where).toEqual([SNOWY_GRASS, BlockType.Dirt]);
});
