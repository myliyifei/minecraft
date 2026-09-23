import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_TICKS, NIGHT_END, NIGHT_START } from '../../src/core/time-of-day';
import {
  DAY_LIGHTING,
  MIN_AMBIENT,
  NIGHT_LIGHTING,
  TWILIGHT_TICKS,
  celestialAngle,
  celestialVisible,
  dayFactor,
  frameTimeOfDay,
  lightingAt,
  moonDirection,
  sunDirection,
  type Rgb,
} from '../../src/render/daylight';

const DAY_SKY: Rgb = [0.2, 0.45, 0.8];
const NIGHT_SKY: Rgb = [0.01, 0.02, 0.05];
const SKY = { day: DAY_SKY, night: NIGHT_SKY };

/** 一整天每 50 tick 取一个时刻。 */
const WHOLE_DAY = Array.from({ length: DAY_LENGTH_TICKS / 50 }, (_, i) => i * 50);

describe('白天到夜晚的比例', () => {
  it('进入世界的早晨与正午是全亮，午夜是全暗', () => {
    expect(dayFactor(0)).toBe(1);
    expect(dayFactor(6000)).toBe(1);
    expect(dayFactor(18000)).toBe(0);
  });

  it('黄昏在夜晚开始之前变暗，到夜晚开始时全暗', () => {
    expect(dayFactor(NIGHT_START - TWILIGHT_TICKS)).toBe(1);
    expect(dayFactor(NIGHT_START - TWILIGHT_TICKS / 2)).toBeCloseTo(0.5, 10);
    expect(dayFactor(NIGHT_START)).toBe(0);
  });

  it('黎明从夜晚结束时开始变亮，到一天结束时全亮', () => {
    expect(dayFactor(NIGHT_END - 1)).toBe(0);
    expect(dayFactor(NIGHT_END)).toBe(0);
    expect(dayFactor(NIGHT_END + TWILIGHT_TICKS / 2)).toBeCloseTo(0.5, 10);
    expect(dayFactor(DAY_LENGTH_TICKS - 1)).toBeLessThan(1);
    expect(dayFactor(DAY_LENGTH_TICKS - 1)).toBeGreaterThan(0.99);
  });

  it('黄昏单调变暗，黎明单调变亮', () => {
    for (let t = NIGHT_START - TWILIGHT_TICKS; t < NIGHT_START; t += 10) {
      expect(dayFactor(t + 10)).toBeLessThan(dayFactor(t));
    }
    for (let t = NIGHT_END; t < DAY_LENGTH_TICKS - 10; t += 10) {
      expect(dayFactor(t + 10)).toBeGreaterThan(dayFactor(t));
    }
  });

  it('带小数的时刻也连续：渲染层传的是插值后的时刻', () => {
    const t = NIGHT_START - 100;
    expect(dayFactor(t + 0.5)).toBeLessThan(dayFactor(t));
    expect(dayFactor(t + 0.5)).toBeGreaterThan(dayFactor(t + 1));
  });
});

describe('亮度与天空色', () => {
  it('白天是白天那组常量，夜晚是夜晚那组', () => {
    const noon = lightingAt(6000, SKY);
    expect(noon.ambient).toBe(DAY_LIGHTING.ambient);
    expect(noon.directional).toBe(DAY_LIGHTING.directional);
    expect(noon.sky).toEqual(DAY_SKY);
    const midnight = lightingAt(18000, SKY);
    expect(midnight.ambient).toBe(NIGHT_LIGHTING.ambient);
    expect(midnight.directional).toBe(NIGHT_LIGHTING.directional);
    expect(midnight.sky).toEqual(NIGHT_SKY);
  });

  it('黄昏正中是两端的插值：环境光、方向光与天空色的每个分量都取两端的平均', () => {
    const dusk = lightingAt(NIGHT_START - TWILIGHT_TICKS / 2, SKY);
    expect(dusk.ambient).toBeCloseTo((DAY_LIGHTING.ambient + NIGHT_LIGHTING.ambient) / 2, 10);
    expect(dusk.directional).toBeCloseTo(
      (DAY_LIGHTING.directional + NIGHT_LIGHTING.directional) / 2,
      10,
    );
    for (let i = 0; i < 3; i++) {
      expect(dusk.sky[i]).toBeCloseTo((DAY_SKY[i]! + NIGHT_SKY[i]!) / 2, 10);
    }
  });

  it('按比例插值：黄昏过了四分之一，离白天那一端四分之一', () => {
    const t = NIGHT_START - TWILIGHT_TICKS * 0.75;
    const f = dayFactor(t);
    expect(f).toBeCloseTo(0.75, 10);
    const { ambient } = lightingAt(t, SKY);
    expect(ambient).toBeCloseTo(NIGHT_LIGHTING.ambient + (DAY_LIGHTING.ambient - NIGHT_LIGHTING.ambient) * f, 10);
  });

  it('夜晚比白天暗，而且一整天的环境光都不低于下限', () => {
    expect(NIGHT_LIGHTING.ambient).toBeLessThan(DAY_LIGHTING.ambient);
    expect(NIGHT_LIGHTING.directional).toBeLessThan(DAY_LIGHTING.directional);
    expect(NIGHT_LIGHTING.ambient).toBeGreaterThanOrEqual(MIN_AMBIENT);
    expect(MIN_AMBIENT).toBeGreaterThan(0);
    for (const t of WHOLE_DAY) {
      expect(lightingAt(t, SKY).ambient, `时刻 ${t}`).toBeGreaterThanOrEqual(MIN_AMBIENT);
    }
  });

  it('夜晚还留着方向光：方块的六个面仍有明暗差，轮廓分得出', () => {
    expect(NIGHT_LIGHTING.directional).toBeGreaterThan(0);
  });
});

