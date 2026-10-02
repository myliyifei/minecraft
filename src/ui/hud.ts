import type { GameCore } from '../core/game';
import type { InventoryScreenView } from '../core/inventory-screen';
import { installCrosshair } from './crosshair';
import { installDeathScreen } from './death-screen';
import { installEnterHint } from './enter-hint';
import { installHealthBar } from './health-bar';
import { installHotbar } from './hotbar';
import { installHurtFlash } from './hurt-flash';
import {
  CRAFTING_TABLE_SCREEN_LABEL,
  FURNACE_SCREEN_LABEL,
  INVENTORY_SCREEN_LABEL,
  installInventoryScreen,
  type InventoryScreenSource,
} from './inventory-screen';
import { installLevelBar } from './level-bar';

/**
 * 屏幕上那一整套界面：十字准星在正中，没锁定鼠标时准星正下方有进入提示，底部自上而下是生命值
 * 那一排心、等级条、快捷栏，再加受伤时的红闪、三层覆盖层——按 E 打开的背包界面，与使用键对着
 * 工作台、熔炉打开的工作台界面、熔炉界面——与生命归零时的死亡画面。
 *
 * 合成一个句柄，接线层与调试句柄因此不必知道界面由几个部件组成——加一块显示（饥饿值）
 * 只改这个文件。心、等级条与快捷栏装在同一个 `#hud` 容器里，等级条的宽度因此自动跟
 * 快捷栏一样宽，不必把 9 格的宽度算式在 CSS 里写第二遍；十字准星、进入提示、红闪与背包界面各自
 * 贴着视口定位，不在那个容器里。
 */
export interface Hud {
  /** 让画面跟上核心。每帧调一次。 */
  update(): void;
  /** 卸下整套 HUD。 */
  remove(): void;
}

/** HUD 要读核心的哪几样、往回递哪一条指令。写成窄接口，接线接错了编译期就报。 */
export type HudSource = Pick<
  GameCore,
  | 'experience'
  | 'health'
  | 'tickCount'
  | 'inventory'
  | 'inventoryScreen'
  | 'craftingTableScreen'
  | 'furnaceScreen'
  | 'uiMode'
  | 'clickSlot'
  | 'splitSlot'
  | 'clickCraftingOutput'
  | 'clickRecipe'
  | 'respawn'
>;

/** 给一层界面接线：视图换成它自己的，背包与点击指令是共用的那一份。 */
function screenSource(source: HudSource, screen: InventoryScreenView): InventoryScreenSource {
  return {
    inventory: source.inventory,
    screen,
    clickSlot: (index) => source.clickSlot(index),
    splitSlot: (index) => source.splitSlot(index),
    clickCraftingOutput: () => source.clickCraftingOutput(),
    clickRecipe: (index) => source.clickRecipe(index),
  };
}

/**
 * 把 HUD 挂到页面上。返回的句柄要每帧 `update()`。
 *
 * `afterRespawn` 在死亡画面的重生按钮按下、核心重生之后同步调，接线层在这里抓回指针锁定
 * （见 `installDeathScreen`）。`pointerLocked` 报此刻鼠标是否锁定在画布上，进入提示按它显示与隐藏。
 */
export function installHud(
  parent: HTMLElement,
  source: HudSource,
  afterRespawn: () => void,
  pointerLocked: () => boolean,
): Hud {
  // 红闪挂在最前面：后挂的元素画在它上面，心、快捷栏、准星与三层界面因此都不被染红，
  // 受伤那一下照样看得清剩几颗心。它挂在 `parent` 而不是 `#hud` 里，理由见下面准星那一段，
  // 另外还有一条：界面开着时 `#hud` 整栏收起，而开着背包受伤也要闪。
  const hurtFlash = installHurtFlash(parent, source);

  const root = document.createElement('div');
  root.id = 'hud';
  root.className = 'hud';
  parent.append(root);

  // 顺序就是自上而下的堆叠顺序：心在等级条上方，等级条压在快捷栏上方，与原版一致。
  const healthBar = installHealthBar(root, source.health);
  const levelBar = installLevelBar(root, source.experience);
  const hotbar = installHotbar(root, source.inventory);
  // 准星与三层界面都挂在 `parent` 而不是 `#hud` 里：那一栏贴在屏幕底部、而且不接收点击
  // （pointer-events: none），装进去的覆盖层既铺不满屏幕，格子也点不着；准星装进去连
  // 位置都对不上，理由在 style.css 的 `.crosshair` 那一段。
  const crosshair = installCrosshair(parent, source);
  // 进入提示在准星正下方，与准星一样直接贴着视口定位。
  const enterHint = installEnterHint(parent, source, pointerLocked);
  const screen = installInventoryScreen(
    parent,
    screenSource(source, source.inventoryScreen),
    INVENTORY_SCREEN_LABEL,
  );
  const craftingTable = installInventoryScreen(
    parent,
    screenSource(source, source.craftingTableScreen),
    CRAFTING_TABLE_SCREEN_LABEL,
  );
  const furnace = installInventoryScreen(
    parent,
    screenSource(source, source.furnaceScreen),
    FURNACE_SCREEN_LABEL,
  );
  // 死亡画面挂在最后，压在其余一切之上。死亡时核心已经关掉了三层界面，准星与底部那一栏
  // 也因为界面模式收起了，这里只是保证叠放的先后。
  const deathScreen = installDeathScreen(parent, source, afterRespawn);

  /** 上一次画的是收起还是展开。与当前相同就不碰 DOM。 */
  let shownOpen: boolean | undefined;

  return {
    update(): void {
      // 有界面开着时把底部这一栏收起来：界面里已经有一排快捷栏了，屏幕上不该出现两排。
      const open = source.uiMode;
      if (open !== shownOpen) {
        shownOpen = open;
        root.hidden = open;
      }
      healthBar.update();
      levelBar.update();
      hotbar.update();
      hurtFlash.update();
      crosshair.update();
      enterHint.update();
      screen.update();
      craftingTable.update();
      furnace.update();
      deathScreen.update();
    },
    remove(): void {
      root.remove();
      hurtFlash.remove();
      crosshair.remove();
      enterHint.remove();
      screen.remove();
      craftingTable.remove();
      furnace.remove();
      deathScreen.remove();
    },
  };
}
