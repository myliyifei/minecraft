import { isSlotIndex } from './inventory';
import {
  isUnstackable,
  stackLimit,
  withCount,
  withoutOne,
  type ItemStack,
  type ItemType,
  type SlotBatch,
  type SlotStore,
} from './item';
import {
  hasIngredients,
  ingredientMatches,
  layoutRecipe,
  recipesFor,
  type Ingredient,
  type Recipe,
} from './recipe';
import type { Crafting, RuledSlotBatch, SmeltingProgress, SlotRules } from './slot-batch';

/**
 * 光标上拿着的那一堆，以及它是从哪一格拿起来的。
 *
 * 两样合成一个而不是两个字段：光标空着的时候「从哪儿拿的」没有意义，合起来类型上就
 * 没有「有东西却不知道从哪儿来」这种状态，也就不必写一段永远走不到的兜底。
 */
interface CursorHold {
  readonly stack: ItemStack;
  /**
   * 拿起它的那一格（界面里的格号，可能落在格子批上）。关闭界面时光标物品先回这一格。
   *
   * 记着它而不是一律走入包规则：玩家把第 20 格那一堆拿在手上按了背包键，东西回到第 20 格
   * 才是他预期的结果，而入包规则会把它塞进下标最小的空格里。
   *
   * 光标空着时从输出格、只取格拿的东西没有这一格（`undefined`）：两处都不收东西，关闭界面时
   * 光标上那一堆直接走入包规则。并进已有光标物品的成品与只取格物品不改变这一格。
   */
  readonly from: number | undefined;
}

/**
 * 配方书（见 CONTEXT.md）里的一条：哪条配方，此刻材料够不够。
 *
 * 「够不够」把背包 36 格与网格里的材料合计，光标物品不计入——光标上那一堆是玩家正拿着
 * 要放到别处的，不该被配方书顺手用掉。一组物品按组里每一种的合计判断（`hasIngredients`）：
 * 2 块橡木板加 2 块白桦木板够做工作台。
 */
export interface RecipeBookEntry {
  readonly recipe: Recipe;
  readonly craftable: boolean;
}

/** 界面里的一格落在哪一批格子的第几格上，以及那一批格子的规则。 */
interface SlotRef {
  readonly batch: SlotBatch;
  /** 那一批格子里的下标。 */
  readonly local: number;
  readonly rules: SlotRules;
}

/** 背包 36 格的规则：每格都收任何物品，没有只取格。 */
const INVENTORY_RULES: SlotRules = Object.freeze({
  accepts: () => true,
  isTakeOnly: () => false,
  taken: () => {},
});

/** 关闭界面时一样东西都不用交出去。共用一份，免得每次关界面都分配一个空数组。 */
const NO_LEFTOVERS: readonly ItemStack[] = Object.freeze([]);

/**
 * 合成网格与输出格的只读视图：网格几列几行、各格摆了什么、输出格显示什么。
 *
 * 界面层据此画网格与输出格。网格的格号从 `firstSlot` 起按行连续编号——点第 i 格递的是
 * `firstSlot + i`，「网格格号接在背包之后」这条规则因此只在核心里写一遍。
 */
export interface CraftingView {
  readonly width: number;
  readonly height: number;
  /** 网格第 0 格在界面里的格号。 */
  readonly firstSlot: number;
  /** 网格第 local 格里的那一堆，空格是 undefined。 */
  slot(local: number): ItemStack | undefined;
  /** 输出格（见 CONTEXT.md）里显示的成品，不匹配任何配方时 undefined。 */
  readonly output: ItemStack | undefined;
  /**
   * 配方书：这块网格能做的全部配方，顺序固定，每条带着此刻材料够不够。点第 i 条递的是
   * `InventoryScreen.clickRecipe(i)`。
   */
  readonly recipes: ReadonlyArray<RecipeBookEntry>;
}

/**
 * 熔炉三格与两条进度条的只读视图：各格摆了什么、燃料还剩多少、这件炼到几分之几。
 *
 * 界面层据此画三格与进度条。格号与 `CraftingView` 同一条规则：第 local 格在界面里是
 * `firstSlot + local`，哪一格是原料、燃料、成品见 `FURNACE_INPUT_SLOT` 那三个下标。
 */
