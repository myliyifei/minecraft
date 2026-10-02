import { describe, expect, it } from 'vitest';
import { isPointerWarp, WARP_WINDOW_MS } from '../../src/input/pointer-warp';

describe('锁定之后的第一发鼠标移动是不是光标归位事件', () => {
  it('还没收到锁定变更事件就到了：WSL2 上的 Chrome 补投的归位事件，丢掉', () => {
    expect(isPointerWarp(undefined, 1000)).toBe(true);
  });

  it('锁定生效后 1 毫秒内到达：无头 Chromium 补投的归位事件，丢掉', () => {
    // 实测锁定变更 526.3、归位事件 526.7
    expect(isPointerWarp(526.3, 526.7)).toBe(true);
  });

  it('时间戳比锁定变更还早：同一段队列里排在后面投递的归位事件，丢掉', () => {
    expect(isPointerWarp(717, 716)).toBe(true);
  });

  it('锁定生效之后过了一阵才到：Windows Edge 上玩家真的动了鼠标，照常转动视角', () => {
    expect(isPointerWarp(1000, 1000 + WARP_WINDOW_MS + 1)).toBe(false);
    expect(isPointerWarp(1000, 1300)).toBe(false);
  });

  it('窗口的边上还算', () => {
    expect(isPointerWarp(1000, 1000 + WARP_WINDOW_MS)).toBe(true);
  });
});
