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
import {
  FURNACE_FUEL_SLOT,
  FURNACE_INPUT_SLOT,
  FURNACE_RESULT_SLOT,
} from '../src/core/furnace-slots';
import { PICKUP_DELAY_TICKS } from '../src/core/drop';
import { MAX_HEALTH } from '../src/core/health';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../src/core/inventory';
import {
  BARE_HAND,
  ItemType,
  TOOL_MATERIALS,
  ToolMaterial,
  miningToolOf,
  type ItemStack,
} from '../src/core/item';
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
  HeldItemShape,
  ITEM_TILES,
  TILE,
  TILE_PX,
  tileCell,
} from '../src/render/atlas';
import { recipesFor, type GridSize } from '../src/core/recipe';
import { HURT_FLASH_TICKS } from '../src/ui/hurt-flash';
import { ZOMBIE_HURT_TINT_TICKS } from '../src/render/zombie-model';
import { BRIGHTNESS_FLOOR } from '../src/render/shading';
import { ATTACK_COOLDOWN_TICKS, ATTACK_RANGE } from '../src/core/attack';
import { XP_ATTRACT_RANGE } from '../src/core/xp-orb';
import { NIGHT_START } from '../src/core/time-of-day';
import {
  ZOMBIE_ATTACK_RANGE,
  ZOMBIE_BURN_DAMAGE,
  ZOMBIE_BURN_INTERVAL,
  ZOMBIE_HEIGHT,
  ZOMBIE_MAX_HEALTH,
  ZOMBIE_SPAWN_MAX_DISTANCE,
  ZOMBIE_SPAWN_MIN_DISTANCE,
  ZOMBIE_SPEED,
  ZOMBIE_XP,
} from '../src/core/zombie';
import { ITEM_NAMES, durabilityLabel, recipeLabel, STRINGS } from '../src/ui/strings';
import {
  countCanvasColors,
  installPixelProbe,
  readElementPixels,
  waitForFirstFrame,
} from './canvas';

/** 熔炉三格各自的下标与读屏名字。 */
const FURNACE_SLOTS: ReadonlyArray<readonly [number, string]> = [
  [FURNACE_INPUT_SLOT, STRINGS.furnaceInput],
  [FURNACE_FUEL_SLOT, STRINGS.furnaceFuel],
  [FURNACE_RESULT_SLOT, STRINGS.furnaceResult],
];

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
  // 核心这一侧已经卸载，网格要等下一帧游戏循环调 syncChunkMeshes 才移除（见 planChunkMeshes）。
  // CPU 负载高时两帧之间隔得很久，所以原地等到网格也没了再断言。
  await expect.poll(() => readOriginChunkState(page)).toEqual({ loaded: false, hasMesh: false });

  // 再往回退，走到原点区块重新进入视距
  await walkUntil(page, 'back', async () => (await readOriginChunkState(page)).loaded, 1000);

  // 网格还要再往回走几格才有：刚跨过加载线时原点区块朝外那一侧的邻居仍在视距之外，
  // 而网格要周围 8 个邻居齐全才建（见 planChunkMeshes）。补网格由游戏循环逐帧发起，一帧两个。
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
  // 整格方块：选框套住那一整格
  const cell = dig.aimed.selection.bounds!;
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(cell.min[axis]).toBeCloseTo(dig.at[axis]);
    expect(cell.max[axis]).toBeCloseTo(dig.at[axis] + 1);
  }
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
  // 0 级升 1 级要 7 点（见 tests/core/experience.test.ts），一块方块都没挖时进度条是空的
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
      // 往下挖：草之下是泥土，都是空手挖得动的
      digOneBlock(grassTicks);
      const firstBlock = read();

      // 再挖一块泥土，又是 30 点，等级继续上升
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

  // 一块草 30 点：0→1 级 7 点、1→2 级 9 点、2→3 级 11 点共 27 点，所以是 3 级，等级内 3 点，
  // 3→4 级共需 13 点，进度条填了 3/13
  expect(samples.firstBlock.total).toBe(30);
  expect(samples.firstBlock.level).toBe('3');
  expect(samples.firstBlock.valueNow).toBe('3');
  expect(samples.firstBlock.valueMax).toBe('13');
  const { fillPx, trackPx } = samples.firstBlock as { fillPx: number; trackPx: number };
  expect(fillPx / trackPx).toBeCloseTo(3 / 13, 2);

  // 再挖一块攒到 60 点：等级数增加，等级内经验重新从头算
  expect(samples.levelledUp.total).toBe(60);
  expect(Number(samples.levelledUp.level)).toBeGreaterThan(3);
  expect(samples.levelledUp.text).toBe(samples.levelledUp.level);
  expect(Number(samples.levelledUp.valueNow)).toBeLessThan(Number(samples.levelledUp.valueMax));
  expect(errors).toEqual([]);
});

test('等级条上方靠左有 10 颗整心，开局满血，红闪藏着', async ({ page }) => {
  const bar = page.locator('#health-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('role', 'meter');
  await expect(bar).toHaveAttribute('aria-label', STRINGS.health);
  await expect(bar).toHaveAttribute('aria-valuenow', String(MAX_HEALTH));
  const hearts = page.locator('#health-bar .health__heart');
  await expect(hearts).toHaveCount(10);
  for (const heart of await hearts.all()) await expect(heart).toHaveAttribute('data-state', 'full');
  await expect(page.locator('#hurt-flash')).toBeHidden();

  // 整排心压在等级条之上、与等级条左边对齐，宽度不到快捷栏的一半
  const barBox = await bar.boundingBox();
  const levelBox = await page.locator('#level-bar').boundingBox();
  const hotbarBox = await page.locator('#hotbar').boundingBox();
  expect(barBox).not.toBeNull();
  expect(levelBox).not.toBeNull();
  expect(hotbarBox).not.toBeNull();
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(levelBox!.y);
  expect(barBox!.x).toBeCloseTo(levelBox!.x, 0);
  expect(barBox!.width).toBeLessThan(hotbarBox!.width / 2);
  // 心是红的：取第一颗正中那个像素
  const fill = await page.evaluate(() => {
    const heart = document.querySelector('#health-bar .health__heart');
    if (!(heart instanceof HTMLElement)) throw new Error('缺心');
    return getComputedStyle(heart).backgroundColor;
  });
  expect(fill).toBe('rgb(216, 35, 42)');
  expect(errors).toEqual([]);
});

test('调试句柄挖空脚下 6 格：落地后少一颗半心，红色遮罩铺满屏幕，10 tick 后隐藏', async ({
  page,
}) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来：落地那一 tick 与之后第几 tick 都是精确的。
  const samples = await page.evaluate(
    ({ depth, flashTicks, full, air }) => {
      const { core, hud } = window.__VOXEL__!;

      /** 心与红闪现在画的是什么，加核心里的生命值好对照。 */
      const read = (): Record<string, unknown> => {
        const flash = document.querySelector('#hurt-flash');
        const bar = document.querySelector('#health-bar');
        if (!(flash instanceof HTMLElement) || !(bar instanceof HTMLElement)) {
          throw new Error('生命值界面不完整');
        }
        const box = flash.getBoundingClientRect();
        return {
          points: core.health.points,
          valueNow: bar.getAttribute('aria-valuenow'),
          hearts: [...bar.querySelectorAll<HTMLElement>('.health__heart')].map(
            (heart) => heart.dataset.state,
          ),
          flashShown: getComputedStyle(flash).display !== 'none',
          flashCovers: box.width === window.innerWidth && box.height === window.innerHeight,
          flashColor: getComputedStyle(flash).backgroundColor,
        };
      };

      const { x, z } = core.player.position;
      const column = { x: Math.floor(x), z: Math.floor(z) };
      const top = core.highestBlockY(column.x, column.z);
      for (let y = top; y > top - depth; y--) core.setBlock(column.x, y, column.z, air);

      let ticks = 0;
      while (core.health.points === full && ticks < 100) {
        core.tick();
        ticks++;
      }
      hud.update();
      const landed = read();
      core.tick(flashTicks - 1);
      hud.update();
      const lastFlashTick = read();
      core.tick();
      hud.update();
      return { landed, lastFlashTick, after: read() };
    },
    { depth: 6, flashTicks: HURT_FLASH_TICKS, full: MAX_HEALTH, air: BlockType.Air },
  );

  // 落差 6 格，超出 3 格的部分每格 1 点：20 → 17，8 颗整心、1 颗半心、1 颗空心
  expect(samples.landed.points).toBe(17);
  expect(samples.landed.valueNow).toBe('17');
  expect(samples.landed.hearts).toEqual([...Array(8).fill('full'), 'half', 'empty']);
  expect(samples.landed.flashShown).toBe(true);
  expect(samples.landed.flashCovers).toBe(true);
  // 半透明的红，不是不透明的一块：不透明度 0.35
  expect(samples.landed.flashColor).toContain('0.35');

  expect(samples.lastFlashTick.flashShown).toBe(true);
  expect(samples.after.flashShown).toBe(false);
  expect(samples.after.points).toBe(17);
  expect(errors).toEqual([]);
});

