import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Difficulty } from '../../src/core/difficulty';
import { Drops } from '../../src/core/drop';
import { GameCore } from '../../src/core/game';
import { MAX_HEALTH } from '../../src/core/health';
import { ItemType, type ItemSink } from '../../src/core/item';
import { hitboxAt } from '../../src/core/physics';
import {
  IDLE_INTENT,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  WATER_MAX_SINK_SPEED,
  type MoveIntent,
} from '../../src/core/player';
import type { Terrain } from '../../src/core/terrain';
import type { Vec3 } from '../../src/core/vec3';
import type { World } from '../../src/core/world';
import { ZOMBIE_MAX_HEALTH, Zombies, type ZombieTarget } from '../../src/core/zombie';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain, flatTestWorld } from '../helpers/flat-terrain';

/*
 * 水中移动（#77）：玩家碰撞箱与水格重叠时算「在水里」，水平变慢、下沉变慢，按住跳上浮，水平被挡时按住跳能爬上岸，
 * 落进水里不受摔落伤害；眼睛那一格是水时算「眼睛在水下」。僵尸、掉落物在水里照旧。
 *
 * 全部在平地上用 `setBlock` 摆水池与岸（水不流动，摆在空中也停在原处），从核心的公共接口驱动：`turn`、`setMoveIntent`、
 * `tick`，读玩家的位置、上一 tick 的位置与生命值。速度只读位移，不读内部的速度分量；数值写在 src/core/player.ts 的常量里
 * 由实现按原版观感定，这里只断言相对关系（比陆上慢、比空气里慢、不超过上限、上浮为正）。
 */

const G = FLAT_GROUND_Y;

const FORWARD: MoveIntent = { ...IDLE_INTENT, forward: true };
const JUMP: MoveIntent = { ...IDLE_INTENT, jump: true };
const SWIM_FORWARD: MoveIntent = { ...IDLE_INTENT, forward: true, jump: true };

/** 视距 1 的平地核心，玩家站在原点那一格中心、朝 −Z。 */
function core(terrain: (seed: number) => Terrain = flatTerrain): GameCore {
  return new GameCore({ viewRadius: 1, terrain });
}

/** 把 [x0, x1] × [y0, y1] × [z0, z1]（含两端）填成 block。 */
function fill(
  game: GameCore,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  [z0, z1]: [number, number],
  block: BlockType,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) game.setBlock(x, y, z, block);
    }
  }
}

/** 推进 ticks 个 tick，返回每一 tick 结束时脚底的 y。 */
function heights(game: GameCore, intent: MoveIntent, ticks: number): number[] {
  game.setMoveIntent(intent);
  const ys: number[] = [];
  for (let i = 0; i < ticks; i++) {
    game.tick();
    ys.push(game.player.position.y);
  }
  game.setMoveIntent(IDLE_INTENT);
  return ys;
}

/** 按住 W 走 ticks 个 tick，返回朝 −Z 走了多远。 */
function walkedDistance(game: GameCore, ticks: number): number {
  const start = game.player.position.z;
  game.setMoveIntent(FORWARD);
  game.tick(ticks);
  game.setMoveIntent(IDLE_INTENT);
  return start - game.player.position.z;
}

/**
 * 深水箱：玩家所在那一列周围 3×3、从 G − 14 到 G + 3 全是水（替换掉地面），水面顶在 G + 4。玩家脚底在 G + 1，
 * 整个碰撞箱在水里，脚下还有 15 格水。`fillWith` 换成空气就是同样形状的干竖井，用来对照。
 */
const TANK_TOP = G + 3;
const TANK_SURFACE = TANK_TOP + 1;
function tank(game: GameCore, fillWith: BlockType = BlockType.Water): void {
  fill(game, [-1, 1], [G - 14, TANK_TOP], [-1, 1], fillWith);
}

/** 平地加一根石柱：原点那一列从 G + 1 到 G + height 是石头，出生点因此在柱顶。 */
function pillarTerrain(height: number): (seed: number) => Terrain {
  return (seed) => {
    const flat = flatTerrain(seed);
    return {
      ...flat,
      generateChunk: (cx, cz) => {
        const chunk = flat.generateChunk(cx, cz);
        if (cx === 0 && cz === 0) chunk.fillColumn(0, 0, G + 1, G + height, BlockType.Stone);
        return chunk;
      },
    };
  };
}

