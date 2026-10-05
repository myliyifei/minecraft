import { expect, type Page } from '@playwright/test';
import { BlockType, isSolid } from '../src/core/block';
import { DEFAULT_SEED, WORLD_MIN_Y } from '../src/core/constants';
import type { Difficulty } from '../src/core/difficulty';
import { STRINGS } from '../src/ui/strings';

/**
 * 不实心的方块编号：空气、火把、水、地表植物等。页面里找「一列最高的实心方块」时跳过它们——调试句柄的 `highestBlockY`
 * 报的是最高的非空气方块，地表植物（#80）长出来之后那一格是植物，不是地面。
 */
export const NON_SOLID_BLOCKS: readonly number[] = Object.values(BlockType).filter((block) => !isSolid(block));

/**
 * 地表植物（#80）的四个编号。生成僵尸判断列顶时只跳过它们（CONTEXT.md「生成」），不跳过水与火把。
 */
export const PLANT_BLOCKS: readonly number[] = [BlockType.ShortGrass, BlockType.Fern, BlockType.Dandelion, BlockType.Poppy];

/** 找「最高的实心方块」要传进页面的参数：不实心的编号与世界最低的 y。 */
export const GROUND_ARGS = { nonSolid: NON_SOLID_BLOCKS, minY: WORLD_MIN_Y } as const;

/** 新建世界表单里要填的。不给的项保持表单的默认值。 */
export interface NewWorldForm {
  readonly name?: string;
  readonly seed?: string;
  readonly difficulty?: Difficulty;
}

/** 等世界列表显示出来。 */
export async function waitForWorldList(page: Page): Promise<void> {
  await expect(page.locator('#world-list')).toBeVisible({ timeout: 20_000 });
}

/**
 * 等进入世界：画布已经挂上、加载画面已经藏起。点「进入」或「创建」之后调。
 *
 * 不能只看加载画面藏没藏：它在世界列表上本来就藏着。点下去的那一刻它同步显示出来，画布在进入的过程中挂上，
 * 两样同时满足只有在加载结束之后。
 */
export async function waitForWorld(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('#game') !== null && (document.querySelector('#loading') as HTMLElement).hidden,
    null,
    { timeout: 20_000 },
  );
}

/** 在世界列表上点「新建世界」，按给的填表，点「创建」，等加载画面消失。 */
export async function createWorld(page: Page, form: NewWorldForm = {}): Promise<void> {
  await page.getByRole('button', { name: STRINGS.newWorld }).click();
  if (form.name !== undefined) await page.getByLabel(STRINGS.worldName).fill(form.name);
  if (form.seed !== undefined) await page.getByLabel(STRINGS.worldSeed).fill(form.seed);
  if (form.difficulty !== undefined) await page.getByLabel(STRINGS.difficulty).selectOption(form.difficulty);
  await page.getByRole('button', { name: STRINGS.createWorld }).click();
  await waitForWorld(page);
}

/**
 * 在暂停菜单上点「回到游戏」，等指针锁定生效、世界推进了一个 tick：加载画面消失后世界处于暂停。之后鼠标一直
 * 锁着，释放锁定就是暂停（ADR-0019）。无头 Chromium 锁着几秒之后帧率越来越低，锁上之后别停留太久。只在
 * 开发构建里用，读的是调试句柄。
 */
export async function resumeGame(page: Page): Promise<void> {
  const start = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  await page.getByRole('button', { name: STRINGS.backToGame }).click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('game');
  await page.waitForFunction((start) => window.__VOXEL__!.core.tickCount > start, start);
}

/** 退出指针锁定，等锁定变更事件到达：世界随之暂停。真人按 Esc 时由浏览器退出，CDP 合成的 Esc 做不到这一步。 */
export async function pressEscape(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        document.addEventListener('pointerlockchange', () => resolve(), { once: true });
        document.exitPointerLock();
      }),
  );
}

/** 经调试句柄写盘并退出到世界列表，等列表显示出来。 */
export async function exitToList(page: Page): Promise<void> {
  await page.evaluate(() => window.__VOXEL__!.exitToList());
  await waitForWorldList(page);
}

/** 把这一列最高的实心方块挖掉，返回它的 y。上面长着的植物随之碎掉。 */
export function digTop(page: Page, x: number, z: number): Promise<number> {
  return page.evaluate(
    ({ x, z, air, nonSolid, minY }) => {
      const core = window.__VOXEL__!.core;
      let y = core.highestBlockY(x, z);
      while (y >= minY && nonSolid.includes(core.getBlock(x, y, z))) y--;
      core.setBlock(x, y, z, air);
      return y;
    },
    { x, z, air: BlockType.Air, ...GROUND_ARGS },
  );
}

export function blockAt(page: Page, x: number, y: number, z: number): Promise<number> {
  return page.evaluate(({ x, y, z }) => window.__VOXEL__!.core.getBlock(x, y, z), { x, y, z });
}

/** 从脚下最高的实心方块起挖空 24 格，推进到摔死。整段在一次同步的 evaluate 里，游戏循环插不进来。 */
export async function fallToDeath(page: Page): Promise<void> {
  const dead = await page.evaluate(
    ({ depth, air, nonSolid, minY }) => {
      const { core, hud } = window.__VOXEL__!;
      const { x, z } = core.player.position;
      const column = { x: Math.floor(x), z: Math.floor(z) };
      let top = core.highestBlockY(column.x, column.z);
      while (top >= minY && nonSolid.includes(core.getBlock(column.x, top, column.z))) top--;
      for (let y = top; y > top - depth; y--) core.setBlock(column.x, y, column.z, air);
      for (let ticks = 0; ticks < 100 && !core.health.dead; ticks++) core.tick();
      hud.update();
      return core.health.dead;
    },
    { depth: 24, air: BlockType.Air, ...GROUND_ARGS },
  );
  expect(dead).toBe(true);
}

/** 重新打开页面，在世界列表上点第一条的「进入」，等加载画面消失。世界处于暂停。 */
export async function reloadAndEnter(page: Page): Promise<void> {
  await page.reload();
  await waitForWorldList(page);
  await page.getByRole('button', { name: STRINGS.enterWorld }).first().click();
  await waitForWorld(page);
}

/**
 * 让世界暂停时照样推进、不显示暂停菜单，等它推进了一个 tick。冒烟测试用：无头 Chromium 锁定指针几秒之后帧率
 * 越来越低，测试不能一直锁着（见 `DebugHandle.setIgnorePause`）。之后的状态与第六切片之前打开页面时一样：世界在
 * 推进、鼠标没锁定，点画布锁定。
 */
export async function ignorePause(page: Page): Promise<void> {
  const start = await page.evaluate(() => {
    window.__VOXEL__!.setIgnorePause(true);
    return window.__VOXEL__!.core.tickCount;
  });
  await page.waitForFunction((start) => window.__VOXEL__!.core.tickCount > start, start);
}

/** 从世界列表新建一个默认种子、默认难度的世界，让它不理会暂停。端到端冒烟测试的起点。 */
export async function enterDefaultWorld(page: Page): Promise<void> {
  await waitForWorldList(page);
  await createWorld(page, { seed: String(DEFAULT_SEED) });
  await ignorePause(page);
}
