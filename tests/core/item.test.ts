import { describe, expect, it } from 'vitest';
import {
  BARE_HAND,
  DEFAULT_STACK_SIZE,
  ITEMS,
  ItemType,
  TOOL_MATERIALS,
  TOOL_STACK_SIZE,
  ToolClass,
  ToolMaterial,
  durabilityOf,
  maxDurability,
  miningToolOf,
  stackLimit,
  toolOf,
  withCount,
  wornTool,
  type ItemStack,
} from '../../src/core/item';

describe('物品表里的工具', () => {
  /**
   * issue #21 的三件木制工具：哪一类、哪一档。写死字面值，不从 `ITEMS` 反读——
   * 改坏数据表这条也照样通过的测试等于没写。
   */
  const WOODEN_TOOLS: Array<[string, ItemType, ToolClass]> = [
    ['木镐是木档的镐', ItemType.WoodenPickaxe, ToolClass.Pickaxe],
    ['木斧是木档的斧', ItemType.WoodenAxe, ToolClass.Axe],
    ['木铲是木档的铲', ItemType.WoodenShovel, ToolClass.Shovel],
  ];

  for (const [name, item, toolClass] of WOODEN_TOOLS) {
    it(name, () => {
      expect(toolOf(item)).toEqual({ toolClass, material: ToolMaterial.Wood });
    });
  }

  it('工具不可堆叠：每把占一格', () => {
    expect(TOOL_STACK_SIZE).toBe(1);
    for (const [, item] of WOODEN_TOOLS) {
      expect(stackLimit(item), `物品 ${item}`).toBe(1);
    }
  });

  it('材料与方块物品不是工具，堆叠上限 64', () => {
    for (const item of [ItemType.Dirt, ItemType.OakLog, ItemType.OakPlanks, ItemType.Stick]) {
      expect(toolOf(item), `物品 ${item}`).toBeUndefined();
      expect(stackLimit(item)).toBe(DEFAULT_STACK_SIZE);
    }
  });

  it('物品表的每一行都填了堆叠上限，是工具的那几行才填工具', () => {
    for (const item of Object.values(ItemType)) {
      const def = ITEMS[item];
      expect(def.stackSize, `物品 ${item}`).toBeGreaterThan(0);
      if (def.tool) {
        expect(def.stackSize).toBe(TOOL_STACK_SIZE);
        expect(Object.values(ToolClass)).toContain(def.tool.toolClass);
        expect(def.tool.toolClass).not.toBe(ToolClass.None);
        expect(Object.values(ToolMaterial)).toContain(def.tool.material);
      }
    }
  });
});

describe('材质档的倍率与最大耐久', () => {
  it('木档倍率 2、耐久 59：issue #15 物品属性表的数值，写死字面值', () => {
    expect(TOOL_MATERIALS[ToolMaterial.Wood]).toEqual({ speed: 2, durability: 59 });
  });

  it('每一档都填了正的倍率与耐久', () => {
    for (const material of Object.values(ToolMaterial)) {
      const def = TOOL_MATERIALS[material];
      expect(def.speed, `材质档 ${material}`).toBeGreaterThan(0);
      expect(def.durability, `材质档 ${material}`).toBeGreaterThan(0);
    }
  });

  it('工具的最大耐久按材质档查：三件木制工具都是 59，材料没有耐久', () => {
    expect(maxDurability(ItemType.WoodenPickaxe)).toBe(59);
    expect(maxDurability(ItemType.WoodenAxe)).toBe(59);
    expect(maxDurability(ItemType.WoodenShovel)).toBe(59);
    expect(maxDurability(ItemType.Dirt)).toBeUndefined();
    expect(maxDurability(ItemType.Stick)).toBeUndefined();
  });
});

describe('手上那一堆在挖掘里算什么工具', () => {
  it('空手是 BARE_HAND', () => {
    expect(miningToolOf(undefined)).toBe(BARE_HAND);
  });

  it('材料与方块物品也是 BARE_HAND：拿着泥土挖与空手一样', () => {
    expect(miningToolOf({ item: ItemType.Dirt, count: 3 })).toBe(BARE_HAND);
    expect(miningToolOf({ item: ItemType.Stick, count: 1 })).toBe(BARE_HAND);
  });

  it('木镐是倍率 2 的镐，木铲是倍率 2 的铲；损耗过的也一样', () => {
    expect(miningToolOf({ item: ItemType.WoodenPickaxe, count: 1 })).toEqual({
      toolClass: ToolClass.Pickaxe,
      speed: 2,
    });
    expect(miningToolOf({ item: ItemType.WoodenShovel, count: 1, damage: 40 })).toEqual({
      toolClass: ToolClass.Shovel,
      speed: 2,
    });
  });
});

describe('耐久是格子里那一堆的状态（ADR-0010）', () => {
  const FRESH: ItemStack = { item: ItemType.WoodenShovel, count: 1 };

  it('新造的工具没有损耗字段，耐久是满的 59/59', () => {
    expect(FRESH.damage).toBeUndefined();
    expect(durabilityOf(FRESH)).toEqual({ left: 59, max: 59 });
  });

  it('损耗 1 点：同一件工具，damage 记 1，耐久剩 58/59', () => {
    const worn = wornTool(FRESH, 1);
    expect(worn).toEqual({ item: ItemType.WoodenShovel, count: 1, damage: 1 });
    expect(durabilityOf(worn!)).toEqual({ left: 58, max: 59 });
  });

  it('损耗累加：已损耗 10 点再损耗 5 点是 15 点', () => {
    expect(wornTool({ ...FRESH, damage: 10 }, 5)).toEqual({ ...FRESH, damage: 15 });
  });

  it('损耗到 59 点工具消失：返回 undefined，那一格因此清空', () => {
    expect(wornTool({ ...FRESH, damage: 58 }, 1)).toBeUndefined();
    expect(wornTool(FRESH, 59)).toBeUndefined();
  });

  it('损耗超过剩余耐久同样是消失，不会出负数', () => {
    expect(wornTool({ ...FRESH, damage: 50 }, 20)).toBeUndefined();
  });

  it('损耗 0 点什么都不变', () => {
    expect(wornTool(FRESH, 0)).toBe(FRESH);
  });

  it('材料没有耐久：怎么损耗都原样返回，耐久是 undefined', () => {
    const dirt: ItemStack = { item: ItemType.Dirt, count: 5 };
    expect(wornTool(dirt, 3)).toBe(dirt);
    expect(durabilityOf(dirt)).toBeUndefined();
  });

  it('空手损耗什么都没有', () => {
    expect(wornTool(undefined, 1)).toBeUndefined();
  });

  it('改数量时损耗跟着走：withCount 保留 damage', () => {
    expect(withCount({ ...FRESH, damage: 7 }, 1)).toEqual({ ...FRESH, damage: 7 });
    expect(withCount({ item: ItemType.Dirt, count: 10 }, 4)).toEqual({ item: ItemType.Dirt, count: 4 });
  });
});
