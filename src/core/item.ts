/**
 * 物品种类（见 CONTEXT.md 的「物品」）。数值会进存档，因此已发布的编号不可改动，
 * 新物品追加即可。
 *
 * 与方块是两套编号，不是一套：工具、食物这些物品没有对应的方块，草方块这样的方块
 * 掉的又是另一种物品（泥土）。哪种方块掉什么在 `BLOCKS` 的 `drop` 一列里。
 */
export const ItemType = {
  Dirt: 1,
  OakLog: 2,
  OakPlanks: 3,
  Stick: 4,
} as const;

export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** 一格里的一堆物品。`count` 恒 ≥ 1——数量归零的堆就是空格，用 undefined 表示。 */
export interface ItemStack {
  readonly item: ItemType;
  readonly count: number;
}

/**
 * 工具类别（见 CONTEXT.md 的「工具」）：镐、斧、铲，加一个「无」。
 *
 * 两侧都用它：物品那边说某件工具属于哪一类（工具物品等 #21），方块那边说挖它的
 * 正确工具是哪一类（`BlockDef.properTool`）。「无」同时表示三件事——空手、手上那件东西
 * 不是工具、这种方块没有正确工具（树叶）。三者对挖掘的作用相同，不必分开。
 *
 * 值是字符串而不是编号：它不进存档（工具类别是由物品种类查出来的，不单独存），
 * 所以不必像 `ItemType` 那样把编号钉死，读起来还清楚些。
 */
export const ToolClass = {
  None: 'none',
  Pickaxe: 'pickaxe',
  Axe: 'axe',
  Shovel: 'shovel',
} as const;

export type ToolClass = (typeof ToolClass)[keyof typeof ToolClass];

/**
 * 手上那件工具在挖掘上起的作用：算不算正确工具看类别，是正确工具时快多少看倍率。
 *
 * 只有这两个数进得了耗时公式，所以挖掘拿到的是它而不是整堆物品——耐久与图标不参与
 * 算耗时。哪种物品对应哪一件工具是物品表的事（#21、#22）。
 *
 * 与 `Hand` 不是一回事，别混：`Hand` 是「选中格里那一堆物品」，这里是「那一堆在挖掘
 * 那一步算什么」。空手也有这么一个值（`BARE_HAND`），它不是一只 `Hand`。
 */
export interface MiningTool {
  readonly toolClass: ToolClass;
  /** 挖掘速度倍率：木 2、石 4（见 #15 的物品属性表）。空手是 1。 */
  readonly speed: number;
}

/** 空手：没有类别，因此对任何方块都不算正确工具，倍率 1。手上拿着的不是工具时也是它。 */
export const BARE_HAND: MiningTool = Object.freeze({ toolClass: ToolClass.None, speed: 1 });

export interface ItemDef {
  /** 一格最多堆多少个。工具那类不可堆叠的物品（后续切片）是 1。 */
  readonly stackSize: number;
}

/** 可堆叠物品的堆叠上限。与原版一致。 */
export const DEFAULT_STACK_SIZE = 64;

/** 物品属性表——纯数据。耐久、食物回复量是后续切片往这里加的数据列。 */
export const ITEMS: Readonly<Record<ItemType, ItemDef>> = {
  [ItemType.Dirt]: { stackSize: DEFAULT_STACK_SIZE },
  [ItemType.OakLog]: { stackSize: DEFAULT_STACK_SIZE },
  [ItemType.OakPlanks]: { stackSize: DEFAULT_STACK_SIZE },
  [ItemType.Stick]: { stackSize: DEFAULT_STACK_SIZE },
};

/** 这种物品一格最多堆多少个。 */
export function stackLimit(item: ItemType): number {
  return ITEMS[item].stackSize;
}

/**
 * 收物品的地方，返回没放下的数量（0 表示全收下了）。
 *
 * 掉落物依赖它而不是 `Inventory` 本身：吸入那条路只需要「能不能收下」这一件事，
 * 测试里因此可以塞一个满的假背包，不必先把 36 格填出来。
 */
export interface ItemSink {
  add(stack: ItemStack): number;
}

/**
 * 一批可以逐格读写的物品格子。
 *
 * 背包界面依赖它而不是 `Inventory` 本身：那套拿起放下只搬格子里的东西，与选中格、
 * 快捷栏无关。合成网格（#17）与将来箱子的 27 格都是这么一批格子。
 */
export interface SlotBatch {
  /** 格子总数。 */
  readonly size: number;
  /** 某一格里的一堆物品，空格与指不到格子的下标都是 undefined。 */
  slot(index: number): ItemStack | undefined;
  /** 把某一格换成一堆物品（undefined 表示清空）。指不到格子的下标什么都不写。 */
  setSlot(index: number, stack: ItemStack | undefined): void;
}

/**
 * 一批格子，还能按入包规则整堆收物品（`add`）。背包是这么一批。
 *
 * 与 `SlotBatch` 分开是因为「收得下入包的东西」不是每一批格子都支持的操作：合成网格
 * 逐格读写，但拾取到的东西不该落进网格里，它因此只是 `SlotBatch`。关闭界面时东西
 * 往回归还，收的那一头必须是这一种。
 */
export interface SlotStore extends SlotBatch, ItemSink {}

/**
 * 手上拿着的那一堆物品，以及从它里面用掉一个。
 *
 * 放置依赖它而不是 `Inventory` 本身：放置只要「手上是什么」和「用掉一个」两件事，
 * 与「手上」是快捷栏的哪一格无关。测试里因此可以塞一只拿着任意东西的手。
 */
export interface Hand {
  /** 手持的那一堆（快捷栏选中格里的），空手时 undefined。 */
  readonly held: ItemStack | undefined;
  /** 用掉手上的一个。空手时什么都不做。 */
  takeOne(): void;
}
