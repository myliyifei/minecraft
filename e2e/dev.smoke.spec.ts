import { expect, test, type Locator, type Page } from '@playwright/test';
import { BlockType, miningTicks } from '../src/core/block';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
  TICK_RATE,
} from '../src/core/constants';
import { CRAFTING_TABLE_GRID, INVENTORY_CRAFTING_GRID } from '../src/core/crafting-grid';
import { PICKUP_DELAY_TICKS } from '../src/core/drop';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../src/core/inventory';
import { BARE_HAND, ItemType, type ItemStack } from '../src/core/item';
import {
  MAX_PITCH,
  PLAYER_EYE_HEIGHT,
  PLAYER_WIDTH,
  WALK_SPEED,
  WALK_STEP,
} from '../src/core/player';
import { plainsTreePlacement } from '../src/core/terrain';
import { OAK_CANOPY_RADIUS, oakTreesTouching, type OakTree } from '../src/core/tree';
import type { Vec3 } from '../src/core/vec3';
import {
  HOTBAR_KEY_CODES,
  INVENTORY_CLOSE_KEY,
  KEY_BINDINGS,
  MOUSE_BINDINGS,
} from '../src/input/keybindings';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  CRACK_STAGES,
  ITEM_TILES,
  TILE_PX,
  tileCell,
} from '../src/render/atlas';
import { RECIPES } from '../src/core/recipe';
import { ITEM_NAMES, STRINGS } from '../src/ui/strings';
import {
  countCanvasColors,
  installPixelProbe,
  readElementPixels,
  waitForFirstFrame,
} from './canvas';

/** 背包界面那块合成网格有几格。 */
const CRAFTING_CELLS = INVENTORY_CRAFTING_GRID.width * INVENTORY_CRAFTING_GRID.height;

/** 默认视距下已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -DEFAULT_VIEW_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (DEFAULT_VIEW_RADIUS + 1) * CHUNK_SIZE - 1;

/** 视距铺满时的区块数。 */
const CHUNKS_IN_VIEW = (2 * DEFAULT_VIEW_RADIUS + 1) ** 2;

/** 采样时 z 的步长：抽十来行就够判断起伏与确定性，不必读满六千多列。 */
const PROFILE_Z_STEP = 8;

/**
 * 挖穿之后再等这么多 tick：掉落物落到坑底、玩家也掉进坑里站稳。
 * 必须小于拾取延迟（`PICKUP_DELAY_TICKS`），否则掉落物在断言之前就被吸走了。
 */
const DROP_SETTLE_TICKS = 8;

/**
 * 挖穿之后再等这么多 tick，经验球一定已经飞到玩家身上并被吸收。
 * 玩家就站在坑口，实际只要几 tick；一秒是宽松的上界。
 */
const XP_ABSORB_TICKS = TICK_RATE;

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
 * 其余由 Worker 陆续送来。要对整片地形下断言就得先等它补齐，否则读到的是
 * 「未加载即空气」。
 */
async function waitForFullViewDistance(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__VOXEL__!.core.loadedChunkCount), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(CHUNKS_IN_VIEW);
}

/** 移动的方向。视角始终朝 −Z，所以往前是 −Z、往回退是 +Z。 */
type WalkDirection = 'forward' | 'back';

/**
 * 一直走 n 个 tick，绕开挡路的东西，中途把主线程让出去，好让 Worker 送回来的区块
 * 能被收下。视角不动：`forward` 是朝视线方向走，`back` 是往回退。
 *
 * 逐个 tick 走而不是一次 `core.tick(n)`：区块是异步回填的，一整段跑在同一个任务里
 * 就一个区块也等不到，玩家会走进还没生成的地方。边走边跳是因为真实地形上相邻两列可能
 * 差一格，光走会被那一格挡住；往前挪不动就侧身让一步、侧身也挪不动就换另一边，是因为
 * 平原上散布着橡树，树干与低垂的树冠都是实心的。挡路的规避与 tests/core/game.test.ts
 * 的 `walkForwardPastTrees` 是同一套。
 */
async function walkTicks(
  page: Page,
  ticks: number,
  direction: WalkDirection = 'forward',
): Promise<void> {
  await page.evaluate(
    async ({ total, sidestepProgress, backward }) => {
      const core = window.__VOXEL__!.core;
      /** 每这么多 tick 把主线程让出去一次。 */
      const yieldEvery = 10;
      /** 视角朝 −Z，所以往前走 z 变小，往回退 z 变大。 */
      const advanced = (now: number, before: number): boolean =>
        backward ? now > before : now < before;
      let sidestep: 'none' | 'right' | 'left' = 'none';
      let previous = core.player.position;
      for (let done = 0; done < total; done++) {
        core.setMoveIntent({
          forward: !backward,
          back: backward,
          left: sidestep === 'left',
          right: sidestep === 'right',
          jump: true,
        });
        core.tick();
        const now = core.player.position;
        if (advanced(now.z, previous.z)) sidestep = 'none';
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
    { total: ticks, sidestepProgress: WALK_STEP / 2, backward: direction === 'back' },
  );
}

/** 原点区块此刻在世界里、在场景里的状态。走远再回来那一趟全靠它判断。 */
async function readOriginChunkState(page: Page): Promise<{ loaded: boolean; hasMesh: boolean }> {
  return page.evaluate(() => ({
    loaded: window.__VOXEL__!.core.isChunkLoaded(0, 0),
    hasMesh: window.__VOXEL__!.renderer.hasChunkMesh(0, 0),
  }));
}

/**
 * 一直走到 `done()` 成立，最多走 maxTicks 个 tick。
 * 分批走，每批之间问一次——走多少格才跨过加载线取决于路上有多少树要绕。
 */
async function walkUntil(
  page: Page,
  direction: WalkDirection,
  done: () => Promise<boolean>,
  maxTicks: number,
): Promise<void> {
  /** 每批走这么多 tick（5 秒游戏时间，约 20 格）。 */
  const batch = 100;
  for (let walked = 0; walked < maxTicks; walked += batch) {
    if (await done()) return;
    await walkTicks(page, batch, direction);
  }
  if (!(await done())) throw new Error(`走了 ${maxTicks} tick 还没走到`);
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

/** 元素中心离视口正中最多差这么多像素：视口边长是奇数时 50% 会落在半像素上。 */
const CENTER_TOLERANCE_PX = 1;

/** 断言这个元素的中心落在视口正中。 */
async function expectCenteredOnScreen(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - viewport!.width / 2)).toBeLessThanOrEqual(
    CENTER_TOLERANCE_PX,
  );
  expect(Math.abs(box!.y + box!.height / 2 - viewport!.height / 2)).toBeLessThanOrEqual(
    CENTER_TOLERANCE_PX,
  );
}

/**
 * 走一段路，返回起止位置。
 *
 * 时间由 `core.tick(n)` 显式推进，不等真实时钟：headless Chromium 在指针锁定期间会
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

/**
 * 通过调试句柄往背包里放 1 个原木：脚下那块换成原木再挖来。核心没有直接往背包里塞物品的
 * 入口，「放进背包」走的就是这条路。配方书那两条测试共用。
 */
async function giveOneLog(page: Page): Promise<void> {
  await page.evaluate(
    ({ pitch, logTicks, pickupTicks, oakLog }) => {
      const core = window.__VOXEL__!.core;
      const { x, y, z } = core.player.position;
      core.setBlock(Math.floor(x), Math.floor(y) - 1, Math.floor(z), oakLog);
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(logTicks);
      core.setMining(false);
      core.tick(pickupTicks);
    },
    {
      pitch: MAX_PITCH,
      logTicks: miningTicks(BlockType.OakLog, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      oakLog: BlockType.OakLog,
    },
  );
}

/** 打开背包界面：开合直接给核心，下一个 tick 生效。 */
async function openInventoryScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    core.toggleInventory();
    core.tick();
  });
}

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await installPixelProbe(page);
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
      // 树冠最宽那一层，横向取一整行
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
  // （主线程根本没有生成器——核心拿到的来源只有 chunks.source，见 src/main.ts）
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
  await walkTicks(page, 60 * TICK_RATE);

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

