import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
} from '../src/core/constants';
import { DEMO_TREE_COLUMN } from '../src/demo-scene';
import { STRINGS } from '../src/ui/strings';
import { countCanvasColors, waitForFirstFrame } from './canvas';

/** 默认视距下已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -DEFAULT_VIEW_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (DEFAULT_VIEW_RADIUS + 1) * CHUNK_SIZE - 1;

/** 采样时 z 的步长：抽十来行就够判断起伏与确定性，不必读满六千多列。 */
const PROFILE_Z_STEP = 8;

/** 读一片地表高度。地形起伏与确定性都靠它断言。 */
async function readSurfaceProfile(page: Page): Promise<number[]> {
  return page.evaluate(
    ({ from, to, zStep }) => {
      const core = window.__VOXEL__!.core;
      const heights: number[] = [];
      for (let z = from; z <= to; z += zStep) {
        for (let x = from; x <= to; x++) heights.push(core.highestBlockY(x, z));
      }
      return heights;
    },
    { from: LOADED_MIN, to: LOADED_MAX, zStep: PROFILE_Z_STEP },
  );
}

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await waitForFirstFrame(page);
});

test('页面加载过程中没有 JS 错误', () => {
  expect(errors).toEqual([]);
});

test('页面标题来自简体中文字符串表', async ({ page }) => {
  await expect(page).toHaveTitle(STRINGS.gameTitle);
});

test('画布画出了内容，不是单色', async ({ page }) => {
  const colors = await countCanvasColors(page);
  expect(colors).toBeGreaterThan(20);
});

test('调试句柄报告已加载区块与已建网格', async ({ page }) => {
  const state = await page.evaluate(() => {
    const handle = window.__VOXEL__;
    if (!handle) throw new Error('开发构建下应存在调试句柄');
    return {
      loadedChunkCount: handle.core.loadedChunkCount,
      chunkMeshCount: handle.renderer.chunkMeshCount,
    };
  });
  expect(state.loadedChunkCount).toBeGreaterThan(0);
  expect(state.chunkMeshCount).toBeGreaterThan(0);
});

test('调试句柄能读到核心的方块状态', async ({ page }) => {
  const state = await page.evaluate(
    ({ column, oakLog }) => {
      const core = window.__VOXEL__!.core;
      const spawn = core.spawnPoint;
      // 演示橡树的树干在这一列上。地表高度随地形起伏，所以自上而下扫，不写死 y。
      let trunkFound = false;
      for (let y = core.highestBlockY(column.x, column.z); y > 0; y--) {
        if (core.getBlock(column.x, y, column.z) === oakLog) {
          trunkFound = true;
          break;
        }
      }
      return {
        underSpawn: core.getBlock(spawn.x, spawn.y - 1, spawn.z),
        atSpawn: core.getBlock(spawn.x, spawn.y, spawn.z),
        aboveSpawn: core.getBlock(spawn.x, spawn.y + 1, spawn.z),
        trunkFound,
      };
    },
    { column: DEMO_TREE_COLUMN, oakLog: BlockType.OakLog },
  );
  expect(state.underSpawn).toBe(BlockType.Grass);
  expect(state.atSpawn).toBe(BlockType.Air);
  expect(state.aboveSpawn).toBe(BlockType.Air);
  expect(state.trunkFound).toBe(true);
});

test('页面打开后是由默认种子生成的起伏平原', async ({ page }) => {
  const seed = await page.evaluate(() => window.__VOXEL__!.core.seed);
  expect(seed).toBe(DEFAULT_SEED);

  const heights = await readSurfaceProfile(page);
  // 出现多种高度才算「起伏」，而不是一片硬编码平地
  expect(new Set(heights).size).toBeGreaterThan(1);
  expect(Math.min(...heights)).toBeGreaterThan(SEA_LEVEL);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(20);
});

test('同一种子每次进入地形相同', async ({ page }) => {
  const before = await readSurfaceProfile(page);
  await page.reload();
  await waitForFirstFrame(page);
  expect(await readSurfaceProfile(page)).toEqual(before);
});

test('核心以固定步长推进', async ({ page }) => {
  const before = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  // 20 tick/s，放宽到 [10, 30] 以容忍 CI 上的抖动
  expect(after - before).toBeGreaterThanOrEqual(10);
  expect(after - before).toBeLessThanOrEqual(30);
});
