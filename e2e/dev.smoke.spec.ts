import { expect, test } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { FLAT_SURFACE_Y } from '../src/core/constants';
import { DEMO_TREE_COLUMN } from '../src/demo-scene';
import { STRINGS } from '../src/ui/strings';
import { countCanvasColors, waitForFirstFrame } from './canvas';

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
  const trunk = { ...DEMO_TREE_COLUMN, y: FLAT_SURFACE_Y + 1 };
  const blocks = await page.evaluate((trunkAt) => {
    const core = window.__VOXEL__!.core;
    const spawn = core.spawnPoint;
    return {
      underSpawn: core.getBlock(spawn.x, spawn.y - 1, spawn.z),
      atSpawn: core.getBlock(spawn.x, spawn.y, spawn.z),
      demoTrunk: core.getBlock(trunkAt.x, trunkAt.y, trunkAt.z),
    };
  }, trunk);
  expect(blocks.underSpawn).toBe(BlockType.Grass);
  expect(blocks.atSpawn).toBe(BlockType.Air);
  expect(blocks.demoTrunk).toBe(BlockType.OakLog);
});

test('核心以固定步长推进', async ({ page }) => {
  const before = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  // 20 tick/s，放宽到 [10, 30] 以容忍 CI 上的抖动
  expect(after - before).toBeGreaterThanOrEqual(10);
  expect(after - before).toBeLessThanOrEqual(30);
});
