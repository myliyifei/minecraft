import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { DEFAULT_SEED, TICK_RATE } from '../src/core/constants';
import { Difficulty } from '../src/core/difficulty';
import { PICKUP_DELAY_TICKS } from '../src/core/drop';
import { ItemType } from '../src/core/item';
import { MAX_PITCH } from '../src/core/player';
import type { Vec3 } from '../src/core/vec3';
import { DEFAULT_KEY_BINDINGS, keyLabel } from '../src/input/keybindings';
import { STRINGS } from '../src/ui/strings';
import { changedCells, checkSeventhSliceTerrain, expectStep, stepInPage, type StepReadback } from './seventh-slice';
import { GROUND_ARGS, createWorld, fallToDeath, ignorePause, pressEscape, resumeGame, waitForWorld, waitForWorldList } from './world-list';

/*
 * 第六切片的全流程（#71）：全程在同一个浏览器上下文里，从空的世界列表走到导出再导入，IndexedDB 与 localStorage
 * 一路累积。世界里的动作经调试句柄交给核心，界面上的操作都点真实的按钮。生产构建上的同一条流程在
 * prod.full-flow.spec.ts。
 *
 * 第七切片的全流程（#82）是另一条用例，世界里的各步写在 seventh-slice.ts，与生产构建那条共用。
 */

/** 改跳跃键用的那颗键。 */
const NEW_JUMP_KEY = 'KeyJ';
/** 设置里把视距改成的值。 */
const NEW_VIEW_RADIUS = 4;
/** 午夜。退出再进来还要是夜里。 */
const MIDNIGHT = 18000;

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

function pauseMenu(page: Page) {
  return page.locator('#pause-menu');
}

function settingsScreen(page: Page) {
  return page.locator('#settings');
}

function entries(page: Page) {
  return page.locator('.world-list__entry');
}

/** 名称是这个的那一条。 */
function entryNamed(page: Page, name: string) {
  return entries(page).filter({ has: page.locator('.world-list__name', { hasText: name }) });
}

/** 世界里动过的三格：挖掉的、放了圆石的、插了火把的。 */
interface Spots {
  readonly hole: Vec3;
  readonly cobblestone: Vec3;
  readonly torch: Vec3;
}

/**
 * 回到游戏之后在一次同步的 evaluate 里做完：把世界时刻改到午夜，右键对着地面放一块圆石、插一支火把，空手挖掉脚下那一格（泥土
 * 拾取进背包，经验球被吸收），背包放满泥土后打开背包界面拿起一堆、再放满，关掉界面时那一堆扔在脚下。最后再推进一秒。
 */
function playInWorld(page: Page): Promise<Spots> {
  return page.evaluate(
    ({ items, blocks, maxPitch, pickupTicks, tickRate, midnight, nonSolid, minY }) => {
      const core = window.__VOXEL__!.core;
      core.setTimeOfDay(midnight);
      core.giveItem(items.torch, 4);
      core.giveItem(items.cobblestone, 8);

      /** 对准 (x, y, z) 那一格顶面的中心偏下一点。 */
      const aimAtTop = (x: number, y: number, z: number): void => {
        const eye = core.player.eyePosition;
        const dx = x + 0.5 - eye.x;
        const dy = y + 0.9 - eye.y;
        const dz = z + 0.5 - eye.z;
        core.turn(Math.atan2(-dx, -dz) - core.player.yaw, Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch);
      };
      /** 选第 slot 格，对准 (x, ground, z) 的顶面按使用键，返回放下去的那一格。ground 是这一列最高的实心方块。 */
      const placeOnGround = (slot: number, x: number, z: number): { x: number; y: number; z: number } => {
        let ground = core.highestBlockY(x, z);
        while (ground >= minY && nonSolid.includes(core.getBlock(x, ground, z))) ground--;
        core.selectHotbarSlot(slot);
        aimAtTop(x, ground, z);
        core.tick();
        const target = core.mining.target;
        if (target?.x !== x || target.y !== ground || target.z !== z) throw new Error(`没有对准 ${x},${ground},${z}`);
        core.use();
        core.tick();
        return { x, y: ground + 1, z };
      };

      const px = Math.floor(core.player.position.x);
      const pz = Math.floor(core.player.position.z);
      const cobblestone = placeOnGround(1, px + 2, pz);
      const torch = placeOnGround(0, px, pz + 2);

      // 空手低头挖脚下
      core.selectHotbarSlot(2);
      core.turn(0, -maxPitch - core.player.pitch);
      core.tick();
      const hole = { ...core.mining.target! };
      core.setMining(true);
      for (let i = 0; i < 200 && core.getBlock(hole.x, hole.y, hole.z) !== blocks.air; i++) core.tick();
      core.setMining(false);
      core.tick(pickupTicks + tickRate);

      // 扔：背包一格不剩时，关界面时光标上那一堆掉在脚下
      while (core.giveItem(items.dirt, 64) === 0);
      core.toggleInventory();
      core.tick();
      core.clickSlot(9);
      core.tick();
      core.giveItem(items.dirt, 64);
      core.toggleInventory();
      core.tick(tickRate);
      return { hole, cobblestone, torch };
    },
    {
      items: { torch: ItemType.Torch, cobblestone: ItemType.Cobblestone, dirt: ItemType.Dirt },
      blocks: { air: BlockType.Air },
      maxPitch: MAX_PITCH,
      pickupTicks: PICKUP_DELAY_TICKS,
      tickRate: TICK_RATE,
      midnight: MIDNIGHT,
      ...GROUND_ARGS,
    },
  );
}

