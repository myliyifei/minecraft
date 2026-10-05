import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { BlockType, isSolid } from '../src/core/block';
import { blockIndex } from '../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, TICK_RATE, WORLD_MIN_Y } from '../src/core/constants';
import { Difficulty } from '../src/core/difficulty';
import { PICKUP_DELAY_TICKS } from '../src/core/drop';
import { GameCore } from '../src/core/game';
import { ItemType } from '../src/core/item';
import { MAX_PITCH } from '../src/core/player';
import type { Snapshot } from '../src/core/snapshot';
import type { Vec3 } from '../src/core/vec3';
import { DEFAULT_KEY_BINDINGS, keyLabel } from '../src/input/keybindings';
import { gunzipChunk } from '../src/storage/chunk-codec';
import { decodeWorldBlob, encodeWorldFile, type WorldFile } from '../src/storage/world-file';
import { STRINGS } from '../src/ui/strings';
import { worldFileOf } from '../tests/helpers/world-file';
import { changedCells, checkSeventhSliceTerrain, expectStep, SEVENTH_SLICE_ARGS, seventhSliceSteps } from './seventh-slice';
import { createWorld, pressEscape, waitForWorld, waitForWorldList } from './world-list';

/*
 * 第六切片的全流程跑在生产构建的预览上（#71）。生产构建没有调试句柄，读不到核心，而无头 Chromium 锁着指针时
 * 越来越慢，用真实鼠标挖放既慢又对不准。所以世界里的动作（挖、放、扔、插火把、把世界时刻改到夜里）在 Node 里用同一份核心
 * 做好，编码成导出文件，经界面导入；要比对的状态一律经界面导出、在 Node 里解码。界面上的操作都点真实的按钮。
 *
 * 第七切片的全流程（#82）同样做法：游水塘、往水里放方块、挖冰、挖花再种下、砍白桦合成工作台在 Node 里用 seventh-slice.ts 的
 * 步骤函数做（与 dev 那条同一组），自动跳跃上台阶用真实按键在生产构建里走；另导入一个玩家被白桦树叶围住的世界，用真实鼠标
 * 挖掉树叶，检验生产构建里真实输入改动的方块能写盘。水下雾要读渲染器的 `sky`，生产构建读不到，只在 dev 里核对。
 */

/** 改跳跃键用的那颗键。 */
const NEW_JUMP_KEY = 'KeyJ';
/** 设置里把视距改成的值。 */
const NEW_VIEW_RADIUS = 4;
/** 午夜。 */
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

function entryWithId(page: Page, id: string) {
  return page.locator(`.world-list__entry[data-id="${id}"]`);
}

async function entryIds(page: Page): Promise<string[]> {
  return entries(page).evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.id!));
}

async function enterId(page: Page, id: string): Promise<void> {
  await entryWithId(page, id).getByRole('button', { name: STRINGS.enterWorld }).click();
  await waitForWorld(page);
  await expect(pauseMenu(page)).toBeVisible();
}

async function saveAndExit(page: Page): Promise<void> {
  await pauseMenu(page).getByRole('button', { name: STRINGS.saveAndExit }).click();
  await waitForWorldList(page);
}

/** 点回到游戏，等指针锁定生效：生产构建里读不到 tick，暂停菜单藏起就是暂停解除了。 */
async function resume(page: Page): Promise<void> {
  await pauseMenu(page).getByRole('button', { name: STRINGS.backToGame }).click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('game');
  await expect(pauseMenu(page)).toBeHidden();
}

/** 点这一条的「导出」，在 Node 里解码下载的文件。 */
async function exportId(page: Page, id: string): Promise<WorldFile> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    entryWithId(page, id).getByRole('button', { name: STRINGS.exportWorld }).click(),
  ]);
  const decoded = await decodeWorldBlob(new Blob([await readFile(await download.path())]));
  if (!decoded.ok) throw new Error(`导出的文件解不开：${decoded.reason}`);
  return decoded.file;
}

