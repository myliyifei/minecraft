import type { ExperienceView } from '../core/experience';
import { installHotbar } from './hotbar';
import { installInventoryScreen, type InventoryScreenSource } from './inventory-screen';
import { installLevelBar } from './level-bar';

/**
 * 屏幕上那一整套界面：等级条在上、快捷栏在下，再加一层按 E 打开的背包界面。
 *
 * 合成一个句柄，接线层与调试句柄因此不必知道界面由几个部件组成——加一块显示（生命值、
 * 饥饿值）只改这个文件。等级条与快捷栏装在同一个 `#hud` 容器里，等级条的宽度因此自动跟
 * 快捷栏一样宽，不必把 9 格的宽度算式在 CSS 里写第二遍；背包界面是铺满屏幕的一层覆盖层，
 * 不在那个容器里。
 */
export interface Hud {
  /** 让画面跟上核心。每帧调一次。 */
  update(): void;
  /** 卸下整套 HUD。 */
  remove(): void;
}

/** HUD 要读核心的哪几样、往回递哪一条指令。写成窄接口，接线接错了编译期就报。 */
export interface HudSource extends InventoryScreenSource {
  readonly experience: ExperienceView;
}

/** 把 HUD 挂到页面上。返回的句柄要每帧 `update()`。 */
export function installHud(parent: HTMLElement, source: HudSource): Hud {
  const root = document.createElement('div');
  root.id = 'hud';
  root.className = 'hud';
  parent.append(root);

  // 顺序就是自上而下的堆叠顺序：等级条压在快捷栏上方，与原版一致。
  const levelBar = installLevelBar(root, source.experience);
  const hotbar = installHotbar(root, source.inventory);
  // 背包界面挂在 `parent` 而不是 `#hud` 里：那一栏贴在屏幕底部、而且不接收点击
  // （pointer-events: none），装进去的覆盖层既铺不满屏幕，格子也点不着。
  const screen = installInventoryScreen(parent, source);

  /** 上一次画的是收起还是展开。与当前相同就不碰 DOM。 */
  let shownOpen: boolean | undefined;

  return {
    update(): void {
      // 背包界面开着时把底部这一栏收起来：界面里已经有一排快捷栏了，屏幕上不该出现两排。
      const open = source.inventoryScreen.open;
      if (open !== shownOpen) {
        shownOpen = open;
        root.hidden = open;
      }
      levelBar.update();
      hotbar.update();
      screen.update();
    },
    remove(): void {
      root.remove();
      screen.remove();
    },
  };
}
