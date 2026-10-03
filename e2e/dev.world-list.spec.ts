import { expect, test, type Locator, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { Difficulty } from '../src/core/difficulty';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION } from '../src/core/snapshot';
import { seedFromText } from '../src/core/world-seed';
import { DB_NAME, WORLDS, type WorldMeta } from '../src/storage/world-storage';
import { DIFFICULTY_NAMES, STRINGS } from '../src/ui/strings';
import { blockAt, createWorld, digTop, exitToList, resumeGame, waitForWorld, waitForWorldList } from './world-list';

/*
 * 世界列表与进入世界（#67）。每条测试的浏览器上下文都是新的，IndexedDB 一开始是空的。
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

/** 名称是这个的那一条。测试里的名称互不包含，按子串匹配只匹配到一条。 */
function entryNamed(page: Page, name: string): Locator {
  return entries(page).filter({ has: page.locator('.world-list__name', { hasText: name }) });
}

/** 列表里自上而下的名称。 */
function entryNames(page: Page): Promise<string[]> {
  return page.locator('.world-list__name').allTextContents();
}

/** 点这一条的「进入」，等加载画面消失。 */
async function enterNamed(page: Page, name: string): Promise<void> {
  await entryNamed(page, name).getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
}

/** 两下点这一条的删除按钮：第一下换成「确认删除」，第二下才删。 */
async function deleteNamed(page: Page, name: string): Promise<void> {
  const button = entryNamed(page, name).locator('.world-list__delete');
  await button.click();
  await expect(button).toHaveText(STRINGS.confirmDelete);
  await button.click();
}

/**
 * 不经过页面的存储模块，直接打开 IndexedDB 的元数据表：先写进 `put` 里的记录，再读出全部世界元数据。
 */
function worldsTable(page: Page, put: readonly WorldMeta[] = []): Promise<WorldMeta[]> {
  return page.evaluate(
    async ({ dbName, store, put }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(store, 'readwrite');
      for (const meta of put) tx.objectStore(store).put(meta);
      const metas = await new Promise<WorldMeta[]>((resolve, reject) => {
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as WorldMeta[]);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return metas;
    },
    { dbName: DB_NAME, store: WORLDS, put },
  );
}

/** 挖空脚下 24 格，推进到摔死。整段在一次同步的 evaluate 里，游戏循环插不进来。 */
async function fallToDeath(page: Page): Promise<void> {
  const dead = await page.evaluate(
    ({ depth, air }) => {
      const { core, hud } = window.__VOXEL__!;
      const { x, z } = core.player.position;
      const column = { x: Math.floor(x), z: Math.floor(z) };
      const top = core.highestBlockY(column.x, column.z);
      for (let y = top; y > top - depth; y--) core.setBlock(column.x, y, column.z, air);
      for (let ticks = 0; ticks < 100 && !core.health.dead; ticks++) core.tick();
      hud.update();
      return core.health.dead;
    },
    { depth: 24, air: BlockType.Air },
  );
  expect(dead).toBe(true);
}

test('首次打开列表为空；新建世界的加载画面消失后世界时刻为 0、玩家在出生点，锁定指针之前不推进；退出后列表一条，再进入接着上次', async ({
  page,
}) => {
  await expect(page.locator('.world-list__empty')).toHaveText(STRINGS.noWorlds);
  await expect(entries(page)).toHaveCount(0);
  for (const name of [STRINGS.newWorld, STRINGS.importWorld, STRINGS.settings]) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }

  await createWorld(page);
  await expect(page.locator('#world-list')).toBeHidden();
  const entered = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    return {
      ticks: core.tickCount,
      timeOfDay: core.timeOfDay,
      position: { ...core.player.position },
      spawn: core.spawnPoint,
    };
  });
  expect(entered.ticks).toBe(0);
  expect(entered.timeOfDay).toBe(0);
  expect(entered.position).toEqual(entered.spawn);
  // 加载画面消失后世界处于暂停，等玩家点回到游戏
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__VOXEL__!.core.tickCount)).toBe(0);
  await resumeGame(page);

  const exited = await page.evaluate(async () => {
    const handle = window.__VOXEL__!;
    // 读完马上退出：快照在退出的第一步同步取完，循环插不进来
    const state = { seed: handle.core.seed, ticks: handle.core.tickCount };
    await handle.exitToList();
    return state;
  });
  await waitForWorldList(page);
  expect(await page.evaluate(() => window.__VOXEL__ ?? null)).toBeNull();
  await expect(page.locator('#game')).toHaveCount(0);
  await expect(entries(page)).toHaveCount(1);
  await expect(page.locator('.world-list__name')).toHaveText(STRINGS.defaultWorldName);
  await expect(page.locator('.world-list__details')).toContainText(
    `${STRINGS.worldSeed} ${exited.seed} · ${DIFFICULTY_NAMES[Difficulty.Normal]} · `,
  );
  const listed = await page.evaluate(() => window.__VOXEL_LIST__!.listWorlds());
  expect(listed.map(({ meta, compatible }) => ({ name: meta.name, seed: meta.seed, compatible }))).toEqual([
    { name: STRINGS.defaultWorldName, seed: exited.seed, compatible: true },
  ]);

  await enterNamed(page, STRINGS.defaultWorldName);
  const restored = await page.evaluate(() => ({
    seed: window.__VOXEL__!.core.seed,
    ticks: window.__VOXEL__!.core.tickCount,
  }));
  expect(restored).toEqual(exited);
  expect(await page.evaluate(() => window.__VOXEL_LIST__ ?? null)).toBeNull();
  expect(errors).toEqual([]);
});

