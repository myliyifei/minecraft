import { expect, test, type Page } from '@playwright/test';
import { BlockType, miningTicks } from '../src/core/block';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
  TICK_RATE,
} from '../src/core/constants';
import { MAX_PITCH, PLAYER_EYE_HEIGHT, WALK_SPEED, WALK_STEP } from '../src/core/player';
import { plainsTreePlacement } from '../src/core/terrain';
import { OAK_CANOPY_RADIUS, oakTreesTouching, type OakTree } from '../src/core/tree';
import type { Vec3 } from '../src/core/vec3';
import { KEY_BINDINGS } from '../src/input/keybindings';
import { CRACK_STAGES } from '../src/render/atlas';
import { STRINGS } from '../src/ui/strings';
import { countCanvasColors, waitForFirstFrame } from './canvas';

/** 默认视距下已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -DEFAULT_VIEW_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (DEFAULT_VIEW_RADIUS + 1) * CHUNK_SIZE - 1;

/** 视距铺满时的区块数。 */
const CHUNKS_IN_VIEW = (2 * DEFAULT_VIEW_RADIUS + 1) ** 2;

/** 采样时 z 的步长：抽十来行就够判断起伏与确定性，不必读满六千多列。 */
const PROFILE_Z_STEP = 8;

/**
 * 默认种子下、会写进原点区块的第一棵橡树。树根不一定落在原点区块里，但一定在页面
 * 打开时就等好了的那一片内（见 SPAWN_READY_RADIUS）。
 *
 * 在 Node 这一侧用纯地形函数算出来，再拿去核对页面里的世界——两边对得上，就说明
 * Worker 生成的区块与核心认的是同一个世界（ADR-0003）。
 */
function spawnAreaTree(): OakTree {
  const tree = oakTreesTouching(plainsTreePlacement(DEFAULT_SEED), 0, 0)[0];
  if (!tree) throw new Error('默认种子的原点区块附近应有一棵橡树');
  return tree;
}

/**
 * 等视距内的区块全部到位。
 *
 * 页面打开时只等好了出生点那一小片（见 SPAWN_READY_RADIUS），
 * 其余由 Worker 陆续送来。要对整片地形下断言就得先等它长齐，否则读到的是
 * 「未加载即空气」。
 */
async function waitForFullViewDistance(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__VOXEL__!.core.loadedChunkCount), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(CHUNKS_IN_VIEW);
}

/**
 * 一直往前走 n 个 tick，绕开挡路的东西，中途把主线程让出去，好让 Worker 送回来的区块
 * 能被收下。
 *
 * 逐个 tick 走而不是一次 `core.tick(n)`：区块是异步回填的，一整段跑在同一个任务里
 * 就一个区块也等不到，玩家会走进还没生成的地方。边走边跳是因为真实地形上相邻两列可能
 * 差一格，光走会被那一格挡住；往前挪不动就侧身让一步、侧身也挪不动就换另一边，是因为
 * 平原上散布着橡树，树干与低垂的树冠都是实心的。挡路的规避与 tests/core/game.test.ts
 * 的 `walkForwardPastTrees` 是同一套。
 */
