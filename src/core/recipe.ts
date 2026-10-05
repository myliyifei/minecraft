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
 * 一组物品（见 CONTEXT.md 的「配方」，#85）：配方里的一格写它时，组里任意一种都匹配，同一个配方里的
 * 几格可以各摆组里不同的一种。目前只有木板组（`PLANKS`）。
 *
 * 写成带 `kind` 的对象而不是物品数组：配方格里的单个物品是编号，组是对象，两者可按类型区分，
 * `ingredientMatches` 按 `typeof` 分派。
 *
 * 配方书判材料够不够、填入材料时假定组与组之间没有共同的物品，也不与同一条配方里写明的单个物品重叠
 * （`hasIngredients`、`InventoryScreen.clickRecipe`）。木板组与木棍、圆石、铁锭都不重叠。
 */
export interface ItemGroup {
  readonly kind: 'group';
  readonly items: ReadonlyArray<ItemType>;
}

/** 木板组：橡木、白桦、云杉三种木板。木棍、工作台与木制的镐、斧、铲、剑都用它。 */
export const PLANKS: ItemGroup = Object.freeze({
  kind: 'group',
  items: Object.freeze([ItemType.OakPlanks, ItemType.BirchPlanks, ItemType.SprucePlanks]),
});

/** 配方里的一格要什么：一种物品，或一组物品里的任意一种。 */
export type Ingredient = ItemType | ItemGroup;

/** 这一格摆的物品满足这份材料要求吗：单个物品要正好是它，一组物品要是组里的一种。 */
export function ingredientMatches(ingredient: Ingredient, item: ItemType): boolean {
  return typeof ingredient === 'number' ? ingredient === item : ingredient.items.includes(item);
}

/**
 * 有序配方的图案：几行，每行几格，格里是哪种材料（一种物品或一组物品）或空着。各行长度必须相等。
 *
 * 写成二维数组而不是原版那种「字符画 + 图例」：配方就那么几条，多一层图例只是多一处
 * 对不上的可能。
 */
export type Pattern = ReadonlyArray<ReadonlyArray<Ingredient | undefined>>;

/** 网格裁到非空格的最小包围矩形之后的样子：几行，每行几格，格里是摆的物品或空着。 */
type Placed = ReadonlyArray<ReadonlyArray<ItemType | undefined>>;

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
  readonly ingredients: ReadonlyArray<Ingredient>;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

/** 成品只有一个的配方（工作台、工具）的成品那一栏。 */
function one(item: ItemType): ItemStack {
  return { item, count: 1 };
}

/** 一档工具：头部用哪种材料，造出来的镐、斧、铲、剑各是哪种物品。 */
interface ToolTier {
  readonly head: Ingredient;
  readonly pickaxe: ItemType;
  readonly axe: ItemType;
  readonly shovel: ItemType;
  readonly sword: ItemType;
}

/**
 * 一档工具的四条配方：头部用 `head` 材料、柄是木棍。木制用木板组，石制用圆石，铁制用铁锭，
 * 四条图案不变——所以图案只写一遍，材料当参数传进来。
 *
 * 镐、铲与剑的图案左右对称，镜像与否结果相同，写 false；斧的刃只在一边，左右镜像的摆法也算。
 * 四条都是三行，摆不进 2x2：只能在工作台里做。
 */
function toolRecipes({ head, pickaxe, axe, shovel, sword }: ToolTier): Recipe[] {
  const S = ItemType.Stick;
  return [
    {
      kind: 'shaped',
      result: one(pickaxe),
      pattern: [
        [head, head, head],
        [undefined, S, undefined],
        [undefined, S, undefined],
      ],
      mirrored: false,
    },
    {
      kind: 'shaped',
      result: one(axe),
      pattern: [
        [head, head],
        [head, S],
        [undefined, S],
      ],
      mirrored: true,
    },
    {
      kind: 'shaped',
      result: one(shovel),
      pattern: [[head], [S], [S]],
      mirrored: false,
    },
    // 剑（#45）：两格材料竖排在上、一根木棍在下。木板那一档与木棍配方不冲突：多了一根木棍，
    // 包围矩形是 3 行，木棍配方是 2 行。
    {
      kind: 'shaped',
      result: one(sword),
      pattern: [[head], [head], [S]],
      mirrored: false,
    },
  ];
}

/**
 * 配方表——纯数据（见 CONTEXT.md 的「合成」）。加配方只加一条。
 *
 * 目前有三种原木各出自己的木板三条、木板出木棍、木板出工作台，加木、石、铁三档各四件（镐、斧、铲、剑），
 * 再加圆石出熔炉、煤炭与木炭各出火把。用到木板的配方写木板组（#85），三种木板任意混用，配方书里各只列一条。
 * 金、钻石那两档各再加一组 `toolRecipes`。
 */
