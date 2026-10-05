import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { NIGHT_END, NIGHT_START } from '../../src/core/time-of-day';
import { flatTerrain } from '../helpers/flat-terrain';

/*
 * 难度生效（#66）。玩家站在原点那一格中心 (0.5, 71, 0.5)。视距 3 时 24 到 48 格的整个圆环都已加载，
 * 夜晚露天的平地上会生成僵尸（见 zombie-spawn.test.ts）。
 */

/** 平地核心，难度 difficulty。 */
function core(difficulty: Difficulty, viewRadius = 1): GameCore {
  return new GameCore({ difficulty, viewRadius, terrain: flatTerrain });
}

/** 挖空玩家脚下 24 格，推进到摔死为止：着地时摔掉 21 点。 */
function fallToDeath(game: GameCore): void {
  const { x, z } = game.player.position;
  const [bx, bz] = [Math.floor(x), Math.floor(z)];
  const top = game.highestBlockY(bx, bz);
  for (let y = top; y > top - 24; y--) game.setBlock(bx, y, bz, BlockType.Air);
  for (let n = 0; n < 100 && !game.health.dead; n++) game.tick();
  if (!game.health.dead) throw new Error('100 tick 还没摔死');
}

describe('和平', () => {
  it('夜晚露天推进整夜，一只僵尸都不生成；同样的世界在普通难度下会生成', () => {
    const peaceful = core(Difficulty.Peaceful, 3);
    peaceful.setTimeOfDay(NIGHT_START);
    for (let n = NIGHT_START; n < NIGHT_END; n++) {
      peaceful.tick();
      expect(peaceful.zombies.count, `第 ${peaceful.tickCount} tick`).toBe(0);
    }

    const normal = core(Difficulty.Normal, 3);
    normal.setTimeOfDay(NIGHT_START);
    normal.tick(2000);
    expect(normal.zombies.count).toBeGreaterThan(0);
  });

  it('放一只，下一 tick 消失，不掉腐肉、不给经验球', () => {
    const game = core(Difficulty.Peaceful);
    const { x, y, z } = game.player.position;
    game.spawnZombieAt(x + 3, y, z);
    expect(game.zombies.count).toBe(1);

    game.tick();
    expect(game.zombies.count).toBe(0);
    expect(game.drops.count).toBe(0);
    expect(game.xpOrbs.count).toBe(0);
  });

  it('贴着玩家放一只，消失之前不打玩家', () => {
    const game = core(Difficulty.Peaceful);
    const { x, y, z } = game.player.position;
    game.spawnZombieAt(x + 1, y, z);

    game.tick();
    expect(game.health.points).toBe(20);
  });
});

describe('僵尸打玩家一下的伤害按难度', () => {
  /** 在玩家身旁 1 格放一只，推进 1 tick，返回玩家剩下的生命值。 */
  function healthAfterOneHit(difficulty: Difficulty): number {
    const game = core(difficulty);
    const { x, y, z } = game.player.position;
    game.spawnZombieAt(x + 1, y, z);
    game.tick();
    return game.health.points;
  }

  it('简单 2 点', () => {
    expect(healthAfterOneHit(Difficulty.Easy)).toBe(18);
  });

  it('普通 3 点', () => {
    expect(healthAfterOneHit(Difficulty.Normal)).toBe(17);
  });

  it('困难与极限 4 点', () => {
    expect(healthAfterOneHit(Difficulty.Hard)).toBe(16);
    expect(healthAfterOneHit(Difficulty.Hardcore)).toBe(16);
  });

  it('摔落伤害不按难度：简单与困难摔同样的高度扣同样多', () => {
    const fallFrom = (difficulty: Difficulty): number => {
      const game = core(difficulty);
      const { x, z } = game.player.position;
      const [bx, bz] = [Math.floor(x), Math.floor(z)];
      const top = game.highestBlockY(bx, bz);
      for (let y = top; y > top - 6; y--) game.setBlock(bx, y, bz, BlockType.Air);
      game.tick(40);
      return game.health.points;
    };
    expect(fallFrom(Difficulty.Easy)).toBeLessThan(20);
    expect(fallFrom(Difficulty.Easy)).toBe(fallFrom(Difficulty.Hard));
  });
});

describe('极限死亡', () => {
  it('死亡那一 tick 起核心的已死亡标记为真，快照里也为真', () => {
    const game = core(Difficulty.Hardcore);
    expect(game.hardcoreDead).toBe(false);
    fallToDeath(game);
    expect(game.hardcoreDead).toBe(true);
    expect(game.snapshot().hardcoreDead).toBe(true);
  });

  it('非极限的四档死亡后标记为假', () => {
    for (const difficulty of [Difficulty.Peaceful, Difficulty.Easy, Difficulty.Normal, Difficulty.Hard]) {
      const game = core(difficulty);
      fallToDeath(game);
      expect(game.hardcoreDead, difficulty).toBe(false);
      expect(game.snapshot().hardcoreDead, difficulty).toBe(false);
    }
  });

  it('极限死亡后不能重生：调重生什么都不发生，仍在死亡画面上', () => {
    const game = core(Difficulty.Hardcore);
    fallToDeath(game);
    const at = game.player.position;

    game.respawn();
    expect(game.health.dead).toBe(true);
    expect(game.uiMode).toBe(true);
    expect(game.player.position).toEqual(at);
  });

  it('极限死亡但标记为假的快照（这条规则之前存下的）读回来也不能重生', () => {
    const game = core(Difficulty.Hardcore);
    fallToDeath(game);
    const before = { ...game.snapshot(), hardcoreDead: false };
    const restored = new GameCore({ restore: before, viewRadius: 1, terrain: flatTerrain });
    expect(restored.health.dead).toBe(true);

    restored.tick(5);
    restored.respawn();
    expect(restored.health.dead).toBe(true);
  });

  it('非极限死亡后照常重生', () => {
    const game = core(Difficulty.Hard);
    fallToDeath(game);
    game.respawn();
    expect(game.health.dead).toBe(false);
  });
});
