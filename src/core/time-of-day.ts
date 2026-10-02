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

/**
 * 黄昏与黎明各持续多少 tick。
 *
 * 黄昏排在夜晚开始之前、黎明排在夜晚结束之后：核心判定为夜晚的整段时间里画面都是全暗的，
 * 天色开始变暗就说明夜晚快到了。两段都落在太阳处于地平线以下的时候——黄昏从日落（12000）
 * 开始，黎明到日出（24000，即 0）结束，天色与太阳的位置对得上。天空色（`dayFactor`）与
 * 天光减量（`skyDarkeningAt`）按同样的两段过渡。
 */
export const TWILIGHT_TICKS = 1000;

/** 夜晚的天光减量（见 CONTEXT.md 的「折算天光」）：露天格子天光 15，夜里折算天光为 4。 */
export const NIGHT_SKY_DARKENING = 11;

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

/**
 * 这一刻的天光减量（见 CONTEXT.md 的「折算天光」）：白天 0，夜晚 `NIGHT_SKY_DARKENING`，
 * 黄昏从 0 线性增上去，黎明线性减回 0。
 *
 * 不取整：时刻可以带小数（渲染层传插值后的时刻），着色器拿这个浮点值，画面因此是连续的。
 * 规则用的是取整之后的值，见 `GameCore.skyDarkening`。
 */
export function skyDarkeningAt(timeOfDay: number): number {
  const duskStart = NIGHT_START - TWILIGHT_TICKS;
  if (timeOfDay < duskStart) return 0;
  if (timeOfDay < NIGHT_START) return (NIGHT_SKY_DARKENING * (timeOfDay - duskStart)) / TWILIGHT_TICKS;
  if (timeOfDay < NIGHT_END) return NIGHT_SKY_DARKENING;
  return Math.max(0, (NIGHT_SKY_DARKENING * (DAY_LENGTH_TICKS - timeOfDay)) / TWILIGHT_TICKS);
}

/** 天光 skyLight 按减量 darkening 折算之后的等级（见 CONTEXT.md 的「折算天光」），不低于 0。 */
export function effectiveSkyLight(skyLight: number, darkening: number): number {
  return Math.max(0, skyLight - darkening);
}
