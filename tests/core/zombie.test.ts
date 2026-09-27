import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import { ItemType, type ItemStack } from '../../src/core/item';
import { hitboxAt, KNOCKBACK_DECAY, KNOCKBACK_LIFT, KNOCKBACK_SPEED } from '../../src/core/physics';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/core/player';
import type { Vec3 } from '../../src/core/vec3';
import type { World } from '../../src/core/world';
import {
  ZOMBIE_DESPAWN_RANGE,
  ZOMBIE_MAX_HEALTH,
  ZOMBIE_SPEED,
  ZOMBIE_STEP,
  ZOMBIE_WANDER_TICKS,
  ZOMBIE_WIDTH,
  ZOMBIE_XP,
  Zombies,
  type ZombieTarget,
  type ZombieView,
} from '../../src/core/zombie';
import { FLAT_STAND_Y, flatTestTerrain, flatTestWorld } from '../helpers/flat-terrain';

const SEED = 1234;

/** 玩家站在原点那一格中心。僵尸集合的测试直接把这个位置交给 `step`。 */
const PLAYER: Vec3 = { x: 0.5, y: FLAT_STAND_Y, z: 0.5 };

/** 死掉的僵尸交出来的一样东西落在哪一格。 */
type Cell = [number, number, number];

/**
 * 平地上的僵尸集合，带一个 tick 计数：游走的方向由种子、tick 与编号哈希出来，
 * 测试得像核心那样每 tick 把计数加 1 交进去。死掉的僵尸掉的腐肉与经验球记在 `dropped` 与 `orbs` 里。
 */
function zombiesOnFlatGround(radius = 1, seed = SEED) {
  const world: World = flatTestWorld(radius);
  const dropped: Array<{ stack: ItemStack; at: Cell }> = [];
  const orbs: Array<{ amount: number; at: Cell }> = [];
  const zombies = new Zombies(
    world,
    seed,
    { spawnInBlock: (stack, x, y, z) => dropped.push({ stack, at: [x, y, z] }) },
    { spawnInBlock: (amount, x, y, z) => orbs.push({ amount, at: [x, y, z] }) },
  );
  let tick = 0;
  /** 推进 n 个 tick，玩家站在 player。每 tick 之后交给 `each` 看一眼。 */
  const advance = (n: number, player: Vec3 = PLAYER, each?: (zombie: ZombieView) => void) => {
    for (let i = 0; i < n; i++) {
      zombies.step(++tick, bystander(player));
      const [zombie] = zombies.all();
      if (each && zombie) each(zombie);
    }
  };
  return { world, zombies, advance, now: () => tick, dropped, orbs };
}

/**
 * 站在 at 的玩家，挨打不受伤。这里测的是走、跳、消失与被玩家打；僵尸打玩家要看生命值与击退，
 * 在 `zombie-attack.test.ts` 里从核心测。
 */
function bystander(at: Vec3): ZombieTarget {
  return { position: at, hitbox: hitboxAt(at, PLAYER_WIDTH, PLAYER_HEIGHT), hitByZombie: () => {} };
}

