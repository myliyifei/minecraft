import { expect, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { DEFAULT_SEED, TICK_RATE, WORLD_MIN_Y } from '../src/core/constants';
import { PICKUP_DELAY_TICKS } from '../src/core/drop';
import type { GameCore } from '../src/core/game';
import { ItemType } from '../src/core/item';
import { pondsTouching } from '../src/core/pond';
import { createTerrain } from '../src/core/terrain';
import { treesTouching } from '../src/core/tree';
import type { Vec3 } from '../src/core/vec3';
import { chunkOf } from '../src/core/world';
import { NON_SOLID_BLOCKS } from './world-list';

/*
 * 第七切片全流程（#82）在世界里做的各步。dev.full-flow.spec.ts 经调试句柄把 `seventhSliceSteps` 的源码送进页面，
 * 在页面里的核心上跑；prod.full-flow.spec.ts 在 Node 里用同一份核心跑完再导入。两边做的是同一件事。
 *
 * `seventhSliceSteps` 只用参数：方块与物品编号、坐标都经 `SEVENTH_SLICE_ARGS` 传进来。它的源码要能单独在页面里求值，
 * 函数体里不能引用本模块的任何导入。
 *
 * 地点都在默认种子的出生列（原点）附近，开头由 Node 里同一份地形对象核对（`checkSeventhSliceTerrain`）：
 * #81 交接的水塘 (7..13, 6..12) 水面 y 67，#79 交接的原点区块第一棵树是白桦，水塘东边一株虞美人。
 */

const TERRAIN = createTerrain(DEFAULT_SEED);

/** 水塘的中心列与它西边一列：两列塘底都是这个水塘最深的 y。玩家游到中心列，在西边那列塘底上放一块圆石。 */
const POND_CENTER = { x: 10, z: 9 } as const;
const POND_WEST = { x: 9, z: 9 } as const;
/** 爬岸后站的列（水塘东岸）与它西边那格水面：在那里放冰、挖冰。 */
const EAST_BANK = { x: 15, z: 9 } as const;
const ICE_COLUMN = { x: 13, z: 9 } as const;
/** 出生点 7 格外的一株花，挖它时站的列，以及种回去的那一列。 */
const FLOWER = { x: 18, z: 5 } as const;
const FLOWER_STAND = { x: 17, z: 5 } as const;
const REPLANT = { x: 18, z: 4 } as const;
/** 原点区块的第一棵树（白桦）的树干列，砍它时站的列（树冠之外）。 */
const BIRCH = { x: 0, z: 12 } as const;
const BIRCH_STAND = { x: 0, z: 9 } as const;
/** 从花那里走到白桦去的路点：沿 z = 4 往西，绕开水塘。 */
const DETOUR = [
  { x: 14, z: 4 },
  { x: 2, z: 4 },
] as const;
/** 搭台阶的起点：出生列往 +Z 三格，台阶朝 −Z 搭。 */
const STEP_START = { x: 0, z: 3 } as const;

export interface SeventhSliceArgs {
  readonly blocks: {
    readonly air: BlockType;
    readonly water: BlockType;
    readonly ice: BlockType;
    readonly stone: BlockType;
    readonly grass: BlockType;
    readonly poppy: BlockType;
    readonly birchLog: BlockType;
    readonly birchLeaves: BlockType;
  };
  readonly items: {
    readonly cobblestone: ItemType;
    readonly poppy: ItemType;
    readonly birchLog: ItemType;
    readonly birchPlanks: ItemType;
    readonly oakPlanks: ItemType;
    readonly craftingTable: ItemType;
  };
  readonly nonSolid: readonly number[];
  readonly minY: number;
  readonly pickupTicks: number;
  readonly tickRate: number;
  readonly pondCenter: { readonly x: number; readonly z: number };
  readonly pondWest: { readonly x: number; readonly z: number };
  readonly eastBank: { readonly x: number; readonly z: number };
  readonly iceColumn: { readonly x: number; readonly z: number };
  readonly flower: { readonly x: number; readonly z: number };
  readonly flowerStand: { readonly x: number; readonly z: number };
  readonly replant: { readonly x: number; readonly z: number };
  readonly birch: { readonly x: number; readonly z: number };
  readonly birchStand: { readonly x: number; readonly z: number };
  readonly detour: ReadonlyArray<{ readonly x: number; readonly z: number }>;
  readonly stepStart: { readonly x: number; readonly z: number };
  /** 台阶上层往 −Z 铺多长。prod 用真实按键走，走多远由帧率决定，铺得长一些。 */
  readonly stepLength: number;
}

export const SEVENTH_SLICE_ARGS: SeventhSliceArgs = {
  blocks: {
    air: BlockType.Air,
    water: BlockType.Water,
    ice: BlockType.Ice,
    stone: BlockType.Stone,
    grass: BlockType.Grass,
    poppy: BlockType.Poppy,
    birchLog: BlockType.BirchLog,
    birchLeaves: BlockType.BirchLeaves,
  },
  items: {
    cobblestone: ItemType.Cobblestone,
    poppy: ItemType.Poppy,
    birchLog: ItemType.BirchLog,
    birchPlanks: ItemType.BirchPlanks,
    oakPlanks: ItemType.OakPlanks,
    craftingTable: ItemType.CraftingTable,
  },
  nonSolid: NON_SOLID_BLOCKS,
  minY: WORLD_MIN_Y,
  pickupTicks: PICKUP_DELAY_TICKS,
  tickRate: TICK_RATE,
  pondCenter: POND_CENTER,
  pondWest: POND_WEST,
  eastBank: EAST_BANK,
  iceColumn: ICE_COLUMN,
  flower: FLOWER,
  flowerStand: FLOWER_STAND,
  replant: REPLANT,
  birch: BIRCH,
  birchStand: BIRCH_STAND,
  detour: DETOUR,
  stepStart: STEP_START,
  stepLength: 8,
};

/** 塘底（铺沙子那一格）的 y。 */
function pondFloor(x: number, z: number): number {
  const pond = pondsTouching(TERRAIN, chunkOf(x), chunkOf(z)).find((pond) =>
    pond.columns.some((column) => column.x === x && column.z === z),
  );
  if (!pond) throw new Error(`(${x}, ${z}) 不是水塘列`);
  return pond.floors[pond.columns.findIndex((column) => column.x === x && column.z === z)]!;
}

/** 生成的地形里 (x, y, z) 那一格（不经核心，直接调生成器）。 */
function generated(x: number, y: number, z: number): BlockType {
  const cx = chunkOf(x);
  const cz = chunkOf(z);
  return TERRAIN.generateChunk(cx, cz).get(x - cx * 16, y, z - cz * 16) as BlockType;
}

/** Node 里由地形对象算出、页面与导出文件要对上的那些格。 */
export interface SeventhSliceTerrain {
  readonly spawn: Vec3;
  readonly waterY: number;
  readonly pondFloor: number;
  /** 在水里放圆石的那一格：西边那列塘底之上一格。 */
  readonly placedInWater: Vec3;
  /** 放冰再挖掉的那一格：东岸西边那列的水面。 */
  readonly iceCell: Vec3;
  readonly flowerCell: Vec3;
  readonly replantCell: Vec3;
  readonly birchLog: Vec3;
}

/**
 * 用 Node 里同一份地形对象复核前序 issue 交接的地点，返回之后要对上的各格。地形改了导致对不上时这里先报出来，
 * 不让后面的步骤在错的地方乱走。
 */
export function checkSeventhSliceTerrain(): SeventhSliceTerrain {
  const { spawnColumn } = TERRAIN;
  const fail = (message: string): never => {
    throw new Error(`默认种子的地形与 #82 全流程的假设不符：${message}`);
  };
  if (TERRAIN.biomeAt(spawnColumn.x, spawnColumn.z) !== 'plains') fail('出生列不是平原');
  if (TERRAIN.surfaceBlockAt(spawnColumn.x, spawnColumn.z) !== BlockType.Grass) fail('出生列列顶不是草方块');
  const spawnY = TERRAIN.surfaceHeightAt(spawnColumn.x, spawnColumn.z) + 1;

  const pond = pondsTouching(TERRAIN, chunkOf(POND_CENTER.x), chunkOf(POND_CENTER.z)).find(
    (pond) => pond.x === POND_CENTER.x && pond.z === POND_CENTER.z,
  );
  if (!pond) fail(`(${POND_CENTER.x}, ${POND_CENTER.z}) 不是水塘的中心列`);
  const floor = pondFloor(POND_CENTER.x, POND_CENTER.z);
  if (pondFloor(POND_WEST.x, POND_WEST.z) !== floor) fail('水塘中心列西边那列的塘底与中心列不同');
  // 至少三格深：沉到塘底时眼睛在水里
  if (pond!.waterY - floor < 3) fail('水塘中心不到三格深');
  if (TERRAIN.surfaceBlockAt(ICE_COLUMN.x, ICE_COLUMN.z) !== BlockType.Water) fail('放冰的那一列不是水塘列');
  if (TERRAIN.surfaceBlockAt(EAST_BANK.x, EAST_BANK.z) !== BlockType.Grass) fail('东岸那一列列顶不是草方块');
  if (TERRAIN.surfaceHeightAt(EAST_BANK.x, EAST_BANK.z) !== pond!.waterY) fail('东岸的地面与水面不齐，爬不上去');

  const flowerY = TERRAIN.surfaceHeightAt(FLOWER.x, FLOWER.z) + 1;
  if (generated(FLOWER.x, flowerY, FLOWER.z) !== BlockType.Poppy) fail(`(${FLOWER.x}, ${flowerY}, ${FLOWER.z}) 不是虞美人`);
  if (Math.max(Math.abs(FLOWER.x - spawnColumn.x), Math.abs(FLOWER.z - spawnColumn.z)) <= 7) fail('那株花在出生列 7 格以内');
  const replantY = TERRAIN.surfaceHeightAt(REPLANT.x, REPLANT.z) + 1;
  if (TERRAIN.surfaceBlockAt(REPLANT.x, REPLANT.z) !== BlockType.Grass) fail('种花的那一列列顶不是草方块');
  if (generated(REPLANT.x, replantY, REPLANT.z) !== BlockType.Air) fail('种花的那一格不是空气');

  const [first] = treesTouching(TERRAIN, 0, 0);
  if (first?.species !== 'birch' || first.x !== BIRCH.x || first.z !== BIRCH.z) fail('原点区块的第一棵树不是那棵白桦');
  return {
    spawn: { x: spawnColumn.x + 0.5, y: spawnY, z: spawnColumn.z + 0.5 },
    waterY: pond!.waterY,
    pondFloor: floor,
    placedInWater: { x: POND_WEST.x, y: floor + 1, z: POND_WEST.z },
    iceCell: { x: ICE_COLUMN.x, y: pond!.waterY, z: ICE_COLUMN.z },
    flowerCell: { x: FLOWER.x, y: flowerY, z: FLOWER.z },
    replantCell: { x: REPLANT.x, y: replantY, z: REPLANT.z },
    birchLog: { x: BIRCH.x, y: first!.rootY, z: BIRCH.z },
  };
}

/** 每一步的读回：玩家此刻的状态，加上这一步关心的那几格方块。 */
export interface StepReadback {
  readonly position: Vec3;
  readonly onGround: boolean;
  readonly inWater: boolean;
  readonly eyeInWater: boolean;
  readonly cells: Record<string, number>;
  readonly target?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  readonly inventory: ReadonlyArray<{ readonly item: number; readonly count: number } | null>;
  readonly extra?: unknown;
}

export type StepName = 'swimToPondCenter' | 'placeInWater' | 'climbOutEast' | 'mineIce' | 'pickFlower' | 'chopBirch' | 'craftTable' | 'buildStep' | 'walkUpStep';

/**
 * 全流程在世界里的各步，`core` 是核心（页面里的调试句柄或 Node 里的 `GameCore`）。返回一个按步名取的对象，
 * 每一步做完返回读回。整段只用参数，见本文件开头。
 */
export function seventhSliceSteps(core: GameCore, a: SeventhSliceArgs): Record<StepName, () => StepReadback> {
  const idle = { forward: false, back: false, left: false, right: false, jump: false };
  /** 这一列最高的实心方块。 */
  const groundY = (x: number, z: number): number => {
    let y = core.highestBlockY(x, z);
    while (y >= a.minY && a.nonSolid.includes(core.getBlock(x, y, z))) y--;
    return y;
  };
  const inventory = () =>
    Array.from({ length: core.inventory.size }, (_, i) => {
      const stack = core.inventory.slot(i);
      return stack ? { item: stack.item, count: stack.count } : null;
    });
  const readback = (cells: Record<string, { x: number; y: number; z: number }>, extra?: unknown): StepReadback => {
    const { position, onGround, inWater, eyeInWater } = core.player;
    const target = core.mining.target;
    return {
      position: { ...position },
      onGround,
      inWater,
      eyeInWater,
      cells: Object.fromEntries(Object.entries(cells).map(([name, { x, y, z }]) => [name, core.getBlock(x, y, z)])),
      target: target ? { x: target.x, y: target.y, z: target.z } : undefined,
      inventory: inventory(),
      extra,
    };
  };
  /** 视线对准 (x, y, z) 这一点，推进一 tick 让目标按新视线重算。 */
  const aimAt = (x: number, y: number, z: number): void => {
    const eye = core.player.eyePosition;
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
    core.turn(Math.atan2(-dx, -dz) - core.player.yaw, Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch);
    core.tick();
  };
  /** 朝 (x + 0.5, z + 0.5) 走（每 tick 转向它），到了半格以内停下，再等停稳。jump 是否一路按着跳。 */
  const walkTo = (x: number, z: number, jump = false, maxTicks = 600): void => {
    const tx = x + 0.5;
    const tz = z + 0.5;
    let ticks = 0;
    for (; ticks < maxTicks; ticks++) {
      const { position } = core.player;
      const dx = tx - position.x;
      const dz = tz - position.z;
      if (Math.hypot(dx, dz) < 0.25) break;
      core.turn(Math.atan2(-dx, -dz) - core.player.yaw, -core.player.pitch);
      core.setMoveIntent({ ...idle, forward: true, jump });
      core.tick();
    }
    core.setMoveIntent(idle);
    if (ticks === maxTicks) throw new Error(`${maxTicks} tick 内没走到 (${x}, ${z})，停在 ${JSON.stringify(core.player.position)}`);
    settle();
  };
  /** 不按任何键，推进到玩家落地（或在水里沉到底）且不再移动。 */
  const settle = (): void => {
    for (let i = 0; i < 10 * a.tickRate; i++) {
      const before = { ...core.player.position };
      core.tick();
      const after = core.player.position;
      if (core.player.onGround && Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) < 1e-4) return;
    }
  };
  /** 对准 (x, y, z) 那一格离底面 aimY 高处，按住挖掘键直到它不再是 block；一路上视线先碰到的别的方块（树叶）一并挖掉。 */
  const mineThrough = (x: number, y: number, z: number, block: number, aimY = 0.5, maxTicks = 1200): string[] => {
    const cleared: string[] = [];
    let ticks = 0;
    while (core.getBlock(x, y, z) === block && ticks < maxTicks) {
      aimAt(x + 0.5, y + aimY, z + 0.5);
      const target = core.mining.target;
      if (!target) throw new Error(`对不准 (${x}, ${y}, ${z})`);
      const aimed = { ...target };
      const aimedBlock = core.getBlock(aimed.x, aimed.y, aimed.z);
      core.setMining(true);
      while (core.getBlock(aimed.x, aimed.y, aimed.z) === aimedBlock && ticks < maxTicks) {
        core.tick();
        ticks++;
      }
      core.setMining(false);
      if (aimed.x !== x || aimed.y !== y || aimed.z !== z) cleared.push(`${aimed.x},${aimed.y},${aimed.z}:${aimedBlock}`);
    }
    if (core.getBlock(x, y, z) === block) throw new Error(`${maxTicks} tick 内没挖掉 (${x}, ${y}, ${z})`);
    return cleared;
  };
  const slotOf = (item: number): number => {
    for (let i = 0; i < 9; i++) if (core.inventory.slot(i)?.item === item) return i;
    throw new Error(`快捷栏里没有物品 ${item}`);
  };
  /** 选中 item 那一格，对准 (x, y, z) 的顶面按使用键，返回此刻的目标。 */
  const useOnTop = (item: number, x: number, y: number, z: number) => {
    core.selectHotbarSlot(slotOf(item));
    aimAt(x + 0.5, y + 1, z + 0.5);
    const target = core.mining.target ? { ...core.mining.target } : undefined;
    core.use();
    core.tick();
    return target;
  };

  const center = a.pondCenter;
  const floorAtCenter = (): number => groundY(center.x, center.z);

  return {
    swimToPondCenter() {
      walkTo(center.x, center.z);
      const { x, y, z } = core.player.eyePosition;
      return readback({ eye: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } }, { floor: floorAtCenter() });
    },
    placeInWater() {
      core.giveItem(a.items.cobblestone, 4);
      const floor = groundY(a.pondWest.x, a.pondWest.z);
      const cell = { x: a.pondWest.x, y: floor + 1, z: a.pondWest.z };
      const before = core.getBlock(cell.x, cell.y, cell.z);
      const target = useOnTop(a.items.cobblestone, a.pondWest.x, floor, a.pondWest.z);
      return { ...readback({ placed: cell }, { before, floor }), target };
    },
    climbOutEast() {
      walkTo(a.eastBank.x, a.eastBank.z, true);
      return readback({}, { ground: groundY(a.eastBank.x, a.eastBank.z) });
    },
    mineIce() {
      const x = a.iceColumn.x;
      const z = a.iceColumn.z;
      // 水面那一格：这一列从上往下第一格水
      let y = core.highestBlockY(x, z);
      while (y >= a.minY && core.getBlock(x, y, z) !== a.blocks.water) y--;
      core.setBlock(x, y, z, a.blocks.ice);
      const placed = core.getBlock(x, y, z);
      const drops = core.drops.count;
      core.selectHotbarSlot(8);
      mineThrough(x, y, z, a.blocks.ice, 0.9);
      core.tick(a.pickupTicks + a.tickRate);
      return readback({ ice: { x, y, z } }, { placed, y, newDrops: core.drops.count - drops });
    },
    pickFlower() {
      walkTo(a.flowerStand.x, a.flowerStand.z);
      const flower = { x: a.flower.x, y: groundY(a.flower.x, a.flower.z) + 1, z: a.flower.z };
      const before = core.getBlock(flower.x, flower.y, flower.z);
      core.selectHotbarSlot(8);
      aimAt(flower.x + 0.5, flower.y + 0.25, flower.z + 0.5);
      const minedTarget = core.mining.target ? { ...core.mining.target } : undefined;
      core.setMining(true);
      core.tick();
      core.setMining(false);
      core.tick(a.pickupTicks + a.tickRate);
      const picked = inventory();
      const soil = { x: a.replant.x, y: groundY(a.replant.x, a.replant.z), z: a.replant.z };
      const soilBlock = core.getBlock(soil.x, soil.y, soil.z);
      const plantTarget = useOnTop(a.items.poppy, soil.x, soil.y, soil.z);
      return readback(
        { flower, replanted: { x: soil.x, y: soil.y + 1, z: soil.z } },
        { before, minedTarget, picked, soilBlock, plantTarget, soil },
      );
    },
    chopBirch() {
      for (const point of a.detour) walkTo(point.x, point.z);
      walkTo(a.birchStand.x, a.birchStand.z);
      const log = { x: a.birch.x, y: groundY(a.birch.x, a.birch.z - 3) + 1, z: a.birch.z };
      const before = core.getBlock(log.x, log.y, log.z);
      core.selectHotbarSlot(8);
      const cleared = mineThrough(log.x, log.y, log.z, a.blocks.birchLog);
      // 原木掉在树干那一列：沿挖开的那条缝走过去拾起
      walkTo(a.birch.x, a.birch.z - 1);
      core.tick(a.pickupTicks + a.tickRate);
      return readback({ log }, { before, cleared });
    },
    craftTable() {
      core.giveItem(a.items.oakPlanks, 2);
      core.toggleInventory();
      core.tick();
      // 界面上的点击在下一 tick 生效，每点一下推进一 tick 再读
      const click = (action: () => void): void => {
        action();
        core.tick();
      };
      const crafting = () => core.inventoryScreen.crafting!;
      const recipe = (item: number): number => crafting().recipes.findIndex((entry) => entry.recipe.result.item === item);
      // 一根白桦原木出 4 块白桦木板，放进第 30 格
      click(() => core.clickRecipe(recipe(a.items.birchPlanks)));
      const planksOutput = crafting().output ? { ...crafting().output! } : undefined;
      click(() => core.clickCraftingOutput());
      click(() => core.clickSlot(30));
      // 工作台：配方书按三种木板合计判断，点它填入 2 块橡木板与 2 块白桦木板
      const craftable = crafting().recipes[recipe(a.items.craftingTable)]!.craftable;
      click(() => core.clickRecipe(recipe(a.items.craftingTable)));
      const grid = Array.from({ length: 4 }, (_, i) => crafting().slot(i)?.item ?? null);
      const tableOutput = crafting().output ? { ...crafting().output! } : undefined;
      click(() => core.clickCraftingOutput());
      click(() => core.clickSlot(31));
      core.toggleInventory();
      core.tick();
      return readback({}, { planksOutput, craftable, grid, tableOutput, open: core.inventoryScreen.open });
    },
    buildStep() {
      walkTo(a.stepStart.x, a.stepStart.z);
      // 与 dev.settings.spec.ts 的 walkIntoStep 同样的台阶：玩家脚下一层石头地面，往 −Z 两格外起高一格
      core.turn(-core.player.yaw, -core.player.pitch);
      const start = core.player.position;
      const bx = Math.floor(start.x);
      const bz = Math.floor(start.z);
      const feet = Math.floor(start.y);
      const far = 2 + a.stepLength;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = 1; dz >= -far; dz--) {
          core.setBlock(bx + dx, feet - 1, bz + dz, a.blocks.stone);
          for (let dy = 0; dy <= 3; dy++) core.setBlock(bx + dx, feet + dy, bz + dz, a.blocks.air);
        }
        for (let dz = -3; dz >= -far; dz--) core.setBlock(bx + dx, feet, bz + dz, a.blocks.stone);
      }
      core.tick();
      // 台阶靠玩家那一面在 z = bz − 2
      return readback({ stepFirst: { x: bx, y: feet, z: bz - 3 }, below: { x: bx, y: feet - 1, z: bz } }, { feet, stepFace: bz - 2 });
    },
    walkUpStep() {
      core.turn(-core.player.yaw, -core.player.pitch);
      core.setMoveIntent({ ...idle, forward: true });
      for (let i = 0; i < 30; i++) core.tick();
      core.setMoveIntent(idle);
      settle();
      return readback({});
    },
  };
}

