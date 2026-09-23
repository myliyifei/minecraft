/**
 * 世界时刻（见 CONTEXT.md）：一天分成 `DAY_LENGTH_TICKS` 个 tick，时刻是一天里的第几个。
 *
 * 时刻由 tick 计数加一个偏移算出来，不单独计一个每 tick 加一的数：`setTimeOfDay` 只改偏移，
 * tick 计数不动，靠 tick 计数起算的那些东西（拾取延迟、熔炼进度、哈希）因此不受拨时刻的影响。
 */

/** 一天多少 tick：20 分钟（20 tick/s）。 */
export const DAY_LENGTH_TICKS = 24000;

/** 夜晚从这一刻开始（含）。 */
export const NIGHT_START = 13000;

/** 夜晚到这一刻结束（不含）。这之后到下一天的 `NIGHT_START` 之前都是白天。 */
export const NIGHT_END = 23000;

/** tick 计数与偏移对应的时刻，落在 [0, `DAY_LENGTH_TICKS`)。偏移可以是负数。 */
export function timeOfDayAt(ticks: number, offset: number): number {
  return wrapTimeOfDay(ticks + offset);
}

/** 把任意一个 tick 数折回一天之内，负数从一天的末尾往回数。 */
export function wrapTimeOfDay(t: number): number {
  return ((t % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
}

/** 这一刻是不是夜晚。白天与夜晚的分界只写在这里。 */
export function isNightAt(timeOfDay: number): boolean {
  return timeOfDay >= NIGHT_START && timeOfDay < NIGHT_END;
}
