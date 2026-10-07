import { deletesWorldOnDeath, type Difficulty } from '../core/difficulty';
import type { GameCore } from '../core/game';
import { STRINGS } from './strings';

/** 死亡画面要读核心的两样、往回递一条指令：死了没有、本世界的难度，与重生。 */
export type DeathScreenSource = Pick<GameCore, 'health' | 'difficulty' | 'respawn'>;

/** 死亡画面上那颗按钮做什么：重生，或删除世界。 */
export type DeathScreenAction = 'respawn' | 'deleteWorld';

/** 这一档难度下死亡画面给哪颗按钮：极限只有删除世界，其余四档是重生（见 GLOSSARY.md「死亡画面」）。 */
export function deathScreenAction(difficulty: Difficulty): DeathScreenAction {
  return deletesWorldOnDeath(difficulty) ? 'deleteWorld' : 'respawn';
}

/**
 * 死亡画面：生命归零时铺满屏幕的红色遮罩，正中是「你死了」与一颗按钮，极限难度下是删除世界，其余是重生。
 *
 * 纯表现：死没死、点了按钮之后回到哪里都是核心的规则（`HealthView.dead`、`GameCore.respawn`），
 * 这里只按「死了没有」显示与隐藏，点按钮时把重生递给核心。它不是背包那样的界面，没有关闭它的键：
 * 背包键与 Esc 都不认（输入层与核心两侧各挡一次），只有这颗按钮让它退出。删除世界不经过核心：
 * 存档在外层，按钮只把这次点击交给接线层。
 */
export interface DeathScreenHud {
  /** 按核心状态刷新画面。每帧调一次；显示与否没变就不碰 DOM。 */
  update(): void;
  /**
   * 压在暂停菜单下层时设成 inert：鼠标点不到它，键盘也不行，Tab 进不去、Enter 按不下那颗按钮。没设的话，从暂停
   * 菜单按 Shift+Tab 能聚焦到下层的这颗按钮，极限难度下一按就删除了世界。没变就不碰 DOM。
   */
  setInert(inert: boolean): void;
  /** 卸下死亡画面。 */
  remove(): void;
}

/** 死亡画面那颗按钮按下之后交给接线层的事。 */
export interface DeathScreenActions {
  /**
   * 在重生按钮的 click 里、重生之后同步调：接线层在这里把指针锁定抓回来。锁定只在用户手势里放行，
   * 推迟到下一帧再抓就会被浏览器拒掉。
   */
  readonly afterRespawn: () => void;
  /** 极限难度下点删除世界时调：接线层删除这个世界，回到世界列表。 */
  readonly deleteWorld: () => void;
}

/**
 * 把死亡画面挂到页面上，开局藏着。返回的句柄要每帧 `update()`。
 *
 * 给哪颗按钮在这里按难度定下（`deathScreenAction`）：难度新建世界时定，之后不变，换一个世界就换一个
 * 核心，界面也随之重新挂。
 */
export function installDeathScreen(
  parent: HTMLElement,
  source: DeathScreenSource,
  actions: DeathScreenActions,
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
  button.className = 'death-screen__button';
  if (deathScreenAction(source.difficulty) === 'deleteWorld') {
    button.textContent = STRINGS.deleteWorld;
    button.addEventListener('click', () => actions.deleteWorld());
  } else {
    button.textContent = STRINGS.respawn;
    button.addEventListener('click', () => {
      source.respawn();
      actions.afterRespawn();
    });
  }
  // 不在显示时把焦点移到按钮上：死的那一刻玩家可能正按着空格跳，松开空格会当场按下聚焦的按钮。

  root.append(title, button);
  parent.append(root);

  /** 上一次画的是显示还是藏着、设没设 inert。与当前相同就不碰 DOM。 */
  let shownVisible = false;
  let shownInert = false;

  return {
    update(): void {
      const visible = source.health.dead;
      if (visible === shownVisible) return;
      shownVisible = visible;
      root.hidden = !visible;
    },
    setInert(inert: boolean): void {
      if (inert === shownInert) return;
      shownInert = inert;
      root.inert = inert;
    },
    remove(): void {
      root.remove();
    },
  };
}