test('调试句柄让玩家摔死：死亡画面铺满屏幕并交还鼠标，背包键与 Esc 关不掉它；点重生按钮回到出生点、重新锁定鼠标、心满', async ({
  page,
}) => {
  await grabPointer(page);
  // 挖空脚下 24 格，落地摔 21 点。整段跑在一次同步的 evaluate 里，游戏循环插不进来
  const died = await page.evaluate(
    ({ depth, air }) => {
      const { core, hud } = window.__VOXEL__!;
      const { x, z } = core.player.position;
      const column = { x: Math.floor(x), z: Math.floor(z) };
      const top = core.highestBlockY(column.x, column.z);
      for (let y = top; y > top - depth; y--) core.setBlock(column.x, y, column.z, air);
      for (let ticks = 0; ticks < 100 && !core.health.dead; ticks++) core.tick();
      hud.update();
      return { dead: core.health.dead, points: core.health.points };
    },
    { depth: 24, air: BlockType.Air },
  );
  expect(died).toEqual({ dead: true, points: 0 });

  const screen = page.locator('#death-screen');
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute('aria-label', STRINGS.youDied);
  await expect(page.locator('#death-screen .death-screen__title')).toHaveText(STRINGS.youDied);
  const respawn = page.getByRole('button', { name: STRINGS.respawn });
  await expect(respawn).toBeVisible();
  // 铺满视口，准星与底部那一栏都收起
  const box = await screen.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toEqual({ x: 0, y: 0, width: viewport!.width, height: viewport!.height });
  await expect(page.locator('#crosshair')).toBeHidden();
  await expect(page.locator('#hud')).toBeHidden();
  // 死亡那一帧由游戏循环把鼠标交还给页面
  await expect.poll(() => readLockedElementId(page)).toBe(null);

  // 背包键与 Esc 都关不掉它，不打开背包界面，也不把鼠标抓回去
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await page.keyboard.press(INVENTORY_CLOSE_KEY);
  await page.evaluate(() => {
    const { core, hud } = window.__VOXEL__!;
    core.tick();
    hud.update();
  });
  await expect(screen).toBeVisible();
  await expect(page.locator('#inventory-screen')).toBeHidden();
  expect(await readLockedElementId(page)).toBe(null);

  await respawn.click();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  // 锁定期间 headless Chromium 的 rAF 降到约 1/10（见 `walkWhileHolding`），界面在这里显式刷新一次再读
  const after = await page.evaluate(() => {
    const { core, hud } = window.__VOXEL__!;
    hud.update();
    const shown = (selector: string): boolean => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement && getComputedStyle(element).display !== 'none';
    };
    return {
      dead: core.health.dead,
      points: core.health.points,
      atSpawn: JSON.stringify(core.player.position) === JSON.stringify(core.spawnPoint),
      deathScreen: shown('#death-screen'),
      crosshair: shown('#crosshair'),
      hud: shown('#hud'),
      hearts: [...document.querySelectorAll<HTMLElement>('#health-bar .health__heart')].map(
        (heart) => heart.dataset.state,
      ),
    };
  });
  expect(after).toEqual({
    dead: false,
    points: MAX_HEALTH,
    atSpawn: true,
    deathScreen: false,
    crosshair: true,
    hud: true,
    hearts: Array(MAX_HEALTH / 2).fill('full'),
  });
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
  expect(dug.total).toBe(30);
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

/** 投一发可取消的 contextmenu，返回它被输入适配器拦下了没有。 */
async function menuBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('锁定鼠标后右键不弹出浏览器菜单', async ({ page }) => {
  // 没进第一人称时右键还是浏览器的事
  expect(await menuBlocked(page)).toBe(false);

  // 锁定期间右键是放置，菜单一弹就抢走了后面的按键
  await grabPointer(page);
  expect(await menuBlocked(page)).toBe(true);
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

/** 玩家站在一格深的坑里时的整数坐标：所在列的 x 与 z，加眼睛那一层的 y。眼前那一格就是 (x, eyeY, z − 1)。 */
interface PitSpot {
  readonly x: number;
  readonly eyeY: number;
  readonly z: number;
}

/**
 * 通过调试句柄让玩家拿到一把木镐：脚下换成原木挖穿掉进坑里，坑里眼前再摆一根原木挖来，再远一格
 * 摆工作台，用配方书三步造出木镐放进第 0 格（选中格），最后关掉工作台界面。
 *
 * 原木只能挖来，木镐只能造出来：核心没有直接往背包里放物品的入口。整段在一次同步的 evaluate 里
 * 给核心，游戏循环插不进来。返回玩家站的那个坑的位置，后面几条测试据此在眼前摆方块。
 */
async function craftPickaxeIntoHand(page: Page): Promise<PitSpot> {
  return page.evaluate(
    ({ pitch, logTicks, pickupTicks, oakLog, table, eyeHeight, planks, stick, pickaxe }) => {
      const { core } = window.__VOXEL__!;
      const look = (yaw: number, to: number): void =>
        core.turn(yaw - core.player.yaw, to - core.player.pitch);
      const dig = (ticks: number): void => {
        core.setMining(true);
        core.tick(ticks);
        core.setMining(false);
        core.tick(pickupTicks);
      };
      const x = Math.floor(core.player.position.x);
      const z = Math.floor(core.player.position.z);
      const groundY = Math.floor(core.player.position.y) - 1;

      // 脚下换成原木挖掉：1 根原木进第一格，玩家掉进一格深的坑
      core.setBlock(x, groundY, z, oakLog);
      look(0, -pitch);
      dig(logTicks);
      // 坑里平视，眼前那一格摆第二根原木挖掉，掉落物落在脚边拾起
      const eyeY = Math.floor(core.player.position.y + eyeHeight);
      core.setBlock(x, eyeY, z - 1, oakLog);
      look(0, 0);
      core.tick();
      dig(logTicks);
      // 再远一格摆工作台，使用键打开它
      core.setBlock(x, eyeY, z - 2, table);
      core.tick();
      core.use();
      core.tick();
      if (!core.craftingTableScreen.open) throw new Error('对着工作台按使用键应该打开工作台界面');

      // 依次点配方书：两根原木出 8 块木板（第 20 格），2 块木板出 4 根木棍（第 21 格），
      // 3 块木板加 2 根木棍出木镐（放进第 0 格，也就是选中格）
      const recipe = (item: number): number =>
        core.craftingTableScreen.crafting!.recipes.findIndex((e) => e.recipe.result.item === item);
      for (let i = 0; i < 2; i++) {
        core.clickRecipe(recipe(planks));
        core.clickCraftingOutput();
        core.clickSlot(20);
      }
      core.clickRecipe(recipe(stick));
      core.clickCraftingOutput();
      core.clickSlot(21);
      core.clickRecipe(recipe(pickaxe));
      core.clickCraftingOutput();
      core.clickSlot(0);
      core.toggleInventory();
      core.tick();
      if (core.inventory.held?.item !== pickaxe) throw new Error('造完木镐应该拿在手上');
      return { x, eyeY, z };
    },
    {
      pitch: MAX_PITCH,
      logTicks: miningTicks(BlockType.OakLog, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      oakLog: BlockType.OakLog,
      table: BlockType.CraftingTable,
      eyeHeight: PLAYER_EYE_HEIGHT,
      planks: ItemType.OakPlanks,
      stick: ItemType.Stick,
      pickaxe: ItemType.WoodenPickaxe,
    },
  );
}

test('在工作台里造出木镐拿在手上：快捷栏画它的图标与中文名，右下角画平面图标而不是立方体', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  await craftPickaxeIntoHand(page);

  // 渲染层直接调：不锁鼠标、不等游戏循环，读到的就是刚画的那一帧。
  const hand = await page.evaluate(
    ({ pitch, dirtTicks, pickupTicks }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;

      renderer.syncChunkMeshes();
      renderer.render(1);
      const tool = renderer.heldItem;
      if (!tool) throw new Error('手上有木镐时右下角应该画着东西');
      const toolRgb = pixel(tool.screen.x, tool.screen.y);

      // 低头再挖一块泥土：进第二格，切过去手上就是泥土
      core.turn(-core.player.yaw, -pitch - core.player.pitch);
      core.setMining(true);
      core.tick(dirtTicks);
      core.setMining(false);
      core.tick(pickupTicks);
      core.selectHotbarSlot(1);
      core.tick();
      renderer.render(1);
      const dirt = renderer.heldItem;
      window.__VOXEL__!.hud.update();
      return { tool, toolRgb, dirt, hotbar: core.inventory.hotbar() };
    },
    {
      pitch: MAX_PITCH,
      // 持镐挖泥土与空手一样慢：镐不是泥土的合格工具
      dirtTicks: miningTicks(BlockType.Dirt, BARE_HAND),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
    },
  );

  expect(hand.hotbar[0]).toEqual({ item: ItemType.WoodenPickaxe, count: 1, damage: 1 });
  expect(hand.hotbar[1]).toEqual({ item: ItemType.Dirt, count: 1 });

  // 手持木镐：画的是平面图标，落在右下角，那一处是木柄的褐而不是天空的蓝
  expect(hand.tool).toMatchObject({ item: ItemType.WoodenPickaxe, shape: HeldItemShape.Flat });
  expect(hand.tool.screen.x).toBeGreaterThan(0.2);
  expect(hand.tool.screen.y).toBeLessThan(-0.2);
  expect(hand.toolRgb[0]).toBeGreaterThan(hand.toolRgb[2]);
  // 切回泥土又是立方体
  expect(hand.dirt).toMatchObject({ item: ItemType.Dirt, shape: HeldItemShape.Cube });

  // 快捷栏第一格画的是木镐的图标；只有一把，不写数字
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.WoodenPickaxe));
  await expect(slot.locator('.hotbar__count')).toHaveText('');
  const { col, row } = tileCell(ITEM_TILES[ItemType.WoodenPickaxe].side);
  const icon = slot.locator('.hotbar__icon');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
  expect(errors).toEqual([]);
});

/**
 * 在玩家眼前那一格摆一块石头，持木镐挖穿它并拾起掉出来的圆石，再刷一次 HUD。
 * 玩家站在 `craftPickaxeIntoHand` 留下的那个坑里，眼前那一格正是第二根原木挖掉后空出来的。
 */
async function mineStoneAhead(page: Page, at: PitSpot): Promise<void> {
  await page.evaluate(
    ({ x, eyeY, z, stone, stoneTicks, pickupTicks }) => {
      const { core, hud } = window.__VOXEL__!;
      core.setBlock(x, eyeY, z - 1, stone);
      core.turn(-core.player.yaw, -core.player.pitch);
      core.tick();
      const target = core.mining.target;
      if (!target || target.z !== z - 1) throw new Error('平视时应该对准眼前那块石头');
      core.setMining(true);
      core.tick(stoneTicks);
      core.setMining(false);
      core.tick(pickupTicks);
      hud.update();
    },
    {
      ...at,
      stone: BlockType.Stone,
      stoneTicks: miningTicks(BlockType.Stone, miningToolOf({ item: ItemType.WoodenPickaxe, count: 1 })),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
    },
  );
}

test('持木镐挖石头掉圆石，快捷栏的木镐格上出现耐久条并随挖掘缩短，背包界面里同一格也有', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  const at = await craftPickaxeIntoHand(page);
  await page.evaluate(() => window.__VOXEL__!.hud.update());

  // 新造的木镐满耐久：格子上没有耐久条，提示只有物品名
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  const bar = slot.locator('.hotbar__durability');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.WoodenPickaxe));
  await expect(slot).toHaveAttribute('title', ITEM_NAMES[ItemType.WoodenPickaxe]);
  await expect(bar).toBeHidden();

  // 挖穿一块石头：第二格拿到圆石，木镐损耗 1 点，耐久条出现，长度是 58/59
  await mineStoneAhead(page, at);
  const max = TOOL_MATERIALS[ToolMaterial.Wood].durability;
  const second = page.locator('#hotbar .hotbar__slot[data-slot="1"]');
  await expect(second).toHaveAttribute('data-item', String(ItemType.Cobblestone));
  await expect(second).toHaveAttribute('title', ITEM_NAMES[ItemType.Cobblestone]);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveCSS('--durability', String((max - 1) / max));
  await expect(bar).toHaveAttribute('aria-valuenow', String(max - 1));
  await expect(bar).toHaveAttribute('aria-valuemax', String(max));
  await expect(slot).toHaveAttribute(
    'title',
    durabilityLabel(ITEM_NAMES[ItemType.WoodenPickaxe], max - 1, max),
  );
  // 填充占轨道的 58/59；轨道本身与图标一样宽
  const fill = bar.locator('.hotbar__durability-fill');
  const track = (await bar.boundingBox())!.width;
  const width = (await fill.boundingBox())!.width;
  expect(width).toBeCloseTo((track * (max - 1)) / max, 0);

  // 再挖一块：损耗 2 点，填充更短；圆石并成 2 个
  await mineStoneAhead(page, at);
  await expect(bar).toHaveCSS('--durability', String((max - 2) / max));
  expect((await fill.boundingBox())!.width).toBeLessThan(width);
  await expect(second.locator('.hotbar__count')).toHaveText('2');

  // 背包界面里的第 0 格是同一格，耐久条同样在
  await openInventoryScreen(page);
  await page.evaluate(() => window.__VOXEL__!.hud.update());
  const screenBar = page.locator(
    '#inventory-screen .invscreen__slot[data-slot="0"] .invscreen__durability',
  );
  await expect(screenBar).toBeVisible();
  await expect(screenBar).toHaveCSS('--durability', String((max - 2) / max));
  expect(errors).toEqual([]);
});

test('攒 3 个圆石在工作台造出石镐：快捷栏画石镐的图标与中文名，挖石头 12 tick 而不是 23 tick', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  const at = await craftPickaxeIntoHand(page);
  // 持木镐挖三块石头，攒够一把石镐的头
  for (let dug = 0; dug < 3; dug++) await mineStoneAhead(page, at);

  const crafted = await page.evaluate(
    ({ x, eyeY, z, stone, stonePickaxe, stoneTicks, pickupTicks }) => {
      const { core, hud } = window.__VOXEL__!;
      // 眼前那块石头挖掉了，目标落回工作台上：使用键打开界面
      core.tick();
      core.use();
      core.tick();
      if (!core.craftingTableScreen.open) throw new Error('对着工作台按使用键应该打开工作台界面');

      const entries = core.craftingTableScreen.crafting!.recipes;
      const index = entries.findIndex((e) => e.recipe.result.item === stonePickaxe);
      if (!entries[index]!.craftable) throw new Error('3 个圆石加 2 根木棍应该够造一把石镐');
      // 配方书填料、拿走成品，放进第 2 格再切过去
      core.clickRecipe(index);
      core.clickCraftingOutput();
      core.clickSlot(2);
      core.toggleInventory();
      core.selectHotbarSlot(2);
      core.tick();
      if (core.inventory.held?.item !== stonePickaxe) throw new Error('造完石镐应该拿在手上');

      // 持石镐挖眼前那块石头：12 tick 就碎，石镐损耗 1 点
      core.setBlock(x, eyeY, z - 1, stone);
      core.tick();
      core.setMining(true);
      core.tick(stoneTicks - 1);
      const standing = core.getBlock(x, eyeY, z - 1) === stone;
      core.tick(1);
      const broken = core.getBlock(x, eyeY, z - 1) !== stone;
      core.setMining(false);
      core.tick(pickupTicks);
      hud.update();
      return { standing, broken, damage: core.inventory.held?.damage };
    },
    {
      ...at,
      stone: BlockType.Stone,
      stonePickaxe: ItemType.StonePickaxe,
      stoneTicks: miningTicks(
        BlockType.Stone,
        miningToolOf({ item: ItemType.StonePickaxe, count: 1 }),
      ),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
    },
  );

  // 木镐要 23 tick，石镐 12 tick：第 11 tick 石头还在，第 12 tick 碎
  expect(crafted).toEqual({ standing: true, broken: true, damage: 1 });

  // 快捷栏第三格是石镐：图集里石镐那一格、简体中文名、损耗 1 点的耐久条
  const max = TOOL_MATERIALS[ToolMaterial.Stone].durability;
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="2"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.StonePickaxe));
  await expect(slot).toHaveAttribute(
    'title',
    durabilityLabel(ITEM_NAMES[ItemType.StonePickaxe], max - 1, max),
  );
  const bar = slot.locator('.hotbar__durability');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveCSS('--durability', String((max - 1) / max));

  const icon = slot.locator('.hotbar__icon');
  const { col, row } = tileCell(ITEM_TILES[ItemType.StonePickaxe].side);
  const iconPx = Number.parseFloat(
    await icon.evaluate((element) => getComputedStyle(element).width),
  );
  await expect(icon).toHaveCSS('background-position', `${-col * iconPx}px ${-row * iconPx}px`);
  expect(errors).toEqual([]);
});

