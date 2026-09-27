import { describe, expect, it } from 'vitest';
import { HELD_SWING_TICKS, heldSwingPhase, heldSwingPose } from '../../src/render/held-swing';

describe('手持物品的挥动（#42）', () => {
  it('还没按过左键：不挥', () => {
    expect(heldSwingPhase(undefined, false, 30, 0.5)).toBe(0);
  });

  it('左键按下后挥一次：按下那一 tick 起 6 tick 内相位从 0 走到 1，之后停在 0', () => {
    expect(HELD_SWING_TICKS).toBe(6);
    const phases: number[] = [];
    for (let now = 40; now < 40 + HELD_SWING_TICKS; now++) {
      for (const alpha of [0.25, 0.75]) phases.push(heldSwingPhase(40, false, now, alpha));
    }
    // 单调增大，都落在 (0, 1) 里
    expect(phases.every((phase) => phase > 0 && phase < 1)).toBe(true);
    expect([...phases].sort((a, b) => a - b)).toEqual(phases);
    expect(heldSwingPhase(40, false, 40 + HELD_SWING_TICKS, 0)).toBe(0);
    expect(heldSwingPhase(40, false, 40 + HELD_SWING_TICKS + 3, 0.5)).toBe(0);
  });

  it('挖掘中持续挥动：过了一次挥动的时长还在挥，一轮 6 tick', () => {
    expect(heldSwingPhase(40, true, 40 + HELD_SWING_TICKS + 3, 0)).toBeCloseTo(0.5, 12);
    expect(heldSwingPhase(40, true, 40 + 5 * HELD_SWING_TICKS + 3, 0)).toBeCloseTo(0.5, 12);
  });

  it('相位 0 是原位；挥到一半时手持物品往下、往里挪并向前转', () => {
    expect(heldSwingPose(0)).toEqual({ x: 0, y: 0, z: 0, pitch: 0 });
    const mid = heldSwingPose(0.5);
    expect(mid.y).toBeLessThan(0);
    expect(mid.x).toBeLessThan(0);
    expect(mid.pitch).toBeLessThan(0);
    // 挥完回到原位附近
    const end = heldSwingPose(0.999);
    expect(Math.abs(end.y)).toBeLessThan(Math.abs(mid.y) / 10);
  });
});
