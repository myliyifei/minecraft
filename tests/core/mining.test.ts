import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHAIN_MINING_LIMIT } from '../../src/core/chain-mining';
import type { DropSink } from '../../src/core/drop';
import { Inventory } from '../../src/core/inventory';
import { ItemType, type ItemStack, type ToolHand } from '../../src/core/item';
import { Mining, type AimView, type MiningInput } from '../../src/core/mining';
import { PLAYER_REACH } from '../../src/core/player';
import type { EntityRaycast } from '../../src/core/raycast';
import type { Vec3 } from '../../src/core/vec3';
import type { XpOrbSink } from '../../src/core/xp-orb';
import { World } from '../../src/core/world';
import {
  AIM_EYE as EYE,
  AIM_LAYER_Y as LAYER_Y,
  unit,
  worldWithBlocks as worldWith,
  type BlockCoord,
} from '../helpers/aiming';
import { flatTestWorld } from '../helpers/flat-terrain';

/** 水平朝 +X 看。 */
const LOOK_X: Vec3 = { x: 1, y: 0, z: 0 };

/** 水平朝 +Z 看。 */
const LOOK_Z: Vec3 = { x: 0, y: 0, z: 1 };

/** 水平朝 −Z 看：那一侧什么都没摆，用来表示「视线移到空处」。 */
const LOOK_EMPTY: Vec3 = { x: 0, y: 0, z: -1 };

/** 眼睛正前方 2.5 格的那块方块。 */
const TARGET: BlockCoord = [3, LAYER_Y, 0];

/** 可以中途改朝向的瞄准视图。眼睛不动，只转视线。 */
function turntable(initial: Vec3 = LOOK_X): { aim: AimView; look: (next: Vec3) => void } {
  let direction = initial;
  return {
    aim: {
      eyePosition: EYE,
      get lookDirection(): Vec3 {
        return direction;
      },
    },
    look: (next: Vec3) => {
      direction = next;
    },
  };
}

/** 一格里掉出来的东西。 */
type SpawnedDrop = { stack: ItemStack; at: BlockCoord };

/** 一格里生成的经验球。 */
type SpawnedXp = { amount: number; at: BlockCoord };

/** 记下挖掘交出来的掉落物，不真的模拟它们。 */
function dropLog(): { sink: DropSink; spawned: SpawnedDrop[] } {
  const spawned: SpawnedDrop[] = [];
  return {
    sink: {
      spawnInBlock: (stack, x, y, z) => spawned.push({ stack, at: [x, y, z] }),
    },
    spawned,
  };
}

/** 记下挖掘交出来的经验，不真的模拟经验球飞过来。 */
function xpLog(): { sink: XpOrbSink; spawned: SpawnedXp[] } {
  const spawned: SpawnedXp[] = [];
  return {
    sink: {
      spawnInBlock: (amount, x, y, z) => spawned.push({ amount, at: [x, y, z] }),
    },
    spawned,
  };
}

/**
 * 不看掉落也不看经验的那些用例用这两个：交出去的东西没人读，所有用例共用一份就够。
 */
const IGNORED_DROPS: DropSink = dropLog().sink;
const IGNORED_XP: XpOrbSink = xpLog().sink;

/** 视线上没有任何实体：这里的用例只看方块。僵尸挡住视线的用例在 tests/core/attack.test.ts。 */
const NO_ENTITIES: EntityRaycast = { raycast: () => undefined };

/**
 * 什么都不拿的手。空手挖掘的用例共用一份：它没有状态，损耗对它没有任何效果。
 */
const BARE: ToolHand = { held: undefined, wearHeld: () => {} };

/**
 * 手上拿着某一堆的背包：选中格里放的就是它。
 *
 * 用真的 `Inventory` 而不是假对象：耐久损耗到满那一格要清空，这条规则在背包里，
 * 挖掘那一侧只管报「损耗了几点」。
 */
function handHolding(stack: ItemStack | undefined): Inventory {
  const inventory = new Inventory();
  inventory.setSlot(0, stack);
  return inventory;
}

/** 一把新工具：满耐久，所以没有 `damage` 字段。 */
function fresh(item: ItemType): ItemStack {
  return { item, count: 1 };
}

/** 一把用旧的工具：已经损耗了 `damage` 点耐久。 */
function worn(item: ItemType, damage: number): ItemStack {
  return { item, count: 1, damage };
}

/** 目标为正前方那块方块的挖掘状态机，手上拿着 `held`（默认空手）。 */
function miningTowards(
  block: BlockType,
  held?: ItemStack,
): {
  world: World;
  mining: Mining;
  hand: Inventory;
  spawned: SpawnedDrop[];
  experience: SpawnedXp[];
} {
  const world = worldWith([TARGET, block]);
  const drops = dropLog();
  const xp = xpLog();
  const hand = handHolding(held);
  return {
    world,
    mining: new Mining(world, turntable().aim, hand, drops.sink, xp.sink, NO_ENTITIES),
    hand,
    spawned: drops.spawned,
    experience: xp.spawned,
  };
}

/** 只按挖掘键。 */
const SINGLE: MiningInput = { held: true, chain: false };

/** 挖掘键与连锁键都按着。 */
const CHAINED: MiningInput = { held: true, chain: true };

/** 两个键都松开。 */
const RELEASED: MiningInput = { held: false, chain: false };

/** 按住这套输入推进 n 个 tick，默认只按挖掘键。 */
function hold(mining: Mining, ticks: number, input: MiningInput = SINGLE): void {
  for (let i = 0; i < ticks; i++) mining.step(input);
}

/**
 * 原木挖满要多少 tick。连锁的耗时与它相同。
 *
 * 写死 60 而不是调 `miningTicks`：这个文件就是耗时的断言处（见上面的 `TIMINGS`），
 * 拿被测函数算出期望值等于什么都没验。别处（tests/core/game.test.ts）测的是接线，
 * 那里从耗时表取才对。
 */
const LOG_TICKS = 60;