test('走远到区块卸载再走回来，挖过的洞还在，网格也还带着它', async ({ page }) => {
  // 一来一回一千多个 tick，中间还要等 Worker 把周围的区块重新送来
  test.setTimeout(90_000);
  await waitForFullViewDistance(page);

  // 低头把脚下那块草挖穿，记下带洞的网格。整段跑在一次同步的 evaluate 里，
  // 网格要自己调 syncChunkMeshes——那一步平时是游戏循环发起的。
  const dug = await page.evaluate(
    ({ pitch, ticksToBreak }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.turn(0, -pitch);
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const y = Math.floor(core.player.position.y) - 1;
      core.tick();
      const intact = renderer.chunkMeshVertexCount(0, 0);

      core.setMining(true);
      core.tick(ticksToBreak);
      core.setMining(false);
      renderer.syncChunkMeshes();

      return {
        at: { x, y, z },
        block: core.getBlock(x, y, z),
        intact,
        withHole: renderer.chunkMeshVertexCount(0, 0),
      };
    },
    { pitch: MAX_PITCH, ticksToBreak: miningTicks(BlockType.Grass, BARE_HAND) },
  );

  expect(dug.block).toBe(BlockType.Air);
  // 洞进了网格：坑壁那几个面原来是贴着的，现在暴露出来了
  expect(dug.withHole).toBeGreaterThan(dug.intact);

  // 朝 −Z 走到原点区块被卸载：视距 8、卸载线 9，要走出去 144 格开外
  await walkUntil(page, 'forward', async () => !(await readOriginChunkState(page)).loaded, 2000);
  expect(await readOriginChunkState(page)).toEqual({ loaded: false, hasMesh: false });

  // 再往回退，走到原点区块重新进入视距
  await walkUntil(page, 'back', async () => (await readOriginChunkState(page)).loaded, 1000);

  // 网格还要再往回走几格才有：刚跨过加载线时原点区块朝外那一侧的邻居仍在视距之外，
  // 而网格要四邻齐全才建（见 planChunkMeshes）。补网格由游戏循环逐帧发起，一帧两个。
  await walkUntil(page, 'back', async () => (await readOriginChunkState(page)).hasMesh, 1000);

  const back = await page.evaluate(({ x, y, z }) => {
    const { core, renderer } = window.__VOXEL__!;
    return {
      block: core.getBlock(x, y, z),
      meshVertices: renderer.chunkMeshVertexCount(0, 0),
    };
  }, dug.at);

  // 那一格还是空气，重建出来的网格与挖穿时一模一样——洞不是重新生成的地形填回去了
  expect(back.block).toBe(BlockType.Air);
  expect(back.meshVertices).toBe(dug.withHole);
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
  // 这条不用锁鼠标：测的是渲染层，移动意图直接给核心。
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

      // 视线几乎竖直向下，画面正中正落在目标方块贴图的中心，而裂纹图案就是从那里长起来
      // 的——裂纹与挖出来的坑因此都在这一像素上看得见。只对场景里那两个对象下断言的话，
      // 证不到它们真的画进了画布。
      const centerRgb = window.__CENTER_RGB__!;

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
    { pitch: MAX_PITCH, ticksToBreak: miningTicks(BlockType.Grass, BARE_HAND) },
  );

  /** 一像素的亮度。 */
  const brightness = (rgb: readonly number[]): number => rgb.reduce((sum, c) => sum + c, 0);

  // 瞄上就有选框，还没挖所以没有裂纹；画面正中是草的绿
  expect(dig.aimed.block).toBe(BlockType.Grass);
  expect(dig.aimed.selection.target).toEqual(dig.at);
  expect(dig.aimed.selection.crackStage).toBeUndefined();
  expect(dig.aimed.rgb[1]).toBeGreaterThan(dig.aimed.rgb[0]);

  // 差一 tick 碎：草还在，裂纹到了最后一阶，而且真画上去了——正中亮度明显下降
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

/** 端到端测试自己砌的那根树干有几格：多到预览一眼看得出不止一格，又不必等太久。 */
const CHAIN_TRUNK_HEIGHT = 5;

test('按住连锁键对准树干，画面上出现一圈连锁预览轮廓', async ({ page }) => {
  await waitForFullViewDistance(page);
  await grabPointer(page);
  // 连锁键与左键都走真实事件：验的就是「按住 AltLeft 再按左键」这条线接上了没有
  await page.keyboard.down(KEY_BINDINGS.chainMining);
  await page.mouse.down();

  // **对准要在按下之后**：指针锁定下 Playwright 的 mouse.down 会连带投一发大位移的
  // mousemove，视角当场被甩到别处。整段跑在一次同步的 evaluate 里，游戏循环插不进来。
  const chained = await page.evaluate(
    ({ pitch, log, trunkHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      /** 偏航归零，俯仰转到绝对角度上。 */
      const look = (to: number): void => core.turn(-core.player.yaw, to - core.player.pitch);

      // 先抬头看天让挖掘状态归零：按下左键与这一句之间游戏循环仍在推进 tick，不清掉的话
      // 下面那一 tick 就不是「开始挖掘」的那一 tick，而连锁只在那一 tick 判定。
      look(pitch);
      core.tick();

      // 出生点那一带不长树（OAK_SPAWN_CLEARANCE），自己往脚下砌一根原木树干
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const topY = Math.floor(core.player.position.y) - 1;
      const cells: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < trunkHeight; i++) {
        cells.push({ x, y: topY - i, z });
        core.setBlock(x, topY - i, z, log);
      }

      // 低头对准树干最上面那块：这一 tick 开始挖，连锁在这里判定
      look(-pitch);
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);

      return {
        cells,
        corePreview: [...core.mining.chainPreview],
        preview: renderer.chainPreview,
        selection: renderer.selection,
      };
    },
    { pitch: MAX_PITCH, log: BlockType.OakLog, trunkHeight: CHAIN_TRUNK_HEIGHT },
  );

  // 松开连锁键（真实 keyup）：预览随即从画面上消失，接着挖的是单块
  await page.keyboard.up(KEY_BINDINGS.chainMining);
  const released = await page.evaluate(() => {
    const { core, renderer } = window.__VOXEL__!;
    core.tick();
    renderer.render(1);
    return {
      corePreview: core.mining.chainPreview.length,
      preview: renderer.chainPreview.blocks,
    };
  });
  await page.mouse.up();

  // 整根树干都进了连锁，画面上一格一个轮廓，顺序与核心报的一致
  expect(chained.cells).toHaveLength(CHAIN_TRUNK_HEIGHT);
  expect(chained.corePreview).toEqual(chained.cells);
  expect(chained.preview.blocks).toEqual(chained.cells);
  // 选框只套着对准的那一块，预览比它多出下面那几块
  expect(chained.selection.target).toEqual(chained.cells[0]);
  // 两圈线颜色不同：「这一下挖哪块」与「这一下会碎哪些」在画面上分得开
  expect(chained.preview.color).not.toBe(chained.selection.color);

  expect(released.corePreview).toBe(0);
  expect(released.preview).toEqual([]);
  expect(errors).toEqual([]);
});

test('屏幕底部有 9 格快捷栏，开局全是空的', async ({ page }) => {
  const hotbar = page.locator('#hotbar');
  await expect(hotbar).toBeVisible();
  await expect(hotbar).toHaveAttribute('aria-label', STRINGS.hotbar);
  await expect(page.locator('#hotbar .hotbar__slot')).toHaveCount(HOTBAR_SIZE);

  // 真的在屏幕下半边
  const box = await hotbar.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThan(viewport!.height / 2);

  // 开局空手：没有一格带物品
  await expect(page.locator('#hotbar .hotbar__slot[data-item]')).toHaveCount(0);
  await expect(page.locator('#hotbar .hotbar__icon:visible')).toHaveCount(0);
});

test('按住左键一秒把脚下的草挖掉，掉出的泥土进快捷栏', async ({ page }) => {
  await grabPointer(page);

  // 按下与松开走的是真实的鼠标事件（指针锁定下 mouse.down 投得到 document 上的监听器）。
  // 中间只留两次 evaluate：锁定期间 headless Chromium 把整页任务调度降到约 1/10，
  // 每来回一次都要好几秒，多一次就会超过测试的超时上限。
  await page.mouse.down();
  // **对准要在按下之后**：指针锁定下 Playwright 的 mouse.down 会连带投一发大位移的
  // mousemove，视角当场被甩到别处，按下之前对准的方向会被它抵消——真人按键不会有
  // 这发位移。
  // 推进时间同样走 evaluate，不等真实时钟：throttle 之下靠时钟数 tick 不可靠。
  const at = await page.evaluate(
    ({ pitch, ticks }) => {
      const core = window.__VOXEL__!.core;
      const target = {
        x: Math.floor(core.player.position.x),
        y: Math.floor(core.player.position.y) - 1,
        z: Math.floor(core.player.position.z),
      };
      // 低头看到底、偏航归零：视线因此几乎竖直向下，对着脚下那一格
      core.turn(-core.player.yaw, -pitch - core.player.pitch);
      // 一秒 = 20 tick，草 18 tick 碎
      core.tick(ticks);
      return target;
    },
    { pitch: MAX_PITCH, ticks: TICK_RATE },
  );
  await page.mouse.up();
  // 掉落物落在坑里，拾取延迟一过就被吸走。HUD 那一步平时由游戏循环发起，
  // 同步 evaluate 里没有帧，得自己调。
  const dugOut = await page.evaluate(
    ({ ticks, block }) => {
      const { core, hud } = window.__VOXEL__!;
      core.tick(ticks);
      hud.update();
      return core.getBlock(block.x, block.y, block.z);
    },
    { ticks: PICKUP_DELAY_TICKS + 1, block: at },
  );
  expect(dugOut).toBe(BlockType.Air);

  // 快捷栏第一格出现泥土图标
  const first = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  await expect(first).toHaveAttribute('data-item', String(ItemType.Dirt));
  await expect(first).toHaveAttribute('title', ITEM_NAMES[ItemType.Dirt]);
  await expect(first.locator('.hotbar__icon')).toBeVisible();
  // 图标贴的是不是泥土那一格，在下面那条不锁鼠标的测试里验：读图集要发一次请求，
  // 而指针锁定期间页面的任务调度被降到约 1/10，异步请求在这里会迟迟回不来。
  expect(errors).toEqual([]);
});

