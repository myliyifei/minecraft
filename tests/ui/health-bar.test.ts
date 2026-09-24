import { describe, expect, it } from 'vitest';
import { heartStates } from '../../src/ui/health-bar';

describe('心的三态', () => {
  it('满血 10 颗整心', () => {
    expect(heartStates(20)).toEqual(Array(10).fill('full'));
  });

  it('17 点是 8 颗整心、1 颗半心、1 颗空心，从左往右排', () => {
    expect(heartStates(17)).toEqual([
      ...Array(8).fill('full'),
      'half',
      'empty',
    ]);
  });

  it('1 点只剩最左边半颗，0 点全空', () => {
    expect(heartStates(1)).toEqual(['half', ...Array(9).fill('empty')]);
    expect(heartStates(0)).toEqual(Array(10).fill('empty'));
  });
});
