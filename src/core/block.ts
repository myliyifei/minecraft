import { ItemType, ToolClass, type ItemStack, type MiningTool } from './item';

/**
 * 方块种类。数值直接存进区块的 Uint8Array，因此已发布的编号不可改动，新方块追加即可。
 */
export const BlockType = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Bedrock: 4,
  OakLog: 5,
  OakLeaves: 6,
} as const;

export type BlockType = (typeof BlockType)[keyof typeof BlockType];

/** 挖不动的方块的硬度。基岩是唯一一个。 */
export const UNBREAKABLE = Infinity;

export interface BlockDef {
  /** 是否完全遮挡视线。false 的方块（空气、树叶）不会剔除邻居的面。 */
  readonly opaque: boolean;
  /**
   * 是否阻挡玩家与生物移动。
   * 与 `opaque` 是两件事：树叶不遮挡视线，但站在树冠里会被它挡住。
   */
  readonly solid: boolean;
  /** 硬度（见 CONTEXT.md），挖掘耗时按它算。`UNBREAKABLE` 表示怎么挖都挖不掉。 */
  readonly hardness: number;
  /**
   * 挖它更快的那一类工具（见 CONTEXT.md 的「正确工具」）：石头是镐，原木是斧，
   * 草与泥土是铲。`None` 是「没有哪种工具挖它更快」，树叶就是这一档。
   *
   * 与 `requiresTool` 是两件事：这一列说「哪种工具算正确工具」，那一列说「手上没有它时还能不能
   * 拿到东西」。草方块有正确工具（铲）但空手挖也照样掉泥土。
   */
  readonly properTool: ToolClass;
  /**
   * 挖它要正确工具（石头要镐）。空手照样挖得动，只是慢得多——每点硬度从 30 tick
   * 变成 100 tick，石头因此是 150 tick 而不是 45——而且什么都拿不到（见 `blockDrop`）。
   */
  readonly requiresTool: boolean;
  /**
   * 挖掉它掉出什么（见 CONTEXT.md 的「掉落表」），`null` 表示什么都不掉。
   *
   * 这一列是「拿着正确工具时掉什么」。需要工具的方块在没有正确工具时一律什么都不掉，
   * 那条规则在 `blockDrop` 里，不在数据里。石头这一行仍记 `null`：圆石这种物品要等
   * #22，那时把它换成圆石，空手挖不到东西的行为自然仍然成立。
   */
  readonly drop: ItemStack | null;
  /**
   * 挖掉它生成的经验球给几点经验值（见 CONTEXT.md 的「经验球」），0 表示不生成经验球。
   *
   * 与 `drop` 是两列，不是一列：任何挖得动的方块都给经验，掉落却可能是空的——空手挖
   * 石头什么都拿不到，经验照给 3 点。矿石那几档（煤 9 到钻石 24）见
   * docs/design-decisions.md，等有矿石了往这里加行。
   */
  readonly experience: number;
}

/** 一个某种物品的掉落。掉落表里绝大多数行都是这个形状。 */
function one(item: ItemType): ItemStack {
  return { item, count: 1 };
}

/** 普通方块给的经验值。原木与将来的矿石各有自己的档，见 `BlockDef.experience`。 */
const COMMON_EXPERIENCE = 3;