export interface SmeltingView extends SmeltingProgress {
  /** 三格里第 0 格在界面里的格号。 */
  readonly firstSlot: number;
  /** 第 local 格里的那一堆，空格是 undefined。 */
  slot(local: number): ItemStack | undefined;
}

/** 背包界面的只读视图。界面层读它画覆盖层。 */
export interface InventoryScreenView {
  /** 界面开着没有。开着时核心处于界面模式（见 CONTEXT.md）。 */
  readonly open: boolean;
  /** 光标物品（见 CONTEXT.md）：拿在鼠标上的那一堆，没拿着东西时 undefined。 */
  readonly cursor: ItemStack | undefined;
  /** 合成网格与输出格，附加的格子批没有合成能力（或没有附加格子批）时 undefined。 */
  readonly crafting: CraftingView | undefined;
  /** 熔炉三格与两条进度条，附加的格子批没有熔炼进度（或没有附加格子批）时 undefined。 */
  readonly smelting: SmeltingView | undefined;
}

/**
 * 背包界面（见 CONTEXT.md）：开合，以及光标物品这套拿起放下的操作。
 *
 * 工作台界面也是这个类的一个实例：它同样摆出全部 36 个背包格子，只是附加的合成网格是
 * 3x3 而不是 2x2。熔炉界面是第三个：附加的是熔炉三格（`FurnaceSlots`），没有合成网格。三者的
 * 差别全在构造时传进来的那个格子批上，开合、光标、归还一套规则。
 *
 * 状态放在核心而不是界面层：界面模式一开，移动、视角、挖掘、放置就都不算数了
 * （规则在 `GameCore.step`），这是游戏规则，不是一个 DOM 覆盖层的显隐。
 *
 * 界面里的格子可以不止背包那 36 格：构造时附加一个格子批（`RuledSlotBatch`），格号接在
 * 背包之后编号。普通格的拿起、放下、合并、交换四种结果与背包格完全一样，只是放下、合并、
 * 交换之前先按那一格的规则判定收不收；只取格另有一条规则（`takeFrom`）。界面层因此仍然只递格号，
 * 不必知道那一格属于哪一批、是哪种格。输出格不在这批格号里——它不存东西，点它是另一条
 * 指令（`clickOutput`）。
 */
export class InventoryScreen implements InventoryScreenView {
  private readonly slots: SlotStore;
  /** 附加的那个格子批，没有就是 undefined。 */
  private readonly extra: RuledSlotBatch | undefined;
  /** 配方书列的那几条：配方表里摆得进附加网格的，顺序固定。没有合成能力就是空的。 */
  private readonly bookRecipes: ReadonlyArray<Recipe>;
  private isOpen = false;
  private holding: CursorHold | undefined;

  /**
   * 网格与输出格的视图，构造时造一次。它比网格本身多知道一件事——网格第 0 格在界面里
   * 是第几格——其余都是网格自己的，所以它只是网格的一个只读包装，不另存状态。
   */
  readonly crafting: CraftingView | undefined;

  /** 熔炉三格与进度条的视图，构造时造一次，理由同 `crafting`。 */
  readonly smelting: SmeltingView | undefined;

  constructor(slots: SlotStore, extra?: RuledSlotBatch) {
    this.slots = slots;
    this.extra = extra;
    const crafting = extra?.crafting;
    this.bookRecipes = crafting ? recipesFor(crafting) : [];
    this.crafting =
      extra && crafting && craftingView(crafting, extra, slots, this.bookRecipes, slots.size);
    const smelting = extra?.smelting;
    this.smelting = extra && smelting && smeltingView(smelting, extra, slots.size);
  }

  get open(): boolean {
    return this.isOpen;
  }

  get cursor(): ItemStack | undefined {
    return this.holding?.stack;
  }

  /** 界面里一共有多少格：背包那些加上附加的那批。 */
  private get size(): number {
    return this.slots.size + (this.extra?.size ?? 0);
  }

  /**
   * 开合界面。关闭时光标上的东西退回背包；`returnsOnClose` 为 true 的格子批，里面的东西也
   * 退回背包。返回一格都放不下的那些——调用方负责把它们扔到世界里，物品因此不会凭空消失。
   *
   * 返回的是一批而不是一堆：附加格子里可以摆着好几种物品，背包满了它们各自无处可去。
   */
  toggle(): readonly ItemStack[] {
    this.isOpen = !this.isOpen;
    return this.isOpen ? NO_LEFTOVERS : this.putEverythingBack();
  }

