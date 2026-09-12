import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STACK_SIZE,
  ITEMS,
  ItemType,
  TOOL_STACK_SIZE,
  ToolClass,
  ToolMaterial,
  stackLimit,
  toolOf,
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
