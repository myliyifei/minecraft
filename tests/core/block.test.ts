import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BlockStateKind,
  BlockType,
  BlockUse,
  UNBREAKABLE,
  baseBlock,
  blockDrop,
  blockExperience,
  blockStateKind,
  blockUse,
  dropFor,
  isBreakable,
  miningTicks,
  miningTicksFor,
  placedBlock,
  type BlockDef,
} from '../../src/core/block';
import {
  BARE_HAND,
  ItemType,
  ToolClass,
  ToolMaterial,
  type MiningTool,
} from '../../src/core/item';

/**
 * 木、石、铁三档：材质档加它的挖掘速度倍率，倍率来自 #15 的物品属性表，写死字面值。
 * 不从 `TOOL_MATERIALS` 反读：这个文件断言的是「某档挖某块要几 tick」，倍率是输入的一部分。
 */
type MaterialWithSpeed = Pick<MiningTool, 'material' | 'speed'>;
const WOODEN: MaterialWithSpeed = { material: ToolMaterial.Wood, speed: 2 };
const STONE: MaterialWithSpeed = { material: ToolMaterial.Stone, speed: 4 };
const IRON: MaterialWithSpeed = { material: ToolMaterial.Iron, speed: 6 };

/** 手上拿着某一类、某一档的工具。 */
function tool(toolClass: ToolClass, material: MaterialWithSpeed): MiningTool {
  return { toolClass, ...material };
}

/**
 * issue #7 给的硬度与空手耗时，全部写死字面值。
 *
 * 不从 `BLOCKS` 反算耗时：右边一旦是「硬度 × 30」，就是拿实现的式子比它自己，
 * 硬度写错也照样通过。这张表是需求那一侧的数字，两列必须各自对得上。
 */
const HAND_MINING: Array<[string, BlockType, number, number]> = [
  ['草方块', BlockType.Grass, 0.6, 18],
  ['泥土', BlockType.Dirt, 0.5, 15],
  // 石头要镐，空着手是每点硬度 100 tick 而不是 30——按 30 算会是 45 tick
  ['石头', BlockType.Stone, 1.5, 150],
  ['原木', BlockType.OakLog, 2, 60],
  ['树叶', BlockType.OakLeaves, 0.2, 6],
  // 木板与原木同硬度（issue #18）
  ['木板', BlockType.OakPlanks, 2, 60],
  // 工作台比木板硬半点（issue #19）
  ['工作台', BlockType.CraftingTable, 2.5, 75],
  // 圆石要镐（issue #22），空着手同样是每点硬度 100 tick
  ['圆石', BlockType.Cobblestone, 2, 200],
  // 熔炉要镐（issue #30），硬度 3.5；燃烧中的那个编号与它同一行数据
  ['熔炉', BlockType.Furnace, 3.5, 350],
  ['燃烧中的熔炉', BlockType.LitFurnace, 3.5, 350],
  // 两种矿石要镐（issue #31），硬度 3；空手按每点硬度 100 tick
  ['煤矿石', BlockType.CoalOre, 3, 300],
  ['铁矿石', BlockType.IronOre, 3, 300],
];

