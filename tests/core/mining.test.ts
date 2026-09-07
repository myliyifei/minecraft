import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHAIN_MINING_LIMIT } from '../../src/core/chain-mining';
import type { DropSink } from '../../src/core/drop';
import { ItemType, type ItemStack } from '../../src/core/item';
import { Mining, type AimView, type MiningInput } from '../../src/core/mining';
import { PLAYER_REACH } from '../../src/core/player';
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

/** 盯着正前方那块方块的挖掘状态机。 */
function miningTowards(block: BlockType): {
  world: World;
  mining: Mining;
  spawned: SpawnedDrop[];
  experience: SpawnedXp[];
} {
  const world = worldWith([TARGET, block]);
  const drops = dropLog();
  const xp = xpLog();
  return {
    world,
    mining: new Mining(world, turntable().aim, drops.sink, xp.sink),
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
    // 石头要镐，空着手是每点硬度 5 秒而不是 1.5 秒
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
    const mining = new Mining(world, table.aim, IGNORED_DROPS, IGNORED_XP);

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
    const mining = new Mining(world, table.aim, IGNORED_DROPS, IGNORED_XP);

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
    const mining = new Mining(world, table.aim, IGNORED_DROPS, IGNORED_XP);

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
    const mining = new Mining(world, turntable().aim, IGNORED_DROPS, IGNORED_XP);
    hold(mining, 15);
    expect(world.getBlock(...near)).toBe(BlockType.Air);
  });

  it('再远一格就不是目标，按住也挖不动', () => {
    const far: BlockCoord = [REACHABLE_X + 1, LAYER_Y, 0];
    const world = worldWith([far, BlockType.Dirt]);
    const mining = new Mining(world, turntable().aim, IGNORED_DROPS, IGNORED_XP);
    hold(mining, 100);
    expect(mining.target).toBeUndefined();
    expect(mining.progress).toBe(0);
    expect(world.getBlock(...far)).toBe(BlockType.Dirt);
  });

  it('什么都没对准时按住挖掘键不出事', () => {
    const world = flatTestWorld();
    const mining = new Mining(world, turntable(LOOK_EMPTY).aim, IGNORED_DROPS, IGNORED_XP);
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
    const mining = new Mining(world, turntable().aim, sink, IGNORED_XP);

    hold(mining, 30);
    expect(spawned).toEqual([
      { stack: { item: ItemType.Dirt, count: 1 }, at: [2, LAYER_Y, 0] },
      { stack: { item: ItemType.Dirt, count: 1 }, at: TARGET },
    ]);
  });
});

describe('挖穿之后给多少经验', () => {
  /** issue #9 给的经验值：普通方块 3、原木 6。 */
  const EXPERIENCE: Array<[string, BlockType, number, number]> = [
    ['草方块', BlockType.Grass, 18, 3],
    ['泥土', BlockType.Dirt, 15, 3],
    ['原木', BlockType.OakLog, 60, 6],
    ['树叶', BlockType.OakLeaves, 6, 3],
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

  it('空手挖石头什么都拿不到，经验照给 3 点', () => {
    const { mining, spawned, experience } = miningTowards(BlockType.Stone);
    hold(mining, 150);
    expect(spawned).toEqual([]);
    expect(experience).toEqual([{ amount: 3, at: TARGET }]);
  });

  it('挖不动的基岩不给经验', () => {
    const { mining, experience } = miningTowards(BlockType.Bedrock);
    hold(mining, 1000);
    expect(experience).toEqual([]);
  });

  it('连着挖两块，一块一个经验球', () => {
    const world = worldWith([[2, LAYER_Y, 0], BlockType.Dirt], [TARGET, BlockType.Dirt]);
    const { sink, spawned } = xpLog();
    const mining = new Mining(world, turntable().aim, IGNORED_DROPS, sink);

    hold(mining, 30);
    expect(spawned).toEqual([
      { amount: 3, at: [2, LAYER_Y, 0] },
      { amount: 3, at: TARGET },
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
    const mining = new Mining(world, turntable().aim, IGNORED_DROPS, IGNORED_XP);

    hold(mining, 15);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    // 选框不会在这一 tick 里还套着已经没有的方块
    expect(mining.target).toMatchObject({ x: 3 });
    expect(mining.progress).toBe(0);

    hold(mining, 15);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });
});

/** 一格的三元坐标换成 Vec3，好跟预览报出来的坐标对照。 */
function toVec([x, y, z]: BlockCoord): Vec3 {
  return { x, y, z };
}

/** 从目标那一格往上数 height 格，自下而上。连锁挖掘那一节拿它当树干。 */
function trunkCells(height: number): BlockCoord[] {
  return Array.from({ length: height }, (_, i) => [TARGET[0], TARGET[1] + i, TARGET[2]]);
}

/** 盯着一根 height 格高的原木树干最下面那块的挖掘状态机。 */
function miningTrunk(height: number): {
  world: World;
  cells: BlockCoord[];
  mining: Mining;
  spawned: SpawnedDrop[];
  experience: SpawnedXp[];
} {
  const cells = trunkCells(height);
  const logs = cells.map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]);
  const world = worldWith(...logs);
  const drops = dropLog();
  const xp = xpLog();
  return {
    world,
    cells,
    mining: new Mining(world, turntable().aim, drops.sink, xp.sink),
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
    expect(experience).toEqual(cells.map((at) => ({ amount: 6, at })));
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
    const mining = new Mining(world, turntable().aim, IGNORED_DROPS, IGNORED_XP);

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
      ...trunkCells(3).map((cell) => [cell, BlockType.OakLog] as [BlockCoord, BlockType]),
      [other, BlockType.OakLog],
    );
    const table = turntable();
    const mining = new Mining(world, table.aim, IGNORED_DROPS, IGNORED_XP);

    hold(mining, 1, CHAINED);
    expect(mining.chainPreview).toEqual(trunkCells(3).map(toVec));

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
