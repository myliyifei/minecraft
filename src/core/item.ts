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
} as const;

export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** 一格里的一堆物品。`count` 恒 ≥ 1——数量归零的堆就是空格，用 undefined 表示。 */
export interface ItemStack {
  readonly item: ItemType;
  readonly count: number;
}

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
 * 一批可以逐格读写的物品格子，还能按入包规则整堆收物品（`add`）。
 *
 * 背包界面依赖它而不是 `Inventory` 本身：那套拿起放下只搬格子里的东西，与选中格、
 * 快捷栏无关。将来箱子的 27 格也是这么一批格子。
 */
export interface SlotStore extends ItemSink {
  /** 格子总数。 */
  readonly size: number;
  /** 某一格里的一堆物品，空格与指不到格子的下标都是 undefined。 */
  slot(index: number): ItemStack | undefined;
  /** 把某一格换成一堆物品（undefined 表示清空）。指不到格子的下标什么都不写。 */
  setSlot(index: number, stack: ItemStack | undefined): void;
}

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