test('快捷栏图标取的就是图集里泥土那一格', async ({ page }) => {
  // 不锁鼠标：这条要发一次网络请求，锁定期间的 throttle 会让它迟迟回不来。
  const icon = await page.evaluate(
    async ({ pitch, grassTicks, pickupDelay }) => {
      const { core, hud } = window.__VOXEL__!;
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(grassTicks);
      core.setMining(false);
      core.tick(pickupDelay + 1);
      hud.update();

      const element = document.querySelector('#hotbar .hotbar__slot[data-slot="0"] .hotbar__icon');
      if (!(element instanceof HTMLElement)) throw new Error('快捷栏第一格没有图标');
      const style = getComputedStyle(element);
      const url = style.backgroundImage.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');

      // 真去解一遍这张图，而不是看 fetch 的状态码：开发服务器对认不出的路径回的是
      // index.html，状态码 200，光看 ok 那条断言等于没有。
      const atlas = new Image();
      const decoded = await new Promise<boolean>((resolve) => {
        atlas.onload = () => resolve(true);
        atlas.onerror = () => resolve(false);
        atlas.src = url;
      });

      return {
        decoded,
        atlasWidth: atlas.naturalWidth,
        atlasHeight: atlas.naturalHeight,
        // 计算值是解析过 calc 的像素数
        backgroundPosition: style.backgroundPosition,
        iconPx: Number.parseFloat(style.width),
      };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      pickupDelay: PICKUP_DELAY_TICKS,
    },
  );

  // 图集真解得开、尺寸就是图集那个尺寸，而且 CSS 那串 calc 算出来的偏移正好落在泥土
  // 那一格上。`toBeVisible` 挡不住这两种错——图加载失败、偏移指错格，元素照样有尺寸。
  const { col, row } = tileCell(ITEM_TILES[ItemType.Dirt].side);
  expect(icon.decoded).toBe(true);
  expect(icon.atlasWidth).toBe(ATLAS_COLS * TILE_PX);
  expect(icon.atlasHeight).toBe(ATLAS_ROWS * TILE_PX);
  expect(icon.backgroundPosition).toBe(`${-col * icon.iconPx}px ${-row * icon.iconPx}px`);
  expect(errors).toEqual([]);
});

test('挖两块并进同一堆，快捷栏这才显示数量', async ({ page }) => {
  // 不锁鼠标：测的是 HUD，挖掘意图直接给核心。整段跑在一次同步的 evaluate 里，
  // 游戏循环插不进来，拾取到几个因此是精确的——锁定期间的任务调度会把这一点打乱。
  const shown = await page.evaluate(
    ({ pitch, grassTicks, dirtTicks, pickupDelay }) => {
      const { core, hud } = window.__VOXEL__!;
      const countText = (): string =>
        document.querySelector('#hotbar .hotbar__slot[data-slot="0"] .hotbar__count')
          ?.textContent ?? '缺格子';

      /** 挖掉当前对准的那一块，等它被吸进背包，再刷新 HUD。 */
      const digAndPickUp = (ticks: number): void => {
        core.setMining(true);
        core.tick(ticks);
        core.setMining(false);
        core.tick(pickupDelay + 1);
        hud.update();
      };

      core.turn(0, -pitch);
      // 地表的草，掉 1 个泥土
      digAndPickUp(grassTicks);
      const one = countText();
      // 玩家掉进坑里，脚下换成了坑底那格泥土，再掉 1 个
      digAndPickUp(dirtTicks);
      return {
        one,
        two: countText(),
        slot0: core.inventory.slot(0),
        filledSlots: document.querySelectorAll('#hotbar .hotbar__slot[data-item]').length,
      };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      dirtTicks: miningTicks(BlockType.Dirt, BARE_HAND),
      pickupDelay: PICKUP_DELAY_TICKS,
    },
  );

  // 只有一个时不写数字，与原版一致：满屏的「1」除了占地方没有信息
  expect(shown.one).toBe('');
  expect(shown.two).toBe('2');
  // 并成一堆而不是占两格
  expect(shown.slot0).toEqual({ item: ItemType.Dirt, count: 2 });
  expect(shown.filledSlots).toBe(1);
  expect(errors).toEqual([]);
});

test('掉落物画成会转会漂的小方块，被拾取后从画面上消失', async ({ page }) => {
  await waitForFullViewDistance(page);

  // 整段跑在一次同步的 evaluate 里：游戏循环插不进来，画面与 tick 数因此是精确的。
  const dug = await page.evaluate(
    ({ pitch, grassTicks, pickupDelay, settleTicks, stone }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const y = Math.floor(core.player.position.y) - 1;

      // 把坑底换成石头：掉落物是泥土的褐色，衬在石头的灰上，画面正中那一像素才分得出
      // 小方块在不在。默认地形里草下面也是泥土，两者同色，就验不到东西了。
      core.setBlock(x, y - 1, z, stone);
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(grassTicks);
      core.setMining(false);
      // 等掉落物落定、玩家也掉进坑里站稳，再往下都在拾取延迟之内
      core.tick(settleTicks);

      // 先画一帧：小方块是 render() 里摆进场景的，不画就没有它的位置可读
      renderer.syncChunkMeshes();
      renderer.render(1);

      // 把视线对准场景里那个小方块的中心
      const [mesh] = renderer.drops;
      if (!mesh) throw new Error('场景里应该有一个掉落物小方块');
      const eye = core.player.eyePosition;
      const dx = mesh.position.x - eye.x;
      const dy = mesh.position.y - eye.y;
      const dz = mesh.position.z - eye.z;
      core.turn(
        Math.atan2(-dx, -dz) - core.player.yaw,
        Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch,
      );

      // 同一个 alpha 再画一帧：相位没变，小方块还在刚才那个位置，只是视线转过去了
      renderer.render(1);
      const settled = { drops: renderer.drops, rgb: centerRgb() };
      // 同一份核心状态、另一个插值系数：漂浮与旋转是逐帧算的，所以高度与角度都该不一样
      renderer.render(0);
      const sameTick = renderer.drops;

      // 玩家就站在掉落物旁边，拾取延迟一过就被吸走，小方块随即从场景里移除
      core.tick(pickupDelay + 1);
      renderer.render(1);
      const gone = { drops: renderer.drops, rgb: centerRgb() };

      return { settled, sameTick, gone, dropCount: core.drops.count };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      pickupDelay: PICKUP_DELAY_TICKS,
      settleTicks: DROP_SETTLE_TICKS,
      stone: BlockType.Stone,
    },
  );

  /** 褐（泥土）而不是灰（石头）：红色分量明显压过蓝色。 */
  const isDirtColored = (rgb: readonly number[]): boolean => rgb[0]! > rgb[2]! * 1.5;

  // 场景里有一个小方块，而且真画进了画布：视线对准它，画面正中是泥土的褐
  expect(dug.settled.drops).toHaveLength(1);
  expect(isDirtColored(dug.settled.rgb)).toBe(true);

  // 会转、会漂：同一个 tick 的两帧之间，角度与高度都变了
  expect(dug.sameTick[0]!.id).toBe(dug.settled.drops[0]!.id);
  expect(dug.sameTick[0]!.spin).not.toBeCloseTo(dug.settled.drops[0]!.spin, 4);
  expect(dug.sameTick[0]!.position.y).not.toBeCloseTo(dug.settled.drops[0]!.position.y, 4);
  // 「漂浮整段都在落点之上、不沉进地面」要看一整个周期，浏览器里抓不到那么多帧
  // （中途就被拾取了），那一条在 tests/render/drop-motion.test.ts 里。

  // 被拾取：核心里没有了，场景里那个小方块也不见了，同一条视线看到的是石头的灰
  expect(dug.dropCount).toBe(0);
  expect(dug.gone.drops).toEqual([]);
  expect(isDirtColored(dug.gone.rgb)).toBe(false);
  expect(errors).toEqual([]);
});

test('屏幕底部有等级条，压在快捷栏上方，开局 0 级、进度条是空的', async ({ page }) => {
  const bar = page.locator('#level-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-label', STRINGS.levelBar);
  await expect(bar).toHaveAttribute('data-level', '0');
  await expect(page.locator('#level-bar .levelbar__level')).toHaveText('0');

  const track = page.locator('#level-bar .levelbar__track');
  await expect(track).toHaveAttribute('role', 'progressbar');
  await expect(track).toHaveAttribute('aria-label', STRINGS.levelProgress);
  await expect(track).toHaveAttribute('aria-valuenow', '0');
  // 0 级升 1 级要 7 点，见 tests/core/experience.test.ts
  await expect(track).toHaveAttribute('aria-valuemax', '7');

  // 等级条整条压在快捷栏之上，两者不重叠
  const barBox = await bar.boundingBox();
  const hotbarBox = await page.locator('#hotbar').boundingBox();
  expect(barBox).not.toBeNull();
  expect(hotbarBox).not.toBeNull();
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(hotbarBox!.y);
  // 进度条与快捷栏同宽：宽度只有快捷栏那一处算式
  expect(barBox!.width).toBeCloseTo(hotbarBox!.width, 0);

  // 一点经验都没有，填充是 0 宽
  const fill = await page.evaluate(() => {
    const element = document.querySelector('#level-bar .levelbar__fill');
    if (!(element instanceof HTMLElement)) throw new Error('等级条缺填充');
    return Number.parseFloat(getComputedStyle(element).width);
  });
  expect(fill).toBe(0);
});

