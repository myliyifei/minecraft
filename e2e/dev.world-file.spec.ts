import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { ItemType } from '../src/core/item';
import { STRINGS } from '../src/ui/strings';
import { blockAt, createWorld, digTop, exitToList, waitForWorld, waitForWorldList } from './world-list';

/*
 * 导出与导入（#70）。每条测试的浏览器上下文都是新的，IndexedDB 一开始是空的。
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
});

function entries(page: Page): Locator {
  return page.locator('.world-list__entry');
}

/** 世界 id 是这个的那一条。导入的世界与原世界同名，只能按 id 找。 */
function entryWithId(page: Page, id: string): Locator {
  return page.locator(`.world-list__entry[data-id="${id}"]`);
}

/** 列表里自上而下的世界 id。 */
async function entryIds(page: Page): Promise<string[]> {
  return entries(page).evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.id!));
}

async function enterId(page: Page, id: string): Promise<void> {
  await entryWithId(page, id).getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
}

/** 点这一条的「导出」，等下载完成，返回下载的文件名与存在本地的路径。 */
async function exportId(page: Page, id: string): Promise<{ name: string; path: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    entryWithId(page, id).getByRole('button', { name: STRINGS.exportWorld }).click(),
  ]);
  return { name: download.suggestedFilename(), path: await download.path() };
}

/** 点「导入」选这个文件。文件对话框由 Playwright 接住，不弹出来。 */
async function importFile(page: Page, path: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: STRINGS.importWorld }).click()]);
  await chooser.setFiles(path);
}

/** 世界里的洞与掉落物：比对导入前后用。 */
async function holeAndDrops(page: Page, hole: { x: number; y: number; z: number }) {
  return page.evaluate(
    ({ x, y, z }) => {
      const core = window.__VOXEL__!.core;
      return {
        block: core.getBlock(x, y, z),
        drops: core.drops.all().map(({ id, item, count, position, age }) => ({ id, item, count, age, position: { ...position } })),
      };
    },
    hole,
  );
}

test('导出一个世界，导入后列表多一条同名世界，进入后洞与掉落物与原世界一致；再导入同一个文件又多一条，三者互不影响', async ({
  page,
}) => {
  await createWorld(page, { name: '原世界', seed: '1' });
  // 背包塞满泥土再挖脚下那一块：掉出来的泥土收不进背包，留在洞里
  const hole = await page.evaluate(
    ({ dirt, air }) => {
      const core = window.__VOXEL__!.core;
      while (core.giveItem(dirt, 64) === 0);
      core.turn(0, -Math.PI);
      core.tick();
      const { x, y, z } = core.mining.target!;
      core.setMining(true);
      for (let i = 0; i < 200 && core.getBlock(x, y, z) !== air; i++) core.tick();
      core.setMining(false);
      return { x, y, z };
    },
    { dirt: ItemType.Dirt, air: BlockType.Air },
  );
  const original = await holeAndDrops(page, hole);
  expect(original.block).toBe(BlockType.Air);
  expect(original.drops).toHaveLength(1);
  await exitToList(page);
  const [originalId] = await entryIds(page);

  const exported = await exportId(page, originalId!);
  expect(exported.name).toBe('原世界.voxelworld');

  await importFile(page, exported.path);
  await expect(entries(page)).toHaveCount(2);
  const [firstCopy] = (await entryIds(page)).filter((id) => id !== originalId);
  // 导入的那条上次游玩时间是当前，排在最前
  expect(await entryIds(page)).toEqual([firstCopy, originalId]);
  await expect(entryWithId(page, firstCopy!).locator('.world-list__name')).toHaveText('原世界');

  await enterId(page, firstCopy!);
  expect(await holeAndDrops(page, hole)).toEqual(original);
  // 在第一份副本里另挖一个洞
  const extra = { x: hole.x + 5, z: hole.z + 5 };
  const extraY = await digTop(page, extra.x, extra.z);
  await exitToList(page);

  await importFile(page, exported.path);
  await expect(entries(page)).toHaveCount(3);
  const [secondCopy] = (await entryIds(page)).filter((id) => id !== originalId && id !== firstCopy);
  expect(new Set([originalId, firstCopy, secondCopy]).size).toBe(3);

  for (const id of [originalId!, secondCopy!]) {
    await enterId(page, id);
    expect(await holeAndDrops(page, hole)).toEqual(original);
    expect(await blockAt(page, extra.x, extraY, extra.z)).not.toBe(BlockType.Air);
    await exitToList(page);
  }
  await enterId(page, firstCopy!);
  expect(await blockAt(page, extra.x, extraY, extra.z)).toBe(BlockType.Air);
  await exitToList(page);

  expect(errors).toEqual([]);
});

test('导入随意的文件或版本不同的文件：提示「文件无效或版本不兼容」，列表不变', async ({ page }, testInfo) => {
  await createWorld(page, { name: '原世界' });
  await exitToList(page);
  const [id] = await entryIds(page);
  const exported = await exportId(page, id!);
  const message = page.locator('.world-list__message');

  const junk = testInfo.outputPath('随意的文件.voxelworld');
  await writeFile(junk, '这不是导出文件');
  // 文件头第 8 到 11 字节是格式版本，改成别的版本
  const otherVersion = testInfo.outputPath('别的版本.voxelworld');
  const bytes = await readFile(exported.path);
  bytes.writeUInt32LE(bytes.readUInt32LE(8) + 1, 8);
  await writeFile(otherVersion, bytes);

  for (const path of [junk, otherVersion]) {
    await importFile(page, path);
    await expect(message).toHaveText(STRINGS.importInvalid);
    await expect(entries(page)).toHaveCount(1);
    expect(await page.evaluate(() => window.__VOXEL_LIST__!.listWorlds().then((list) => list.length))).toBe(1);
    // 下一次点列表上的按钮时提示清掉
    await page.getByRole('button', { name: STRINGS.newWorld }).click();
    await expect(message).toBeHidden();
    await page.getByRole('button', { name: STRINGS.cancel }).click();
  }
  // 好的文件照样导入
  await importFile(page, exported.path);
  await expect(entries(page)).toHaveCount(2);
  // 文件无效是预期的结果，控制台只有警告
  expect(errors).toEqual([]);
});

test('另一个标签页开着这个世界：导出被拒并提示「已在另一个标签页打开」，不下载；那边退出之后可以导出', async ({ page }) => {
  await createWorld(page, { name: '世界甲' });
  const other = await page.context().newPage();
  await other.goto('/');
  await waitForWorldList(other);
  // 进入时的那次写盘提交了，另一个标签页才读得到这个世界
  await expect.poll(() => other.evaluate(() => window.__VOXEL_LIST__!.listWorlds().then((list) => list.length))).toBe(1);
  await other.reload();
  await waitForWorldList(other);
  await expect(entries(other)).toHaveCount(1);
  const [id] = await entryIds(other);

  let downloads = 0;
  other.on('download', () => downloads++);
  await entryWithId(other, id!).getByRole('button', { name: STRINGS.exportWorld }).click();
  await expect(other.locator('.world-list__message')).toHaveText(STRINGS.worldInUse);
  await other.waitForTimeout(500);
  expect(downloads).toBe(0);

  await exitToList(page);
  const exported = await exportId(other, id!);
  expect(exported.name).toBe('世界甲.voxelworld');
  await other.close();
  expect(errors).toEqual([]);
});