function equalPosition(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** 僵尸与玩家的水平距离。 */
function horizontalDistance(zombie: ZombieView, player: Vec3 = PLAYER): number {
  return Math.hypot(zombie.position.x - player.x, zombie.position.z - player.z);
}

/** 视距 1 的平地核心。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain });
}

describe('僵尸的出现（spawnZombieAt）', () => {
  it('生成之后列表里有一只：就在给定的位置，满血，存活 0 tick，编号从 1 起', () => {
    const game = core();
    game.spawnZombieAt(3.5, FLAT_STAND_Y, 0.5);

    expect(game.zombies.count).toBe(1);
    const [zombie] = game.zombies.all();
    expect(zombie).toMatchObject({
      id: 1,
      position: { x: 3.5, y: FLAT_STAND_Y, z: 0.5 },
      previousPosition: { x: 3.5, y: FLAT_STAND_Y, z: 0.5 },
      age: 0,
      health: ZOMBIE_MAX_HEALTH,
    });
    expect(ZOMBIE_MAX_HEALTH).toBe(20);
  });

  it('编号不复用：消失了的那只的编号不会给下一只', () => {
    const game = core();
    game.spawnZombieAt(3.5, FLAT_STAND_Y, 0.5);
    // 视距 1 只加载到 32 格，100 格外的这一只所在区块没加载，下一 tick 就消失
    game.spawnZombieAt(100.5, FLAT_STAND_Y, 0.5);
    game.tick();
    expect(game.zombies.all().map((z) => z.id)).toEqual([1]);

    game.spawnZombieAt(-3.5, FLAT_STAND_Y, 0.5);
    expect(game.zombies.all().map((z) => z.id)).toEqual([1, 3]);
  });

  it('生成在玩家身上：两者重叠不互推，玩家的位置一点不变', () => {
    const game = core();
    const { x, y, z } = game.player.position;
    game.spawnZombieAt(x, y, z);

    game.tick(40);
    expect(game.player.position).toEqual({ x, y, z });
    // 僵尸也还在原地贴着玩家：它追的就是玩家的水平位置
    const [zombie] = game.zombies.all();
    expect(horizontalDistance(zombie!, { x, y, z })).toBeLessThan(1e-9);
  });

  it('核心每 tick 推进僵尸：生成在 20 格外的那一只朝玩家走过来', () => {
    const game = core();
    const { x, z } = game.player.position;
    game.spawnZombieAt(x + 20, FLAT_STAND_Y, z);
    game.tick(20);
    expect(game.zombies.all()[0]!.position.x).toBeCloseTo(x + 20 - ZOMBIE_SPEED, 9);
    expect(game.zombies.all()[0]!.age).toBe(20);
  });
});

describe('僵尸在 32 格内朝玩家直线走', () => {
  it('每 tick 靠近 3 格/秒那么多，斜着走也不更快', () => {
    const { zombies, advance } = zombiesOnFlatGround();
    // 斜对着玩家，水平距离 20
    zombies.spawnAt({ x: 12.5, y: FLAT_STAND_Y, z: 16.5 });

    const distances: number[] = [horizontalDistance(zombies.all()[0]!)];
    advance(20, PLAYER, (zombie) => distances.push(horizontalDistance(zombie)));

    for (let i = 1; i < distances.length; i++) {
      expect(distances[i - 1]! - distances[i]!, `第 ${i} tick`).toBeCloseTo(ZOMBIE_STEP, 9);
    }
    // 20 tick 是 1 秒
    expect(distances[0]! - distances[20]!).toBeCloseTo(ZOMBIE_SPEED, 9);
    expect(ZOMBIE_SPEED).toBe(3);
  });

  it('偏航朝着玩家：视线方向的水平分量指向玩家', () => {
    const { zombies, advance } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 12.5, y: FLAT_STAND_Y, z: 16.5 });
    advance(1);

    const zombie = zombies.all()[0]!;
    const d = horizontalDistance(zombie);
    // 与玩家同一套约定：偏航 0 朝 −Z，前方是 (−sin 偏航, −cos 偏航)
    expect(-Math.sin(zombie.yaw)).toBeCloseTo((PLAYER.x - zombie.position.x) / d, 9);
    expect(-Math.cos(zombie.yaw)).toBeCloseTo((PLAYER.z - zombie.position.z) / d, 9);
  });

  it('走到玩家的水平位置就停住，不冲过头', () => {
    const { zombies, advance } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 2.5, y: FLAT_STAND_Y, z: 0.5 });
    advance(40);
    expect(horizontalDistance(zombies.all()[0]!)).toBeLessThan(1e-9);
  });

  /** 在 x = 10 那一列摆一道 z 从 −3 到 3、高 height 格的石墙。 */
  function wall(world: World, height: number): void {
    for (let z = -3; z <= 3; z++) {
      for (let y = FLAT_STAND_Y; y < FLAT_STAND_Y + height; y++) world.setBlock(10, y, z, BlockType.Stone);
    }
  }

  it('隔着一道 1 格高的墙：跳上去、翻过来，接着走到玩家脚下', () => {
    const { world, zombies, advance } = zombiesOnFlatGround();
    wall(world, 1);
    zombies.spawnAt({ x: 20.5, y: FLAT_STAND_Y, z: 0.5 });

    let stoodOnWall = false;
    let highest = -Infinity;
    advance(200, PLAYER, (zombie) => {
      if (zombie.position.y === FLAT_STAND_Y + 1) stoodOnWall = true;
      highest = Math.max(highest, zombie.position.y);
    });
    expect(stoodOnWall).toBe(true);
    // 只在地面上起跳，与玩家同一套物理：最高点是起跳处之上 1.252 格，贴着墙往上蹭也不会更高
    expect(highest).toBeLessThan(FLAT_STAND_Y + 1.26);
    const zombie = zombies.all()[0]!;
    expect(zombie.position.x).toBeLessThan(10);
    expect(zombie.position.y).toBe(FLAT_STAND_Y);
    expect(horizontalDistance(zombie)).toBeLessThan(1e-9);
  });

  it('2 格高的墙挡住：贴着墙停下，一次也不跳', () => {
    const { world, zombies, advance } = zombiesOnFlatGround();
    wall(world, 2);
    zombies.spawnAt({ x: 20.5, y: FLAT_STAND_Y, z: 0.5 });

    let highest = -Infinity;
    advance(200, PLAYER, (zombie) => {
      highest = Math.max(highest, zombie.position.y);
    });
    expect(highest).toBe(FLAT_STAND_Y);
    const zombie = zombies.all()[0]!;
    // 碰撞箱的西面贴着墙的东面
    expect(zombie.position.x).toBeCloseTo(11 + ZOMBIE_WIDTH / 2, 9);
    expect(zombie.position.z).toBeCloseTo(0.5, 9);
  });

  it('生成在半空：往下落，落在地面上停住', () => {
    const { zombies, advance } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 20.5, y: FLAT_STAND_Y + 10, z: 0.5 });

    const heights: number[] = [];
    advance(60, PLAYER, (zombie) => heights.push(zombie.position.y));
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!, `第 ${i} tick`).toBeLessThanOrEqual(heights[i - 1]!);
    }
    // 第一 tick 按初速 0 走、再加上重力，第二 tick 起才往下掉
    expect(heights[1]).toBeLessThan(FLAT_STAND_Y + 10);
    expect(heights.at(-1)).toBe(FLAT_STAND_Y);
  });
});