test('挖方块把等级条填起来，攒够就升级', async ({ page }) => {
  // 不锁鼠标：测的是 HUD，挖掘意图直接给核心。整段跑在一次同步的 evaluate 里，
  // 游戏循环插不进来，攒了几点因此是精确的。
  const samples = await page.evaluate(
    ({ pitch, grassTicks, dirtTicks, absorbTicks }) => {
      const { core, hud } = window.__VOXEL__!;

      /** 等级条现在画的是什么，加核心里的经验值好对照。 */
      const read = (): Record<string, unknown> => {
        const bar = document.querySelector('#level-bar');
        const track = document.querySelector('#level-bar .levelbar__track');
        const fill = document.querySelector('#level-bar .levelbar__fill');
        if (
          !(bar instanceof HTMLElement) ||
          !(track instanceof HTMLElement) ||
          !(fill instanceof HTMLElement)
        ) {
          throw new Error('等级条不完整');
        }
        return {
          level: bar.dataset.level,
          text: bar.querySelector('.levelbar__level')?.textContent,
          valueNow: track.getAttribute('aria-valuenow'),
          valueMax: track.getAttribute('aria-valuemax'),
          fillPx: Number.parseFloat(getComputedStyle(fill).width),
          trackPx: Number.parseFloat(getComputedStyle(track).width),
          total: core.experience.total,
        };
      };

      /** 挖掉当前对准的那一块，等经验球飞过来被吸收，再刷新 HUD。 */
      const digOneBlock = (ticks: number): void => {
        core.setMining(true);
        core.tick(ticks);
        // 必须松手：按住不放会接着挖下面那块，一次就攒了两块的经验
        core.setMining(false);
        core.tick(absorbTicks);
        hud.update();
      };

      core.turn(0, -pitch);
      // 一路往下挖：草之下是泥土，都是空手挖得动的
      digOneBlock(grassTicks);
      const firstBlock = read();

      // 再挖两块泥土，一块 3 点，攒过 7 点就升 1 级
      digOneBlock(dirtTicks);
      digOneBlock(dirtTicks);
      return { firstBlock, levelledUp: read() };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      dirtTicks: miningTicks(BlockType.Dirt, BARE_HAND),
      absorbTicks: XP_ABSORB_TICKS,
    },
  );

  // 一块草 3 点：还是 0 级，进度条填了 3/7
  expect(samples.firstBlock.total).toBe(3);
  expect(samples.firstBlock.level).toBe('0');
  expect(samples.firstBlock.valueNow).toBe('3');
  expect(samples.firstBlock.valueMax).toBe('7');
  const { fillPx, trackPx } = samples.firstBlock as { fillPx: number; trackPx: number };
  expect(fillPx / trackPx).toBeCloseTo(3 / 7, 2);

  // 攒过 7 点：数字变成 1，等级内经验重新从头算
  expect(samples.levelledUp.total).toBeGreaterThanOrEqual(7);
  expect(Number(samples.levelledUp.level)).toBeGreaterThanOrEqual(1);
  expect(samples.levelledUp.text).toBe(samples.levelledUp.level);
  expect(Number(samples.levelledUp.valueNow)).toBeLessThan(Number(samples.levelledUp.valueMax));
  expect(errors).toEqual([]);
});

test('经验球画成小方块飞向玩家，被吸收后从画面上消失', async ({ page }) => {
  await waitForFullViewDistance(page);

  // 整段跑在一次同步的 evaluate 里：游戏循环插不进来，画面与 tick 数因此是精确的。
  const dug = await page.evaluate(
    ({ pitch, stoneTicks, absorbTicks, stone }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const y = Math.floor(core.player.position.y) - 1;

      // 挖石头而不是草：石头空手挖没有掉落，坑里因此只有经验球。挖草的话掉落物那个
      // 小方块（0.25 格）比经验球（0.2 格）大，两者又都生成在同一格的中心，画面正中
      // 那一像素看到的会是掉落物而不是经验球。
      core.setBlock(x, y, z, stone);
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(stoneTicks);
      core.setMining(false);

      // 方块刚碎，经验球还在原来那一格里。先画一帧：小方块是 render() 里摆进场景的
      renderer.syncChunkMeshes();
      renderer.render(1);

      // 把视线对准场景里那个小方块的中心，再用同一个 alpha 画一帧
      const [mesh] = renderer.xpOrbs;
      if (!mesh) throw new Error('场景里应该有一个经验球小方块');
      const eye = core.player.eyePosition;
      core.turn(
        Math.atan2(-(mesh.position.x - eye.x), -(mesh.position.z - eye.z)) - core.player.yaw,
        Math.atan2(
          mesh.position.y - eye.y,
          Math.hypot(mesh.position.x - eye.x, mesh.position.z - eye.z),
        ) - core.player.pitch,
      );
      renderer.render(1);
      const spawned = { orbs: renderer.xpOrbs, drops: renderer.drops, rgb: centerRgb() };

      // 飞一个 tick：同一个编号的小方块换了位置
      core.tick(1);
      renderer.render(1);
      const flying = renderer.xpOrbs;
      // 同一份核心状态、另一个插值系数：位置该落在上一个 tick 与这一个 tick 之间
      renderer.render(0);
      const sameTick = renderer.xpOrbs;

      // 玩家就站在坑口，几 tick 就吸收了，小方块随即从场景里移除
      core.tick(absorbTicks);
      renderer.render(1);
      return {
        spawned,
        flying,
        sameTick,
        gone: renderer.xpOrbs,
        rgbAfter: centerRgb(),
        orbCount: core.xpOrbs.count,
        total: core.experience.total,
      };
    },
    {
      pitch: MAX_PITCH,
      stoneTicks: miningTicks(BlockType.Stone, BARE_HAND),
      absorbTicks: XP_ABSORB_TICKS,
      stone: BlockType.Stone,
    },
  );

  /** 黄绿（经验球）而不是褐（泥土）：绿色分量明显压过红色。 */
  const isXpColored = (rgb: readonly number[]): boolean => rgb[1]! > rgb[0]! * 1.2;

  // 空手挖石头什么都不掉，坑里只有经验球
  expect(dug.spawned.drops).toEqual([]);
  // 场景里有一个小方块，而且真画进了画布：视线对准它，画面正中是经验球的黄绿
  expect(dug.spawned.orbs).toHaveLength(1);
  expect(isXpColored(dug.spawned.rgb)).toBe(true);

  // 还是同一个经验球（渲染层按编号认对象），位置变了：它在往玩家那边飞
  expect(dug.flying[0]!.id).toBe(dug.spawned.orbs[0]!.id);
  expect(dug.flying[0]!.position.y).not.toBeCloseTo(dug.spawned.orbs[0]!.position.y, 4);
  // 「每 tick 都离玩家更近、一次也不冲过头」要看整段飞行，那一条在 tests/core/xp-orb.test.ts
  expect(dug.sameTick[0]!.position.y).not.toBeCloseTo(dug.flying[0]!.position.y, 4);

  // 被吸收：核心里没有了，场景里那个小方块也不见了，同一条视线看到的是泥土的褐
  expect(dug.orbCount).toBe(0);
  expect(dug.gone).toEqual([]);
  expect(isXpColored(dug.rgbAfter)).toBe(false);
  expect(dug.total).toBe(3);
  expect(errors).toEqual([]);
});

/**
 * 站在一格深的坑里斜着往下看的俯仰：−30°。
 * 视线越过坑沿落在旁边那一格的顶面上，所以放置的落点在坑外，不与玩家相交。
 */
const ASIDE_PITCH = -Math.PI / 6;

/** 朝 +X 看的偏航。 */
const EAST_YAW = -Math.PI / 2;

test('数字键与滚轮切换选中格，快捷栏跟着高亮', async ({ page }) => {
  /**
   * 滚一下（`deltaY` 给 0 表示不滚），推进一个 tick 让选中格生效，再读核心与快捷栏
   * 各自认的是第几格。
   *
   * 滚轮用合成事件而不是 `page.mouse.wheel`：那个方法要等页面把滚动做完才返回，而指针
   * 锁定期间 headless Chromium 把整页的任务调度降到约 1/10，这个等待等不回来（实测卡满
   * 30 秒的超时）。事件仍然投给真的监听器，走的还是输入适配器那条线。
   */
  const step = async (
    deltaY = 0,
  ): Promise<{ core: number; marked: string | undefined; highlighted: number }> =>
    page.evaluate((dy) => {
      const { core, hud } = window.__VOXEL__!;
      if (dy !== 0) {
        document.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, cancelable: true }));
      }
      // 选中格下一个 tick 生效（ADR-0004）；HUD 那一步平时由游戏循环发起
      core.tick();
      hud.update();
      const marked = document.querySelectorAll('#hotbar .hotbar__slot[data-selected]');
      const first = marked[0];
      return {
        core: core.inventory.selectedSlot,
        marked: first instanceof HTMLElement ? first.dataset.slot : undefined,
        highlighted: marked.length,
      };
    }, deltaY);

  await grabPointer(page);
  // 开局选中第一格，而且只有一格高亮
  expect(await step()).toEqual({ core: 0, marked: '0', highlighted: 1 });

  // 数字键 3 选中第三格（真实按键）
  await page.keyboard.press(HOTBAR_KEY_CODES[2]!);
  expect(await step()).toEqual({ core: 2, marked: '2', highlighted: 1 });

  // 往下滚一格
  expect(await step(120)).toEqual({ core: 3, marked: '3', highlighted: 1 });

  // 往上滚回来
  expect(await step(-120)).toEqual({ core: 2, marked: '2', highlighted: 1 });
  expect(errors).toEqual([]);
});

