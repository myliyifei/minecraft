import { MAX_HEALTH, type HealthView } from '../core/health';
import { STRINGS } from './strings';

/** 一颗心代表几点生命值。 */
const POINTS_PER_HEART = 2;

/** 一颗心的三态：整、半、空。 */
export type HeartState = 'full' | 'half' | 'empty';

/**
 * 生命值对应的一排心，从左往右。满血 10 颗整心；奇数点时最右边那颗有血的心是半颗。
 *
 * 心的数量由 `MAX_HEALTH` 定，不在这里另写一个 10。
 */
export function heartStates(points: number): HeartState[] {
  const hearts: HeartState[] = [];
  for (let i = 0; i < MAX_HEALTH / POINTS_PER_HEART; i++) {
    const left = points - i * POINTS_PER_HEART;
    hearts.push(left >= POINTS_PER_HEART ? 'full' : left > 0 ? 'half' : 'empty');
  }
  return hearts;
}

/**
 * 生命值 HUD（见 GLOSSARY.md 的「生命值」）：等级条上方左侧那一排心。
 *
 * 只读核心的 `HealthView`：扣多少、什么时候回都在 `src/core/health.ts` 里，这里只把点数
 * 换成一排心。一颗心长什么样在 `style.css` 里。
 */
export interface HealthBarHud {
  /** 按生命值刷新画面。每帧调一次；点数没变就一个 DOM 属性都不碰。 */
  update(): void;
  /** 卸下这一排心。 */
  remove(): void;
}

/** 把生命值那一排心挂到页面上。返回的句柄要每帧 `update()`。 */
export function installHealthBar(parent: HTMLElement, health: HealthView): HealthBarHud {
  const root = document.createElement('div');
  root.id = 'health-bar';
  root.className = 'health';
  // 一排心说的是「一个量在一个范围里的哪里」，与 meter 的语义一致：读屏软件报的是
  // 「生命值 17」，而不是十个没名字的方块。
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', STRINGS.health);
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(MAX_HEALTH));

  const hearts = heartStates(MAX_HEALTH).map(() => {
    const heart = document.createElement('span');
    heart.className = 'health__heart';
    root.append(heart);
    return heart;
  });
  parent.append(root);

  /** 上一次画上去的点数。与当前相同就整排跳过。 */
  let shownPoints: number | undefined;

  return {
    update(): void {
      const points = health.points;
      if (points === shownPoints) return;
      shownPoints = points;

      root.setAttribute('aria-valuenow', String(points));
      // 点数与每颗心的状态进 data 属性：端到端测试据此断言，样式也按它选颜色。
      root.dataset.points = String(points);
      heartStates(points).forEach((state, i) => {
        hearts[i]!.dataset.state = state;
      });
    },
    remove(): void {
      root.remove();
    },
  };
}