/** 方块属性表——纯数据。加方块只加一行。 */
export const BLOCKS: Readonly<Record<BlockType, BlockDef>> = {
  // 空气不是挖掘目标，硬度与正确工具只是占位。
  [BlockType.Air]: {
    opaque: false,
    solid: false,
    hardness: 0,
    properTool: ToolClass.None,
    requiresTool: false,
    drop: null,
    experience: 0,
  },
  // 草方块掉的是泥土，不是草方块本身——与原版一致。
  [BlockType.Grass]: {
    opaque: true,
    solid: true,
    hardness: 0.6,
    properTool: ToolClass.Shovel,
    requiresTool: false,
    drop: one(ItemType.Dirt),
    experience: COMMON_EXPERIENCE,
  },
  [BlockType.Dirt]: {
    opaque: true,
    solid: true,
    hardness: 0.5,
    properTool: ToolClass.Shovel,
    requiresTool: false,
    drop: one(ItemType.Dirt),
    experience: COMMON_EXPERIENCE,
  },
  // 空手挖得掉石头，但什么也拿不到（要镐）。
  [BlockType.Stone]: {
    opaque: true,
    solid: true,
    hardness: 1.5,
    properTool: ToolClass.Pickaxe,
    requiresTool: true,
    drop: null,
    experience: COMMON_EXPERIENCE,
  },
  [BlockType.Bedrock]: {
    opaque: true,
    solid: true,
    hardness: UNBREAKABLE,
    // 挖不动，谈不上哪种工具算正确工具。
    properTool: ToolClass.None,
    requiresTool: false,
    drop: null,
    // 挖不动，所以它永远碎不了，也就不会生成经验球。
    experience: 0,
  },
  [BlockType.OakLog]: {
    opaque: true,
    solid: true,
    hardness: 2,
    properTool: ToolClass.Axe,
    requiresTool: false,
    drop: one(ItemType.OakLog),
    // 原木自成一档，比普通方块高一倍。
    experience: 6,
  },
  // 树叶什么都不掉。树苗与苹果要等树叶凋落（后续切片）。
  [BlockType.OakLeaves]: {
    opaque: false,
    solid: true,
    hardness: 0.2,
    // 原版用剪刀与剑，本项目两样都还没有，所以树叶没有正确工具：拿什么挖都一样快。
    properTool: ToolClass.None,
    requiresTool: false,
    drop: null,
    // 树叶什么都不掉，但「任何方块都给经验」（见 CONTEXT.md 的「经验球」），
    // 所以它照普通方块给 3 点。原版的树叶不给经验，这一条是本项目自己定的。
    experience: COMMON_EXPERIENCE,
  },
};

export function isAir(block: BlockType): boolean {
  return block === BlockType.Air;
}

/** 完全遮挡视线的方块会让邻居对应的面被剔除。 */
export function isOpaque(block: BlockType): boolean {
  return BLOCKS[block].opaque;
}

/** 阻挡移动的方块参与实体的碰撞箱判定。 */
export function isSolid(block: BlockType): boolean {
  return BLOCKS[block].solid;
}

/** 挖得动的方块。空气不是挖掘目标，基岩挖不动。 */
export function isBreakable(block: BlockType): boolean {
  return block !== BlockType.Air && BLOCKS[block].hardness !== UNBREAKABLE;
}

/**
 * 一点硬度要挖多少 tick（倍率为 1 时）。
 * 与原版一致：20 tick/s（ADR-0002）下的 30 tick 就是 1.5 秒。
 */
const TICKS_PER_HARDNESS = 30;

/**
 * 需要工具而手上没有正确工具时，一点硬度要挖多少 tick。
 * 石头因此空手要 150 tick，而不是按上面那一档算出来的 45。
 */
const TICKS_PER_HARDNESS_WITHOUT_TOOL = 100;

/**
 * 取整到 tick 时先减掉的容差。
 *
 * 硬度是 0.2、0.6 这类十进制小数，二进制存不精确：`0.2 × 30` 算出来是
 * 6.000000000000001，直接向上取整树叶就要挖 7 tick 而不是 6。容差比一个 tick 小得多，
 * 只抵消舍入误差，不改变任何本该取整的结果。
 */
const TICK_EPSILON = 1e-9;

/** 手上那件工具对这种方块算不算正确工具。方块没有正确工具（树叶）时谁都不算。 */
function isProperTool(def: BlockDef, toolClass: ToolClass): boolean {
  return def.properTool !== ToolClass.None && def.properTool === toolClass;
}

