import { expect, type Page } from '@playwright/test';
import { DEFAULT_SEED } from '../src/core/constants';
import type { Difficulty } from '../src/core/difficulty';
import { STRINGS } from '../src/ui/strings';

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
 * 让刚进入的世界开始推进：加载画面消失后世界不推进，第一次锁定指针才开始。锁定一次再释放，之后的状态与
 * 第六切片之前打开页面时一样：世界在推进，鼠标没锁定。
 *
 * 要等世界推进了一个 tick 再释放：循环每帧看一次锁没锁，锁上又在下一帧之前释放的话它看不到。只在开发构建里用，
 * 读的是调试句柄。
 */
export async function startTicking(page: Page): Promise<void> {
  await page.locator('#game').click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('game');
  await page.waitForFunction(() => window.__VOXEL__!.core.tickCount > 0);
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        document.addEventListener('pointerlockchange', () => resolve(), { once: true });
        document.exitPointerLock();
      }),
  );
}

/** 重新打开页面，在世界列表上点第一条的「进入」，等加载画面消失。世界还没开始推进。 */
export async function reloadAndEnter(page: Page): Promise<void> {
  await page.reload();
  await waitForWorldList(page);
  await page.getByRole('button', { name: STRINGS.enterWorld }).first().click();
  await waitForWorld(page);
}

/** 从世界列表新建一个默认种子、默认难度的世界并让它开始推进。端到端冒烟测试的起点。 */
export async function enterDefaultWorld(page: Page): Promise<void> {
  await waitForWorldList(page);
  await createWorld(page, { seed: String(DEFAULT_SEED) });
  await startTicking(page);
}