test('调试句柄给一把铁镐拿在手上：快捷栏画铁镐的图标与中文名，右下角画平面图标，挖石头 8 tick', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  // issue #32 的数值：铁镐挖石头 8 tick。直接写字面值，页面这一层也独立核对这个数
  const stoneTicks = miningTicks(BlockType.Stone, miningToolOf({ item: ItemType.IronPickaxe, count: 1 }));
  expect(stoneTicks).toBe(8);

  // 铁锭要挖铁矿、炼上 200 tick 才有，所以用调试句柄的 giveItem 直接放进开局空着的第一格（#45）。
  // 整段跑在一次同步的 evaluate 里，渲染层直接调，读到的就是刚画的那一帧。
  const seen = await page.evaluate(
    ({ stone, ironPickaxe, eyeHeight, stoneTicks, pickupTicks }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      core.turn(-core.player.yaw, -core.player.pitch);
      const spot = {
        x: Math.floor(core.player.position.x),
        y: Math.floor(core.player.position.y + eyeHeight),
        z: Math.floor(core.player.position.z) - 1,
      };

      core.giveItem(ironPickaxe, 1);
      core.selectHotbarSlot(0);
      core.tick();
      if (core.inventory.held?.item !== ironPickaxe) throw new Error('给的铁镐应该在选中格里');

      renderer.syncChunkMeshes();
      renderer.render(1);
      const tool = renderer.heldItem;

      // 持铁镐挖眼前那块石头：第 7 tick 还在，第 8 tick 碎
      core.setBlock(spot.x, spot.y, spot.z, stone);
      core.tick();
      core.setMining(true);
      core.tick(stoneTicks - 1);
      const standing = core.getBlock(spot.x, spot.y, spot.z) === stone;
      core.tick(1);
      const broken = core.getBlock(spot.x, spot.y, spot.z) !== stone;
      core.setMining(false);
      core.tick(pickupTicks);
      hud.update();
      return { tool, standing, broken, hotbar: core.inventory.hotbar() };
    },
    {
      stone: BlockType.Stone,
      ironPickaxe: ItemType.IronPickaxe,
      eyeHeight: PLAYER_EYE_HEIGHT,
      stoneTicks,
      pickupTicks: PICKUP_DELAY_TICKS + 2,
    },
  );

  // 右下角画的是铁镐的平面图标
  expect(seen.tool).toMatchObject({ item: ItemType.IronPickaxe, shape: HeldItemShape.Flat });
  expect(seen.tool!.screen.x).toBeGreaterThan(0.2);
  expect(seen.tool!.screen.y).toBeLessThan(-0.2);
  // 铁镐挖石头 8 tick（石镐 12、木镐 23），挖穿后铁镐损耗 1 点，圆石进第二格
  expect(seen.standing).toBe(true);
  expect(seen.broken).toBe(true);
  expect(seen.hotbar[0]).toEqual({ item: ItemType.IronPickaxe, count: 1, damage: 1 });
  expect(seen.hotbar[1]).toEqual({ item: ItemType.Cobblestone, count: 1 });

  // 快捷栏第一格：图集里铁镐那一格、简体中文名、损耗 1 点的耐久条
  const max = TOOL_MATERIALS[ToolMaterial.Iron].durability;
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.IronPickaxe));
  await expect(slot).toHaveAttribute('title', durabilityLabel(ITEM_NAMES[ItemType.IronPickaxe], max - 1, max));
  await expect(slot.locator('.hotbar__durability')).toHaveCSS('--durability', String((max - 1) / max));
  const { col, row } = tileCell(ITEM_TILES[ItemType.IronPickaxe].side);
  const icon = slot.locator('.hotbar__icon');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
  expect(errors).toEqual([]);
});

test('调试句柄给一把铁剑并选中：快捷栏画铁剑的图标与中文名、满耐久不画耐久条，右下角画平面图标', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  const seen = await page.evaluate(
    ({ ironSword }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      const left = core.giveItem(ironSword, 1);
      core.selectHotbarSlot(0);
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      hud.update();
      return { left, held: renderer.heldItem, hotbar: core.inventory.hotbar() };
    },
    { ironSword: ItemType.IronSword },
  );

  expect(seen.left).toBe(0);
  expect(seen.hotbar[0]).toEqual({ item: ItemType.IronSword, count: 1 });
  // 右下角画的是铁剑的平面图标
  expect(seen.held).toMatchObject({ item: ItemType.IronSword, shape: HeldItemShape.Flat });
  expect(seen.held!.screen.x).toBeGreaterThan(0.2);
  expect(seen.held!.screen.y).toBeLessThan(-0.2);

  // 快捷栏第一格：图集里铁剑那一格、简体中文名；满耐久不画耐久条，只有一把不写数字
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.IronSword));
  await expect(slot).toHaveAttribute('title', ITEM_NAMES[ItemType.IronSword]);
  expect(ITEM_NAMES[ItemType.IronSword]).toBe('铁剑');
  await expect(slot.locator('.hotbar__durability')).toBeHidden();
  await expect(slot.locator('.hotbar__count')).toHaveText('');
  const { col, row } = tileCell(ITEM_TILES[ItemType.IronSword].side);
  const icon = slot.locator('.hotbar__icon');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
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

/**
 * 补发一次背包键的连发 keydown，再推进 1 个 tick，返回这时有没有界面开着。
 *
 * 按住不放，浏览器每几十毫秒补发一次 keydown，带的是 repeat: true。切换型的键必须把
 * 这些挡掉，否则界面每个 tick 开一次关一次。Playwright 的 keyboard.down 不模拟连发，
 * 所以这里合成事件——投的是同一个监听器。开合排到下一个 tick 才生效，tick 在同一次
 * evaluate 里显式推进，不靠 `waitForTimeout` 等游戏循环（理由见 `walkWhileHolding`）：
 * 挡不住的话这一发之后界面状态就变了。
 */
async function sendInventoryRepeat(page: Page): Promise<boolean> {
  return page.evaluate((code) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: true }));
    const core = window.__VOXEL__!.core;
    core.tick();
    return core.uiMode;
  }, KEY_BINDINGS.inventory);
}

