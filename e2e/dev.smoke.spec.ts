import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
  TICK_RATE,
} from '../src/core/constants';
import { DEMO_TREE_COLUMN } from '../src/demo-scene';
import { PLAYER_EYE_HEIGHT, WALK_SPEED } from '../src/core/player';
import type { Vec3 } from '../src/core/vec3';
import { KEY_BINDINGS } from '../src/input/keybindings';
import { STRINGS } from '../src/ui/strings';
import { countCanvasColors, waitForFirstFrame } from './canvas';

/** 默认视距下已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -DEFAULT_VIEW_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (DEFAULT_VIEW_RADIUS + 1) * CHUNK_SIZE - 1;

/** 采样时 z 的步长：抽十来行就够判断起伏与确定性，不必读满六千多列。 */
const PROFILE_Z_STEP = 8;

/** 读一片地表高度。地形起伏与确定性都靠它断言。 */
async function readSurfaceProfile(page: Page): Promise<number[]> {
  return page.evaluate(
    ({ from, to, zStep }) => {
      const core = window.__VOXEL__!.core;
      const heights: number[] = [];
      for (let z = from; z <= to; z += zStep) {
        for (let x = from; x <= to; x++) heights.push(core.highestBlockY(x, z));
      }
      return heights;
    },
    { from: LOADED_MIN, to: LOADED_MAX, zStep: PROFILE_Z_STEP },
  );
}

/** 当前被指针锁定的元素 id。没有锁定时是 null。 */
async function readLockedElementId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.pointerLockElement?.id ?? null);
}

/**
 * 点画布进入第一人称：之后按键才生效。
 * 锁定之后浏览器会补投一发光标归位的 mousemove，这里等它到达，好让后面的断言看到
 * 稳定的视角。
 */
async function grabPointer(page: Page): Promise<void> {
  await page.locator('#game').click();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  await page.waitForTimeout(200);
}

/**
 * 走一段路，返回起止位置。
 *
 * 时间由 `core.tick(n)` 显式推进，不等墙上时间：headless Chromium 在指针锁定期间会
 * 把页面的任务调度降到约 1/10 并继续退化（rAF 与 setInterval 一起变慢，解锁即恢复），
 * 靠 `waitForTimeout` 数 tick 在这里是不可靠的。整段跑在一次 evaluate 里，
 * 游戏循环插不进来，位移因此是精确值。真人按键的那条路（keydown → 移动意图）
 * 仍然走的是浏览器真实事件。
 */
async function walkWhileHolding(
  page: Page,
  code: string,
  ticks: number,
): Promise<{ from: Vec3; to: Vec3; yaw: number }> {
  await page.keyboard.down(code);
  const walk = await page.evaluate((n) => {
    const core = window.__VOXEL__!.core;
    const from = { ...core.player.position };
    core.tick(n);
    return { from, to: { ...core.player.position }, yaw: core.player.yaw };
  }, ticks);
  await page.keyboard.up(code);
  return walk;
}

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await waitForFirstFrame(page);
});

test('页面加载过程中没有 JS 错误', () => {
  expect(errors).toEqual([]);
});

test('页面标题来自简体中文字符串表', async ({ page }) => {
  await expect(page).toHaveTitle(STRINGS.gameTitle);
});

test('画布画出了内容，不是单色', async ({ page }) => {
  const colors = await countCanvasColors(page);
  expect(colors).toBeGreaterThan(20);
});

test('调试句柄报告已加载区块与已建网格', async ({ page }) => {
  const state = await page.evaluate(() => {
    const handle = window.__VOXEL__;
    if (!handle) throw new Error('开发构建下应存在调试句柄');
    return {
      loadedChunkCount: handle.core.loadedChunkCount,
      chunkMeshCount: handle.renderer.chunkMeshCount,
    };
  });
  expect(state.loadedChunkCount).toBeGreaterThan(0);
  expect(state.chunkMeshCount).toBeGreaterThan(0);
});