describe('挖掘耗时按硬度表', () => {
  /** 空手挖掉一块要多少 tick，来自 issue #7 的验收条件。 */
  const TIMINGS: Array<[string, BlockType, number]> = [
    ['草方块', BlockType.Grass, 18],
    ['泥土', BlockType.Dirt, 15],
    // 石头要镐，空着手是每点硬度 100 tick 而不是 30
    ['石头', BlockType.Stone, 150],
    ['原木', BlockType.OakLog, 60],
    ['树叶', BlockType.OakLeaves, 6],
  ];

  for (const [name, block, ticks] of TIMINGS) {
    it(`${name}第 ${ticks - 1} tick 仍在，第 ${ticks} tick 变成空气`, () => {
      const { world, mining } = miningTowards(block);
      hold(mining, ticks - 1);
      expect(world.getBlock(...TARGET)).toBe(block);
      expect(mining.progress).toBeCloseTo((ticks - 1) / ticks, 10);

      hold(mining, 1);
      expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    });
  }

  it('基岩挖不动，按住多久都还在，也不出裂纹', () => {
    const { world, mining } = miningTowards(BlockType.Bedrock);
    hold(mining, 1000);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Bedrock);
    // 进度恒为 0，渲染层因此一阶裂纹都不画
    expect(mining.progress).toBe(0);
    expect(mining.target).toMatchObject({ x: TARGET[0] });
  });
});

