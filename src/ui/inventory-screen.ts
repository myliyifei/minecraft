import { HOTBAR_SIZE, INVENTORY_SIZE, type InventoryView } from '../core/inventory';
import type { InventoryScreenView } from '../core/inventory-screen';
import {
  applyAtlasGrid,
  buildItemBox,
  buildSlotCell,
  refreshSlot,
  type SlotCell,
} from './item-slot';
import { STRINGS } from './strings';

/**
 * 背包界面要读核心的哪几样、往回递哪一条指令。写成窄接口，接线接错了编译期就报。
 */
export interface InventoryScreenSource {
  readonly inventory: InventoryView;
  readonly inventoryScreen: InventoryScreenView;
  /** 点了第 index 格。下一个 tick 生效（ADR-0004）。 */
  clickSlot(index: number): void;
}

/**
 * 背包界面（见 CONTEXT.md）的那层 DOM 覆盖层：36 格加一个跟着鼠标走的光标物品。
 *
 * 开着没有、光标上拿着什么、点一格之后东西怎么搬，全都在核心里（`src/core/
 * inventory-screen.ts`）。这里只做两件事：把核心的状态画成格子，把点击的格号递回去。
 *
 * 格子与快捷栏共用 `item-slot.ts` 那套画法，所以界面里第 0 格与 HUD 底部第 0 格画出来
 * 是同一堆东西——它们本来就是背包的同一格。
 */
export interface InventoryScreenHud {
  /** 让画面跟上核心。每帧调一次；关着的时候只看一眼就返回。 */
  update(): void;
  /** 卸下覆盖层。 */
  remove(): void;
}

/** 把背包界面挂到页面上。返回的句柄要每帧 `update()`。 */
export function installInventoryScreen(
  parent: HTMLElement,
  source: InventoryScreenSource,
): InventoryScreenHud {
  const root = document.createElement('div');
  root.id = 'inventory-screen';
  root.className = 'invscreen';
  // 一层模态覆盖层：读屏软件因此把它当成一个对话框，而不是页面上多出来的一片东西。
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', STRINGS.inventory);
  root.hidden = true;
  applyAtlasGrid(root);
  // 一行摆几格由快捷栏的格数决定（36 = 9 × 4），排布的算式留在 CSS 里：这里只给格数，
  // 与图集格数同一套分工。
  root.style.setProperty('--invscreen-cols', String(HOTBAR_SIZE));

  const panel = document.createElement('div');
  panel.className = 'invscreen__panel';

  const title = document.createElement('h2');
  title.className = 'invscreen__title';
  title.textContent = STRINGS.inventory;

  // 储物格：背包的第 9–35 格，3 行 9 列
  const storage = document.createElement('div');
  storage.className = 'invscreen__storage';
  storage.setAttribute('role', 'list');
  storage.setAttribute('aria-label', STRINGS.inventoryStorage);

  // 快捷栏那一排：背包的第 0–8 格，与屏幕底部那一排是同一批格子
  const hotbar = document.createElement('div');
  hotbar.className = 'invscreen__hotbar';
  hotbar.setAttribute('role', 'list');
  hotbar.setAttribute('aria-label', STRINGS.hotbar);

  // 下标就是背包的格号，与核心的 clickSlot 对得上。快捷栏那 9 格摆在下面一排，
  // 与原版一致，但格号仍从 0 起。
  const cells: SlotCell[] = [];
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    cells.push(buildSlotCell(i < HOTBAR_SIZE ? hotbar : storage, 'invscreen', i));
  }

  panel.append(title, storage, hotbar);
  root.append(panel);

  // 光标物品挂在面板外面：它要能盖到面板之外的地方去，鼠标移到哪儿它就在哪儿。
  const cursor = buildItemBox(root, 'invscreen', 'invscreen__cursor');
  cursor.slot.setAttribute('aria-label', STRINGS.cursorItem);
  cursor.slot.hidden = true;

  /** 光标物品跟着鼠标走。摆在哪一点是 CSS 的事，这里只报鼠标在哪儿。 */
  const followPointer = (event: MouseEvent): void => {
    root.style.setProperty('--cursor-x', `${event.clientX}px`);
    root.style.setProperty('--cursor-y', `${event.clientY}px`);
  };

  /**
   * 点一格：把格号递给核心。
   *
   * 事件委托挂在覆盖层上而不是 36 个格子各挂一个：格子是一次建好不再变的，但一个监听器
   * 比 36 个好卸。点在格子之间的空隙上什么都不做。
   */
  const onClick = (event: MouseEvent): void => {
    followPointer(event);
    if (!(event.target instanceof Element)) return;
    const slot = event.target.closest('[data-slot]');
    if (!(slot instanceof HTMLElement) || slot.dataset.slot === undefined) return;
    source.clickSlot(Number(slot.dataset.slot));
  };

  root.addEventListener('click', onClick);
  root.addEventListener('pointermove', followPointer);
  parent.append(root);

  /** 上一次画的是开着还是关着，以及光标上有没有东西。与当前相同就不碰 DOM。 */
  let shownOpen: boolean | undefined;
  let shownCursor: boolean | undefined;

  return {
    update(): void {
      const { open, cursor: stack } = source.inventoryScreen;
      if (open !== shownOpen) {
        shownOpen = open;
        root.hidden = !open;
      }
      // 关着的时候不必刷内容：藏起来的格子画了也没人看，而这是每帧都要走的一段。
      // 重新打开时下一帧就会把 36 格全对一遍，期间背包被拾取改动过也跟得上。
      if (!open) return;

      for (let i = 0; i < cells.length; i++) {
        refreshSlot(cells[i]!, source.inventory.slot(i));
      }

      refreshSlot(cursor, stack);
      const hasCursor = stack !== undefined;
      if (hasCursor === shownCursor) return;
      shownCursor = hasCursor;
      // 光标空了就整块藏起来，否则鼠标上会拖着一个空框。
      cursor.slot.hidden = !hasCursor;
    },
    remove(): void {
      root.removeEventListener('click', onClick);
      root.removeEventListener('pointermove', followPointer);
      root.remove();
    },
  };
}