async function walkForwardTicks(page: Page, ticks: number): Promise<void> {
  await page.evaluate(
    async ({ total, sidestepProgress }) => {
      const core = window.__VOXEL__!.core;
      /** 每这么多 tick 把主线程让出去一次。 */
      const yieldEvery = 10;
      let sidestep: 'none' | 'right' | 'left' = 'none';
      let previous = core.player.position;
      for (let done = 0; done < total; done++) {
        core.setMoveIntent({
          forward: true,
          back: false,
          left: sidestep === 'left',
          right: sidestep === 'right',
          jump: true,
        });
        core.tick();
        const now = core.player.position;
        if (now.z < previous.z) sidestep = 'none';
        else if (sidestep === 'none') sidestep = 'right';
        else if (Math.abs(now.x - previous.x) < sidestepProgress) {
          sidestep = sidestep === 'right' ? 'left' : 'right';
        }
        previous = now;
        if (done % yieldEvery === yieldEvery - 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      core.setMoveIntent({ forward: false, back: false, left: false, right: false, jump: false });
    },
    { total: ticks, sidestepProgress: WALK_STEP / 2 },
  );
}

/**
 * 读一片列顶高度（`highestBlockY`）。地形起伏与确定性都靠它断言。
 * 不是「地表高度」：有树的列上它报的是树冠。
 */
async function readTopBlockProfile(page: Page): Promise<number[]> {
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
  const state = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    const spawn = core.spawnPoint;
    return {
      underSpawn: core.getBlock(spawn.x, spawn.y - 1, spawn.z),
      atSpawn: core.getBlock(spawn.x, spawn.y, spawn.z),
      aboveSpawn: core.getBlock(spawn.x, spawn.y + 1, spawn.z),
    };
  });
  expect(state.underSpawn).toBe(BlockType.Grass);
  expect(state.atSpawn).toBe(BlockType.Air);
  expect(state.aboveSpawn).toBe(BlockType.Air);
});

test('页面里长着由种子生成的橡树，树干与树冠都在', async ({ page }) => {
  const expected = spawnAreaTree();
  // 树的坐标要当参数传进 evaluate：页面里没有 Node 这一侧的模块。
  const tree = await page.evaluate(
    ({ x, z, rootY, trunkHeight, radius }) => {
      const core = window.__VOXEL__!.core;
      // 地面、整根树干、树干顶上那一格
      const column: number[] = [];
      for (let y = rootY - 1; y <= rootY + trunkHeight; y++) {
        column.push(core.getBlock(x, y, z));
      }
      // 树冠最宽那一层横着切一刀
      const canopy: number[] = [];
      const top = rootY + trunkHeight - 1;
      for (let dx = -radius; dx <= radius; dx++) canopy.push(core.getBlock(x + dx, top - 1, z));
      return { column, canopy };
    },
    { ...expected, radius: OAK_CANOPY_RADIUS },
  );

  const { OakLog: log, OakLeaves: leaves, Grass: grass } = BlockType;
  // 自下而上：草地、连续原木、树干顶上一格树叶
  expect(tree.column).toEqual([grass, ...Array<number>(expected.trunkHeight).fill(log), leaves]);
  // 树冠比树干宽：最宽那一层左右各伸出 OAK_CANOPY_RADIUS 格树叶
  expect(tree.canopy).toEqual([
    ...Array<number>(OAK_CANOPY_RADIUS).fill(leaves),
    log,
    ...Array<number>(OAK_CANOPY_RADIUS).fill(leaves),
  ]);
});

test('页面打开后是由默认种子生成的起伏平原', async ({ page }) => {
  const seed = await page.evaluate(() => window.__VOXEL__!.core.seed);
  expect(seed).toBe(DEFAULT_SEED);

  await waitForFullViewDistance(page);
  const heights = await readTopBlockProfile(page);
  // 出现多种高度才算「起伏」，而不是一片硬编码平地
  expect(new Set(heights).size).toBeGreaterThan(1);
  expect(Math.min(...heights)).toBeGreaterThan(SEA_LEVEL);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(20);
});

test('同一种子每次进入地形相同', async ({ page }) => {
  await waitForFullViewDistance(page);
  const before = await readTopBlockProfile(page);
  await page.reload();
  await waitForFirstFrame(page);
  await waitForFullViewDistance(page);
  expect(await readTopBlockProfile(page)).toEqual(before);
});

test('地形生成在 Worker 里进行，视距内的区块陆续送到', async ({ page }) => {
  // 首帧只等了出生点那一小片，此时视距还没铺满
  const atFirstFrame = await page.evaluate(() => window.__VOXEL__!.core.loadedChunkCount);
  expect(atFirstFrame).toBeLessThan(CHUNKS_IN_VIEW);

  await waitForFullViewDistance(page);

  const state = await page.evaluate(() => ({
    loaded: window.__VOXEL__!.core.loadedChunkCount,
    delivered: window.__VOXEL__!.chunks.deliveredCount,
  }));
  // 送回来的不少于世界里现有的：视距铺满靠的是 Worker 的产出，不是主线程边跑边生成
  // （主线程压根没有生成器——核心拿到的来源只有 chunks.source，见 src/main.ts）
  expect(state.delivered).toBeGreaterThanOrEqual(state.loaded);
  expect(errors).toEqual([]);
});

