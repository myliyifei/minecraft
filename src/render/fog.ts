import type { Rgb } from './daylight';

/**
 * 这一帧的雾：眼睛在水下（`PlayerView.eyeInWater`）时开启，混入蓝色的雾色、只看得清近处，平时关闭。
 *
 * 纯数学、不 import three，与 daylight.ts 同类，因此能在 Node 里测。着色器怎么用这几个数见 light-material.ts 的
 * `FrameLighting`：按每一处到相机的距离，从 `near` 开始混入雾色，到 `far` 全是雾色（ADR-0016 补记）。
 * 在水下时场景背景色也取雾色，远处没有地形的地方与全部显示为雾色的地形是同一个颜色。
 */

/** 这一帧的雾。 */
export interface Fog {
  readonly enabled: boolean;
  /** 雾色（sRGB 三分量）。在水下时背景色也取它。 */
  readonly color: Rgb;
  /** 到相机多远（方块）开始混入雾色。 */
  readonly near: number;
  /** 到相机多远（方块）全是雾色。 */
  readonly far: number;
}

/** 水下雾的颜色（sRGB）：偏深的蓝色。 */
export const UNDERWATER_FOG_COLOR: Rgb = [0.05, 0.15, 0.45];

/** 水下雾从这个距离（方块）开始混入：交互距离以内看得清。 */
export const UNDERWATER_FOG_NEAR = 1;

/**
 * 水下雾到这个距离（方块）全是雾色。要小于最小视距的加载边缘（4 个区块，64 格）：雾得在最近可能出现的区块边缘之前
 * 让地形全部显示为雾色，否则在水下看得到区块边缘。
 */
export const UNDERWATER_FOG_FAR = 16;

const UNDERWATER: Fog = Object.freeze({
  enabled: true,
  color: UNDERWATER_FOG_COLOR,
  near: UNDERWATER_FOG_NEAR,
  far: UNDERWATER_FOG_FAR,
});

/** 关闭时颜色与距离不参与计算，取水下那一份，以免切换时着色器读到无意义的值。 */
const CLEAR: Fog = Object.freeze({ ...UNDERWATER, enabled: false });

/** 这一帧的雾：眼睛在水下时是水下雾，否则关闭。 */
export function fogAt(eyeInWater: boolean): Fog {
  return eyeInWater ? UNDERWATER : CLEAR;
}