describe('挖掘进度绑定目标方块', () => {
  it('把目标切到另一块，两块都从零开始', () => {
    const world = worldWith([TARGET, BlockType.Dirt], [[0, LAYER_Y, 3], BlockType.Dirt]);
    const table = turntable();
    const mining = new Mining(world, table.aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, 10);
    expect(mining.progress).toBeCloseTo(10 / 15, 10);

    table.look(LOOK_Z);
    hold(mining, 1);
    expect(mining.target).toMatchObject({ x: 0, z: 3 });
    expect(mining.progress).toBeCloseTo(1 / 15, 10);

    table.look(LOOK_X);
    hold(mining, 1);
    expect(mining.target).toMatchObject({ x: 3, z: 0 });
    expect(mining.progress).toBeCloseTo(1 / 15, 10);
  });

  it('视线移开再回来，要重新挖满整份耗时', () => {
    const world = worldWith([TARGET, BlockType.Dirt]);
    const table = turntable();
    const mining = new Mining(world, table.aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, 14);
    table.look(LOOK_EMPTY);
    hold(mining, 1);
    table.look(LOOK_X);

    // 只看最终状态会漏掉「进度攒着」这种实现：碎掉的时刻才分得开两者
    hold(mining, 14);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('松开挖掘键再按下，进度从零开始', () => {
    const { world, mining } = miningTowards(BlockType.Dirt);
    hold(mining, 14);
    expect(mining.progress).toBeCloseTo(14 / 15, 10);

    mining.step(RELEASED);
    expect(mining.progress).toBe(0);

    hold(mining, 14);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('只是瞄着不按键，进度一直是 0', () => {
    const { world, mining } = miningTowards(BlockType.Dirt);
    for (let i = 0; i < 100; i++) mining.step(RELEASED);
    expect(mining.progress).toBe(0);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
  });

  it('换的只是命中面而不是方块时，进度接着走', () => {
    // 同一块方块，一条视线从它的顶面进、一条从 −X 面进
    const block: BlockCoord = [2, LAYER_Y - 1, 0];
    const world = worldWith([block, BlockType.Dirt]);
    const table = turntable(unit({ x: 1, y: -0.25, z: 0 }));
    const mining = new Mining(world, table.aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, 7);
    expect(mining.target).toMatchObject({ x: 2, y: LAYER_Y - 1, normal: { y: 1 } });

    table.look(unit({ x: 1, y: -0.5, z: 0 }));
    hold(mining, 8);
    expect(world.getBlock(...block)).toBe(BlockType.Air);
  });
});

describe('挖掘的触及距离', () => {
  /** 进入面正好落在触及距离上的那一格：眼睛在 x = 0.5，进入面在 x = 5。 */
  const REACHABLE_X = EYE.x + PLAYER_REACH;

  it('触及距离之内的方块挖得掉', () => {
    const near: BlockCoord = [REACHABLE_X, LAYER_Y, 0];
    const world = worldWith([near, BlockType.Dirt]);
    const mining = new Mining(world, turntable().aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);
    hold(mining, 15);
    expect(world.getBlock(...near)).toBe(BlockType.Air);
  });

  it('再远一格就不是目标，按住也挖不动', () => {
    const far: BlockCoord = [REACHABLE_X + 1, LAYER_Y, 0];
    const world = worldWith([far, BlockType.Dirt]);
    const mining = new Mining(world, turntable().aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);
    hold(mining, 100);
    expect(mining.target).toBeUndefined();
    expect(mining.progress).toBe(0);
    expect(world.getBlock(...far)).toBe(BlockType.Dirt);
  });

  it('什么都没对准时按住挖掘键，没有目标、进度为 0', () => {
    const world = flatTestWorld();
    const mining = new Mining(
      world,
      turntable(LOOK_EMPTY).aim,
      BARE,
      IGNORED_DROPS,
      IGNORED_XP,
      NO_ENTITIES,
    );
    hold(mining, 100);
    expect(mining.target).toBeUndefined();
    expect(mining.progress).toBe(0);
  });
});

describe('挖穿之后掉出什么', () => {
  it('草方块碎掉时在原地掉出一个泥土', () => {
    const { mining, spawned } = miningTowards(BlockType.Grass);

    hold(mining, 17);
    // 还没碎，什么都没掉
    expect(spawned).toEqual([]);

    hold(mining, 1);
    expect(spawned).toEqual([{ stack: { item: ItemType.Dirt, count: 1 }, at: TARGET }]);
  });

  it('原木掉原木', () => {
    const { mining, spawned } = miningTowards(BlockType.OakLog);
    hold(mining, 60);
    expect(spawned).toEqual([{ stack: { item: ItemType.OakLog, count: 1 }, at: TARGET }]);
  });

  it('树叶与空手挖的石头碎了也不掉东西', () => {
    for (const [block, ticks] of [
      [BlockType.OakLeaves, 6],
      [BlockType.Stone, 150],
    ] as const) {
      const { world, mining, spawned } = miningTowards(block);
      hold(mining, ticks);
      expect(world.getBlock(...TARGET), `方块 ${block}`).toBe(BlockType.Air);
      expect(spawned, `方块 ${block}`).toEqual([]);
    }
  });

  it('挖不动的基岩不掉东西', () => {
    const { mining, spawned } = miningTowards(BlockType.Bedrock);
    hold(mining, 1000);
    expect(spawned).toEqual([]);
  });

  it('连着挖两块，一块掉一个', () => {
    const world = worldWith([[2, LAYER_Y, 0], BlockType.Dirt], [TARGET, BlockType.Dirt]);
    const { sink, spawned } = dropLog();
    const mining = new Mining(world, turntable().aim, BARE, sink, IGNORED_XP, NO_ENTITIES);

    hold(mining, 30);
    expect(spawned).toEqual([
      { stack: { item: ItemType.Dirt, count: 1 }, at: [2, LAYER_Y, 0] },
      { stack: { item: ItemType.Dirt, count: 1 }, at: TARGET },
    ]);
  });
});

describe('挖掉熔炉时里面的东西一起掉出来（issue #30）', () => {
  const PICKAXE = fresh(ItemType.WoodenPickaxe);
  const FURNACE_X1 = { item: ItemType.Furnace, count: 1 };
  const INPUT = { item: ItemType.Cobblestone, count: 3 };
  const FUEL = { item: ItemType.OakLog, count: 2 };
  const OUTPUT = { item: ItemType.Dirt, count: 4 };

  /** 正前方摆一个装了原料、燃料、成品的熔炉，手上拿着 `held`。 */
  function loadedFurnace(block: BlockType, held?: ItemStack) {
    const setup = miningTowards(block, held);
    const state = setup.world.blockStateAt(...TARGET)!;
    state.input = INPUT;
    state.fuel = FUEL;
    state.output = OUTPUT;
    return setup;
  }

  it('持木镐 53 tick 挖掉：熔炉物品与三格里的东西都在原位掉出，状态表里那条没了', () => {
    const { world, mining, spawned } = loadedFurnace(BlockType.Furnace, PICKAXE);
    hold(mining, 52);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Furnace);
    expect(spawned).toEqual([]);

    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([
      { stack: FURNACE_X1, at: TARGET },
      { stack: INPUT, at: TARGET },
      { stack: FUEL, at: TARGET },
      { stack: OUTPUT, at: TARGET },
    ]);
    expect(world.blockStateAt(...TARGET)).toBeUndefined();
  });

  it('燃烧中的编号挖掉结果相同：掉的是熔炉物品，不是别的', () => {
    const { world, mining, spawned } = loadedFurnace(BlockType.LitFurnace, PICKAXE);
    hold(mining, 53);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([
      { stack: FURNACE_X1, at: TARGET },
      { stack: INPUT, at: TARGET },
      { stack: FUEL, at: TARGET },
      { stack: OUTPUT, at: TARGET },
    ]);
    expect(world.blockStateAt(...TARGET)).toBeUndefined();
  });

  it('空手 350 tick 挖掉：熔炉物品拿不到，里面的东西照样掉出来，东西不会消失', () => {
    const { world, mining, spawned } = loadedFurnace(BlockType.Furnace);
    hold(mining, 350);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([
      { stack: INPUT, at: TARGET },
      { stack: FUEL, at: TARGET },
      { stack: OUTPUT, at: TARGET },
    ]);
  });

  it('空熔炉挖掉只掉熔炉物品', () => {
    const { mining, spawned } = miningTowards(BlockType.Furnace, PICKAXE);
    hold(mining, 53);
    expect(spawned).toEqual([{ stack: FURNACE_X1, at: TARGET }]);
  });
});

describe('挖穿之后给多少经验', () => {
  /** issue #26 给的经验值（#9 的数值乘 10）：普通方块 30、原木 60。 */
  const EXPERIENCE: Array<[string, BlockType, number, number]> = [
    ['草方块', BlockType.Grass, 18, 30],
    ['泥土', BlockType.Dirt, 15, 30],
    ['原木', BlockType.OakLog, 60, 60],
    ['树叶', BlockType.OakLeaves, 6, 30],
  ];

  for (const [name, block, ticks, amount] of EXPERIENCE) {
    it(`${name}碎掉时在原地生成一个 ${amount} 点的经验球`, () => {
      const { mining, experience } = miningTowards(block);

      hold(mining, ticks - 1);
      // 还没碎，一点经验都没有
      expect(experience).toEqual([]);

      hold(mining, 1);
      expect(experience).toEqual([{ amount, at: TARGET }]);
    });
  }

  it('空手挖石头什么都拿不到，经验照给 30 点', () => {
    const { mining, spawned, experience } = miningTowards(BlockType.Stone);
    hold(mining, 150);
    expect(spawned).toEqual([]);
    expect(experience).toEqual([{ amount: 30, at: TARGET }]);
  });

  it('挖不动的基岩不给经验', () => {
    const { mining, experience } = miningTowards(BlockType.Bedrock);
    hold(mining, 1000);
    expect(experience).toEqual([]);
  });

  it('连着挖两块，一块一个经验球', () => {
    const world = worldWith([[2, LAYER_Y, 0], BlockType.Dirt], [TARGET, BlockType.Dirt]);
    const { sink, spawned } = xpLog();
    const mining = new Mining(world, turntable().aim, BARE, IGNORED_DROPS, sink, NO_ENTITIES);

    hold(mining, 30);
    expect(spawned).toEqual([
      { amount: 30, at: [2, LAYER_Y, 0] },
      { amount: 30, at: TARGET },
    ]);
  });
});

describe('挖掘的目标查询', () => {
  it('目标报出方块坐标、命中面与到进入面的距离', () => {
    const { mining } = miningTowards(BlockType.Dirt);
    // 还没 tick 过，什么都没瞄
    expect(mining.target).toBeUndefined();

    mining.step(RELEASED);
    expect(mining.target).toEqual({
      x: 3,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
      distance: 2.5,
    });
  });

  it('挖穿之后目标当场换到后面那块，按住不放接着挖', () => {
    const world = worldWith([[2, LAYER_Y, 0], BlockType.Dirt], [TARGET, BlockType.Dirt]);
    const mining = new Mining(world, turntable().aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, 15);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    // 选框不会在这一 tick 里还套着已经没有的方块
    expect(mining.target).toMatchObject({ x: 3 });
    expect(mining.progress).toBe(0);

    hold(mining, 15);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });
});

describe('挖掘视图报告碎掉的方块（#60）', () => {
  it('挖穿那一 tick 报告目标的坐标与种类，下一 tick 清空', () => {
    const { mining } = miningTowards(BlockType.Dirt);
    hold(mining, 14);
    expect(mining.broken).toBeUndefined();

    hold(mining, 1);
    expect(mining.broken).toEqual({ x: 3, y: LAYER_Y, z: 0, block: BlockType.Dirt });

    hold(mining, 1);
    expect(mining.broken).toBeUndefined();
  });

  it('松开挖掘键的下一 tick 同样清空', () => {
    const { mining } = miningTowards(BlockType.OakLeaves);
    hold(mining, 6);
    expect(mining.broken).toMatchObject({ block: BlockType.OakLeaves });
    mining.step(RELEASED);
    expect(mining.broken).toBeUndefined();
  });

  it('连锁挖 10 块：10 块都碎了，只报目标那一块', () => {
    const { world, cells, mining } = miningTrunk(10);
    hold(mining, LOG_TICKS, CHAINED);
    expect(remaining(world, cells)).toEqual([]);
    expect(mining.broken).toEqual({ x: TARGET[0], y: TARGET[1], z: TARGET[2], block: BlockType.OakLog });
  });

  it('挖不动的基岩按住多久都不报', () => {
    const { mining } = miningTowards(BlockType.Bedrock);
    hold(mining, 200);
    expect(mining.broken).toBeUndefined();
  });
});

/** 一格的三元坐标换成 Vec3，好跟预览报出来的坐标对照。 */
function toVec([x, y, z]: BlockCoord): Vec3 {
  return { x, y, z };
}

/**
 * 从目标那一格往上数 height 格，自下而上。
 * 连锁挖掘那几节拿它当一柱相连的方块：摆原木就是树干，摆石头就是石柱。
 */
function columnCells(height: number): BlockCoord[] {
  return Array.from({ length: height }, (_, i) => [TARGET[0], TARGET[1] + i, TARGET[2]]);
}

/** 对准一根 height 格高的原木树干最下面那块的挖掘状态机。 */
function miningTrunk(height: number): {
  world: World;
  cells: BlockCoord[];
  mining: Mining;
  spawned: SpawnedDrop[];
  experience: SpawnedXp[];
} {
  const cells = columnCells(height);
  const logs = cells.map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]);
  const world = worldWith(...logs);
  const drops = dropLog();
  const xp = xpLog();
  return {
    world,
    cells,
    mining: new Mining(world, turntable().aim, BARE, drops.sink, xp.sink, NO_ENTITIES),
    spawned: drops.spawned,
    experience: xp.spawned,
  };
}

/** 树干上还剩下的那些格。 */
function remaining(world: World, cells: BlockCoord[]): BlockCoord[] {
  return cells.filter((cell) => world.getBlock(...cell) !== BlockType.Air);
}

describe('连锁挖掘一次挖掉一整根树干', () => {
  it('按住连锁键挖底部一块，5 块全空、掉出 5 个掉落物与 5 个经验球', () => {
    const { world, cells, mining, spawned, experience } = miningTrunk(5);

    hold(mining, LOG_TICKS, CHAINED);

    expect(remaining(world, cells)).toEqual([]);
    // 每块各掉一个、各给一份经验，落点是它自己那一格
    expect(spawned).toEqual(
      cells.map((at) => ({ stack: { item: ItemType.OakLog, count: 1 }, at })),
    );
    expect(experience).toEqual(cells.map((at) => ({ amount: 60, at })));
  });

  it('连锁耗时等于挖单块：第 59 tick 一块没少，第 60 tick 全没了', () => {
    const { world, cells, mining } = miningTrunk(5);

    hold(mining, LOG_TICKS - 1, CHAINED);
    expect(remaining(world, cells)).toEqual(cells);
    expect(mining.progress).toBeCloseTo((LOG_TICKS - 1) / LOG_TICKS, 10);

    hold(mining, 1, CHAINED);
    expect(remaining(world, cells)).toEqual([]);
  });

  it('不按连锁键就只挖对准的那一块', () => {
    const { world, cells, mining, spawned } = miningTrunk(5);

    hold(mining, LOG_TICKS);

    expect(remaining(world, cells)).toEqual(cells.slice(1));
    expect(spawned).toHaveLength(1);
    expect(mining.chainPreview).toEqual([]);
  });

  it('仅在角上碰着的同种方块跟着碎，紧挨着的异种方块不受影响', () => {
    const corner: BlockCoord = [TARGET[0] + 1, TARGET[1] + 1, TARGET[2] + 1];
    const neighbour: BlockCoord = [TARGET[0] + 1, TARGET[1], TARGET[2]];
    const world = worldWith(
      [TARGET, BlockType.OakLog],
      [corner, BlockType.OakLog],
      [neighbour, BlockType.Dirt],
    );
    const mining = new Mining(world, turntable().aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, LOG_TICKS, CHAINED);

    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(world.getBlock(...corner)).toBe(BlockType.Air);
    expect(world.getBlock(...neighbour)).toBe(BlockType.Dirt);
  });

  it('挖不动的基岩进不了连锁，预览是空的', () => {
    const { world, mining } = miningTowards(BlockType.Bedrock);
    hold(mining, 1000, CHAINED);
    expect(mining.chainPreview).toEqual([]);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Bedrock);
  });
});

