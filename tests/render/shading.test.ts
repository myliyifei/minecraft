import { describe, expect, it } from 'vitest';
import { MAX_LIGHT_LEVEL } from '../../src/core/constants';
import { BLOCKS } from '../../src/core/block';
import { BRIGHTNESS_CURVE, FACE_SHADE, SELF_LIT_BLOCK_LIGHT, brightnessAt } from '../../src/render/shading';

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