/** 把快照编码成导出文件写到测试的输出目录，经界面导入，返回新多出来的那一条的 id。 */
async function importSnapshot(page: Page, testInfo: TestInfo, snapshot: Snapshot, name: string): Promise<string> {
  const encoded = encodeWorldFile(await worldFileOf(snapshot, name));
  if (!encoded.ok) throw new Error(encoded.reason);
  const path = testInfo.outputPath(`${name}.voxelworld`);
  await writeFile(path, new Uint8Array(encoded.buffer));
  const known = new Set(await entryIds(page));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: STRINGS.importWorld }).click(),
  ]);
  await chooser.setFiles(path);
  await expect(entries(page)).toHaveCount(known.size + 1);
  return (await entryIds(page)).find((id) => !known.has(id))!;
}

/** 比对用：区块解压、按坐标排好，元数据去掉上次游玩时间。 */
async function comparable({ meta, state, blockStates, chunks }: WorldFile) {
  const { lastPlayedAt: _, ...rest } = meta;
  const sorted = [...chunks].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  return {
    meta: rest,
    state,
    blockStates,
    chunks: await Promise.all(sorted.map(async ({ cx, cz, data }) => ({ cx, cz, blocks: Buffer.from(await gunzipChunk(data)) }))),
  };
}

/** 默认种子的平原，周围的区块都加载好。 */
function newCore(difficulty: Difficulty): GameCore {
  const core = new GameCore({ seed: DEFAULT_SEED, difficulty, viewRadius: 2 });
  core.tick(TICK_RATE);
  return core;
}

/**
 * 在 Node 里玩过的世界：午夜，玩家身边放一块圆石、插一支火把，空手挖掉脚下那一格（泥土拾取进背包、经验球被吸收），
 * 背包放满泥土后打开背包界面拿起一堆、再放满，关界面时那一堆扔在脚下。与 dev.full-flow.spec.ts 做的是同样的事，
 * 放方块直接写进世界：右键对准放置的那一步在 dev 的全流程里。
 *
 * 另放一座熔炉，装好粗铁与煤炭但还没推进：回到游戏的第一个 tick 它点火，方块换成燃烧中的熔炉，那个区块从此算改过，
 * 下次写盘要经压缩 Worker 压。导入的区块本身不算改过，不放它的话生产构建上的写盘一个区块都不压。
 */
/** 这一列最高的实心方块的 y：地表植物（#80）不是地面。 */
function groundY(core: GameCore, x: number, z: number): number {
  let y = core.highestBlockY(x, z);
  while (y >= WORLD_MIN_Y && !isSolid(core.getBlock(x, y, z))) y--;
  return y;
}

function playedSnapshot(): { snapshot: Snapshot; furnace: Vec3 } {
  const core = newCore(Difficulty.Normal);
  core.setTimeOfDay(MIDNIGHT);
  core.giveItem(ItemType.Torch, 3);
  core.giveItem(ItemType.Cobblestone, 7);
  const px = Math.floor(core.player.position.x);
  const pz = Math.floor(core.player.position.z);
  core.setBlock(px + 2, groundY(core, px + 2, pz) + 1, pz, BlockType.Cobblestone);
  core.setBlock(px, groundY(core, px, pz + 2) + 1, pz + 2, BlockType.Torch);

  core.selectHotbarSlot(2);
  core.turn(0, -MAX_PITCH);
  core.tick();
  const hole = { ...core.mining.target! };
  core.setMining(true);
  for (let i = 0; i < 200 && core.getBlock(hole.x, hole.y, hole.z) !== BlockType.Air; i++) core.tick();
  core.setMining(false);
  core.tick(PICKUP_DELAY_TICKS + TICK_RATE);

  while (core.giveItem(ItemType.Dirt, 64) === 0);
  core.toggleInventory();
  core.tick();
  core.clickSlot(9);
  core.tick();
  core.giveItem(ItemType.Dirt, 64);
  core.toggleInventory();
  core.tick(TICK_RATE);

  const furnace = { x: px - 2, y: groundY(core, px - 2, pz) + 1, z: pz };
  core.setBlock(furnace.x, furnace.y, furnace.z, BlockType.Furnace);
  const state = core.blockStateAt(furnace.x, furnace.y, furnace.z)!;
  state.input = { item: ItemType.RawIron, count: 8 };
  state.fuel = { item: ItemType.Coal, count: 1 };

  const snapshot = core.snapshot();
  expect(snapshot.drops.length).toBeGreaterThan(0);
  expect(snapshot.player.experience).toBeGreaterThan(0);
  expect(snapshot.editedChunks.length).toBeGreaterThan(0);
  return { snapshot, furnace };
}

