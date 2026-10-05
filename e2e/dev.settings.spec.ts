import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { DEFAULT_SEED, TICK_RATE } from '../src/core/constants';
import { PLAYER_WIDTH } from '../src/core/player';
import { DEFAULT_KEY_BINDINGS, keyLabel } from '../src/input/keybindings';
import { SETTINGS_KEY } from '../src/settings';
import { STRINGS } from '../src/ui/strings';
import { createWorld, ignorePause, pressEscape, resumeGame, waitForWorld, waitForWorldList } from './world-list';

/*
 * 设置界面（#69，ADR-0020）。每条测试的浏览器上下文都是新的，localStorage 与 IndexedDB 一开始都是空的。
 */

/** 改跳跃键用的那颗键。 */
const NEW_JUMP_KEY = 'KeyJ';

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

test.afterEach(() => {
  expect(errors).toEqual([]);
});

function settingsScreen(page: Page) {
  return page.locator('#settings');
}

/** 设置界面上一个动作的那颗按键按钮。 */
function binding(page: Page, action: string) {
  return settingsScreen(page).locator(`[data-action="${action}"]`);
}

/** 在世界列表上点「设置」，等设置界面出现。 */
async function openSettingsFromList(page: Page): Promise<void> {
  await page.locator('#world-list').getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page)).toBeVisible();
}

/** 点一项键位，按下 `code`，等那颗按钮换成新键的显示名。 */
async function rebind(page: Page, action: string, code: string): Promise<void> {
  const button = binding(page, action);
  await button.click();
  await expect(button).toHaveText(STRINGS.pressAKey);
  await page.keyboard.press(code);
  await expect(button).toHaveText(keyLabel(code));
}

function loadedChunks(page: Page): Promise<number> {
  return page.evaluate(() => window.__VOXEL__!.core.loadedChunkCount);
}

/** 先落到地上，再推进一秒，返回脚底的起点与这一秒里到过的最高处。 */
function apexOverOneSecond(page: Page): Promise<{ ground: number; apex: number }> {
  return page.evaluate((ticks) => {
    const core = window.__VOXEL__!.core;
    for (let i = 0; i < 10 * ticks && !core.player.onGround; i++) core.tick();
    const ground = core.player.position.y;
    let apex = ground;
    for (let i = 0; i < ticks; i++) {
      core.tick();
      apex = Math.max(apex, core.player.position.y);
    }
    return { ground, apex };
  }, TICK_RATE);
}

/** 视距 r 时以玩家为中心的那一片区块数。 */
const chunksIn = (radius: number) => (2 * radius + 1) ** 2;

/**
 * 不理会暂停、让世界推进到视距内的区块全部到位，再回到暂停菜单。之后锁定指针时不再有区块在生成、在建网格：
 * 无头 Chromium 锁着指针时本来就越来越慢，两件事叠在一起，一秒的 tick 要推进好几秒。
 */