test('按住背包键不放，界面不会反复开关', async ({ page }) => {
  await grabPointer(page);
  const screen = page.locator('#inventory-screen');
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeVisible();

  for (let i = 0; i < 5; i++) expect(await sendInventoryRepeat(page)).toBe(true);
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

test('背包界面里对格子按右键拆堆：一堆木板拆进两格排成木棍配方，不弹浏览器菜单、不放置方块', async ({
  page,
}) => {
  await giveOneLog(page);
  await openInventoryScreen(page);
  await expect(page.locator('#inventory-screen')).toBeVisible();

  const gridCells = page.locator('#inventory-screen .invscreen__grid .invscreen__slot');
  const output = page.locator('#inventory-screen [data-output]');
  const cursor = page.locator('#inventory-screen .invscreen__cursor');
  const first = page.locator('#inventory-screen .invscreen__slot[data-slot="0"]');

  // 原木进网格，点输出格：4 块木板到光标上
  await first.click();
  await gridCells.first().click();
  await output.click();
  await expect(cursor).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(cursor.locator('.invscreen__count')).toHaveText('4');

  // 以真实右键事件对左上、左下各放 1 块（事件经过界面层的事件委托）：木板竖排就是木棍配方
  await gridCells.nth(0).click({ button: 'right' });
  await expect(gridCells.nth(0)).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(cursor.locator('.invscreen__count')).toHaveText('3');
  await gridCells.nth(2).click({ button: 'right' });
  await expect(gridCells.nth(2)).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(cursor.locator('.invscreen__count')).toHaveText('2');
  await expect(output).toHaveAttribute('data-item', String(ItemType.Stick));
  await expect(output.locator('.invscreen__count')).toHaveText('4');

  // 右键输出格、右键高亮的木棍配方、右键格子之间的空隙（标题）都什么都不改变：
  // 界面层不为这几处发拆堆指令，网格里的木板仍各 1 块、光标仍 2 块
  await output.click({ button: 'right' });
  const stickRecipe = page.locator('#inventory-screen [data-recipe][data-craftable="true"]', {
    hasText: ITEM_NAMES[ItemType.Stick],
  });
  await expect(stickRecipe).toHaveCount(1);
  await stickRecipe.click({ button: 'right' });
  await page.locator('#inventory-screen .invscreen__title').click({ button: 'right' });
  await expect(output).toHaveAttribute('data-item', String(ItemType.Stick));
  await expect(gridCells.nth(0).locator('.invscreen__count')).toHaveText('');
  await expect(gridCells.nth(2).locator('.invscreen__count')).toHaveText('');
  await expect(cursor.locator('.invscreen__count')).toHaveText('2');

  // 剩下 2 块放回第 0 格（选中格，手持物品因此是木板），再右键它拿起一半：光标 1 块、格里 1 块
  // （只有 1 个时格子不显示数量）
  await first.click();
  await expect(cursor).toBeHidden();
  await expect(first.locator('.invscreen__count')).toHaveText('2');
  await first.click({ button: 'right' });
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(cursor.locator('.invscreen__count')).toHaveText('');
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(first.locator('.invscreen__count')).toHaveText('');

  // 界面开着时右键不弹浏览器菜单；也没有在世界里放置：木板合计仍是 4 块，分布在光标、第 0 格与网格里
  expect(await menuBlocked(page)).toBe(true);
  const planks = await page.evaluate((item) => {
    const core = window.__VOXEL__!.core;
    core.tick();
    const grid = core.inventoryScreen.crafting!;
    const count = (stack: ItemStack | undefined): number =>
      stack?.item === item ? stack.count : 0;
    return (
      count(core.inventory.slot(0)) +
      count(core.inventoryScreen.cursor) +
      count(grid.slot(0)) +
      count(grid.slot(2))
    );
  }, ItemType.OakPlanks);
  expect(planks).toBe(4);
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
 * 在一层开着的界面里验配方书：面板在、文案来自字符串表、木板配方高亮而木棍配方灰显；
 * 点木板配方之后原木进网格、背包那一格空了、输出格显示 4 块木板；点灰显的木棍配方没有任何反应。
 */
async function expectRecipeBookWorks(page: Page, screenId: string, grid: GridSize): Promise<void> {
  const book = page.locator(`#${screenId} .invscreen__recipes`);
  await expect(book).toBeVisible();
  await expect(book).toHaveAttribute('aria-label', STRINGS.recipeBook);
  await expect(book.locator('.invscreen__recipes-title')).toHaveText(STRINGS.recipeBook);
  // 列的是摆得进这块网格的那几条：2x2 的没有工具那三条，3x3 的是整张配方表
  await expect(book.locator('[data-recipe]')).toHaveCount(recipesFor(grid).length);

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
  // 读屏文字也来自字符串表：成品名加材料够不够
  await expect(planks).toHaveAttribute(
    'aria-label',
    recipeLabel(ITEM_NAMES[ItemType.OakPlanks], true),
  );
  await expect(sticks).toHaveAttribute('aria-label', recipeLabel(ITEM_NAMES[ItemType.Stick], false));

  // 点灰显的木棍配方：原木还在第一格，网格空着
  const first = page.locator(`#${screenId} .invscreen__slot[data-slot="0"]`);
  const gridFirst = page.locator(`#${screenId} .invscreen__grid .invscreen__slot`).first();
  const output = page.locator(`#${screenId} [data-output]`);
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakLog));
  // 灰显的那条带 aria-disabled，Playwright 会把它当成不可点的按钮一直等下去；这里要验的
  // 正是「点了没有任何反应」，所以跳过可点性检查直接点
  await sticks.click({ force: true });
  await page.waitForTimeout(100);
  await expect(first).toHaveAttribute('data-item', String(ItemType.OakLog));
  await expect(gridFirst).not.toHaveAttribute('data-item', /./);
  await expect(output).not.toHaveAttribute('data-item', /./);

  // 点高亮的木板配方：原木进网格左上角，背包那一格空了，输出格图标变为木板
  await planks.click();
  await expect(gridFirst).toHaveAttribute('data-item', String(ItemType.OakLog));
  await expect(first).not.toHaveAttribute('data-item', /./);
  await expect(output).toHaveAttribute('data-item', String(ItemType.OakPlanks));
  await expect(output.locator('.invscreen__count')).toHaveText('4');
  // 原木进了网格，背包里没有了：木板配方仍然高亮，因为网格里的也算材料
  await expect(planks).toHaveAttribute('data-craftable', 'true');
}

test('背包界面右侧有配方书，点木板配方自动填入材料，输出格出现木板', async ({ page }) => {
  await giveOneLog(page);
  await openInventoryScreen(page);
  await expect(page.locator('#inventory-screen')).toBeVisible();
  await expectRecipeBookWorks(page, 'inventory-screen', INVENTORY_CRAFTING_GRID);
  expect(errors).toEqual([]);
});

test('工作台界面右侧也有配方书，点木板配方自动填入材料', async ({ page }) => {
  await giveOneLog(page);
  // 挖完站在一格深的坑里，工作台摆在眼前那一格，使用键直接给核心
  await setUsableAhead(page);
  await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    core.use();
    core.tick();
  });
  await expect(page.locator('#crafting-table-screen')).toBeVisible();
  await expectRecipeBookWorks(page, 'crafting-table-screen', CRAFTING_TABLE_GRID);
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
 * 在玩家正前方紧挨着的那一格摆一个可使用方块（默认工作台），并让玩家朝它平视。返回那一格的坐标。
 *
 * 方块由 `setBlock` 直接摆进世界：核心没有往背包里放入物品的入口，而 4 块木板合成工作台要先
 * 拆堆（#25）、8 块圆石合成熔炉要先挖石头。这条测的是右键那一下的接线，不是合成。
 */
async function setUsableAhead(
  page: Page,
  block: BlockType = BlockType.CraftingTable,
): Promise<Vec3> {
  return page.evaluate(
    ({ block, eyeHeight }) => {
      const core = window.__VOXEL__!.core;
      const { x, y, z } = core.player.position;
      // 眼睛那一层、正前方（−Z）一格
      const spot = { x: Math.floor(x), y: Math.floor(y + eyeHeight), z: Math.floor(z) - 1 };
      core.setBlock(spot.x, spot.y, spot.z, block);
      core.turn(-core.player.yaw, -core.player.pitch);
      core.tick();
      const target = core.mining.target;
      if (!target || target.x !== spot.x || target.y !== spot.y || target.z !== spot.z) {
        throw new Error(`平视时应该对准正前方那个方块 ${block}`);
      }
      return spot;
    },
    { block, eyeHeight: PLAYER_EYE_HEIGHT },
  );
}

test('右键对着工作台打开工作台界面并交还鼠标，按 E 关闭并抓回鼠标，准星随之隐藏与复现', async ({
  page,
}) => {
  await setUsableAhead(page);
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
  // Windows 上的浏览器松开右键才发 contextmenu，这时锁定已经释放：菜单仍然不能弹出来
  expect(await menuBlocked(page)).toBe(true);

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
  await setUsableAhead(page);
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

test('右键对着熔炉打开熔炉界面：三格、两条进度条、36 格，交还鼠标；按 E 关闭并重新锁定鼠标，准星随之隐藏与复现', async ({
  page,
}) => {
  await setUsableAhead(page, BlockType.Furnace);
  await grabPointer(page);
  const screen = page.locator('#furnace-screen');
  const crosshair = page.locator('#crosshair');
  await expect(screen).toBeHidden();
  await expect(crosshair).toBeVisible();

  // 右键：事件真的经过输入适配器。用合成事件而不是 page.mouse，理由见放置那条测试。
  await page.evaluate(
    (useButton) => document.dispatchEvent(new MouseEvent('mousedown', { button: useButton })),
    MOUSE_BINDINGS.use,
  );
  await expect(screen).toBeVisible();
  await expect(page.locator('#inventory-screen')).toBeHidden();
  await expect(page.locator('#crafting-table-screen')).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe(null);
  await expect(crosshair).toBeHidden();
  await expect(page.locator('#hud')).toBeHidden();

  // 标题与无障碍名都是「熔炉」；三格接在 36 格之后、各有自己的名字；没有合成网格、输出格与配方书
  await expect(screen).toHaveAttribute('aria-label', STRINGS.furnace);
  await expect(page.locator('#furnace-screen .invscreen__title')).toHaveText(STRINGS.furnace);
  await expect(page.locator('#furnace-screen .invscreen__slot')).toHaveCount(
    INVENTORY_SIZE + FURNACE_SLOTS.length,
  );
  for (const [local, label] of FURNACE_SLOTS) {
    const cell = page.locator(`#furnace-screen [data-slot="${INVENTORY_SIZE + local}"]`);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('aria-label', label);
  }
  await expect(page.locator('#furnace-screen .invscreen__grid')).toHaveCount(0);
  await expect(page.locator('#furnace-screen [data-output]')).toHaveCount(0);
  await expect(page.locator('#furnace-screen .invscreen__recipes')).toHaveCount(0);

  // 两条进度条都在，空熔炉不点火，长度都是 0
  for (const label of [STRINGS.fuelLeft, STRINGS.smeltProgress]) {
    const bar = screen.getByRole('progressbar', { name: label });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
  }

  // 按 E 关掉的是熔炉界面，不是再开一层背包界面；鼠标当场回到第一人称
  await page.keyboard.press(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  await expect(page.locator('#inventory-screen')).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  await expect(crosshair).toBeVisible();
  expect(errors).toEqual([]);
});

test('熔炉界面开着时按 Esc 也关掉它', async ({ page }) => {
  await setUsableAhead(page, BlockType.Furnace);
  await grabPointer(page);
  const screen = page.locator('#furnace-screen');
  const crosshair = page.locator('#crosshair');
  await page.evaluate(
    (useButton) => document.dispatchEvent(new MouseEvent('mousedown', { button: useButton })),
    MOUSE_BINDINGS.use,
  );
  await expect(screen).toBeVisible();
  await expect.poll(() => readLockedElementId(page)).toBe(null);
  await expect(crosshair).toBeHidden();

  await page.keyboard.press(INVENTORY_CLOSE_KEY);
  await expect(screen).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  await expect(crosshair).toBeVisible();
  expect(errors).toEqual([]);
});

test('按住背包键不放，熔炉界面不会被连发关掉，关掉之后连发也不会打开背包界面', async ({ page }) => {
  await setUsableAhead(page, BlockType.Furnace);
  await grabPointer(page);
  const screen = page.locator('#furnace-screen');
  const inventory = page.locator('#inventory-screen');
  await page.evaluate(
    (useButton) => document.dispatchEvent(new MouseEvent('mousedown', { button: useButton })),
    MOUSE_BINDINGS.use,
  );
  await expect(screen).toBeVisible();

  for (let i = 0; i < 5; i++) expect(await sendInventoryRepeat(page)).toBe(true);
  await expect(screen).toBeVisible();

  // 第一发 keydown 关掉熔炉界面。要等鼠标重新锁定，连发才会进入背包键那个分支；
  // 没锁定、也没有界面开着时，无论有没有连发拦截，连发都会被忽略
  await page.keyboard.down(KEY_BINDINGS.inventory);
  await expect(screen).toBeHidden();
  await expect.poll(() => readLockedElementId(page)).toBe('game');
  for (let i = 0; i < 5; i++) expect(await sendInventoryRepeat(page)).toBe(false);
  await page.keyboard.up(KEY_BINDINGS.inventory);
  await expect(inventory).toBeHidden();
  expect(errors).toEqual([]);
});

test('熔炉界面画的是那个熔炉的三格：调试句柄放进去的粗铁、煤炭、铁锭出现在对应格里，点成品格拿到光标上', async ({
  page,
}) => {
  // 放东西与开界面都直接给核心：这条测的是界面里画了什么、点击递没递到，右键那一下的接线在上面
  // 两条里；而指针锁定期间 headless Chromium 会把页面的任务调度降到约 1/10。
  const spot = await setUsableAhead(page, BlockType.Furnace);
  await page.evaluate(
    ({ spot, input, fuel, output }) => {
      const core = window.__VOXEL__!.core;
      const state = core.blockStateAt(spot.x, spot.y, spot.z)!;
      state.input = input;
      state.fuel = fuel;
      state.output = output;
      core.use();
      core.tick();
    },
    {
      spot,
      input: { item: ItemType.RawIron, count: 3 },
      fuel: { item: ItemType.Coal, count: 2 },
      output: { item: ItemType.IronIngot, count: 10 },
    },
  );
  const screen = page.locator('#furnace-screen');
  await expect(screen).toBeVisible();

  const cell = (local: number): Locator =>
    page.locator(`#furnace-screen [data-slot="${INVENTORY_SIZE + local}"]`);
  await expect(cell(FURNACE_INPUT_SLOT)).toHaveAttribute('data-item', String(ItemType.RawIron));
  await expect(cell(FURNACE_INPUT_SLOT)).toHaveAttribute('title', ITEM_NAMES[ItemType.RawIron]);
  await expect(cell(FURNACE_FUEL_SLOT)).toHaveAttribute('data-item', String(ItemType.Coal));
  await expect(cell(FURNACE_RESULT_SLOT)).toHaveAttribute(
    'data-item',
    String(ItemType.IronIngot),
  );
  await expect(cell(FURNACE_RESULT_SLOT).locator('.invscreen__count')).toHaveText('10');

  // 点成品格：10 个铁锭到光标上，成品格空了
  await cell(FURNACE_RESULT_SLOT).click();
  await expect(cell(FURNACE_RESULT_SLOT)).not.toHaveAttribute('data-item');
  await expect(page.locator('#furnace-screen .invscreen__cursor')).toHaveAttribute(
    'data-item',
    String(ItemType.IronIngot),
  );
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

test('调试句柄放一块熔炉在玩家面前：画布上正面是熄火那一格，改成燃烧中编号并重建后是燃烧那一格', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  // 整段跑在一次同步的 evaluate 里。正面贴在方块的 −X 与 −Z 两面，所以玩家朝 +X 平视，熔炉摆在
  // 正前方两格、眼睛那一层：正对视线的是它的 −X 面，也就是正面，画面正中那一像素落在炉口上。
  // 两次都读回送上显卡的网格用到了哪些贴图格号：那是「画的是哪一格」的直接证据，像素颜色只作辅助。
  const seen = await page.evaluate(
    ({ furnace, lit, eyeHeight, chunkSize, eastYaw }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.turn(eastYaw - core.player.yaw, -core.player.pitch);
      const { x, y, z } = core.player.position;
      const spot = { x: Math.floor(x) + 2, y: Math.floor(y + eyeHeight), z: Math.floor(z) };
      const cx = Math.floor(spot.x / chunkSize);
      const cz = Math.floor(spot.z / chunkSize);
      const show = (block: BlockType) => {
        core.setBlock(spot.x, spot.y, spot.z, block);
        core.tick();
        renderer.syncChunkMeshes();
        renderer.render(1);
        return {
          block: core.getBlock(spot.x, spot.y, spot.z),
          tiles: renderer.chunkMeshTiles(cx, cz),
          rgb: centerRgb(),
          hasState: core.blockStateAt(spot.x, spot.y, spot.z) !== undefined,
          stateCount: core.blockStateCount,
          entries: core.allBlockStates().map(({ x, y, z }) => ({ x, y, z })),
        };
      };
      const before = core.blockStateCount;
      return { before, off: show(furnace), lit: show(lit) };
    },
    {
      furnace: BlockType.Furnace,
      lit: BlockType.LitFurnace,
      eyeHeight: PLAYER_EYE_HEIGHT,
      chunkSize: CHUNK_SIZE,
      // 朝 +X 看的偏航
      eastYaw: -Math.PI / 2,
    },
  );
  // 熄火时网格用到熄火正面、没有燃烧正面；改成燃烧中并重建后反过来
  expect(seen.off.block).toBe(BlockType.Furnace);
  expect(seen.off.tiles).toContain(TILE.furnaceFront);
  expect(seen.off.tiles).not.toContain(TILE.litFurnaceFront);
  expect(seen.lit.block).toBe(BlockType.LitFurnace);
  expect(seen.lit.tiles).toContain(TILE.litFurnaceFront);
  expect(seen.lit.tiles).not.toContain(TILE.furnaceFront);
  // 顶面与侧面两次都在
  for (const tiles of [seen.off.tiles, seen.lit.tiles]) {
    expect(tiles).toContain(TILE.furnaceTop);
    expect(tiles).toContain(TILE.furnaceSide);
  }
  // 画面正中：熄火时是炉口的近黑，燃烧时是火的橙——红分量高得多，且红 > 绿 > 蓝
  expect(seen.lit.rgb[0]).toBeGreaterThan(seen.off.rgb[0] + 60);
  expect(seen.lit.rgb[0]).toBeGreaterThan(seen.lit.rgb[1]);
  expect(seen.lit.rgb[1]).toBeGreaterThan(seen.lit.rgb[2]);
  // 调试句柄读得到状态表：放下建了一条，换编号那条还在
  expect(seen.before).toBe(0);
  expect(seen.off.hasState).toBe(true);
  expect(seen.off.stateCount).toBe(1);
  expect(seen.lit.hasState).toBe(true);
  expect(seen.lit.stateCount).toBe(1);
  expect(seen.off.entries).toEqual(seen.lit.entries);
  expect(seen.lit.entries).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('调试句柄往熔炉放粗铁与煤炭：推进后区块网格用到燃烧正面，界面两条进度条长度非零；1600 tick 后网格回到熄火正面', async ({
  page,
}) => {
  const spot = await setUsableAhead(page, BlockType.Furnace);
  // 放东西、推进、开界面都在一次同步的 evaluate 里：游戏循环在两次 evaluate 之间也在推进，读数得
  // 在同一段里取，才对得上刚推进的那几 tick。网格读回送上显卡的贴图格号，那是「画的是哪一格」的
  // 直接证据。8 个粗铁够一件煤炭炼满 1600 tick，这期间熔炼进度不会停在 0。
  const burning = await page.evaluate(
    ({ spot, input, fuel, chunkSize, progressTicks, fuelLabel, progressLabel }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      const cx = Math.floor(spot.x / chunkSize);
      const cz = Math.floor(spot.z / chunkSize);
      const state = core.blockStateAt(spot.x, spot.y, spot.z)!;
      state.input = input;
      state.fuel = fuel;
      core.tick();
      renderer.syncChunkMeshes();
      const lit = { block: core.getBlock(spot.x, spot.y, spot.z), tiles: renderer.chunkMeshTiles(cx, cz) };

      core.use();
      core.tick(progressTicks);
      hud.update();
      const bar = (label: string) => {
        const track = document.querySelector(`#furnace-screen [role="progressbar"][aria-label="${label}"]`)!;
        return {
          valueNow: Number(track.getAttribute('aria-valuenow')),
          fillWidth: track.firstElementChild!.getBoundingClientRect().width,
        };
      };
      return { lit, open: core.furnaceScreen.open, fuel: bar(fuelLabel), progress: bar(progressLabel) };
    },
    {
      spot,
      input: { item: ItemType.RawIron, count: 8 },
      fuel: { item: ItemType.Coal, count: 1 },
      chunkSize: CHUNK_SIZE,
      progressTicks: 50,
      fuelLabel: STRINGS.fuelLeft,
      progressLabel: STRINGS.smeltProgress,
    },
  );
  expect(burning.lit.block).toBe(BlockType.LitFurnace);
  expect(burning.lit.tiles).toContain(TILE.litFurnaceFront);
  expect(burning.lit.tiles).not.toContain(TILE.furnaceFront);
  expect(burning.open).toBe(true);
  for (const bar of [burning.fuel, burning.progress]) {
    expect(bar.valueNow).toBeGreaterThan(0);
    expect(bar.fillWidth).toBeGreaterThan(0);
  }
  await expect(page.locator('#furnace-screen')).toBeVisible();

  const out = await page.evaluate(
    ({ spot, chunkSize, coalTicks }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.toggleInventory();
      core.tick();
      core.tick(coalTicks);
      renderer.syncChunkMeshes();
      return {
        open: core.furnaceScreen.open,
        block: core.getBlock(spot.x, spot.y, spot.z),
        tiles: renderer.chunkMeshTiles(Math.floor(spot.x / chunkSize), Math.floor(spot.z / chunkSize)),
        output: core.blockStateAt(spot.x, spot.y, spot.z)!.output,
      };
    },
    { spot, chunkSize: CHUNK_SIZE, coalTicks: 1600 },
  );
  // 关掉界面照样烧：一件煤炭烧完，8 个粗铁全炼成铁锭，方块换回熄火的编号
  expect(out.open).toBe(false);
  expect(out.block).toBe(BlockType.Furnace);
  expect(out.tiles).toContain(TILE.furnaceFront);
  expect(out.tiles).not.toContain(TILE.litFurnaceFront);
  expect(out.output).toEqual({ item: ItemType.IronIngot, count: 8 });
  expect(errors).toEqual([]);
});

test('调试句柄放一块煤矿石在玩家面前：画布上那一块用的是煤矿石那一格，持木镐挖穿后快捷栏出现煤炭的图标与中文名', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  const at = await craftPickaxeIntoHand(page);

  // 整段跑在一次同步的 evaluate 里。玩家站在造镐留下的坑里，眼前那一格摆煤矿石；先读一次送上显卡
  // 的网格用到了哪些贴图格号（那是「画的是哪一格」的直接证据），再持木镐挖穿它、拾起煤炭。
  const seen = await page.evaluate(
    ({ x, eyeY, z, coalOre, coalTicks, pickupTicks, chunkSize }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      const spot = { x, y: eyeY, z: z - 1 };
      const cx = Math.floor(spot.x / chunkSize);
      const cz = Math.floor(spot.z / chunkSize);
      core.turn(-core.player.yaw, -core.player.pitch);
      core.tick();
      renderer.syncChunkMeshes();
      const before = renderer.chunkMeshTiles(cx, cz);

      core.setBlock(spot.x, spot.y, spot.z, coalOre);
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      const placed = { block: core.getBlock(spot.x, spot.y, spot.z), tiles: renderer.chunkMeshTiles(cx, cz) };

      const target = core.mining.target;
      if (!target || target.z !== spot.z) throw new Error('平视时应该对准眼前那块煤矿石');
      core.setMining(true);
      core.tick(coalTicks);
      core.setMining(false);
      core.tick(pickupTicks);
      hud.update();
      return { before, placed, after: core.getBlock(spot.x, spot.y, spot.z), hotbar: core.inventory.hotbar() };
    },
    {
      ...at,
      coalOre: BlockType.CoalOre,
      coalTicks: miningTicks(BlockType.CoalOre, miningToolOf({ item: ItemType.WoodenPickaxe, count: 1 })),
      pickupTicks: PICKUP_DELAY_TICKS + 2,
      chunkSize: CHUNK_SIZE,
    },
  );
  // 摆上之前这个区块的网格里没有煤矿石那一格（天然矿石埋在泥土之下，没有露出的面），摆上之后有
  expect(seen.before).not.toContain(TILE.coalOre);
  expect(seen.placed.block).toBe(BlockType.CoalOre);
  expect(seen.placed.tiles).toContain(TILE.coalOre);
  // 挖穿了：那一格空了，煤炭进第二格，木镐损耗 1 点
  expect(seen.after).toBe(BlockType.Air);
  expect(seen.hotbar[0]).toEqual({ item: ItemType.WoodenPickaxe, count: 1, damage: 1 });
  expect(seen.hotbar[1]).toEqual({ item: ItemType.Coal, count: 1 });

  // 快捷栏第二格画的是煤炭的图标，提示是简体中文名
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="1"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.Coal));
  await expect(slot).toHaveAttribute('title', ITEM_NAMES[ItemType.Coal]);
  const { col, row } = tileCell(ITEM_TILES[ItemType.Coal].side);
  const icon = slot.locator('.hotbar__icon');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
  expect(errors).toEqual([]);
});

test('调试句柄把时刻拨到午夜：背景色比白天暗、天光减量比白天大，月亮在天上、太阳不在；拨回早晨反过来', async ({
  page,
}) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来。朝 −Z 抬头看天：太阳与月亮绕 z 轴转，
  // 始终在东西向的那个竖直面上，画面正中这一块天空因此不会碰上它们，读到的就是背景色。
  const seen = await page.evaluate(
    ({ lookUp }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.turn(-core.player.yaw, lookUp - core.player.pitch);
      const at = (time: number) => {
        core.setTimeOfDay(time);
        renderer.render(1);
        return { time: core.timeOfDay, night: core.isNight, sky: renderer.sky, rgb: centerRgb() };
      };
      return { day: at(6000), night: at(18000), back: at(6000) };
    },
    { lookUp: 0.6 },
  );
  const brightness = ([r, g, b]: readonly number[]) => r! + g! + b!;
  const hexBrightness = (hex: number) => brightness([hex >> 16, (hex >> 8) & 0xff, hex & 0xff]);

  expect(seen.day).toMatchObject({ time: 6000, night: false });
  expect(seen.night).toMatchObject({ time: 18000, night: true });
  // 午夜：背景色比白天暗，送进着色器的天光减量比白天大（白天 0、夜晚 11）；月亮可见、太阳不可见
  expect(hexBrightness(seen.night.sky.background)).toBeLessThan(hexBrightness(seen.day.sky.background));
  expect(seen.night.sky.skyDarkening).toBeGreaterThan(seen.day.sky.skyDarkening);
  expect(seen.day.sky.skyDarkening).toBe(0);
  expect(seen.night.sky.skyDarkening).toBe(11);
  expect(seen.night.sky).toMatchObject({ moonVisible: true, sunVisible: false });
  // 早晨：太阳可见、月亮不可见
  expect(seen.day.sky).toMatchObject({ moonVisible: false, sunVisible: true });
  // 画面上的天空也真的暗下去了：读回来的像素与场景背景色一致地变暗
  expect(brightness(seen.night.rgb)).toBeLessThan(brightness(seen.day.rgb) - 150);
  // 拨回 6000 与一开始的白天完全相同
  expect(seen.back.sky).toEqual(seen.day.sky);
  expect(seen.back.rgb).toEqual(seen.day.rgb);
  expect(errors).toEqual([]);
});

test('场景里没有灯光对象：明暗全由光照材质按光照等级算（ADR-0016）', async ({ page }) => {
  const count = await page.evaluate(() => window.__VOXEL__!.renderer.sceneLightCount);
  expect(count).toBe(0);
  expect(errors).toEqual([]);
});

test('白天用石头把玩家四面与头顶都封起来：正前方那块石头的墙面比封起来之前暗得多', async ({ page }) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来。平视正前方（−Z），眼睛那一层隔一格摆一块石头，
  // 画面正中就是它朝着玩家的那一面。先读一次露天的颜色，再以玩家为中心砌一个 5×5 的石头盒子
  // ——地面、四面墙、屋顶，那块石头正好是前墙的一格——天光进不来，再读一次。
  const seen = await page.evaluate(
    ({ stone, air, eyeHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.setTimeOfDay(6000);
      core.turn(-core.player.yaw, -core.player.pitch);
      const px = Math.floor(core.player.position.x);
      const py = Math.floor(core.player.position.y);
      const pz = Math.floor(core.player.position.z);
      const eyeY = Math.floor(core.player.position.y + eyeHeight);
      // 盒子里面清空：开局那一片可能长着树，挡在视线上的话读到的就不是那块石头
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          core.setBlock(px + dx, py, pz + dz, air);
          core.setBlock(px + dx, py + 1, pz + dz, air);
        }
      }
      core.setBlock(px, eyeY, pz - 2, stone);
      renderer.syncChunkMeshes();
      renderer.render(1);
      const open = centerRgb();

      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          core.setBlock(px + dx, py - 1, pz + dz, stone);
          core.setBlock(px + dx, py + 2, pz + dz, stone);
          if (Math.abs(dx) === 2 || Math.abs(dz) === 2) {
            core.setBlock(px + dx, py, pz + dz, stone);
            core.setBlock(px + dx, py + 1, pz + dz, stone);
          }
        }
      }
      renderer.syncChunkMeshes();
      renderer.render(1);
      return {
        open,
        covered: centerRgb(),
        // 那一面外侧那一格的天光：露天时有光，封起来之后是 0
        insideSkyLight: core.skyLightAt(px, eyeY, pz - 1),
      };
    },
    { stone: BlockType.Stone, air: BlockType.Air, eyeHeight: PLAYER_EYE_HEIGHT },
  );
  const brightness = ([r, g, b]: readonly number[]) => r! + g! + b!;

  expect(seen.insideSkyLight).toBe(0);
  // 露天那一面是看得清的石头灰
  expect(brightness(seen.open)).toBeGreaterThan(3 * 80);
  // 封起来之后明显更暗，但不是纯黑：画面上是露天那时的「等级 0 的亮度」倍（露天那一面接近 15，亮度接近 1）。
  // 曲线是按画面给的，暗处也按这个倍数，不会因为换算到线性空间再被压暗一截。
  const ratio = brightness(seen.covered) / brightness(seen.open);
  expect(ratio).toBeGreaterThan(BRIGHTNESS_FLOOR * 0.8);
  expect(ratio).toBeLessThan(BRIGHTNESS_FLOOR * 1.35);
  expect(errors).toEqual([]);
});