describe('方块的硬度表', () => {
  it('硬度与空手耗时就是 issue #7 给的那两列', () => {
    for (const [name, block, hardness, ticks] of HAND_MINING) {
      expect(BLOCKS[block].hardness, `${name}的硬度`).toBe(hardness);
      expect(miningTicks(block, BARE_HAND), `${name}的耗时`).toBe(ticks);
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

  it('石头、圆石、两个编号的熔炉与两种矿石需要工具', () => {
    const needsTool = new Set<BlockType>([
      BlockType.Stone,
      BlockType.Cobblestone,
      BlockType.Furnace,
      BlockType.LitFurnace,
      BlockType.CoalOre,
      BlockType.IronOre,
    ]);
    for (const block of Object.values(BlockType)) {
      expect(BLOCKS[block].requiresTool, `方块 ${block}`).toBe(needsTool.has(block));
    }
  });
});

describe('手持工具时的挖掘耗时', () => {
  /**
   * issue #22 给的关键数值：向上取整（硬度 × 30 ÷ 倍率），倍率只在合格工具上算数；
   * 需要工具的方块没有合格工具时每点硬度 100 tick，这条优先。写死字面值，不从公式反算。
   */
  const TOOL_MINING: Array<[string, BlockType, MiningTool, number]> = [
    ['持木镐挖石头', BlockType.Stone, tool(ToolClass.Pickaxe, WOODEN), 23],
    ['持木镐挖圆石', BlockType.Cobblestone, tool(ToolClass.Pickaxe, WOODEN), 30],
    ['持木铲挖泥土', BlockType.Dirt, tool(ToolClass.Shovel, WOODEN), 8],
    ['持木铲挖草方块', BlockType.Grass, tool(ToolClass.Shovel, WOODEN), 9],
    ['持木斧挖原木', BlockType.OakLog, tool(ToolClass.Axe, WOODEN), 30],
    ['持木斧挖工作台', BlockType.CraftingTable, tool(ToolClass.Axe, WOODEN), 38],
    ['持石镐挖石头', BlockType.Stone, tool(ToolClass.Pickaxe, STONE), 12],
    // 熔炉（issue #30）：硬度 3.5 × 30 ÷ 2 = 52.5，向上取整
    ['持木镐挖熔炉', BlockType.Furnace, tool(ToolClass.Pickaxe, WOODEN), 53],
    ['持木镐挖燃烧中的熔炉', BlockType.LitFurnace, tool(ToolClass.Pickaxe, WOODEN), 53],
    // 熔炉要镐：持木斧按需要工具那一档算，与空手相同
    ['持木斧挖熔炉', BlockType.Furnace, tool(ToolClass.Axe, WOODEN), 350],
    ['持石斧挖原木', BlockType.OakLog, tool(ToolClass.Axe, STONE), 15],
    // 矿石（issue #31）：硬度 3 × 30 ÷ 2 = 45，÷ 4 = 22.5 向上取整
    ['持木镐挖煤矿石', BlockType.CoalOre, tool(ToolClass.Pickaxe, WOODEN), 45],
    ['持石镐挖煤矿石', BlockType.CoalOre, tool(ToolClass.Pickaxe, STONE), 23],
    ['持石镐挖铁矿石', BlockType.IronOre, tool(ToolClass.Pickaxe, STONE), 23],
    // 铁矿石最低档石：木镐类别对但档不够，按需要工具那一档算，与空手相同
    ['持木镐挖铁矿石', BlockType.IronOre, tool(ToolClass.Pickaxe, WOODEN), 300],
    // 铁档（issue #32）：倍率 6。石头 1.5 × 30 ÷ 6 = 7.5、熔炉 17.5、泥土 2.5，都向上取整
    ['持铁镐挖石头', BlockType.Stone, tool(ToolClass.Pickaxe, IRON), 8],
    ['持铁镐挖煤矿石', BlockType.CoalOre, tool(ToolClass.Pickaxe, IRON), 15],
    // 铁矿石最低档石：铁档高于石，同样合格
    ['持铁镐挖铁矿石', BlockType.IronOre, tool(ToolClass.Pickaxe, IRON), 15],
    ['持铁镐挖熔炉', BlockType.Furnace, tool(ToolClass.Pickaxe, IRON), 18],
    ['持铁斧挖原木', BlockType.OakLog, tool(ToolClass.Axe, IRON), 10],
    ['持铁铲挖泥土', BlockType.Dirt, tool(ToolClass.Shovel, IRON), 3],
    // 拿错工具与空手一样慢
    ['持木铲挖原木', BlockType.OakLog, tool(ToolClass.Shovel, WOODEN), 60],
    ['持铁铲挖原木', BlockType.OakLog, tool(ToolClass.Shovel, IRON), 60],
    ['持木斧挖泥土', BlockType.Dirt, tool(ToolClass.Axe, WOODEN), 15],
    // 需要工具的方块拿错工具仍按「需要工具」那一档算，倍率不起作用
    ['持石斧挖石头', BlockType.Stone, tool(ToolClass.Axe, STONE), 150],
    ['持木铲挖圆石', BlockType.Cobblestone, tool(ToolClass.Shovel, WOODEN), 200],
    // 树叶没有合格工具，谁挖都一样
    ['持木斧挖树叶', BlockType.OakLeaves, tool(ToolClass.Axe, WOODEN), 6],
    // 剑（issue #45）：没有任何方块以剑为合格工具，持剑挖什么都与空手一样慢
    ['持木剑挖泥土', BlockType.Dirt, tool(ToolClass.Sword, WOODEN), 15],
    ['持铁剑挖原木', BlockType.OakLog, tool(ToolClass.Sword, IRON), 60],
    ['持铁剑挖石头', BlockType.Stone, tool(ToolClass.Sword, IRON), 150],
    ['持铁剑挖树叶', BlockType.OakLeaves, tool(ToolClass.Sword, IRON), 6],
  ];

  for (const [name, block, held, ticks] of TOOL_MINING) {
    it(`${name}要 ${ticks} tick`, () => {
      expect(miningTicks(block, held)).toBe(ticks);
    });
  }
});

describe('方块表的合格工具类别一列', () => {
  /**
   * issue #15 的方块表给的「合格工具」一列。同样写死字面值，不从 `BLOCKS` 反读。
   * 「无」是「没有哪种工具挖它更快」，树叶是这一档；空气与基岩不是挖掘目标，也记「无」。
   */
  const PROPER_TOOL: Array<[string, BlockType, ToolClass]> = [
    ['草方块', BlockType.Grass, ToolClass.Shovel],
    ['泥土', BlockType.Dirt, ToolClass.Shovel],
    ['石头', BlockType.Stone, ToolClass.Pickaxe],
    ['圆石', BlockType.Cobblestone, ToolClass.Pickaxe],
    ['煤矿石', BlockType.CoalOre, ToolClass.Pickaxe],
    ['铁矿石', BlockType.IronOre, ToolClass.Pickaxe],
    ['原木', BlockType.OakLog, ToolClass.Axe],
    ['木板', BlockType.OakPlanks, ToolClass.Axe],
    ['工作台', BlockType.CraftingTable, ToolClass.Axe],
    ['树叶', BlockType.OakLeaves, ToolClass.None],
    ['空气', BlockType.Air, ToolClass.None],
    ['基岩', BlockType.Bedrock, ToolClass.None],
  ];

  for (const [name, block, expected] of PROPER_TOOL) {
    it(`${name}的合格工具类别是 ${expected}`, () => {
      expect(BLOCKS[block].qualifiedToolClass).toBe(expected);
    });
  }

  it('没有任何方块以剑为合格工具（issue #45）', () => {
    for (const block of Object.values(BlockType)) {
      expect(BLOCKS[block].qualifiedToolClass, `方块 ${block}`).not.toBe(ToolClass.Sword);
    }
  });

  it('每一行都填了这一列，且填的是一种工具类别', () => {
    const classes: readonly ToolClass[] = Object.values(ToolClass);
    for (const block of Object.values(BlockType)) {
      expect(classes, `方块 ${block}`).toContain(BLOCKS[block].qualifiedToolClass);
    }
  });
});

describe('方块表的最低材质档一列（issue #28）', () => {
  it('只有铁矿石记石，其余方块全部为木：任何镐、斧、铲在它们上面都合格', () => {
    for (const block of Object.values(BlockType)) {
      expect(BLOCKS[block].minimumMaterial, `方块 ${block}`).toBe(
        block === BlockType.IronOre ? ToolMaterial.Stone : ToolMaterial.Wood,
      );
    }
  });

  it('每一行填的都是一种材质档', () => {
    const materials: readonly ToolMaterial[] = Object.values(ToolMaterial);
    for (const block of Object.values(BlockType)) {
      expect(materials, `方块 ${block}`).toContain(BLOCKS[block].minimumMaterial);
    }
  });
});

describe('合格工具：类别正确且材质档不低于方块要求的最低档', () => {
  /**
   * 现有方块的最低档全是木，这条规则在方块表上观察不到。拿石头那一行改最低档为石造一个
   * 测试专用的方块定义：需要工具、硬度 1.5、合格工具是镐、掉圆石，只有最低档不同。
   */
  const STONE_ONLY: BlockDef = { ...BLOCKS[BlockType.Stone], minimumMaterial: ToolMaterial.Stone };
  const cobblestone = { item: ItemType.Cobblestone, count: 1 };

  it('持木镐挖它：类别对但档不够，视同没有合格工具，按需要工具那一档 150 tick 且什么都不掉', () => {
    expect(miningTicksFor(STONE_ONLY, tool(ToolClass.Pickaxe, WOODEN))).toBe(150);
    expect(dropFor(STONE_ONLY, tool(ToolClass.Pickaxe, WOODEN))).toBeNull();
  });

  it('持石镐挖它正常：12 tick、掉圆石', () => {
    expect(miningTicksFor(STONE_ONLY, tool(ToolClass.Pickaxe, STONE))).toBe(12);
    expect(dropFor(STONE_ONLY, tool(ToolClass.Pickaxe, STONE))).toEqual(cobblestone);
  });

  it('空手与拿错类别的石斧仍是 150 tick、什么都不掉', () => {
    expect(miningTicksFor(STONE_ONLY, BARE_HAND)).toBe(150);
    expect(dropFor(STONE_ONLY, BARE_HAND)).toBeNull();
    expect(miningTicksFor(STONE_ONLY, tool(ToolClass.Axe, STONE))).toBe(150);
    expect(dropFor(STONE_ONLY, tool(ToolClass.Axe, STONE))).toBeNull();
  });

  it('不需要工具的方块档不够时按倍率 1：最低档为石的原木持木斧挖是 60 tick，照样掉原木', () => {
    const def: BlockDef = { ...BLOCKS[BlockType.OakLog], minimumMaterial: ToolMaterial.Stone };
    expect(miningTicksFor(def, tool(ToolClass.Axe, WOODEN))).toBe(60);
    expect(dropFor(def, tool(ToolClass.Axe, WOODEN))).toEqual({ item: ItemType.OakLog, count: 1 });
    expect(miningTicksFor(def, tool(ToolClass.Axe, STONE))).toBe(15);
  });

  it('按方块种类查的两个入口与按定义查的结果一致', () => {
    const wooden = tool(ToolClass.Pickaxe, WOODEN);
    expect(miningTicks(BlockType.Stone, wooden)).toBe(miningTicksFor(BLOCKS[BlockType.Stone], wooden));
    expect(blockDrop(BlockType.Stone, wooden)).toEqual(dropFor(BLOCKS[BlockType.Stone], wooden));
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
    ['橡木木板掉木板', BlockType.OakPlanks, ItemType.OakPlanks],
    ['工作台掉工作台', BlockType.CraftingTable, ItemType.CraftingTable],
    ['树叶什么都不掉', BlockType.OakLeaves, null],
    // 石头与圆石要镐，空着手挖掉了也拿不到东西
    ['空手挖石头什么都不掉', BlockType.Stone, null],
    ['空手挖圆石什么都不掉', BlockType.Cobblestone, null],
    ['空手挖熔炉什么都不掉', BlockType.Furnace, null],
    ['空手挖燃烧中的熔炉什么都不掉', BlockType.LitFurnace, null],
    ['空手挖煤矿石什么都不掉', BlockType.CoalOre, null],
    ['空手挖铁矿石什么都不掉', BlockType.IronOre, null],
    ['基岩什么都不掉', BlockType.Bedrock, null],
  ];

  for (const [name, block, item] of HAND_DROPS) {
    it(name, () => {
      const drop = blockDrop(block, BARE_HAND);
      if (item === null) {
        expect(drop).toBeNull();
      } else {
        expect(drop).toEqual({ item, count: 1 });
      }
    });
  }

  it('空气不掉东西', () => {
    expect(blockDrop(BlockType.Air, BARE_HAND)).toBeNull();
  });

  it('掉落表里每一堆都至少有一个', () => {
    for (const block of Object.values(BlockType)) {
      const drop = BLOCKS[block].drop;
      if (drop) expect(drop.count, `方块 ${block}`).toBeGreaterThan(0);
    }
  });
});

describe('掉落看手上的工具', () => {
  it('需要工具的方块，手上没有合格工具时什么都不掉', () => {
    for (const block of Object.values(BlockType)) {
      if (!BLOCKS[block].requiresTool) continue;
      expect(blockDrop(block, BARE_HAND), `方块 ${block} 空手`).toBeNull();
      // 拿着的不是合格工具那一类也一样：石头要镐，石斧挖得动也拿不到东西
      expect(blockDrop(block, tool(ToolClass.Axe, STONE)), `方块 ${block} 持石斧`).toBeNull();
    }
  });

  it('不需要工具的方块不看工具：拿着什么挖都掉同一样', () => {
    for (const block of Object.values(BlockType)) {
      if (BLOCKS[block].requiresTool) continue;
      const bare = blockDrop(block, BARE_HAND);
      for (const toolClass of Object.values(ToolClass)) {
        expect(blockDrop(block, tool(toolClass, STONE)), `方块 ${block} 持 ${toolClass}`).toEqual(
          bare,
        );
      }
    }
  });

  it('持镐挖石头掉 1 个圆石，挖圆石也掉 1 个圆石（issue #22）', () => {
    const cobblestone = { item: ItemType.Cobblestone, count: 1 };
    expect(blockDrop(BlockType.Stone, tool(ToolClass.Pickaxe, WOODEN))).toEqual(cobblestone);
    expect(blockDrop(BlockType.Cobblestone, tool(ToolClass.Pickaxe, WOODEN))).toEqual(cobblestone);
  });

  it('持镐挖两个编号的熔炉都掉 1 个熔炉：燃烧中的熔炉挖掉不会变成别的东西（issue #30）', () => {
    const furnace = { item: ItemType.Furnace, count: 1 };
    expect(blockDrop(BlockType.Furnace, tool(ToolClass.Pickaxe, WOODEN))).toEqual(furnace);
    expect(blockDrop(BlockType.LitFurnace, tool(ToolClass.Pickaxe, WOODEN))).toEqual(furnace);
  });

  it('持木镐挖煤矿石掉 1 个煤炭，持石镐挖铁矿石掉 1 个粗铁（issue #31）', () => {
    expect(blockDrop(BlockType.CoalOre, tool(ToolClass.Pickaxe, WOODEN))).toEqual({
      item: ItemType.Coal,
      count: 1,
    });
    expect(blockDrop(BlockType.IronOre, tool(ToolClass.Pickaxe, STONE))).toEqual({
      item: ItemType.RawIron,
      count: 1,
    });
  });

  it('铁档高于石：持铁镐挖铁矿石同样掉 1 个粗铁（issue #32）', () => {
    expect(blockDrop(BlockType.IronOre, tool(ToolClass.Pickaxe, IRON))).toEqual({
      item: ItemType.RawIron,
      count: 1,
    });
    // 类别不对，档再高也不合格
    expect(blockDrop(BlockType.IronOre, tool(ToolClass.Axe, IRON))).toBeNull();
  });

  it('铁矿石最低档石：持木镐挖得动但什么都不掉，持石斧也不掉', () => {
    expect(blockDrop(BlockType.IronOre, tool(ToolClass.Pickaxe, WOODEN))).toBeNull();
    expect(blockDrop(BlockType.IronOre, tool(ToolClass.Axe, STONE))).toBeNull();
    // 煤矿石最低档木：木镐就合格
    expect(blockDrop(BlockType.CoalOre, tool(ToolClass.Pickaxe, WOODEN))).not.toBeNull();
  });

  it('草方块持镐挖照样掉泥土：镐不是它的合格工具，也不影响掉落', () => {
    expect(blockDrop(BlockType.Grass, tool(ToolClass.Pickaxe, WOODEN))).toEqual({
      item: ItemType.Dirt,
      count: 1,
    });
  });
});

describe('挖掉一块给多少经验', () => {
  /**
   * issue #26 给的经验表（#9 的数值乘 10）：普通方块 30、原木 60；矿石那几档见
   * docs/design-decisions.md，煤 90、铁 120（issue #31）。同样写死字面值，不从 `BLOCKS` 反读。
   */
  const EXPERIENCE: Array<[string, BlockType, number]> = [
    ['草方块', BlockType.Grass, 30],
    ['泥土', BlockType.Dirt, 30],
    ['石头', BlockType.Stone, 30],
    ['圆石', BlockType.Cobblestone, 30],
    ['树叶', BlockType.OakLeaves, 30],
    ['木板', BlockType.OakPlanks, 30],
    ['工作台', BlockType.CraftingTable, 30],
    ['原木', BlockType.OakLog, 60],
    ['煤矿石', BlockType.CoalOre, 90],
    ['铁矿石', BlockType.IronOre, 120],
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
    expect(blockDrop(BlockType.Stone, BARE_HAND)).toBeNull();
    expect(blockExperience(BlockType.Stone)).toBeGreaterThan(0);
    // 树叶同理
    expect(blockDrop(BlockType.OakLeaves, BARE_HAND)).toBeNull();
    expect(blockExperience(BlockType.OakLeaves)).toBeGreaterThan(0);
  });

  it('挖得动的方块都给正的经验', () => {
    for (const block of Object.values(BlockType)) {
      if (!isBreakable(block)) continue;
      expect(blockExperience(block), `方块 ${block}`).toBeGreaterThan(0);
    }
  });
});

describe('外观变体归到的编号（ADR-0012）', () => {
  it('燃烧中的熔炉归到熔炉，其余方块都是自己', () => {
    expect(baseBlock(BlockType.LitFurnace)).toBe(BlockType.Furnace);
    for (const block of Object.values(BlockType)) {
      if (block === BlockType.LitFurnace) continue;
      expect(baseBlock(block), `方块 ${block}`).toBe(block);
    }
  });
});

describe('放置表', () => {
  /**
   * issue #15 的放置表：哪种物品放下去是哪种方块，`null` 是放不下去。
   * 写死字面值，不从 `PLACED_BLOCKS` 反读。
   */
  const PLACED: Array<[string, ItemType, BlockType | null]> = [
    ['泥土放下去是泥土方块', ItemType.Dirt, BlockType.Dirt],
    ['原木放下去是原木方块', ItemType.OakLog, BlockType.OakLog],
    ['木板放下去是木板方块', ItemType.OakPlanks, BlockType.OakPlanks],
    ['工作台放下去是工作台方块', ItemType.CraftingTable, BlockType.CraftingTable],
    ['圆石放下去是圆石方块', ItemType.Cobblestone, BlockType.Cobblestone],
    // 放置永远是熄火那个编号：燃烧中的熔炉没有对应的物品
    ['熔炉放下去是熄火的熔炉方块', ItemType.Furnace, BlockType.Furnace],
    ['木棍放不下去', ItemType.Stick, null],
    ['木镐放不下去', ItemType.WoodenPickaxe, null],
    ['木斧放不下去', ItemType.WoodenAxe, null],
    ['木铲放不下去', ItemType.WoodenShovel, null],
    ['石镐放不下去', ItemType.StonePickaxe, null],
    ['石斧放不下去', ItemType.StoneAxe, null],
    ['石铲放不下去', ItemType.StoneShovel, null],
    // 煤炭与粗铁只是材料（issue #31），没有对应的方块
    ['煤炭放不下去', ItemType.Coal, null],
    ['粗铁放不下去', ItemType.RawIron, null],
    // 铁锭只是材料、三件铁制工具与别的工具一样（issue #32）
    ['铁锭放不下去', ItemType.IronIngot, null],
    ['铁镐放不下去', ItemType.IronPickaxe, null],
    ['铁斧放不下去', ItemType.IronAxe, null],
    ['铁铲放不下去', ItemType.IronShovel, null],
    // 三把剑与工具一样放不下去（issue #45）
    ['木剑放不下去', ItemType.WoodenSword, null],
    ['石剑放不下去', ItemType.StoneSword, null],
    ['铁剑放不下去', ItemType.IronSword, null],
    // 木炭是原木炼出来的材料（issue #34），没有对应的方块
    ['木炭放不下去', ItemType.Charcoal, null],
    ['腐肉放不下去', ItemType.RottenFlesh, null],
  ];

  it('上面这张表覆盖了物品表的每一行：加一种物品就得在这里补一条', () => {
    for (const item of Object.values(ItemType)) {
      expect(PLACED.some(([, listed]) => listed === item), `物品 ${item} 不在这张表里`).toBe(true);
    }
  });

  for (const [name, item, block] of PLACED) {
    it(name, () => {
      expect(placedBlock(item)).toBe(block);
    });
  }

  it('放下去再挖掉，拿回的是同一种物品：木板方块掉木板', () => {
    // issue #18：放下去的木板方块挖掉后掉回木板，材料不损失
    const block = placedBlock(ItemType.OakPlanks)!;
    expect(blockDrop(block, BARE_HAND)).toEqual({ item: ItemType.OakPlanks, count: 1 });
  });

  it('圆石放下去再持镐挖掉，掉回圆石：圆石是可回收的建材（issue #22）', () => {
    const block = placedBlock(ItemType.Cobblestone)!;
    expect(blockDrop(block, tool(ToolClass.Pickaxe, WOODEN))).toEqual({
      item: ItemType.Cobblestone,
      count: 1,
    });
  });
});

describe('方块表的「方块状态」一列（issue #30）', () => {
  it('只有两个编号的熔炉带方块状态，其余方块没有', () => {
    const stateful = new Set<BlockType>([BlockType.Furnace, BlockType.LitFurnace]);
    for (const block of Object.values(BlockType)) {
      expect(blockStateKind(block), `方块 ${block}`).toBe(
        stateful.has(block) ? BlockStateKind.Furnace : BlockStateKind.None,
      );
    }
  });

  it('每一行都填了这一列，且填的是一种状态', () => {
    const kinds: readonly BlockStateKind[] = Object.values(BlockStateKind);
    for (const block of Object.values(BlockType)) {
      expect(kinds, `方块 ${block}`).toContain(BLOCKS[block].state);
    }
  });

  it('燃烧中的熔炉与熄火的熔炉除贴图外是同一行数据：硬度、合格工具、掉落、状态都相同', () => {
    expect(BLOCKS[BlockType.LitFurnace]).toEqual(BLOCKS[BlockType.Furnace]);
  });
});

describe('方块表的「使用」一列', () => {
  it('只有工作台与熔炉是可使用方块：使用键对着它们打开界面，熔炉的两个编号都开熔炉界面', () => {
    const uses: Partial<Record<BlockType, BlockUse>> = {
      [BlockType.CraftingTable]: BlockUse.CraftingTable,
      [BlockType.Furnace]: BlockUse.Furnace,
      [BlockType.LitFurnace]: BlockUse.Furnace,
    };
    for (const block of Object.values(BlockType)) {
      expect(blockUse(block), `方块 ${block}`).toBe(uses[block] ?? BlockUse.None);
    }
  });
});

describe('硬度换算成挖掘耗时', () => {
  it('耗时与硬度成正比', () => {
    // 原木硬度 2，泥土 0.5，两者都不需要工具，耗时之比就该是 4：这一条不看具体秒数，
    // 只看那个乘法关系确实在起作用
    expect(miningTicks(BlockType.OakLog, BARE_HAND)).toBe(
      4 * miningTicks(BlockType.Dirt, BARE_HAND),
    );
  });

  it('耗时是整数个 tick，且不因浮点噪声多算一个', () => {
    // 0.2 × 30 在二进制里是 6.000000000000001，天真的向上取整会给出 7
    expect(miningTicks(BlockType.OakLeaves, BARE_HAND)).toBe(6);
    for (const block of Object.values(BlockType)) {
      if (block === BlockType.Bedrock) continue;
      expect(Number.isInteger(miningTicks(block, BARE_HAND)), `方块 ${block}`).toBe(true);
    }
  });

  it('挖不动的方块耗时是无穷', () => {
    expect(miningTicks(BlockType.Bedrock, BARE_HAND)).toBe(Infinity);
    expect(miningTicks(BlockType.Bedrock, tool(ToolClass.Pickaxe, STONE))).toBe(Infinity);
  });
});

describe('挖掘耗时看手上的工具', () => {
  /**
   * issue #15 的「关键数值」一节给的 tick 数：耗时 = 向上取整（硬度 × 30 ÷ 倍率），
   * 需要工具而手上没有合格工具时则是每点硬度 100 tick。同样写死字面值。
   */
  const TIMINGS: Array<[string, BlockType, MiningTool, number]> = [
    ['泥土持木铲', BlockType.Dirt, tool(ToolClass.Shovel, WOODEN), 8],
    ['草方块持木铲', BlockType.Grass, tool(ToolClass.Shovel, WOODEN), 9],
    ['原木持木斧', BlockType.OakLog, tool(ToolClass.Axe, WOODEN), 30],
    ['原木持石斧', BlockType.OakLog, tool(ToolClass.Axe, STONE), 15],
    ['石头持木镐', BlockType.Stone, tool(ToolClass.Pickaxe, WOODEN), 23],
    ['石头持石镐', BlockType.Stone, tool(ToolClass.Pickaxe, STONE), 12],
    ['石头持铁镐', BlockType.Stone, tool(ToolClass.Pickaxe, IRON), 8],
  ];

  for (const [name, block, held, ticks] of TIMINGS) {
    it(`${name}要 ${ticks} tick`, () => {
      expect(miningTicks(block, held)).toBe(ticks);
    });
  }

  it('拿错工具与空手一样慢', () => {
    // 铲挖原木、镐挖泥土都不是合格工具，倍率不起作用
    expect(miningTicks(BlockType.OakLog, tool(ToolClass.Shovel, STONE))).toBe(
      miningTicks(BlockType.OakLog, BARE_HAND),
    );
    expect(miningTicks(BlockType.Dirt, tool(ToolClass.Pickaxe, STONE))).toBe(
      miningTicks(BlockType.Dirt, BARE_HAND),
    );
  });

  it('需要工具的方块，拿错工具时仍按每点硬度 100 tick 那一档算', () => {
    // 石头要镐：拿着斧头挖仍是 150 tick，不是 1.5 × 30 ÷ 4
    expect(miningTicks(BlockType.Stone, tool(ToolClass.Axe, STONE))).toBe(150);
  });

  it('合格工具是「无」的方块谁也加不了速', () => {
    // 树叶那一行的合格工具是「无」，斧头对它不起作用
    const bare = miningTicks(BlockType.OakLeaves, BARE_HAND);
    for (const toolClass of Object.values(ToolClass)) {
      const held = tool(toolClass, STONE);
      expect(miningTicks(BlockType.OakLeaves, held), `持 ${toolClass}`).toBe(bare);
    }
  });
});