/** 导出文件里 (x, y, z) 那一格的方块编号。 */
async function blockIn(file: WorldFile, { x, y, z }: Vec3): Promise<BlockType | undefined> {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const chunk = file.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (!chunk) return undefined;
  const blocks = await gunzipChunk(chunk.data);
  return blocks[blockIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)] as BlockType;
}

/** 极限世界，玩家在出生点上方 30 格：回到游戏就摔死。 */
function fallingHardcoreSnapshot(): Snapshot {
  const snapshot = newCore(Difficulty.Hardcore).snapshot();
  const { position } = snapshot.player;
  const high = { ...position, y: position.y + 30 };
  return { ...snapshot, player: { ...snapshot.player, position: high, fallHighest: high.y } };
}

test('生产构建的全流程：设置改键位与视距并保留；新建世界回到游戏、Esc、保存并退出，再进入一致，另一个标签页进不去；导入玩过的世界再导出一致，回到游戏后熔炉点火、经压缩 Worker 写盘；极限世界摔死后删除', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  // 列表为空。设置里改跳跃键与视距，关掉页面再打开仍在
  await expect(page.locator('.world-list__empty')).toHaveText(STRINGS.noWorlds);
  await page.locator('#world-list').getByRole('button', { name: STRINGS.settings }).click();
  const jump = settingsScreen(page).locator('[data-action="jump"]');
  await jump.click();
  await expect(jump).toHaveText(STRINGS.pressAKey);
  await page.keyboard.press(NEW_JUMP_KEY);
  await expect(jump).toHaveText(keyLabel(NEW_JUMP_KEY));
  await settingsScreen(page).getByLabel(STRINGS.viewRadius).fill(String(NEW_VIEW_RADIUS));
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();
  await page.reload();
  await waitForWorldList(page);
  await page.locator('#world-list').getByRole('button', { name: STRINGS.settings }).click();
  await expect(jump).toHaveText(keyLabel(NEW_JUMP_KEY));
  await expect(settingsScreen(page).getByLabel(STRINGS.viewRadius)).toHaveValue(String(NEW_VIEW_RADIUS));
  await settingsScreen(page).getByRole('button', { name: STRINGS.done }).click();

  // 新建 → 暂停菜单 → 回到游戏推进一会儿 → Esc 暂停 → 保存并退出
  await createWorld(page, { name: '新建的世界', seed: String(DEFAULT_SEED) });
  await expect(pauseMenu(page)).toBeVisible();
  await resume(page);
  await page.waitForTimeout(1000);
  await pressEscape(page);
  await expect(pauseMenu(page)).toBeVisible();
  await saveAndExit(page);
  const [createdId] = await entryIds(page);
  const played = await exportId(page, createdId!);
  expect(played.state.ticks).toBeGreaterThan(0);
  expect(played.meta.seed).toBe(DEFAULT_SEED);

  // 再进入：另一个标签页进不去。不回到游戏直接保存并退出，导出的与上次完全相同
  await enterId(page, createdId!);
  const other = await page.context().newPage();
  await other.goto('/');
  await waitForWorldList(other);
  await entryWithId(other, createdId!).getByRole('button', { name: STRINGS.enterWorld }).click();
  await expect(other.locator('.world-list__message')).toHaveText(STRINGS.worldInUse);
  await expect(other.locator('#game')).toHaveCount(0);
  await other.close();
  await saveAndExit(page);
  expect(await comparable(await exportId(page, createdId!))).toEqual(await comparable(played));

  // 导入在 Node 里玩过的世界：进入、保存并退出、导出，洞、方块、火把、掉落物、世界时刻、背包、经验都一致
  const { snapshot, furnace } = playedSnapshot();
  const original = await worldFileOf(snapshot, '玩过的世界');
  const importedId = await importSnapshot(page, testInfo, snapshot, '玩过的世界');
  await enterId(page, importedId);
  await saveAndExit(page);
  // 导入沿用文件里的创建时间，写盘时保留第一次写的，所以元数据只有上次游玩时间不同
  expect(await comparable(await exportId(page, importedId))).toEqual(await comparable(original));

  // 再进入、回到游戏：熔炉点火，那个区块经压缩 Worker 写盘。导出的文件里那一格是燃烧中的熔炉
  await enterId(page, importedId);
  await resume(page);
  await page.waitForTimeout(1000);
  await pressEscape(page);
  await expect(pauseMenu(page)).toBeVisible();
  await saveAndExit(page);
  const lit = await exportId(page, importedId);
  expect(await blockIn(original, furnace)).toBe(BlockType.Furnace);
  expect(await blockIn(lit, furnace)).toBe(BlockType.LitFurnace);
  expect(lit.state.ticks).toBeGreaterThan(snapshot.ticks);

  // 极限世界摔死：死亡画面只有删除世界，点了回到列表，这个世界不在了
  const hardcoreId = await importSnapshot(page, testInfo, fallingHardcoreSnapshot(), '极限');
  await enterId(page, hardcoreId);
  await resume(page);
  const deathButtons = page.locator('#death-screen button');
  await expect(deathButtons).toHaveText([STRINGS.deleteWorld], { timeout: 20_000 });
  await deathButtons.click();
  await waitForWorldList(page);
  expect(new Set(await entryIds(page))).toEqual(new Set([createdId, importedId]));
  expect(errors).toEqual([]);
});

