import { ItemType } from './item';

/**
 * 燃料表（见 CONTEXT.md 的「燃料」）——纯数据：一件燃料能烧多少 tick，数值与原版一致。不在表里的
 * 物品不是燃料，燃料格不收（`isFuel`）。
 *
 * 工作台与木制工具不在表里：原版里它们能烧，这里不收，免得玩家误把镐放进燃料格烧掉。木炭随 #34
 * 加入（那时才有这种物品），同样 1600 tick。
 */
export const FUEL_BURN_TICKS: Readonly<Partial<Record<ItemType, number>>> = {
  [ItemType.Coal]: 1600,
  [ItemType.OakLog]: 300,
  [ItemType.OakPlanks]: 300,
  [ItemType.Stick]: 100,
};

/** 这种物品是燃料吗：燃料表里有它。燃料格按它判定收不收。 */
export function isFuel(item: ItemType): boolean {
  return FUEL_BURN_TICKS[item] !== undefined;
}

/**
 * 熔炼配方表里的原料：粗铁与橡木原木。原料格只收它们（`isSmeltable`）。
 *
 * 这里只记原料，不记成品与每件经验：原木炼出的木炭要到 #34 才有这种物品，那时这张表换成
 * 「原料 → 成品与经验」的完整配方表，`isSmeltable` 的答案不变。
 */
const SMELTABLE_ITEMS: ReadonlySet<ItemType> = new Set([ItemType.RawIron, ItemType.OakLog]);

/** 这种物品能在熔炉里熔炼吗。原料格按它判定收不收。 */
export function isSmeltable(item: ItemType): boolean {
  return SMELTABLE_ITEMS.has(item);
}

/** 每件原料熔炼多少 tick 出 1 件成品：200 tick（10 秒），与原版一致。界面的进度条按它算比例。 */
export const SMELT_TICKS = 200;
