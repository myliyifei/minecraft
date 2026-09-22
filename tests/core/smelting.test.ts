import { describe, expect, it } from 'vitest';
import { ItemType } from '../../src/core/item';
import { FUEL_BURN_TICKS, isFuel, isSmeltable } from '../../src/core/smelting';

const ALL_ITEMS: readonly ItemType[] = Object.values(ItemType);

describe('燃料表（issue #33）', () => {
  it('煤炭、橡木原木、橡木木板、木棍是燃料，其余都不是', () => {
    const fuels = new Set<ItemType>([
      ItemType.Coal,
      ItemType.OakLog,
      ItemType.OakPlanks,
      ItemType.Stick,
    ]);
    for (const item of ALL_ITEMS) {
      expect(isFuel(item), `物品 ${item}`).toBe(fuels.has(item));
    }
  });

  it('燃烧时长与原版一致：煤炭 1600 tick、原木与木板 300 tick、木棍 100 tick', () => {
    expect(FUEL_BURN_TICKS).toEqual({
      [ItemType.Coal]: 1600,
      [ItemType.OakLog]: 300,
      [ItemType.OakPlanks]: 300,
      [ItemType.Stick]: 100,
    });
  });

  it('工作台与木制工具不是燃料', () => {
    expect(isFuel(ItemType.CraftingTable)).toBe(false);
    expect(isFuel(ItemType.WoodenPickaxe)).toBe(false);
    expect(isFuel(ItemType.WoodenAxe)).toBe(false);
    expect(isFuel(ItemType.WoodenShovel)).toBe(false);
  });
});

describe('熔炼配方表的原料（issue #33）', () => {
  it('粗铁与橡木原木能熔炼，其余都不能', () => {
    for (const item of ALL_ITEMS) {
      expect(isSmeltable(item), `物品 ${item}`).toBe(
        item === ItemType.RawIron || item === ItemType.OakLog,
      );
    }
  });

  it('橡木原木既是原料也是燃料', () => {
    expect(isSmeltable(ItemType.OakLog)).toBe(true);
    expect(isFuel(ItemType.OakLog)).toBe(true);
  });
});
