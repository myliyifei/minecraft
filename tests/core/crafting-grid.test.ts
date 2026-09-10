import { describe, expect, it } from 'vitest';
import { CraftingGrid, INVENTORY_CRAFTING_GRID } from '../../src/core/crafting-grid';
import { ItemType, type ItemStack } from '../../src/core/item';

function logs(count: number): ItemStack {
  return { item: ItemType.OakLog, count };
}

function dirt(count: number): ItemStack {
  return { item: ItemType.Dirt, count };
}

const PLANKS_X4 = { item: ItemType.OakPlanks, count: 4 };

describe('合成网格是一批可逐格读写的格子', () => {
  it('背包界面那块是 2x2，共 4 格，新建时全空', () => {
    const grid = new CraftingGrid(INVENTORY_CRAFTING_GRID);
    expect(grid.width).toBe(2);
    expect(grid.height).toBe(2);
    expect(grid.size).toBe(4);
    for (let i = 0; i < grid.size; i++) expect(grid.slot(i)).toBeUndefined();
  });

  it('写进一格再读出来', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(3, logs(5));
    expect(grid.slot(3)).toEqual(logs(5));
    grid.setSlot(3, undefined);
    expect(grid.slot(3)).toBeUndefined();
  });

  it('指不到格子的下标什么都不写、读出来是 undefined', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(4, logs(1));
    grid.setSlot(-1, logs(1));
    grid.setSlot(1.5, logs(1));
    grid.setSlot(Number.NaN, logs(1));
    expect(grid.size).toBe(4);
    expect(grid.slot(4)).toBeUndefined();
    for (let i = 0; i < grid.size; i++) expect(grid.slot(i)).toBeUndefined();
  });
});

describe('输出格按网格里摆的东西给出成品', () => {
  it('空网格的输出格是空的', () => {
    expect(new CraftingGrid({ width: 2, height: 2 }).output).toBeUndefined();
  });

  it('摆进一个原木，输出格显示 4 块木板', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(2, logs(1));
    expect(grid.output).toEqual(PLANKS_X4);
  });

  it('一格里摆几个原木，输出格仍是一份成品', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(0, logs(10));
    expect(grid.output).toEqual(PLANKS_X4);
  });

  it('不匹配任何配方时输出格是空的', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(0, logs(1));
    grid.setSlot(1, dirt(1));
    expect(grid.output).toBeUndefined();
  });

  it('拿走材料之后输出格跟着变空', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(0, logs(1));
    grid.setSlot(0, undefined);
    expect(grid.output).toBeUndefined();
  });
});

describe('合成一份：每个非空格各减 1', () => {
  it('只有 1 个的那一格清空', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(0, logs(1));
    grid.consumeOne();
    expect(grid.slot(0)).toBeUndefined();
    expect(grid.output).toBeUndefined();
  });

  it('还有剩的那一格减 1，输出格按剩下的材料重算', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(1, logs(3));
    grid.consumeOne();
    expect(grid.slot(1)).toEqual(logs(2));
    expect(grid.output).toEqual(PLANKS_X4);
  });

  it('几格都摆了东西时每格各减 1，空格不动', () => {
    const grid = new CraftingGrid({ width: 2, height: 2 });
    grid.setSlot(0, logs(2));
    grid.setSlot(3, dirt(1));
    grid.consumeOne();
    expect(grid.slot(0)).toEqual(logs(1));
    expect(grid.slot(1)).toBeUndefined();
    expect(grid.slot(2)).toBeUndefined();
    expect(grid.slot(3)).toBeUndefined();
  });
});
