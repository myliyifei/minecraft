import { describe, expect, it } from 'vitest';
import { fbm2, hashCoords, perlin2 } from '../../src/core/noise';

/** 一批含负数、跨区块、大坐标的采样点，用来代替真随机采样（测试必须确定性）。 */
const POINTS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, -1],
  [15, -16],
  [-33, 48],
  [1000, -1000],
  [123_456, 654_321],
];

describe('hashCoords', () => {
  it('同样的种子与坐标给出同样的值', () => {
    for (const [x, z] of POINTS) {
      expect(hashCoords(7, x, z)).toBe(hashCoords(7, x, z));
    }
  });

  it('结果是 32 位无符号整数', () => {
    for (const [x, z] of POINTS) {
      const h = hashCoords(-9, x, z);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('换种子就换值', () => {
    for (const [x, z] of POINTS) {
      expect(hashCoords(1, x, z)).not.toBe(hashCoords(2, x, z));
    }
  });

  it('x 与 z 不对称：交换两者得到不同的值', () => {
    expect(hashCoords(5, 3, 9)).not.toBe(hashCoords(5, 9, 3));
  });

  it('相邻坐标在整个网格上几乎不碰撞', () => {
    const seen = new Set<number>();
    for (let x = -40; x < 40; x++) {
      for (let z = -40; z < 40; z++) {
        seen.add(hashCoords(42, x, z));
      }
    }
    // 6400 个格点，允许极少量碰撞，但不能出现成片重复。
    expect(seen.size).toBeGreaterThan(6390);
  });
});

describe('perlin2', () => {
  it('确定性：同样的种子与坐标给出同样的值', () => {
    for (const [x, z] of POINTS) {
      expect(perlin2(5, x * 0.13, z * 0.13)).toBe(perlin2(5, x * 0.13, z * 0.13));
    }
  });

  it('值域落在 [−1, 1]', () => {
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) {
        const v = perlin2(8, i * 0.37 - 37, j * 0.37 - 37);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('整数格点上为 0（梯度噪声的特征）', () => {
    for (const [x, z] of POINTS) {
      expect(Math.abs(perlin2(8, x, z))).toBeLessThan(1e-12);
    }
  });

  it('格点之间不恒为 0，确实产生了起伏', () => {
    let nonZero = 0;
    for (let i = 1; i < 20; i++) {
      if (Math.abs(perlin2(8, i + 0.5, i * 0.25 + 0.3)) > 0.01) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(10);
  });

  it('连续：坐标走一小步，值也只变一小点', () => {
    const step = 0.01;
    for (let i = 0; i < 500; i++) {
      const x = i * 0.031 - 8;
      const z = i * 0.017 + 3;
      const delta = Math.abs(perlin2(2, x + step, z) - perlin2(2, x, z));
      // 梯度噪声的斜率有界，一格内的最大变化远小于 1
      expect(delta).toBeLessThan(0.1);
    }
  });

  it('换种子得到另一个噪声场', () => {
    let differing = 0;
    for (let i = 0; i < 100; i++) {
      const x = i * 0.41;
      const z = i * 0.23;
      if (Math.abs(perlin2(1, x, z) - perlin2(2, x, z)) > 1e-6) differing++;
    }
    expect(differing).toBeGreaterThan(90);
  });
});

describe('fbm2', () => {
  it('确定性：同样的输入给出同样的值', () => {
    expect(fbm2(4, 1.5, -2.25)).toBe(fbm2(4, 1.5, -2.25));
  });

  it('值域落在 [−1, 1]', () => {
    for (let i = 0; i < 300; i++) {
      for (let j = 0; j < 30; j++) {
        const v = fbm2(6, i * 0.11 - 16, j * 0.29 - 4);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('单个八度就等于 perlin2 本身', () => {
    expect(fbm2(9, 0.3, 0.7, 1)).toBeCloseTo(perlin2(9, 0.3, 0.7), 12);
  });

  it('叠加更多八度会加进 perlin2 没有的细节', () => {
    const single = fbm2(9, 0.3, 0.7, 1);
    const layered = fbm2(9, 0.3, 0.7, 4);
    expect(layered).not.toBeCloseTo(single, 6);
  });

  it('一层都不叠时结果是 0', () => {
    expect(fbm2(9, 0.3, 0.7, 0)).toBe(0);
    expect(fbm2(9, 0.3, 0.7, -1)).toBe(0);
  });

  it('换种子得到另一个噪声场', () => {
    let differing = 0;
    for (let i = 0; i < 100; i++) {
      if (Math.abs(fbm2(1, i * 0.41, i * 0.23) - fbm2(2, i * 0.41, i * 0.23)) > 1e-6) {
        differing++;
      }
    }
    expect(differing).toBeGreaterThan(90);
  });
});