/**
 * 在页面里的核心上跑一步：把 `seventhSliceSteps` 的源码送进页面求值。整段在一次同步的 evaluate 里，游戏循环插不进来。
 */
export function stepInPage(page: Page, name: StepName): Promise<StepReadback> {
  return page.evaluate(
    ({ source, name, args }) => {
      const steps = (0, eval)(`(${source})`)(window.__VOXEL__!.core, args);
      return steps[name]();
    },
    { source: seventhSliceSteps.toString(), name, args: SEVENTH_SLICE_ARGS },
  );
}

/** 一步的读回里 extra 那一项的内容，按步名。 */
interface StepExtras {
  readonly swimToPondCenter: { readonly floor: number };
  readonly placeInWater: { readonly before: number; readonly floor: number };
  readonly climbOutEast: { readonly ground: number };
  readonly mineIce: { readonly placed: number; readonly y: number; readonly newDrops: number };
  readonly pickFlower: {
    readonly before: number;
    readonly minedTarget: Vec3 | undefined;
    readonly picked: StepReadback['inventory'];
    readonly soilBlock: number;
    readonly plantTarget: (Vec3 & { readonly normal: Vec3 }) | undefined;
  };
  readonly chopBirch: { readonly before: number; readonly cleared: readonly string[] };
  readonly craftTable: {
    readonly planksOutput: { readonly item: number; readonly count: number } | undefined;
    readonly craftable: boolean;
    readonly grid: ReadonlyArray<number | null>;
    readonly tableOutput: { readonly item: number; readonly count: number } | undefined;
    readonly open: boolean;
  };
  readonly buildStep: { readonly feet: number; readonly stepFace: number };
}

