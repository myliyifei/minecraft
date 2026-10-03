import { describe, expect, it } from 'vitest';
import { seedFromText } from '../../src/core/world-seed';

/** 空文本时给的随机种子。测试里固定成一个认得出的值，看得出是不是走了随机这条路。 */
const RANDOM = 123_456;
const random = (): number => RANDOM;

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

describe('新建世界时的种子文本', () => {
  it('32 位有符号整数范围内的整数原样使用', () => {
    for (const seed of [0, 1, -1, 42, 20_260_905, INT32_MIN, INT32_MAX]) {
      expect(seedFromText(String(seed), random), String(seed)).toBe(seed);
    }
  });

  it('首尾空白不算进文本', () => {
    expect(seedFromText('  42 ', random)).toBe(42);
    expect(seedFromText(' 绿宝石 ', random)).toBe(seedFromText('绿宝石', random));
  });

  it('超出 32 位的整数与越界的负数走哈希，结果仍在范围内', () => {
    for (const text of [String(INT32_MAX + 1), String(INT32_MIN - 1), '99999999999999999999', '-99999999999999999999']) {
      const seed = seedFromText(text, random);
      expect(Number.isInteger(seed), text).toBe(true);
      expect(seed, text).toBeGreaterThanOrEqual(INT32_MIN);
      expect(seed, text).toBeLessThanOrEqual(INT32_MAX);
      // 不是截断或回绕成的那个数：截断的话 2^31 会变成 -2^31，与直接输入 -2^31 撞上。
      expect(seed, text).not.toBe(Number(text) | 0);
      expect(seed, text).not.toBe(RANDOM);
    }
  });

  it('带小数点的数与其他文本走哈希', () => {
    for (const text of ['1.5', '1.0', '1e3', '0x10', 'abc', '绿宝石']) {
      const seed = seedFromText(text, random);
      expect(Number.isInteger(seed), text).toBe(true);
      expect(seed, text).toBeGreaterThanOrEqual(INT32_MIN);
      expect(seed, text).toBeLessThanOrEqual(INT32_MAX);
      expect(seed, text).not.toBe(RANDOM);
    }
    expect(seedFromText('1.0', random)).not.toBe(1);
  });

  it('同一段文本每次得到同一个种子', () => {
    for (const text of ['abc', '绿宝石', '4294967296', '1.5']) {
      expect(seedFromText(text, random), text).toBe(seedFromText(text, () => 7));
    }
  });

  it('不同的文本得到不同的种子', () => {
    const texts = ['a', 'b', 'ab', 'ba', 'abc', 'Abc', '绿宝石', '红宝石', '1.5', '1.50', '2147483648', '2147483649'];
    const seeds = new Set(texts.map((text) => seedFromText(text, random)));
    expect(seeds.size).toBe(texts.length);
  });

  it('空文本与只有空白的文本取随机种子', () => {
    expect(seedFromText('', random)).toBe(RANDOM);
    expect(seedFromText('   ', random)).toBe(RANDOM);
    expect(seedFromText('', () => -5)).toBe(-5);
  });
});