test('午夜在脚边放一座熔炉，放进煤炭与粗铁点火：低头看脚下的地面比点火前亮', async ({ page }) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来。夜里露天的折算天光只有 4，脚下那块地面
  // 的亮度来自熔炉的方块光：熔炉在旁边一格，点着之后脚下那格方块光 12。点火走熔炼状态机——
  // 放进原料与燃料、推进一 tick——不直接写燃烧中的编号。
  const seen = await page.evaluate(
    ({ furnace, rawIron, coal, maxPitch }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.setTimeOfDay(18000);
      core.turn(0, -maxPitch - core.player.pitch);
      const px = Math.floor(core.player.position.x);
      const py = Math.floor(core.player.position.y);
      const pz = Math.floor(core.player.position.z);
      core.setBlock(px + 1, py, pz, furnace);
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      const off = { rgb: centerRgb(), blockLight: core.blockLightAt(px, py, pz) };

      const state = core.blockStateAt(px + 1, py, pz)!;
      state.input = { item: rawIron, count: 1 };
      state.fuel = { item: coal, count: 1 };
      core.tick();
      renderer.syncChunkMeshes();
      renderer.render(1);
      return {
        off,
        lit: { rgb: centerRgb(), blockLight: core.blockLightAt(px, py, pz) },
        block: core.getBlock(px + 1, py, pz),
        below: core.getBlock(px, py - 1, pz),
      };
    },
    { furnace: BlockType.Furnace, rawIron: ItemType.RawIron, coal: ItemType.Coal, maxPitch: MAX_PITCH },
  );
  const brightness = ([r, g, b]: readonly number[]) => r! + g! + b!;

  // 脚下是实心的地面，画面正中读到的就是它的顶面
  expect(seen.below).not.toBe(BlockType.Air);
  expect(seen.block).toBe(BlockType.LitFurnace);
  expect(seen.off.blockLight).toBe(0);
  expect(seen.lit.blockLight).toBe(12);
  // 折算天光 4 对方块光 12：亮度差得很多，不是一两个色阶的抖动
  expect(brightness(seen.lit.rgb)).toBeGreaterThan(brightness(seen.off.rgb) * 1.5);
  expect(errors).toEqual([]);
});