/** 背包里某种物品的合计。 */
export function countOf(inventory: StepReadback['inventory'], item: number): number {
  return inventory.reduce((sum, stack) => sum + (stack?.item === item ? stack.count : 0), 0);
}

/**
 * 每一步读回的断言，dev 与 prod 共用。期望值来自 Node 里的地形（`SeventhSliceTerrain`）与方块、物品编号。
 * 返回之后几步要用的值（台阶的高度与位置）。
 */
export const expectStep = {
  /** 走到水边游进去，沉到中心列塘底：脚踩塘底、身子与眼睛都在水里，眼睛那一格是水。 */
  swimToPondCenter(r: StepReadback, t: SeventhSliceTerrain): void {
    const extra = r.extra as StepExtras['swimToPondCenter'];
    expect(extra.floor).toBe(t.pondFloor);
    expect(r.position.y).toBe(t.pondFloor + 1);
    expect(r.onGround).toBe(true);
    expect(r.inWater).toBe(true);
    expect(r.eyeInWater).toBe(true);
    expect(r.cells.eye).toBe(BlockType.Water);
  },
  /** 对着水里那列塘底的顶面放圆石：那一格先是水，放下之后是圆石，背包少一块。 */
  placeInWater(r: StepReadback, t: SeventhSliceTerrain): void {
    const extra = r.extra as StepExtras['placeInWater'];
    expect(extra.before).toBe(BlockType.Water);
    expect(r.target).toMatchObject({ x: t.placedInWater.x, y: t.placedInWater.y - 1, z: t.placedInWater.z });
    expect(r.cells.placed).toBe(BlockType.Cobblestone);
    expect(countOf(r.inventory, ItemType.Cobblestone)).toBe(3);
  },
  /** 按住跳朝东岸游：爬上岸，站在岸上的草方块上，不在水里。 */
  climbOutEast(r: StepReadback, t: SeventhSliceTerrain): void {
    const extra = r.extra as StepExtras['climbOutEast'];
    expect(extra.ground).toBe(t.waterY);
    expect(r.position.y).toBe(t.waterY + 1);
    expect(r.onGround).toBe(true);
    expect(r.inWater).toBe(false);
  },
  /** 把水面那一格换成冰，空手挖掉：原处是一格水，没有掉落物。 */
  mineIce(r: StepReadback, t: SeventhSliceTerrain): void {
    const extra = r.extra as StepExtras['mineIce'];
    expect(extra.y).toBe(t.iceCell.y);
    expect(extra.placed).toBe(BlockType.Ice);
    expect(r.cells.ice).toBe(BlockType.Water);
    expect(extra.newDrops).toBe(0);
  },
  /** 挖掉那株虞美人拾起来，种到旁边一列的草方块上：原处空了，新处是虞美人，背包里不剩。 */
  pickFlower(r: StepReadback, t: SeventhSliceTerrain): void {
    const extra = r.extra as StepExtras['pickFlower'];
    expect(extra.before).toBe(BlockType.Poppy);
    expect(extra.minedTarget).toMatchObject({ ...t.flowerCell });
    expect(countOf(extra.picked, ItemType.Poppy)).toBe(1);
    expect(r.cells.flower).toBe(BlockType.Air);
    expect(extra.soilBlock).toBe(BlockType.Grass);
    expect(extra.plantTarget).toMatchObject({ x: t.replantCell.x, y: t.replantCell.y - 1, z: t.replantCell.z, normal: { x: 0, y: 1, z: 0 } });
    expect(r.cells.replanted).toBe(BlockType.Poppy);
    expect(countOf(r.inventory, ItemType.Poppy)).toBe(0);
  },
  /** 空手砍白桦最下面那格原木（挡在视线上的白桦树叶先挖掉），走过去拾起一根白桦原木。 */
  chopBirch(r: StepReadback): void {
    const extra = r.extra as StepExtras['chopBirch'];
    expect(extra.before).toBe(BlockType.BirchLog);
    expect(r.cells.log).toBe(BlockType.Air);
    for (const cleared of extra.cleared) expect(cleared.endsWith(`:${BlockType.BirchLeaves}`), cleared).toBe(true);
    expect(countOf(r.inventory, ItemType.BirchLog)).toBe(1);
  },
  /**
   * 背包界面里一根白桦原木做出 4 块白桦木板，再加 2 块橡木板：工作台那条配方够料，点它填入两种木板各 2 块，
   * 做出一个工作台；背包里剩 2 块白桦木板，橡木板用完。
   */
  craftTable(r: StepReadback): void {
    const extra = r.extra as StepExtras['craftTable'];
    expect(extra.planksOutput).toEqual({ item: ItemType.BirchPlanks, count: 4 });
    expect(extra.craftable).toBe(true);
    const byId = (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1);
    expect([...extra.grid].sort(byId)).toEqual([ItemType.OakPlanks, ItemType.OakPlanks, ItemType.BirchPlanks, ItemType.BirchPlanks].sort(byId));
    expect(extra.tableOutput).toEqual({ item: ItemType.CraftingTable, count: 1 });
    expect(extra.open).toBe(false);
    expect(countOf(r.inventory, ItemType.CraftingTable)).toBe(1);
    expect(countOf(r.inventory, ItemType.BirchPlanks)).toBe(2);
    expect(countOf(r.inventory, ItemType.OakPlanks)).toBe(0);
    expect(countOf(r.inventory, ItemType.BirchLog)).toBe(0);
  },
  /** 搭好一格高的台阶：脚下是石头，台阶第一格是石头。返回脚底高度与台阶靠玩家那一面的 z。 */
  buildStep(r: StepReadback): StepExtras['buildStep'] {
    expect(r.cells.below).toBe(BlockType.Stone);
    expect(r.cells.stepFirst).toBe(BlockType.Stone);
    return r.extra as StepExtras['buildStep'];
  },
};

/** 保存并退出再进入、导出再导入之后都要在原处的那几格，与各自应是的方块。 */
export function changedCells(t: SeventhSliceTerrain, step: StepExtras['buildStep']): Record<string, { cell: Vec3; block: BlockType }> {
  return {
    放进水里的圆石: { cell: t.placedInWater, block: BlockType.Cobblestone },
    挖冰留下的水: { cell: t.iceCell, block: BlockType.Water },
    挖掉的花: { cell: t.flowerCell, block: BlockType.Air },
    种下的花: { cell: t.replantCell, block: BlockType.Poppy },
    砍掉的白桦原木: { cell: t.birchLog, block: BlockType.Air },
    台阶: { cell: { x: SEVENTH_SLICE_ARGS.stepStart.x, y: step.feet, z: step.stepFace - 1 }, block: BlockType.Stone },
  };
}
