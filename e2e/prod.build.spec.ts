import { expect, test } from '@playwright/test';
import { countCanvasColors, waitForFirstFrame } from './canvas';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForFirstFrame(page);
});

test('生产构建不挂调试句柄', async ({ page }) => {
  const handle = await page.evaluate(() => window.__VOXEL__ ?? null);
  expect(handle).toBeNull();
});

test('生产构建同样画出了世界', async ({ page }) => {
  await expect(page).toHaveTitle('体素世界');
  expect(await countCanvasColors(page)).toBeGreaterThan(20);
});
