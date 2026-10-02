import type { GameCore } from '../core/game';
import { STRINGS } from './strings';

/** 进入提示要读核心的一样东西：有没有界面开着。 */
export type EnterHintSource = Pick<GameCore, 'uiMode'>;

/**
 * 进入提示（见 CONTEXT.md）：画面正中、准星正下方的一行字，告诉玩家先点一下画面。鼠标没锁定时
 * 按键与鼠标按钮都不生效（`src/input/controls.ts`），刚打开页面、或按 Esc 退出锁定之后，不点这一下
 * 什么都操作不了。
 *
 * 显示的条件是「没锁定，也没有界面开着」：界面开着时鼠标本来就交还给页面，玩家在点格子或
 * 重生按钮，那时提示点画面是错的。是否锁定是输入层的状态，由接线层以 `pointerLocked` 递进来。
 */
export interface EnterHintHud {
  /** 让画面跟上锁定状态与核心。每帧调一次；显示与否没变就不碰 DOM。 */
  update(): void;
  /** 卸下进入提示。 */
  remove(): void;
}

/** 把进入提示挂到页面上。返回的句柄要每帧 `update()`。 */
export function installEnterHint(
  parent: HTMLElement,
  source: EnterHintSource,
  pointerLocked: () => boolean,
): EnterHintHud {
  const root = document.createElement('div');
  root.id = 'enter-hint';
  root.className = 'enter-hint';
  root.setAttribute('role', 'status');
  root.textContent = STRINGS.clickToStart;
  parent.append(root);

  /** 上一次画的是显示还是藏着。与当前相同就不碰 DOM。 */
  let shownVisible: boolean | undefined;

  return {
    update(): void {
      const visible = !pointerLocked() && !source.uiMode;
      if (visible === shownVisible) return;
      shownVisible = visible;
      root.hidden = !visible;
    },
    remove(): void {
      root.remove();
    },
  };
}
