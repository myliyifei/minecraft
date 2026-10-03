import { expect, test } from '@playwright/test';
import { STRINGS } from '../src/ui/strings';
import { createWorld, waitForWorldList } from './world-list';

/**
 * 跑在生产构建的预览上。生产构建不挂调试句柄、也不保留绘制缓冲，
 * 所以这里不数画布颜色（那条断言在 dev 项目里）——从世界列表新建世界、加载画面藏起本身就说明
 * 存储模块、贴图加载、渲染器构造、首帧渲染全部正常。
 */
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await waitForWorldList(page);
  await createWorld(page);
});

test('生产构建不挂调试句柄', async ({ page }) => {
  const handles = await page.evaluate(() => [window.__VOXEL__ ?? null, window.__VOXEL_LIST__ ?? null]);
  expect(handles).toEqual([null, null]);
});

test('生产构建能正常起来并画完首帧', async ({ page }) => {
  await expect(page).toHaveTitle(STRINGS.gameTitle);
  const size = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('页面上没有画布');
    return { width: canvas.width, height: canvas.height };
  });
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