describe('连锁挖掘的上限', () => {
  it('70 块连通的原木只挖掉 64 块，剩下的是离起点最远的那 6 块', () => {
    const { world, cells, mining, spawned, experience } = miningTrunk(70);

    hold(mining, LOG_TICKS, CHAINED);

    expect(remaining(world, cells)).toEqual(cells.slice(CHAIN_MINING_LIMIT));
    expect(spawned).toHaveLength(CHAIN_MINING_LIMIT);
    expect(experience).toHaveLength(CHAIN_MINING_LIMIT);
  });
});

describe('连锁状态在开始挖掘那一 tick 判定', () => {
  it('中途松开连锁键：只挖单块，已积累的进度不丢', () => {
    const { world, cells, mining, spawned } = miningTrunk(5);

    hold(mining, 30, CHAINED);
    expect(mining.chainPreview).toHaveLength(5);

    // 松开连锁键，预览随即消失
    hold(mining, 1);
    expect(mining.chainPreview).toEqual([]);

    // 进度留着：这一块一共只挖了 60 tick 就碎，而且只碎它自己
    hold(mining, LOG_TICKS - 32);
    expect(remaining(world, cells)).toEqual(cells);
    hold(mining, 1);
    expect(remaining(world, cells)).toEqual(cells.slice(1));
    expect(spawned).toHaveLength(1);
  });

  it('松开连锁键之后再按回来也不算数', () => {
    const { world, cells, mining } = miningTrunk(5);

    hold(mining, 30, CHAINED);
    // 松开一 tick 又按回来
    hold(mining, 1);
    hold(mining, LOG_TICKS - 32, CHAINED);
    expect(mining.chainPreview).toEqual([]);

    hold(mining, 1, CHAINED);
    expect(remaining(world, cells)).toEqual(cells.slice(1));
  });

  it('开始挖掘之后再按连锁键不进入连锁', () => {
    const { world, cells, mining } = miningTrunk(5);

    // 第一 tick 没按连锁键
    hold(mining, 1);
    hold(mining, LOG_TICKS - 1, CHAINED);

    expect(mining.chainPreview).toEqual([]);
    expect(remaining(world, cells)).toEqual(cells.slice(1));
  });

  it('松开挖掘键再按下时重新判定：这次按着连锁键，整根树干一起碎', () => {
    const { world, cells, mining } = miningTrunk(5);

    hold(mining, 30);
    mining.step(RELEASED);
    hold(mining, LOG_TICKS, CHAINED);

    expect(remaining(world, cells)).toEqual([]);
  });
});