describe('在水里的水平移动（#77）', () => {
  it('平地上挖一个 3 格深的水池，玩家在池底走同样多的 tick，走得比在陆上近', () => {
    const land = core();
    const onLand = walkedDistance(land, 20);

    const pool = core();
    // 池子沿 −Z 伸出去 16 格，够走 20 tick
    fill(pool, [-2, 2], [G - 2, G], [-15, 1], BlockType.Water);
    pool.tick(30); // 先沉到池底
    const inWater = walkedDistance(pool, 20);

    expect(inWater).toBeLessThan(onLand);
    // 仍然走得动，不是被挡住了
    expect(inWater).toBeGreaterThan(0);
    // 场景搭对了：玩家确实在水池里，没有站在地面上
    expect(pool.player.position.y).toBeLessThan(FLAT_STAND_Y);
  });
});

describe('在水里的下沉与上浮（#77）', () => {
  it('不按跳时会下沉，但比在同样形状的干竖井里落得慢', () => {
    const wet = core();
    tank(wet);
    const wetDrop = FLAT_STAND_Y - heights(wet, IDLE_INTENT, 20).at(-1)!;

    const dry = core();
    tank(dry, BlockType.Air);
    const dryDrop = FLAT_STAND_Y - heights(dry, IDLE_INTENT, 20).at(-1)!;

    expect(wetDrop).toBeGreaterThan(0);
    expect(wetDrop).toBeLessThan(dryDrop);
  });

  it('在深水里一直下沉，每 tick 的下降都不超过水里的下落速度上限', () => {
    expect(WATER_MAX_SINK_SPEED).toBeGreaterThan(0);
    const game = core();
    tank(game);
    let previous = game.player.position.y;
    const drops: number[] = [];
    for (const y of heights(game, IDLE_INTENT, 60)) {
      drops.push(previous - y);
      previous = y;
    }
    expect(Math.max(...drops)).toBeLessThanOrEqual(WATER_MAX_SINK_SPEED + 1e-9);
    // 场景搭对了：60 tick 之后还悬在水中，没有落到箱底
    expect(game.player.position.y).toBeGreaterThan(G - 14);
  });

  it('从高处落进深水：入水之后每 tick 的下降都不超过水里的下落速度上限，不按空气里的速度一直冲下去', () => {
    // 出生在 30 格高的石柱顶上；水箱替换掉石柱的下段，再拆掉水面以上的那段，玩家从水面上方 27 格落进水箱
    const game = core(pillarTerrain(30));
    tank(game);
    fill(game, [0, 0], [TANK_SURFACE, G + 30], [0, 0], BlockType.Air);
    let wetTicks = 0;
    for (let i = 0; i < 80; i++) {
      const wasInWater = game.player.inWater;
      game.tick();
      if (!wasInWater) continue;
      wetTicks++;
      const drop = game.player.previousPosition.y - game.player.position.y;
      expect(drop, `第 ${i + 1} tick`).toBeLessThanOrEqual(WATER_MAX_SINK_SPEED + 1e-9);
    }
    // 场景搭对了：真的落进了水箱，在水里待了一阵，还没沉到箱底
    expect(wetTicks).toBeGreaterThan(20);
    expect(game.player.position.y).toBeGreaterThan(G - 14);
  });

  it('悬在水中按住跳：没有踩着地也逐 tick 上升，是向上的速度而不是起跳', () => {
    const game = core();
    tank(game);
    const ys = heights(game, JUMP, 20);
    // 前两 tick 留给加速；之后每一 tick 都比上一 tick 高。起跳要求踩在地上，这里脚下是 15 格水
    for (let i = 2; i < ys.length; i++) expect(ys[i]!, `第 ${i + 1} tick`).toBeGreaterThan(ys[i - 1]!);
  });

  it('一直按住跳会浮到水面：头露出水面，但不会从开阔的水面上蹦出去', () => {
    const game = core();
    tank(game);
    const ys = heights(game, JUMP, 300);
    const eyes = ys.map((y) => y + PLAYER_EYE_HEIGHT);
    // 眼睛到过水面之上
    expect(Math.max(...eyes)).toBeGreaterThan(TANK_SURFACE);
    // 脚不高出水面半格：没有岸可爬时只是在水面上浮着
    expect(Math.max(...ys)).toBeLessThan(TANK_SURFACE + 0.5);
    // 浮上来之后停在水面附近，不再沉下去：最后 40 tick 眼睛离水面不到一格
    expect(Math.min(...eyes.slice(-40))).toBeGreaterThan(TANK_SURFACE - 1);
  });
});