  /**
   * 点一格。普通格四种结果，与原版一致：
   *
   * - 光标空、格里有东西：拿起整堆，那一格空了。
   * - 光标有东西、格是空的：整堆放下。
   * - 两边同一类型：并进那一格，超过堆叠上限的余量留在光标上。
   * - 两边不同类型，或两边是同一类型的工具（堆叠上限 1）：交换。
   *
   * 后三种都要往格里放东西，先按那一格的规则判定收不收（`SlotRules.accepts`）：不收时什么都不改变，
   * 光标上的东西还在。只取格走另一条规则（`takeFrom`）。
   *
   * 界面关着、下标指不到格子、两边都是空的时候什么都不发生。
   */
  clickSlot(index: number): void {
    if (!this.isOpen) return;
    // 这一条要挡在这里而不是只靠 `setSlot`：写不进去时下面那段仍会把光标清空，
    // 光标上那一堆就没了。
    const ref = this.locate(index);
    if (!ref) return;
    if (ref.rules.isTakeOnly(ref.local)) {
      this.takeFrom(ref);
      return;
    }

    const inSlot = ref.batch.slot(ref.local);
    const holding = this.holding;

    if (!holding) {
      if (!inSlot) return;
      this.holding = { stack: inSlot, from: index };
      ref.batch.setSlot(ref.local, undefined);
      return;
    }

    const cursor = holding.stack;
    if (!ref.rules.accepts(ref.local, cursor.item)) return;

    // 不同类型要换手，`mergeInto` 表达不了这一种，单独一条。换来的那一堆是从这一格拿的，
    // 所以「从哪儿拿的」跟着换。两把同一类型的工具也走这条：并不进去，「满了所以没有任何反应」
    // 对可堆叠物品是对的，对工具玩家要的是换一把（见 `isUnstackable`）。
    if (inSlot && (inSlot.item !== cursor.item || isUnstackable(cursor.item))) {
      ref.batch.setSlot(ref.local, cursor);
      this.holding = { stack: inSlot, from: index };
      return;
    }

    // 空格接下整堆，同一类型并到堆叠上限；那一格已经满了就一个都不动。
    const left = this.mergeInto(index, cursor);
    if (left === cursor.count) return;
    this.keepOnCursor(holding, left);
  }

  /**
   * 拆堆点击一格（右键），普通格与原版一致：
   *
   * - 光标空、格里有东西：拿起一半（向上取整），其余留在格里。4 块拿 2 块、3 块拿 2 块、
   *   1 块拿 1 块。
   * - 光标有东西、格是空的，或格里是同一类型且未满：放下 1 个。
   * - 其余（光标空且格空、格已满、两边不同类型、那一格不收这种物品）什么都不改变——这里
   *   没有交换。
   *
   * 只取格没有拆堆：对它按拆堆键与普通点击相同（`takeFrom`），成品不会被拆成半堆留在格里。
   *
   * 工具的堆叠上限是 1，规则不必另写：光标空着时「一半向上取整」就是整把；光标上有工具时
   * 对空格放下这一把；格里是同一类型的工具则视为已满，与 `clickSlot` 的交换不同。
   *
   * 拿起的半堆记着来源格；放下 1 个不改变来源格（与 `clickSlot` 的合并一样）。
   * 界面关着、下标指不到格子时什么都不改变。
   *
   * 与 `clickSlot` 是两个方法而不是一个带参数的方法：两者只有开头的定位与结尾的余量处理相同，
   * 中间的规则没有一条一样，合成一个只会多出一层分支。
   */
  splitSlot(index: number): void {
    if (!this.isOpen) return;
    const ref = this.locate(index);
    if (!ref) return;
    if (ref.rules.isTakeOnly(ref.local)) {
      this.takeFrom(ref);
      return;
    }

    const inSlot = ref.batch.slot(ref.local);
    const holding = this.holding;

    if (!holding) {
      if (!inSlot) return;
      const taken = Math.ceil(inSlot.count / 2);
      this.holding = { stack: withCount(inSlot, taken), from: index };
      const rest = inSlot.count - taken;
      ref.batch.setSlot(ref.local, rest > 0 ? withCount(inSlot, rest) : undefined);
      return;
    }

    // 只传 1 个给 `mergeInto`：空格、同一类型未满的格并入它，其余情形一个都不并入。
    if (this.mergeInto(index, withCount(holding.stack, 1)) > 0) return;
    this.keepOnCursor(holding, holding.stack.count - 1);
  }