/**
 * 手上拿着这件工具，挖掉一个方块要多少 tick，挖不动的返回 `Infinity`。
 *
 * 公式：向上取整（硬度 × 30 ÷ 倍率）。倍率只在手上那件工具是正确工具时算数，否则是 1——
 * 拿铲挖原木与空手一样慢。需要工具的方块在没有正确工具时另走一档（每点硬度 100 tick），
 * 这条优先于倍率：拿着石斧挖石头仍是 150 tick。
 *
 * 空手（`BARE_HAND`）的结果：草 18、泥土 15、树叶 6、原木 60、石头 150。
 */
export function miningTicks(block: BlockType, tool: MiningTool): number {
  const def = BLOCKS[block];
  const proper = isProperTool(def, tool.toolClass);
  if (def.requiresTool && !proper) {
    return Math.ceil(def.hardness * TICKS_PER_HARDNESS_WITHOUT_TOOL - TICK_EPSILON);
  }
  const speed = proper ? tool.speed : 1;
  return Math.ceil((def.hardness * TICKS_PER_HARDNESS) / speed - TICK_EPSILON);
}

/**
 * 手上拿着这一类工具，挖掉一个方块掉出什么，什么都不掉时返回 `null`。
 *
 * 需要工具的方块只在手上拿着正确工具时掉东西——空手挖石头挖得掉，什么也拿不到。
 * 其余方块不看工具：草方块拿镐挖照样掉泥土。
 *
 * 只要类别不要倍率：掉什么与挖多快无关，木镐与石镐挖石头掉的是同一样东西。
 */
export function blockDrop(block: BlockType, toolClass: ToolClass): ItemStack | null {
  const def = BLOCKS[block];
  if (def.requiresTool && !isProperTool(def, toolClass)) return null;
  return def.drop;
}

/**
 * 挖掉一个方块生成的经验球给几点经验值，0 表示不生成经验球。
 *
 * 不看工具：经验与掉落独立，空手挖石头拿不到圆石，经验照给。
 */
export function blockExperience(block: BlockType): number {
  return BLOCKS[block].experience;
}

/**
 * 放置表：一种物品放下去变成哪种方块，`null` 表示放不下去（工具、食物那些）。
 *
 * 与 `BLOCKS` 的 `drop` 一列正好反着来，但两张表并不互逆：草方块掉的是泥土，
 * 泥土放下去是泥土方块，草方块因此没有对应的物品；工具与食物则一头都没有。
 *
 * 表放在这个文件里而不是 `item.ts` 里，是因为 `block.ts` 已经 import 了 `item.ts`
 * （掉落表要写 `ItemStack`）。反过来再 import 一次就成了循环依赖，而两个模块顶层都有
 * 常量表要初始化，那种循环会在模块求值顺序上出问题。
 */
export const PLACED_BLOCKS: Readonly<Record<ItemType, BlockType | null>> = {
  [ItemType.Dirt]: BlockType.Dirt,
  [ItemType.OakLog]: BlockType.OakLog,
  // 木板方块要等 #18，在那之前木板只是合成出来的一种物品，放不下去。
  [ItemType.OakPlanks]: null,
};

/**
 * 这种物品放下去是哪种方块，放不下去的返回 `null`。
 *
 * 表里没有的物品编号（存档来自更新的版本，或者测试里的假物品）也当成放不下去，
 * 而不是让调用方拿到 undefined。
 */
export function placedBlock(item: ItemType): BlockType | null {
  return PLACED_BLOCKS[item] ?? null;
}

/**
 * 按世界坐标读方块的最小接口。
 * 网格生成、射线检测这些只读消费者依赖它而不是 World 本身，便于用假数据测试。
 */
export interface BlockView {
  getBlock(x: number, y: number, z: number): BlockType;
}

/**
 * 按世界坐标读写方块的最小接口。
 * 挖掘要把方块改成空气，因此比只读的 `BlockView` 多一个写入；返回值表示这次写入
 * 落到世界里了没有（区块未加载、y 越界都算没落地）。
 */
export interface BlockEdit extends BlockView {
  setBlock(x: number, y: number, z: number, block: BlockType): boolean;
}
