import { MAX_LIGHT_LEVEL } from '../core/constants';

/**
 * 着色器怎样把光照等级画成明暗（ADR-0016）：等级到亮度的曲线，与各面固定的明暗系数。
 *
 * 纯数据、不 import three，因此能在 Node 里测；着色器（`light-material.ts`）只拿这里的数。
 * 两者都按画面上看到的亮度给（乘在 sRGB 颜色上），着色器在线性空间里乘之前自己换算。
 */

/**
 * 等级 0 的亮度：洞里没有火把时的样子。很暗，但墙面与路的轮廓看得出来（见 CONTEXT.md 的「亮度」）。
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
