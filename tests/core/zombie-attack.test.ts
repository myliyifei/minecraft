import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import { INVULNERABLE_TICKS } from '../../src/core/health';
import { ItemType } from '../../src/core/item';
import { FLAT_STAND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/*
 * 僵尸攻击玩家（#43）。玩家站在原点那一格中心 (0.5, 71, 0.5)，僵尸生成在它身旁。
 */

/** 视距 1 的平地核心。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain });
}

/** 在玩家 +X 方向 distance 格处生成一只，脚底与玩家同高。 */
function zombieBeside(game: GameCore, distance: number): void {
  const { x, y, z } = game.player.position;
  game.spawnZombieAt(x + distance, y, z);
}

/** 挖空玩家脚下 24 格，推进到摔死为止：落地摔 21 点。 */
function fallToDeath(game: GameCore): void {
  const { x, z } = game.player.position;
  const [bx, bz] = [Math.floor(x), Math.floor(z)];
  const top = game.highestBlockY(bx, bz);
  for (let y = top; y > top - 24; y--) game.setBlock(bx, y, bz, BlockType.Air);
  for (let n = 0; n < 100 && !game.health.dead; n++) game.tick();
  if (!game.health.dead) throw new Error('100 tick 还没摔死');
}

describe('僵尸打玩家', () => {
  it('生成在玩家旁 1 格：下一 tick 生命 17，随后 19 tick 不变，第 21 tick 变 14', () => {
    const game = core();
    zombieBeside(game, 1);

    game.tick();
    expect(game.health.points).toBe(17);
    for (let n = 0; n < 19; n++) {
      game.tick();
      expect(game.health.points).toBe(17);
    }
    game.tick();
    expect(game.health.points).toBe(14);
  });
});

describe('界面与死亡画面下', () => {
  it('背包界面开着照样掉血', () => {
    const game = core();
    game.toggleInventory();
    game.tick();
    expect(game.inventoryScreen.open).toBe(true);

    zombieBeside(game, 1);
    game.tick();
    expect(game.inventoryScreen.open).toBe(true);
    expect(game.health.points).toBe(17);
  });

  it('死亡画面下不掉血：僵尸贴着站 100 tick，生命一直是 0，也不被推', () => {
    const game = core();
    fallToDeath(game);
    const lastHurt = game.health.lastHurtTick;
    const at = game.player.position;

    zombieBeside(game, 0.5);
    game.tick(100);
    expect(game.health.points).toBe(0);
    expect(game.health.lastHurtTick).toBe(lastHurt);
    expect(game.player.position).toEqual(at);
  });
});

describe('几只僵尸围着打', () => {
  it('三只同时围上来：第一 tick 只掉 3 点（无敌）；打不进去的那两下也算出过手，之后还是每 20 tick 掉 3 点', () => {
    const game = core();
    zombieBeside(game, 1);
    zombieBeside(game, -1);
    const { x, y, z } = game.player.position;
    game.spawnZombieAt(x, y, z + 1);

    game.tick();
    expect(game.health.points).toBe(17);
    // 玩家的无敌时间第 12 tick 就过了，但三只都在第 1 tick 出过手，要等到第 21 tick
    for (let n = 0; n < 19; n++) {
      game.tick();
      expect(game.health.points).toBe(17);
    }
    game.tick();
    expect(game.health.points).toBe(14);
  });
});

describe('被僵尸打死', () => {
  it('生命归零后进入死亡画面，背包里的东西掉在死亡处', () => {
    const game = core();
    game.giveItem(ItemType.Cobblestone, 10);
    zombieBeside(game, 1);
    for (let n = 0; n < 400 && !game.health.dead; n++) game.tick();

    expect(game.health.dead).toBe(true);
    expect(game.uiMode).toBe(true);
    const at = game.player.position;
    expect(game.drops.all().map(({ item, count }) => ({ item, count }))).toEqual([
      { item: ItemType.Cobblestone, count: 10 },
    ]);
    const [drop] = game.drops.all();
    expect(Math.floor(drop!.position.x)).toBe(Math.floor(at.x));
    expect(Math.floor(drop!.position.z)).toBe(Math.floor(at.z));
    expect(game.inventory.slot(0)).toBeUndefined();
  });

  it('重生后停在出生点：打死他的那一下留下的击退不带到重生之后', () => {
    const game = core();
    // 出生点那一列挖一口 21 格深的井：落地摔 18 点，剩 2 点。重生也回到井底
    const top = game.highestBlockY(0, 0);
    for (let y = top; y > top - 21; y--) game.setBlock(0, y, 0, BlockType.Air);
    for (let n = 0; n < 100 && game.health.points === 20; n++) game.tick();
    expect(game.health.points).toBe(2);
    // 等落地的无敌时间过去。井底 +X 那一侧掏一个两格高的洞，僵尸生成在里面，离玩家 1 格，下一 tick
    // 就打：这一下朝 −X 推。等它走到玩家脚下再打就没有水平方向了
    game.tick(INVULNERABLE_TICKS);
    const { y } = game.player.position;
    game.setBlock(1, y, 0, BlockType.Air);
    game.setBlock(1, y + 1, 0, BlockType.Air);
    game.spawnZombieAt(1.5, y, 0.5);
    game.tick();
    expect(game.health.dead).toBe(true);

    game.respawn();
    const spawn = game.spawnPoint;
    expect(game.player.position).toEqual(spawn);
    game.tick(5);
    expect(game.player.position).toEqual(spawn);
  });
});

describe('僵尸打得到的范围', () => {
  it('2 格外不打：走近到 1.5 格以内那一 tick 才打（每 tick 走 0.15 格，第 4 tick）', () => {
    const game = core();
    zombieBeside(game, 2);
    game.tick(3);
    expect(game.health.points).toBe(20);
    game.tick();
    expect(game.health.points).toBe(17);
  });

  /**
   * 玩家 +X 那一格挖一个 depth 格深、一格宽的坑，僵尸生成在坑底：水平中心距 1 格，脚底比玩家低
   * depth 格。坑壁 3 格高时它跳不出来。
   */
  function zombieInPit(depth: number): GameCore {
    const game = core();
    const { x, y, z } = game.player.position;
    const [bx, bz] = [Math.floor(x) + 1, Math.floor(z)];
    for (let n = 1; n <= depth; n++) game.setBlock(bx, y - n, bz, BlockType.Air);
    game.spawnZombieAt(bx + 0.5, y - depth, bz + 0.5);
    return game;
  }

  it('1.5 格内、高度差 3 格：碰撞箱竖直区间不重叠，不打', () => {
    const game = zombieInPit(3);
    game.tick(40);
    expect(game.zombies.all()[0]!.position.y).toBe(FLAT_STAND_Y - 3);
    expect(game.health.points).toBe(20);
  });

  it('1.5 格内、它比玩家高 3 格：同样不打', () => {
    const game = core();
    const { x, y, z } = game.player.position;
    const [bx, bz] = [Math.floor(x) + 1, Math.floor(z)];
    // 玩家 +X 那一格立一根 3 格高的柱子，顶上四周围一圈 2 格高的墙，僵尸站在柱顶下不来
    for (let n = 0; n < 3; n++) game.setBlock(bx, y + n, bz, BlockType.Stone);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let n = 3; n < 5; n++) game.setBlock(bx + dx, y + n, bz + dz, BlockType.Stone);
    }
    game.spawnZombieAt(bx + 0.5, y + 3, bz + 0.5);
    game.tick(40);
    expect(game.zombies.all()[0]!.position.y).toBe(FLAT_STAND_Y + 3);
    expect(game.health.points).toBe(20);
  });

  it('高度差 1 格：碰撞箱竖直区间还重叠，打得到', () => {
    const game = zombieInPit(1);
    game.tick();
    expect(game.health.points).toBe(17);
  });
});

