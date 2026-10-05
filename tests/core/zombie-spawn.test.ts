import { describe, expect, it } from 'vitest';
import { BlockType, isSolid } from '../../src/core/block';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { ItemType } from '../../src/core/item';
import { IDLE_INTENT } from '../../src/core/player';
import { WORLD_MAX_Y } from '../../src/core/constants';
import { NIGHT_END, NIGHT_SKY_DARKENING, NIGHT_START } from '../../src/core/time-of-day';
import type { Vec3 } from '../../src/core/vec3';
import {
  ZOMBIE_MAX_COUNT,
  ZOMBIE_SPAWN_MAX_DISTANCE,
  ZOMBIE_SPAWN_INTERVAL,
  ZOMBIE_SPAWN_MIN_DISTANCE,
  Zombies,
  type ZombieView,
} from '../../src/core/zombie';
import { FLAT_STAND_Y, flatTerrain, flatTestWorld } from '../helpers/flat-terrain';

/*
 * 僵尸的自然生成（#44，#55 改按光照判定）。玩家站在原点那一格中心 (0.5, 71, 0.5)。视距 3 时加载到
 * ±48 格以外，24 到 48 格的整个圆环都在已加载区块里。
 */

const SEED = 1234;

/** 平地核心。 */
function core(seed = SEED, viewRadius = 3): GameCore {
  return new GameCore({ seed, viewRadius, terrain: flatTerrain });
}

/** 屋顶的 y：平地之上隔 3 格空气盖一层石头，玩家与僵尸都站得进屋里。 */
const ROOF_Y = FLAT_STAND_Y + 3;

/** 在 game 里用石头盖一层屋顶，罩住 24 到 48 格的整个圆环（视距 3 时 ±48 格都已加载）。 */
function roofOver(game: GameCore): GameCore {
  for (let x = -48; x <= 48; x++) {
    for (let z = -48; z <= 48; z++) game.setBlock(x, ROOF_Y, z, BlockType.Stone);
  }
  return game;
}

/** 一只刚生成的僵尸：第几个 tick 出现的、那时在哪、玩家那时在哪。 */
interface Spawned {
  readonly tick: number;
  readonly id: number;
  readonly position: Vec3;
  readonly player: Vec3;
}

/** 推进 ticks 个 tick，逐 tick 记下新出现的僵尸。 */
function spawnsOver(game: GameCore, ticks: number): Spawned[] {
  const seen = new Set(game.zombies.all().map((zombie) => zombie.id));
  const spawned: Spawned[] = [];
  for (let n = 0; n < ticks; n++) {
    game.tick();
    for (const zombie of game.zombies.all()) {
      if (seen.has(zombie.id)) continue;
      seen.add(zombie.id);
      spawned.push({
        tick: game.tickCount,
        id: zombie.id,
        position: zombie.position,
        player: game.player.position,
      });
    }
  }
  return spawned;
}

function atNight(game: GameCore): GameCore {
  game.setTimeOfDay(NIGHT_START);
  return game;
}

