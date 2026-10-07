import { STRINGS } from './strings';

/**
 * 暂停菜单要读的三样：暂停没有、回到游戏的锁定请求被拒了没有、上次写盘失败了没有。前两样是输入层的状态，
 * 第三样是接线层的，都不在核心里（ADR-0019：核心不知道暂停）。
 */
export interface PauseMenuSource {
  readonly paused: boolean;
  readonly resumeRejected: boolean;
  readonly saveFailed: boolean;
}

/** 暂停菜单上的按钮按下之后交给接线层的事。 */
export interface PauseMenuActions {
  /**
   * 回到游戏：在按钮的 click 里同步调，接线层在这里请求指针锁定。锁定只在用户手势里放行。暂停在锁定生效时
   * 才解除，菜单在那之后的一帧藏起。
   */
  readonly resume: () => void;
  /** 打开设置界面。设置界面开着时仍处于暂停：它不请求锁定。 */
  readonly openSettings: () => void;
  /** 保存并退出到世界列表：接线层再写一次盘，写成了才销毁世界。 */
  readonly saveAndExit: () => void;
}

/**
 * 暂停菜单（见 GLOSSARY.md「暂停菜单」）：暂停时铺满画面的一层，正中是三个按钮，下面是提示行。
 *
 * 纯表现：什么时候暂停、什么时候解除由输入层定，这里按 `paused` 显示与隐藏。设置界面叠在它之上，关掉回到它。
 */
export interface PauseMenuHud {
  /** 按暂停状态刷新画面。每帧调一次；没变就不碰 DOM。 */
  update(): void;
  /** 卸下暂停菜单。 */
  remove(): void;
}

/** 把暂停菜单挂到页面上。返回的句柄要每帧 `update()`。 */
export function installPauseMenu(
  parent: HTMLElement,
  source: PauseMenuSource,
  actions: PauseMenuActions,
): PauseMenuHud {
  const root = document.createElement('div');
  root.id = 'pause-menu';
  root.className = 'pause-menu';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', STRINGS.paused);
  root.hidden = true;

  const title = document.createElement('div');
  title.className = 'pause-menu__title';
  title.textContent = STRINGS.paused;

  const resume = button(STRINGS.backToGame, () => actions.resume());
  const settings = button(STRINGS.settings, () => actions.openSettings());
  const exit = button(STRINGS.saveAndExit, () => actions.saveAndExit());
  // 不在显示时把焦点移到按钮上：按 Esc 的那一刻玩家可能正按着空格跳，松开空格会当场按下聚焦的按钮。

  const rejected = notice(STRINGS.resumeRejected);
  const saveFailed = notice(STRINGS.saveFailed);

  root.append(title, resume, settings, exit, rejected, saveFailed);
  parent.append(root);

  /** 上一次画的三样。与当前相同就不碰 DOM。 */
  const shown = { paused: false, resumeRejected: false, saveFailed: false };

  return {
    update(): void {
      if (source.paused !== shown.paused) {
        shown.paused = source.paused;
        root.hidden = !source.paused;
      }
      if (source.resumeRejected !== shown.resumeRejected) {
        shown.resumeRejected = source.resumeRejected;
        rejected.hidden = !source.resumeRejected;
      }
      if (source.saveFailed !== shown.saveFailed) {
        shown.saveFailed = source.saveFailed;
        saveFailed.hidden = !source.saveFailed;
      }
    },
    remove(): void {
      root.remove();
    },
  };
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'pause-menu__button';
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}

/** 按钮下面的一行提示，开局藏着。 */
function notice(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'pause-menu__notice';
  element.setAttribute('role', 'status');
  element.textContent = text;
  element.hidden = true;
  return element;
}