async function settleWorld(page: Page): Promise<void> {
  await ignorePause(page);
  await expect.poll(() => loadedChunks(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(chunksIn(8));
  await page.evaluate(() => window.__VOXEL__!.setIgnorePause(false));
  await expect(page.locator('#pause-menu')).toBeVisible();
}

test('设置里把跳跃改到 J：回到游戏按 J 能跳、按空格不能；关掉页面再打开，设置里仍是 J，进世界按 J 仍能跳', async ({
  page,
}) => {
  // 两次进世界、两次锁定指针。无头 Chromium 锁着指针时每一次按键都比上一次慢，第一次锁定的那几步实测要 4 到 10 秒，
  // 放宽到 60 秒。
  test.setTimeout(60_000);
  await openSettingsFromList(page);
  await rebind(page, 'jump', NEW_JUMP_KEY);
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await expect(settingsScreen(page)).toBeHidden();
  await expect(page.locator('#world-list')).toBeVisible();

  await createWorld(page, { seed: String(DEFAULT_SEED) });
  await settleWorld(page);
  await resumeGame(page);

  await page.keyboard.down(DEFAULT_KEY_BINDINGS.jump);
  const space = await apexOverOneSecond(page);
  await page.keyboard.up(DEFAULT_KEY_BINDINGS.jump);
  expect(space.apex).toBe(space.ground);

  await page.keyboard.down(NEW_JUMP_KEY);
  const j = await apexOverOneSecond(page);
  await page.keyboard.up(NEW_JUMP_KEY);
  expect(j.apex).toBeGreaterThan(j.ground);
  // 无头 Chromium 锁着指针久了越来越慢，验完就放开
  await pressEscape(page);

  await page.reload();
  await waitForWorldList(page);
  await openSettingsFromList(page);
  await expect(binding(page, 'jump')).toHaveText(keyLabel(NEW_JUMP_KEY));
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();

  await page.getByRole('button', { name: STRINGS.enterWorld }).first().click();
  await waitForWorld(page);
  await settleWorld(page);
  await resumeGame(page);
  await page.keyboard.down(NEW_JUMP_KEY);
  const again = await apexOverOneSecond(page);
  await page.keyboard.up(NEW_JUMP_KEY);
  expect(again.apex).toBeGreaterThan(again.ground);
});

test('刚绑上的键按住不放就关掉设置、回到游戏：浏览器连发的按下照常生效，松开之后不再跳', async ({ page }) => {
  await createWorld(page, { seed: String(DEFAULT_SEED) });
  await settleWorld(page);
  await page.locator('#pause-menu').getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page)).toBeVisible();
  const jump = binding(page, 'jump');
  await jump.click();
  await page.keyboard.down(NEW_JUMP_KEY);
  await expect(jump).toHaveText(keyLabel(NEW_JUMP_KEY));
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await resumeGame(page);

  // 同一颗键再按下一次，Playwright 把它当作连发（repeat 为真）
  await page.keyboard.down(NEW_JUMP_KEY);
  const held = await apexOverOneSecond(page);
  expect(held.apex).toBeGreaterThan(held.ground);
  await page.keyboard.up(NEW_JUMP_KEY);
  const released = await apexOverOneSecond(page);
  expect(released.apex).toBe(released.ground);
});

test('两个动作改到同一个键：两行都标红；改开之后都不红。等按键时按 Esc 取消，键不变', async ({ page }) => {
  await openSettingsFromList(page);
  await rebind(page, 'jump', DEFAULT_KEY_BINDINGS.forward);
  const conflicted = settingsScreen(page).locator('.settings__key--conflict');
  await expect(conflicted).toHaveCount(2);
  await expect(binding(page, 'forward')).toHaveAttribute('aria-invalid', 'true');
  await expect(binding(page, 'jump')).toHaveAttribute('aria-invalid', 'true');

  await rebind(page, 'jump', NEW_JUMP_KEY);
  await expect(conflicted).toHaveCount(0);

  const inventory = binding(page, 'inventory');
  await inventory.click();
  await expect(inventory).toHaveText(STRINGS.pressAKey);
  await page.keyboard.press('Escape');
  await expect(inventory).toHaveText(keyLabel(DEFAULT_KEY_BINDINGS.inventory));
  await expect(settingsScreen(page)).toBeVisible();

  // 不在等按键时按 Esc：关掉设置界面
  await page.keyboard.press('Escape');
  await expect(settingsScreen(page)).toBeHidden();
});

test('暂停菜单里打开设置，视距 8 → 4：已加载区块数当场下降；改回 8、回到游戏后回升。关掉设置回到暂停菜单', async ({
  page,
}) => {
  await createWorld(page, { seed: String(DEFAULT_SEED) });
  // 鼠标从没锁过，世界本来就处于暂停，关掉「不理会暂停」之后显示的就是暂停菜单。
  await settleWorld(page);
  const full = await loadedChunks(page);
  const menu = page.locator('#pause-menu');
  await menu.getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page)).toBeVisible();

  const slider = settingsScreen(page).getByLabel(STRINGS.viewRadius);
  await expect(slider).toHaveValue('8');
  await slider.fill('4');
  expect(await page.evaluate(() => window.__VOXEL__!.core.viewRadius)).toBe(4);
  // 卸载线比视距多留一环
  expect(await loadedChunks(page)).toBeLessThanOrEqual(chunksIn(4 + 1));

  await slider.fill('8');
  expect(await page.evaluate(() => window.__VOXEL__!.core.viewRadius)).toBe(8);
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await expect(settingsScreen(page)).toBeHidden();
  await expect(menu).toBeVisible();

  await ignorePause(page);
  await expect.poll(() => loadedChunks(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(full);
});

/** 设置界面上的自动跳跃开关（#78）。 */
function autoJumpToggle(page: Page) {
  return settingsScreen(page).getByLabel(STRINGS.autoJump);
}

