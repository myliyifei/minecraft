import { TAU } from '../core/constants';

/**
 * 掉落物的漂浮与旋转。
 *
 * 纯数学、不 import three，因此能在 Node 里测——「漂浮整段都在落点之上」这种要看一整个
 * 周期才成立的性质，靠浏览器里抓两帧是断言不出来的。
 *
 * 相位以 tick 计，允许带小数：渲染层传 `age + alpha`（ADR-0002 的插值系数），两次 tick
 * 之间因此是连续的，不会以 20Hz 一跳一跳地转。
 */

/** 转一圈要多少 tick。三秒一圈：看得出在转，又不晃眼。 */
export const DROP_SPIN_TICKS = 60;

/** 上下漂浮一个来回要多少 tick。 */
export const DROP_BOB_TICKS = 40;

/** 漂浮的幅度（方块）。 */
export const DROP_BOB_HEIGHT = 0.05;

/**
 * 相位对应的漂浮高度（方块），恒落在 [0, 2 × `DROP_BOB_HEIGHT`]。
 *
 * 偏移整段在落点之上，而不是围着落点上下对称：掉落物停在地面上，往下漂就会沉进地里。
 */
export function dropBob(phase: number): number {
  return DROP_BOB_HEIGHT * (1 + Math.sin((phase / DROP_BOB_TICKS) * TAU));
}

/** 相位对应的旋转角（弧度），绕竖直轴。 */
export function dropSpin(phase: number): number {
  return (phase / DROP_SPIN_TICKS) * TAU;
}
