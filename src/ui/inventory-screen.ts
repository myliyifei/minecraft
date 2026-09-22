import {
  FURNACE_FUEL_SLOT,
  FURNACE_INPUT_SLOT,
  FURNACE_RESULT_SLOT,
} from '../core/furnace-slots';
import { HOTBAR_SIZE, INVENTORY_SIZE, type InventoryView } from '../core/inventory';
import type {
  CraftingView,
  InventoryScreenView,
  RecipeBookEntry,
  SmeltingView,
} from '../core/inventory-screen';
import { MOUSE_BINDINGS } from '../input/keybindings';
import {
  applyAtlasGrid,
  buildItemBox,
  buildSlotCell,
  refreshSlot,
  type SlotCell,
} from './item-slot';
import { ITEM_NAMES, recipeLabel, STRINGS } from './strings';

/**
 * 一层界面要读核心的哪几样、往回递哪一条指令。写成窄接口，接线接错了编译期就报。
 *
 * 背包界面、工作台界面与熔炉界面各接一份：`screen` 是各自那个界面对象的视图，`inventory` 与
 * 点击指令是同一份——36 个背包格子每层都画，点击由核心递给开着的那个界面。
 */
export interface InventoryScreenSource {
  readonly inventory: InventoryView;
  readonly screen: InventoryScreenView;
  /** 点了第 index 格。下一个 tick 生效（ADR-0004）。 */
  clickSlot(index: number): void;
  /** 对第 index 格按了拆堆键（右键）。下一个 tick 生效（ADR-0004）。 */
  splitSlot(index: number): void;
  /** 点了输出格。下一个 tick 生效（ADR-0004）。 */
  clickCraftingOutput(): void;
  /** 点了配方书的第 index 条。下一个 tick 生效（ADR-0004）。 */
  clickRecipe(index: number): void;
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

/** 熔炉界面那一层：使用键对着熔炉打开。 */
export const FURNACE_SCREEN_LABEL: InventoryScreenLabel = {
  id: 'furnace-screen',
  title: STRINGS.furnace,
};

/**
 * 背包界面（见 CONTEXT.md）的那层 DOM 覆盖层：36 格、一块合成网格加输出格、右侧那块
 * 配方书面板，以及一个跟着鼠标走的光标物品。工作台界面是同一层的另一份实例：网格 3x3，
 * 标题换成「工作台」。熔炉界面是第三份：没有网格与配方书，换成熔炉三格与两条进度条。
 *
 * 开着没有、光标上拿着什么、点一格之后东西怎么搬、输出格里显示什么、配方书里哪条高亮，
 * 全都在核心里（`src/core/inventory-screen.ts`）。这里只做两件事：把核心的状态画成格子，
 * 把点击的格号（或「点了输出格」「点了第几条配方」）递回去。
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
  // 配方书：面板右侧一列，列的是核心报的那几条，这里只照着画。
  const recipeBook = buildRecipeBook(source.screen.crafting);
  // 熔炉三格与两条进度条：摆在合成网格那个位置，格号同样由核心给。
  const furnace = buildFurnaceHud(source.screen.smelting);

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

  // 面板分两栏：左栏自上而下是标题、合成网格（或熔炉三格）、储物格、快捷栏，右栏是配方书。
  // 熔炉界面没有配方书，只有左栏。
  const main = document.createElement('div');
  main.className = 'invscreen__main';
  main.append(title);
  if (crafting) main.append(crafting.root);
  if (furnace) main.append(furnace.root);
  main.append(storage, hotbar);
  panel.append(main);
  if (recipeBook) panel.append(recipeBook.root);
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
   * 点一格：把格号递给核心；点输出格、点配方书的一条递的是另外两条指令。
   *
   * 事件委托挂在覆盖层上而不是几十个格子各挂一个：格子是一次建好不再变的，但一个监听器
   * 比几十个好卸。点在格子之间的空隙上什么都不做。灰显的配方也照递：点了没有任何反应是
   * 核心的规则，这里不重复判。
   */
  const onClick = (event: MouseEvent): void => {
    followPointer(event);
    if (!(event.target instanceof Element)) return;
    const hit = event.target.closest('[data-slot], [data-output], [data-recipe]');
    if (!(hit instanceof HTMLElement)) return;
    if (hit.dataset.output !== undefined) {
      source.clickCraftingOutput();
      return;
    }
    if (hit.dataset.recipe !== undefined) {
      source.clickRecipe(Number(hit.dataset.recipe));
      return;
    }
    if (hit.dataset.slot === undefined) return;
    source.clickSlot(Number(hit.dataset.slot));
  };

