import { describe, expect, it } from 'vitest';
import { TAU } from '../../src/core/constants';
import {
  DROP_BOB_HEIGHT,
  DROP_BOB_TICKS,
  DROP_SPIN_TICKS,
  dropBob,
  dropSpin,
} from '../../src/render/drop-motion';

/** 一整个漂浮周期上密集采样的相位。 */
const BOB_PHASES = Array.from({ length: 4 * DROP_BOB_TICKS + 1 }, (_, i) => i / 4);

describe('掉落物的漂浮', () => {
  it('整个周期都不低于落点，最低正好贴着落点', () => {
    // 这一条是「小方块不会沉进地面」：偏移必须整段非负，不是围着落点上下对称
    const heights = BOB_PHASES.map(dropBob);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...heights)).toBeCloseTo(0, 6);
  });

  it('最高浮到两倍幅度', () => {
    expect(Math.max(...BOB_PHASES.map(dropBob))).toBeCloseTo(2 * DROP_BOB_HEIGHT, 6);
  });

  it('一个周期之后回到原处', () => {
    for (const phase of [0, 7.5, 19, 33.25]) {
      expect(dropBob(phase + DROP_BOB_TICKS), `相位 ${phase}`).toBeCloseTo(dropBob(phase), 10);
    }
  });

  it('相位带小数时给出中间高度，不是跳变', () => {
    // 渲染层传的是 age + alpha，两次 tick 之间必须连续
    const low = dropBob(0);
    const high = dropBob(1);
    expect(dropBob(0.5)).toBeGreaterThan(Math.min(low, high));
    expect(dropBob(0.5)).toBeLessThan(Math.max(low, high));
  });
});

describe('掉落物的旋转', () => {
  it('转满一圈正好是一整圈弧度', () => {
    expect(dropSpin(DROP_SPIN_TICKS) - dropSpin(0)).toBeCloseTo(TAU, 10);
  });

  it('角度随相位单调递增', () => {
    let previous = -Infinity;
    for (let phase = 0; phase <= 2 * DROP_SPIN_TICKS; phase += 0.5) {
      const angle = dropSpin(phase);
      expect(angle).toBeGreaterThan(previous);
      previous = angle;
    }
  });

  it('半圈就是半个圈的弧度', () => {
    expect(dropSpin(DROP_SPIN_TICKS / 2)).toBeCloseTo(Math.PI, 10);
  });
});