/**
 * 朝台阶走时每一段按住前进键的时长（毫秒）。无头 Chromium 锁着指针时 tick 推进慢于实时，一段走多远不确定，
 * 所以分段走：每段之后暂停、保存并退出、导出，读位置，直到站上台阶为止。一段至多走 1.7 格，台阶上层铺了 8 格，
 * 站上台阶之后至多再多走一段，不会走过上层的尽头。
 */
const WALK_SEGMENT_MS = 400;
/** 每段松开前进键之后、暂停之前留给落地的时长（毫秒）。是否站上台阶以导出的位置为准，不以这段时长为准。 */
const LAND_MS = 300;
/** 每一段按住左键的时长（毫秒）。空手挖白桦树叶要 6 tick，锁着指针时 tick 推进慢，留足余量。 */
const MINE_SEGMENT_MS = 1500;
/** 分段走台阶与按住左键挖树叶的总时长上限（毫秒）。 */
const REAL_INPUT_TIMEOUT_MS = 60_000;

/**
 * 进入世界、回到游戏，做一段真实输入（act），暂停、保存并退出、导出，直到 done 对导出的文件成立；超过总时长报错。
 * 生产构建读不到核心，世界的状态只能这样读。
 */
async function repeatUntil(
  page: Page,
  id: string,
  act: () => Promise<void>,
  done: (file: WorldFile) => boolean | Promise<boolean>,
  describe: (file: WorldFile) => string,
): Promise<WorldFile> {
  const deadline = Date.now() + REAL_INPUT_TIMEOUT_MS;
  for (;;) {
    await enterId(page, id);
    await resume(page);
    await act();
    await pressEscape(page);
    await expect(pauseMenu(page)).toBeVisible();
    await saveAndExit(page);
    const file = await exportId(page, id);
    if (await done(file)) return file;
    if (Date.now() > deadline) throw new Error(`${REAL_INPUT_TIMEOUT_MS} 毫秒内没有达到预期：${describe(file)}`);
  }
}