  /**
   * 右键按下在一格上：发拆堆指令。落在输出格、配方书条目、空隙上的右键不发任何指令
   * ——那几处的拆堆规则是「什么都不改变」，这里不发，核心也就不必为它们各写一条空分支。
   *
   * 挂在 mousedown 而不是 contextmenu 上：Windows 上的浏览器松开右键才发 contextmenu，
   * 而对着工作台按下右键之后界面在下一个 tick 就开了、锁定随即释放——松开那一刻鼠标已经
   * 落在刚打开的界面上，接 contextmenu 会把开界面的那一下右键当成对某一格的拆堆。按下那一
   * 刻界面还没开，按下事件的目标是画布，不会误发。浏览器菜单由输入适配器拦（界面开着时
   * 一律 preventDefault），这里不重复。左键的 click 不会由右键触发，两条路径互不干扰。
   */
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== MOUSE_BINDINGS.split) return;
    followPointer(event);
    if (!(event.target instanceof Element)) return;
    const hit = event.target.closest('[data-slot]');
    if (!(hit instanceof HTMLElement)) return;
    source.splitSlot(Number(hit.dataset.slot));
  };

  root.addEventListener('click', onClick);
  root.addEventListener('mousedown', onMouseDown);
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
      recipeBook?.update();
      furnace?.update();

      refreshSlot(cursor, stack);
      const hasCursor = stack !== undefined;
      if (hasCursor === shownCursor) return;
      shownCursor = hasCursor;
      // 光标空了就整块藏起来，否则鼠标上会拖着一个空框。
      cursor.slot.hidden = !hasCursor;
    },
    remove(): void {
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousedown', onMouseDown);
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

/** 熔炉三格与两条进度条的 DOM 与刷新。 */
interface FurnaceHud {
  readonly root: HTMLElement;
  /** 让三格与两条进度条跟上核心。 */
  update(): void;
}

/** 一条进度条：轨道、上次画的比例。 */
interface ProgressBar {
  readonly track: HTMLElement;
  /** 上一次画的比例。与当前相同就不碰 DOM。 */
  shown?: number;
}

/**
 * 造熔炉三格与两条进度条。界面没带熔炉三格时不造。
 *
 * 摆法与原版一致：左边一列自上而下是原料格、燃料剩余条、燃料格，中间是熔炼进度条，右边是成品格。
 * 三格与背包格子是同一种格子（同一套画法、带 data-slot），点它们递的也是格号；哪一格收什么、
 * 成品格只取，都是核心的规则，这里不判。
 */
function buildFurnaceHud(area: SmeltingView | undefined): FurnaceHud | undefined {
  if (!area) return undefined;

  const root = document.createElement('div');
  root.className = 'invscreen__furnace';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', STRINGS.furnace);

  const feed = document.createElement('div');
  feed.className = 'invscreen__furnace-feed';

  const input = buildFurnaceSlot(feed, area.firstSlot + FURNACE_INPUT_SLOT, STRINGS.furnaceInput);
  const fuelBar = buildProgressBar(feed, 'invscreen__fuel', STRINGS.fuelLeft);
  const fuel = buildFurnaceSlot(feed, area.firstSlot + FURNACE_FUEL_SLOT, STRINGS.furnaceFuel);
  root.append(feed);

  const smeltBar = buildProgressBar(root, 'invscreen__smelt', STRINGS.smeltProgress);
  const result = buildFurnaceSlot(
    root,
    area.firstSlot + FURNACE_RESULT_SLOT,
    STRINGS.furnaceResult,
  );

  return {
    root,
    update(): void {
      refreshSlot(input, area.slot(FURNACE_INPUT_SLOT));
      refreshSlot(fuel, area.slot(FURNACE_FUEL_SLOT));
      refreshSlot(result, area.slot(FURNACE_RESULT_SLOT));
      refreshProgressBar(fuelBar, area.fuelRatio);
      refreshProgressBar(smeltBar, area.progressRatio);
    },
  };
}

/**
 * 熔炉里的一格：与背包格子同一套画法、带 data-slot，追加进 `parent`。
 *
 * 不在列表里，所以不是 listitem：三格分在两处摆，读屏软件按各自的名字（原料格、燃料格、成品格）
 * 报，与输出格同一个做法。
 */
function buildFurnaceSlot(parent: HTMLElement, index: number, label: string): SlotCell {
  const cell = buildSlotCell(parent, 'invscreen', index);
  cell.slot.setAttribute('role', 'button');
  cell.slot.setAttribute('aria-label', label);
  return cell;
}

/**
 * 造一条进度条，追加进 `parent`：暗色轨道上一段亮色填充，填充的长度由 --ratio（0 到 1）决定，
 * 算式在 style.css——与耐久条、等级条同一套做法。`block` 是它的 class 名，填充是 `block-fill`。
 */
function buildProgressBar(parent: HTMLElement, block: string, label: string): ProgressBar {
  const track = document.createElement('span');
  track.className = block;
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('span');
  fill.className = `${block}-fill`;
  track.append(fill);
  parent.append(track);
  return { track };
}

/** 比例变了才重画一条进度条。读屏软件报的是百分数，取整。 */
function refreshProgressBar(bar: ProgressBar, ratio: number): void {
  if (bar.shown === ratio) return;
  bar.shown = ratio;
  bar.track.style.setProperty('--ratio', String(ratio));
  bar.track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

/** 配方书的 DOM 与刷新。 */
interface RecipeBookHud {
  readonly root: HTMLElement;
  /** 让每条配方的高亮与灰显跟上核心。 */
  update(): void;
}

/** 配方书里的一条：按钮，以及上次画的亮暗。 */
interface RecipeRow {
  readonly button: HTMLButtonElement;
  /** 上一次画的是高亮还是灰显。与当前相同就不碰 DOM。 */
  lastCraftable?: boolean;
}

/**
 * 造配方书（见 CONTEXT.md）：一列按钮，每条是成品图标加名字。界面没带合成网格时不造。
 *
 * 配方那几条是固定的（核心按网格尺寸过滤配方表，之后不再变），所以按钮一次建好；每帧只刷
 * 高亮与灰显。按钮带 data-recipe，点击处理与端到端测试据此认出点的是第几条。灰显的用
 * aria-disabled 而不是 disabled：disabled 的按钮不发 click，也没有 hover 加亮，玩家点了
 * 得不到任何反馈；而「点了没有任何反应」本来就是核心的规则，界面层不重复判。
 */
function buildRecipeBook(area: CraftingView | undefined): RecipeBookHud | undefined {
  if (!area) return undefined;

  const root = document.createElement('section');
  root.className = 'invscreen__recipes';
  root.setAttribute('aria-label', STRINGS.recipeBook);

  const heading = document.createElement('h3');
  heading.className = 'invscreen__recipes-title';
  heading.textContent = STRINGS.recipeBook;

  // 标题在列表外面：列表里只放配方那几条，读屏软件报的条数才对得上。
  const list = document.createElement('div');
  list.className = 'invscreen__recipe-list';
  list.setAttribute('role', 'list');
  root.append(heading, list);

  const rows: RecipeRow[] = area.recipes.map((entry, index) => buildRecipeRow(list, entry, index));

  return {
    root,
    update(): void {
      const entries = area.recipes;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const entry = entries[i];
        if (!entry) continue;
        if (entry.craftable === row.lastCraftable) continue;
        row.lastCraftable = entry.craftable;
        row.button.dataset.craftable = entry.craftable ? 'true' : 'false';
        row.button.setAttribute('aria-disabled', entry.craftable ? 'false' : 'true');
        row.button.setAttribute(
          'aria-label',
          recipeLabel(ITEM_NAMES[entry.recipe.result.item], entry.craftable),
        );
      }
    },
  };
}

/**
 * 造配方书里的一条，追加进 `parent`。成品图标与格子同一套画法，名字来自物品名表。
 *
 * 列表项是外面一层 div，按钮在它里面：把 role="listitem" 直接写在按钮上会盖掉按钮自己的
 * 语义，读屏软件就把它报成列表项，按钮导航里也找不到它。
 */
function buildRecipeRow(parent: HTMLElement, entry: RecipeBookEntry, index: number): RecipeRow {
  const item = document.createElement('div');
  item.setAttribute('role', 'listitem');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'invscreen__recipe';
  button.dataset.recipe = String(index);

  // 成品图标：与格子同一套画法，只画一次——配方的成品不会变。
  refreshSlot(buildItemBox(button, 'invscreen', 'invscreen__recipe-icon'), entry.recipe.result);

  const name = document.createElement('span');
  name.className = 'invscreen__recipe-name';
  name.textContent = ITEM_NAMES[entry.recipe.result.item];
  button.append(name);

  item.append(button);
  parent.append(item);
  return { button };
}
