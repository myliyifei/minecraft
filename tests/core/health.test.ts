import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import { fallDamage, Health } from '../../src/core/health';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { IDLE_INTENT, PLAYER_WIDTH } from '../../src/core/player';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/** 平地上、视距 1 的核心：生命值的断言要推进几百 tick，区块少一点跑得快。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain });
}

/**
 * 把出生点那一列从地表往下挖空 depth 格，玩家就从 depth 格高处落到坑底。
 * 出生点在 (0.5, 0.5)，碰撞箱只占 (0, 0) 这一列，挖一列就够。
 */
function digShaftUnderfoot(game: GameCore, depth: number, top = game.highestBlockY(0, 0)): void {
  for (let y = top; y > top - depth; y--) game.setBlock(0, y, 0, BlockType.Air);
}

/** 一直推进到玩家站在地上，最多 max tick。返回推进了几 tick。 */
function tickUntilLanded(game: GameCore, max = 100): number {
  for (let n = 1; n <= max; n++) {
    game.tick();
    if (game.player.onGround) return n;
  }
  throw new Error(`${max} tick 还没落地`);
}

describe('核心的玩家生命值', () => {
  it('进入世界时生命 20，没有死', () => {
    const game = core();
    expect(game.health.points).toBe(20);
    expect(game.health.dead).toBe(false);
  });

  it.each([
    [3, 20],
    [4, 19],
    [5, 18],
    [8, 15],
  ])('从 %i 格高处落地，生命 %i', (height, points) => {
    const game = core();
    digShaftUnderfoot(game, height);
    tickUntilLanded(game);
    expect(game.player.position.y).toBe(FLAT_GROUND_Y + 1 - height);
    expect(game.health.points).toBe(points);
  });

  it('受伤后 99 tick 生命不变，第 100 tick 起每 80 tick 回 1，回到 20 停', () => {
    const game = core();
    digShaftUnderfoot(game, 5);
    tickUntilLanded(game);
    expect(game.health.points).toBe(18);

    game.tick(99);
    expect(game.health.points).toBe(18);
    game.tick(1);
    expect(game.health.points).toBe(19);
    game.tick(79);
    expect(game.health.points).toBe(19);
    game.tick(1);
    expect(game.health.points).toBe(20);
    game.tick(400);
    expect(game.health.points).toBe(20);
  });

  it('回血途中再受伤，重新等 100 tick', () => {
    const game = core();
    digShaftUnderfoot(game, 5);
    tickUntilLanded(game);
    game.tick(100);
    expect(game.health.points).toBe(19);

    // 坑底再往下挖 4 格，又摔 1 点
    digShaftUnderfoot(game, 4);
    tickUntilLanded(game);
    expect(game.health.points).toBe(18);
    game.tick(99);
    expect(game.health.points).toBe(18);
    game.tick(1);
    expect(game.health.points).toBe(19);
  });

  // 死亡期间不受重力、不再受伤，在 tests/core/death.test.ts
  it('生命归零后「已死亡」为真，不再回血', () => {
    const game = core();
    // 落差 24 格摔 21 点，扣到 0 为止
    digShaftUnderfoot(game, 24);
    tickUntilLanded(game);
    expect(game.health.points).toBe(0);
    expect(game.health.dead).toBe(true);

    game.tick(500);
    expect(game.health.points).toBe(0);
  });

  it('走到还没送到的区块边上原地等待，不掉进「未加载即空气」里；区块送到之后继续前进，不掉血', () => {
    // 东边 cx = 1 那一列区块先不给，其余照常。送到的那一块在 x = 16 立着一道两格高的墙
    let eastReady = false;
    const eastWithWall = (cx: number, cz: number): Chunk => {
      const chunk = flatTestTerrain(cx, cz)!;
      if (cx === 1) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          chunk.set(0, FLAT_GROUND_Y + 1, z, BlockType.Stone);
          chunk.set(0, FLAT_GROUND_Y + 2, z, BlockType.Stone);
        }
      }
      return chunk;
    };
    const game = new GameCore({
      viewRadius: 1,
      chunkSource: () => (cx, cz) => (cx === 1 && !eastReady ? undefined : eastWithWall(cx, cz)),
    });
    game.turn(-Math.PI / 2, 0);
    game.setMoveIntent({ ...IDLE_INTENT, forward: true });
    game.tick(200);
    // 停在区块边界前：碰撞箱连同这一 tick 要走的一步都还在 x = 16 以西
    const waiting = game.player.position;
    expect(waiting.x + PLAYER_WIDTH / 2).toBeLessThan(16);
    expect(waiting.y).toBe(FLAT_GROUND_Y + 1);
    game.tick(40);
    expect(game.player.position).toEqual(waiting);

    // 送到之后被那道墙挡住，贴在墙面上，而不是已经走进墙的位置里
    eastReady = true;
    game.tick(20);
    expect(game.player.position.x).toBeCloseTo(16 - PLAYER_WIDTH / 2, 10);
    expect(game.player.position.y).toBe(FLAT_GROUND_Y + 1);

    // 挖开墙继续前进
    game.setBlock(16, FLAT_GROUND_Y + 1, 0, BlockType.Air);
    game.setBlock(16, FLAT_GROUND_Y + 2, 0, BlockType.Air);
    game.tick(100);
    expect(game.player.position.x).toBeGreaterThan(20);
    expect(game.player.position.y).toBe(FLAT_GROUND_Y + 1);
    expect(game.health.points).toBe(20);
  });

  it('原地跳不掉血', () => {
    const game = core();
    game.setMoveIntent({ ...IDLE_INTENT, jump: true });
    game.tick(200);
    expect(game.health.points).toBe(20);
  });
});

