import { describe, expect, it } from 'vitest';
import { ItemType } from '../../src/core/item';
import {
  burnTicksOf,
  FUEL_BURN_TICKS,
  isFuel,
  isSmeltable,
  SMELTING_RECIPES,
  smeltingRecipe,
} from '../../src/core/smelting';

const ALL_ITEMS: readonly ItemType[] = Object.values(ItemType);

describe('燃料表（issue #33、#34）', () => {
  it('煤炭、木炭、三种原木、三种木板、木棍是燃料，其余都不是（白桦与云杉见 #85）', () => {
    const fuels = new Set<ItemType>([
      ItemType.Coal,
      ItemType.Charcoal,
      ItemType.OakLog,
      ItemType.OakPlanks,
      ItemType.BirchLog,
      ItemType.BirchPlanks,
      ItemType.SpruceLog,
      ItemType.SprucePlanks,
      ItemType.Stick,
    ]);
    for (const item of ALL_ITEMS) {
      expect(isFuel(item), `物品 ${item}`).toBe(fuels.has(item));
    }
  });

  it('燃烧时长与原版一致：煤炭与木炭 1600 tick、原木与木板 300 tick、木棍 100 tick', () => {
    expect(FUEL_BURN_TICKS).toEqual({
      [ItemType.Coal]: 1600,
      [ItemType.Charcoal]: 1600,
      [ItemType.OakLog]: 300,
      [ItemType.OakPlanks]: 300,
      [ItemType.BirchLog]: 300,
      [ItemType.BirchPlanks]: 300,
      [ItemType.SpruceLog]: 300,
      [ItemType.SprucePlanks]: 300,
      [ItemType.Stick]: 100,
    });
    expect(burnTicksOf(ItemType.Charcoal)).toBe(1600);
    expect(burnTicksOf(ItemType.Cobblestone)).toBeUndefined();
  });

  it('工作台与木制工具不是燃料', () => {
    expect(isFuel(ItemType.CraftingTable)).toBe(false);
    expect(isFuel(ItemType.WoodenPickaxe)).toBe(false);
    expect(isFuel(ItemType.WoodenAxe)).toBe(false);
    expect(isFuel(ItemType.WoodenShovel)).toBe(false);
  });
});

describe('熔炼配方表（issue #33、#34）', () => {
  it('粗铁炼出铁锭、每件 7 点经验；三种原木炼出木炭、每件 2 点经验；只有这四条', () => {
    expect(SMELTING_RECIPES).toEqual({
      [ItemType.RawIron]: { result: ItemType.IronIngot, experience: 7 },
      [ItemType.OakLog]: { result: ItemType.Charcoal, experience: 2 },
      [ItemType.BirchLog]: { result: ItemType.Charcoal, experience: 2 },
      [ItemType.SpruceLog]: { result: ItemType.Charcoal, experience: 2 },
    });
    expect(smeltingRecipe(ItemType.Cobblestone)).toBeUndefined();
  });

  it('粗铁与三种原木能熔炼，其余都不能', () => {
    const smeltable = new Set<ItemType>([
      ItemType.RawIron,
      ItemType.OakLog,
      ItemType.BirchLog,
      ItemType.SpruceLog,
    ]);
    for (const item of ALL_ITEMS) {
      expect(isSmeltable(item), `物品 ${item}`).toBe(smeltable.has(item));
    }
  });

  it('橡木原木既是原料也是燃料', () => {
    expect(isSmeltable(ItemType.OakLog)).toBe(true);
    expect(isFuel(ItemType.OakLog)).toBe(true);
  });
});
