import { describe, expect, it } from 'vitest';
import { BlockStateKind, BlockType } from '../../src/core/block';
import {
  blockStateContents,
  initialBlockState,
  newFurnaceState,
} from '../../src/core/block-state';
import { ItemType } from '../../src/core/item';

describe('熔炉的方块状态（issue #30）', () => {
  it('新建的状态三格都空、燃料与进度全是 0、没有待结算经验', () => {
    expect(newFurnaceState()).toEqual({
      kind: BlockStateKind.Furnace,
      input: undefined,
      fuel: undefined,
      output: undefined,
      burnTicksLeft: 0,
      burnTicksTotal: 0,
      smeltProgress: 0,
      pendingExperience: 0,
    });
  });

  it('每次新建都是一份新的：改一份不影响另一份', () => {
    const a = newFurnaceState();
    const b = newFurnaceState();
    a.input = { item: ItemType.Cobblestone, count: 3 };
    expect(b.input).toBeUndefined();
  });

  it('两个编号的熔炉刚放下时都拿到一份空的熔炉状态，其余方块没有状态', () => {
    expect(initialBlockState(BlockType.Furnace)).toEqual(newFurnaceState());
    expect(initialBlockState(BlockType.LitFurnace)).toEqual(newFurnaceState());
    for (const block of Object.values(BlockType)) {
      if (block === BlockType.Furnace || block === BlockType.LitFurnace) continue;
      expect(initialBlockState(block), `方块 ${block}`).toBeUndefined();
    }
  });
});

describe('方块状态里装着的物品', () => {
  it('空状态里一样东西都没有', () => {
    expect(blockStateContents(newFurnaceState())).toEqual([]);
  });

  it('三格里非空的那几堆按原料、燃料、成品的顺序给出，空格跳过', () => {
    const state = newFurnaceState();
    state.input = { item: ItemType.Cobblestone, count: 3 };
    state.output = { item: ItemType.Dirt, count: 4 };
    expect(blockStateContents(state)).toEqual([
      { item: ItemType.Cobblestone, count: 3 },
      { item: ItemType.Dirt, count: 4 },
    ]);
  });

  it('给出的是格里那一堆本身：工具的损耗跟着走', () => {
    const state = newFurnaceState();
    state.fuel = { item: ItemType.WoodenPickaxe, count: 1, damage: 7 };
    expect(blockStateContents(state)).toEqual([{ item: ItemType.WoodenPickaxe, count: 1, damage: 7 }]);
  });
});