  /**
   * 点只取格（见 CONTEXT.md），点击与拆堆同一条规则：
   *
   * - 光标空着：整堆到光标上，那一格空了。
   * - 光标上是同一类型：并到堆叠上限，并不完的留在格里。工具的堆叠上限是 1，一个都并不进去。
   * - 光标上是别的东西，或格空着：什么都不改变，没有交换也没有放下。
   *
   * 光标空着时拿起的那一堆没有「原格」（`CursorHold.from` 为 undefined）：只取格不收东西，关闭界面
   * 时它直接走入包规则。并进光标的那部分则跟着光标原来的来源格——从背包第 20 格拿起的木板并进了
   * 只取格里的几块，关闭时整堆回第 20 格。两条都与输出格的成品相同（`clickOutput`）。
   *
   * 取走之后告诉格子批取走了几个（`SlotRules.taken`）：熔炉按这个数结算成品的经验。
   */
  private takeFrom(ref: SlotRef): void {
    const inSlot = ref.batch.slot(ref.local);
    if (!inSlot) return;
    const holding = this.holding;

    if (!holding) {
      this.holding = { stack: inSlot, from: undefined };
      ref.batch.setSlot(ref.local, undefined);
      ref.rules.taken(ref.local, inSlot.count);
      return;
    }

    const cursor = holding.stack;
    if (cursor.item !== inSlot.item) return;
    const moved = Math.min(stackLimit(cursor.item) - cursor.count, inSlot.count);
    if (moved <= 0) return;
    this.holding = { stack: withCount(cursor, cursor.count + moved), from: holding.from };
    const rest = inSlot.count - moved;
    ref.batch.setSlot(ref.local, rest > 0 ? withCount(inSlot, rest) : undefined);
    ref.rules.taken(ref.local, moved);
  }

  /**
   * 光标上那一堆放下一部分之后，余量仍留在光标上；放光了光标就清空。
   * 余量仍记着原来那一格：放下一部分不改变「这一堆是从哪儿拿的」。
   */
  private keepOnCursor(holding: CursorHold, left: number): void {
    this.holding =
      left > 0 ? { stack: withCount(holding.stack, left), from: holding.from } : undefined;
  }

  /**
   * 点输出格：把成品拿到光标上，网格每个非空格各消耗 1 个。
   *
   * 三种情形：光标空着，成品整份到光标上；光标上是同一类型且装得下整份，并上去；其余
   * （不同类型、同一类型但装不下、输出格空着、界面关着）一个都不动。装不下整份时不合成半份：
   * 成品与消耗的材料是一对，并进去 3 块而消耗 1 个原木就不守恒了。
   *
   * 从这里拿到的成品没有「原格」：关闭界面时它直接走入包规则（见 `CursorHold.from`）。
   */
  clickOutput(): void {
    if (!this.isOpen) return;
    const crafting = this.extra?.crafting;
    const output = crafting?.output;
    if (!crafting || !output) return;

    const holding = this.holding;
    if (!holding) {
      this.holding = { stack: output, from: undefined };
      crafting.consumeOne();
      return;
    }
    const cursor = holding.stack;
    if (cursor.item !== output.item) return;
    if (cursor.count + output.count > stackLimit(output.item)) return;
    this.holding = {
      stack: withCount(cursor, cursor.count + output.count),
      from: holding.from,
    };
    crafting.consumeOne();
  }

