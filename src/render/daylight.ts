import { TAU } from '../core/constants';
import { DAY_LENGTH_TICKS, NIGHT_END, NIGHT_START, wrapTimeOfDay } from '../core/time-of-day';

/**
 * 昼夜在画面上的样子：亮度、天空色、太阳与月亮的方向，全由世界时刻算出来。
 *
 * 纯数学、不 import three，因此能在 Node 里测。时刻允许带小数：渲染层传的是两次 tick 之间
 * 插值后的时刻（ADR-0002），黄昏变暗与太阳移动因此是连续的。
 *
 * 本切片没有光照传播：整个场景一起变暗变亮，地下与地面同一个亮度。
 */

/** 一种 RGB 颜色，三个分量在 [0, 1]。插值在调用方给的颜色空间里按分量做。 */
export type Rgb = readonly [number, number, number];

/** 一个方向（单位向量，世界坐标）：x 朝东、y 朝上。 */
export type Direction = readonly [number, number, number];

/** 一组灯的强度：环境光打底，方向光让方块的六个面有明暗区分。 */
export interface LightIntensity {
  readonly ambient: number;
  readonly directional: number;
}

/**
 * 白天的两盏灯。
 * 两者的比例决定体积感——环境光太强，六个面的明暗差别就没了，方块看上去是平的。
 */
export const DAY_LIGHTING: LightIntensity = { ambient: 1.05, directional: 1.45 };

/**
 * 夜晚的两盏灯。仍留着一点方向光：六个面的明暗差还在，方块的轮廓在夜里分得出来。
 */
export const NIGHT_LIGHTING: LightIntensity = { ambient: 0.34, directional: 0.3 };

/**
 * 环境光的下限：`lightingAt` 算出的环境光一整天都不低于它，夜晚那组常量调得再低也一样。
 * 再暗下去，背光的那几个面与夜空分不开，看不出方块的轮廓。
 */
export const MIN_AMBIENT = 0.3;

/**
 * 黄昏与黎明各持续多少 tick。
 *
 * 黄昏排在夜晚开始之前、黎明排在夜晚结束之后：核心判定为夜晚的整段时间里画面都是全暗的，
 * 天色开始变暗就说明夜晚快到了。两段都落在太阳处于地平线以下的时候——黄昏从日落（12000）
 * 开始，黎明到日出（24000，即 0）结束，天色与太阳的位置对得上。
 */
export const TWILIGHT_TICKS = 1000;

/** 黄昏从这一刻开始。 */
const DUSK_START = NIGHT_START - TWILIGHT_TICKS;

/**
 * 这一刻的「白天程度」：白天是 1，夜晚是 0，黄昏与黎明在两者之间线性过渡。
 *
 * 时刻要落在 [0, `DAY_LENGTH_TICKS`)。黎明结束在一天的末尾，所以进入世界的时刻 0 是全亮的。
 */
export function dayFactor(timeOfDay: number): number {
  if (timeOfDay < DUSK_START) return 1;
  if (timeOfDay < NIGHT_START) return (NIGHT_START - timeOfDay) / TWILIGHT_TICKS;
  if (timeOfDay < NIGHT_END) return 0;
  return Math.min(1, (timeOfDay - NIGHT_END) / TWILIGHT_TICKS);
}

/** 这一刻的灯光强度与天空色。 */
export interface Lighting extends LightIntensity {
  readonly sky: Rgb;
}

/** 天空色的两端：白天与夜晚各一个颜色。 */
export interface SkyEnds {
  readonly day: Rgb;
  readonly night: Rgb;
}

/**
 * 这一刻的灯光强度与天空色：白天那组与夜晚那组按 `dayFactor` 插值，环境光再以 `MIN_AMBIENT`
 * 为下限。
 *
 * 天空色两端由调用方给：白天那一端是世界色板的 `--sky`，界面与 3D 场景共用一份颜色。
 */
export function lightingAt(timeOfDay: number, sky: SkyEnds): Lighting {
  const f = dayFactor(timeOfDay);
  return {
    ambient: Math.max(MIN_AMBIENT, mix(NIGHT_LIGHTING.ambient, DAY_LIGHTING.ambient, f)),
    directional: mix(NIGHT_LIGHTING.directional, DAY_LIGHTING.directional, f),
    sky: [
      mix(sky.night[0], sky.day[0], f),
      mix(sky.night[1], sky.day[1], f),
      mix(sky.night[2], sky.day[2], f),
    ],
  };
}

/**
 * 画这一帧用的时刻：上一个 tick 与当前 tick 之间按 `alpha` 插值（ADR-0002），落在一天之内。
 *
 * 时刻每 tick 加 1，所以上一个 tick 的时刻就是当前减 1；跨过 0 点时从一天的末尾接上，
 * 不会从 23999 跳回到一个负数。`setTimeOfDay` 之后的第一帧会差出不到 1 tick，看不出来。
 */
export function frameTimeOfDay(timeOfDay: number, alpha: number): number {
  return wrapTimeOfDay(timeOfDay - 1 + alpha);
}

/**
 * 太阳绕 z 轴转过的角度（弧度），一天一圈：时刻 0 是 0（东边的地平线），6000 是 π/2（头顶）。
 */
export function celestialAngle(timeOfDay: number): number {
  return (timeOfDay / DAY_LENGTH_TICKS) * TAU;
}

/**
 * 太阳所在的方向（单位向量，世界坐标）。
 *
 * 绕 z 轴转，一天一圈：时刻 0 在东边（+X）的地平线上，6000 在头顶，12000 落到西边，
 * 18000 在脚下。轴是固定的，太阳因此每天走同一条路。
 */
export function sunDirection(timeOfDay: number): Direction {
  const angle = celestialAngle(timeOfDay);
  return [Math.cos(angle), Math.sin(angle), 0];
}

/** 月亮所在的方向：永远在太阳的对面，所以午夜在头顶。 */
export function moonDirection(timeOfDay: number): Direction {
  const [x, y, z] = sunDirection(timeOfDay);
  return [-x, -y, -z];
}

/**
 * 太阳与月亮离相机多远（方块），要在相机的远裁剪面之内。
 *
 * 它们不靠这个距离排在地形后面：渲染层先画它们、不写深度（见 renderer.ts 的 `celestialQuad`），
 * 地形总盖在它们上面。视距内最远的方块可以比这个距离还远。
 */
export const CELESTIAL_DISTANCE = 400;

/** 太阳与月亮那一张方片的边长（方块）。在 `CELESTIAL_DISTANCE` 外看约 8.6°。 */
export const CELESTIAL_SIZE = 60;

/**
 * 太阳与月亮的中心能落到地平线下多深还画：方片的半边长对应的仰角的正弦。
 * 中心刚过地平线时方片还露着上半截，整块落下去才不画。
 */
const CELESTIAL_HIDE_BELOW = -Math.sin(Math.atan(CELESTIAL_SIZE / 2 / CELESTIAL_DISTANCE));

/**
 * 在这个方向上的太阳或月亮画不画：整块落到地平线以下就不画。
 *
 * 视距之外没有地形挡着，不藏起来的话，落下去的太阳会从世界边缘的下方透出来。
 */
export function celestialVisible(direction: Direction): boolean {
  return direction[1] > CELESTIAL_HIDE_BELOW;
}

function mix(from: number, to: number, f: number): number {
  return from + (to - from) * f;
}
