import { describe, expect, it } from 'vitest';
import { MAX_LIGHT_LEVEL } from '../../src/core/constants';
import { BLOCKS } from '../../src/core/block';
import {
  BRIGHTNESS_CURVE,
  FACE_SHADE,
  SELF_LIT_BLOCK_LIGHT,
  brightnessAt,
  shadedLevel,
} from '../../src/render/shading';
import { FLICKER_AMPLITUDE } from '../../src/render/torch-light';

describe('等级到亮度的曲线', () => {
  it('15 处是 1；0 处是一个大于 0 的最低值，看得出轮廓', () => {
    expect(brightnessAt(MAX_LIGHT_LEVEL)).toBe(1);
    expect(brightnessAt(0)).toBeGreaterThan(0.05);
    expect(brightnessAt(0)).toBeLessThan(0.3);
  });

  it('每升一级都更亮', () => {
    for (let level = 0; level < MAX_LIGHT_LEVEL; level++) {
      expect(brightnessAt(level + 1), `等级 ${level + 1}`).toBeGreaterThan(brightnessAt(level));
    }
  });

  it('带小数的等级落在两侧整数等级之间：平滑光照的平均与黄昏的减量都不是整数', () => {
    expect(brightnessAt(7.5)).toBeCloseTo((brightnessAt(7) + brightnessAt(8)) / 2, 10);
    expect(brightnessAt(14.25)).toBeGreaterThan(brightnessAt(14));
    expect(brightnessAt(14.25)).toBeLessThan(brightnessAt(15));
  });

  it('超出 0 到 15 的输入按两端算：折算天光减到负数时与 0 一样暗', () => {
    expect(brightnessAt(-3)).toBe(brightnessAt(0));
    expect(brightnessAt(20)).toBe(1);
  });

  it('送进着色器的表有 16 项，与曲线在整数等级上相同', () => {
    expect(BRIGHTNESS_CURVE).toHaveLength(MAX_LIGHT_LEVEL + 1);
    for (let level = 0; level <= MAX_LIGHT_LEVEL; level++) {
      expect(BRIGHTNESS_CURVE[level]).toBeCloseTo(brightnessAt(level), 6);
    }
  });
});

describe('各面的明暗系数', () => {
  it('顶面 1，侧面居中，底面最暗，都大于 0', () => {
    expect(FACE_SHADE.top).toBe(1);
    expect(FACE_SHADE.side).toBeLessThan(FACE_SHADE.top);
    expect(FACE_SHADE.bottom).toBeLessThan(FACE_SHADE.side);
    expect(FACE_SHADE.bottom).toBeGreaterThan(0);
  });
});

describe('火把本身不吃光照（ADR-0016）', () => {
  it('标记用的方块光等级高于任何方块的发光等级：光照传播与平滑光照的平均都到不了它', () => {
    for (const [block, def] of Object.entries(BLOCKS)) {
      expect(def.lightEmission, `方块 ${block}`).toBeLessThan(SELF_LIT_BLOCK_LIGHT);
    }
    expect(SELF_LIT_BLOCK_LIGHT).toBe(MAX_LIGHT_LEVEL);
  });
});

describe('一处的等级：天光、方块光、手持光与闪烁怎样合在一起（着色器同一个算法）', () => {
  /** 白天、没有闪烁、空手、离眼睛 3 格；各条测试只改它关心的那几项。 */
  const base = { sky: 0, block: 0, distance: 3, skyDarkening: 0, flicker: 0, heldLight: 0 };

  it('没有闪烁时取三者中最大的：折算天光、方块光、手持光', () => {
    expect(shadedLevel({ ...base, sky: 15, block: 3, skyDarkening: 11 })).toBe(4);
    expect(shadedLevel({ ...base, sky: 15, block: 9, skyDarkening: 11 })).toBe(9);
    expect(shadedLevel({ ...base, block: 2, heldLight: 14, distance: 4 })).toBe(10);
  });

  it('手持光每离眼睛远一格减 1，14 格外是 0', () => {
    expect(shadedLevel({ ...base, heldLight: 14, distance: 0.5 })).toBe(13.5);
    expect(shadedLevel({ ...base, heldLight: 14, distance: 13 })).toBe(1);
    expect(shadedLevel({ ...base, heldLight: 14, distance: 20 })).toBe(0);
    expect(shadedLevel({ ...base, heldLight: 0, distance: 0.5 })).toBe(0);
  });

  it('闪烁加在方块光与手持光中较大的那个上，天光不加', () => {
    expect(shadedLevel({ ...base, block: 12, flicker: 0.5 })).toBe(12.5);
    expect(shadedLevel({ ...base, block: 3, heldLight: 14, distance: 6, flicker: 0.5 })).toBe(8.5);
    // 白天露天：天光 15 已经最亮，闪烁不改
    expect(shadedLevel({ ...base, sky: 15, flicker: 0.5 })).toBe(15);
    // 夜晚露天没有火把：折算天光 4，不跟着闪
    expect(shadedLevel({ ...base, sky: 15, skyDarkening: 11, flicker: 0.5 })).toBe(4);
  });

  it('方块光与手持光都是 0 的地方不闪：洞里没被火把照到的墙不跟着火把一明一暗', () => {
    expect(shadedLevel({ ...base, flicker: FLICKER_AMPLITUDE })).toBe(0);
    expect(shadedLevel({ ...base, heldLight: 14, distance: 20, flicker: FLICKER_AMPLITUDE })).toBe(0);
  });

  it('照到的光从 0 往上，闪烁量随之从 0 加满：光圈边缘没有一道台阶', () => {
    const at = (block: number) => shadedLevel({ ...base, block, flicker: 0.5 });
    expect(at(0.25) - 0.25).toBeCloseTo(0.125, 10);
    expect(at(1) - 1).toBeCloseTo(0.5, 10);
    expect(at(6) - 6).toBeCloseTo(0.5, 10);
  });

  it('折算天光减到负数按 0 算', () => {
    expect(shadedLevel({ ...base, sky: 3, skyDarkening: 11 })).toBe(0);
  });
});
