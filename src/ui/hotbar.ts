import { HOTBAR_SIZE, type InventoryView } from '../core/inventory';
import { applyAtlasGrid, buildSlotCell, refreshSlot, type SlotCell } from './item-slot';
import { STRINGS } from './strings';

/**
 * 快捷栏 HUD：屏幕底部那一排格子，选中的那一格高亮。
 *
 * 图标是方块图集的一张 CSS 精灵图——3D 场景与界面因此用同一份贴图，换贴图包时快捷栏
 * 跟着变，不必再准备一套图标。一格怎么画在 `item-slot.ts` 里（背包界面用的是同一套）；
 * 格子多大、怎么排在 `style.css` 里。
 *
 * 选中格是核心的状态（`InventoryView.selectedSlot`），不是 HUD 自己记的一个数：手上
 * 拿着什么决定放下去是什么方块，界面与判定不能各存一份。
 */
export interface HotbarHud {
  /** 让画面跟上背包。每帧调一次；某一格的内容没变就一个 DOM 属性都不碰。 */
  update(): void;
  /** 卸下 HUD。 */
  remove(): void;
}

/** 把快捷栏挂到页面上。返回的句柄要每帧 `update()`。 */
export function installHotbar(parent: HTMLElement, inventory: InventoryView): HotbarHud {
  const root = document.createElement('div');
  root.id = 'hotbar';
  root.className = 'hotbar';
  root.setAttribute('role', 'list');
  root.setAttribute('aria-label', STRINGS.hotbar);
  applyAtlasGrid(root);

  const cells: SlotCell[] = [];
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    cells.push(buildSlotCell(root, 'hotbar', i));
  }
  parent.append(root);

  /** 上一次高亮的是哪一格。与当前相同就两个格子都不碰。 */
  let shownSelected: number | undefined;

  return {
    update(): void {
      const stacks = inventory.hotbar();
      for (let i = 0; i < cells.length; i++) {
        refreshSlot(cells[i]!, stacks[i]);
      }

      const selected = inventory.selectedSlot;
      if (selected === shownSelected) return;
      if (shownSelected !== undefined) highlight(cells[shownSelected]!, false);
      highlight(cells[selected]!, true);
      shownSelected = selected;
    },
    remove(): void {
      root.remove();
    },
  };
}

/**
 * 高亮（或撤掉高亮）一格。
 *
 * `aria-current` 是给读屏软件的：一排格子里「现在用的是这个」用它表达。
 * 端到端测试认的是 `data-selected`，与格号那个 data 属性同一套做法。
 */
function highlight(cell: SlotCell, selected: boolean): void {
  cell.slot.classList.toggle('hotbar__slot--selected', selected);
  if (selected) {
    cell.slot.dataset.selected = '';
    cell.slot.setAttribute('aria-current', 'true');
    return;
  }
  delete cell.slot.dataset.selected;
  cell.slot.removeAttribute('aria-current');
}
