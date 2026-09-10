import { isSlotIndex } from './inventory';
import type { ItemStack, SlotBatch } from './item';
import { matchRecipe, type GridSize } from './recipe';

/** 背包界面那块合成网格的尺寸（见 CONTEXT.md 的「合成网格」）：2x2。工作台（#19）是 3x3。 */
export const INVENTORY_CRAFTING_GRID: GridSize = Object.freeze({ width: 2, height: 2 });

/**
 * 合成网格（见 CONTEXT.md）：一批按行排列的格子，加一个由内容算出来的输出格。
 *
 * 它是 `SlotBatch` 而不是 `SlotStore`：格子逐格读写，背包界面那套拿起放下直接用在它上面，
 * 但它不按入包规则收东西——拾取到的东西不该落进网格里。
 *
 * 输出格不存东西：它是网格内容对配方表的一次匹配结果，每次读都当场算。存一份的话，
 * 每条 `setSlot` 都得记着去刷它，而配方就那么几条，算一次比记着刷便宜得多也不会出错。
 */
export class CraftingGrid implements SlotBatch, GridSize {
  readonly width: number;
  readonly height: number;
  private readonly cells: Array<ItemStack | undefined>;

  constructor({ width, height }: GridSize) {
    this.width = width;
    this.height = height;
    this.cells = Array<ItemStack | undefined>(width * height).fill(undefined);
  }

  get size(): number {
    return this.cells.length;
  }

  slot(index: number): ItemStack | undefined {
    return this.cells[index];
  }

  /** 指不到格子的下标什么都不写，理由同 `Inventory.setSlot`：写进去这批格子就多出一格。 */
  setSlot(index: number, stack: ItemStack | undefined): void {
    if (!isSlotIndex(index, this.cells.length)) return;
    this.cells[index] = stack;
  }

  /**
   * 输出格（见 CONTEXT.md）：网格里摆的东西匹配到的成品与数量，不匹配任何配方时 undefined。
   * 只读的预览——拿走成品是 `InventoryScreen.clickOutput` 那条独立的指令。
   */
  get output(): ItemStack | undefined {
    return matchRecipe(
      this.cells.map((stack) => stack?.item),
      this,
    );
  }

  /**
   * 合成一份：每个非空格各消耗 1 个，只剩 1 个的那一格清空。
   *
   * 材料守恒的那一半在这里，成品到光标上的那一半在界面对象里——网格不知道光标，也不该
   * 知道。调用方要先看 `output` 确认匹配到了配方再来消耗，这里不重复判。
   */
  consumeOne(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const stack = this.cells[i];
      if (!stack) continue;
      this.cells[i] = stack.count > 1 ? { item: stack.item, count: stack.count - 1 } : undefined;
    }
  }
}
