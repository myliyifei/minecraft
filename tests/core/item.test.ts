import { describe, expect, it } from 'vitest';
import {
  BARE_HAND,
  DEFAULT_STACK_SIZE,
  ITEMS,
  ItemType,
  TOOL_MATERIAL_ORDER,
  TOOL_MATERIALS,
  TOOL_STACK_SIZE,
  ToolClass,
  ToolMaterial,
  durabilityOf,
  materialAtLeast,
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
   * issue #21 的三件木制工具、issue #23 的三件石制工具与 issue #32 的三件铁制工具：哪一类、
   * 哪一档。写死字面值，不从 `ITEMS` 反读——改坏数据表这条也照样通过的测试等于没写。
   */
  const TOOLS: Array<[string, ItemType, ToolClass, ToolMaterial]> = [
    ['木镐是木档的镐', ItemType.WoodenPickaxe, ToolClass.Pickaxe, ToolMaterial.Wood],
    ['木斧是木档的斧', ItemType.WoodenAxe, ToolClass.Axe, ToolMaterial.Wood],
    ['木铲是木档的铲', ItemType.WoodenShovel, ToolClass.Shovel, ToolMaterial.Wood],
    ['石镐是石档的镐', ItemType.StonePickaxe, ToolClass.Pickaxe, ToolMaterial.Stone],
    ['石斧是石档的斧', ItemType.StoneAxe, ToolClass.Axe, ToolMaterial.Stone],
    ['石铲是石档的铲', ItemType.StoneShovel, ToolClass.Shovel, ToolMaterial.Stone],
    ['铁镐是铁档的镐', ItemType.IronPickaxe, ToolClass.Pickaxe, ToolMaterial.Iron],
    ['铁斧是铁档的斧', ItemType.IronAxe, ToolClass.Axe, ToolMaterial.Iron],
    ['铁铲是铁档的铲', ItemType.IronShovel, ToolClass.Shovel, ToolMaterial.Iron],
  ];

  for (const [name, item, toolClass, material] of TOOLS) {
    it(name, () => {
      expect(toolOf(item)).toEqual({ toolClass, material });
    });
  }

  it('同一档的镐斧铲三件是三个类别、一个材质档', () => {
    // 类别与材质档是两回事（见 CONTEXT.md 的「材质档」）：木镐与石镐同类不同档，
    // 木镐与木斧同档不同类
    expect(toolOf(ItemType.WoodenPickaxe)!.toolClass).toBe(toolOf(ItemType.StonePickaxe)!.toolClass);
    expect(toolOf(ItemType.WoodenPickaxe)!.material).not.toBe(toolOf(ItemType.StonePickaxe)!.material);
    expect(toolOf(ItemType.StonePickaxe)!.material).toBe(toolOf(ItemType.StoneAxe)!.material);
    expect(toolOf(ItemType.StonePickaxe)!.toolClass).not.toBe(toolOf(ItemType.StoneAxe)!.toolClass);
  });

  it('工具不可堆叠：每把占一格', () => {
    expect(TOOL_STACK_SIZE).toBe(1);
    for (const [, item] of TOOLS) {
      expect(stackLimit(item), `物品 ${item}`).toBe(1);
    }
  });

  it('材料与方块物品不是工具，堆叠上限 64', () => {
    for (const item of [
      ItemType.Dirt,
      ItemType.OakLog,
      ItemType.OakPlanks,
      ItemType.Stick,
      ItemType.Cobblestone,
      ItemType.Furnace,
      ItemType.Coal,
      ItemType.RawIron,
      ItemType.IronIngot,
    ]) {
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

  it('石档倍率 4、耐久 131：同一张表的石制那一行（issue #23）', () => {
    expect(TOOL_MATERIALS[ToolMaterial.Stone]).toEqual({ speed: 4, durability: 131 });
  });

  it('铁档倍率 6、耐久 250：同一张表的铁制那一行（issue #32）', () => {
    expect(TOOL_MATERIALS[ToolMaterial.Iron]).toEqual({ speed: 6, durability: 250 });
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

  it('三件石制工具都是 131：同一档的镐斧铲数值相同', () => {
    expect(maxDurability(ItemType.StonePickaxe)).toBe(131);
    expect(maxDurability(ItemType.StoneAxe)).toBe(131);
    expect(maxDurability(ItemType.StoneShovel)).toBe(131);
    expect(maxDurability(ItemType.Cobblestone)).toBeUndefined();
  });

  it('三件铁制工具都是 250，铁锭是材料没有耐久', () => {
    expect(maxDurability(ItemType.IronPickaxe)).toBe(250);
    expect(maxDurability(ItemType.IronAxe)).toBe(250);
    expect(maxDurability(ItemType.IronShovel)).toBe(250);
    expect(maxDurability(ItemType.IronIngot)).toBeUndefined();
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

  it('空手没有材质档：谈不上够不够方块要求的最低档', () => {
    expect(BARE_HAND.material).toBeUndefined();
    expect(BARE_HAND.toolClass).toBe(ToolClass.None);
    expect(BARE_HAND.speed).toBe(1);
  });

  it('木镐是木档、倍率 2 的镐，木铲是木档、倍率 2 的铲；损耗过的也一样', () => {
    expect(miningToolOf({ item: ItemType.WoodenPickaxe, count: 1 })).toEqual({
      toolClass: ToolClass.Pickaxe,
      material: ToolMaterial.Wood,
      speed: 2,
    });
    expect(miningToolOf({ item: ItemType.WoodenShovel, count: 1, damage: 40 })).toEqual({
      toolClass: ToolClass.Shovel,
      material: ToolMaterial.Wood,
      speed: 2,
    });
  });

  it('石镐是石档、倍率 4 的镐，石斧是石档、倍率 4 的斧', () => {
    expect(miningToolOf({ item: ItemType.StonePickaxe, count: 1 })).toEqual({
      toolClass: ToolClass.Pickaxe,
      material: ToolMaterial.Stone,
      speed: 4,
    });
    expect(miningToolOf({ item: ItemType.StoneAxe, count: 1, damage: 130 })).toEqual({
      toolClass: ToolClass.Axe,
      material: ToolMaterial.Stone,
      speed: 4,
    });
  });

  it('铁镐是铁档、倍率 6 的镐，铁铲是铁档、倍率 6 的铲', () => {
    expect(miningToolOf({ item: ItemType.IronPickaxe, count: 1 })).toEqual({
      toolClass: ToolClass.Pickaxe,
      material: ToolMaterial.Iron,
      speed: 6,
    });
    expect(miningToolOf({ item: ItemType.IronShovel, count: 1, damage: 200 })).toEqual({
      toolClass: ToolClass.Shovel,
      material: ToolMaterial.Iron,
      speed: 6,
    });
  });
});

describe('材质档有先后：木 < 石 < 铁（issue #28、#32）', () => {
  it('顺序表从低到高列出每一档，一档一次不多不少', () => {
    expect(TOOL_MATERIAL_ORDER).toEqual([ToolMaterial.Wood, ToolMaterial.Stone, ToolMaterial.Iron]);
    expect([...TOOL_MATERIAL_ORDER].sort()).toEqual(Object.values(ToolMaterial).sort());
  });

  it('石不低于木，木不低于木，木低于石', () => {
    expect(materialAtLeast(ToolMaterial.Stone, ToolMaterial.Wood)).toBe(true);
    expect(materialAtLeast(ToolMaterial.Wood, ToolMaterial.Wood)).toBe(true);
    expect(materialAtLeast(ToolMaterial.Wood, ToolMaterial.Stone)).toBe(false);
  });

  it('铁不低于石也不低于木，石与木都低于铁', () => {
    expect(materialAtLeast(ToolMaterial.Iron, ToolMaterial.Stone)).toBe(true);
    expect(materialAtLeast(ToolMaterial.Iron, ToolMaterial.Wood)).toBe(true);
    expect(materialAtLeast(ToolMaterial.Stone, ToolMaterial.Iron)).toBe(false);
    expect(materialAtLeast(ToolMaterial.Wood, ToolMaterial.Iron)).toBe(false);
  });

  it('每一档都不低于自己，且顺序表上靠后的一档不低于靠前的任何一档', () => {
    TOOL_MATERIAL_ORDER.forEach((material, index) => {
      expect(materialAtLeast(material, material), `${material} 对自己`).toBe(true);
      for (const lower of TOOL_MATERIAL_ORDER.slice(0, index)) {
        expect(materialAtLeast(material, lower), `${material} 对 ${lower}`).toBe(true);
        expect(materialAtLeast(lower, material), `${lower} 对 ${material}`).toBe(false);
      }
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

  it('石制满耐久 131、木制 59：石镐损耗 130 点还剩 1/131，第 131 点才消失', () => {
    const pickaxe: ItemStack = { item: ItemType.StonePickaxe, count: 1 };
    expect(durabilityOf({ ...pickaxe, damage: 130 })).toEqual({ left: 1, max: 131 });
    expect(wornTool(pickaxe, 130)).toEqual({ ...pickaxe, damage: 130 });
    expect(wornTool(pickaxe, 131)).toBeUndefined();
  });

  it('铁制满耐久 250：铁镐损耗 249 点还剩 1/250，第 250 点才消失', () => {
    const pickaxe: ItemStack = { item: ItemType.IronPickaxe, count: 1 };
    expect(durabilityOf(pickaxe)).toEqual({ left: 250, max: 250 });
    expect(wornTool(pickaxe, 249)).toEqual({ ...pickaxe, damage: 249 });
    expect(wornTool({ ...pickaxe, damage: 249 }, 1)).toBeUndefined();
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