test('新建表单：名称默认「新的世界」，空名称不能创建；整数种子原样使用，其他文本哈希成整数；难度默认普通', async ({
  page,
}) => {
  await page.getByRole('button', { name: STRINGS.newWorld }).click();
  const name = page.getByLabel(STRINGS.worldName);
  const create = page.getByRole('button', { name: STRINGS.createWorld });
  await expect(name).toHaveValue(STRINGS.defaultWorldName);
  await expect(page.getByLabel(STRINGS.worldSeed)).toHaveValue('');
  await expect(page.getByLabel(STRINGS.difficulty)).toHaveValue(Difficulty.Normal);
  await name.fill('   ');
  await expect(create).toBeDisabled();
  await name.fill('世界甲');
  await expect(create).toBeEnabled();
  await page.getByRole('button', { name: STRINGS.cancel }).click();
  await expect(page.locator('.world-list__form')).toBeHidden();

  await createWorld(page, { name: '世界甲', seed: '绿宝石', difficulty: Difficulty.Hard });
  expect(
    await page.evaluate(() => ({ seed: window.__VOXEL__!.core.seed, difficulty: window.__VOXEL__!.core.difficulty })),
  ).toEqual({ seed: seedFromText('绿宝石', () => 0), difficulty: Difficulty.Hard });
  await exitToList(page);

  await createWorld(page, { name: '世界乙', seed: '-12345' });
  expect(await page.evaluate(() => window.__VOXEL__!.core.seed)).toBe(-12345);
  await exitToList(page);
  await expect(entryNamed(page, '世界乙').locator('.world-list__details')).toContainText(
    `${STRINGS.worldSeed} -12345 · ${DIFFICULTY_NAMES[Difficulty.Normal]}`,
  );
  await expect(entryNamed(page, '世界甲').locator('.world-list__details')).toContainText(
    `${STRINGS.worldSeed} ${seedFromText('绿宝石', () => 0)} · ${DIFFICULTY_NAMES[Difficulty.Hard]}`,
  );
  expect(errors).toEqual([]);
});

test('两个世界各挖不同的洞，交替进入互不串；列表按上次游玩倒序', async ({ page }) => {
  // 同一个种子，地形一样，只有挖的洞不同
  const holeA = { x: 3, z: 3 };
  const holeB = { x: -3, z: -3 };

  await createWorld(page, { name: '世界甲', seed: '1' });
  const yA = await digTop(page, holeA.x, holeA.z);
  await exitToList(page);
  await createWorld(page, { name: '世界乙', seed: '1' });
  const yB = await digTop(page, holeB.x, holeB.z);
  await exitToList(page);
  expect(await entryNames(page)).toEqual(['世界乙', '世界甲']);

  await enterNamed(page, '世界甲');
  expect(await blockAt(page, holeA.x, yA, holeA.z)).toBe(BlockType.Air);
  expect(await blockAt(page, holeB.x, yB, holeB.z)).not.toBe(BlockType.Air);
  await exitToList(page);
  expect(await entryNames(page)).toEqual(['世界甲', '世界乙']);

  await enterNamed(page, '世界乙');
  expect(await blockAt(page, holeB.x, yB, holeB.z)).toBe(BlockType.Air);
  expect(await blockAt(page, holeA.x, yA, holeA.z)).not.toBe(BlockType.Air);
  await exitToList(page);
  expect(await entryNames(page)).toEqual(['世界乙', '世界甲']);
  expect(errors).toEqual([]);
});