test('调试句柄能读到核心的方块状态', async ({ page }) => {
  const state = await page.evaluate(
    ({ column, oakLog }) => {
      const core = window.__VOXEL__!.core;
      const spawn = core.spawnPoint;
      // 演示橡树的树干在这一列上。地表高度随地形起伏，所以自上而下扫，不写死 y。
      let trunkFound = false;
      for (let y = core.highestBlockY(column.x, column.z); y > 0; y--) {
        if (core.getBlock(column.x, y, column.z) === oakLog) {
          trunkFound = true;
          break;
        }
      }
      return {
        underSpawn: core.getBlock(spawn.x, spawn.y - 1, spawn.z),
        atSpawn: core.getBlock(spawn.x, spawn.y, spawn.z),
        aboveSpawn: core.getBlock(spawn.x, spawn.y + 1, spawn.z),
        trunkFound,
      };
    },
    { column: DEMO_TREE_COLUMN, oakLog: BlockType.OakLog },
  );
  expect(state.underSpawn).toBe(BlockType.Grass);
  expect(state.atSpawn).toBe(BlockType.Air);
  expect(state.aboveSpawn).toBe(BlockType.Air);
  expect(state.trunkFound).toBe(true);
});

test('页面打开后是由默认种子生成的起伏平原', async ({ page }) => {
  const seed = await page.evaluate(() => window.__VOXEL__!.core.seed);
  expect(seed).toBe(DEFAULT_SEED);

  const heights = await readSurfaceProfile(page);
  // 出现多种高度才算「起伏」，而不是一片硬编码平地
  expect(new Set(heights).size).toBeGreaterThan(1);
  expect(Math.min(...heights)).toBeGreaterThan(SEA_LEVEL);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(20);
});

test('同一种子每次进入地形相同', async ({ page }) => {
  const before = await readSurfaceProfile(page);
  await page.reload();
  await waitForFirstFrame(page);
  expect(await readSurfaceProfile(page)).toEqual(before);
});

test('点击画布锁定鼠标，视角不被甩一下', async ({ page }) => {
  expect(await readLockedElementId(page)).toBe(null);
  await grabPointer(page);
  // 锁定生效时浏览器补投的那发光标归位 mousemove 必须被丢掉，否则一进第一人称
  // 视角就转过去了
  const look = await page.evaluate(() => {
    const { yaw, pitch } = window.__VOXEL__!.core.player;
    return { yaw, pitch };
  });
  expect(look).toEqual({ yaw: 0, pitch: 0 });
});

test('锁定鼠标后按住 W 玩家往前走', async ({ page }) => {
  await grabPointer(page);
  const walk = await walkWhileHolding(page, KEY_BINDINGS.forward, TICK_RATE);
  // 期间视角没被甩动，下面的方向断言才成立
  expect(walk.yaw).toBe(0);
  // 视角朝 −Z，一路是平地：走一秒就是一个步行速度的距离
  expect(walk.from.z - walk.to.z).toBeCloseTo(WALK_SPEED, 5);
  expect(walk.to.x).toBeCloseTo(walk.from.x, 5);
  expect(walk.to.y).toBe(walk.from.y);
});

test('锁定鼠标后按住空格玩家离地', async ({ page }) => {
  // 只验空格这条线接上了（按键 → 移动意图 → 起跳）。跳多高是核心的事，
  // 断言在 tests/core/player.test.ts，不在这里重复一遍。
  /** 推进一秒，返回这段时间里脚底到过的最高处。 */
  const apexOverOneSecond = async (): Promise<number> =>
    page.evaluate((ticks) => {
      const core = window.__VOXEL__!.core;
      let apex = core.player.position.y;
      for (let i = 0; i < ticks; i++) {
        core.tick();
        apex = Math.max(apex, core.player.position.y);
      }
      return apex;
    }, TICK_RATE);

  await grabPointer(page);
  const ground = await page.evaluate(() => window.__VOXEL__!.core.player.position.y);
  expect(await apexOverOneSecond()).toBe(ground);

  await page.keyboard.down(KEY_BINDINGS.jump);
  const apex = await apexOverOneSecond();
  await page.keyboard.up(KEY_BINDINGS.jump);
  expect(apex).toBeGreaterThan(ground);
});

test('未锁定鼠标时按键不动玩家', async ({ page }) => {
  const walk = await walkWhileHolding(page, KEY_BINDINGS.forward, TICK_RATE);
  expect(walk.to).toEqual(walk.from);
});

