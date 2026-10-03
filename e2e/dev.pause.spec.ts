import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { ItemType } from '../src/core/item';
import { KEY_BINDINGS } from '../src/input/keybindings';
import { CHUNKS, DB_NAME, WORLDS } from '../src/storage/world-storage';
import { STRINGS } from '../src/ui/strings';
import { createWorld, pressEscape, resumeGame, waitForWorld, waitForWorldList } from './world-list';

/*
 * 暂停与写盘（#68，ADR-0019）。每条测试的浏览器上下文都是新的，IndexedDB 一开始是空的；进入的是一个新建的世界。
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

function pauseMenu(page: Page) {
  return page.locator('#pause-menu');
}

function tickCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__VOXEL__!.core.tickCount);
}

/** 等 500 毫秒，世界没有推进。 */
async function expectStill(page: Page): Promise<void> {
  const before = await tickCount(page);
  await page.waitForTimeout(500);
  expect(await tickCount(page)).toBe(before);
}

/** 这个区块在 IndexedDB 的已改区块表里有没有一条。库里只有一个世界，世界 id 从元数据表取。 */
function chunkStored(page: Page, cx: number, cz: number): Promise<boolean> {
  return page.evaluate(
    async ({ dbName, worlds, chunks, cx, cz }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = <T>(store: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const request = run(db.transaction(store).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [meta] = await read(worlds, (store) => store.getAll());
      const record = await read(chunks, (store) => store.get([(meta as { id: string }).id, cx, cz]));
      db.close();
      return record !== undefined;
    },
    { dbName: DB_NAME, worlds: WORLDS, chunks: CHUNKS, cx, cz },
  );
}

/**
 * 派发一次 beforeunload，返回页面有没有要求离开确认。合成的事件不是 `BeforeUnloadEvent`，`returnValue` 只是布尔，
 * 所以看 `defaultPrevented`：要求确认时处理函数两样都设。
 */
function asksBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('加载画面消失后是暂停菜单，世界不推进；点回到游戏、锁定生效后菜单藏起，世界开始推进', async ({ page }) => {
  const menu = pauseMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: STRINGS.backToGame })).toBeVisible();
  await expect(menu.getByRole('button', { name: STRINGS.settings })).toBeDisabled();
  await expect(menu.getByRole('button', { name: STRINGS.saveAndExit })).toBeVisible();
  await expect(page.locator('#enter-hint')).toHaveCount(0);
  await expectStill(page);
  expect(await tickCount(page)).toBe(0);

  await resumeGame(page);
  await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});

test('挖一块后 Esc：暂停菜单出现、世界停住、那个区块已写进 IndexedDB；回到游戏接着推进；保存并退出，再进入洞还在、掉落物在原位、世界时刻接着', async ({
  page,
}) => {
  await resumeGame(page);
  // 背包塞满泥土再挖脚下那一块：掉出来的泥土收不进背包，留在洞里
  const dug = await page.evaluate(
    ({ dirt, air }) => {
      const core = window.__VOXEL__!.core;
      while (core.giveItem(dirt, 64) === 0);
      core.turn(0, -Math.PI);
      core.tick();
      const { x, y, z } = core.mining.target!;
      core.setMining(true);
      for (let i = 0; i < 200 && core.getBlock(x, y, z) !== air; i++) core.tick();
      core.setMining(false);
      return { x, y, z, cx: Math.floor(x / 16), cz: Math.floor(z / 16), drops: core.drops.count };
    },
    { dirt: ItemType.Dirt, air: BlockType.Air },
  );
  expect(dug.drops).toBe(1);
  expect(await chunkStored(page, dug.cx, dug.cz)).toBe(false);

  await pressEscape(page);
  await expect(pauseMenu(page)).toBeVisible();
  await expectStill(page);
  await expect.poll(() => chunkStored(page, dug.cx, dug.cz)).toBe(true);

  await resumeGame(page);
  await expect(pauseMenu(page)).toBeHidden();
  await pressEscape(page);
  await expect(pauseMenu(page)).toBeVisible();
  const before = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    return {
      timeOfDay: core.timeOfDay,
      ticks: core.tickCount,
      drops: core.drops.all().map(({ position }) => ({ ...position })),
    };
  });

  await pauseMenu(page).getByRole('button', { name: STRINGS.saveAndExit }).click();
  await waitForWorldList(page);
  await page.getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
  await expect(pauseMenu(page)).toBeVisible();
  const after = await page.evaluate(
    ({ x, y, z }) => {
      const core = window.__VOXEL__!.core;
      return {
        block: core.getBlock(x, y, z),
        timeOfDay: core.timeOfDay,
        ticks: core.tickCount,
        drops: core.drops.all().map(({ position }) => ({ ...position })),
      };
    },
    dug,
  );
  expect(after.block).toBe(BlockType.Air);
  expect(after.ticks).toBe(before.ticks);
  expect(after.timeOfDay).toBe(before.timeOfDay);
  expect(after.drops).toHaveLength(1);
  expect(after.drops).toEqual(before.drops);
  expect(errors).toEqual([]);
});