test('删除要再点一次确认；删掉一个之后另一个照常进入', async ({ page }) => {
  await createWorld(page, { name: '世界甲' });
  await exitToList(page);
  await createWorld(page, { name: '世界乙' });
  await exitToList(page);

  const button = entryNamed(page, '世界甲').locator('.world-list__delete');
  await button.click();
  await expect(button).toHaveText(STRINGS.confirmDelete);
  // 点了一下还没删
  await expect(entries(page)).toHaveCount(2);
  expect(await worldsTable(page)).toHaveLength(2);
  await button.click();
  await expect(entries(page)).toHaveCount(1);
  expect(await entryNames(page)).toEqual(['世界乙']);
  expect((await worldsTable(page)).map(({ name }) => name)).toEqual(['世界乙']);

  await enterNamed(page, '世界乙');
  await exitToList(page);
  await deleteNamed(page, '世界乙');
  await expect(page.locator('.world-list__empty')).toHaveText(STRINGS.noWorlds);
  expect(await worldsTable(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('另一个标签页开着这个世界：进入与删除都被拒并提示「已在另一个标签页打开」；那边退出之后可以删除', async ({
  page,
}) => {
  await createWorld(page, { name: '世界甲' });
  // 进入时的那次写盘提交了，另一个标签页才读得到这个世界
  await expect.poll(async () => (await worldsTable(page)).length).toBe(1);
  const [{ id }] = await worldsTable(page);

  const other = await page.context().newPage();
  await other.goto('/');
  await waitForWorldList(other);
  await expect(entries(other)).toHaveCount(1);
  const message = other.locator('.world-list__message');

  await entryNamed(other, '世界甲').getByRole('button', { name: STRINGS.enterWorld }).click();
  await expect(message).toHaveText(STRINGS.worldInUse);
  await expect(other.locator('#game')).toHaveCount(0);
  await expect(other.locator('#world-list')).toBeVisible();
  expect(await other.evaluate((id) => window.__VOXEL_LIST__!.enterWorld(id), id!)).toBe('locked');

  await deleteNamed(other, '世界甲');
  await expect(message).toHaveText(STRINGS.worldInUse);
  await expect(entries(other)).toHaveCount(1);
  expect(await worldsTable(other)).toHaveLength(1);

  await exitToList(page);
  await deleteNamed(other, '世界甲');
  await expect(entries(other)).toHaveCount(0);
  await expect(message).toBeHidden();
  expect(await worldsTable(other)).toEqual([]);
  await other.close();
  expect(errors).toEqual([]);
});

test('版本不兼容的世界：列表标「版本不兼容」，进入禁用，导出与删除按钮还在', async ({ page }) => {
  const base: WorldMeta = {
    id: 'old-format',
    name: '旧格式',
    seed: 1,
    difficulty: Difficulty.Normal,
    formatVersion: SNAPSHOT_FORMAT_VERSION + 1,
    terrainVersion: TERRAIN_VERSION,
    createdAt: 1,
    lastPlayedAt: 2,
    hardcoreDead: false,
  };
  const metas: WorldMeta[] = [
    base,
    { ...base, id: 'old-terrain', name: '旧地形', formatVersion: SNAPSHOT_FORMAT_VERSION, terrainVersion: TERRAIN_VERSION + 1, lastPlayedAt: 1 },
  ];
  await worldsTable(page, metas);
  await page.reload();
  await waitForWorldList(page);

  await expect(entries(page)).toHaveCount(2);
  for (const { name } of metas) {
    const entry = entryNamed(page, name);
    await expect(entry.locator('.world-list__incompatible')).toHaveText(STRINGS.incompatible);
    await expect(entry.getByRole('button', { name: STRINGS.enterWorld })).toBeDisabled();
    await expect(entry.getByRole('button', { name: STRINGS.exportWorld })).toBeVisible();
    await expect(entry.getByRole('button', { name: STRINGS.deleteEntry })).toBeEnabled();
  }
  expect(await page.evaluate(() => window.__VOXEL_LIST__!.enterWorld('old-format'))).toBe('incompatible');
  await expect(page.locator('#game')).toHaveCount(0);

  await deleteNamed(page, '旧格式');
  await expect(page.locator('.world-list__name')).toHaveText(['旧地形']);
  expect(errors).toEqual([]);
});

test('极限世界摔死：已死亡标记当场写盘，重新打开页面列表里只剩删除；死亡画面上点删除世界回到列表，世界消失', async ({
  page,
}) => {
  await createWorld(page, { name: '世界甲', difficulty: Difficulty.Hardcore });
  await fallToDeath(page);
  await expect.poll(async () => (await worldsTable(page)).map(({ hardcoreDead }) => hardcoreDead)).toEqual([true]);

  // 不退出直接重新打开页面：标记是死亡那一帧写的，不靠退出时的写盘
  await page.reload();
  await waitForWorldList(page);
  const dead = entryNamed(page, '世界甲');
  await expect(dead.getByRole('button')).toHaveText([STRINGS.deleteEntry]);
  const [{ id }] = await worldsTable(page);
  expect(await page.evaluate((id) => window.__VOXEL_LIST__!.enterWorld(id), id!)).toBe('hardcoreDead');
  await waitForWorldList(page);

  // 这一次回到游戏再摔：暂停时死亡画面压在暂停菜单底下，点不到
  await createWorld(page, { name: '世界乙', difficulty: Difficulty.Hardcore });
  await resumeGame(page);
  await fallToDeath(page);
  const button = page.locator('#death-screen button');
  await expect(button).toHaveText(STRINGS.deleteWorld);
  await button.click();
  await waitForWorldList(page);
  await expect(page.locator('#game')).toHaveCount(0);
  expect(await entryNames(page)).toEqual(['世界甲']);
  expect((await worldsTable(page)).map(({ name }) => name)).toEqual(['世界甲']);
  expect(errors).toEqual([]);
});