describe('连锁预览', () => {
  it('每一 tick 都查得到，而且与最终挖掉的那批方块一致', () => {
    const { world, cells, mining } = miningTrunk(5);
    const expected = cells.map(toVec);

    const previews: Vec3[][] = [];
    for (let i = 0; i < LOG_TICKS; i++) {
      mining.step(CHAINED);
      previews.push(mining.chainPreview.map(({ x, y, z }) => ({ x, y, z })));
    }

    // 碎之前的每一 tick 都报同一批方块，起点也在里面
    for (const preview of previews.slice(0, -1)) expect(preview).toEqual(expected);
    // 挖穿那一 tick 之后没有预览了：那些方块已经不在世界里
    expect(previews.at(-1)).toEqual([]);
    expect(remaining(world, cells)).toEqual([]);
  });

  it('目标一换就重新算：转向另一根树干，预览跟着换', () => {
    const other: BlockCoord = [0, LAYER_Y, 3];
    const world = worldWith(
      ...columnCells(3).map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]),
      [other, BlockType.OakLog],
    );
    const table = turntable();
    const mining = new Mining(world, table.aim, BARE, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, 1, CHAINED);
    expect(mining.chainPreview).toEqual(columnCells(3).map(toVec));

    table.look(LOOK_Z);
    hold(mining, 1, CHAINED);
    expect(mining.chainPreview).toEqual([toVec(other)]);
  });

  it('松开挖掘键预览就没了', () => {
    const { mining } = miningTrunk(5);
    hold(mining, 10, CHAINED);
    expect(mining.chainPreview).toHaveLength(5);

    mining.step(RELEASED);
    expect(mining.chainPreview).toEqual([]);
  });
});

