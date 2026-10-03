import { BLOCKS, placedBlock } from '../core/block';
import { TAU } from '../core/constants';
import type { ItemType } from '../core/item';

/**
 * 火把在画面上的两种光：手持光与闪烁（ADR-0016，见 CONTEXT.md 的「手持光」「闪烁」）。
 *
 * 两者都只改画面：每帧作为 uniform 送进光照材质，不写进光照数组，生成与燃烧都不看它们。闪烁量也让火把本身
 * 有明暗起伏（`selfLitBrightness`）。
 *
 * 纯数学、不 import three，因此能在 Node 里测。
 */

/**
 * 选中格里的物品带来的手持光等级：放下去那种方块的发光等级，火把是 14，其余（空格、工具、
 * 不发光的方块）是 0。着色器再按每一处离眼睛的距离减。
 *
 * 取放置表与方块表，不另记一个 14：手持的火把与放下的火把一样亮，两处的数不会对不上。
 * 熔炉物品放下去是熄火的熔炉，发光 0，所以手持熔炉不亮。
 */
export function heldLightLevel(item: ItemType | undefined): number {
  if (item === undefined) return 0;
  const block = placedBlock(item);
  return block === null ? 0 : BLOCKS[block].lightEmission;
}

/**
 * 闪烁量的上限（光照等级）：闪烁量落在 0 到它之间，加在方块光与手持光上。
 *
 * 不到 1 级：在 7 级上约差 6% 的亮度，在 14 级上约差 3.5%，看得出起伏又不刺眼。
 */
export const FLICKER_AMPLITUDE = 0.8;

/**
 * 叠成闪烁的几条正弦：频率（Hz）、权重与初相。权重之和为 1，所以叠出来落在 −1 到 1。
 *
 * 三个频率互不成整数倍，叠出来的起伏看不出固定的周期。最高的一条 5.3 Hz、权重最小：
 * 60 帧/秒下相邻两帧最多差幅度的 14%，亮度是逐帧渐变的，不会一帧一跳。
 */
const FLICKER_WAVES: readonly { readonly hz: number; readonly weight: number; readonly phase: number }[] = [
  { hz: 1.3, weight: 0.5, phase: 0 },
  { hz: 2.9, weight: 0.3, phase: 1.7 },
  { hz: 5.3, weight: 0.2, phase: 4.1 },
];

/**
 * 这一刻的闪烁量（`seconds` 是真实时间，秒）：在 0 到 `FLICKER_AMPLITUDE` 之间。
 *
 * 所有火把与燃烧中的熔炉共用这一个数，同一节奏。按真实时间而不是 tick：打开界面、世界不推进时火光
 * 照样起伏，核心也不必知道它（核心不许读真实时钟，见架构测试）。
 */
export function flickerAt(seconds: number): number {
  let wave = 0;
  for (const { hz, weight, phase } of FLICKER_WAVES) wave += weight * Math.sin(TAU * hz * seconds + phase);
  return (FLICKER_AMPLITUDE * (wave + 1)) / 2;
}

/**
 * 这一帧送进着色器的闪烁量：设置里关掉了闪烁（ADR-0020）就是 0，火光不再起伏；开着就是 `flickerAt`。
 */
export function frameFlicker(enabled: boolean, seconds: number): number {
  return enabled ? flickerAt(seconds) : 0;
}

/**
 * 闪烁量最小时火把本身暗多少：火把按贴图本色画（`SELF_LIT_BLOCK_LIGHT`），再乘一个随闪烁在
 * 1 − 它到 1 之间起伏的系数，火焰与它照亮的地方同一节奏。
 */
export const SELF_LIT_FLICKER_DIM = 0.12;

/** 火把本身这一帧乘在贴图本色上的系数：闪烁量最大时是 1，最小时是 1 − `SELF_LIT_FLICKER_DIM`。着色器同一个算法。 */
export function selfLitBrightness(flicker: number): number {
  return 1 - SELF_LIT_FLICKER_DIM * (1 - flicker / FLICKER_AMPLITUDE);
}