/** 一层树叶围住玩家的那些格：玩家所在那一列周围 3×3、从脚下一格到头顶上方一格，去掉玩家身体占的两格。 */
function leafShell(feet: Vec3): Vec3[] {
  const bx = Math.floor(feet.x);
  const by = Math.floor(feet.y);
  const bz = Math.floor(feet.z);
  const cells: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue;
        cells.push({ x: bx + dx, y: by + dy, z: bz + dz });
      }
    }
  }
  return cells;
}

/**
 * 玩家被一层白桦树叶围住的世界：从眼睛往任何方向，触及距离以内第一个碰到的都是一格树叶。指针锁定下 Playwright 的
 * mouse.down 会连带投递一次大位移的 mousemove，视线朝哪不确定；这样不论朝哪，按住左键挖到的都是树叶。
 */
function leafShellSnapshot(): { snapshot: Snapshot; shell: Vec3[] } {
  const core = newCore(Difficulty.Normal);
  const shell = leafShell(core.player.position);
  for (const { x, y, z } of shell) core.setBlock(x, y, z, BlockType.BirchLeaves);
  core.tick();
  return { snapshot: core.snapshot(), shell };
}

/**
 * 在 Node 里用同一份核心把第七切片全流程在世界里的各步做完（与 dev 全流程同一组步骤函数），每一步按同样的断言核对，
 * 最后停在台阶前面朝它：自动跳跃那一步留给生产构建里的真实按键。
 */
function seventhSlicePlayed() {
  const terrain = checkSeventhSliceTerrain();
  const core = newCore(Difficulty.Normal);
  expect({ ...core.player.position }).toEqual(terrain.spawn);
  const steps = seventhSliceSteps(core, SEVENTH_SLICE_ARGS);
  expectStep.swimToPondCenter(steps.swimToPondCenter(), terrain);
  for (const name of ['placeInWater', 'climbOutEast', 'mineIce', 'pickFlower', 'chopBirch', 'craftTable'] as const) {
    expectStep[name](steps[name](), terrain);
  }
  const step = expectStep.buildStep(steps.buildStep());
  return { terrain, step, snapshot: core.snapshot() };
}