test('按背包键打开背包界面：锁定交还给页面，但不暂停，世界照旧推进', async ({ page }) => {
  await resumeGame(page);
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(page.locator('#inventory-screen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement)).toBe(null);
  const before = await tickCount(page);
  await page.waitForFunction((before) => window.__VOXEL__!.core.tickCount > before + 5, before);
  await expect(pauseMenu(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('背包界面开着时切走标签页：界面当场关掉、光标物品退回原格，然后暂停', async ({ page }) => {
  await page.evaluate((dirt) => window.__VOXEL__!.core.giveItem(dirt, 5), ItemType.Dirt);
  await resumeGame(page);
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(page.locator('#inventory-screen')).toBeVisible();
  // 拿起快捷栏第一格那一堆，放在光标上
  await page.evaluate(() => {
    const { core, hud } = window.__VOXEL__!;
    core.clickSlot(0);
    core.tick();
    hud.update();
  });
  expect(await page.evaluate(() => window.__VOXEL__!.core.inventoryScreen.cursor)).not.toBeNull();

  // 无头浏览器切不走标签页：改写 visibilityState 再派发事件
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(pauseMenu(page)).toBeVisible();
  await expect(page.locator('#inventory-screen')).toBeHidden();
  const state = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    return { cursor: core.inventoryScreen.cursor ?? null, slot: core.inventory.slot(0)?.count, uiMode: core.uiMode };
  });
  expect(state).toEqual({ cursor: null, slot: 5, uiMode: false });
  await expectStill(page);
  expect(errors).toEqual([]);
});

test('离开确认：推进过 tick 或改过方块时要确认；暂停写完盘、没再推进时不要', async ({ page }) => {
  // 进入时写过一次盘，世界还没推进
  await expect.poll(() => asksBeforeLeaving(page)).toBe(false);

  await resumeGame(page);
  expect(await asksBeforeLeaving(page)).toBe(true);

  await pressEscape(page);
  await expect.poll(() => asksBeforeLeaving(page)).toBe(false);

  // 暂停期间调试句柄推进一个 tick
  await page.evaluate(() => window.__VOXEL__!.core.tick());
  expect(await asksBeforeLeaving(page)).toBe(true);
  await page.evaluate(() => window.__VOXEL__!.exitToList());
  await waitForWorldList(page);
  expect(await asksBeforeLeaving(page)).toBe(false);

  // 再进入，只改一块方块、不推进
  await page.getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
  await expect.poll(() => asksBeforeLeaving(page)).toBe(false);
  await page.evaluate(
    ({ air }) => {
      const core = window.__VOXEL__!.core;
      const { x, z } = core.player.position;
      core.setBlock(Math.floor(x) + 2, core.highestBlockY(Math.floor(x) + 2, Math.floor(z)), Math.floor(z), air);
    },
    { air: BlockType.Air },
  );
  expect(await asksBeforeLeaving(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('死亡画面上切走标签页：回来先看到暂停菜单，死亡按钮按不到；点回到游戏，暂停菜单藏起，点得到重生', async ({
  page,
}) => {
  await resumeGame(page);
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
  // 死亡画面那一帧由每帧同步交还鼠标，不算暂停
  await expect.poll(() => page.evaluate(() => document.pointerLockElement)).toBe(null);
  await expect(pauseMenu(page)).toBeHidden();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(pauseMenu(page)).toBeVisible();
  await expect(page.locator('#death-screen')).toBeVisible();
  expect(await page.locator('#death-screen').evaluate((element) => (element as HTMLElement).inert)).toBe(true);

  await pauseMenu(page).getByRole('button', { name: STRINGS.backToGame }).click();
  await expect(pauseMenu(page)).toBeHidden();
  await page.getByRole('button', { name: STRINGS.respawn }).click();
  await expect(page.locator('#death-screen')).toBeHidden();
  expect(errors).toEqual([]);
});
