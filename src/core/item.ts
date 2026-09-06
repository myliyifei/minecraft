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