describe('画一帧用的时刻', () => {
  it('在上一个 tick 与当前 tick 之间插值', () => {
    expect(frameTimeOfDay(6000, 1)).toBe(6000);
    expect(frameTimeOfDay(6000, 0)).toBe(5999);
    expect(frameTimeOfDay(6000, 0.25)).toBe(5999.25);
  });

  it('跨过 0 点时从一天的末尾接上，不出负数', () => {
    expect(frameTimeOfDay(0, 0)).toBe(DAY_LENGTH_TICKS - 1);
    expect(frameTimeOfDay(0, 0.5)).toBe(DAY_LENGTH_TICKS - 0.5);
    expect(frameTimeOfDay(0, 1)).toBe(0);
    // 跨 0 点那一帧的亮度与前后连续：23999.5 与 0 都接近全亮
    expect(dayFactor(frameTimeOfDay(0, 0.5))).toBeGreaterThan(0.99);
  });
});

describe('太阳与月亮的方向', () => {
  it('转过的角度与方向一致', () => {
    for (const t of [0, 4770.64, 6000, 13000, 18000]) {
      const [x, y] = sunDirection(t);
      expect(Math.cos(celestialAngle(t))).toBeCloseTo(x, 10);
      expect(Math.sin(celestialAngle(t))).toBeCloseTo(y, 10);
    }
  });

  it('早晨太阳在东边地平线，正午在头顶，傍晚在西边，午夜在脚下', () => {
    const at = (t: number) => sunDirection(t).map((v) => Math.round(v * 1e9) / 1e9 + 0);
    expect(at(0)).toEqual([1, 0, 0]);
    expect(at(6000)).toEqual([0, 1, 0]);
    expect(at(12000)).toEqual([-1, 0, 0]);
    expect(at(18000)).toEqual([0, -1, 0]);
  });

  it('月亮永远在太阳的对面', () => {
    for (const t of [0, 3000, 13000, 18000, 23000.5]) {
      const sun = sunDirection(t);
      const moon = moonDirection(t);
      for (let i = 0; i < 3; i++) expect(moon[i]).toBeCloseTo(-sun[i]!, 10);
    }
  });

  it('绕一根固定的轴转：方向恒为单位向量，z 分量恒为 0', () => {
    for (const t of WHOLE_DAY) {
      const [x, y, z] = sunDirection(t);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
      expect(z).toBe(0);
    }
  });

  it('午夜月亮可见、太阳不可见；正午反过来', () => {
    expect(celestialVisible(moonDirection(18000))).toBe(true);
    expect(celestialVisible(sunDirection(18000))).toBe(false);
    expect(celestialVisible(sunDirection(6000))).toBe(true);
    expect(celestialVisible(moonDirection(6000))).toBe(false);
  });

  it('刚落到地平线下还露着一点，落深了才不可见', () => {
    expect(celestialVisible([1, 0, 0])).toBe(true);
    expect(celestialVisible([Math.cos(0.01), -Math.sin(0.01), 0])).toBe(true);
    expect(celestialVisible([Math.cos(0.5), -Math.sin(0.5), 0])).toBe(false);
  });
});