describe('玩家被僵尸打到时的击退', () => {
  it('被推离僵尸、上抛：水平速度 0.4 起每 tick 乘 0.6，几 tick 后衰减到 0；落地不扣血', () => {
    const game = core();
    zombieBeside(game, 1);
    game.tick();
    expect(game.health.points).toBe(17);
    const hitAt = game.player.position;

    // 被打的那一 tick 只写进速度，下一 tick 玩家走的时候才动
    const steps: number[] = [];
    let highest = hitAt.y;
    for (let n = 0; n < 19; n++) {
      const before = game.player.position.x;
      game.tick();
      steps.push(game.player.position.x - before);
      highest = Math.max(highest, game.player.position.y);
      expect(game.player.position.z).toBe(hitAt.z);
    }
    // 僵尸在 +X，玩家往 −X 被推
    expect(steps[0]).toBeCloseTo(-0.4, 12);
    expect(steps[1]).toBeCloseTo(-0.24, 12);
    for (let n = 1; n < steps.length; n++) {
      expect(Math.abs(steps[n]!)).toBeLessThanOrEqual(Math.abs(steps[n - 1]!));
    }
    expect(steps.slice(-5)).toEqual([0, 0, 0, 0, 0]);
    // 一共推出去约 1 格
    expect(hitAt.x - game.player.position.x).toBeGreaterThan(0.9);
    expect(hitAt.x - game.player.position.x).toBeLessThan(1);

    expect(highest).toBeGreaterThan(FLAT_STAND_Y + 1);
    expect(game.player.position.y).toBe(FLAT_STAND_Y);
    expect(game.player.onGround).toBe(true);
    expect(game.health.points).toBe(17);
  });
});
