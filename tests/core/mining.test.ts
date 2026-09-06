import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Mining, type AimView } from '../../src/core/mining';
import { PLAYER_REACH } from '../../src/core/player';
import type { Vec3 } from '../../src/core/vec3';
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

/** 盯着正前方那块方块的挖掘状态机。 */
function miningTowards(block: BlockType): { world: World; mining: Mining } {
  const world = worldWith([TARGET, block]);
  return { world, mining: new Mining(world, turntable().aim) };
}

/** 按住挖掘键推进 n 个 tick。 */
function hold(mining: Mining, ticks: number): void {
  for (let i = 0; i < ticks; i++) mining.step(true);
}

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
    const mining = new Mining(world, table.aim);

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
    const mining = new Mining(world, table.aim);

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

    mining.step(false);
    expect(mining.progress).toBe(0);

    hold(mining, 14);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
    hold(mining, 1);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });

  it('只是瞄着不按键，进度一直是 0', () => {
    const { world, mining } = miningTowards(BlockType.Dirt);
    for (let i = 0; i < 100; i++) mining.step(false);
    expect(mining.progress).toBe(0);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Dirt);
  });

  it('换的只是命中面而不是方块时，进度接着走', () => {
    // 同一块方块，一条视线从它的顶面进、一条从 −X 面进
    const block: BlockCoord = [2, LAYER_Y - 1, 0];
    const world = worldWith([block, BlockType.Dirt]);
    const table = turntable(unit({ x: 1, y: -0.25, z: 0 }));
    const mining = new Mining(world, table.aim);

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
    const mining = new Mining(world, turntable().aim);
    hold(mining, 15);
    expect(world.getBlock(...near)).toBe(BlockType.Air);
  });

  it('再远一格就不是目标，按住也挖不动', () => {
    const far: BlockCoord = [REACHABLE_X + 1, LAYER_Y, 0];
    const world = worldWith([far, BlockType.Dirt]);
    const mining = new Mining(world, turntable().aim);
    hold(mining, 100);
    expect(mining.target).toBeUndefined();
    expect(mining.progress).toBe(0);
    expect(world.getBlock(...far)).toBe(BlockType.Dirt);
  });

  it('什么都没对准时按住挖掘键不出事', () => {
    const world = flatTestWorld();
    const mining = new Mining(world, turntable(LOOK_EMPTY).aim);
    hold(mining, 100);
    expect(mining.target).toBeUndefined();
    expect(mining.progress).toBe(0);
  });
});

describe('挖掘的目标查询', () => {
  it('目标报出方块坐标、命中面与到进入面的距离', () => {
    const { mining } = miningTowards(BlockType.Dirt);
    // 还没 tick 过，什么都没瞄
    expect(mining.target).toBeUndefined();

    mining.step(false);
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
    const mining = new Mining(world, turntable().aim);

    hold(mining, 15);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    // 选框不会在这一 tick 里还套着已经没有的方块
    expect(mining.target).toMatchObject({ x: 3 });
    expect(mining.progress).toBe(0);

    hold(mining, 15);
    expect(world.getBlock(...TARGET)).toBe(BlockType.Air);
  });
});