function horizontal(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 僵尸列表的全部字段，逐字段比较用。 */
function snapshot(zombies: readonly ZombieView[]) {
  return zombies.map(({ id, position, previousPosition, yaw, age, health, lastHurtTick, burning }) => ({
    id,
    position,
    previousPosition,
    yaw,
    age,
    health,
    lastHurtTick,
    burning,
  }));
}

describe('白天不生成', () => {
  it('平地上白天推进 2000 tick，一只僵尸都没有', () => {
    const game = core();
    expect(game.isNight).toBe(false);
    game.tick(2000);
    expect(game.isNight).toBe(false);
    expect(game.zombies.count).toBe(0);
  });

  it('白天屋顶底下的列不生成：候选位置只看列顶，列顶是屋顶，屋顶上面那格折算天光 15', () => {
    const game = roofOver(core());
    // 屋顶底下的地面方块光 0、折算天光 0，生成要是看这一格就会生成
    expect(game.effectiveSkyLightAt(30, FLAT_STAND_Y, 0)).toBe(0);
    expect(game.blockLightAt(30, FLAT_STAND_Y, 0)).toBe(0);
    expect(game.highestBlockY(30, 0)).toBe(ROOF_Y);
    expect(game.effectiveSkyLightAt(30, ROOF_Y + 1, 0)).toBe(15);

    expect(spawnsOver(game, 2000)).toEqual([]);
  });

  it('同样的屋顶，夜晚生成在屋顶上面', () => {
    const spawned = spawnsOver(atNight(roofOver(core())), 2000);
    expect(spawned.length).toBeGreaterThan(0);
    for (const { position } of spawned) expect(position.y).toBe(ROOF_Y + 1);
  });
});

describe('夜晚在 24 到 48 格外的露天地表生成', () => {
  it('夜晚推进 2000 tick 有僵尸；每只出现时离玩家 24 到 48 格、脚下实心、身位两格空气、在列顶之上，那格折算天光 4、方块光 0', () => {
    const game = atNight(core());
    const spawned = spawnsOver(game, 2000);

    expect(spawned.length).toBeGreaterThan(0);
    expect(ZOMBIE_SPAWN_MIN_DISTANCE).toBe(24);
    expect(ZOMBIE_SPAWN_MAX_DISTANCE).toBe(48);
    for (const { tick, position, player } of spawned) {
      const label = `第 ${tick} tick 生成的那只`;
      const distance = horizontal(position, player);
      expect(distance, label).toBeGreaterThanOrEqual(24);
      expect(distance, label).toBeLessThanOrEqual(48);
      const [bx, by, bz] = [Math.floor(position.x), position.y, Math.floor(position.z)];
      expect(isSolid(game.getBlock(bx, by - 1, bz)), label).toBe(true);
      expect(game.getBlock(bx, by, bz), label).toBe(BlockType.Air);
      expect(game.getBlock(bx, by + 1, bz), label).toBe(BlockType.Air);
      expect(position.y, label).toBe(game.highestBlockY(bx, bz) + 1);
      expect(position.y, label).toBe(FLAT_STAND_Y);
      expect(game.effectiveSkyLightAt(bx, by, bz), label).toBe(4);
      expect(game.blockLightAt(bx, by, bz), label).toBe(0);
      // 站在那一列的中心
      expect(position.x - bx, label).toBe(0.5);
      expect(position.z - bz, label).toBe(0.5);
    }
  });

  it('只在 tick 能被 20 整除时生成，一次至多一只', () => {
    const spawned = spawnsOver(atNight(core()), 2000);
    for (const { tick } of spawned) expect(tick % 20, `第 ${tick} tick`).toBe(0);
    const ticks = spawned.map(({ tick }) => tick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('同一种子两次运行，生成的位置与 tick 逐一相同；换一个种子不同', () => {
    const first = spawnsOver(atNight(core(SEED)), 2000);
    const second = spawnsOver(atNight(core(SEED)), 2000);
    const other = spawnsOver(atNight(core(SEED + 1)), 2000);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
  });
});

describe('生成的条件', () => {
  it('同时至多 8 只：夜晚推进 2000 tick，数量到过 8，从没超过 8', () => {
    const game = atNight(core());
    let most = 0;
    for (let n = 0; n < 2000; n++) {
      game.tick();
      most = Math.max(most, game.zombies.count);
    }
    expect(ZOMBIE_MAX_COUNT).toBe(8);
    expect(most).toBe(8);
  });

  it('已有 8 只时不再生成', () => {
    const game = atNight(core());
    const { x, y, z } = game.player.position;
    for (let n = 0; n < 8; n++) game.spawnZombieAt(x, y, z);

    expect(spawnsOver(game, 2000)).toEqual([]);
    expect(game.zombies.all().map((zombie) => zombie.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('候选列所在区块没加载就不生成：只加载玩家脚下那一个区块，2000 tick 一只都没有', () => {
    // 视距 0 只加载原点区块，x 与 z 都在 [0, 16) 里，离 (0.5, 0.5) 最远不到 22 格
    const game = atNight(core(SEED, 0));
    expect(game.loadedChunkCount).toBe(1);
    game.tick(2000);
    expect(game.zombies.count).toBe(0);
  });

  it('玩家头顶盖一层方块不影响生成：看的是候选列，不是玩家那一列', () => {
    const open = spawnsOver(atNight(core()), 2000);

    const covered = atNight(core());
    // 盖得比击退的上抛高，玩家挨打时碰不到它，走法与露天时一样
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) covered.setBlock(dx, FLAT_STAND_Y + 10, dz, BlockType.Stone);
    }
    expect(covered.highestBlockY(0, 0)).toBe(FLAT_STAND_Y + 10);

    expect(open.length).toBeGreaterThan(0);
    expect(spawnsOver(covered, 2000)).toEqual(open);
  });

  it('手持火把不影响生成：手持光只在画面上，玩家脚下那格与每只生成处的方块光仍 0，生成的位置与 tick 与空手时逐一相同（#58）', () => {
    const bare = spawnsOver(atNight(core()), 2000);

    const holding = atNight(core());
    expect(holding.giveItem(ItemType.Torch, 64)).toBe(0);
    expect(holding.inventory.held?.item).toBe(ItemType.Torch);
    const { x, y, z } = holding.player.position;
    // 玩家站着那一列：列顶上面那格就是脚下那格
    expect(holding.highestBlockY(Math.floor(x), Math.floor(z)) + 1).toBe(y);
    expect(holding.blockLightAt(Math.floor(x), y, Math.floor(z))).toBe(0);

    const spawned = spawnsOver(holding, 2000);
    expect(bare.length).toBeGreaterThan(0);
    expect(spawned).toEqual(bare);
    for (const { tick, position } of spawned) {
      const [bx, by, bz] = [Math.floor(position.x), position.y, Math.floor(position.z)];
      expect(holding.blockLightAt(bx, by, bz), `第 ${tick} tick 生成的那只`).toBe(0);
    }
  });
});

describe('光源旁不生成（#55）', () => {
  it('24 到 48 格的地面布满燃烧中的熔炉，夜晚 2000 tick 一只都没有', () => {
    const game = atNight(core());
    // 每 8 格一座，地面上任意一格离最近的一座曼哈顿距离不超过 8，方块光至少 13 − 8
    for (let x = -48; x <= 48; x += 8) {
      for (let z = -48; z <= 48; z += 8) {
        if (Math.hypot(x, z) < 16) continue;
        expect(game.setBlock(x, FLAT_STAND_Y, z, BlockType.LitFurnace)).toBe(true);
      }
    }
    expect(game.blockLightAt(28, FLAT_STAND_Y, 4)).toBeGreaterThan(0);

    expect(spawnsOver(game, 2000)).toEqual([]);
  });
});

describe('黄昏与黎明的边界（#55）', () => {
  /** 世界时刻 t 那一 tick 正好是一次生成尝试：拨到 t 之前 20 tick 再推进 20 tick，返回生成了几只。 */
  function attemptAt(t: number): number {
    const game = core();
    game.setTimeOfDay(t - ZOMBIE_SPAWN_INTERVAL);
    game.tick(ZOMBIE_SPAWN_INTERVAL);
    expect(game.timeOfDay).toBe(t);
    return game.zombies.count;
  }

  it('setTimeOfDay(12800) 推进 100 tick 露天生成，setTimeOfDay(12600) 推进 60 tick 不生成', () => {
    const dusk = core();
    dusk.setTimeOfDay(12800);
    expect(spawnsOver(dusk, 100).length).toBeGreaterThan(0);

    const early = core();
    early.setTimeOfDay(12600);
    // 推进到 12660：减量 7.26 取整为 7，露天折算天光 8
    expect(spawnsOver(early, 60)).toEqual([]);
  });

  it('setTimeOfDay(23200) 推进 100 tick 露天生成，setTimeOfDay(23400) 推进 100 tick 不生成', () => {
    const dawn = core();
    dawn.setTimeOfDay(23200);
    expect(spawnsOver(dawn, 100).length).toBeGreaterThan(0);

    const late = core();
    late.setTimeOfDay(23400);
    expect(spawnsOver(late, 100)).toEqual([]);
  });

  it('紧挨边界：12681 不生成、12682 生成；23318 生成、23319 不生成（减量取整之后的分界）', () => {
    // 这个种子在第 20 tick 的候选列成立：夜里那一次尝试生成得出来
    expect(attemptAt(NIGHT_START + 1000)).toBe(1);
    expect(attemptAt(12681)).toBe(0);
    expect(attemptAt(12682)).toBe(1);
    expect(attemptAt(23318)).toBe(1);
    expect(attemptAt(23319)).toBe(0);
  });
});

describe('确定性', () => {
  it('同一种子、同一指令序列，两次运行 3000 tick 后僵尸列表逐字段相同', () => {
    // 从天亮前 2800 tick 起跑：先是生成、追击、打玩家，最后 200 tick 天亮了在露天燃烧
    const run = () => {
      const game = core();
      game.setTimeOfDay(NIGHT_END - 2800);
      game.setMoveIntent({ ...IDLE_INTENT, forward: true });
      game.tick(200);
      game.turn(1, 0);
      game.tick(300);
      game.setMoveIntent(IDLE_INTENT);
      game.tick(2500);
      return snapshot(game.zombies.all());
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((zombie) => zombie.burning)).toBe(true);
    expect(run()).toEqual(first);
  });
});

describe('候选列（Zombies.spawnNaturally）', () => {
  // 每一次尝试各用一个新的僵尸集合，现有数量总是 0，不受上限限制：2000 次尝试都只由候选列的规则决定成败。
  const world = flatTestWorld(3);
  const player: Vec3 = { x: 0.5, y: FLAT_STAND_Y, z: 0.5 };
  const sinks = [{ spawnInBlock: () => {} }, { spawnInBlock: () => {} }] as const;

  function attempt(tick: number, darkening = NIGHT_SKY_DARKENING, blocks = world): ZombieView | undefined {
    const zombies = new Zombies(blocks, SEED, ...sinks, Difficulty.Normal);
    zombies.spawnNaturally(tick, player, darkening);
    return zombies.all()[0];
  }

  it('2000 次尝试：生成的每一只都在列的中心、离玩家水平 24 到 48 格；整片都加载了，大多数尝试都成功', () => {
    let spawned = 0;
    for (let n = 1; n <= 2000; n++) {
      const zombie = attempt(n * ZOMBIE_SPAWN_INTERVAL);
      if (!zombie) continue;
      spawned++;
      const distance = horizontal(zombie.position, player);
      expect(distance, `第 ${n} 次`).toBeGreaterThanOrEqual(ZOMBIE_SPAWN_MIN_DISTANCE);
      expect(distance, `第 ${n} 次`).toBeLessThanOrEqual(ZOMBIE_SPAWN_MAX_DISTANCE);
      expect(zombie.position.y).toBe(FLAT_STAND_Y);
    }
    // 取整到列上偏出 24 到 48 格的那些放弃，只占很少一部分
    expect(spawned).toBeGreaterThan(1900);
    expect(spawned).toBeLessThan(2000);
  });

  it('tick 不能被 20 整除时不试', () => {
    for (let tick = 1; tick < ZOMBIE_SPAWN_INTERVAL; tick++) expect(attempt(tick)).toBeUndefined();
  });

  it('折算天光不超过 7 才生成：露天减量 8（折算 7）生成，减量 7（折算 8）与白天的 0 不生成', () => {
    expect(attempt(ZOMBIE_SPAWN_INTERVAL, 8)).toBeDefined();
    expect(attempt(ZOMBIE_SPAWN_INTERVAL, 7)).toBeUndefined();
    expect(attempt(ZOMBIE_SPAWN_INTERVAL, 0)).toBeUndefined();
  });

  it('候选列顶上面那格方块光大于 0 不生成：燃烧中的熔炉在 12 格外（方块光 1）不生成，13 格外（0）生成', () => {
    const tick = ZOMBIE_SPAWN_INTERVAL;
    const plain = attempt(tick)!;
    const [bx, by, bz] = [Math.floor(plain.position.x), plain.position.y, Math.floor(plain.position.z)];
    // 熔炉沿 x 朝原点那边摆，留在已加载的区块里
    const toward = bx > 0 ? -1 : 1;

    const near = flatTestWorld(3);
    near.setBlock(bx + toward * 12, by, bz, BlockType.LitFurnace);
    expect(near.blockLightAt(bx, by, bz)).toBe(1);
    expect(attempt(tick, NIGHT_SKY_DARKENING, near)).toBeUndefined();

    const far = flatTestWorld(3);
    far.setBlock(bx + toward * 13, by, bz, BlockType.LitFurnace);
    expect(far.blockLightAt(bx, by, bz)).toBe(0);
    expect(attempt(tick, NIGHT_SKY_DARKENING, far)?.position).toEqual(plain.position);
  });

  it('候选列被火把照到不生成：火把在 13 格外（方块光 1）不生成，14 格外（0）生成（#56）', () => {
    const tick = ZOMBIE_SPAWN_INTERVAL;
    const plain = attempt(tick)!;
    const [bx, by, bz] = [Math.floor(plain.position.x), plain.position.y, Math.floor(plain.position.z)];
    const toward = bx > 0 ? -1 : 1;

    const near = flatTestWorld(3);
    near.setBlock(bx + toward * 13, by, bz, BlockType.Torch);
    expect(near.blockLightAt(bx, by, bz)).toBe(1);
    expect(attempt(tick, NIGHT_SKY_DARKENING, near)).toBeUndefined();

    const far = flatTestWorld(3);
    far.setBlock(bx + toward * 14, by, bz, BlockType.Torch);
    expect(far.blockLightAt(bx, by, bz)).toBe(0);
    expect(attempt(tick, NIGHT_SKY_DARKENING, far)?.position).toEqual(plain.position);
  });

  it('列顶在世界最高一层时不生成：上面那一格不在光照数组里；低一层照常生成', () => {
    const tick = ZOMBIE_SPAWN_INTERVAL;
    const plain = attempt(tick)!;
    const [bx, bz] = [Math.floor(plain.position.x), Math.floor(plain.position.z)];

    const top = flatTestWorld(3);
    top.setBlock(bx, WORLD_MAX_Y, bz, BlockType.Stone);
    expect(top.highestBlockY(bx, bz)).toBe(WORLD_MAX_Y);
    expect(attempt(tick, NIGHT_SKY_DARKENING, top)).toBeUndefined();

    const below = flatTestWorld(3);
    below.setBlock(bx, WORLD_MAX_Y - 1, bz, BlockType.Stone);
    expect(attempt(tick, NIGHT_SKY_DARKENING, below)?.position.y).toBe(WORLD_MAX_Y);
  });
});
