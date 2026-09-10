import { ItemType, type ItemStack } from './item';

/** 一块合成网格有几列几行。背包界面的是 2x2，工作台界面的是 3x3。 */
export interface GridSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 网格里每格摆的是哪种物品，按行排列：第 i 格在第 ⌊i ÷ width⌋ 行、第 i mod width 列，
 * 空格是 undefined。
 *
 * 只有种类没有数量：配方看的是「摆了什么」，一格里摆 1 个还是 64 个匹配结果相同，
 * 数量在拿走成品那一步才起作用（`CraftingGrid.consumeOne`）。
 */
export type GridContents = ReadonlyArray<ItemType | undefined>;

/**
 * 有序配方的图案：几行，每行几格，格里是哪种物品或空着。各行长度必须相等。
 *
 * 写成二维数组而不是原版那种「字符画 + 图例」：配方就那么几条，多一层图例只是多一处
 * 对不上的可能。
 */
export type Pattern = ReadonlyArray<ReadonlyArray<ItemType | undefined>>;

/** 有序配方：材料要按图案摆。图案可以摆在网格里任意位置，允许镜像的还可以左右翻过来。 */
export interface ShapedRecipe {
  readonly kind: 'shaped';
  readonly result: ItemStack;
  readonly pattern: Pattern;
  /** 左右镜像的摆法也算匹配。斧头那类不对称的图案是 true，镐与铲本身对称，写 false。 */
  readonly mirrored: boolean;
}

/** 无序配方：材料摆在哪儿都行，只看非空格里的材料多重集是否正好等于这一份。 */
export interface ShapelessRecipe {
  readonly kind: 'shapeless';
  readonly result: ItemStack;
  /** 所需材料，同一种要几份就写几遍。 */
  readonly ingredients: ReadonlyArray<ItemType>;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

/**
 * 配方表——纯数据（见 CONTEXT.md 的「合成」）。加配方只加一条。
 *
 * 目前有原木出木板、木板出木棍、木板出工作台三条。六件工具（#21、#23）随各自的票加进来。
 */
export const RECIPES: ReadonlyArray<Recipe> = [
  {
    kind: 'shapeless',
    result: { item: ItemType.OakPlanks, count: 4 },
    ingredients: [ItemType.OakLog],
  },
  // 两块木板竖排出 4 根木棍。图案上下对称也左右对称，镜像与否结果相同，写 false。
  {
    kind: 'shaped',
    result: { item: ItemType.Stick, count: 4 },
    pattern: [[ItemType.OakPlanks], [ItemType.OakPlanks]],
    mirrored: false,
  },
  // 四块木板摆成方形出一个工作台。方形四向对称，镜像与否结果相同，写 false。
  {
    kind: 'shaped',
    result: { item: ItemType.CraftingTable, count: 1 },
    pattern: [
      [ItemType.OakPlanks, ItemType.OakPlanks],
      [ItemType.OakPlanks, ItemType.OakPlanks],
    ],
    mirrored: false,
  },
];

/**
 * 这条配方摆得进这么大的网格吗。
 *
 * 有序配方看图案的行列数，无序配方看材料数——五样材料在 2x2 里摆不下。配方书（#20）
 * 按它过滤「当前网格尺寸能做的全部配方」；匹配器也先问它一句，图案比网格大的配方在
 * 那个网格里永远匹配不到。
 */
export function recipeFits(recipe: Recipe, size: GridSize): boolean {
  if (recipe.kind === 'shapeless') {
    return recipe.ingredients.length <= size.width * size.height;
  }
  return recipe.pattern.length <= size.height && patternWidth(recipe.pattern) <= size.width;
}

/**
 * 网格里摆的东西匹配哪条配方，给出成品与数量；一条都不匹配（含空网格）时 undefined。
 *
 * 规则：先把网格内容裁到非空格的最小包围矩形。有序配方要求包围矩形与图案（或其左右
 * 镜像，若允许）行列数相同、逐格相同——所以图案摆在网格哪个位置都行，而多摆一格无关
 * 材料会让包围矩形变大或多出一格，就不匹配了。无序配方要求非空格里的材料多重集与
 * 所需材料相等。
 *
 * 纯函数：没有跨 tick 的状态，与连锁挖掘的搜索一样单独成模块。`recipes` 默认是配方表，
 * 测试里换成自己构造的几条来验规则。
 */
export function matchRecipe(
  contents: GridContents,
  size: GridSize,
  recipes: ReadonlyArray<Recipe> = RECIPES,
): ItemStack | undefined {
  const cropped = crop(contents, size);
  if (!cropped) return undefined;
  for (const recipe of recipes) {
    if (!recipeFits(recipe, size)) continue;
    if (matches(recipe, cropped)) return recipe.result;
  }
  return undefined;
}

/** 图案有几列。各行等长，看第一行就够；没有行的图案是 0 列。 */
function patternWidth(pattern: Pattern): number {
  return pattern[0]?.length ?? 0;
}

/**
 * 非空格的最小包围矩形，按行排列成一个小图案；一格都没摆时 undefined。
 *
 * 裁完之后有序配方的比对就是「两个图案相等吗」，网格多大、摆在哪儿都不再出现。
 */
function crop(contents: GridContents, size: GridSize): Pattern | undefined {
  let top = size.height;
  let bottom = -1;
  let left = size.width;
  let right = -1;
  for (let row = 0; row < size.height; row++) {
    for (let col = 0; col < size.width; col++) {
      if (contents[row * size.width + col] === undefined) continue;
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
      left = Math.min(left, col);
      right = Math.max(right, col);
    }
  }
  if (bottom < 0) return undefined;

  const rows: Array<ReadonlyArray<ItemType | undefined>> = [];
  for (let row = top; row <= bottom; row++) {
    rows.push(contents.slice(row * size.width + left, row * size.width + right + 1));
  }
  return rows;
}

/** 裁好的图案匹配这条配方吗。有序的比形状（允许镜像时再比一次镜像），无序的比材料。 */
function matches(recipe: Recipe, cropped: Pattern): boolean {
  if (recipe.kind === 'shapeless') return sameIngredients(recipe.ingredients, cropped);
  if (samePattern(recipe.pattern, cropped)) return true;
  return recipe.mirrored && samePattern(recipe.pattern, mirror(cropped));
}

/** 两个图案行列数相同、逐格相同。 */
function samePattern(a: Pattern, b: Pattern): boolean {
  if (a.length !== b.length || patternWidth(a) !== patternWidth(b)) return false;
  return a.every((row, r) => row.every((cell, c) => cell === b[r]![c]));
}

/** 左右镜像：每一行倒过来。 */
function mirror(pattern: Pattern): Pattern {
  return pattern.map((row) => [...row].reverse());
}

/**
 * 图案里非空格的材料多重集，正好等于所需材料吗。
 *
 * 两边都按物品编号排好序再逐个比：材料是编号，排序之后同种的挨在一起，「各要几份」
 * 就在这一比里一起验了。
 */
function sameIngredients(ingredients: ReadonlyArray<ItemType>, cropped: Pattern): boolean {
  const placed = cropped.flat().filter((cell): cell is ItemType => cell !== undefined);
  if (placed.length !== ingredients.length) return false;
  const sortedPlaced = [...placed].sort((a, b) => a - b);
  const sortedNeeded = [...ingredients].sort((a, b) => a - b);
  return sortedPlaced.every((item, i) => item === sortedNeeded[i]);
}