export const RECIPES: ReadonlyArray<Recipe> = [
  // 三种原木各出 4 块自己那种木板（#85）：原木不是一组，白桦原木出不了橡木板。
  ...(
    [
      [ItemType.OakLog, ItemType.OakPlanks],
      [ItemType.BirchLog, ItemType.BirchPlanks],
      [ItemType.SpruceLog, ItemType.SprucePlanks],
    ] as const
  ).map(
    ([log, planks]): Recipe => ({
      kind: 'shapeless',
      result: { item: planks, count: 4 },
      ingredients: [log],
    }),
  ),
  // 两块木板竖排出 4 根木棍。图案上下对称也左右对称，镜像与否结果相同，写 false。
  {
    kind: 'shaped',
    result: { item: ItemType.Stick, count: 4 },
    pattern: [[PLANKS], [PLANKS]],
    mirrored: false,
  },
  // 四块木板摆成方形出一个工作台。方形四向对称，镜像与否结果相同，写 false。
  {
    kind: 'shaped',
    result: one(ItemType.CraftingTable),
    pattern: [
      [PLANKS, PLANKS],
      [PLANKS, PLANKS],
    ],
    mirrored: false,
  },
  ...toolRecipes({
    head: PLANKS,
    pickaxe: ItemType.WoodenPickaxe,
    axe: ItemType.WoodenAxe,
    shovel: ItemType.WoodenShovel,
    sword: ItemType.WoodenSword,
  }),
  // 石制三件：图案与木制那三条一模一样，头部的木板换成圆石（#23）。
  ...toolRecipes({
    head: ItemType.Cobblestone,
    pickaxe: ItemType.StonePickaxe,
    axe: ItemType.StoneAxe,
    shovel: ItemType.StoneShovel,
    sword: ItemType.StoneSword,
  }),
  // 铁制三件：图案不变，头部换成铁锭（#32）。
  ...toolRecipes({
    head: ItemType.IronIngot,
    pickaxe: ItemType.IronPickaxe,
    axe: ItemType.IronAxe,
    shovel: ItemType.IronShovel,
    sword: ItemType.IronSword,
  }),
  // 8 块圆石围一圈、中心空着出一个熔炉（#30）。图案占满 3x3，只在工作台里做得出；
  // 四向对称，镜像与否结果相同，写 false。
  {
    kind: 'shaped',
    result: one(ItemType.Furnace),
    pattern: [
      [ItemType.Cobblestone, ItemType.Cobblestone, ItemType.Cobblestone],
      [ItemType.Cobblestone, undefined, ItemType.Cobblestone],
      [ItemType.Cobblestone, ItemType.Cobblestone, ItemType.Cobblestone],
    ],
    mirrored: false,
  },
  // 火把（#56）：一块煤炭或木炭竖排在一根木棍上面，各出 4 支。图案 1 列 2 行，2x2 与 3x3 都做得出；
  // 左右对称，镜像与否结果相同，写 false。配方书里两条，名称都是「火把」。
  ...[ItemType.Coal, ItemType.Charcoal].map(
    (fuel): Recipe => ({
      kind: 'shaped',
      result: { item: ItemType.Torch, count: 4 },
      pattern: [[fuel], [ItemType.Stick]],
      mirrored: false,
    }),
  ),
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

/**
 * 配方书（见 CONTEXT.md）列出的配方：配方表里摆得进这么大网格的那些，顺序照配方表。
 *
 * 顺序稳定是有用的：配方书里第 i 条就是这个数组的第 i 项，点第 i 条递的就是 i。
 */
export function recipesFor(size: GridSize, recipes: ReadonlyArray<Recipe> = RECIPES): Recipe[] {
  return recipes.filter((recipe) => recipeFits(recipe, size));
}

/**
 * 一条配方要哪些材料、各几份。有序配方数图案里的非空格，无序配方数材料表。一组物品按组计数，
 * 不拆成组里的每一种：工作台要的是「木板组 4 份」，不是橡木、白桦、云杉各几块。
 *
 * 配方书判「材料够不够」看的就是这张表（`hasIngredients`）。
 */
export function ingredientCounts(recipe: Recipe): Map<Ingredient, number> {
  const counts = new Map<Ingredient, number>();
  const cells = recipe.kind === 'shapeless' ? recipe.ingredients : recipe.pattern.flat();
  for (const ingredient of cells) {
    if (ingredient === undefined) continue;
    counts.set(ingredient, (counts.get(ingredient) ?? 0) + 1);
  }
  return counts;
}

/**
 * 手上这些物品（每种各有几个）够做这条配方吗。配方书的高亮与点击拦截都用它。
 *
 * 先扣写明的单个物品，再扣一组物品：组按组里每一种的合计算，2 块橡木板加 2 块白桦木板够工作台
 * 要的 4 份木板组。按这个顺序扣，是因为单个物品只能由它自己满足，组还可以换组里别的一种。
 * 组与组、组与单个物品之间不重叠（见 `ItemGroup`），所以这样扣不会把够的判成不够。
 */
export function hasIngredients(recipe: Recipe, available: ReadonlyMap<ItemType, number>): boolean {
  const left = new Map(available);
  const needs = [...ingredientCounts(recipe)].sort(([a], [b]) => groupLast(a) - groupLast(b));
  for (const [ingredient, needed] of needs) {
    let missing = needed;
    for (const item of typeof ingredient === 'number' ? [ingredient] : ingredient.items) {
      const taken = Math.min(missing, left.get(item) ?? 0);
      left.set(item, (left.get(item) ?? 0) - taken);
      missing -= taken;
    }
    if (missing > 0) return false;
  }
  return true;
}

/** 排序键：单个物品排在一组物品前面。 */
function groupLast(ingredient: Ingredient): number {
  return typeof ingredient === 'number' ? 0 : 1;
}

/**
 * 配方书自动填入材料时网格各格要什么材料：图案靠左上角对齐、不镜像；无序配方的材料从左上角
 * 起按行排开。每格是一种物品或一组物品，数量都是 1——每格只填 1 个；一组物品的格子填组里哪一种
 * 由取料的那一方决定（`InventoryScreen.clickRecipe`）。调用方要先用 `recipeFits` 确认摆得进去。
 */
export function layoutRecipe(recipe: Recipe, size: GridSize): ReadonlyArray<Ingredient | undefined> {
  const contents = Array<Ingredient | undefined>(size.width * size.height).fill(undefined);
  if (recipe.kind === 'shapeless') {
    recipe.ingredients.forEach((item, i) => {
      contents[i] = item;
    });
    return contents;
  }
  recipe.pattern.forEach((row, r) => {
    row.forEach((ingredient, c) => {
      contents[r * size.width + c] = ingredient;
    });
  });
  return contents;
}

/** 图案有几列。各行等长，看第一行就够；没有行的图案是 0 列。 */
function patternWidth(pattern: Pattern | Placed): number {
  return pattern[0]?.length ?? 0;
}

/**
 * 非空格的最小包围矩形，按行排列成一个小图案；一格都没摆时 undefined。
 *
 * 裁完之后有序配方的比对就是「两个图案相等吗」，网格多大、摆在哪儿都不再出现。
 */
function crop(contents: GridContents, size: GridSize): Placed | undefined {
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
function matches(recipe: Recipe, cropped: Placed): boolean {
  if (recipe.kind === 'shapeless') return sameIngredients(recipe.ingredients, cropped);
  if (samePattern(recipe.pattern, cropped)) return true;
  return recipe.mirrored && samePattern(recipe.pattern, mirror(cropped));
}

/**
 * 摆的图案与配方图案行列数相同、逐格一致：图案空着的格必须空着，有材料的格摆的物品要满足那份材料
 * （`ingredientMatches`）。木板组的几格因此各摆哪种木板都行。
 */
function samePattern(pattern: Pattern, placed: Placed): boolean {
  if (pattern.length !== placed.length || patternWidth(pattern) !== patternWidth(placed)) return false;
  return pattern.every((row, r) =>
    row.every((ingredient, c) => {
      const item = placed[r]![c];
      if (ingredient === undefined || item === undefined) return ingredient === item;
      return ingredientMatches(ingredient, item);
    }),
  );
}

/** 左右镜像：每一行倒过来。 */
function mirror(placed: Placed): Placed {
  return placed.map((row) => [...row].reverse());
}

/**
 * 摆的物品与所需材料能一一配上吗：份数相等，且每份材料都分到一件满足它的物品。
 *
 * 材料里有一组物品时不能再「两边排序逐个比」，改成逐份材料回溯找一件还没分出去的物品。
 * 无序配方最多 9 份材料，回溯的开销可以忽略。
 */
function sameIngredients(ingredients: ReadonlyArray<Ingredient>, cropped: Placed): boolean {
  const placed = cropped.flat().filter((cell): cell is ItemType => cell !== undefined);
  if (placed.length !== ingredients.length) return false;
  const used = Array<boolean>(placed.length).fill(false);
  const assign = (next: number): boolean => {
    if (next === ingredients.length) return true;
    for (let i = 0; i < placed.length; i++) {
      if (used[i] || !ingredientMatches(ingredients[next]!, placed[i]!)) continue;
      used[i] = true;
      if (assign(next + 1)) return true;
      used[i] = false;
    }
    return false;
  };
  return assign(0);
}
