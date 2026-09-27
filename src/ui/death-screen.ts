import type { GameCore } from '../core/game';
import { STRINGS } from './strings';

/** 死亡画面要读核心的一样、往回递一条指令：死了没有，与重生。 */
export type DeathScreenSource = Pick<GameCore, 'health' | 'respawn'>;

/**
 * 死亡画面：生命归零时铺满屏幕的红色遮罩，正中是「你死了」与重生按钮。
 *
 * 纯表现：死没死、点了按钮之后回到哪里都是核心的规则（`HealthView.dead`、`GameCore.respawn`），
 * 这里只按「死了没有」显示与隐藏，点按钮时把重生递给核心。它不是背包那样的界面，没有关闭它的键：
 * 背包键与 Esc 都不认（输入层与核心两侧各挡一次），只有这颗按钮让它退出。
 */
export interface DeathScreenHud {
  /** 按核心状态刷新画面。每帧调一次；显示与否没变就不碰 DOM。 */
  update(): void;
  /** 卸下死亡画面。 */
  remove(): void;
}

/**
 * 把死亡画面挂到页面上，开局藏着。返回的句柄要每帧 `update()`。
 *
 * `afterRespawn` 在按钮的 click 里、重生之后同步调：接线层在这里把指针锁定抓回来。锁定只在
 * 用户手势里放行，推迟到下一帧再抓就会被浏览器拒掉。
 */
export function installDeathScreen(
  parent: HTMLElement,
  source: DeathScreenSource,
  afterRespawn: () => void,
): DeathScreenHud {
  const root = document.createElement('div');
  root.id = 'death-screen';
  root.className = 'death-screen';
  // 它打断游戏、只留一个出口，读屏软件应当当场报出来。
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', STRINGS.youDied);
  root.hidden = true;

  const title = document.createElement('div');
  title.className = 'death-screen__title';
  title.textContent = STRINGS.youDied;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'death-screen__respawn';
  button.textContent = STRINGS.respawn;
  button.addEventListener('click', () => {
    source.respawn();
    afterRespawn();
  });
  // 不在显示时把焦点移到按钮上：死的那一刻玩家可能正按着空格跳，松开空格会当场按下聚焦的按钮。

  root.append(title, button);
  parent.append(root);

  /** 上一次画的是显示还是藏着。与当前相同就不碰 DOM。 */
  let shownVisible = false;

  return {
    update(): void {
      const visible = source.health.dead;
      if (visible === shownVisible) return;
      shownVisible = visible;
      root.hidden = !visible;
    },
    remove(): void {
      root.remove();
    },
  };
}