describe('从水里爬上岸（#77）', () => {
  /**
   * 平地上挖一个 5 格宽、3 格深的水池（水在 G − 2 到 G，水面在 G + 1），玩家在池里朝 −Z，岸在 z ≤ −7。
   * 按住跳与 W 走，至多 300 tick，直到站在 standY 上为止。返回站上去了没有与最后的位置。
   */
  function swimToShore(raiseShore: boolean, standY: number) {
    const game = core();
    fill(game, [-2, 2], [G - 2, G], [-6, 1], BlockType.Water);
    // 岸比水面高一格：岸上多铺一层石头
    if (raiseShore) fill(game, [-2, 2], [G + 1, G + 1], [-9, -7], BlockType.Stone);
    game.setMoveIntent(SWIM_FORWARD);
    let climbed = false;
    for (let i = 0; i < 300 && !climbed; i++) {
      game.tick();
      climbed = game.player.onGround && game.player.position.y === standY;
    }
    game.setMoveIntent(IDLE_INTENT);
    return { climbed, position: game.player.position };
  }

  /** 与上面同一个水池，岸上摞 layers 层石头（岸顶比水面高 layers 格），按住跳与 W 游 300 tick，返回站上岸顶没有与脚底到过的最高处。 */
  function swimToWall(layers: number) {
    const game = core();
    fill(game, [-2, 2], [G - 2, G], [-6, 1], BlockType.Water);
    fill(game, [-2, 2], [G + 1, G + layers], [-9, -7], BlockType.Stone);
    game.setMoveIntent(SWIM_FORWARD);
    let climbed = false;
    let highestFeet = -Infinity;
    for (let i = 0; i < 300; i++) {
      game.tick();
      highestFeet = Math.max(highestFeet, game.player.position.y);
      climbed ||= game.player.onGround && game.player.position.y === G + 1 + layers;
    }
    game.setMoveIntent(IDLE_INTENT);
    return { climbed, highestFeet };
  }

  it('岸比水面高一格：按住跳朝岸游，水平被岸挡住时得到额外的上升速度，最后站在岸顶上', () => {
    const { climbed, position } = swimToShore(true, G + 2);
    expect(climbed).toBe(true);
    expect(Math.floor(position.z)).toBeLessThanOrEqual(-7);
    expect(Math.floor(position.z)).toBeGreaterThanOrEqual(-9);
  });

  it('深水里贴着墙按住跳与 W：离水面还远时不给爬岸的速度，上升不比只按跳快', () => {
    const game = core();
    tank(game);
    // 先沉下去：100 tick 之后脚底在 G − 9 附近，正前方 z = −2 那一列是地下的石头，离水面十几格
    heights(game, IDLE_INTENT, 100);
    const ys = heights(game, SWIM_FORWARD, 40);
    let previous = ys[0]!;
    for (const [i, y] of ys.slice(1).entries()) {
      // 按住跳在水里每 tick 至多上升 0.1 格（`WATER_SWIM_UP_SPEED` 与阻力、重力收敛到的速度）
      expect(y - previous, `第 ${i + 2} tick`).toBeLessThanOrEqual(0.1 + 1e-9);
      previous = y;
    }
    // 场景搭对了：一直贴着墙（被挡在 z = −1 那一格里），而且 40 tick 之后还在水面以下很深的地方
    expect(Math.floor(game.player.position.z)).toBe(-1);
    expect(game.player.position.y).toBeLessThan(G);
  });

  it('岸在 −X 方向、比水面高一格：朝 −X 游过去同样爬得上去', () => {
    const game = core();
    // 把上面的水池转到 x 轴上：水在 x ∈ [−6, 1]，岸在 x ≤ −7
    fill(game, [-6, 1], [G - 2, G], [-2, 2], BlockType.Water);
    fill(game, [-9, -7], [G + 1, G + 1], [-2, 2], BlockType.Stone);
    // 偏航 π/2：前方是 −X
    game.turn(Math.PI / 2, 0);
    game.setMoveIntent(SWIM_FORWARD);
    let climbed = false;
    for (let i = 0; i < 300 && !climbed; i++) {
      game.tick();
      climbed = game.player.onGround && game.player.position.y === G + 2;
    }
    expect(climbed).toBe(true);
    expect(Math.floor(game.player.position.x)).toBeLessThanOrEqual(-7);
  });

  it('深水底部被一格高的台阶挡住：离水面还远时不给爬岸的速度，按住跳只按水里的上浮速度升起来', () => {
    const game = core();
    tank(game);
    // 水箱底部朝 −Z 那一排垫一格石头，成为一级台阶；先沉到箱底
    fill(game, [-1, 1], [G - 14, G - 14], [-1, -1], BlockType.Stone);
    heights(game, IDLE_INTENT, 200);
    // 落点与箱底之间只差碰撞扫掠容差以内的舍入误差
    expect(game.player.position.y).toBeCloseTo(G - 14, 9);
    let previous = game.player.position.y;
    const ys = heights(game, SWIM_FORWARD, 30);
    for (const [i, y] of ys.entries()) {
      expect(y - previous, `第 ${i + 1} tick`).toBeLessThanOrEqual(0.1 + 1e-9);
      previous = y;
    }
    // 场景搭对了：已经越过了台阶，离水面还远
    expect(game.player.position.y).toBeGreaterThan(G - 13);
    expect(game.player.position.y).toBeLessThan(G);
  });

  it('岸比水面高两格：按住跳朝岸游，被挡住时不给爬岸的速度，只在水面上浮着，不会一次次被抬出水面', () => {
    const { climbed, highestFeet } = swimToWall(2);
    expect(climbed).toBe(false);
    // 浮在水面时脚底至多比水面高约 0.05 格；被抬出水面时会高出 1 格以上
    expect(highestFeet).toBeLessThan(G + 1 + 0.5);
  });

  it('岸与水面齐平（平地上挖的池子）：按住跳朝岸游，最后站回地面上', () => {
    const { climbed, position } = swimToShore(false, FLAT_STAND_Y);
    expect(climbed).toBe(true);
    expect(Math.floor(position.z)).toBeLessThanOrEqual(-7);
  });
});

