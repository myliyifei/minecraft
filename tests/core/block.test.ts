import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BlockType,
  BlockUse,
  UNBREAKABLE,
  blockDrop,
  blockExperience,
  blockUse,
  isBreakable,
  miningTicks,
  placedBlock,
} from '../../src/core/block';
import { BARE_HAND, ItemType, ToolClass, type MiningTool } from '../../src/core/item';

/**
 * 木制与石制那一档的挖掘速度倍率，来自 #15 的物品属性表。
 * 工具物品本身要等 #21，这里只用得上「类别 + 倍率」这两个数。
 */
const WOODEN = 2;
const STONE = 4;

/** 手上拿着某一类、某一档的工具。 */
function tool(toolClass: ToolClass, speed: number): MiningTool {
  return { toolClass, speed };
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

  it('本切片只有石头需要工具', () => {
    for (const block of Object.values(BlockType)) {
      expect(BLOCKS[block].requiresTool, `方块 ${block}`).toBe(block === BlockType.Stone);
    }
  });
});

describe('方块表的正确工具一列', () => {
  /**
   * issue #15 的方块表给的「正确工具」一列。同样写死字面值，不从 `BLOCKS` 反读。
   * 「无」是「没有哪种工具挖它更快」，树叶是这一档；空气与基岩不是挖掘目标，也记「无」。
   */
  const PROPER_TOOL: Array<[string, BlockType, ToolClass]> = [
    ['草方块', BlockType.Grass, ToolClass.Shovel],
    ['泥土', BlockType.Dirt, ToolClass.Shovel],
    ['石头', BlockType.Stone, ToolClass.Pickaxe],
    ['原木', BlockType.OakLog, ToolClass.Axe],
    ['木板', BlockType.OakPlanks, ToolClass.Axe],
    ['工作台', BlockType.CraftingTable, ToolClass.Axe],
    ['树叶', BlockType.OakLeaves, ToolClass.None],
    ['空气', BlockType.Air, ToolClass.None],
    ['基岩', BlockType.Bedrock, ToolClass.None],
  ];

  for (const [name, block, expected] of PROPER_TOOL) {
    it(`${name}的正确工具是 ${expected}`, () => {
      expect(BLOCKS[block].properTool).toBe(expected);
    });
  }

  it('每一行都填了这一列，且填的是一种工具类别', () => {
    const classes: readonly ToolClass[] = Object.values(ToolClass);
    for (const block of Object.values(BlockType)) {
      expect(classes, `方块 ${block}`).toContain(BLOCKS[block].properTool);
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
    ['橡木木板掉木板', BlockType.OakPlanks, ItemType.OakPlanks],
    ['工作台掉工作台', BlockType.CraftingTable, ItemType.CraftingTable],
    ['树叶什么都不掉', BlockType.OakLeaves, null],
    // 石头要镐，空着手挖掉了也拿不到东西
    ['空手挖石头什么都不掉', BlockType.Stone, null],
    ['基岩什么都不掉', BlockType.Bedrock, null],
  ];

  for (const [name, block, item] of HAND_DROPS) {
    it(name, () => {
      const drop = blockDrop(block, ToolClass.None);
      if (item === null) {
        expect(drop).toBeNull();
      } else {
        expect(drop).toEqual({ item, count: 1 });
      }
    });
  }

  it('空气不掉东西', () => {
    expect(blockDrop(BlockType.Air, ToolClass.None)).toBeNull();
  });

  it('掉落表里每一堆都至少有一个', () => {
    for (const block of Object.values(BlockType)) {
      const drop = BLOCKS[block].drop;
      if (drop) expect(drop.count, `方块 ${block}`).toBeGreaterThan(0);
    }
  });
});

describe('掉落看手上的工具类别', () => {
  it('需要工具的方块，手上没有正确工具时什么都不掉', () => {
    for (const block of Object.values(BlockType)) {
      if (!BLOCKS[block].requiresTool) continue;
      expect(blockDrop(block, ToolClass.None), `方块 ${block} 空手`).toBeNull();
      // 拿着的不是正确工具那一类也一样：石头要镐，斧头挖得动也拿不到东西
      expect(blockDrop(block, ToolClass.Axe), `方块 ${block} 持斧`).toBeNull();
    }
  });

  it('不需要工具的方块不看工具：拿着什么挖都掉同一样', () => {
    for (const block of Object.values(BlockType)) {
      if (BLOCKS[block].requiresTool) continue;
      const bare = blockDrop(block, ToolClass.None);
      for (const toolClass of Object.values(ToolClass)) {
        expect(blockDrop(block, toolClass), `方块 ${block} 持 ${toolClass}`).toEqual(bare);
      }
    }
  });

  it('草方块持镐挖照样掉泥土：镐不是它的正确工具，也不影响掉落', () => {
    expect(blockDrop(BlockType.Grass, ToolClass.Pickaxe)).toEqual({
      item: ItemType.Dirt,
      count: 1,
    });
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
    ['木板', BlockType.OakPlanks, 3],
    ['工作台', BlockType.CraftingTable, 3],
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
    expect(blockDrop(BlockType.Stone, ToolClass.None)).toBeNull();
    expect(blockExperience(BlockType.Stone)).toBeGreaterThan(0);
    // 树叶同理
    expect(blockDrop(BlockType.OakLeaves, ToolClass.None)).toBeNull();
    expect(blockExperience(BlockType.OakLeaves)).toBeGreaterThan(0);
  });

  it('挖得动的方块都给正的经验', () => {
    for (const block of Object.values(BlockType)) {
      if (!isBreakable(block)) continue;
      expect(blockExperience(block), `方块 ${block}`).toBeGreaterThan(0);
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
    ['木棍放不下去', ItemType.Stick, null],
  ];

  for (const [name, item, block] of PLACED) {
    it(name, () => {
      expect(placedBlock(item)).toBe(block);
    });
  }

  it('放下去再挖掉，拿回的是同一种物品：木板方块掉木板', () => {
    // issue #18：放下去的木板方块挖掉后掉回木板，材料不损失
    const block = placedBlock(ItemType.OakPlanks)!;
    expect(blockDrop(block, ToolClass.None)).toEqual({ item: ItemType.OakPlanks, count: 1 });
  });
});

describe('方块表的「使用」一列', () => {
  it('只有工作台是可使用方块：使用键对着它打开界面', () => {
    for (const block of Object.values(BlockType)) {
      expect(blockUse(block), `方块 ${block}`).toBe(
        block === BlockType.CraftingTable ? BlockUse.CraftingTable : BlockUse.None,
      );
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
   * 需要工具而手上没有正确工具时则是每点硬度 100 tick。同样写死字面值。
   */
  const TIMINGS: Array<[string, BlockType, MiningTool, number]> = [
    ['泥土持木铲', BlockType.Dirt, tool(ToolClass.Shovel, WOODEN), 8],
    ['草方块持木铲', BlockType.Grass, tool(ToolClass.Shovel, WOODEN), 9],
    ['原木持木斧', BlockType.OakLog, tool(ToolClass.Axe, WOODEN), 30],
    ['原木持石斧', BlockType.OakLog, tool(ToolClass.Axe, STONE), 15],
    ['石头持木镐', BlockType.Stone, tool(ToolClass.Pickaxe, WOODEN), 23],
    ['石头持石镐', BlockType.Stone, tool(ToolClass.Pickaxe, STONE), 12],
  ];

  for (const [name, block, held, ticks] of TIMINGS) {
    it(`${name}要 ${ticks} tick`, () => {
      expect(miningTicks(block, held)).toBe(ticks);
    });
  }

  it('拿错工具与空手一样慢', () => {
    // 铲挖原木、镐挖泥土都不是正确工具，倍率不起作用
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

  it('正确工具是「无」的方块谁也加不了速', () => {
    // 树叶那一行的正确工具是「无」，斧头对它不起作用
    const bare = miningTicks(BlockType.OakLeaves, BARE_HAND);
    for (const toolClass of Object.values(ToolClass)) {
      const held = tool(toolClass, STONE);
      expect(miningTicks(BlockType.OakLeaves, held), `持 ${toolClass}`).toBe(bare);
    }
  });
});