/**
 * 挖来一块泥土，再站在坑里斜着看旁边那一格的顶面。返回放置的落点与手上那一堆。
 *
 * 真实地形是起伏的，所以先把东边那一条铺平——视线落在哪一格因此算得准。挖掘那条线由
 * 别的测试验，这里直接把意图给核心。放置的两条测试共用这一段。
 */
async function digDirtAndAimAside(
  page: Page,
): Promise<{ spot: Vec3; held: ItemStack | undefined }> {
  return page.evaluate(
    ({ pitch, grassTicks, pickupTicks, eastYaw, asidePitch, grass, air }) => {
      const core = window.__VOXEL__!.core;
      /** 把视角转到绝对的偏航与俯仰上。 */
      const look = (yaw: number, to: number): void =>
        core.turn(yaw - core.player.yaw, to - core.player.pitch);

      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const groundY = Math.floor(core.player.position.y) - 1;
      for (let dx = 0; dx <= 5; dx++) {
        core.setBlock(x + dx, groundY, z, grass);
        core.setBlock(x + dx, groundY + 1, z, air);
        core.setBlock(x + dx, groundY + 2, z, air);
      }

      // 挖掉脚下那块草：泥土进快捷栏第一格，玩家掉进一格深的坑里
      look(0, -pitch);
      core.setMining(true);
      core.tick(grassTicks);
      core.setMining(false);
      core.tick(pickupTicks);

      look(eastYaw, asidePitch);
      core.tick();
      const target = core.mining.target;
      if (!target) throw new Error('斜着往下看应该对准旁边那一格');
      return {
        // 落点是命中面外侧那一格，这里自己算一遍，不调核心那个函数
        spot: {
          x: target.x + target.normal.x,
          y: target.y + target.normal.y,
          z: target.z + target.normal.z,
        },
        held: core.inventory.held,
      };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      eastYaw: EAST_YAW,
      asidePitch: ASIDE_PITCH,
      grass: BlockType.Grass,
      air: BlockType.Air,
    },
  );
}

test('锁定鼠标后右键把手上的方块放回世界，网格跟着重建', async ({ page }) => {
  await waitForFullViewDistance(page);
  await grabPointer(page);
  const aimed = await digDirtAndAimAside(page);
  expect(aimed.held).toEqual({ item: ItemType.Dirt, count: 1 });

  // 按键与它生效的那一个 tick 必须在同一次同步的 evaluate 里，游戏循环才插不进来。
  const placed = await page.evaluate(
    ({ spot, placeButton }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      renderer.syncChunkMeshes();
      renderer.render(1);
      const before = {
        block: core.getBlock(spot.x, spot.y, spot.z),
        vertices: renderer.chunkMeshVertexCount(0, 0),
      };

      // 右键：事件真的经过输入适配器（监听器就挂在 document 上）。
      // 用合成事件而不是 page.mouse.down：指针锁定下 Playwright 的鼠标事件会连带投递一次
      // 大位移的 mousemove，视线当场偏到别处，而放置在下一个 tick 才生效——那一 tick
      // 什么时候来由游戏循环说了算，届时对准的已经不是刚才那一格。真右键的那一面由
      // 「未锁定鼠标时右键不放置」验。
      document.dispatchEvent(new MouseEvent('mousedown', { button: placeButton }));
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      hud.update();

      return {
        before,
        after: {
          block: core.getBlock(spot.x, spot.y, spot.z),
          vertices: renderer.chunkMeshVertexCount(0, 0),
        },
        slot0: core.inventory.slot(0),
        filledSlots: document.querySelectorAll('#hotbar .hotbar__slot[data-item]').length,
      };
    },
    { spot: aimed.spot, placeButton: MOUSE_BINDINGS.use },
  );

  // 挖来的那一个泥土放回了世界：落点原来是空气，现在是泥土方块
  expect(placed.before.block).toBe(BlockType.Air);
  expect(placed.after.block).toBe(BlockType.Dirt);
  // 快捷栏那一格空了
  expect(placed.slot0).toBeUndefined();
  expect(placed.filledSlots).toBe(0);
  // 网格跟着重建：那一格所在区块的顶点数变了
  expect(placed.after.vertices).not.toBe(placed.before.vertices);
  expect(errors).toEqual([]);
});

test('未锁定鼠标时右键不放置', async ({ page }) => {
  const aimed = await digDirtAndAimAside(page);
  expect(aimed.held).toEqual({ item: ItemType.Dirt, count: 1 });

  // 真按一下右键（Playwright 按名字给按钮，'right' 就是 MOUSE_BINDINGS.use 那个编号）。
  // 没有指针锁定，输入适配器一概不理——Esc 之后不该还能改世界。
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });

  const after = await page.evaluate((spot) => {
    const core = window.__VOXEL__!.core;
    core.tick(2);
    return { block: core.getBlock(spot.x, spot.y, spot.z), held: core.inventory.held };
  }, aimed.spot);

  expect(after.block).toBe(BlockType.Air);
  expect(after.held).toEqual({ item: ItemType.Dirt, count: 1 });
  expect(errors).toEqual([]);
});

test('锁定鼠标后右键不弹出浏览器菜单', async ({ page }) => {
  /** 投一发可取消的 contextmenu，返回它被拦下了没有。 */
  const menuBlocked = async (): Promise<boolean> =>
    page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    });

  // 没进第一人称时右键还是浏览器的事
  expect(await menuBlocked()).toBe(false);

  // 锁定期间右键是放置，菜单一弹就抢走了后面的按键
  await grabPointer(page);
  expect(await menuBlocked()).toBe(true);
  expect(errors).toEqual([]);
});