describe('落进水里不受摔落伤害（#77）', () => {
  /** 出生列上立着的石柱高度：玩家出生在柱顶，脚底离地面 PILLAR 格。 */
  const PILLAR = 20;

  /** 站在柱顶上，按 withPool 在柱脚挖一个 3 格深的水池，再拆掉石柱，推进到落定为止。 */
  function fallFromPillar(withPool: boolean): GameCore {
    const game = core(pillarTerrain(PILLAR));
    expect(game.player.position.y).toBe(FLAT_STAND_Y + PILLAR);
    if (withPool) fill(game, [-2, 2], [G - 2, G], [-2, 2], BlockType.Water);
    fill(game, [0, 0], [G + 1, G + PILLAR], [0, 0], BlockType.Air);
    game.tick(100);
    return game;
  }

  it('从 20 格高处落进 3 格深的水里，生命值不变', () => {
    const game = fallFromPillar(true);
    expect(game.health.points).toBe(MAX_HEALTH);
    // 场景搭对了：玩家确实落进了水池，在地面以下
    expect(game.player.position.y).toBeLessThan(FLAT_STAND_Y);
  });

  it('从 20 格高处落进铺在草地上的一层水里，同一 tick 入水并落到水底，生命值也不变', () => {
    const game = core(pillarTerrain(PILLAR));
    // 一层水铺在草地上（G + 1），石柱那一格留给下面拆
    fill(game, [-2, 2], [G + 1, G + 1], [-2, 2], BlockType.Water);
    fill(game, [0, 0], [G + 1, G + PILLAR], [0, 0], BlockType.Air);
    game.setBlock(0, G + 1, 0, BlockType.Water);
    let landedFromAir = false;
    for (let i = 0; i < 100; i++) {
      const wasInWater = game.player.inWater;
      game.tick();
      if (game.player.onGround && !wasInWater && game.player.inWater) landedFromAir = true;
    }
    // 场景搭对了：入水与落到草地上是同一 tick，这一 tick 开始时还在空中
    expect(landedFromAir).toBe(true);
    expect(game.player.position.y).toBe(FLAT_STAND_Y);
    expect(game.health.points).toBe(MAX_HEALTH);
  });

  it('下落途中水平走进一层悬空的水、碰撞箱只擦进水格一点，下一 tick 就离开了水，落到地上也不扣血', () => {
    // 石柱旁边 G + 4 那一层摆一片悬空的水；第 23 tick 起按 W，那一 tick 水平移动之后碰撞箱顶端擦进水格约 0.03 格，
    // 下一 tick 下沉 0.1 格就离开了水。在水里的那一刻落差就该从那里重新算起（复现方法来自 #77 的审查）
    const game = core(pillarTerrain(PILLAR));
    fill(game, [-2, 2], [G + 4, G + 4], [-3, -1], BlockType.Water);
    fill(game, [0, 0], [G + 1, G + PILLAR], [0, 0], BlockType.Air);
    let wetTicks = 0;
    for (let i = 0; i < 100; i++) {
      game.setMoveIntent(i >= 23 ? FORWARD : IDLE_INTENT);
      game.tick();
      if (game.player.inWater) wetTicks++;
    }
    // 场景搭对了：只有一个 tick 结束时在水里，最后落在草地上
    expect(wetTicks).toBe(1);
    expect(game.player.position.y).toBe(FLAT_STAND_Y);
    expect(game.health.points).toBe(MAX_HEALTH);
  });

  it('对照：同样高度落在草地上扣血', () => {
    const game = fallFromPillar(false);
    expect(game.player.position.y).toBe(FLAT_STAND_Y);
    expect(game.health.points).toBeLessThan(MAX_HEALTH);
  });
});

