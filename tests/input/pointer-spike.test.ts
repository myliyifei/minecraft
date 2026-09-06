import { describe, expect, it } from 'vitest';
import { isPointerSpike } from '../../src/input/pointer-spike';

/**
 * 下面两组样本都是从真实浏览器里采下来的，同一段「朝一个方向连续快转三秒」的
 * 3685 发 mousemove（WSL2 + Chrome，指针锁定正常，`screenX` 全程不动）。
 * 记的是 `|movementX|` 与距上一发的毫秒数。
 */

/** 巨型增量：幅度几乎恒定在 562–578px，与手速无关，所以不是手的位移。 */
const SPIKES: ReadonlyArray<readonly [px: number, ms: number]> = [
  [562, 0.3],
  [563, 0.2],
  [564, 0.4],
  [578, 0.6],
  [562, 0.4],
  [566, 0.2],
  [566, 0.4],
  [566, 0.3],
];

/** 同一段采样里紧挨着那些尖峰的真实增量。中位数是 2px，最大 16px。 */
const REAL_MOVES: ReadonlyArray<readonly [px: number, ms: number]> = [
  [0, 0.1],
  [1, 0.3],
  [1, 0.4],
  [2, 0.1],
  [2, 0.3],
  [2, 0.4],
  [2, 0.5],
  [4, 0.4],
  [4, 0.5],
  [5, 0.4],
  [5, 0.5],
  [5, 0.7],
  [6, 0.2],
  [6, 0.3],
  [6, 0.4],
  [6, 0.6],
  [6, 0.8],
  [7, 0.5],
  [8, 0.3],
  [10, 1.6],
  [12, 0.6],
  [16, 0.6],
];

describe('剔掉浏览器投来的假鼠标增量', () => {
  it('实测到的每一发巨型增量都判成假的', () => {
    const kept = SPIKES.filter(([px, ms]) => !isPointerSpike(px, ms));
    expect(kept).toEqual([]);
  });

  it('同一段采样里的真实增量一发都不误剔', () => {
    const dropped = REAL_MOVES.filter(([px, ms]) => isPointerSpike(px, ms));
    expect(dropped).toEqual([]);
  });

  it('时间戳没前进的巨型增量也判成假的', () => {
    // 实测里尖峰常常成对出现，中间夹一发 Δt=0.00ms 的事件。
    expect(isPointerSpike(566, 0)).toBe(true);
  });

  it('时间戳没前进的小增量不判成假的', () => {
    // 时间戳分辨率有限，正常增量也会撞上 Δt=0；按幅度先放行。
    expect(isPointerSpike(2, 0)).toBe(false);
  });

  it('慢慢移过来的大增量是真的', () => {
    // 标签页切回前台、或浏览器把一批位移合并成一发时，幅度大但摊的时间也长。
    expect(isPointerSpike(566, 100)).toBe(false);
  });

  it('判据看的是速度而不是幅度', () => {
    const [px, ms] = SPIKES[0]!;
    // 同样的幅度，摊在长十倍的时间里就不再是假的了。
    expect(isPointerSpike(px, ms)).toBe(true);
    expect(isPointerSpike(px, ms * 10)).toBe(false);
  });
});