test('右下角画着手上那块方块，切换选中格时跟着换', async ({ page }) => {
  await waitForFullViewDistance(page);

  // 不锁鼠标：测的是渲染层，挖掘与选格直接给核心。整段跑在一次同步的 evaluate 里，
  // 游戏循环插不进来，读到的就是刚断言的那一帧。
  const hand = await page.evaluate(
    ({ pitch, grassTicks, logTicks, pickupTicks, log }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;
      const look = (yaw: number, to: number): void =>
        core.turn(yaw - core.player.yaw, to - core.player.pitch);

      renderer.syncChunkMeshes();
      renderer.render(1);
      // 开局空手，右下角什么都不画
      const emptyAtStart = renderer.heldItem;

      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const groundY = Math.floor(core.player.position.y) - 1;

      // 挖掉脚下那块草：泥土进第一格
      look(0, -pitch);
      core.setMining(true);
      core.tick(grassTicks);
      core.setMining(false);
      core.tick(pickupTicks);

      // 把新的脚下那一格换成原木再挖掉：原木物品另占一格，手上因此有两种东西
      core.setBlock(x, groundY - 1, z, log);
      core.setMining(true);
      core.tick(logTicks);
      core.setMining(false);
      core.tick(pickupTicks);

      // 抬头看天：右下角那块方块衬在天空上，那一处是褐还是蓝分得清清楚楚
      look(0, pitch);
      renderer.syncChunkMeshes();
      renderer.render(1);
      const dirt = renderer.heldItem;
      if (!dirt) throw new Error('手上有泥土时右下角应该画着一块方块');
      const dirtRgb = pixel(dirt.screen.x, dirt.screen.y);

      // 切到第二格：手上换成原木
      core.selectHotbarSlot(1);
      core.tick();
      renderer.render(1);
      const oak = renderer.heldItem;

      // 切到空着的第三格：右下角什么都不画了，同一处露出天空
      core.selectHotbarSlot(2);
      core.tick();
      renderer.render(1);
      const empty = renderer.heldItem;

      return {
        emptyAtStart,
        dirt,
        dirtRgb,
        oak,
        empty,
        emptyRgb: pixel(dirt.screen.x, dirt.screen.y),
        hotbar: core.inventory.hotbar(),
      };
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      logTicks: miningTicks(BlockType.OakLog, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      log: BlockType.OakLog,
    },
  );

  /** 褐（方块贴图）而不是蓝（天空）：红色分量压过蓝色。 */
  const isBrown = (rgb: readonly number[]): boolean => rgb[0]! > rgb[2]!;

  expect(hand.hotbar[0]).toEqual({ item: ItemType.Dirt, count: 1 });
  expect(hand.hotbar[1]).toEqual({ item: ItemType.OakLog, count: 1 });

  // 开局空手不画
  expect(hand.emptyAtStart).toBeUndefined();

  // 手上有泥土：右下角有一块方块，落在画面的右半边、下半边，而且没出画面
  expect(hand.dirt!.item).toBe(ItemType.Dirt);
  expect(hand.dirt!.screen.x).toBeGreaterThan(0.2);
  expect(hand.dirt!.screen.x).toBeLessThan(1);
  expect(hand.dirt!.screen.y).toBeLessThan(-0.2);
  expect(hand.dirt!.screen.y).toBeGreaterThan(-1);
  // 真画进了画布：那一处是方块贴图的褐，不是天空的蓝
  expect(isBrown(hand.dirtRgb)).toBe(true);

  // 切一格就换成原木，切到空格就不画了，天空重新露出来
  expect(hand.oak!.item).toBe(ItemType.OakLog);
  expect(hand.empty).toBeUndefined();
  expect(isBrown(hand.emptyRgb)).toBe(false);
  expect(errors).toEqual([]);
});

test('贴着墙站着，手上那块方块不会被墙切穿', async ({ page }) => {
  await waitForFullViewDistance(page);
  // 先挖来一块泥土（顺带把东边那一条铺平）
  const aimed = await digDirtAndAimAside(page);
  expect(aimed.held).toEqual({ item: ItemType.Dirt, count: 1 });

  const wall = await page.evaluate(
    ({ eastYaw, stone, walkTicks }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;
      const look = (yaw: number, to: number): void =>
        core.turn(yaw - core.player.yaw, to - core.player.pitch);

      // 东边隔一格砌一堵石墙，高度盖住眼睛，再走过去贴着它平视
      const wallX = Math.floor(core.player.position.x) + 1;
      const z = Math.floor(core.player.position.z);
      const feetY = Math.floor(core.player.position.y);
      core.setBlock(wallX, feetY + 1, z, stone);
      core.setBlock(wallX, feetY + 2, z, stone);
      look(eastYaw, 0);
      core.setMoveIntent({ forward: true, back: false, left: false, right: false, jump: false });
      core.tick(walkTicks);
      core.setMoveIntent({ forward: false, back: false, left: false, right: false, jump: false });

      renderer.syncChunkMeshes();
      renderer.render(1);
      const held = renderer.heldItem;
      if (!held) throw new Error('手上有泥土时右下角应该画着一块方块');

      return {
        // 眼睛到墙面的距离：贴住了就是玩家的半宽
        eyeToWall: wallX - core.player.position.x,
        heldRgb: pixel(held.screen.x, held.screen.y),
        wallRgb: pixel(0, 0),
      };
    },
    { eastYaw: EAST_YAW, stone: BlockType.Stone, walkTicks: TICK_RATE },
  );

  // 真的贴住了墙：眼睛离墙面只有半个碰撞箱宽，比手上那块方块（0.72 格）近得多
  expect(wall.eyeToWall).toBeCloseTo(PLAYER_WIDTH / 2, 5);
  // 画面正中是石头的灰（三个分量差不多）
  expect(Math.abs(wall.wallRgb[0] - wall.wallRgb[2])).toBeLessThan(12);
  // 手持那一点仍是泥土的褐：手持是单独一遍渲染，不参与世界的深度测试
  expect(wall.heldRgb[0] - wall.heldRgb[2]).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('按 E 打开背包界面，36 格与快捷栏对应，再按 E 关闭', async ({ page }) => {
  const screen = page.locator('#inventory-screen');
  // 开局关着
  await expect(screen).toBeHidden();

  await grabPointer(page);
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();

  // 打开时鼠标交还给页面：玩家要用它点格子
  await expect.poll(() => readLockedElementId(page)).toBe(null);

  // 文字来自简体中文字符串表
  await expect(screen).toHaveAttribute('aria-label', STRINGS.inventory);
  await expect(page.locator('#inventory-screen .invscreen__title')).toHaveText(STRINGS.inventory);

  // 36 格加合成网格那 4 格，其中一行 9 格就是快捷栏
  await expect(page.locator('#inventory-screen .invscreen__slot')).toHaveCount(
    INVENTORY_SIZE + CRAFTING_CELLS,
  );
  await expect(
    page.locator('#inventory-screen .invscreen__hotbar .invscreen__slot'),
  ).toHaveCount(HOTBAR_SIZE);
  // 底部那一栏收起来：屏幕上不会同时出现两排快捷栏
  await expect(page.locator('#hud')).toBeHidden();

  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  await expect(page.locator('#hud')).toBeVisible();
  expect(errors).toEqual([]);
});

test('关掉背包界面之后鼠标自动回到第一人称，视角不被甩一下', async ({ page }) => {
  await grabPointer(page);
  const screen = page.locator('#inventory-screen');
  const look = async (): Promise<{ yaw: number; pitch: number }> =>
    page.evaluate(() => {
      const { yaw, pitch } = window.__VOXEL__!.core.player;
      return { yaw, pitch };
    });

  const before = await look();
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();
  await expect.poll(() => readLockedElementId(page)).toBe(null);

  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  // 不必再点一下画面：界面一关就回到指针锁定，网页鼠标随即消失
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  // 锁定生效时浏览器补投的那发光标归位 mousemove 必须被丢掉，否则关掉背包视角就转过去了
  expect(await look()).toEqual(before);
  expect(errors).toEqual([]);
});

test('按住背包键不放，界面不会反复开关', async ({ page }) => {
  await grabPointer(page);
  const screen = page.locator('#inventory-screen');
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();

  // 按住不放，浏览器每几十毫秒补发一次 keydown，带的是 repeat: true。切换型的键必须把
  // 这些挡掉，否则界面每个 tick 开一次关一次。Playwright 的 keyboard.down 不模拟连发，
  // 所以这里合成事件——投的是同一个监听器。每发之间等过一个 tick（50ms），
  // 挡不住的话第一发就把界面关了。
  for (let i = 0; i < 5; i++) {
    await page.evaluate(
      (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: true })),
      KEY_BINDINGS.inventory,
    );
    await page.waitForTimeout(60);
  }
  await expect(screen).toBeVisible();
  expect(errors).toEqual([]);
});

test('背包界面开着时按 Esc 关掉它', async ({ page }) => {
  await grabPointer(page);
  const screen = page.locator('#inventory-screen');
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();

  // 界面开着时指针锁定已经交还，Esc 不再被浏览器吃掉，由输入适配器关掉界面
  await page.keyboard.press(INVENTORY_CLOSE_KEY);
  await expect(screen).toBeHidden();
  // 与按背包键关界面一样，鼠标自动回到第一人称
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  expect(errors).toEqual([]);
});

test('背包界面里点一格拿起泥土，再点空格放下', async ({ page }) => {
  // 先挖一块草拿到泥土，再打开界面。挖掘与开合都直接给核心：这条测的是界面里的鼠标
  // 点击，而指针锁定期间 headless Chromium 会把页面的任务调度降到约 1/10。
  await page.evaluate(
    ({ pitch, grassTicks, pickupTicks }) => {
      const core = window.__VOXEL__!.core;
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(grassTicks);
      core.setMining(false);
      core.tick(pickupTicks);
      core.toggleInventory();
      core.tick();
    },
    {
      pitch: MAX_PITCH,
      grassTicks: miningTicks(BlockType.Grass, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
    },
  );

  const screen = page.locator('#inventory-screen');
  await expect(screen).toBeVisible();

  // 界面里的第一格就是快捷栏的第一格，挖来的泥土在这里
  const first = page.locator('#inventory-screen .invscreen__slot[data-slot="0"]');
  await expect(first).toHaveAttribute('data-item', String(ItemType.Dirt));
  await expect(first).toHaveAttribute('title', ITEM_NAMES[ItemType.Dirt]);

  // 点它：整堆到光标上，那一格空了（点击下一个 tick 生效，界面由游戏循环刷新）
  const cursor = page.locator('#inventory-screen .invscreen__cursor');
  await expect(cursor).toBeHidden();
  await first.click();
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveAttribute('data-item', String(ItemType.Dirt));
  await expect(first).not.toHaveAttribute('data-item', /./);

  // 再点储物格那一侧的空格：放下去，光标空了
  const storage = page.locator('#inventory-screen .invscreen__slot[data-slot="20"]');
  await storage.click();
  await expect(storage).toHaveAttribute('data-item', String(ItemType.Dirt));
  await expect(cursor).toBeHidden();
  // HUD 的快捷栏跟着空了：界面里那一格与 HUD 那一格是同一格
  await expect(page.locator('#hotbar .hotbar__slot[data-slot="0"][data-item]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('背包界面里有 2x2 合成网格与输出格，放进原木后输出格出现木板，点它拿走', async ({ page }) => {
  // 脚下那块换成原木再挖来：东西只能挖来，核心没有往背包里塞物品的入口。挖掘与开合都
  // 直接给核心，理由同上一条。
  await giveOneLog(page);
  await openInventoryScreen(page);

  const screen = page.locator('#inventory-screen');
  await expect(screen).toBeVisible();

  // 网格 4 格，格号接在 36 格之后；输出格单独一个，文字来自字符串表
  const gridCells = page.locator('#inventory-screen .invscreen__grid .invscreen__slot');
  await expect(gridCells).toHaveCount(CRAFTING_CELLS);
  await expect(gridCells.first()).toHaveAttribute('data-slot', String(INVENTORY_SIZE));
  const output = page.locator('#inventory-screen [data-output]');
  await expect(output).toBeVisible();
  await expect(output).toHaveAttribute('aria-label', STRINGS.craftingOutput);
  await expect(output).not.toHaveAttribute('data-item', /./);

  // 拿起原木放进网格第一格：输出格出现木板
  const first = page.locator('#inventory-screen .invscreen__slot[data-slot="0"]');
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakLog));
  await first.click();
  await gridCells.first().click();
  await expect(gridCells.first()).toHaveAttribute('data-item', String(ItemType.OakLog));
  await expect(output).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(output).toHaveAttribute('title', ITEM_NAMES[ItemType.OakPlanks]);
  await expect(output.locator('.invscreen__count')).toHaveText('4');

  // 点输出格：4 块木板到光标上，原木用掉，输出格空了
  const cursor = page.locator('#inventory-screen .invscreen__cursor');
  await output.click();
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(cursor.locator('.invscreen__count')).toHaveText('4');
  await expect(gridCells.first()).not.toHaveAttribute('data-item', /./);
  await expect(output).not.toHaveAttribute('data-item', /./);
  expect(errors).toEqual([]);
});

test('合成出的木板放到世界里，画面正中从草绿变成木板的褐黄', async ({ page }) => {
  await waitForFullViewDistance(page);

  // 木板只能合成来：脚下换成原木挖来，在背包界面里合成，再关掉界面放到旁边。整段跑在
  // 一次同步的 evaluate 里，游戏循环不会在中间执行，读到的就是刚断言的那一帧。
  const placed = await page.evaluate(
    ({ pitch, logTicks, pickupTicks, eastYaw, asidePitch, grass, air, oakLog, gridFirst }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      const look = (yaw: number, to: number): void =>
        core.turn(yaw - core.player.yaw, to - core.player.pitch);

      // 把东边一条铺平：斜看过去对准的是一块草的顶面，放下的木板落在它前面、正对视线
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const groundY = Math.floor(core.player.position.y) - 1;
      for (let dx = 0; dx <= 5; dx++) {
        core.setBlock(x + dx, groundY, z, grass);
        core.setBlock(x + dx, groundY + 1, z, air);
        core.setBlock(x + dx, groundY + 2, z, air);
      }
      core.setBlock(x, groundY, z, oakLog);

      look(0, -pitch);
      core.setMining(true);
      core.tick(logTicks);
      core.setMining(false);
      core.tick(pickupTicks);

      core.toggleInventory();
      core.tick();
      core.clickSlot(0);
      core.clickSlot(gridFirst);
      core.clickCraftingOutput();
      core.toggleInventory();
      core.tick();
      const held = core.inventory.held;

      look(eastYaw, asidePitch);
      core.tick();
      const target = core.mining.target;
      if (!target) throw new Error('斜着往下看应该对准旁边那一格');
      const spot = {
        x: target.x + target.normal.x,
        y: target.y + target.normal.y,
        z: target.z + target.normal.z,
      };
      renderer.syncChunkMeshes();
      renderer.render(1);
      const before = { block: core.getBlock(spot.x, spot.y, spot.z), rgb: centerRgb() };

      core.use();
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      const after = { block: core.getBlock(spot.x, spot.y, spot.z), rgb: centerRgb() };

      return { held, before, after, heldAfter: core.inventory.held };
    },
    {
      pitch: MAX_PITCH,
      logTicks: miningTicks(BlockType.OakLog, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      eastYaw: EAST_YAW,
      asidePitch: ASIDE_PITCH,
      grass: BlockType.Grass,
      air: BlockType.Air,
      oakLog: BlockType.OakLog,
      gridFirst: INVENTORY_SIZE,
    },
  );

  expect(placed.held).toEqual({ item: ItemType.OakPlanks, count: 4 });
  // 落点原来是空气，正中是草的绿；放下之后是木板方块，正中变成木板的褐黄（红分量大于绿与蓝）
  expect(placed.before.block).toBe(BlockType.Air);
  expect(placed.before.rgb[1]).toBeGreaterThan(placed.before.rgb[0]);
  expect(placed.after.block).toBe(BlockType.OakPlanks);
  expect(placed.after.rgb[0]).toBeGreaterThan(placed.after.rgb[1]);
  expect(placed.after.rgb[0]).toBeGreaterThan(placed.after.rgb[2]);
  expect(placed.heldAfter).toEqual({ item: ItemType.OakPlanks, count: 3 });
  expect(errors).toEqual([]);
});

test('两堆木板竖排进合成网格，输出格出现带图标与中文名的木棍', async ({ page }) => {
  // 两根原木出两堆木板：第一堆先放回快捷栏，第二堆从输出格拿到光标上——所以是两堆而不是
  // 并成一堆。挖两块与合成都直接给核心，理由同上一条。
  await page.evaluate(
    ({ pitch, logTicks, pickupTicks, oakLog, gridFirst, landingTicks }) => {
      const core = window.__VOXEL__!.core;
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const groundY = Math.floor(core.player.position.y) - 1;
      core.setBlock(x, groundY, z, oakLog);
      core.setBlock(x, groundY - 1, z, oakLog);

      // 一路往下挖两块：挖穿一块掉下去，目标当场落到下面那块上
      core.turn(0, -pitch);
      core.setMining(true);
      core.tick(2 * (logTicks + landingTicks));
      core.setMining(false);
      core.tick(pickupTicks);

      core.toggleInventory();
      core.tick();
      // 两根原木进网格，出第一堆木板放回第一格；再出第二堆留在光标上
      core.clickSlot(0);
      core.clickSlot(gridFirst);
      core.clickCraftingOutput();
      core.clickSlot(0);
      core.clickCraftingOutput();
      // 第二堆放进网格左下，第一堆再拿起来放进左上：左列竖排两块木板
      core.clickSlot(gridFirst + 2);
      core.clickSlot(0);
      core.clickSlot(gridFirst);
      core.tick();
    },
    {
      pitch: MAX_PITCH,
      logTicks: miningTicks(BlockType.OakLog, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      oakLog: BlockType.OakLog,
      gridFirst: INVENTORY_SIZE,
      landingTicks: LANDING_TICKS,
    },
  );

  const gridCells = page.locator('#inventory-screen .invscreen__grid .invscreen__slot');
  await expect(gridCells.nth(0)).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(gridCells.nth(2)).toHaveAttribute('data-item', String(ItemType.OakPlanks));

  const output = page.locator('#inventory-screen [data-output]');
  await expect(output).toHaveAttribute('data-item', String(ItemType.Stick));
  await expect(output).toHaveAttribute('title', ITEM_NAMES[ItemType.Stick]);
  await expect(output.locator('.invscreen__count')).toHaveText('4');
  // 图标取的是图集里木棍那一格
  const { col, row } = tileCell(ITEM_TILES[ItemType.Stick].side);
  const icon = output.locator('.invscreen__icon');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
  expect(errors).toEqual([]);
});

/**
 * 配方书里成品是这种物品的那一条。按成品图标定位而不是按 data-recipe 的序号：序号是核心按
 * 网格尺寸过滤之后的下标，配方表里加进 3x3 专属配方之后，2x2 那本的序号就与配方表对不上了。
 */
function recipeEntry(book: Locator, item: ItemType): Locator {
  return book.locator('[data-recipe]', {
    has: book.page().locator(`.invscreen__recipe-icon[data-item="${item}"]`),
  });
}

/**
 * 在一层开着的界面里验配方书：面板在、文案来自字符串表、木板配方亮着而木棍配方暗着；
 * 点木板配方之后原木进网格、背包那一格空了、输出格显示 4 块木板；点暗着的木棍配方无事发生。
 */
async function expectRecipeBookWorks(page: Page, screenId: string): Promise<void> {
  const book = page.locator(`#${screenId} .invscreen__recipes`);
  await expect(book).toBeVisible();
  await expect(book).toHaveAttribute('aria-label', STRINGS.recipeBook);
  await expect(book.locator('.invscreen__recipes-title')).toHaveText(STRINGS.recipeBook);
  // 配方表的每一条都摆得进 2x2，两套界面因此列的都是整张表
  await expect(book.locator('[data-recipe]')).toHaveCount(RECIPES.length);

  const planks = recipeEntry(book, ItemType.OakPlanks);
  const sticks = recipeEntry(book, ItemType.Stick);
  await expect(planks).toHaveAttribute('data-craftable', 'true');
  await expect(planks).toHaveAttribute('aria-disabled', 'false');
  await expect(planks.locator('.invscreen__recipe-name')).toHaveText(ITEM_NAMES[ItemType.OakPlanks]);
  await expect(planks.locator('.invscreen__recipe-icon')).toHaveAttribute(
    'data-item',
    String(ItemType.OakPlanks),
  );
  await expect(sticks).toHaveAttribute('data-craftable', 'false');
  await expect(sticks).toHaveAttribute('aria-disabled', 'true');

  // 点暗着的木棍配方：原木还在第一格，网格空着
  const first = page.locator(`#${screenId} .invscreen__slot[data-slot="0"]`);
  const gridFirst = page.locator(`#${screenId} .invscreen__grid .invscreen__slot`).first();
  const output = page.locator(`#${screenId} [data-output]`);
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakLog));
  await sticks.click();
  await page.waitForTimeout(100);
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakLog));
  await expect(gridFirst).not.toHaveAttribute('data-item', /./);
  await expect(output).not.toHaveAttribute('data-item', /./);

  // 点亮着的木板配方：原木进网格左上角，背包那一格空了，输出格图标变为木板
  await planks.click();
  await expect(gridFirst).toHaveAttribute('data-item', String(ItemType.OakLog));
  await expect(first).not.toHaveAttribute('data-item', /./);
  await expect(output).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(output.locator('.invscreen__count')).toHaveText('4');
  // 原木进了网格，背包里没有了：木板配方仍然亮着，因为网格里的也算材料
  await expect(planks).toHaveAttribute('data-craftable', 'true');
}

