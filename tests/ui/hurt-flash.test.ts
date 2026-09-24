import { describe, expect, it } from 'vitest';
import { hurtFlashVisible } from '../../src/ui/hurt-flash';

describe('受伤红闪', () => {
  it('受伤那一 tick 起可见，10 tick 后不可见', () => {
    expect(hurtFlashVisible(50, 50)).toBe(true);
    expect(hurtFlashVisible(50, 59)).toBe(true);
    expect(hurtFlashVisible(50, 60)).toBe(false);
  });

  it('还没受过伤不可见', () => {
    expect(hurtFlashVisible(undefined, 0)).toBe(false);
  });
});
