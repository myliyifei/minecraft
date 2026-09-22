import { ItemType } from './item';

/**
 * 燃料表（见 CONTEXT.md 的「燃料」）——纯数据：一件燃料能烧多少 tick，数值与原版一致。不在表里的
 * 物品不是燃料，燃料格不收（`isFuel`）。
 *
 * 工作台与木制工具不在表里：原版里它们能烧，这里不收，免得玩家误把镐放进燃料格烧掉。
 */
export const FUEL_BURN_TICKS: Readonly<Partial<Record<ItemType, number>>> = {
  [ItemType.Coal]: 1600,
  [ItemType.Charcoal]: 1600,
  [ItemType.OakLog]: 300,
  [ItemType.OakPlanks]: 300,
  [ItemType.Stick]: 100,
};

/** 这种物品是燃料吗：燃料表里有它。燃料格按它判定收不收。 */
export function isFuel(item: ItemType): boolean {
  return burnTicksOf(item) !== undefined;
}

/** 一件燃料能烧多少 tick，不是燃料时 undefined。 */
export function burnTicksOf(item: ItemType): number | undefined {
  return FUEL_BURN_TICKS[item];
}

/** 一条熔炼配方：一件原料炼出什么，每件给几点经验。 */
export interface SmeltingRecipe {
  /** 成品：每炼完一件原料，成品格加 1 个它。 */
  readonly result: ItemType;
  /** 每件成品的经验，玩家从成品格取走时才结算（见 `takeExperience`）。 */
  readonly experience: number;
}

/**
 * 熔炼配方表（见 CONTEXT.md 的「熔炼」）——纯数据：原料 → 成品与每件经验，数值与原版一致。
 * 不在表里的物品不能熔炼，原料格不收（`isSmeltable`）。
 */
export const SMELTING_RECIPES: Readonly<Partial<Record<ItemType, SmeltingRecipe>>> = {
  [ItemType.RawIron]: { result: ItemType.IronIngot, experience: 7 },
  [ItemType.OakLog]: { result: ItemType.Charcoal, experience: 2 },
};

/** 这种原料的熔炼配方，不能熔炼时 undefined。 */
export function smeltingRecipe(item: ItemType): SmeltingRecipe | undefined {
  return SMELTING_RECIPES[item];
}

/** 这种物品能在熔炉里熔炼吗：熔炼配方表里有它。原料格按它判定收不收。 */
export function isSmeltable(item: ItemType): boolean {
  return smeltingRecipe(item) !== undefined;
}

/** 每件原料熔炼多少 tick 出 1 件成品：200 tick（10 秒），与原版一致。界面的进度条按它算比例。 */
export const SMELT_TICKS = 200;

/** 没在炼时熔炼进度每 tick 倒退多少，退到 0 为止：2，与原版一致。 */
export const SMELT_REGRESS_PER_TICK = 2;