test('背包界面右侧有配方书，点木板配方自动摆料，输出格出现木板', async ({ page }) => {
  await giveOneLog(page);
  await openInventoryScreen(page);
  await expect(page.locator('#inventory-screen')).toBeVisible();
  await expectRecipeBookWorks(page, 'inventory-screen');
  expect(errors).toEqual([]);
});

test('工作台界面右侧也有配方书，点木板配方自动摆料', async ({ page }) => {
  await giveOneLog(page);
  // 挖完站在一格深的坑里，工作台摆在眼前那一格，使用键直接给核心
  await setTableAhead(page);
  await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    core.use();
    core.tick();
  });
  await expect(page.locator('#crafting-table-screen')).toBeVisible();
  await expectRecipeBookWorks(page, 'crafting-table-screen');
  expect(errors).toEqual([]);
});

/**
 * 挖穿一块之后玩家落到下一块上、目标方块重算完成要的 tick 数。连着往下挖几块时每块加上它，
 * 后一块的挖掘才从落地之后算起。
 */
const LANDING_TICKS = 4;

/** 换到这个尺寸再核对一遍居中：宽高都跟默认视口不一样，两边还都是奇数。 */
const ODD_VIEWPORT = { width: 901, height: 533 };

test('屏幕正中有十字准星，改窗口尺寸后仍在正中，而且不吃鼠标事件', async ({ page }) => {
  const crosshair = page.locator('#crosshair');
  await expect(crosshair).toBeVisible();
  await expect(crosshair).toHaveAttribute('aria-label', STRINGS.crosshair);
  await expectCenteredOnScreen(crosshair);

  // 换个窗口尺寸：居中靠的是 CSS 里那个 50%，不是挂上去时算的那一次像素
  await page.setViewportSize(ODD_VIEWPORT);
  await expectCenteredOnScreen(crosshair);

  // 真画上去了：那一小块里既有白线的白，也有描边的墨色。深浅背景上都看得见靠的就是
  // 这两样同时在——白衬在树干、坑底上，墨边衬在天空上。
  const pixels = await readElementPixels(crosshair);
  expect(pixels.some((rgb) => rgb.every((channel) => channel >= 250))).toBe(true);
  expect(pixels.some((rgb) => rgb.every((channel) => channel <= 40))).toBe(true);

  // 准星正压在画布正中，也正是 Playwright 点 #game 时落的那一点。它要是接收鼠标事件，
  // 这一下就点在准星上，玩家永远进不了第一人称。
  await grabPointer(page);
  expect(errors).toEqual([]);
});

