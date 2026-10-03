import { describe, expect, it } from 'vitest';
import { ItemType } from '../../src/core/item';
import {
  FLICKER_AMPLITUDE,
  SELF_LIT_FLICKER_DIM,
  flickerAt,
  frameFlicker,
  heldLightLevel,
  selfLitBrightness,
} from '../../src/render/torch-light';

describe('手持光等级（选中格里的物品）', () => {
  it('选中火把是 14：与放下的火把一样亮', () => {
    expect(heldLightLevel(ItemType.Torch)).toBe(14);
  });

  it('空格是 0', () => {
    expect(heldLightLevel(undefined)).toBe(0);
  });

  it('别的物品都是 0：方块、熔炉、煤炭、工具都不发光', () => {
    for (const item of Object.values(ItemType)) {
      if (item === ItemType.Torch) continue;
      expect(heldLightLevel(item), `物品 ${item}`).toBe(0);
    }
  });
});

describe('闪烁量（按真实时间的小幅周期扰动）', () => {
  /** 0 到 10 秒之间每 1/60 秒取一次，相当于 60 帧/秒连画 10 秒。 */
  const frames = Array.from({ length: 600 }, (_, frame) => flickerAt(frame / 60));

  it('每一帧都落在 0 到设定的幅度之间：非负，加到方块光上只会更亮', () => {
    for (const [frame, flicker] of frames.entries()) {
      expect(flicker, `第 ${frame} 帧`).toBeGreaterThanOrEqual(0);
      expect(flicker, `第 ${frame} 帧`).toBeLessThanOrEqual(FLICKER_AMPLITUDE);
    }
  });

  it('幅度是小幅的：不超过 1 级，火光起伏不刺眼', () => {
    expect(FLICKER_AMPLITUDE).toBeGreaterThan(0);
    expect(FLICKER_AMPLITUDE).toBeLessThanOrEqual(1);
  });

  it('一段时间内有变化：10 秒里起伏用到了幅度的大半', () => {
    const spread = Math.max(...frames) - Math.min(...frames);
    expect(spread).toBeGreaterThan(FLICKER_AMPLITUDE * 0.6);
  });

  it('相邻两帧变化不大：不是每帧乱跳', () => {
    for (let frame = 1; frame < frames.length; frame++) {
      expect(Math.abs(frames[frame]! - frames[frame - 1]!), `第 ${frame} 帧`).toBeLessThan(
        FLICKER_AMPLITUDE * 0.25,
      );
    }
  });

  it('同一时刻同一个值：所有火把共用这一个数，同一节奏', () => {
    expect(flickerAt(3.21)).toBe(flickerAt(3.21));
  });
});

describe('火把本身随闪烁起伏', () => {
  it('闪烁量最大时是贴图本色，最小时暗 SELF_LIT_FLICKER_DIM，仍是画面上最亮的一类东西', () => {
    expect(selfLitBrightness(FLICKER_AMPLITUDE)).toBe(1);
    expect(selfLitBrightness(0)).toBeCloseTo(1 - SELF_LIT_FLICKER_DIM, 10);
    expect(SELF_LIT_FLICKER_DIM).toBeGreaterThan(0);
    expect(SELF_LIT_FLICKER_DIM).toBeLessThanOrEqual(0.2);
  });

  it('闪烁量越大越亮', () => {
    expect(selfLitBrightness(FLICKER_AMPLITUDE / 2)).toBeGreaterThan(selfLitBrightness(0));
    expect(selfLitBrightness(FLICKER_AMPLITUDE / 2)).toBeLessThan(selfLitBrightness(FLICKER_AMPLITUDE));
  });
});

describe('闪烁开关（ADR-0020）', () => {
  it('关掉时每一刻的闪烁量都是 0', () => {
    for (let t = 0; t < 10; t += 0.137) expect(frameFlicker(false, t)).toBe(0);
  });

  it('开着时就是这一刻的闪烁量', () => {
    for (let t = 0; t < 10; t += 0.137) expect(frameFlicker(true, t)).toBe(flickerAt(t));
  });
});