test('调试句柄给 4 支火把：快捷栏画中文名「火把」；午夜对着脚边的地面放下一支，网格用到火把那一格，低头看脚下的地面比放之前亮；手持画平面图标，选框只套细杆', async ({
  page,
}) => {
  await waitForFullViewDistance(page);
  // 整段跑在一次同步的 evaluate 里。玩家东边一格的地面换成石头、上面两格清空，转头对准那块石头的
  // 顶面按使用键：火把落在玩家东边一格、与脚同高。之后低头看脚下，画面正中是脚下那块地面的顶面，
  // 夜里它的亮度来自火把的方块光（隔一格，13）。
  const seen = await page.evaluate(
    ({ torch, stone, air, maxPitch, chunkSize }) => {
      const { core, renderer, hud } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      const left = core.giveItem(torch, 4);
      core.selectHotbarSlot(0);
      core.setTimeOfDay(18000);
      const px = Math.floor(core.player.position.x);
      const py = Math.floor(core.player.position.y);
      const pz = Math.floor(core.player.position.z);
      core.setBlock(px + 1, py - 1, pz, stone);
      core.setBlock(px + 1, py, pz, air);
      core.setBlock(px + 1, py + 1, pz, air);
      const cx = Math.floor((px + 1) / chunkSize);
      const cz = Math.floor(pz / chunkSize);

      const lookDown = () => {
        core.turn(0, -maxPitch - core.player.pitch);
        core.tick();
        renderer.syncChunkMeshes();
        renderer.render(1);
      };
      lookDown();
      const before = { rgb: centerRgb(), blockLight: core.blockLightAt(px, py, pz), tiles: renderer.chunkMeshTiles(cx, cz) };

      // 对准东边那块石头顶面的中心偏下一点
      const eye = core.player.eyePosition;
      const dx = px + 1.5 - eye.x;
      const dy = py - 0.1 - eye.y;
      const dz = pz + 0.5 - eye.z;
      core.turn(Math.atan2(-dx, -dz) - core.player.yaw, Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch);
      core.tick();
      const target = core.mining.target;
      core.use();
      core.tick();
      const placed = core.getBlock(px + 1, py, pz);

      lookDown();
      hud.update();
      const after = { rgb: centerRgb(), blockLight: core.blockLightAt(px, py, pz), tiles: renderer.chunkMeshTiles(cx, cz) };

      // 再对准火把细杆的中段：选框套住的应当是细杆，不是整格
      const sx = px + 1.5 - eye.x;
      const sy = py + 0.3 - eye.y;
      const sz = pz + 0.5 - eye.z;
      core.turn(Math.atan2(-sx, -sz) - core.player.yaw, Math.atan2(sy, Math.hypot(sx, sz)) - core.player.pitch);
      core.tick();
      renderer.render(1);
      return {
        left,
        target,
        expectedTarget: { x: px + 1, y: py - 1, z: pz },
        placed,
        before,
        after,
        torchCell: { x: px + 1, y: py, z: pz },
        selection: renderer.selection,
        held: renderer.heldItem,
        hotbar: core.inventory.hotbar(),
      };
    },
    { torch: ItemType.Torch, stone: BlockType.Stone, air: BlockType.Air, maxPitch: MAX_PITCH, chunkSize: CHUNK_SIZE },
  );
  const brightness = ([r, g, b]: readonly number[]) => r! + g! + b!;

  expect(seen.left).toBe(0);
  expect(seen.target).toMatchObject({ ...seen.expectedTarget, normal: { x: 0, y: 1, z: 0 } });
  expect(seen.placed).toBe(BlockType.Torch);
  expect(seen.hotbar[0]).toEqual({ item: ItemType.Torch, count: 3 });
  // 网格用到火把那一格，不再用 #56 的临时贴图（#57 起那一格不用）
  const STAND_IN_TORCH_TILE = 43;
  expect(seen.before.tiles).not.toContain(TILE.torch);
  expect(seen.after.tiles).toContain(TILE.torch);
  expect(seen.after.tiles).not.toContain(STAND_IN_TORCH_TILE);
  // 脚下那格方块光从 0 变成 13，画面正中的地面明显变亮
  expect(seen.before.blockLight).toBe(0);
  expect(seen.after.blockLight).toBe(13);
  expect(brightness(seen.after.rgb)).toBeGreaterThan(brightness(seen.before.rgb) * 1.5);

  // 手持火把画平面图标，在画面右下
  expect(seen.held?.item).toBe(ItemType.Torch);
  expect(seen.held?.shape).toBe(HeldItemShape.Flat);
  expect(seen.held!.screen.x).toBeGreaterThan(0);
  expect(seen.held!.screen.y).toBeLessThan(0);

  // 选框对着火把：套住的是截面 2/16、高 10/16 的细杆
  const { torchCell } = seen;
  expect(seen.selection.target).toEqual(torchCell);
  const bounds = seen.selection.bounds!;
  expect(bounds.min.x).toBeCloseTo(torchCell.x + 7 / 16);
  expect(bounds.max.x).toBeCloseTo(torchCell.x + 9 / 16);
  expect(bounds.min.y).toBeCloseTo(torchCell.y);
  expect(bounds.max.y).toBeCloseTo(torchCell.y + 10 / 16);
  expect(bounds.min.z).toBeCloseTo(torchCell.z + 7 / 16);
  expect(bounds.max.z).toBeCloseTo(torchCell.z + 9 / 16);

  // 快捷栏第一格：火把的图标与简体中文名
  const slot = page.locator('#hotbar .hotbar__slot[data-slot="0"]');
  await expect(slot).toHaveAttribute('data-item', String(ItemType.Torch));
  await expect(slot).toHaveAttribute('title', ITEM_NAMES[ItemType.Torch]);
  expect(ITEM_NAMES[ItemType.Torch]).toBe('火把');
  await expect(slot.locator('.hotbar__count')).toHaveText('3');
  const { col, row } = tileCell(ITEM_TILES[ItemType.Torch].side);
  const icon = slot.locator('.hotbar__icon');
  await expect(icon).toHaveCSS('--tile-col', String(col));
  await expect(icon).toHaveCSS('--tile-row', String(row));
  expect(errors).toEqual([]);
});

test('午夜低头看露天的地面：画面不是一片黑，仍数得出许多种颜色', async ({ page }) => {
  // 夜晚露天的折算天光是 4：比白天暗，但方块的轮廓与贴图的纹理都还在。
  const center = await page.evaluate(
    ({ lookDown }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.setTimeOfDay(18000);
      core.turn(0, lookDown - core.player.pitch);
      renderer.render(1);
      return window.__CENTER_RGB__!();
    },
    { lookDown: -0.7 },
  );
  expect(center[0] + center[1] + center[2]).toBeGreaterThan(3 * 15);
  expect(await countCanvasColors(page)).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('正午抬头看得见太阳；头顶放一块石头之后，画面正中是石头而不是太阳', async ({ page }) => {
  // 太阳先画、不参与深度（renderer.ts 的 celestialQuad）：地形必须盖在它上面。画的顺序一旦
  // 弄反，太阳就会画在头顶那块石头之上。
  const seen = await page.evaluate(
    ({ stone, eyeHeight, maxPitch }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.turn(0, maxPitch - core.player.pitch);
      core.setTimeOfDay(6000);
      renderer.render(1);
      const open = centerRgb();
      const { x, y, z } = core.player.position;
      core.setBlock(Math.floor(x), Math.floor(y + eyeHeight) + 3, Math.floor(z), stone);
      renderer.syncChunkMeshes();
      renderer.render(1);
      return { open, covered: centerRgb(), sunVisible: renderer.sky.sunVisible };
    },
    { stone: BlockType.Stone, eyeHeight: PLAYER_EYE_HEIGHT, maxPitch: MAX_PITCH },
  );
  expect(seen.sunVisible).toBe(true);
  // 太阳是暖黄：红绿都高、蓝明显比红低（天空的蓝正相反，蓝比红高）
  const [r, g, b] = seen.open;
  expect(r).toBeGreaterThan(200);
  expect(g).toBeGreaterThan(150);
  expect(r - b).toBeGreaterThan(40);
  // 盖上石头之后是石头的灰：三个分量相近，不再是太阳的黄
  const [sr, sg, sb] = seen.covered;
  expect(Math.max(sr, sg, sb) - Math.min(sr, sg, sb)).toBeLessThan(30);
  expect(errors).toEqual([]);
});

test('调试句柄在玩家前方 3 格生成一只僵尸：下一帧场景里有一个六部件的组，画面正中是它；推进 20 tick 后它走近了相机', async ({
  page,
}) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来。平视前方，僵尸生成在视线正前方 3 格那一列的
  // 顶面上：相机在眼睛的高度，视线正好落在它的头上。
  const seen = await page.evaluate(
    ({ distance }) => {
      const { core, renderer } = window.__VOXEL__!;
      const centerRgb = window.__CENTER_RGB__!;
      core.turn(0, -core.player.pitch);
      renderer.render(1);
      const before = centerRgb();

      const { position, yaw } = core.player;
      const x = position.x - Math.sin(yaw) * distance;
      const z = position.z - Math.cos(yaw) * distance;
      core.spawnZombieAt(x, core.highestBlockY(Math.floor(x), Math.floor(z)) + 1, z);
      renderer.render(1);
      const spawned = { zombies: renderer.zombies, camera: renderer.cameraPosition, rgb: centerRgb() };

      core.tick(10);
      renderer.render(0.5);
      const walking = renderer.zombies;
      core.tick(10);
      renderer.render(1);
      return {
        before,
        spawned,
        walking,
        later: { zombies: renderer.zombies, camera: renderer.cameraPosition },
        count: core.zombies.count,
      };
    },
    { distance: 3 },
  );
  const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

  // 一只僵尸，一个组，六个部件：头、身体、两条手臂、两条腿
  expect(seen.spawned.zombies).toHaveLength(1);
  expect(seen.spawned.zombies[0]).toMatchObject({ id: 1, parts: 6, armSwing: 0 });
  expect(horizontal(seen.spawned.zombies[0]!.position, seen.spawned.camera)).toBeCloseTo(3, 6);
  // 真画进了画布：画面正中换成了僵尸头上那一片灰绿，绿色分量压过红与蓝
  const [r, g, b] = seen.spawned.rgb;
  expect(seen.spawned.rgb).not.toEqual(seen.before);
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);

  // 走动时臂在摆；推进 20 tick 之后还是同一只，离相机更近了。20 tick 是 1 秒，走近 ZOMBIE_SPEED 格，
  // 只要求走近一半：要求正好走近那么多的话，比较结果取决于浮点误差
  expect(seen.walking[0]!.armSwing).not.toBe(0);
  expect(seen.count).toBe(1);
  expect(seen.later.zombies[0]!.id).toBe(1);
  expect(horizontal(seen.later.zombies[0]!.position, seen.later.camera)).toBeLessThan(
    horizontal(seen.spawned.zombies[0]!.position, seen.spawned.camera) - ZOMBIE_SPEED / 2,
  );
  expect(errors).toEqual([]);
});

