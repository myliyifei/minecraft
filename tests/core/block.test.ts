import { describe, expect, it } from 'vitest';
import { BLOCKS, BlockType, UNBREAKABLE, isBreakable, miningTicks } from '../../src/core/block';

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