/** localStorage 里那条设置 JSON 的自动跳跃一项，没有设置时 undefined。 */
function storedAutoJump(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as { autoJump?: unknown }).autoJump;
  }, SETTINGS_KEY);
}

/**
 * 在玩家正前方（−Z）搭一条 3 格宽的平路，路上前方第三格起垒一格高、八格长的台阶，按住 W 推进 30 tick，返回起点、终点
 * 与台阶的位置。约 10 tick 走到台阶跟前，开着自动跳跃时约第 19 tick 落在台阶上，第 30 tick 还在台阶中段，没走出这段路。
 * 整段在一次同步的 evaluate 里，游戏循环不会在其间执行；世界处于暂停，只有这里推进 tick。不依赖出生点附近的地形：脚下一层
 * 换成石头，脚底往上四格清空，台阶上方因此站得下。
 */
function walkIntoStep(page: Page) {
  return page.evaluate(
    ({ stone, air }) => {
      const core = window.__VOXEL__!.core;
      core.turn(-core.player.yaw, -core.player.pitch);
      const start = core.player.position;
      const bx = Math.floor(start.x);
      const bz = Math.floor(start.z);
      const feet = Math.floor(start.y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = 1; dz >= -10; dz--) {
          core.setBlock(bx + dx, feet - 1, bz + dz, stone);
          for (let dy = 0; dy <= 3; dy++) core.setBlock(bx + dx, feet + dy, bz + dz, air);
        }
        for (let dz = -3; dz >= -10; dz--) core.setBlock(bx + dx, feet, bz + dz, stone);
      }
      core.setMoveIntent({ forward: true, back: false, left: false, right: false, jump: false });
      for (let i = 0; i < 30; i++) core.tick();
      core.setMoveIntent({ forward: false, back: false, left: false, right: false, jump: false });
      // 台阶靠玩家那一面在 z = bz − 2
      return { start, end: core.player.position, feet, stepFace: bz - 2 };
    },
    { stone: BlockType.Stone, air: BlockType.Air },
  );
}

test('自动跳跃默认开：设置里与三个画面开关并列、勾着；进世界后朝一格高的台阶走能上去（#78）', async ({ page }) => {
  await openSettingsFromList(page);
  await expect(autoJumpToggle(page)).toBeChecked();
  // 与三个画面开关同样是一行开关，排在它们后面
  const toggles = settingsScreen(page).locator('.settings__row--toggle input[type="checkbox"]');
  await expect(toggles).toHaveCount(4);
  expect(await toggles.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).name))).toEqual([
    'smoothLighting',
    'flicker',
    'particles',
    'autoJump',
  ]);
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();

  await createWorld(page, { seed: String(DEFAULT_SEED) });
  expect(await page.evaluate(() => window.__VOXEL__!.core.autoJump)).toBe(true);
  const walk = await walkIntoStep(page);
  expect(walk.end.y).toBe(walk.feet + 1);
  expect(walk.end.z).toBeLessThan(walk.stepFace - 1);
});

test('设置里关掉自动跳跃：当场写进 localStorage，重新打开页面仍是关；进世界后朝台阶走被挡住（#78）', async ({ page }) => {
  await openSettingsFromList(page);
  await autoJumpToggle(page).uncheck();
  expect(await storedAutoJump(page)).toBe(false);
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();

  await page.reload();
  await waitForWorldList(page);
  await openSettingsFromList(page);
  await expect(autoJumpToggle(page)).not.toBeChecked();
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();

  await createWorld(page, { seed: String(DEFAULT_SEED) });
  expect(await page.evaluate(() => window.__VOXEL__!.core.autoJump)).toBe(false);
  const walk = await walkIntoStep(page);
  expect(walk.end.y).toBe(walk.feet);
  expect(walk.end.z).toBeCloseTo(walk.stepFace + PLAYER_WIDTH / 2, 6);
});

test('暂停菜单里打开设置切换自动跳跃：核心的开关当场跟着变（#78）', async ({ page }) => {
  await createWorld(page, { seed: String(DEFAULT_SEED) });
  const core = () => page.evaluate(() => window.__VOXEL__!.core.autoJump);
  expect(await core()).toBe(true);
  await page.locator('#pause-menu').getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page)).toBeVisible();

  await autoJumpToggle(page).uncheck();
  expect(await core()).toBe(false);
  await autoJumpToggle(page).check();
  expect(await core()).toBe(true);
  expect(await storedAutoJump(page)).toBe(true);
});
