import type { InventoryScreenView } from '../core/inventory-screen';
import { STRINGS } from './strings';

/**
 * 十字准星 HUD（见 CONTEXT.md）：屏幕正中那个十字，标出视线落在哪一点。
 *
 * 纯表现，一个数都不读核心的世界状态——视线撞上哪一块是目标方块的事（`src/core/
 * raycast.ts`），准星只是把「那条视线从屏幕的哪一点射出去」画出来。它唯一要跟着变的
 * 是背包界面开没开：那时玩家在摆物品，不是在瞄准，屏幕正中不该还立着一个准星。
 *
 * 居中不写在 JS 里：CSS 用视口的 50% 定位，窗口一改尺寸浏览器自己重排，这里不必挂
 * resize 监听器。十字长什么样也在 `style.css` 里。
 */
export interface CrosshairHud {
  /** 让画面跟上核心。每帧调一次；开合状态没变就一个 DOM 属性都不碰。 */
  update(): void;
  /** 卸下准星。 */
  remove(): void;
}

/** 把十字准星挂到页面上。返回的句柄要每帧 `update()`。 */
export function installCrosshair(
  parent: HTMLElement,
  inventoryScreen: InventoryScreenView,
): CrosshairHud {
  const root = document.createElement('div');
  root.id = 'crosshair';
  root.className = 'crosshair';
  // 它画的是一个东西而不是一段文字，所以报的是图像那一档语义。读屏软件因此能告诉玩家
  // 屏幕正中立着准星，而不是跳过一个没名字的空框。
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', STRINGS.crosshair);
  parent.append(root);

  /** 上一次画的是收起还是显示。与当前相同就不碰 DOM。 */
  let shownOpen: boolean | undefined;

  return {
    update(): void {
      const { open } = inventoryScreen;
      if (open === shownOpen) return;
      shownOpen = open;
      root.hidden = open;
    },
    remove(): void {
      root.remove();
    },
  };
}