describe('在水里与眼睛在水下的判定（#77）', () => {
  // 玩家站在原点那一格的草方块上：脚底在 G + 1，眼睛在 G + 1 + 1.62，落在 G + 2 那一格
  const FEET_Y = FLAT_STAND_Y;
  const EYE_Y = Math.floor(FLAT_STAND_Y + PLAYER_EYE_HEIGHT);

  it('什么水都没有时不在水里，眼睛也不在水下', () => {
    const game = core();
    expect(game.player.inWater).toBe(false);
    expect(game.player.eyeInWater).toBe(false);
  });

  it('眼睛所在那一格是水：在水里，眼睛在水下', () => {
    const game = core();
    game.setBlock(0, EYE_Y, 0, BlockType.Water);
    expect(game.player.inWater).toBe(true);
    expect(game.player.eyeInWater).toBe(true);
  });

  it('只有脚下那一格是水：在水里，眼睛不在水下', () => {
    const game = core();
    game.setBlock(0, FEET_Y, 0, BlockType.Water);
    expect(game.player.inWater).toBe(true);
    expect(game.player.eyeInWater).toBe(false);
  });

  it('碰撞箱只是贴着水格的侧面、没有重叠出体积时不算在水里', () => {
    const game = core();
    // 碰撞箱在 x ∈ [0.2, 0.8]，x = 1 那一格的水离它还有 0.2 格；x = −1 那一格同理
    game.setBlock(1, FEET_Y, 0, BlockType.Water);
    game.setBlock(-1, FEET_Y, 0, BlockType.Water);
    expect(game.player.inWater).toBe(false);
  });

  it('只有头顶上方那一格是水：碰撞箱没有伸进去，不在水里', () => {
    const game = core();
    // 碰撞箱顶在 G + 1 + 1.8，离 G + 3 那一格还有 0.2 格
    game.setBlock(0, FEET_Y + 2, 0, BlockType.Water);
    expect(game.player.inWater).toBe(false);
    expect(game.player.eyeInWater).toBe(false);
  });

  it('拆掉水之后两者都回到假', () => {
    const game = core();
    game.setBlock(0, EYE_Y, 0, BlockType.Water);
    game.setBlock(0, FEET_Y, 0, BlockType.Water);
    expect(game.player.eyeInWater).toBe(true);
    game.setBlock(0, EYE_Y, 0, BlockType.Air);
    game.setBlock(0, FEET_Y, 0, BlockType.Air);
    expect(game.player.inWater).toBe(false);
    expect(game.player.eyeInWater).toBe(false);
  });
});