describe('手持工具挖掘：耗时按工具算，掉落看工具类别', () => {
  it('持木镐挖石头第 22 tick 仍在，第 23 tick 变空气、掉 1 个圆石、给 30 点经验', () => {
    const { world, mining, spawned, experience } = miningTowards(
      BlockType.Stone,
      fresh(ItemType.WoodenPickaxe),
    );
    hold(mining, 22);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    expect(mining.progress).toBeCloseTo(22 / 23, 10);

    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.Cobblestone, count: 1 }, at: TARGET }]);
    expect(experience).toEqual([{ amount: 30, at: TARGET }]);
  });

  it('空手挖石头仍是 150 tick，什么都不掉', () => {
    const { world, mining, spawned } = miningTowards(BlockType.Stone);
    hold(mining, 149);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([]);
  });

  it('持木铲挖泥土 8 tick', () => {
    const { world, mining } = miningTowards(BlockType.Dirt, fresh(ItemType.WoodenShovel));
    hold(mining, 7);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('持木铲挖原木 60 tick：拿错工具与空手一样慢', () => {
    const { world, mining } = miningTowards(BlockType.OakLog, fresh(ItemType.WoodenShovel));
    hold(mining, 59);
    expect(world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('持木斧挖原木 30 tick，掉的仍是原木', () => {
    const { world, mining, spawned } = miningTowards(BlockType.OakLog, fresh(ItemType.WoodenAxe));
    hold(mining, 29);
    expect(world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.OakLog, count: 1 }, at: TARGET }]);
  });

  it('空手挖圆石 200 tick 什么都不掉，持木镐 30 tick 掉圆石', () => {
    const bare = miningTowards(BlockType.Cobblestone);
    hold(bare.mining, 199);
    expect(bare.world.getBlock(...TARGET)).toBe(BlockType.Cobblestone);
    hold(bare.mining, 1);
    expect(bare.world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(bare.spawned).toEqual([]);

    const picked = miningTowards(BlockType.Cobblestone, fresh(ItemType.WoodenPickaxe));
    hold(picked.mining, 30);
    expect(picked.world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(picked.spawned).toEqual([
      { stack: { item: ItemType.Cobblestone, count: 1 }, at: TARGET },
    ]);
  });

  it('持石镐挖石头 12 tick，掉的仍是圆石：木镐要 23 tick（issue #23）', () => {
    const { world, mining, spawned } = miningTowards(
      BlockType.Stone,
      fresh(ItemType.StonePickaxe),
    );
    hold(mining, 11);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.Cobblestone, count: 1 }, at: TARGET }]);
  });

  it('持石斧挖原木 15 tick', () => {
    const { world, mining } = miningTowards(BlockType.OakLog, fresh(ItemType.StoneAxe));
    hold(mining, 14);
    expect(world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('持石铲挖泥土 4 tick，持石铲挖原木仍是 60 tick：拿错工具照样慢', () => {
    const dug = miningTowards(BlockType.Dirt, fresh(ItemType.StoneShovel));
    hold(dug.mining, 3);
    expect(dug.world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(dug.mining, 1);
    expect(dug.world.getBlock(...TARGET)).toBe(BlockType.Air);

    const wrong = miningTowards(BlockType.OakLog, fresh(ItemType.StoneShovel));
    hold(wrong.mining, 59);
    expect(wrong.world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(wrong.mining, 1);
    expect(wrong.world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('拿着泥土挖与空手一样：石头 150 tick 且不掉东西', () => {
    const { world, mining, spawned } = miningTowards(BlockType.Stone, {
      item: ItemType.Dirt,
      count: 5,
    });
    hold(mining, 150);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([]);
  });
});

describe('挖掘中途换手上的工具', () => {
  it('从空手换到木镐：进度不归零，剩余耗时按木镐算', () => {
    const { world, mining, hand } = miningTowards(BlockType.Stone);
    hold(mining, 10);
    expect(mining.progress).toBeCloseTo(10 / 150, 10);

    // 换选中格不换目标：已经挖的 10 tick 留着，木镐一共只要 23 tick
    hand.setSlot(0, fresh(ItemType.WoodenPickaxe));
    hold(mining, 1);
    expect(mining.progress).toBeCloseTo(11 / 23, 10);
    hold(mining, 11);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('从木镐换回空手：进度按空手的 150 tick 重算，一共 150 tick 才碎', () => {
    const { world, mining, hand } = miningTowards(BlockType.Stone, fresh(ItemType.WoodenPickaxe));
    hold(mining, 20);
    hand.setSlot(0, undefined);
    hold(mining, 1);
    expect(mining.progress).toBeCloseTo(21 / 150, 10);
    hold(mining, 128);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('已挖的 tick 数超过新工具的耗时：空手挖 30 tick 再换木镐，下一 tick 就碎', () => {
    const { world, mining, hand } = miningTowards(BlockType.Stone);
    hold(mining, 30);
    hand.setSlot(0, fresh(ItemType.WoodenPickaxe));
    // 换上木镐后的第一 tick：31 ≥ 23，当场挖穿；进度不会超过 1
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(mining.progress).toBe(0);
  });

  it('挖穿那一 tick 拿的是什么就按什么掉：最后一 tick 才换上木镐，石头掉圆石', () => {
    const { world, mining, hand, spawned } = miningTowards(BlockType.Stone);
    hold(mining, 149);
    hand.setSlot(0, fresh(ItemType.WoodenPickaxe));
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.Cobblestone, count: 1 }, at: TARGET }]);
  });
});

describe('手持工具挖穿方块损耗耐久', () => {
  it('挖一块泥土后木铲损耗 1 点', () => {
    const { mining, hand } = miningTowards(BlockType.Dirt, fresh(ItemType.WoodenShovel));
    hold(mining, 7);
    // 还没挖穿，一点都不损耗
    expect(hand.held).toEqual(fresh(ItemType.WoodenShovel));
    hold(mining, 1);
    expect(hand.held).toEqual({ item: ItemType.WoodenShovel, count: 1, damage: 1 });
  });

  it('持镐挖泥土同样损耗 1 点：不看是不是合格工具', () => {
    const { mining, hand } = miningTowards(BlockType.Dirt, fresh(ItemType.WoodenPickaxe));
    hold(mining, 15);
    expect(hand.held).toEqual({ item: ItemType.WoodenPickaxe, count: 1, damage: 1 });
  });

  it('挖 59 块泥土后木铲消失，选中格为空', () => {
    const { world, mining, hand } = miningTowards(BlockType.Dirt, fresh(ItemType.WoodenShovel));
    // 每挖穿一块就在原地再摆一块：一直对着同一格挖满 59 块
    for (let dug = 0; dug < 58; dug++) {
      hold(mining, 8);
      expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
      world.setBlock(...TARGET, BlockType.Dirt);
    }
    expect(hand.held).toEqual({ item: ItemType.WoodenShovel, count: 1, damage: 58 });

    hold(mining, 8);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(hand.held).toBeUndefined();
    expect(hand.slot(0)).toBeUndefined();
  });

  it('连锁挖掘按块数结算：持木斧连锁挖 5 块树干损耗 5 点，一次扣完', () => {
    const cells = columnCells(5);
    const world = worldWith(...cells.map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]));
    const hand = handHolding(fresh(ItemType.WoodenAxe));
    const mining = new Mining(world, turntable().aim, hand, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    // 持木斧 30 tick 挖穿：第 29 tick 一点都没损耗，第 30 tick 5 块全碎、一次损耗 5 点
    hold(mining, 29, CHAINED);
    expect(hand.held).toEqual(fresh(ItemType.WoodenAxe));
    hold(mining, 1, CHAINED);
    expect(remaining(world, cells)).toEqual([]);
    expect(hand.held).toEqual({ item: ItemType.WoodenAxe, count: 1, damage: 5 });
  });

  it('空手与拿着材料挖不涉及耐久：泥土那一堆一个都不少', () => {
    const { mining, hand } = miningTowards(BlockType.Grass, { item: ItemType.Dirt, count: 5 });
    hold(mining, 18);
    expect(hand.held).toEqual({ item: ItemType.Dirt, count: 5 });
  });

  it('挖不动的基岩不损耗耐久', () => {
    const { mining, hand } = miningTowards(BlockType.Bedrock, fresh(ItemType.WoodenPickaxe));
    hold(mining, 1000);
    expect(hand.held).toEqual(fresh(ItemType.WoodenPickaxe));
  });
});

describe('挖矿石（issue #31）', () => {
  /**
   * issue #31 给的耗时与掉落。写死字面值：持木镐挖煤矿石 45 tick，持石镐挖铁矿石 23 tick，
   * 持木镐挖铁矿石按需要工具那一档 300 tick。
   */
  const WOODEN_PICKAXE_COAL_TICKS = 45;
  const STONE_PICKAXE_IRON_TICKS = 23;
  const UNQUALIFIED_ORE_TICKS = 300;

  it('持木镐挖煤矿石 45 tick 碎：掉 1 个煤炭、给 90 经验', () => {
    const { world, mining, spawned, experience } = miningTowards(BlockType.CoalOre, fresh(ItemType.WoodenPickaxe));

    hold(mining, WOODEN_PICKAXE_COAL_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.CoalOre);
    hold(mining, 1);

    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.Coal, count: 1 }, at: TARGET }]);
    expect(experience).toEqual([{ amount: 90, at: TARGET }]);
  });

  it('持石镐挖铁矿石 23 tick 碎：掉 1 个粗铁、给 120 经验', () => {
    const { world, mining, spawned, experience } = miningTowards(BlockType.IronOre, fresh(ItemType.StonePickaxe));

    hold(mining, STONE_PICKAXE_IRON_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.IronOre);
    hold(mining, 1);

    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.RawIron, count: 1 }, at: TARGET }]);
    expect(experience).toEqual([{ amount: 120, at: TARGET }]);
  });

  it('持木镐挖铁矿石：300 tick 才碎，什么都不掉，经验照给，木镐照样损耗 1 点', () => {
    const { world, mining, hand, spawned, experience } = miningTowards(BlockType.IronOre, fresh(ItemType.WoodenPickaxe));

    hold(mining, UNQUALIFIED_ORE_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.IronOre);
    hold(mining, 1);

    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([]);
    expect(experience).toEqual([{ amount: 120, at: TARGET }]);
    expect(hand.held).toEqual(worn(ItemType.WoodenPickaxe, 1));
  });

  it('空手挖两种矿石都是 300 tick、什么都不掉', () => {
    for (const block of [BlockType.CoalOre, BlockType.IronOre]) {
      const { world, mining, spawned } = miningTowards(block);
      hold(mining, UNQUALIFIED_ORE_TICKS - 1);
      expect(world.getBlock(...TARGET), `方块 ${block}`).toBe(block);
      hold(mining, 1);
      expect(world.getBlock(...TARGET), `方块 ${block}`).toBe(BlockType.Air);
      expect(spawned, `方块 ${block}`).toEqual([]);
    }
  });

  it('持石镐连锁挖一团 5 块铁矿石：掉 5 个粗铁、给 5 份经验、石镐损耗 5 点', () => {
    // 一团：目标那一格加上它前后左右与上面那一格，26 向连通
    const cluster: BlockCoord[] = [
      TARGET,
      [TARGET[0] + 1, TARGET[1], TARGET[2]],
      [TARGET[0] + 1, TARGET[1] + 1, TARGET[2]],
      [TARGET[0], TARGET[1], TARGET[2] + 1],
      [TARGET[0] + 2, TARGET[1] + 1, TARGET[2] + 1],
    ];
    const world = worldWith(...cluster.map((cell) => [cell, BlockType.IronOre] as [BlockCoord, BlockType]));
    const drops = dropLog();
    const xp = xpLog();
    const hand = handHolding(fresh(ItemType.StonePickaxe));
    const mining = new Mining(world, turntable().aim, hand, drops.sink, xp.sink, NO_ENTITIES);

    hold(mining, STONE_PICKAXE_IRON_TICKS, CHAINED);

    expect(remaining(world, cluster)).toEqual([]);
    const rawIron = drops.spawned.filter(({ stack }) => stack.item === ItemType.RawIron && stack.count === 1);
    expect(rawIron).toHaveLength(5);
    expect(rawIron.map(({ at }) => at).sort()).toEqual([...cluster].sort());
    expect(xp.spawned.map(({ amount }) => amount)).toEqual([120, 120, 120, 120, 120]);
    expect(hand.held).toEqual(worn(ItemType.StonePickaxe, 5));
  });
});

