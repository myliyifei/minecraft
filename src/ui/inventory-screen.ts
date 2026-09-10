import { HOTBAR_SIZE, INVENTORY_SIZE, type InventoryView } from '../core/inventory';
import type { CraftingView, InventoryScreenView } from '../core/inventory-screen';
import {
  applyAtlasGrid,
  buildItemBox,
  buildSlotCell,
  refreshSlot,
  type SlotCell,
} from './item-slot';
import { STRINGS } from './strings';

/**
 * 一层界面要读核心的哪几样、往回递哪一条指令。写成窄接口，接线接错了编译期就报。
 *
 * 背包界面与工作台界面各接一份：`screen` 是各自那个界面对象的视图，`inventory` 与两条
 * 点击指令是同一份——36 个背包格子两层都画，点击由核心递给开着的那个界面。
 */
export interface InventoryScreenSource {
  readonly inventory: InventoryView;
  readonly screen: InventoryScreenView;
  /** 点了第 index 格。下一个 tick 生效（ADR-0004）。 */
  clickSlot(index: number): void;
  /** 点了输出格。下一个 tick 生效（ADR-0004）。 */
  clickCraftingOutput(): void;
}

/** 这一层覆盖层在页面上叫什么：元素 id（端到端测试据此找它）与标题。 */
export interface InventoryScreenLabel {
  readonly id: string;
  readonly title: string;
}

/** 背包界面那一层：按 E 打开。 */
export const INVENTORY_SCREEN_LABEL: InventoryScreenLabel = {
  id: 'inventory-screen',
  title: STRINGS.inventory,
};

/** 工作台界面那一层：使用键对着工作台打开。 */
export const CRAFTING_TABLE_SCREEN_LABEL: InventoryScreenLabel = {
  id: 'crafting-table-screen',
  title: STRINGS.craftingTable,
};

/**
 * 背包界面（见 CONTEXT.md）的那层 DOM 覆盖层：36 格、一块合成网格加输出格，以及一个
 * 跟着鼠标走的光标物品。工作台界面是同一层的另一份实例：网格 3x3，标题换成「工作台」。
 *
 * 开着没有、光标上拿着什么、点一格之后东西怎么搬、输出格里显示什么，全都在核心里
 * （`src/core/inventory-screen.ts`）。这里只做两件事：把核心的状态画成格子，把点击的格号
 * （或「点了输出格」）递回去。
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

/** 把一层界面挂到页面上。返回的句柄要每帧 `update()`。 */
export function installInventoryScreen(
  parent: HTMLElement,
  source: InventoryScreenSource,
  label: InventoryScreenLabel,
): InventoryScreenHud {
  const root = document.createElement('div');
  root.id = label.id;
  root.className = 'invscreen';
  // 一层模态覆盖层：读屏软件因此把它当成一个对话框，而不是页面上多出来的一片东西。
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', label.title);
  root.hidden = true;
  applyAtlasGrid(root);
  // 一行摆几格由快捷栏的格数决定（36 = 9 × 4），排布的算式留在 CSS 里：这里只给格数，
  // 与图集格数同一套分工。
  root.style.setProperty('--invscreen-cols', String(HOTBAR_SIZE));

  const panel = document.createElement('div');
  panel.className = 'invscreen__panel';

  const title = document.createElement('h2');
  title.className = 'invscreen__title';
  title.textContent = label.title;

  // 合成网格在左、输出格在右。格号由核心给（接在 36 格之后），这里只照着编。
  const crafting = buildCraftingHud(source.screen.crafting);

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

  panel.append(title);
  if (crafting) panel.append(crafting.root);
  panel.append(storage, hotbar);
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
   * 点一格：把格号递给核心；点输出格递的是另一条指令。
   *
   * 事件委托挂在覆盖层上而不是 40 个格子各挂一个：格子是一次建好不再变的，但一个监听器
   * 比 40 个好卸。点在格子之间的空隙上什么都不做。
   */
  const onClick = (event: MouseEvent): void => {
    followPointer(event);
    if (!(event.target instanceof Element)) return;
    const hit = event.target.closest('[data-slot], [data-output]');
    if (!(hit instanceof HTMLElement)) return;
    if (hit.dataset.output !== undefined) {
      source.clickCraftingOutput();
      return;
    }
    if (hit.dataset.slot === undefined) return;
    source.clickSlot(Number(hit.dataset.slot));
  };

  root.addEventListener('click', onClick);
  root.addEventListener('pointermove', followPointer);
  parent.append(root);

  /** 上一次画的是开着还是关着，以及光标上有没有东西。与当前相同就不碰 DOM。 */
  let shownOpen: boolean | undefined;
  let shownCursor: boolean | undefined;

  return {
    update(): void {
      const { open, cursor: stack } = source.screen;
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
      crafting?.update();

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

/** 合成网格与输出格的 DOM 与刷新。 */
interface CraftingHud {
  readonly root: HTMLElement;
  /** 让网格与输出格跟上核心。 */
  update(): void;
}

/**
 * 造合成网格与输出格：一块 `width × height` 的网格，旁边一个输出格。界面没带合成网格时不造。
 *
 * 网格格子与背包格子是同一种格子（同一套画法、同样带 data-slot），点它递的也是格号；
 * 输出格不是格子——它不存东西、没有格号，带的是 data-output，点它递的是另一条指令。
 */
function buildCraftingHud(area: CraftingView | undefined): CraftingHud | undefined {
  if (!area) return undefined;

  const root = document.createElement('div');
  root.className = 'invscreen__crafting';
  root.style.setProperty('--invscreen-grid-cols', String(area.width));

  const grid = document.createElement('div');
  grid.className = 'invscreen__grid';
  grid.setAttribute('role', 'list');
  grid.setAttribute('aria-label', STRINGS.craftingGrid);

  const cells: SlotCell[] = [];
  for (let i = 0; i < area.width * area.height; i++) {
    cells.push(buildSlotCell(grid, 'invscreen', area.firstSlot + i));
  }

  // 箭头只是装饰：从网格到输出格的方向。读屏软件不必报它。
  const arrow = document.createElement('span');
  arrow.className = 'invscreen__arrow';
  arrow.setAttribute('aria-hidden', 'true');

  const output = buildItemBox(root, 'invscreen', 'invscreen__output');
  output.slot.setAttribute('role', 'button');
  output.slot.setAttribute('aria-label', STRINGS.craftingOutput);
  // 端到端测试与点击处理都据此认出这是输出格。
  output.slot.dataset.output = '';

  root.prepend(grid, arrow);

  return {
    root,
    update(): void {
      for (let i = 0; i < cells.length; i++) {
        refreshSlot(cells[i]!, area.slot(i));
      }
      refreshSlot(output, area.output);
    },
  };
}