test('走远之后前方区块生成、身后区块与它的网格一起卸载', async ({ page }) => {
  await waitForFullViewDistance(page);
  const before = await page.evaluate(() => ({
    chunk: window.__VOXEL__!.core.playerChunk,
    hasOriginMesh: window.__VOXEL__!.renderer.hasChunkMesh(0, 0),
    z: window.__VOXEL__!.core.player.position.z,
  }));
  expect(before.chunk).toEqual({ cx: 0, cz: 0 });
  expect(before.hasOriginMesh).toBe(true);

  // 朝 −Z 走一分钟：视距 8 的加载范围是 ±128 格，这一趟远远走出去
  await walkForwardTicks(page, 60 * TICK_RATE);

  const after = await page.evaluate((radius) => {
    const { core, renderer } = window.__VOXEL__!;
    const { cx, cz } = core.playerChunk;
    return {
      chunk: { cx, cz },
      z: core.player.position.z,
      y: core.player.position.y,
      surface: core.highestBlockY(
        Math.floor(core.player.position.x),
        Math.floor(core.player.position.z),
      ),
      loaded: core.loadedChunkCount,
      aheadLoaded: core.isChunkLoaded(cx, cz - radius),
      originLoaded: core.isChunkLoaded(0, 0),
      hasOriginMesh: renderer.hasChunkMesh(0, 0),
      hasHereMesh: renderer.hasChunkMesh(cx, cz),
    };
  }, DEFAULT_VIEW_RADIUS);

  // 走出去了好几个区块，脚下始终是地面而不是虚空
  expect(before.z - after.z).toBeGreaterThan(4 * CHUNK_SIZE);
  expect(after.y).toBeGreaterThan(SEA_LEVEL);
  expect(after.y).toBeGreaterThanOrEqual(after.surface);
  // 前方的区块跟着生成，身后的连网格一起卸载
  expect(after.aheadLoaded).toBe(true);
  expect(after.originLoaded).toBe(false);
  expect(after.hasOriginMesh).toBe(false);
  expect(after.hasHereMesh).toBe(true);
  // 已加载区块数稳定在视距那一圈上下，不会一路涨
  expect(after.loaded).toBeGreaterThanOrEqual(CHUNKS_IN_VIEW);
  expect(after.loaded).toBeLessThanOrEqual((2 * (DEFAULT_VIEW_RADIUS + 1) + 1) ** 2);
  expect(errors).toEqual([]);
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

test('瞄准脚下的方块显示选框，挖掘中出裂纹，挖穿后网格重建', async ({ page }) => {
  await waitForFullViewDistance(page);

  // 整段跑在一次同步的 evaluate 里：游戏循环插不进来，tick 数与画面因此是精确的。
  // 画面反馈要自己调 render()，帧是循环发起的，这里没有帧。
  const dig = await page.evaluate(
    ({ pitch, ticksToBreak }) => {
      const { core, renderer } = window.__VOXEL__!;
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      // 脚下那一格：低头看到底，视线几乎竖直向下
      const y = Math.floor(core.player.position.y) - 1;
      core.turn(0, -pitch);

      /**
       * 画布正中那一像素的 RGB。
       *
       * 视线几乎竖直向下，画面正中正落在目标方块贴图的中心，而裂纹图案就是从那里长起来
       * 的——裂纹与挖出来的坑因此都在这一像素上看得见。只对场景里那两个对象下断言的话，
       * 证不到它们真的画进了画布。
       */
      const centerRgb = (): [number, number, number] => {
        const canvas = document.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('页面上没有画布');
        const scratch = document.createElement('canvas');
        scratch.width = canvas.width;
        scratch.height = canvas.height;
        const context = scratch.getContext('2d');
        if (!context) throw new Error('拿不到 2D 上下文');
        context.drawImage(canvas, 0, 0);
        const { data } = context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1);
        return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
      };

      core.tick();
      renderer.render();
      const aimed = {
        block: core.getBlock(x, y, z),
        selection: renderer.selection,
        rgb: centerRgb(),
      };

      core.setMining(true);
      core.tick(ticksToBreak - 1);
      renderer.render();
      const meshBefore = renderer.chunkMeshVertexCount(0, 0);
      const almost = {
        block: core.getBlock(x, y, z),
        selection: renderer.selection,
        rgb: centerRgb(),
      };

      core.tick(1);
      core.setMining(false);
      renderer.syncChunkMeshes();
      renderer.render();
      const broken = {
        block: core.getBlock(x, y, z),
        selection: renderer.selection,
        rgb: centerRgb(),
        meshVertices: renderer.chunkMeshVertexCount(0, 0),
      };

      return { at: { x, y, z }, aimed, almost, meshBefore, broken };
    },
    { pitch: MAX_PITCH, ticksToBreak: miningTicks(BlockType.Grass) },
  );

  /** 一像素的亮度。 */
  const brightness = (rgb: readonly number[]): number => rgb.reduce((sum, c) => sum + c, 0);

  // 瞄上就有选框，还没挖所以没有裂纹；画面正中是草的绿
  expect(dig.aimed.block).toBe(BlockType.Grass);
  expect(dig.aimed.selection.target).toEqual(dig.at);
  expect(dig.aimed.selection.crackStage).toBeUndefined();
  expect(dig.aimed.rgb[1]).toBeGreaterThan(dig.aimed.rgb[0]);

  // 差一 tick 碎：草还在，裂纹到了最后一阶，而且真画上去了——正中被压暗了一大截
  expect(dig.almost.block).toBe(BlockType.Grass);
  expect(dig.almost.selection.crackStage).toBe(CRACK_STAGES - 1);
  expect(brightness(dig.almost.rgb)).toBeLessThan(brightness(dig.aimed.rgb) * 0.7);

  // 挖穿：方块消失、网格重建，选框落到坑底那块泥土上，正中也从草绿变成泥土的褐
  expect(dig.broken.block).toBe(BlockType.Air);
  expect(dig.broken.meshVertices).not.toBe(dig.meshBefore);
  expect(dig.broken.selection.target).toEqual({ ...dig.at, y: dig.at.y - 1 });
  expect(dig.broken.selection.crackStage).toBeUndefined();
  expect(dig.broken.rgb[0]).toBeGreaterThan(dig.broken.rgb[1]);
  expect(errors).toEqual([]);
});

test('锁定鼠标后按住左键才挖，松开就停', async ({ page }) => {
  await grabPointer(page);
  await page.evaluate((pitch) => window.__VOXEL__!.core.turn(0, -pitch), MAX_PITCH);

  /** 推进几个 tick，返回挖掘进度与目标。 */
  const digForTicks = async (): Promise<{ progress: number; hasTarget: boolean }> =>
    page.evaluate(() => {
      const core = window.__VOXEL__!.core;
      core.tick(5);
      return { progress: core.mining.progress, hasTarget: core.mining.target !== undefined };
    });

  // 瞄着但没按左键：有目标，进度是 0
  const idle = await digForTicks();
  expect(idle.hasTarget).toBe(true);
  expect(idle.progress).toBe(0);

  await page.mouse.down();
  expect((await digForTicks()).progress).toBeGreaterThan(0);

  await page.mouse.up();
  expect((await digForTicks()).progress).toBe(0);
  expect(errors).toEqual([]);
});

test('核心以固定步长推进', async ({ page }) => {
  const before = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__VOXEL__!.core.tickCount);
  // 20 tick/s，放宽到 [10, 30] 以容忍 CI 上的抖动
  expect(after - before).toBeGreaterThanOrEqual(10);
  expect(after - before).toBeLessThanOrEqual(30);
});