test('释放鼠标后按住的键不会卡着继续走', async ({ page }) => {
  await grabPointer(page);
  await page.keyboard.down(KEY_BINDINGS.forward);

  // 真人按 Esc 时是浏览器自己退出指针锁定（规范要求 UA 这么做），CDP 合成的 Esc
  // 触发不了它，所以这里直接退出锁定——要测的是我们这一侧：锁定一丢，按键就不算数了。
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        document.addEventListener('pointerlockchange', () => resolve(), { once: true });
        document.exitPointerLock();
      }),
  );
  expect(await readLockedElementId(page)).toBe(null);

  const stuck = await page.evaluate((ticks) => {
    const core = window.__VOXEL__!.core;
    const from = { ...core.player.position };
    core.tick(ticks);
    return { from, to: { ...core.player.position } };
  }, TICK_RATE);
  await page.keyboard.up(KEY_BINDINGS.forward);
  expect(stuck.to).toEqual(stuck.from);
});

test('鼠标移动转动视角', async ({ page }) => {
  await grabPointer(page);
  // 指针锁定下 Playwright 的 mouse.move 会连带投递一次反向位移，方向断言不住，
  // 所以直接合成一次带 movementX 的事件——测的是适配器把增量交给核心这条线。
  const look = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    const before = { yaw: core.player.yaw, pitch: core.player.pitch };
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 200, movementY: 100 }));
    return { before, after: { yaw: core.player.yaw, pitch: core.player.pitch } };
  });
  // 鼠标右移看向右侧（偏航变小），下移看向下方（俯仰变小）
  expect(look.after.yaw).toBeLessThan(look.before.yaw);
  expect(look.after.pitch).toBeLessThan(look.before.pitch);
});

test('手做不到的巨型鼠标增量不转动视角', async ({ page }) => {
  await grabPointer(page);
  const look = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    // 先来一发正常增量，把「上一发的时刻」对到现在，下一发的间隔才是真的很短。
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 2 }));
    const before = core.player.yaw;
    // 566px 是实测采到的假增量幅度，紧跟着上一发投递，隐含速度远超人手。
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 566 }));
    return { before, after: core.player.yaw };
  });
  expect(look.after).toBe(look.before);
});

test('相机跟在玩家眼睛上，并在两个 tick 之间插值', async ({ page }) => {
  // 这条不用锁鼠标：主角是渲染层，移动意图直接给核心。
  const camera = await page.evaluate((ticks) => {
    const { core, renderer } = window.__VOXEL__!;
    const eyeAbove = (): number => renderer.cameraPosition.y - core.player.position.y;

    renderer.render();
    const resting = { eyeAbove: eyeAbove(), z: renderer.cameraPosition.z };

    core.setMoveIntent({ forward: true, back: false, left: false, right: false, jump: false });
    core.tick(ticks);
    renderer.render();
    const walked = { eyeAbove: eyeAbove(), z: renderer.cameraPosition.z };

    // 同一份状态、不同的插值系数：0 画上一个 tick 的位置，1 画当前位置
    core.tick();
    renderer.render(0);
    const atPrevTick = renderer.cameraPosition.z;
    renderer.render(1);
    const atThisTick = renderer.cameraPosition.z;
    renderer.render(0.5);
    const halfway = renderer.cameraPosition.z;

    return { resting, walked, atPrevTick, atThisTick, halfway };
  }, TICK_RATE);

  // 相机就在脚底往上 1.62 格
  expect(camera.resting.eyeAbove).toBeCloseTo(PLAYER_EYE_HEIGHT, 5);
  expect(camera.walked.eyeAbove).toBeCloseTo(PLAYER_EYE_HEIGHT, 5);
  // 走了一秒，相机跟着挪了一个步行速度的距离
  expect(camera.resting.z - camera.walked.z).toBeCloseTo(WALK_SPEED, 5);
  // 插值：alpha 0 与 1 之间差一个 tick 的位移，0.5 落在正中间
  expect(camera.atPrevTick - camera.atThisTick).toBeCloseTo(WALK_SPEED / TICK_RATE, 5);
  expect(camera.halfway).toBeCloseTo((camera.atPrevTick + camera.atThisTick) / 2, 10);
});

test('核心以固定步长推进', async ({ page }) => {
  const before = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  // 20 tick/s，放宽到 [10, 30] 以容忍 CI 上的抖动
  expect(after - before).toBeGreaterThanOrEqual(10);
  expect(after - before).toBeLessThanOrEqual(30);
});