  /**
   * 点配方书的第 index 条：把它的材料填入网格，输出格随即显示成品。
   *
   * 三步：网格里原有的物品先退回背包；再按图案（靠左上角对齐、不镜像）逐格从背包取出
   * 材料，每格 1 个，取的顺序按格号从小到大，每格从背包里格号最小的、满足这格材料的那一堆取——
   * 木板组的格子因此可能各填一种木板；材料够不够按背包与网格合计、光标不计入，木板组按三种木板
   * 合计（`RecipeBookEntry`、`hasIngredients`），不足的那条点了没有任何反应。界面关着、没有网格、
   * 下标指不到配方时同样没有任何反应。
   *
   * 写明单个物品的格子先填、一组物品的格子后填，各自仍按格号从小到大：组的格子先填可能把某个单个物品
   * 格要的那种物品拿走。现有配方里组与单个物品不重叠（木板组与木棍），两种顺序填出来一样。
   *
   * 网格里的物品退不完背包（36 格全满）时不填入材料，退不回去的留在原格：材料够是按
   * 「网格里的也算」判的，退不回去就取不到，硬填会把两处的材料混在一起。
   */
  clickRecipe(index: number): void {
    if (!this.isOpen) return;
    const grid = this.extra;
    const crafting = grid?.crafting;
    const recipe = isSlotIndex(index, this.bookRecipes.length)
      ? this.bookRecipes[index]
      : undefined;
    if (!grid || !crafting || !recipe) return;
    if (!hasIngredients(recipe, countItems(this.slots, grid))) return;
    if (!this.returnGrid(grid)) return;

    const layout = layoutRecipe(recipe, crafting);
    for (const groups of [false, true]) {
      for (let i = 0; i < layout.length; i++) {
        const ingredient = layout[i];
        if (ingredient === undefined || (typeof ingredient !== 'number') !== groups) continue;
        const item = this.takeOneFromSlots(ingredient);
        if (item !== undefined) grid.setSlot(i, { item, count: 1 });
      }
    }
  }

  /**
   * 网格里的物品退回背包，返回是不是一件都没剩。退不回去的那部分留在原格。
   *
   * 与关闭界面时的归还（`putEverythingBack`）不同：那边回不去的要交出去扔到脚下，这边界面
   * 还开着，东西留在网格里玩家看得见、拿得到。
   */
  private returnGrid(grid: SlotBatch): boolean {
    let allReturned = true;
    for (let i = 0; i < grid.size; i++) {
      const stack = grid.slot(i);
      if (!stack) continue;
      const spare = this.slots.add(stack);
      grid.setSlot(i, spare > 0 ? withCount(stack, spare) : undefined);
      if (spare > 0) allReturned = false;
    }
    return allReturned;
  }

  /**
   * 从背包格号最小的、满足这份材料的那一堆里拿走 1 个，返回拿走的是哪种物品。调用方已确认背包里有；
   * 万一没有返回 undefined。
   */
  private takeOneFromSlots(ingredient: Ingredient): ItemType | undefined {
    for (let i = 0; i < this.slots.size; i++) {
      const stack = this.slots.slot(i);
      if (!stack || !ingredientMatches(ingredient, stack.item)) continue;
      this.slots.setSlot(i, withoutOne(stack));
      return stack.item;
    }
    return undefined;
  }

  /**
   * 第 index 格落在哪一批格子的第几格上，指不到格子时 undefined。
   *
   * 附加格子的格号接在背包之后：背包 36 格时第 36 格就是格子批的第 0 格。
   * 小数与 NaN 由 `isSlotIndex` 挡掉——界面层递过来的是 DOM 属性读出来的数字。
   */
  private locate(index: number): SlotRef | undefined {
    if (!isSlotIndex(index, this.size)) return undefined;
    const local = index - this.slots.size;
    if (local < 0) return { batch: this.slots, local: index, rules: INVENTORY_RULES };
    const extra = this.extra;
    return extra ? { batch: extra, local, rules: extra } : undefined;
  }

  /**
   * 关闭界面时把东西都退回背包，返回一格都放不下的那些。
   *
   * 顺序是先光标物品（回拿起它的那一格），再格子批按格号从小到大。这个顺序有讲究：
   * 光标上那一堆可能就是从格子批里拿起来的，先回原格再让格子批清空，它才跟着进背包，
   * 而不是留在一个已经关掉的界面里。
   *
   * `returnsOnClose` 为 false 的格子批，里面的东西原地不动：熔炉里的原料与成品关掉界面还在熔炉里。
   */
  private putEverythingBack(): readonly ItemStack[] {
    const leftovers: ItemStack[] = [];
    const fromCursor = this.putCursorBack();
    if (fromCursor) leftovers.push(fromCursor);

    const extra = this.extra;
    if (extra?.returnsOnClose) {
      for (let i = 0; i < extra.size; i++) {
        const stack = extra.slot(i);
        if (!stack) continue;
        extra.setSlot(i, undefined);
        const spare = this.slots.add(stack);
        if (spare > 0) leftovers.push(withCount(stack, spare));
      }
    }
    return leftovers;
  }

