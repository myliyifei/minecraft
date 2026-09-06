import { HOTBAR_SIZE, type InventoryView } from '../core/inventory';
import type { ItemStack } from '../core/item';
import { ATLAS_COLS, ATLAS_PATH, ATLAS_ROWS, ITEM_TILES, tileCell } from '../render/atlas';
import { ITEM_NAMES, STRINGS } from './strings';

/**
 * 快捷栏 HUD：屏幕底部那一排格子。
 *
 * 图标是方块图集的一张 CSS 精灵图——3D 场景与界面因此用同一份贴图，换贴图包时快捷栏
 * 跟着变，不必再准备一套图标。取哪一格由 `ITEM_TILES` 决定（`src/render/atlas.ts` 是
 * 纯数据，不牵 three.js）；格子多大、怎么排在 `style.css` 里，这里只写下标。
 */
export interface HotbarHud {
  /** 让画面跟上背包。每帧调一次；某一格的内容没变就一个 DOM 属性都不碰。 */
  update(): void;
  /** 卸下 HUD。 */
  remove(): void;
}

/** 一格的 DOM，加上上次画上去的内容。 */
interface SlotCell {
  readonly slot: HTMLElement;
  readonly icon: HTMLElement;
  /** 显示数量的那个小标签。与 `ItemStack.count` 不是一回事，一个是元素一个是数字。 */
  readonly countLabel: HTMLElement;
  /** 上一次画的那一堆。与当前相同就跳过这一格。 */
  shown?: ItemStack;
}

/** 把快捷栏挂到页面上。返回的句柄要每帧 `update()`。 */
export function installHotbar(parent: HTMLElement, inventory: InventoryView): HotbarHud {
  const root = document.createElement('div');
  root.id = 'hotbar';
  root.className = 'hotbar';
  root.setAttribute('role', 'list');
  root.setAttribute('aria-label', STRINGS.hotbar);
  // 图集的布局交给 CSS 算 background-position，格数的唯一来源仍是 atlas.ts。
  root.style.setProperty('--atlas-cols', String(ATLAS_COLS));
  root.style.setProperty('--atlas-rows', String(ATLAS_ROWS));

  const cells: SlotCell[] = [];
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    cells.push(buildSlot(root, i));
  }
  parent.append(root);

  return {
    update(): void {
      const stacks = inventory.hotbar();
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]!;
        const stack = stacks[i];
        if (sameStack(cell.shown, stack)) continue;
        cell.shown = stack;
        paint(cell, stack);
      }
    },
    remove(): void {
      root.remove();
    },
  };
}

function buildSlot(root: HTMLElement, index: number): SlotCell {
  const slot = document.createElement('div');
  slot.className = 'hotbar__slot';
  slot.setAttribute('role', 'listitem');
  slot.dataset.slot = String(index);

  const icon = document.createElement('span');
  icon.className = 'hotbar__icon';
  // 图集路径由 JS 给：写在 CSS 里会按打包后的样式表位置去解析，那已经不是页面根目录了。
  icon.style.backgroundImage = `url(${ATLAS_PATH})`;
  icon.hidden = true;

  const countLabel = document.createElement('span');
  countLabel.className = 'hotbar__count';

  slot.append(icon, countLabel);
  root.append(slot);
  return { slot, icon, countLabel };
}

function paint(cell: SlotCell, stack: ItemStack | undefined): void {
  if (!stack) {
    delete cell.slot.dataset.item;
    cell.slot.removeAttribute('title');
    cell.icon.hidden = true;
    cell.countLabel.textContent = '';
    return;
  }

  const { col, row } = tileCell(ITEM_TILES[stack.item].side);
  // 物品种类进 data 属性：端到端测试据此认出这一格里是什么，不必去比图片像素。
  cell.slot.dataset.item = String(stack.item);
  cell.slot.title = ITEM_NAMES[stack.item];
  cell.icon.style.setProperty('--tile-col', String(col));
  cell.icon.style.setProperty('--tile-row', String(row));
  cell.icon.hidden = false;
  // 只有一个时不写数字，与原版一致：满屏的「1」除了占地方没有信息。
  cell.countLabel.textContent = stack.count > 1 ? String(stack.count) : '';
}

function sameStack(a: ItemStack | undefined, b: ItemStack | undefined): boolean {
  if (!a || !b) return a === b;
  return a.item === b.item && a.count === b.count;
}
