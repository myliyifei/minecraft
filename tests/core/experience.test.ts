import { describe, expect, it } from 'vitest';
import { Experience, levelBreakdown, levelSpan } from '../../src/core/experience';

/**
 * issue #9 给的三段公式，写死字面值。
 *
 * 不从 `levelSpan` 反算：右边一旦是同一个式子，就是拿实现比它自己，分界写错也照样通过。
 */
const SPANS: readonly (readonly [number, number])[] = [
  [0, 7],
  [1, 9],
  [15, 37],
  // 分界：16 级仍走第一段，17 级起走第二段
  [16, 39],
  [17, 47],
  [30, 112],
  [31, 117],
  // 分界：32 级起走第三段
  [32, 130],
  [50, 292],
];

/**
 * 累计到某一级刚满时的总经验值。
 *
 * 0–17 级都在第一段里，逐级累加 2L+7 的闭式解是 L² + 6L；再往上按段累加。
 * 同样写死，好让分界写错时这张表报出来。
 */
const TOTAL_AT_LEVEL: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 7],
  [2, 16],
  [16, 352],
  [17, 391],
  [31, 1504],
  [32, 1621],
];

describe('每级所需经验值', () => {
  it.each(SPANS)('%i 级升到下一级需要 %i 点', (level, span) => {
    expect(levelSpan(level)).toBe(span);
  });

  it('每级所需随等级单调递增', () => {
    for (let level = 0; level < 60; level++) {
      expect(levelSpan(level + 1), `${level} → ${level + 1}`).toBeGreaterThan(levelSpan(level));
    }
  });
});

describe('累计经验值换算等级', () => {
  it.each(TOTAL_AT_LEVEL)('%i 级正好在累计 %i 点时满', (level, total) => {
    const at = levelBreakdown(total);
    expect(at.level).toBe(level);
    expect(at.intoLevel).toBe(0);
  });

  it('刚满某一级时，本级共需按新一级的公式算', () => {
    // 验收条件「16 级满 → 17 级所需按新公式」：满 17 级那一刻，本级共需是第二段的 5L−38
    expect(levelBreakdown(391)).toEqual({ level: 17, intoLevel: 0, levelSpan: 47 });
    // 32 级同理，走第三段的 9L−158
    expect(levelBreakdown(1621)).toEqual({ level: 32, intoLevel: 0, levelSpan: 130 });
  });

  it('差一点升级时仍是上一级，且等级内经验攒满到差一点', () => {
    expect(levelBreakdown(6)).toEqual({ level: 0, intoLevel: 6, levelSpan: 7 });
    expect(levelBreakdown(390)).toEqual({ level: 16, intoLevel: 38, levelSpan: 39 });
  });

  it('等级内经验加上前面各级之和就是累计值', () => {
    for (let total = 0; total <= 500; total++) {
      const { level, intoLevel } = levelBreakdown(total);
      let sum = intoLevel;
      for (let l = 0; l < level; l++) sum += levelSpan(l);
      expect(sum, `累计 ${total}`).toBe(total);
    }
  });

  it('等级内经验永远小于本级共需', () => {
    for (let total = 0; total <= 500; total++) {
      const { intoLevel, levelSpan: span } = levelBreakdown(total);
      expect(intoLevel, `累计 ${total}`).toBeLessThan(span);
    }
  });
});

describe('玩家的经验', () => {
  it('新玩家 0 级、0 经验、进度为 0', () => {
    const experience = new Experience();
    expect(experience.total).toBe(0);
    expect(experience.level).toBe(0);
    expect(experience.intoLevel).toBe(0);
    expect(experience.progress).toBe(0);
  });

  it('累加经验值', () => {
    const experience = new Experience();
    experience.gain(3);
    experience.gain(3);
    expect(experience.total).toBe(6);
    expect(experience.level).toBe(0);
    expect(experience.intoLevel).toBe(6);
  });

  it('攒够 7 点升到 1 级，等级内经验从头开始', () => {
    const experience = new Experience();
    experience.gain(7);
    expect(experience.level).toBe(1);
    expect(experience.intoLevel).toBe(0);
    expect(experience.levelSpan).toBe(9);
    expect(experience.progress).toBe(0);
  });

  it('一次给的经验够跨两级也算得对', () => {
    const experience = new Experience();
    // 7 + 9 = 16 正好两级，多出来的 2 点留在 2 级里
    experience.gain(18);
    expect(experience.level).toBe(2);
    expect(experience.intoLevel).toBe(2);
  });

  it('进度是等级内经验占本级共需的比例', () => {
    const experience = new Experience();
    experience.gain(3);
    expect(experience.progress).toBeCloseTo(3 / 7, 10);
  });

  it('0 与负数不改变经验值', () => {
    const experience = new Experience();
    experience.gain(5);
    experience.gain(0);
    experience.gain(-3);
    expect(experience.total).toBe(5);
  });
});