describe('铁制工具（issue #32）', () => {
  /**
   * issue #32 给的关键数值，直接写字面值：倍率 6，石头 8、矿石 15、原木 10、泥土 3 tick；
   * 铁铲挖原木不是合格工具，与空手一样 60 tick。满耐久 250。
   */
  const IRON_PICKAXE_STONE_TICKS = 8;
  const IRON_PICKAXE_ORE_TICKS = 15;
  const IRON_AXE_LOG_TICKS = 10;
  const IRON_SHOVEL_DIRT_TICKS = 3;
  const IRON_DURABILITY = 250;

  it('持铁镐挖石头第 7 tick 仍在，第 8 tick 碎、掉 1 个圆石', () => {
    const { world, mining, spawned } = miningTowards(BlockType.Stone, fresh(ItemType.IronPickaxe));
    hold(mining, IRON_PICKAXE_STONE_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.Cobblestone, count: 1 }, at: TARGET }]);
  });

  it('持铁镐挖铁矿石 15 tick 碎、掉 1 个粗铁：铁档高于石也合格', () => {
    const { world, mining, spawned, experience } = miningTowards(BlockType.IronOre, fresh(ItemType.IronPickaxe));
    hold(mining, IRON_PICKAXE_ORE_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.IronOre);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([{ stack: { item: ItemType.RawIron, count: 1 }, at: TARGET }]);
    expect(experience).toEqual([{ amount: 120, at: TARGET }]);
  });

  it('持铁斧挖原木 10 tick', () => {
    const { world, mining } = miningTowards(BlockType.OakLog, fresh(ItemType.IronAxe));
    hold(mining, IRON_AXE_LOG_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('持铁铲挖泥土 3 tick，挖原木 60 tick：拿错工具与空手一样慢', () => {
    const dug = miningTowards(BlockType.Dirt, fresh(ItemType.IronShovel));
    hold(dug.mining, IRON_SHOVEL_DIRT_TICKS - 1);
    expect(dug.world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(dug.mining, 1);
    expect(dug.world.getBlock(...TARGET)).toBe(BlockType.Air);

    const wrong = miningTowards(BlockType.OakLog, fresh(ItemType.IronShovel));
    hold(wrong.mining, LOG_TICKS - 1);
    expect(wrong.world.getBlock(...TARGET)).toBe(BlockType.OakLog);
    hold(wrong.mining, 1);
    expect(wrong.world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('铁镐挖 250 块石头后消失：第 249 块之后还剩 1 点，第 250 块挖穿那一 tick 选中格清空', () => {
    const { world, mining, hand } = miningTowards(BlockType.Stone, fresh(ItemType.IronPickaxe));
    // 每挖穿一块就在原地再摆一块：一直对着同一格挖
    for (let dug = 0; dug < IRON_DURABILITY - 1; dug++) {
      hold(mining, IRON_PICKAXE_STONE_TICKS);
      expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
      world.setBlock(...TARGET, BlockType.Stone);
    }
    expect(hand.held).toEqual(worn(ItemType.IronPickaxe, IRON_DURABILITY - 1));

    hold(mining, IRON_PICKAXE_STONE_TICKS);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(hand.held).toBeUndefined();
    expect(hand.slot(0)).toBeUndefined();
  });
});

describe('持剑挖方块（issue #45）', () => {
  /**
   * issue #45 给的数值，写死字面值：剑不是挖掘工具，挖泥土与空手一样 15 tick；挖穿一块损耗 2 点，
   * 不是镐斧铲的 1 点。铁剑满耐久 250，挖 125 块消失。
   */
  const BARE_HAND_DIRT_TICKS = 15;
  const SWORD_WEAR_PER_BLOCK = 2;
  const IRON_DURABILITY = 250;

  it('持木剑挖泥土第 14 tick 仍在、第 15 tick 碎，与空手相同；木剑损耗 2 点', () => {
    const { world, mining, hand, spawned } = miningTowards(BlockType.Dirt, fresh(ItemType.WoodenSword));
    hold(mining, BARE_HAND_DIRT_TICKS - 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    expect(hand.held).toEqual(fresh(ItemType.WoodenSword));
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    // 泥土不需要工具，拿什么挖都掉泥土
    expect(spawned).toEqual([{ stack: { item: ItemType.Dirt, count: 1 }, at: TARGET }]);
    expect(hand.held).toEqual(worn(ItemType.WoodenSword, SWORD_WEAR_PER_BLOCK));
  });

  it('持铁剑挖石头什么都不掉：剑不是合格工具', () => {
    const { world, mining, spawned } = miningTowards(BlockType.Stone, fresh(ItemType.IronSword));
    hold(mining, 150);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(spawned).toEqual([]);
  });

  it('铁剑挖 124 块泥土后还剩 2 点，第 125 块挖穿那一 tick 消失', () => {
    const { world, mining, hand } = miningTowards(BlockType.Dirt, fresh(ItemType.IronSword));
    const blocks = IRON_DURABILITY / SWORD_WEAR_PER_BLOCK;
    for (let dug = 0; dug < blocks - 1; dug++) {
      hold(mining, BARE_HAND_DIRT_TICKS);
      expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
      world.setBlock(...TARGET, BlockType.Dirt);
    }
    expect(hand.held).toEqual(worn(ItemType.IronSword, IRON_DURABILITY - SWORD_WEAR_PER_BLOCK));

    hold(mining, BARE_HAND_DIRT_TICKS);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
    expect(hand.held).toBeUndefined();
    expect(hand.slot(0)).toBeUndefined();
  });

  it('持剑连锁挖 5 块树干：每块 2 点，一次扣 10 点', () => {
    const cells = columnCells(5);
    const world = worldWith(...cells.map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]));
    const hand = handHolding(fresh(ItemType.StoneSword));
    const mining = new Mining(world, turntable().aim, hand, IGNORED_DROPS, IGNORED_XP, NO_ENTITIES);

    hold(mining, LOG_TICKS, CHAINED);
    expect(remaining(world, cells)).toEqual([]);
    expect(hand.held).toEqual(worn(ItemType.StoneSword, 5 * SWORD_WEAR_PER_BLOCK));
  });
});

describe('持工具连锁挖掘一柱相连的石头（issue #23）', () => {
  /** 一柱 height 块相连的石头，手上拿着 `held`，对准最下面那块。 */
  function miningStoneColumn(
    height: number,
    held: ItemStack,
  ): { world: World; cells: BlockCoord[]; mining: Mining; hand: Inventory; spawned: SpawnedDrop[] } {
    const cells = columnCells(height);
    const world = worldWith(
      ...cells.map((cell) => [cell, BlockType.Stone] as [BlockCoord, BlockType]),
    );
    const drops = dropLog();
    const hand = handHolding(held);
    return {
      world,
      cells,
      mining: new Mining(world, turntable().aim, hand, drops.sink, IGNORED_XP, NO_ENTITIES),
      hand,
      spawned: drops.spawned,
    };
  }

  /** 掉出来的圆石各在哪一格。持镐连锁挖石头，每块都在自己那一格掉一个圆石。 */
  function cobblestoneCells(spawned: SpawnedDrop[]): BlockCoord[] {
    return spawned
      .filter(({ stack }) => stack.item === ItemType.Cobblestone && stack.count === 1)
      .map(({ at }) => at);
  }

  it('持木镐连锁挖 64 块相连的石头：掉出 64 个圆石，木镐要损耗 64 点、超过满耐久 59 因此消失', () => {
    const { world, cells, mining, hand, spawned } = miningStoneColumn(
      CHAIN_MINING_LIMIT,
      fresh(ItemType.WoodenPickaxe),
    );

    // 木镐挖石头 23 tick，连锁不改耗时
    hold(mining, 22, CHAINED);
    expect(remaining(world, cells)).toEqual(cells);
    hold(mining, 1, CHAINED);

    expect(remaining(world, cells)).toEqual([]);
    expect(cobblestoneCells(spawned)).toEqual(cells);
    // 满耐久 59 减不掉 64 点：损耗一次结算，木镐当场消失
    expect(hand.held).toBeUndefined();
  });

  it('持石镐连锁挖 64 块石头：石镐满耐久 131，损耗 64 点之后还在手上', () => {
    const { world, cells, mining, hand, spawned } = miningStoneColumn(
      CHAIN_MINING_LIMIT,
      fresh(ItemType.StonePickaxe),
    );

    hold(mining, 12, CHAINED);

    expect(remaining(world, cells)).toEqual([]);
    expect(cobblestoneCells(spawned)).toHaveLength(CHAIN_MINING_LIMIT);
    expect(hand.held).toEqual(worn(ItemType.StonePickaxe, CHAIN_MINING_LIMIT));
  });

  it('连锁的耗时等于持该工具挖单块：持石镐 11 tick 一块没少，第 12 tick 全碎', () => {
    const { world, cells, mining } = miningStoneColumn(20, fresh(ItemType.StonePickaxe));

    hold(mining, 11, CHAINED);
    expect(remaining(world, cells)).toEqual(cells);
    expect(mining.progress).toBeCloseTo(11 / 12, 10);

    hold(mining, 1, CHAINED);
    expect(remaining(world, cells)).toEqual([]);
  });

  it('木镐只剩 10 点耐久时连锁挖 20 块石头：20 块全碎、20 个圆石，工具随后消失', () => {
    const { world, cells, mining, hand, spawned } = miningStoneColumn(
      20,
      worn(ItemType.WoodenPickaxe, 49),
    );

    hold(mining, 23, CHAINED);

    // 耐久不够也把整组全部挖掉（见 GLOSSARY.md 的「连锁挖掘」）
    expect(remaining(world, cells)).toEqual([]);
    expect(cobblestoneCells(spawned)).toEqual(cells);
    expect(hand.held).toBeUndefined();
    expect(hand.slot(0)).toBeUndefined();
  });
});