test('生产构建的第七切片全流程：新建世界出生在平原的草方块上；导入在 Node 里游过水塘、往水里放圆石、挖冰、挖花再种下、砍白桦合成工作台的世界，回到游戏按住前进键自动跳上台阶；保存并退出再进入、导出再导入，改动都在原处；被白桦树叶围住时按住左键挖掉树叶，保存并退出再进入后仍是空气（#82）', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  // 新建世界、保存并退出、导出：玩家在 Node 里地形对象算出的出生点（平原、列顶草方块）
  const { terrain, step, snapshot } = seventhSlicePlayed();
  await createWorld(page, { name: '新建的第七切片', seed: String(DEFAULT_SEED) });
  await expect(pauseMenu(page)).toBeVisible();
  await saveAndExit(page);
  const [createdId] = await entryIds(page);
  const created = await exportId(page, createdId!);
  expect(created.state.player.position).toEqual(terrain.spawn);

  // 导入在 Node 里玩过的世界，回到游戏按住前进键朝台阶走：脚底高了一格、走过了台阶那一面
  const importedId = await importSnapshot(page, testInfo, snapshot, '第七切片');
  // 走多远由帧率决定，只要求站到了台阶上：脚底正好高一格（在空中时脚底不会正好落在整数上），碰撞箱中心越过了台阶那一面
  const onStep = ({ state: { player } }: WorldFile): boolean =>
    player.position.y === step.feet + 1 && player.position.z < step.stepFace;
  const walked = await repeatUntil(
    page,
    importedId,
    async () => {
      await page.keyboard.down(DEFAULT_KEY_BINDINGS.forward);
      await page.waitForTimeout(WALK_SEGMENT_MS);
      await page.keyboard.up(DEFAULT_KEY_BINDINGS.forward);
      await page.waitForTimeout(LAND_MS);
    },
    onStep,
    ({ state: { player } }) => `没有站上台阶，停在 ${JSON.stringify(player.position)}`,
  );
  expect(walked.state.ticks).toBeGreaterThan(snapshot.ticks);

  // 改过的几格都在导出的文件里
  const changed = changedCells(terrain, step);
  const expected = Object.fromEntries(Object.entries(changed).map(([name, { block }]) => [name, block]));
  const blocksIn = async (file: WorldFile) =>
    Object.fromEntries(await Promise.all(Object.entries(changed).map(async ([name, { cell }]) => [name, await blockIn(file, cell)] as const)));
  expect(await blocksIn(walked)).toEqual(expected);

  // 保存并退出再进入（不回到游戏）：导出的与上次完全相同
  await enterId(page, importedId);
  await saveAndExit(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    entryWithId(page, importedId).getByRole('button', { name: STRINGS.exportWorld }).click(),
  ]);
  const exportedPath = await download.path();
  const reentered = await decodeWorldBlob(new Blob([await readFile(exportedPath)]));
  if (!reentered.ok) throw new Error(reentered.reason);
  expect(await comparable(reentered.file)).toEqual(await comparable(walked));

  // 导出再导入：把刚下载的文件导入，副本进入、保存并退出再导出，与原世界相同
  const known = new Set(await entryIds(page));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: STRINGS.importWorld }).click()]);
  await chooser.setFiles(exportedPath);
  await expect(entries(page)).toHaveCount(known.size + 1);
  const copyId = (await entryIds(page)).find((id) => !known.has(id))!;
  await enterId(page, copyId);
  await saveAndExit(page);
  const copy = await exportId(page, copyId);
  expect(await comparable(copy)).toEqual(await comparable(walked));
  expect(await blocksIn(copy)).toEqual(expected);

  // 生产构建里用真实鼠标改一格方块：玩家被一层白桦树叶围住，按住左键挖，保存并退出后导出，有树叶变成了空气；
  // 再进入、保存并退出再导出，挖掉的仍是空气
  const { snapshot: shelled, shell } = leafShellSnapshot();
  const shellId = await importSnapshot(page, testInfo, shelled, '树叶');
  const minedIn = async (file: WorldFile): Promise<Vec3[]> => {
    const blocks = await Promise.all(shell.map((cell) => blockIn(file, cell)));
    return shell.filter((_, i) => blocks[i] === BlockType.Air);
  };
  const mined = await repeatUntil(
    page,
    shellId,
    async () => {
      await page.mouse.down();
      await page.waitForTimeout(MINE_SEGMENT_MS);
      await page.mouse.up();
    },
    async (file) => (await minedIn(file)).length > 0,
    () => '没有一格树叶被挖掉',
  );
  const minedCells = await minedIn(mined);
  // 其余的树叶都还在
  const rest = shell.filter((cell) => !minedCells.includes(cell));
  expect(await Promise.all(rest.map((cell) => blockIn(mined, cell)))).toEqual(rest.map(() => BlockType.BirchLeaves));
  await enterId(page, shellId);
  await saveAndExit(page);
  const reenteredShell = await exportId(page, shellId);
  expect(await minedIn(reenteredShell)).toEqual(minedCells);
  expect(await comparable(reenteredShell)).toEqual(await comparable(mined));
  expect(errors).toEqual([]);
});