describe('僵尸在 32 格外游走', () => {
  /**
   * 种子是挑过的：600 tick 里它一直在 32 格外、也没走出 64 格，中间停下过一次。多数种子下它游走几段
   * 就进了 32 格、转成追击，那样下面几条断言看不出游走本身。
   */
  const WANDER_SEED = 11;

  /** 生成在 40 格外、推进 600 tick，每 tick 记下位置、偏航与到玩家的水平距离。 */
  function wander(seed = WANDER_SEED) {
    const { zombies, advance } = zombiesOnFlatGround(5, seed);
    zombies.spawnAt({ x: 40.5, y: FLAT_STAND_Y, z: 0.5 });
    const track: { position: Vec3; yaw: number; distance: number }[] = [];
    advance(600, PLAYER, (zombie) =>
      track.push({ position: zombie.position, yaw: zombie.yaw, distance: horizontalDistance(zombie) }),
    );
    return { zombies, track };
  }

  it('600 tick 里走动过，但不是一直朝玩家靠近', () => {
    const { zombies, track } = wander();
    expect(zombies.count).toBe(1);
    // 一直在追击范围之外：下面看到的都是游走
    expect(Math.min(...track.map((step) => step.distance))).toBeGreaterThan(32);
    const moved = Math.hypot(track.at(-1)!.position.x - 40.5, track.at(-1)!.position.z - 0.5);
    expect(moved).toBeGreaterThan(0);

    // 有离玩家更远的 tick：它在按自己选的方向走，不是在追
    const movedAway = track.some((step, i) => i > 0 && step.distance > track[i - 1]!.distance);
    expect(movedAway).toBe(true);
  });

  it('选中停下时原地站着，一整段 60 tick 位置不变', () => {
    const { track } = wander();
    const still = track.filter((step, i) => i > 0 && equalPosition(step.position, track[i - 1]!.position));
    expect(still.length).toBeGreaterThanOrEqual(ZOMBIE_WANDER_TICKS - 1);
  });

  it('选中的方向保持 60 tick 才重选：600 tick 里偏航至多换 10 次', () => {
    const { track } = wander();
    const turns = track.filter((step, i) => i > 0 && step.yaw !== track[i - 1]!.yaw).length;
    expect(turns).toBeGreaterThan(0);
    expect(turns).toBeLessThanOrEqual(600 / ZOMBIE_WANDER_TICKS);
  });

  it('同一种子两次运行，轨迹逐 tick 相同', () => {
    expect(wander().track).toEqual(wander().track);
  });

  it('换一个种子，轨迹不同', () => {
    expect(wander(WANDER_SEED + 1).track).not.toEqual(wander().track);
  });
});