test('拨到夜晚推进到僵尸自然生成：场景里多了一个六部件的组，离相机 24 到 48 格；拨回白天，玩家脚下那一只露天烧 400 tick，组消失', async ({
  page,
}) => {
  // 生成要候选列所在区块已加载，先等视距铺满。整段跑在一次同步的 evaluate 里，中途游戏循环不会推进。
  //
  // 燃烧那一半不用自然生成的那一只：它在真实地形上走动，会从树冠上摔下来受伤，也会走到树冠底下不烧，
  // 或者走远了消失，死亡的 tick 因此不固定。改在玩家脚下生成一只：出生点周围没有树，它与玩家水平位置
  // 重合，一步不走，一直在露天。先推进到 tick 计数能被燃烧间隔整除，第 400 tick 正好是第 20 次燃烧。
  await waitForFullViewDistance(page);
  const seen = await page.evaluate(
    ({ night, day, limit, interval, burnTicks }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.setTimeOfDay(night);
      let nightTicks = 0;
      for (; nightTicks < limit && core.zombies.count === 0; nightTicks++) core.tick();
      renderer.render(1);
      const spawned = { zombies: renderer.zombies, camera: renderer.cameraPosition };

      core.setTimeOfDay(day);
      while (core.tickCount % interval !== 0) core.tick();
      const { x, y, z } = core.player.position;
      core.spawnZombieAt(x, y, z);
      const id = core.zombies.all().at(-1)!.id;
      const ours = () => core.zombies.all().find((zombie) => zombie.id === id);
      core.tick(burnTicks - 1);
      renderer.render(1);
      const almost = {
        zombie: ours() && { health: ours()!.health, burning: ours()!.burning },
        group: renderer.zombies.some((zombie) => zombie.id === id),
      };
      core.tick();
      renderer.render(1);
      const burned = {
        zombie: ours(),
        group: renderer.zombies.some((zombie) => zombie.id === id),
        orbs: core.xpOrbs.count,
        experience: core.experience.total,
      };
      return { nightTicks, spawned, almost, burned };
    },
    {
      night: NIGHT_START,
      day: 0,
      limit: 2000,
      interval: ZOMBIE_BURN_INTERVAL,
      burnTicks: (ZOMBIE_MAX_HEALTH / ZOMBIE_BURN_DAMAGE) * ZOMBIE_BURN_INTERVAL,
    },
  );
  const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

  // 夜里生成了一只：场景里一个组、六个部件，离相机（玩家）的水平距离在生成的范围里
  expect(seen.nightTicks).toBeLessThan(2000);
  expect(seen.spawned.zombies).toHaveLength(1);
  expect(seen.spawned.zombies[0]!.parts).toBe(6);
  const away = horizontal(seen.spawned.zombies[0]!.position, seen.spawned.camera);
  expect(away).toBeGreaterThanOrEqual(ZOMBIE_SPAWN_MIN_DISTANCE);
  expect(away).toBeLessThanOrEqual(ZOMBIE_SPAWN_MAX_DISTANCE);

  // 白天第 399 tick：还在燃烧，剩 1 点血，组还在场景里
  expect(seen.almost).toEqual({ zombie: { health: 1, burning: true }, group: true });
  // 第 400 tick 烧死：核心里没有了，场景里的组也移走了，没有给经验
  expect(seen.burned).toEqual({ zombie: undefined, group: false, orbs: 0, experience: 0 });
  expect(errors).toEqual([]);
});

test('对准 2 格外的僵尸按左键：组的材质带红色叠色，10 tick 后恢复；手持物品挥了一下', async ({
  page,
}) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来。平视前方，僵尸生成在视线正前方 2 格那一列的顶面上，
  // 手上拿一把木镐：空手没有东西可挥。
  //
  // 先拨到夜晚：白天露天的僵尸在燃烧（#44），材质叠的是橙色。夜里可能另有僵尸自然生成，所以按编号找到
  // 生成的这一只。
  const seen = await page.evaluate(
    ({ distance, pickaxe, tintTicks, night }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.setTimeOfDay(night);
      core.turn(0, -core.player.pitch);
      core.giveItem(pickaxe, 1);
      core.selectHotbarSlot(0);
      const { position, yaw } = core.player;
      const x = position.x - Math.sin(yaw) * distance;
      const z = position.z - Math.cos(yaw) * distance;
      core.spawnZombieAt(x, core.highestBlockY(Math.floor(x), Math.floor(z)) + 1, z);
      const id = core.zombies.all().at(-1)!.id;
      const ours = () => renderer.zombies.find((zombie) => zombie.id === id);
      core.tick();
      renderer.render(1);
      const before = { zombie: ours(), held: renderer.heldItem };

      core.setMining(true);
      core.tick();
      core.setMining(false);
      renderer.render(0.5);
      const hit = {
        zombie: ours(),
        health: core.zombies.all().find((zombie) => zombie.id === id)?.health,
        held: renderer.heldItem,
      };

      core.tick(tintTicks);
      renderer.render(1);
      return { id, before, hit, after: { zombie: ours(), held: renderer.heldItem } };
    },
    { distance: 2, pickaxe: ItemType.WoodenPickaxe, tintTicks: ZOMBIE_HURT_TINT_TICKS, night: NIGHT_START },
  );
  const rgb = (hex: number) => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff] as const;

  // 打之前是贴图本色（乘白色），手持物品在原位
  expect(seen.before.zombie!.tint).toBe(0xffffff);
  expect(seen.before.held!.swing).toBe(0);

  // 打中了：掉 2 点血（木镐），材质的颜色红分量满、绿蓝压低；手持物品正在挥
  expect(seen.hit.health).toBe(18);
  const [r, g, b] = rgb(seen.hit.zombie!.tint);
  expect(r).toBe(0xff);
  expect(g).toBeLessThan(0xc0);
  expect(b).toBeLessThan(0xc0);
  expect(seen.hit.held!.swing).toBeGreaterThan(0);

  // 10 tick 后恢复本色，手持物品回到原位
  expect(seen.after.zombie!.id).toBe(seen.id);
  expect(seen.after.zombie!.tint).toBe(0xffffff);
  expect(seen.after.held!.swing).toBe(0);
  expect(errors).toEqual([]);
});

test('调试句柄把僵尸生成在玩家身旁：下一 tick 少一颗半心、红色遮罩可见；推进到生命归零，死亡画面可见；点重生后心满', async ({
  page,
}) => {
  // 整段跑在一次同步的 evaluate 里，游戏循环插不进来：被打的那一 tick 是精确的。
  const seen = await page.evaluate(() => {
    const { core, hud } = window.__VOXEL__!;
    const shown = (selector: string): boolean => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement && getComputedStyle(element).display !== 'none';
    };
    const hearts = () =>
      [...document.querySelectorAll<HTMLElement>('#health-bar .health__heart')].map(
        (heart) => heart.dataset.state,
      );

    // 玩家 +X 方向 1 格那一列的顶面上
    const { position } = core.player;
    const x = position.x + 1;
    core.spawnZombieAt(x, core.highestBlockY(Math.floor(x), Math.floor(position.z)) + 1, position.z);
    core.tick();
    hud.update();
    const hit = { points: core.health.points, hearts: hearts(), flash: shown('#hurt-flash') };

    let ticks = 1;
    for (; ticks < 600 && !core.health.dead; ticks++) core.tick();
    hud.update();
    return { hit, died: { dead: core.health.dead, ticks }, deathScreen: shown('#death-screen') };
  });

  // 僵尸打一下 3 点：20 → 17，8 颗整心、1 颗半心、1 颗空心，红闪铺着
  expect(seen.hit).toEqual({
    points: 17,
    hearts: [...Array(8).fill('full'), 'half', 'empty'],
    flash: true,
  });
  // 每 20 tick 打一下，7 下打死
  expect(seen.died.dead).toBe(true);
  expect(seen.died.ticks).toBeGreaterThanOrEqual(6 * 20 + 1);
  expect(seen.deathScreen).toBe(true);
  await expect(page.locator('#death-screen')).toBeVisible();

  // 僵尸还在出生点旁边，点击与下一次 evaluate 之间游戏循环推进一个 tick 它就可能又打一下。所以在
  // 按钮上挂一个一次性监听，排在界面层的重生处理器之后，在同一个事件任务里读状态
  const respawn = page.getByRole('button', { name: STRINGS.respawn });
  await respawn.evaluate((button) => {
    button.addEventListener(
      'click',
      () => {
        const { core, hud } = window.__VOXEL__!;
        hud.update();
        document.body.dataset.respawned = JSON.stringify({
          dead: core.health.dead,
          points: core.health.points,
          hearts: [...document.querySelectorAll<HTMLElement>('#health-bar .health__heart')].map(
            (heart) => heart.dataset.state,
          ),
        });
      },
      { once: true },
    );
  });
  await respawn.click();
  const after: unknown = JSON.parse(
    await page.evaluate(() => document.body.dataset.respawned ?? 'null'),
  );
  expect(after).toEqual({
    dead: false,
    points: MAX_HEALTH,
    hearts: Array(MAX_HEALTH / 2).fill('full'),
  });
  await expect(page.locator('#death-screen')).toBeHidden();
  expect(errors).toEqual([]);
});

/**
 * 整条战斗流程从这个 tick 计数开始。生成的候选列、游走的方向、腐肉的件数都由 tick 哈希出来（ADR-0014），
 * 起点固定，打僵尸那一段每次跑出同样的结果；之后两次 evaluate 之间游戏循环可能推进几个 tick，不再逐 tick
 * 相同。页面打开、等视距铺满的那段时间里游戏循环已经推进了几百 tick，这个值要比那更晚，还要落在白天。
 */
const COMBAT_CHAIN_START_TICK = 2000;

/** 整条战斗流程每一段最多推进这么多 tick：等第一只生成、打死一只、走开再被打死、跑回去拾取，各自够用。 */
const COMBAT_CHAIN_PHASE_TICKS = 3000;

/** 僵尸水平中心距小于这个值才按左键：碰撞箱半宽 0.3，眼睛到它表面的斜距约 2.6 格，在攻击距离之内。 */
const STRIKE_WITHIN = ATTACK_RANGE - 0.2;

/**
 * 最近那只的水平中心距小于这个值就面朝它往后退。玩家比僵尸快，退着打能让它留在攻击距离边上：站着不动的话
 * 几只会走到玩家身上与他重叠，眼睛落进它们的碰撞箱里，左键打不中，它们却一直在打他。
 */
const RETREAT_WITHIN = 2.2;

/**
 * 打死一只之后走到离出生点这么远（水平）、又在露天的地方，站着不动，等僵尸把他打死。离出生点要超过经验球的
 * 吸引范围，重生之后经验球不会自己飞过来，得跑回死亡处；露天是为了让聚在死亡处的僵尸天亮后都在烧。
 */
const DEATH_SITE_DISTANCE = 16;

/**
 * 天亮后在死亡画面上等僵尸烧死最多等这么多 tick。满血烧死至多 400 tick，走过来的路上钻进树冠底下的那几 tick
 * 不烧，所以留一倍的余量。
 */
const BURN_WAIT_TICKS = 2 * (ZOMBIE_MAX_HEALTH / ZOMBIE_BURN_DAMAGE) * ZOMBIE_BURN_INTERVAL;

