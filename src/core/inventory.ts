import { stackLimit, type ItemSink, type ItemStack, type ItemType } from './item';

/** 快捷栏（见 CONTEXT.md）的格数。 */
export const HOTBAR_SIZE = 9;

/** 背包总格数，含快捷栏。与原版一致。 */
export const INVENTORY_SIZE = 36;

/** 背包的只读视图。HUD 与调试句柄拿到的是这个，改内容只能经由核心。 */
export interface InventoryView {
  /** 格子总数。 */
  readonly size: number;
  /** 某一格里的一堆物品，空格与越界的下标都是 undefined。 */
  slot(index: number): ItemStack | undefined;
  /** 快捷栏那一排。HUD 画的就是它。 */
  hotbar(): ReadonlyArray<ItemStack | undefined>;
}

/**
 * 背包：36 个格子，前 `HOTBAR_SIZE` 格就是快捷栏。
 *
 * 快捷栏排在前面不只是编号方便——入包时「快捷栏优先」因此就是「下标小的优先」，
 * 两轮扫描都按下标升序走，不需要再写一遍优先级。
 */
export class Inventory implements InventoryView, ItemSink {
  private readonly slots = Array<ItemStack | undefined>(INVENTORY_SIZE).fill(undefined);

  get size(): number {
    return this.slots.length;
  }

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  hotbar(): ReadonlyArray<ItemStack | undefined> {
    return this.slots.slice(0, HOTBAR_SIZE);
  }

  /**
   * 把一堆物品收进背包，返回没放下的数量（0 表示全收下了）。
   *
   * 两轮：先把同种的未满堆填满，再占空格。顺序是原版的手感——捡起东西优先并进
   * 手上已有的那一堆，而不是每次都新开一格。
   */
  add(stack: ItemStack): number {
    const limit = stackLimit(stack.item);
    let left = stack.count;
    left = this.topUpExisting(stack.item, limit, left);
    return this.fillEmpty(stack.item, limit, left);
  }

  /**
   * 第一轮：填同种的未满堆。返回还剩多少。
   *
   * 与第二轮一样按下标升序走，「快捷栏优先」因此不需要额外一行代码。留意一点：走完
   * `add` 之后同一种物品最多只剩一个未满堆（先填满已有的才另起一堆），所以「快捷栏与
   * 背包各有一堆未满、看谁先被填」这种局面在本切片的接口下构造不出来。
   */
  private topUpExisting(item: ItemType, limit: number, count: number): number {
    let left = count;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.item !== item) continue;
      const room = limit - slot.count;
      if (room <= 0) continue;
      const moved = Math.min(room, left);
      this.slots[i] = { item, count: slot.count + moved };
      left -= moved;
    }
    return left;
  }

  /** 第二轮：占空格。返回还剩多少。 */
  private fillEmpty(item: ItemType, limit: number, count: number): number {
    let left = count;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(limit, left);
      this.slots[i] = { item, count: moved };
      left -= moved;
    }
    return left;
  }
}