describe('僵尸的消失（ADR-0013）', () => {
  it('所在区块卸载之后，下一 tick 列表里就没有它了', () => {
    const { world, zombies, advance } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 20.5, y: FLAT_STAND_Y, z: 0.5 });
    advance(1);
    expect(zombies.count).toBe(1);

    world.unloadChunk(1, 0);
    advance(1);
    expect(zombies.count).toBe(0);
  });

  it('离玩家超过 64 格的下一 tick 消失，正好 64 格的不消失', () => {
    const { zombies, advance } = zombiesOnFlatGround(5);
    zombies.spawnAt({ x: PLAYER.x + ZOMBIE_DESPAWN_RANGE + 1, y: FLAT_STAND_Y, z: 0.5 });
    zombies.spawnAt({ x: PLAYER.x, y: FLAT_STAND_Y, z: PLAYER.z - ZOMBIE_DESPAWN_RANGE });
    expect(ZOMBIE_DESPAWN_RANGE).toBe(64);

    advance(1);
    expect(zombies.all().map((z) => z.id)).toEqual([2]);
  });

  it('碰撞箱伸进没加载的区块时原地等着，不走进那片读成空气的方块里；区块加载后接着走', () => {
    const { world, zombies, advance } = zombiesOnFlatGround();
    // 3×3 个区块的东边界是 x = 32。它的碰撞箱东面伸过了边界，玩家在更东边，它要往东走
    const player: Vec3 = { x: 50.5, y: FLAT_STAND_Y, z: 0.5 };
    zombies.spawnAt({ x: 31.8, y: FLAT_STAND_Y, z: 0.5 });

    advance(20, player);
    expect(zombies.count).toBe(1);
    const held = zombies.all()[0]!;
    expect(held.position).toEqual({ x: 31.8, y: FLAT_STAND_Y, z: 0.5 });
    expect(held.previousPosition).toEqual(held.position);

    world.loadChunk(2, 0);
    advance(1, player);
    expect(zombies.all()[0]!.position.x).toBeCloseTo(31.8 + ZOMBIE_STEP, 9);
  });
});