/** 再进入之后要一致的：三格方块、世界时刻与 tick、玩家、生命、经验、背包与选中格、掉落物、经验球。 */
function observe(page: Page, spots: Spots) {
  return page.evaluate((spots) => {
    const core = window.__VOXEL__!.core;
    const { position, yaw, pitch } = core.player;
    return {
      blocks: [spots.hole, spots.cobblestone, spots.torch].map(({ x, y, z }) => core.getBlock(x, y, z)),
      ticks: core.tickCount,
      timeOfDay: core.timeOfDay,
      night: core.isNight,
      player: { position: { ...position }, yaw, pitch },
      health: core.health.points,
      experience: core.experience.total,
      inventory: Array.from({ length: core.inventory.size }, (_, i) => {
        const stack = core.inventory.slot(i);
        return stack ? { ...stack } : null;
      }),
      selectedSlot: core.inventory.selectedSlot,
      drops: core.drops.all().map(({ id, item, count, position, age }) => ({ id, item, count, age, position: { ...position } })),
      xpOrbs: core.xpOrbs.all().map(({ id, amount, position, age }) => ({ id, amount, age, position: { ...position } })),
    };
  }, spots);
}

/** 点暂停菜单上的保存并退出，等世界列表显示出来。 */
async function saveAndExit(page: Page): Promise<void> {
  await pauseMenu(page).getByRole('button', { name: STRINGS.saveAndExit }).click();
  await waitForWorldList(page);
}

/** 点 id 是这个的那一条的「进入」，等加载画面消失。导入的世界与原世界同名，只能按 id 找。 */
async function enterId(page: Page, id: string): Promise<void> {
  await page.locator(`.world-list__entry[data-id="${id}"]`).getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
}

async function entryIds(page: Page): Promise<string[]> {
  return entries(page).evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.id!));
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