test('背包界面开着时不显示十字准星', async ({ page }) => {
  const crosshair = page.locator('#crosshair');
  const screen = page.locator('#inventory-screen');
  await expect(crosshair).toBeVisible();

  await grabPointer(page);
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();
  // 那时鼠标交还给页面，玩家在摆物品，不是在瞄准
  await expect(crosshair).toBeHidden();

  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  await expect(crosshair).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * 在玩家正前方紧挨着的那一格摆一个工作台，并让玩家朝它平视。返回那一格的坐标。
 *
 * 工作台由 `setBlock` 直接摆进世界：核心没有往背包里塞物品的入口，而 4 块木板合成它要先
 * 拆堆（#25）。这条测的是右键那一下的接线，不是合成。
 */
async function setTableAhead(page: Page): Promise<Vec3> {
  return page.evaluate(
    ({ table, eyeHeight }) => {
      const core = window.__VOXEL__!.core;
      const { x, y, z } = core.player.position;
      // 眼睛那一层、正前方（−Z）一格
      const spot = { x: Math.floor(x), y: Math.floor(y + eyeHeight), z: Math.floor(z) - 1 };
      core.setBlock(spot.x, spot.y, spot.z, table);
      core.turn(-core.player.yaw, -core.player.pitch);
      core.tick();
      const target = core.mining.target;
      if (!target || target.x !== spot.x || target.y !== spot.y || target.z !== spot.z) {
        throw new Error('平视时应该对准正前方那个工作台');
      }
      return spot;
    },
    { table: BlockType.CraftingTable, eyeHeight: PLAYER_EYE_HEIGHT },
  );
}

test('右键对着工作台打开工作台界面并交还鼠标，按 E 关闭并抓回鼠标，准星随之隐藏与复现', async ({
  page,
}) => {
  await setTableAhead(page);
  await grabPointer(page);
  const screen = page.locator('#crafting-table-screen');
  const inventory = page.locator('#inventory-screen');
  const crosshair = page.locator('#crosshair');
  await expect(screen).toBeHidden();
  await expect(crosshair).toBeVisible();

  // 右键：事件真的经过输入适配器。用合成事件而不是 page.mouse，理由见放置那条测试。
  // 使用下一个 tick 生效，交给游戏循环推进；释放鼠标是输入适配器在随后一帧做的。
  await page.evaluate(
    (useButton) => document.dispatchEvent(new MouseEvent('mousedown', { button: useButton })),
    MOUSE_BINDINGS.use,
  );
  await expect(screen).toBeVisible();
  await expect(inventory).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe(null);
  await expect(crosshair).toBeHidden();
  await expect(page.locator('#hud')).toBeHidden();

  // 标题与无障碍名都是「工作台」；3x3 网格 9 格，格号接在 36 格之后；36 个背包格子也都在
  await expect(screen).toHaveAttribute('aria-label', STRINGS.craftingTable);
  await expect(page.locator('#crafting-table-screen .invscreen__title')).toHaveText(
    STRINGS.craftingTable,
  );
  const gridCells = page.locator('#crafting-table-screen .invscreen__grid .invscreen__slot');
  await expect(gridCells).toHaveCount(CRAFTING_TABLE_GRID.width * CRAFTING_TABLE_GRID.height);
  await expect(gridCells.first()).toHaveAttribute('data-slot', String(INVENTORY_SIZE));
  await expect(page.locator('#crafting-table-screen .invscreen__slot')).toHaveCount(
    INVENTORY_SIZE + CRAFTING_TABLE_GRID.width * CRAFTING_TABLE_GRID.height,
  );
  await expect(page.locator('#crafting-table-screen [data-output]')).toBeVisible();

  // 按 E 关掉的是工作台界面，不是再开一层背包界面；鼠标当场回到第一人称
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  await expect(inventory).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  await expect(crosshair).toBeVisible();
  expect(errors).toEqual([]);
});

test('工作台界面开着时按 Esc 也关掉它', async ({ page }) => {
  await setTableAhead(page);
  await grabPointer(page);
  const screen = page.locator('#crafting-table-screen');
  await page.evaluate(
    (useButton) => document.dispatchEvent(new MouseEvent('mousedown', { button: useButton })),
    MOUSE_BINDINGS.use,
  );
  await expect(screen).toBeVisible();
  await expect.poll(() => readLockedElementId(page)).toBe(null);

  await page.keyboard.press(INVENTORY_CLOSE_KEY);
  await expect(screen).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  expect(errors).toEqual([]);
});

test('工作台方块画得出来：平视它时画面正中从远处的草绿变成木板的褐黄', async ({ page }) => {
  await waitForFullViewDistance(page);
  // 整段跑在一次同步的 evaluate 里，读到的就是刚画的那一帧。玩家朝 −Z 平视，工作台摆在
  // 正前方两格、眼睛那一层，正对视线的是它的 −Z 面——也就是正面。
  const rgb = await page.evaluate(
    ({ table, eyeHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.turn(-core.player.yaw, -core.player.pitch);
      renderer.render(1);
      const before = centerRgb();
      const { x, y, z } = core.player.position;
      core.setBlock(Math.floor(x), Math.floor(y + eyeHeight), Math.floor(z) - 2, table);
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      return { before, after: centerRgb() };
    },
    { table: BlockType.CraftingTable, eyeHeight: PLAYER_EYE_HEIGHT },
  );
  // 摆上之后画面正中变了，而且是木板的褐黄：红分量高于绿分量
  expect(rgb.after).not.toEqual(rgb.before);
  expect(rgb.after[0]).toBeGreaterThan(rgb.after[1]);
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
