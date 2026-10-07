import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { selectionBounds } from '../../src/render/selection';

describe('选框套住的范围（见 GLOSSARY.md 的「选框」）', () => {
  it('整格方块：选框就是那一格', () => {
    expect(selectionBounds(BlockType.Stone, 3, 10, -4)).toEqual({
      min: { x: 3, y: 10, z: -4 },
      max: { x: 4, y: 11, z: -3 },
    });
  });

  it('地面火把：选框只套那根细杆，截面 2/16、高 10/16，以格中心为轴立在格底（#57）', () => {
    const { min, max } = selectionBounds(BlockType.Torch, 3, 10, -4);
    expect(min.x).toBeCloseTo(3 + 7 / 16);
    expect(max.x).toBeCloseTo(3 + 9 / 16);
    expect(min.y).toBeCloseTo(10);
    expect(max.y).toBeCloseTo(10 + 10 / 16);
    expect(min.z).toBeCloseTo(-4 + 7 / 16);
    expect(max.z).toBeCloseTo(-4 + 9 / 16);
  });

  it('墙上火把：选框是包住整根斜杆的轴对齐盒子，贴着墙、离墙最远约 5.75/16（#57）', () => {
    const { min, max } = selectionBounds(BlockType.WallTorchPosZ, 3, 10, -4);
    // 斜 22.5°：底面中心离墙 1/16，朝外伸出 1/16·cos + 10/16·sin，底与顶各被截面带出 1/16·sin
    const tilt = Math.PI / 8;
    expect(min.x).toBeCloseTo(3 + 7 / 16);
    expect(max.x).toBeCloseTo(3 + 9 / 16);
    expect(min.y).toBeCloseTo(10 + 3 / 16 - Math.sin(tilt) / 16);
    expect(max.y).toBeCloseTo(10 + 3 / 16 + (10 * Math.cos(tilt) + Math.sin(tilt)) / 16);
    // 墙在 +Z 那一侧（z = −3）
    expect(max.z).toBeCloseTo(-3 - (1 - Math.cos(tilt)) / 16);
    expect(min.z).toBeCloseTo(-3 - (1 + Math.cos(tilt) + 10 * Math.sin(tilt)) / 16);
  });
});