test('全流程：空列表新建世界，挖、放、扔、插火把后 Esc，保存并退出再进入一致；另一个标签页进不去；导出再导入一致；极限死亡删除世界；设置改键位与视距生效并保留', async ({
  page,
}) => {
  // 三次锁定指针、六次进入世界。无头 Chromium 锁着指针时越来越慢，每次锁定都尽快放开。
  test.setTimeout(180_000);

  // 列表为空 → 新建 → 加载画面之后是暂停菜单，世界时刻为 0
  await expect(page.locator('.world-list__empty')).toHaveText(STRINGS.noWorlds);
  await createWorld(page, { name: '全流程', seed: String(DEFAULT_SEED) });
  await expect(pauseMenu(page)).toBeVisible();
  expect(await page.evaluate(() => [window.__VOXEL__!.core.tickCount, window.__VOXEL__!.core.timeOfDay])).toEqual([0, 0]);

  // 回到游戏，挖、放、扔、插火把，Esc：暂停菜单出现，世界停住
  await resumeGame(page);
  const spots = await playInWorld(page);
  await pressEscape(page);
  await expect(pauseMenu(page)).toBeVisible();
  const before = await observe(page, spots);
  expect(before.blocks).toEqual([BlockType.Air, BlockType.Cobblestone, BlockType.Torch]);
  expect(before.night).toBe(true);
  expect(before.experience).toBeGreaterThan(0);
  expect(before.drops.some(({ item, count }) => item === ItemType.Dirt && count === 64)).toBe(true);
  expect(before.inventory.slice(0, 3)).toEqual([
    { item: ItemType.Torch, count: 3 },
    { item: ItemType.Cobblestone, count: 7 },
    { item: ItemType.Dirt, count: 64 },
  ]);
  await page.waitForTimeout(500);
  expect(await observe(page, spots)).toEqual(before);

  // 保存并退出 → 再进入：洞、方块、掉落物、火把、世界时刻、背包、经验都与退出前相同
  await saveAndExit(page);
  await expect(entries(page)).toHaveCount(1);
  const [originalId] = await entryIds(page);
  await enterId(page, originalId!);
  await expect(pauseMenu(page)).toBeVisible();
  expect(await observe(page, spots)).toEqual(before);

  // 另一个标签页进入同一个世界：被拒，提示已在另一个标签页打开
  const other = await page.context().newPage();
  await other.goto('/');
  await waitForWorldList(other);
  await entryNamed(other, '全流程').getByRole('button', { name: STRINGS.enterWorld }).click();
  await expect(other.locator('.world-list__message')).toHaveText(STRINGS.worldInUse);
  await expect(other.locator('#game')).toHaveCount(0);
  await other.close();

  // 导出再导入：列表多一条同名世界，进入后与原世界一致
  await saveAndExit(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    entryNamed(page, '全流程').getByRole('button', { name: STRINGS.exportWorld }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('全流程.voxelworld');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: STRINGS.importWorld }).click(),
  ]);
  await chooser.setFiles(await download.path());
  await expect(entries(page)).toHaveCount(2);
  const [copyId] = (await entryIds(page)).filter((id) => id !== originalId);
  await enterId(page, copyId!);
  expect(await observe(page, spots)).toEqual(before);
  await saveAndExit(page);

  // 极限世界摔死：死亡画面只有删除世界，点了回到列表，这个世界不在了
  await createWorld(page, { name: '极限', difficulty: Difficulty.Hardcore });
  await resumeGame(page);
  await fallToDeath(page);
  const deathButtons = page.locator('#death-screen button');
  await expect(deathButtons).toHaveText([STRINGS.deleteWorld]);
  await deathButtons.click();
  await waitForWorldList(page);
  expect(new Set(await entryIds(page))).toEqual(new Set([originalId, copyId]));

  // 暂停菜单里打开设置：跳跃改到 J、视距改到 4。远处区块当场卸载，回到游戏按 J 能跳、按空格不能
  await enterId(page, originalId!);
  await pauseMenu(page).getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page)).toBeVisible();
  const jump = settingsScreen(page).locator('[data-action="jump"]');
  await jump.click();
  await expect(jump).toHaveText(STRINGS.pressAKey);
  await page.keyboard.press(NEW_JUMP_KEY);
  await expect(jump).toHaveText(keyLabel(NEW_JUMP_KEY));
  await settingsScreen(page).getByLabel(STRINGS.viewRadius).fill(String(NEW_VIEW_RADIUS));
  const shrunk = await page.evaluate(() => ({
    viewRadius: window.__VOXEL__!.core.viewRadius,
    loaded: window.__VOXEL__!.core.loadedChunkCount,
  }));
  expect(shrunk.viewRadius).toBe(NEW_VIEW_RADIUS);
  // 卸载线比视距多留一环
  expect(shrunk.loaded).toBeLessThanOrEqual((2 * (NEW_VIEW_RADIUS + 1) + 1) ** 2);
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await expect(settingsScreen(page)).toBeHidden();

  await resumeGame(page);
  await page.keyboard.down(DEFAULT_KEY_BINDINGS.jump);
  const withSpace = await apexOverOneSecond(page);
  await page.keyboard.up(DEFAULT_KEY_BINDINGS.jump);
  await page.keyboard.down(NEW_JUMP_KEY);
  const withJ = await apexOverOneSecond(page);
  await page.keyboard.up(NEW_JUMP_KEY);
  await pressEscape(page);
  expect(withSpace.apex).toBe(withSpace.ground);
  expect(withJ.apex).toBeGreaterThan(withJ.ground);

  // 关掉页面再打开：设置仍是 J 与 4，进入世界视距是 4
  await page.reload();
  await waitForWorldList(page);
  await page.locator('#world-list').getByRole('button', { name: STRINGS.settings }).click();
  await expect(settingsScreen(page).locator('[data-action="jump"]')).toHaveText(keyLabel(NEW_JUMP_KEY));
  await expect(settingsScreen(page).getByLabel(STRINGS.viewRadius)).toHaveValue(String(NEW_VIEW_RADIUS));
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await enterId(page, originalId!);
  expect(await page.evaluate(() => window.__VOXEL__!.core.viewRadius)).toBe(NEW_VIEW_RADIUS);
  expect(errors).toEqual([]);
});

/** 不理会暂停、等出生列周围 3×3 个区块（全流程走到的地方都在里面）到位，再回到暂停菜单。之后世界只由同步的 tick 推进。 */
async function settleAroundSpawn(page: Page): Promise<void> {
  await ignorePause(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const core = window.__VOXEL__!.core;
          for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) if (!core.isChunkLoaded(cx, cz)) return false;
          return true;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(() => window.__VOXEL__!.setIgnorePause(false));
  await expect(pauseMenu(page)).toBeVisible();
}