test('整条战斗流程：夜里等到僵尸，铁剑打死一只拾到腐肉、经验涨；被僵尸打死，死亡画面上天亮，露天的僵尸烧死；重生回出生点，跑回死亡处拾回掉落物', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // 生成要候选列所在区块已加载，先等视距铺满。每一段都整段跑在一次同步的 evaluate 里，中途游戏循环不会推进。
  await waitForFullViewDistance(page);

  // 第一段：白天开局，拨到夜晚，等第一只自然生成。拿一把铁剑，每 tick 转向最近的那只，离得太近就往后退，
  // 进了攻击距离就按一下左键。打死一只不一定掉腐肉（0 到 2 件），没掉就接着打下一只，掉了就走过去拾起来，
  // 经验球自己飞过来
  const fight = await page.evaluate(
    ({ startTick, night, limit, sword, flesh, strikeWithin, retreatWithin, cooldown, bodyHeight, xpPerKill }) => {
      const core = window.__VOXEL__!.core;
      const idle = { forward: false, back: false, left: false, right: false, jump: false };
      const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
      /** 把视线转向 (x, y, z)。 */
      const aimAt = (x: number, y: number, z: number) => {
        const eye = core.player.eyePosition;
        const [dx, dy, dz] = [x - eye.x, y - eye.y, z - eye.z];
        const yaw = Math.atan2(-dx, -dz) - core.player.yaw;
        const pitch = Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch;
        core.turn(Math.atan2(Math.sin(yaw), Math.cos(yaw)), pitch);
      };
      const carried = (item: number) => {
        let count = 0;
        for (let i = 0; i < core.inventory.size; i++) {
          const stack = core.inventory.slot(i);
          if (stack?.item === item) count += stack.count;
        }
        return count;
      };

      while (core.tickCount < startTick) core.tick();
      const dayAtStart = !core.isNight;
      core.setTimeOfDay(night);
      let waited = 0;
      for (; waited < limit && core.zombies.count === 0; waited++) core.tick();
      const first = core.zombies.all()[0];
      const firstDistance = first && horizontal(first.position, core.player.position);

      core.giveItem(sword, 1);
      core.selectHotbarSlot(0);
      core.tick();
      let lastPress = -Infinity;
      let fought = 0;
      for (; fought < limit && !core.health.dead; fought++) {
        if (carried(flesh) > 0 && core.experience.total >= xpPerKill) break;
        const me = core.player.position;
        const drop = core.drops.all().find((candidate) => candidate.item === flesh);
        if (drop) {
          aimAt(drop.position.x, core.player.eyePosition.y, drop.position.z);
          core.setMoveIntent({ ...idle, forward: true, jump: true });
          core.tick();
          continue;
        }
        const nearest = [...core.zombies.all()]
          .filter((zombie) => zombie.health > 0)
          .sort((a, b) => horizontal(a.position, me) - horizontal(b.position, me))[0];
        const away = nearest ? horizontal(nearest.position, me) : Infinity;
        core.setMoveIntent(away < retreatWithin ? { ...idle, back: true, jump: true } : idle);
        if (nearest) {
          aimAt(nearest.position.x, nearest.position.y + bodyHeight / 2, nearest.position.z);
          if (away < strikeWithin && core.tickCount - lastPress >= cooldown) {
            core.setMining(true);
            core.tick();
            core.setMining(false);
            lastPress = core.tickCount;
            continue;
          }
        }
        core.tick();
      }
      core.setMoveIntent(idle);
      return {
        dayAtStart,
        waited,
        firstDistance,
        fought,
        dead: core.health.dead,
        experience: core.experience.total,
        flesh: carried(flesh),
        sword: core.inventory.slot(0),
      };
    },
    {
      startTick: COMBAT_CHAIN_START_TICK,
      night: NIGHT_START,
      limit: COMBAT_CHAIN_PHASE_TICKS,
      sword: ItemType.IronSword,
      flesh: ItemType.RottenFlesh,
      strikeWithin: STRIKE_WITHIN,
      retreatWithin: RETREAT_WITHIN,
      cooldown: ATTACK_COOLDOWN_TICKS,
      bodyHeight: ZOMBIE_HEIGHT,
      xpPerKill: ZOMBIE_XP,
    },
  );
  expect(fight.dayAtStart).toBe(true);
  // 夜里生成了一只，离玩家 24 到 48 格
  expect(fight.waited).toBeLessThan(COMBAT_CHAIN_PHASE_TICKS);
  expect(fight.firstDistance).toBeGreaterThanOrEqual(ZOMBIE_SPAWN_MIN_DISTANCE);
  expect(fight.firstDistance).toBeLessThanOrEqual(ZOMBIE_SPAWN_MAX_DISTANCE);
  // 打死了至少一只：经验只来自击杀，每只 50 点；拾到了腐肉；铁剑还在手上，出手损耗了耐久
  expect(fight.fought).toBeLessThan(COMBAT_CHAIN_PHASE_TICKS);
  expect(fight.dead).toBe(false);
  expect(fight.experience).toBeGreaterThan(0);
  expect(fight.experience % ZOMBIE_XP).toBe(0);
  expect(fight.flesh).toBeGreaterThan(0);
  expect(fight.sword).toMatchObject({ item: ItemType.IronSword, count: 1 });
  expect(fight.sword!.damage).toBeGreaterThan(0);

  // 第二段：朝 −Z 走，走到离出生点 16 格以外的露天处站住，等僵尸把玩家打死。每 tick 记下身上带着什么，以及
  // 已有哪些掉落物与经验球：死亡那一 tick 背包清空，新出现的那些就是从他身上掉出来的
  const death = await page.evaluate(
    ({ away, limit, step }) => {
      const core = window.__VOXEL__!.core;
      const idle = { forward: false, back: false, left: false, right: false, jump: false };
      const spawn = core.spawnPoint;
      const fromSpawn = () => Math.hypot(core.player.position.x - spawn.x, core.player.position.z - spawn.z);
      const openSky = ({ x, y, z }: Vec3) => core.highestBlockY(Math.floor(x), Math.floor(z)) < y;
      const stacks = () =>
        Array.from({ length: core.inventory.size }, (_, i) => core.inventory.slot(i)).filter(
          (stack) => stack !== undefined,
        );

      // 视角转回朝 −Z。往前走不动就侧身让一步，侧身也走不动就换另一边，与 `walkTicks` 相同。走的路上也可能
      // 被打死，所以从第一步起就记
      core.turn(-core.player.yaw, 0);
      let sidestep: 'none' | 'right' | 'left' = 'none';
      let previous = core.player.position;
      let arrived = false;
      let before = { carried: stacks(), experience: core.experience.total };
      let dropIds = new Set<number>();
      let orbIds = new Set<number>();
      for (let ticks = 0; ticks < limit && !core.health.dead; ticks++) {
        before = { carried: stacks(), experience: core.experience.total };
        dropIds = new Set(core.drops.all().map((drop) => drop.id));
        orbIds = new Set(core.xpOrbs.all().map((orb) => orb.id));
        arrived ||= fromSpawn() >= away && openSky(core.player.position);
        core.setMoveIntent(
          arrived
            ? idle
            : { forward: true, back: false, left: sidestep === 'left', right: sidestep === 'right', jump: true },
        );
        core.tick();
        const now = core.player.position;
        if (now.z < previous.z) sidestep = 'none';
        else if (sidestep === 'none') sidestep = 'right';
        else if (Math.abs(now.x - previous.x) < step / 2) sidestep = sidestep === 'right' ? 'left' : 'right';
        previous = now;
      }
      core.setMoveIntent(idle);
      const site = core.player.position;
      const fromSite = (at: Vec3) => Math.hypot(at.x - site.x, at.z - site.z);
      return {
        dead: core.health.dead,
        distance: fromSpawn(),
        openSky: openSky(site),
        before,
        carriedAfter: stacks(),
        experienceAfter: core.experience.total,
        drops: core.drops
          .all()
          .filter((drop) => !dropIds.has(drop.id))
          .map((drop) => ({ id: drop.id, item: drop.item, count: drop.count, fromSite: fromSite(drop.position) })),
        orbs: core.xpOrbs
          .all()
          .filter((orb) => !orbIds.has(orb.id))
          .map((orb) => ({ id: orb.id, amount: orb.amount, fromSite: fromSite(orb.position) })),
      };
    },
    { away: DEATH_SITE_DISTANCE, limit: COMBAT_CHAIN_PHASE_TICKS, step: WALK_STEP },
  );
  expect(death.dead).toBe(true);
  // 死在离出生点经验球吸引范围以外的露天处
  expect(death.distance).toBeGreaterThan(XP_ATTRACT_RANGE);
  expect(death.openSky).toBe(true);
  // 身上的东西全部留在死亡处：每一堆一个掉落物，累计经验装进一个经验球，都在他倒下的那一格；背包空了、经验归零
  expect(death.carriedAfter).toEqual([]);
  expect(death.experienceAfter).toBe(0);
  const byItem = (a: { item: number }, b: { item: number }) => a.item - b.item;
  expect(death.drops.map(({ item, count }) => ({ item, count })).sort(byItem)).toEqual(
    death.before.carried.map(({ item, count }) => ({ item, count })).sort(byItem),
  );
  expect(death.orbs.map((orb) => orb.amount)).toEqual([death.before.experience]);
  for (const spawned of [...death.drops, ...death.orbs]) expect(spawned.fromSite).toBeLessThan(1);

  // 第三段：死亡画面显示着，拨回白天。世界照常推进，僵尸照样朝死亡处走，只是打不到死了的玩家；聚在死亡处的
  // 那些都在露天，一直烧到死
  await expect(page.locator('#death-screen')).toBeVisible();
  const day = await page.evaluate(
    ({ limit, reach, burnDamage }) => {
      const core = window.__VOXEL__!.core;
      const site = core.player.position;
      const orbsAtDawn = core.xpOrbs.all().map((orb) => orb.id);
      core.setTimeOfDay(0);
      const last = new Map<number, { health: number; burning: boolean }>();
      const atSite = new Set<number>();
      let ticks = 0;
      for (; ticks < limit && core.zombies.count > 0; ticks++) {
        core.tick();
        for (const zombie of core.zombies.all()) {
          last.set(zombie.id, { health: zombie.health, burning: zombie.burning });
          const { x, z } = zombie.position;
          if (Math.hypot(x - site.x, z - site.z) <= reach) atSite.add(zombie.id);
        }
      }
      const alive = new Set(core.zombies.all().map((zombie) => zombie.id));
      const burned = [...atSite].filter((id) => {
        const seen = last.get(id)!;
        return !alive.has(id) && seen.burning && seen.health <= burnDamage;
      });
      return {
        dead: core.health.dead,
        points: core.health.points,
        atSite: atSite.size,
        burned: burned.length,
        orbsAtDawn,
        orbsAfter: core.xpOrbs.all().map((orb) => orb.id),
        experience: core.experience.total,
      };
    },
    { limit: BURN_WAIT_TICKS, reach: ZOMBIE_ATTACK_RANGE, burnDamage: ZOMBIE_BURN_DAMAGE },
  );
  // 死了的玩家不受伤，也没有重生
  expect(day.dead).toBe(true);
  expect(day.points).toBe(0);
  // 走到死亡处的僵尸全部烧死；烧死的不给经验：没有新的经验球，死亡处那一个也没被吸收
  expect(day.atSite).toBeGreaterThan(0);
  expect(day.burned).toBe(day.atSite);
  expect(day.orbsAfter).toEqual(day.orbsAtDawn);
  expect(day.experience).toBe(0);
  await expect(page.locator('#death-screen')).toBeVisible();

  // 点重生按钮：回到出生点、满血、背包是空的
  await page.getByRole('button', { name: STRINGS.respawn }).click();
  await expect(page.locator('#death-screen')).toBeHidden();
  const respawned = await page.evaluate(() => {
    const core = window.__VOXEL__!.core;
    return {
      atSpawn: JSON.stringify(core.player.position) === JSON.stringify(core.spawnPoint),
      points: core.health.points,
      dead: core.health.dead,
      empty: Array.from({ length: core.inventory.size }, (_, i) => core.inventory.slot(i)).every(
        (stack) => stack === undefined,
      ),
    };
  });
  expect(respawned).toEqual({ atSpawn: true, points: MAX_HEALTH, dead: false, empty: true });

  // 第四段：跑回死亡处，把掉在那里的东西一件件拾回来。经验球进了吸引范围就自己飞过来
  const returned = await page.evaluate(
    ({ dropIds, orbIds, limit, step, flesh }) => {
      const core = window.__VOXEL__!.core;
      const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
      const waiting = () => core.drops.all().filter((drop) => dropIds.includes(drop.id));
      const floating = () => core.xpOrbs.all().filter((orb) => orbIds.includes(orb.id));

      // 朝最近的那一件走；离它没有更近就侧身让一步，侧身也走不动就换另一边
      let sidestep: 'none' | 'right' | 'left' = 'none';
      let previous = core.player.position;
      let ticks = 0;
      for (; ticks < limit && (waiting().length > 0 || floating().length > 0); ticks++) {
        const me = core.player.position;
        const target = [...waiting(), ...floating()].sort(
          (a, b) => horizontal(a.position, me) - horizontal(b.position, me),
        )[0]!;
        const yaw = Math.atan2(-(target.position.x - me.x), -(target.position.z - me.z)) - core.player.yaw;
        core.turn(Math.atan2(Math.sin(yaw), Math.cos(yaw)), 0);
        core.setMoveIntent({
          forward: true,
          back: false,
          left: sidestep === 'left',
          right: sidestep === 'right',
          jump: true,
        });
        const distance = horizontal(target.position, me);
        core.tick();
        const now = core.player.position;
        if (horizontal(target.position, now) < distance - step / 2) sidestep = 'none';
        else if (sidestep === 'none') sidestep = 'right';
        else if (horizontal(now, previous) < step / 2) sidestep = sidestep === 'right' ? 'left' : 'right';
        previous = now;
      }
      core.setMoveIntent({ forward: false, back: false, left: false, right: false, jump: false });
      const stacks = Array.from({ length: core.inventory.size }, (_, i) => core.inventory.slot(i));
      return {
        ticks,
        dead: core.health.dead,
        experience: core.experience.total,
        exceptFlesh: stacks.filter((stack) => stack !== undefined && stack.item !== flesh),
        flesh: stacks.reduce((sum, stack) => sum + (stack?.item === flesh ? stack.count : 0), 0),
      };
    },
    {
      dropIds: death.drops.map((drop) => drop.id),
      orbIds: death.orbs.map((orb) => orb.id),
      limit: COMBAT_CHAIN_PHASE_TICKS,
      step: WALK_STEP,
      flesh: ItemType.RottenFlesh,
    },
  );
  // 死亡处的掉落物与经验球都收回来了：铁剑带着死前的耐久损耗，腐肉一件不少（路上还可能拾到烧死的那些
  // 掉的），经验回到死前的累计值
  expect(returned.ticks).toBeLessThan(COMBAT_CHAIN_PHASE_TICKS);
  expect(returned.dead).toBe(false);
  expect(returned.exceptFlesh).toEqual(
    death.before.carried.filter((stack) => stack.item !== ItemType.RottenFlesh),
  );
  const fleshBefore = death.before.carried
    .filter((stack) => stack.item === ItemType.RottenFlesh)
    .reduce((sum, stack) => sum + stack.count, 0);
  expect(returned.flesh).toBeGreaterThanOrEqual(fleshBefore);
  expect(returned.experience).toBe(death.before.experience);
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
