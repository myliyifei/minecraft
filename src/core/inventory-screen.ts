import { isSlotIndex } from './inventory';
import { stackLimit, type ItemStack, type SlotStore } from './item';

/** 背包界面的只读视图。界面层读它画覆盖层。 */
export interface InventoryScreenView {
  /** 界面开着没有。开着时核心处于界面模式（见 CONTEXT.md）。 */
  readonly open: boolean;
  /** 光标物品（见 CONTEXT.md）：拿在鼠标上的那一堆，没拿着东西时 undefined。 */
  readonly cursor: ItemStack | undefined;
}

/**
 * 背包界面（见 CONTEXT.md）：开合，以及光标物品这套拿起放下的操作。
 *
 * 状态放在核心而不是界面层：界面模式一开，移动、视角、挖掘、放置就都不算数了
 * （规则在 `GameCore.step`），这是游戏规则，不是一个 DOM 覆盖层的显隐。
 */
export class InventoryScreen implements InventoryScreenView {
  private readonly slots: SlotStore;
  private isOpen = false;
  private cursorStack: ItemStack | undefined;
  /**
   * 光标上这一堆是从哪一格拿起来的。关闭界面时它先回这一格。
   *
   * 记着它而不是一律走入包规则：玩家把第 20 格那一堆拿在手上按了 E，东西回到第 20 格
   * 才是他预期的结果，而入包规则会把它塞进下标最小的空格里。
   */
  private pickedFrom: number | undefined;

  constructor(slots: SlotStore) {
    this.slots = slots;
  }

  get open(): boolean {
    return this.isOpen;
  }

  get cursor(): ItemStack | undefined {
    return this.cursorStack;
  }

  /**
   * 开合界面。关闭时光标上的东西回背包，返回一格都放不下的那些（都放下了就 undefined）
   * ——调用方负责把它扔到世界里，物品因此不会凭空消失。
   */
  toggle(): ItemStack | undefined {
    this.isOpen = !this.isOpen;
    return this.isOpen ? undefined : this.putCursorBack();
  }

  /**
   * 点一格。四种结果，与原版一致：
   *
   * - 光标空、格里有东西：拿起整堆，那一格空了。
   * - 光标有东西、格是空的：整堆放下。
   * - 两边同种：并进那一格，超过堆叠上限的余量留在光标上。
   * - 两边异种：交换。
   *
   * 界面关着、下标指不到格子、两边都是空的时候什么都不发生。
   */
  clickSlot(index: number): void {
    if (!this.isOpen) return;
    // 这一条要挡在这里而不是只靠 `setSlot`：写不进去时下面那段仍会把光标清空，
    // 光标上那一堆就没了。
    if (!isSlotIndex(index, this.slots.size)) return;

    const inSlot = this.slots.slot(index);
    const cursor = this.cursorStack;

    if (!cursor) {
      if (!inSlot) return;
      this.cursorStack = inSlot;
      this.pickedFrom = index;
      this.slots.setSlot(index, undefined);
      return;
    }

    // 异种要换手，`mergeInto` 表达不了这一种，单独一条。
    if (inSlot && inSlot.item !== cursor.item) {
      this.slots.setSlot(index, cursor);
      this.cursorStack = inSlot;
      this.pickedFrom = index;
      return;
    }

    // 空格接下整堆，同种并到堆叠上限；那一格已经满了就一个都不动。
    const left = this.mergeInto(index, cursor);
    if (left === cursor.count) return;
    this.cursorStack = left > 0 ? { item: cursor.item, count: left } : undefined;
    // 光标空了，「从哪儿拿的」跟着失效；还有余量则仍要记着原来那一格。
    if (left === 0) this.pickedFrom = undefined;
  }

  /**
   * 光标物品回背包：先试拿起它的那一格，剩下的走入包规则（同种未满堆 → 第一个空格）。
   * 返回一格都放不下的那些，并把光标清空。
   */
  private putCursorBack(): ItemStack | undefined {
    const stack = this.cursorStack;
    const origin = this.pickedFrom;
    this.cursorStack = undefined;
    this.pickedFrom = undefined;
    if (!stack) return undefined;

    const left = origin === undefined ? stack.count : this.mergeInto(origin, stack);
    if (left === 0) return undefined;
    const spare = this.slots.add({ item: stack.item, count: left });
    return spare > 0 ? { item: stack.item, count: spare } : undefined;
  }

  /**
   * 把一堆物品并进某一格，返回没并进去的数量。
   * 空格接下整堆，同种的填到堆叠上限，异种与已经满了的一个都不接。
   */
  private mergeInto(index: number, stack: ItemStack): number {
    const inSlot = this.slots.slot(index);
    if (!inSlot) {
      this.slots.setSlot(index, stack);
      return 0;
    }
    if (inSlot.item !== stack.item) return stack.count;
    const room = stackLimit(stack.item) - inSlot.count;
    if (room <= 0) return stack.count;
    const moved = Math.min(room, stack.count);
    this.slots.setSlot(index, { item: stack.item, count: inSlot.count + moved });
    return stack.count - moved;
  }
}