  /**
   * 光标物品退回背包：先试拿起它的那一格，剩下的走入包规则（同一类型未满堆 → 第一个空格）。
   * 从输出格、只取格拿的东西没有原格，直接走入包规则。返回一格都放不下的那些，并把光标清空。
   */
  private putCursorBack(): ItemStack | undefined {
    const holding = this.holding;
    this.holding = undefined;
    if (!holding) return undefined;

    const { stack, from } = holding;
    const left = from === undefined ? stack.count : this.mergeInto(from, stack);
    if (left === 0) return undefined;
    const spare = this.slots.add(withCount(stack, left));
    return spare > 0 ? withCount(stack, spare) : undefined;
  }

  /**
   * 把一堆物品并进某一格，返回没并进去的数量。
   * 空格接下整堆，同一类型的填到堆叠上限；不同类型、已经满了的、不收这种物品的、只取的
   * 与指不到的格子一个都不接。
   */
  private mergeInto(index: number, stack: ItemStack): number {
    const ref = this.locate(index);
    if (!ref || !admits(ref, stack.item)) return stack.count;
    const inSlot = ref.batch.slot(ref.local);
    if (!inSlot) {
      ref.batch.setSlot(ref.local, stack);
      return 0;
    }
    if (inSlot.item !== stack.item) return stack.count;
    const room = stackLimit(stack.item) - inSlot.count;
    if (room <= 0) return stack.count;
    const moved = Math.min(room, stack.count);
    ref.batch.setSlot(ref.local, withCount(inSlot, inSlot.count + moved));
    return stack.count - moved;
  }
}

/** 这一格能不能往里放这种物品：不是只取格，而且收这种物品。 */
function admits(ref: SlotRef, item: ItemType): boolean {
  return !ref.rules.isTakeOnly(ref.local) && ref.rules.accepts(ref.local, item);
}

/**
 * 给一个带合成能力的格子批包一层界面层要的只读视图：格号从 `firstSlot` 起。
 *
 * 配方书那一列每次读都当场算，与输出格同一个理由：材料在背包与网格之间移动、拾取也往
 * 背包里进，记一份就得在每处改动后去刷，而配方就那么几条，重算一次的开销很小。
 */
function craftingView(
  crafting: Crafting,
  grid: SlotBatch,
  slots: SlotStore,
  recipes: ReadonlyArray<Recipe>,
  firstSlot: number,
): CraftingView {
  return {
    width: crafting.width,
    height: crafting.height,
    firstSlot,
    slot: (local) => grid.slot(local),
    get output() {
      return crafting.output;
    },
    get recipes() {
      const available = countItems(slots, grid);
      return recipes.map((recipe) => ({ recipe, craftable: hasIngredients(recipe, available) }));
    },
  };
}

/** 给一个带熔炼进度的格子批包一层界面层要的只读视图：格号从 `firstSlot` 起。 */
function smeltingView(smelting: SmeltingProgress, batch: SlotBatch, firstSlot: number): SmeltingView {
  return {
    firstSlot,
    slot: (local) => batch.slot(local),
    get fuelRatio() {
      return smelting.fuelRatio;
    },
    get progressRatio() {
      return smelting.progressRatio;
    },
  };
}

/** 几批格子里每种物品各有多少个，合在一张表里。 */
function countItems(...batches: ReadonlyArray<SlotBatch>): Map<ItemType, number> {
  const counts = new Map<ItemType, number>();
  for (const batch of batches) {
    for (let i = 0; i < batch.size; i++) {
      const stack = batch.slot(i);
      if (stack) counts.set(stack.item, (counts.get(stack.item) ?? 0) + stack.count);
    }
  }
  return counts;
}

