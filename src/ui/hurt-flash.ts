import type { GameCore } from '../core/game';

/**
 * 受伤红闪持续几 tick：受伤那一 tick 起算，10 tick 之后隐藏。
 *
 * 与无敌时间（`INVULNERABLE_TICKS`）同为 10，但两者各管各的：这个数只决定闪多久，改它不影响
 * 受伤规则，改无敌时间也不必跟着改它。
 */
export const HURT_FLASH_TICKS = 10;

/** 上次受伤在 lastHurtTick、此刻是第 now 个 tick 时，红闪该不该显示。还没受过伤不显示。 */
export function hurtFlashVisible(lastHurtTick: number | undefined, now: number): boolean {
  return lastHurtTick !== undefined && now - lastHurtTick < HURT_FLASH_TICKS;
}

/** 红闪要读核心的两样：上次受伤是哪一 tick，与此刻是哪一 tick。 */
export type HurtFlashSource = Pick<GameCore, 'health' | 'tickCount'>;

/**
 * 受伤红闪：玩家受伤后铺满屏幕的一层半透明红，持续 `HURT_FLASH_TICKS`。背后受伤时也能察觉。
 *
 * 纯表现：受没受伤、哪一 tick 受的都是核心的状态（`HealthView.lastHurtTick`），这里只按
 * tick 差决定显示与否，不自己计时。按 tick 而不是按毫秒算，时长因此与游戏时间一致，
 * 端到端测试推进 10 tick 就能断言它消失。
 */
export interface HurtFlashHud {
  /** 按核心状态刷新画面。每帧调一次；显示与否没变就不碰 DOM。 */
  update(): void;
  /** 卸下红闪那一层。 */
  remove(): void;
}

/** 把红闪那一层挂到页面上，开局藏着。返回的句柄要每帧 `update()`。 */
export function installHurtFlash(parent: HTMLElement, source: HurtFlashSource): HurtFlashHud {
  const root = document.createElement('div');
  root.id = 'hurt-flash';
  root.className = 'hurt-flash';
  // 纯视觉提示，同一件事读屏软件从生命值那一排心上读得到。
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  parent.append(root);

  /** 上一次画的是显示还是藏着。与当前相同就不碰 DOM。 */
  let shownVisible = false;

  return {
    update(): void {
      const visible = hurtFlashVisible(source.health.lastHurtTick, source.tickCount);
      if (visible === shownVisible) return;
      shownVisible = visible;
      root.hidden = !visible;
    },
    remove(): void {
      root.remove();
    },
  };
}