describe('僵尸被玩家打（#42）', () => {
  /** 站在玩家脚下的一只：与玩家水平位置重合，它不走，位移全是击退。 */
  function standingOnPlayer() {
    const ground = zombiesOnFlatGround();
    ground.zombies.spawnAt(PLAYER);
    return ground;
  }

  /** 玩家在它 +Z 那边 1 格打它：击退朝 −Z。 */
  const FROM_SOUTH: Vec3 = { x: PLAYER.x, y: PLAYER.y, z: PLAYER.z + 1 };

  it('打一下：扣血、记下受伤的 tick，这一 tick 水平被推出 0.4 格、往上颠 0.4 格', () => {
    const { zombies, advance, now } = standingOnPlayer();
    advance(1);
    expect(zombies.hitByPlayer(1, 3, FROM_SOUTH, now())).toBe(true);
    const hit = zombies.all()[0]!;
    expect(hit.health).toBe(17);
    expect(hit.lastHurtTick).toBe(now());

    advance(1);
    const pushed = zombies.all()[0]!;
    expect(KNOCKBACK_SPEED).toBe(0.4);
    expect(KNOCKBACK_LIFT).toBe(0.4);
    expect(pushed.position.z).toBeCloseTo(PLAYER.z - 0.4, 12);
    expect(pushed.position.x).toBe(PLAYER.x);
    expect(pushed.position.y).toBeCloseTo(FLAT_STAND_Y + 0.4, 12);
  });

  it('击退的水平速度每 tick 乘 0.6：第二 tick 推出 0.24，同时它朝玩家走回 1 步', () => {
    expect(KNOCKBACK_DECAY).toBe(0.6);
    const { zombies, advance, now } = standingOnPlayer();
    zombies.hitByPlayer(1, 1, FROM_SOUTH, now());
    advance(1);
    const first = zombies.all()[0]!.position.z;
    advance(1);
    expect(zombies.all()[0]!.position.z - first).toBeCloseTo(-0.24 + ZOMBIE_STEP, 12);
  });

  it('推出去一共约 1 格，之后不再被推：一直走回玩家脚下', () => {
    const { zombies, advance, now } = standingOnPlayer();
    zombies.hitByPlayer(1, 1, FROM_SOUTH, now());
    let farthest = 0;
    advance(60, PLAYER, (zombie) => {
      farthest = Math.max(farthest, PLAYER.z - zombie.position.z);
    });
    expect(farthest).toBeGreaterThan(0.4);
    expect(farthest).toBeLessThan(1);
    expect(horizontalDistance(zombies.all()[0]!)).toBe(0);
  });

  it('攻击者与它水平位置重合时只往上颠，不水平推', () => {
    const { zombies, advance, now } = standingOnPlayer();
    zombies.hitByPlayer(1, 1, { x: PLAYER.x, y: PLAYER.y + 5, z: PLAYER.z }, now());
    advance(1);
    expect(zombies.all()[0]!.position).toMatchObject({ x: PLAYER.x, z: PLAYER.z });
    expect(zombies.all()[0]!.position.y).toBeGreaterThan(FLAT_STAND_Y);
  });

  it('受击后 10 tick 内（含第 10 tick）再打不生效：不扣血，也不再击退；第 11 tick 生效', () => {
    const { zombies, advance, now } = standingOnPlayer();
    const first = now();
    zombies.hitByPlayer(1, 1, FROM_SOUTH, first);
    advance(10);
    expect(zombies.hitByPlayer(1, 1, FROM_SOUTH, now())).toBe(false);
    expect(zombies.all()[0]!.health).toBe(19);
    expect(zombies.all()[0]!.lastHurtTick).toBe(first);
    advance(1);
    expect(zombies.hitByPlayer(1, 1, FROM_SOUTH, now())).toBe(true);
    expect(zombies.all()[0]!.health).toBe(18);
  });

  it('没有这一只：不生效', () => {
    const { zombies, now } = standingOnPlayer();
    expect(zombies.hitByPlayer(99, 1, FROM_SOUTH, now())).toBe(false);
  });

  it('生命归零的那一只下一次推进时移除，在它所在那一格掉 0 到 2 件腐肉与一个 50 点的经验球', () => {
    const { zombies, advance, now, dropped, orbs } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 3.5, y: FLAT_STAND_Y, z: 0.5 });
    zombies.hitByPlayer(1, 25, FROM_SOUTH, now());
    expect(zombies.all()[0]!.health).toBe(0);
    advance(1);

    expect(zombies.count).toBe(0);
    const cell: Cell = [3, FLAT_STAND_Y, 0];
    expect(orbs).toEqual([{ amount: ZOMBIE_XP, at: cell }]);
    expect(dropped.length).toBeLessThanOrEqual(1);
    for (const { stack, at } of dropped) {
      expect(at).toEqual(cell);
      expect(stack.item).toBe(ItemType.RottenFlesh);
      expect(stack.count).toBeGreaterThanOrEqual(1);
      expect(stack.count).toBeLessThanOrEqual(2);
    }
  });

  it('视线求交：最先碰到的那一只；死了的不算', () => {
    const { zombies, now } = zombiesOnFlatGround();
    zombies.spawnAt({ x: 0.5, y: FLAT_STAND_Y, z: -4.5 });
    zombies.spawnAt({ x: 0.5, y: FLAT_STAND_Y, z: -2.5 });
    const eye: Vec3 = { x: 0.5, y: FLAT_STAND_Y + 1.62, z: 0.5 };
    const ahead: Vec3 = { x: 0, y: 0, z: -1 };

    expect(zombies.raycast(eye, ahead, 10)).toEqual({ id: 2, distance: expect.closeTo(2.7, 12) });
    expect(zombies.raycast(eye, ahead, 2.6)).toBeUndefined();

    zombies.hitByPlayer(2, 20, eye, now());
    expect(zombies.raycast(eye, ahead, 10)).toMatchObject({ id: 1 });
  });
});
