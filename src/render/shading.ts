import { MAX_LIGHT_LEVEL } from '../core/constants';

/**
 * 着色器怎样把光照等级画成明暗（ADR-0016）：等级到亮度的曲线，与各面固定的明暗系数。
 *
 * 纯数据、不 import three，因此能在 Node 里测；着色器（`light-material.ts`）只拿这里的数。
 * 两者都按画面上看到的亮度给（乘在 sRGB 颜色上），着色器在线性空间里乘之前自己换算。
 */

/**
 * 等级 0 的亮度：洞里没有火把时的样子。很暗，但墙面与路的轮廓看得出来（见 GLOSSARY.md 的「亮度」）。
 */
export const BRIGHTNESS_FLOOR = 0.2;

/**
 * 曲线的指数：亮度 = 下限 + (1 − 下限) × (等级 / 15) 的这个次方。
 *
 * 小于 1 让中间的等级偏亮一点：夜晚露天是 4，墙脚的平滑光照平均下来是 11.25，太暗的话夜里看不清路、
 * 白天每个墙脚都是一道黑边。
 */
const BRIGHTNESS_EXPONENT = 0.8;

/**
 * 每个整数等级的亮度，下标是等级 0 到 15。着色器拿这张表做线性插值，`brightnessAt` 也按同样的
 * 插值算，所以测试断言的就是画面上的值。
 */
export const BRIGHTNESS_CURVE: Float32Array = Float32Array.from(
  { length: MAX_LIGHT_LEVEL + 1 },
  (_, level) =>
    BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * (level / MAX_LIGHT_LEVEL) ** BRIGHTNESS_EXPONENT,
);
// 15 写死成 1：浮点的次方算出来可能差一点。0 那一端是下限加 0，本来就准。
BRIGHTNESS_CURVE[MAX_LIGHT_LEVEL] = 1;

/**
 * 一个等级（可以带小数）的亮度：在 `BRIGHTNESS_CURVE` 的相邻两项之间线性插值，超出 0 到 15 的按两端算。
 *
 * 等级带小数有两个来源：平滑光照取 4 格的平均，黄昏的天光减量不取整。
 */
export function brightnessAt(level: number): number {
  const clamped = Math.min(Math.max(level, 0), MAX_LIGHT_LEVEL);
  const below = Math.floor(clamped);
  if (below === MAX_LIGHT_LEVEL) return BRIGHTNESS_CURVE[below]!;
  const t = clamped - below;
  return BRIGHTNESS_CURVE[below]! * (1 - t) + BRIGHTNESS_CURVE[below + 1]! * t;
}

/**
 * 各面固定的明暗系数，乘在亮度上：顶面最亮、底面最暗、四个侧面居中且相同。
 *
 * 不随太阳转：太阳方向影响明暗不在本切片（#50 的范围之外）。
 */
export const FACE_SHADE = { top: 1, side: 0.75, bottom: 0.55 } as const;

/**
 * 火把自己的顶点在网格里带的方块光（ADR-0016 补记）：着色器见到它就不乘亮度曲线、不乘面系数，按贴图本色画，
 * 火把本身因此总是最亮，四个侧面与顶面一样亮。
 *
 * 用一个等级当标记而不另开顶点属性：任何方块的发光都低于 15，传到邻格只会更低，平滑光照取平均也到不了，
 * 所以只有火把的顶点是这个值（测试守着这一条）。实体的等级读自光照数组，同样到不了。
 */
export const SELF_LIT_BLOCK_LIGHT = MAX_LIGHT_LEVEL;

/** 着色器在一处合成等级要用的输入：这一处的两个等级、这一处到眼睛的距离，与这一帧送进着色器的三个数。 */
export interface ShadedLevelInput {
  readonly sky: number;
  readonly block: number;
  /** 这一处到玩家眼睛的距离（方块）。 */
  readonly distance: number;
  readonly skyDarkening: number;
  readonly flicker: number;
  /** 手持光等级（`heldLightLevel`）。 */
  readonly heldLight: number;
}

/**
 * 一处送进 `brightnessAt` 的等级，与着色器同一个算法：max(折算天光, 照到的光 + 闪烁)，
 * 照到的光是方块光与这一处的手持光（手持光等级减去离眼睛的距离，不低于 0）中较大的那个。
 *
 * 闪烁只加在照到的光上，天光不加（见 GLOSSARY.md 的「闪烁」）。照到的光不足 1 级时闪烁按比例减小，
 * 到 0 就不闪：洞里没被火把照到的墙不跟着火把一明一暗，光圈的边缘也不会因为加了闪烁多出一道台阶。
 */
export function shadedLevel({ sky, block, distance, skyDarkening, flicker, heldLight }: ShadedLevelInput): number {
  const held = Math.max(0, heldLight - distance);
  const lit = Math.max(block, held);
  return Math.max(Math.max(sky - skyDarkening, 0), lit + flicker * Math.min(lit, 1));
}

