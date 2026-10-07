import { durabilityOf, type ItemStack } from '../core/item';
import { ATLAS_COLS, ATLAS_PATH, ATLAS_ROWS, ITEM_TILES, faceTile, tileCell } from '../render/atlas';
import { ITEM_NAMES, STRINGS, durabilityLabel } from './strings';

/**
 * 用这套格子的是谁：快捷栏，还是背包界面。也就是 class 名的 BEM 块名。
 *
 * 两处共用同一套格子：画的是同一批 36 格里的东西，图标怎么取、数量什么时候写数字这些
 * 规则没道理各写一遍。class 名各自成套（`hotbar__` / `invscreen__`），尺寸与排布因此仍
 * 由各自的样式说了算。写成联合类型而不是 `string`：拼错一个块名，样式表里一条都对不上，
 * 而那种错查起来只能靠肉眼。
 */
export type SlotBlock = 'hotbar' | 'invscreen';

/** 一格物品的 DOM，加上上次画上去的内容。 */
export interface SlotCell {
  readonly slot: HTMLElement;
  readonly icon: HTMLElement;
  /** 显示数量的那个小标签。与 `ItemStack.count` 不是一回事，一个是元素一个是数字。 */
  readonly countLabel: HTMLElement;
  /** 工具格底部那条耐久条（见 GLOSSARY.md 的「耐久」）。满耐久与非工具时藏着。 */
  readonly durability: HTMLElement;
  /** 上一次画的那一堆。与当前相同就跳过这一格。 */
  shown?: ItemStack;
}

/**
 * 把图集的格数写到一个容器上：格子里的图标靠它算 background-position（算式在
 * `style.css`），格数的唯一来源仍是 `atlas.ts`。
 */
export function applyAtlasGrid(root: HTMLElement): void {
  root.style.setProperty('--atlas-cols', String(ATLAS_COLS));
  root.style.setProperty('--atlas-rows', String(ATLAS_ROWS));
}

/**
 * 造一格：格子 + 图标 + 数量，追加进 `parent`。
 * `block` 是 BEM 的块名（`hotbar` 或 `invscreen`），`index` 是背包里的格号。
 */
export function buildSlotCell(
  parent: HTMLElement,
  block: SlotBlock,
  index: number,
): SlotCell {
  const cell = buildItemBox(parent, block, `${block}__slot`);
  cell.slot.setAttribute('role', 'listitem');
  // 格号进 data 属性：端到端测试与点击处理都据此认出这是第几格。
  cell.slot.dataset.slot = String(index);
  return cell;
}

/**
 * 造一块「一格物品」：外框 + 图标 + 数量，追加进 `parent`。
 *
 * 与 `buildSlotCell` 分开一层，因为不是每一块都是背包里的一格——光标物品也是这么一块，
 * 但它没有格号，也不该被读屏软件当成列表项报出来。
 */
export function buildItemBox(
  parent: HTMLElement,
  block: SlotBlock,
  className: string,
): SlotCell {
  const slot = document.createElement('div');
  slot.className = className;

  const icon = document.createElement('span');
  icon.className = `${block}__icon`;
  // 图集路径由 JS 给：写在 CSS 里会按打包后的样式表位置去解析，那已经不是页面根目录了。
  icon.style.backgroundImage = `url(${ATLAS_PATH})`;
  icon.hidden = true;

  const countLabel = document.createElement('span');
  countLabel.className = `${block}__count`;

  // 耐久条与数量标签同级，压在图标底边上：暗色的轨道加一段亮色的填充，填充的长度由
  // --durability（剩余比例）决定，算式在 style.css——与等级条同一套做法。
  const durability = document.createElement('span');
  durability.className = `${block}__durability`;
  durability.setAttribute('role', 'progressbar');
  durability.setAttribute('aria-label', STRINGS.durability);
  durability.setAttribute('aria-valuemin', '0');
  durability.hidden = true;
  const fill = document.createElement('span');
  fill.className = `${block}__durability-fill`;
  durability.append(fill);

  slot.append(icon, countLabel, durability);
  parent.append(slot);
  return { slot, icon, countLabel, durability };
}

/** 内容变了才重画一格。没变就一个 DOM 属性都不碰。 */
export function refreshSlot(cell: SlotCell, stack: ItemStack | undefined): void {
  if (sameStack(cell.shown, stack)) return;
  cell.shown = stack;
  paintSlot(cell, stack);
}

/** 把一格画成某一堆物品的样子；`undefined` 就画成空格。 */
function paintSlot(cell: SlotCell, stack: ItemStack | undefined): void {
  if (!stack) {
    delete cell.slot.dataset.item;
    cell.slot.removeAttribute('title');
    cell.icon.hidden = true;
    cell.countLabel.textContent = '';
    cell.durability.hidden = true;
    return;
  }

  // 图标取正面：有正面贴图的（工作台）画正面才认得出，其余方块正面就是侧面。
  const { col, row } = tileCell(faceTile(ITEM_TILES[stack.item], 'front'));
  // 物品种类进 data 属性：端到端测试据此认出这一格里是什么，不必去比图片像素。
  cell.slot.dataset.item = String(stack.item);
  cell.icon.style.setProperty('--tile-col', String(col));
  cell.icon.style.setProperty('--tile-row', String(row));
  cell.icon.hidden = false;
  // 只有一个时不写数字，与原版一致：满屏的「1」除了占地方没有信息。
  cell.countLabel.textContent = stack.count > 1 ? String(stack.count) : '';
  paintDurability(cell, stack);
}

/**
 * 工具格上的耐久条：损耗过才画，长度按剩余比例；满耐久与非工具不画，与原版一致。
 * 提示文字随之带上「耐久 58/59」，读屏软件也从进度条上读到同样的数。
 */
function paintDurability(cell: SlotCell, stack: ItemStack): void {
  const name = ITEM_NAMES[stack.item];
  const durability = durabilityOf(stack);
  if (!durability || durability.left >= durability.max) {
    cell.slot.title = name;
    cell.durability.hidden = true;
    return;
  }
  const { left, max } = durability;
  cell.slot.title = durabilityLabel(name, left, max);
  cell.durability.setAttribute('aria-valuenow', String(left));
  cell.durability.setAttribute('aria-valuemax', String(max));
  // 只给比例，长度与颜色的算式留在 CSS 里，与等级条同一套分工。
  cell.durability.style.setProperty('--durability', String(left / max));
  cell.durability.hidden = false;
}

/** 两堆物品的种类、数量与损耗都一样吗。 */
function sameStack(a: ItemStack | undefined, b: ItemStack | undefined): boolean {
  if (!a || !b) return a === b;
  return a.item === b.item && a.count === b.count && a.damage === b.damage;
}