describe('只改玩家：僵尸与掉落物在水里照旧（#77 回归检查）', () => {
  /*
   * 同一个场景摆两份：原点周围 5×5、3 格深的坑，一份灌水、一份留空，从坑上方放下同一只僵尸或同一个掉落物，逐 tick 比位置。
   * 两份完全一样，才说明水只改了玩家。经验球不受重力、不与方块碰撞（src/core/xp-orb.ts），构造时连世界都没有，不必比。
   */
  function pit(world: World, fillWith: BlockType): void {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = G - 2; y <= G; y++) world.setBlock(x, y, z, fillWith);
      }
    }
  }

  /** 玩家站在坑底中心。僵尸追的是它，打到也不扣什么。 */
  const PLAYER_AT: Vec3 = { x: 0.5, y: G - 2, z: 0.5 };
  const BYSTANDER: ZombieTarget = {
    position: PLAYER_AT,
    hitbox: hitboxAt(PLAYER_AT, PLAYER_WIDTH, PLAYER_HEIGHT),
    hitByZombie: () => {},
  };

  function zombieTrace(fillWith: BlockType): Array<{ y: number; health: number }> {
    const world = flatTestWorld();
    pit(world, fillWith);
    const zombies = new Zombies(world, 1234, { spawnInBlock: () => {} }, { spawnInBlock: () => {} }, Difficulty.Normal);
    // 离坑底 11 格：落地扣 8 点
    zombies.spawnAt({ x: 0.5, y: FLAT_STAND_Y + 8, z: 0.5 });
    const trace: Array<{ y: number; health: number }> = [];
    for (let tick = 1; tick <= 60; tick++) {
      // 夜晚：白天露天会燃烧，掉血就分不清是摔的还是烧的
      zombies.step(tick, BYSTANDER, true);
      const zombie = zombies.all()[0];
      if (zombie) trace.push({ y: zombie.position.y, health: zombie.health });
    }
    return trace;
  }

  it('僵尸落进水坑与落进同样的空坑逐 tick 一样：沉到坑底，照常受摔落伤害', () => {
    const wet = zombieTrace(BlockType.Water);
    const dry = zombieTrace(BlockType.Air);
    expect(wet).toEqual(dry);
    expect(wet.at(-1)!.y).toBe(G - 2);
    expect(wet.at(-1)!.health).toBeLessThan(ZOMBIE_MAX_HEALTH);
  });

  /** 什么都收不下：掉落物不会被拾取。 */
  const FULL_SINK: ItemSink = { add: (stack) => stack.count };
  const FAR_AWAY = hitboxAt({ x: 40.5, y: FLAT_STAND_Y, z: 40.5 }, PLAYER_WIDTH, PLAYER_HEIGHT);

  function dropTrace(fillWith: BlockType): number[] {
    const world = flatTestWorld();
    pit(world, fillWith);
    const drops = new Drops(world, 1234);
    drops.spawnInBlock({ item: ItemType.Dirt, count: 1 }, 0, FLAT_STAND_Y + 2, 0);
    const trace: number[] = [];
    for (let i = 0; i < 60; i++) {
      drops.step(FAR_AWAY, FULL_SINK);
      trace.push(drops.all()[0]!.position.y);
    }
    return trace;
  }

  it('掉落物落进水坑与落进同样的空坑逐 tick 一样：沉到坑底', () => {
    const wet = dropTrace(BlockType.Water);
    const dry = dropTrace(BlockType.Air);
    expect(wet).toEqual(dry);
    expect(wet.at(-1)).toBe(G - 2);
  });
});