/** 画一帧，读回 `sky`：眼睛在不在水下、雾开没开。 */
function skyAfterRender(page: Page): Promise<{ underwater: boolean; fogEnabled: boolean }> {
  return page.evaluate(() => {
    const { renderer } = window.__VOXEL__!;
    renderer.render(1);
    const { underwater, fogEnabled } = renderer.sky;
    return { underwater, fogEnabled };
  });
}

/** 再进入之后要一致的：改过的几格、tick、玩家、背包与选中格、掉落物。 */
function observeSeventh(page: Page, cells: readonly Vec3[]) {
  return page.evaluate((cells) => {
    const core = window.__VOXEL__!.core;
    const { position, yaw, pitch } = core.player;
    return {
      blocks: cells.map(({ x, y, z }) => core.getBlock(x, y, z)),
      ticks: core.tickCount,
      player: { position: { ...position }, yaw, pitch },
      inventory: Array.from({ length: core.inventory.size }, (_, i) => {
        const stack = core.inventory.slot(i);
        return stack ? { ...stack } : null;
      }),
      selectedSlot: core.inventory.selectedSlot,
      drops: core.drops.all().map(({ id, item, count, position, age }) => ({ id, item, count, age, position: { ...position } })),
    };
  }, cells);
}

test('第七切片全流程：新建世界出生在平原的草方块上，走进水塘沉到水下（sky 报告在水下、雾开启），往水里放圆石，挖冰变水，挖花再种下，砍白桦用白桦木板与橡木板合成工作台，自动跳跃上台阶；保存并退出再进入、导出再导入，改动都在原处（#82）', async ({
  page,
}) => {
  // 不锁定指针：世界里的每一步都在一次同步的 evaluate 里推进 tick（seventh-slice.ts）
  test.setTimeout(60_000);
  const terrain = checkSeventhSliceTerrain();

  // 新建世界：出生点是 Node 里地形对象算出的出生列（平原、列顶草方块）最高实心方块的顶面
  await createWorld(page, { name: '第七切片', seed: String(DEFAULT_SEED) });
  await expect(pauseMenu(page)).toBeVisible();
  await settleAroundSpawn(page);
  const spawn = await page.evaluate(
    ({ x, y, z }) => {
      const core = window.__VOXEL__!.core;
      return { position: { ...core.player.position }, ground: core.getBlock(Math.floor(x), y - 1, Math.floor(z)) };
    },
    terrain.spawn,
  );
  expect(spawn.position).toEqual(terrain.spawn);
  expect(spawn.ground).toBe(BlockType.Grass);
  expect(await skyAfterRender(page)).toEqual({ underwater: false, fogEnabled: false });

  // 走到水边游进去，沉到塘底：sky 读回报告在水下，雾开启
  const swim = await stepInPage(page, 'swimToPondCenter');
  expectStep.swimToPondCenter(swim, terrain);
  expect(await skyAfterRender(page)).toEqual({ underwater: true, fogEnabled: true });

  const steps: Record<string, StepReadback> = {};
  for (const name of ['placeInWater', 'climbOutEast', 'mineIce', 'pickFlower', 'chopBirch', 'craftTable'] as const) {
    steps[name] = await stepInPage(page, name);
    expectStep[name](steps[name]!, terrain);
  }
  // 出水之后不再在水下
  expect(await skyAfterRender(page)).toEqual({ underwater: false, fogEnabled: false });

  // 自动跳跃：搭一格高的台阶，朝它走，脚底高一格、走过了台阶那一面
  const step = expectStep.buildStep(await stepInPage(page, 'buildStep'));
  const walked = await stepInPage(page, 'walkUpStep');
  expect(walked.position.y).toBe(step.feet + 1);
  expect(walked.position.z).toBeLessThan(step.stepFace - 1);

  const changed = changedCells(terrain, step);
  const cells = Object.values(changed).map(({ cell }) => cell);
  const before = await observeSeventh(page, cells);
  expect(Object.fromEntries(Object.keys(changed).map((name, i) => [name, before.blocks[i]]))).toEqual(
    Object.fromEntries(Object.entries(changed).map(([name, { block }]) => [name, block])),
  );

  // 保存并退出再进入：改动都在原处
  await saveAndExit(page);
  const [originalId] = await entryIds(page);
  await enterId(page, originalId!);
  await expect(pauseMenu(page)).toBeVisible();
  expect(await observeSeventh(page, cells)).toEqual(before);

  // 导出再导入：副本进入后与原世界相同
  await saveAndExit(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    entryNamed(page, '第七切片').getByRole('button', { name: STRINGS.exportWorld }).click(),
  ]);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: STRINGS.importWorld }).click(),
  ]);
  await chooser.setFiles(await download.path());
  await expect(entries(page)).toHaveCount(2);
  const [copyId] = (await entryIds(page)).filter((id) => id !== originalId);
  await enterId(page, copyId!);
  expect(await observeSeventh(page, cells)).toEqual(before);
  expect(errors).toEqual([]);
});