describe('摔落伤害的换算', () => {
  it('落差不超过 3 格不受伤，超出部分每格 1 点，不足一格的零头按一格算', () => {
    expect(fallDamage(0)).toBe(0);
    expect(fallDamage(3)).toBe(0);
    expect(fallDamage(3.25)).toBe(1);
    expect(fallDamage(4)).toBe(1);
    expect(fallDamage(5)).toBe(2);
    expect(fallDamage(24)).toBe(21);
  });
});

describe('生命值的受伤与无敌时间', () => {
  it('受伤扣血，记下受伤的 tick', () => {
    const health = new Health();
    expect(health.hurt(3, 50)).toBe(true);
    expect(health.points).toBe(17);
    expect(health.lastHurtTick).toBe(50);
  });

  it('受伤后 10 tick 内第二次受伤忽略，第 11 tick 生效', () => {
    const health = new Health();
    health.hurt(3, 50);
    expect(health.hurt(3, 51)).toBe(false);
    expect(health.hurt(3, 60)).toBe(false);
    expect(health.points).toBe(17);
    expect(health.lastHurtTick).toBe(50);

    expect(health.hurt(3, 61)).toBe(true);
    expect(health.points).toBe(14);
    expect(health.lastHurtTick).toBe(61);
  });

  it('被忽略的那一下不延长无敌时间', () => {
    const health = new Health();
    health.hurt(3, 50);
    health.hurt(3, 58);
    expect(health.hurt(3, 61)).toBe(true);
  });

  it('伤害不是正数时不生效，也不进无敌时间', () => {
    const health = new Health();
    expect(health.hurt(0, 50)).toBe(false);
    expect(health.lastHurtTick).toBeUndefined();
    expect(health.hurt(2, 51)).toBe(true);
    expect(health.points).toBe(18);
  });

  it('扣到 0 为止，归零就是死亡，之后再受伤忽略', () => {
    const health = new Health();
    health.hurt(15, 0);
    expect(health.dead).toBe(false);
    expect(health.hurt(15, 100)).toBe(true);
    expect(health.points).toBe(0);
    expect(health.dead).toBe(true);
    expect(health.hurt(1, 200)).toBe(false);
    expect(health.lastHurtTick).toBe(100);
  });
});

describe('生命值的重置', () => {
  it('死后重置：满血、没受过伤、没有无敌时间，下一 tick 就能受伤', () => {
    const health = new Health();
    health.hurt(20, 100);
    expect(health.dead).toBe(true);
    health.reset();
    expect(health.points).toBe(20);
    expect(health.dead).toBe(false);
    expect(health.lastHurtTick).toBeUndefined();
    expect(health.hurt(1, 101)).toBe(true);
    expect(health.points).toBe(19);
  });
});
