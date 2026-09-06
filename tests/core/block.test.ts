import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BlockType,
  UNBREAKABLE,
  blockDrop,
  blockExperience,
  isBreakable,
  miningTicks,
} from '../../src/core/block';
import { ItemType } from '../../src/core/item';

/**
 * issue #7 给的硬度与空手耗时，全部写死字面值。
 *
 * 不从 `BLOCKS` 反算耗时：右边一旦是「硬度 × 1.5 × 20」，就是拿实现的式子比它自己，
 * 硬度写错也照样通过。这张表是需求那一侧的数字，两列必须各自对得上。
 */
const HAND_MINING: Array<[string, BlockType, number, number]> = [
  ['草方块', BlockType.Grass, 0.6, 18],
  ['泥土', BlockType.Dirt, 0.5, 15],
  // 石头要镐，空着手是每点硬度 5 秒而不是 1.5 秒——按 1.5 算会是 45 tick
  ['石头', BlockType.Stone, 1.5, 150],
  ['原木', BlockType.OakLog, 2, 60],
  ['树叶', BlockType.OakLeaves, 0.2, 6],
];

describe('方块的硬度表', () => {
  it('硬度与空手耗时就是 issue #7 给的那两列', () => {
    for (const [name, block, hardness, ticks] of HAND_MINING) {
      expect(BLOCKS[block].hardness, `${name}的硬度`).toBe(hardness);
      expect(miningTicks(block), `${name}的耗时`).toBe(ticks);
    }
  });

  it('除空气外每种方块都有正的硬度', () => {
    for (const block of Object.values(BlockType)) {
      const { hardness } = BLOCKS[block];
      if (block === BlockType.Air) {
        expect(hardness).toBe(0);
      } else {
        expect(hardness, `方块 ${block} 的硬度`).toBeGreaterThan(0);
      }
    }
  });

  it('只有基岩挖不动', () => {
    for (const block of Object.values(BlockType)) {
      const unbreakable = BLOCKS[block].hardness === UNBREAKABLE;
      expect(unbreakable, `方块 ${block}`).toBe(block === BlockType.Bedrock);
    }
  });

  it('空气与基岩挖不动，其余都挖得动', () => {
    expect(isBreakable(BlockType.Air)).toBe(false);
    expect(isBreakable(BlockType.Bedrock)).toBe(false);
    expect(isBreakable(BlockType.Grass)).toBe(true);
    expect(isBreakable(BlockType.Stone)).toBe(true);
    expect(isBreakable(BlockType.OakLeaves)).toBe(true);
  });

  it('本切片只有石头需要工具', () => {
    for (const block of Object.values(BlockType)) {
      expect(BLOCKS[block].requiresTool, `方块 ${block}`).toBe(block === BlockType.Stone);
    }
  });
});

describe('空手挖掘的掉落表', () => {
  /**
   * issue #8 给的掉落表，`null` 是「什么都不掉」。
   * 与硬度那张表一样写死字面值，不从 `BLOCKS` 反读。
   */
  const HAND_DROPS: Array<[string, BlockType, ItemType | null]> = [
    ['草方块掉泥土', BlockType.Grass, ItemType.Dirt],
    ['泥土掉泥土', BlockType.Dirt, ItemType.Dirt],
    ['橡木原木掉原木', BlockType.OakLog, ItemType.OakLog],
    ['树叶什么都不掉', BlockType.OakLeaves, null],
    // 石头要镐，空着手挖掉了也拿不到东西
    ['空手挖石头什么都不掉', BlockType.Stone, null],
    ['基岩什么都不掉', BlockType.Bedrock, null],
  ];

  for (const [name, block, item] of HAND_DROPS) {
    it(name, () => {
      const drop = blockDrop(block);
      if (item === null) {
        expect(drop).toBeNull();
      } else {
        expect(drop).toEqual({ item, count: 1 });
      }
    });
  }

  it('空气不掉东西', () => {
    expect(blockDrop(BlockType.Air)).toBeNull();
  });

  it('掉落表里每一堆都至少有一个', () => {
    for (const block of Object.values(BlockType)) {
      const drop = BLOCKS[block].drop;
      if (drop) expect(drop.count, `方块 ${block}`).toBeGreaterThan(0);
    }
  });
});

describe('挖掉一块给多少经验', () => {
  /**
   * issue #9 给的经验表：普通方块 3、原木 6。同样写死字面值，不从 `BLOCKS` 反读。
   * 矿石那几档（煤 9 到钻石 24，见 docs/design-decisions.md）等有矿石了再往这里加行。
   */
  const EXPERIENCE: Array<[string, BlockType, number]> = [
    ['草方块', BlockType.Grass, 3],
    ['泥土', BlockType.Dirt, 3],
    ['石头', BlockType.Stone, 3],
    ['树叶', BlockType.OakLeaves, 3],
    ['原木', BlockType.OakLog, 6],
  ];

  for (const [name, block, amount] of EXPERIENCE) {
    it(`${name}给 ${amount} 点`, () => {
      expect(blockExperience(block)).toBe(amount);
    });
  }

  it('空气与基岩不给经验：一个不是挖掘目标，一个挖不动', () => {
    expect(blockExperience(BlockType.Air)).toBe(0);
    expect(blockExperience(BlockType.Bedrock)).toBe(0);
  });

  it('经验与掉落各算各的：空手挖石头没有掉落，经验照给', () => {
    expect(blockDrop(BlockType.Stone)).toBeNull();
    expect(blockExperience(BlockType.Stone)).toBeGreaterThan(0);
    // 树叶同理
    expect(blockDrop(BlockType.OakLeaves)).toBeNull();
    expect(blockExperience(BlockType.OakLeaves)).toBeGreaterThan(0);
  });

  it('挖得动的方块都给正的经验', () => {
    for (const block of Object.values(BlockType)) {
      if (!isBreakable(block)) continue;
      expect(blockExperience(block), `方块 ${block}`).toBeGreaterThan(0);
    }
  });
});

describe('硬度换算成挖掘耗时', () => {
  it('耗时与硬度成正比', () => {
    // 原木硬度 2，泥土 0.5，两者都不需要工具，耗时之比就该是 4：这一条不看具体秒数，
    // 只看那个乘法关系确实在起作用
    expect(miningTicks(BlockType.OakLog)).toBe(4 * miningTicks(BlockType.Dirt));
  });

  it('耗时是整数个 tick，且不因浮点噪声多算一个', () => {
    // 0.2 × 1.5 × 20 在二进制里是 6.000000000000001，天真的向上取整会给出 7
    expect(miningTicks(BlockType.OakLeaves)).toBe(6);
    for (const block of Object.values(BlockType)) {
      if (block === BlockType.Bedrock) continue;
      expect(Number.isInteger(miningTicks(block)), `方块 ${block}`).toBe(true);
    }
  });

  it('挖不动的方块耗时是无穷', () => {
    expect(miningTicks(BlockType.Bedrock)).toBe(Infinity);
  });
});
