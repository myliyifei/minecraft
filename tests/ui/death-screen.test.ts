import { describe, expect, it } from 'vitest';
import { Difficulty } from '../../src/core/difficulty';
import { deathScreenAction } from '../../src/ui/death-screen';

describe('死亡画面上的按钮', () => {
  it('非极限的四档是重生', () => {
    for (const difficulty of [Difficulty.Peaceful, Difficulty.Easy, Difficulty.Normal, Difficulty.Hard]) {
      expect(deathScreenAction(difficulty), difficulty).toBe('respawn');
    }
  });

  it('极限是删除世界', () => {
    expect(deathScreenAction(Difficulty.Hardcore)).toBe('deleteWorld');
  });
});
