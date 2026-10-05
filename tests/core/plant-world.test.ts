import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { NIGHT_SKY_DARKENING, NIGHT_START } from '../../src/core/time-of-day';
import type { Vec3 } from '../../src/core/vec3';
import { ZOMBIE_SPAWN_INTERVAL, Zombies, type ZombieView } from '../../src/core/zombie';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain, flatTestWorld } from '../helpers/flat-terrain';
import { DANDELION, FERN, PLANTS, POPPY, SHORT_GRASS, expectPlantsDefined } from '../helpers/plants';

/**
 * 地表植物与世界的其余规则（#80）：生成僵尸判断列顶时只跳过地表植物、植物那格的天光与上一格相同。
 * 平地：草方块在 y 70，站在它上面脚底是 y 71。
 */

const G = FLAT_GROUND_Y;
const S = FLAT_STAND_Y;
const SEED = 1234;

describe('生成僵尸：列顶只跳过地表植物', () => {
  /** 视距 3 的平地核心：24 到 48 格的整个圆环都已加载。 */
  function core(): GameCore {
    return new GameCore({ seed: SEED, viewRadius: 3, terrain: flatTerrain });
  }

  /** 把 24 到 48 格的整个圆环（外加玩家周围 16 格以外的方形四角）的草方块上都长满 plants 里轮流的一种。 */
  function meadow(game: GameCore, plants: readonly BlockType[]): GameCore {
    for (let x = -48; x <= 48; x++) {
      for (let z = -48; z <= 48; z++) {
        if (Math.hypot(x, z) < 16) continue;
        const plant = plants[(((x + z) % plants.length) + plants.length) % plants.length]!;
        expect(game.setBlock(x, S, z, plant)).toBe(true);
      }
    }
    return game;
  }

  /** 推进 ticks 个 tick，记下新出现的僵尸的位置。 */
  function spawnsOver(game: GameCore, ticks: number): Vec3[] {
    const seen = new Set(game.zombies.all().map((zombie) => zombie.id));
    const spawned: Vec3[] = [];
    for (let n = 0; n < ticks; n++) {
      game.tick();
      for (const zombie of game.zombies.all()) {
        if (seen.has(zombie.id)) continue;
        seen.add(zombie.id);
        spawned.push(zombie.position);
      }
    }
    return spawned;
  }

  it('夜晚长满矮草的平地：2000 tick 内照样生成，每只生成在草方块顶面上（矮草那一格里）', () => {
    expectPlantsDefined();
    const game = meadow(core(), [SHORT_GRASS]);
    expect(game.getBlock(30, S, 0)).toBe(SHORT_GRASS);
    expect(game.highestBlockY(30, 0)).toBe(S);
    game.setTimeOfDay(NIGHT_START);
    const spawned = spawnsOver(game, 2000);
    expect(spawned.length).toBeGreaterThan(0);
    for (const position of spawned) {
      expect(position.y).toBe(S);
      expect(game.getBlock(Math.floor(position.x), G, Math.floor(position.z))).toBe(BlockType.Grass);
    }
  });

  it('四种植物混着长满：生成的位置与 tick 与光秃秃的平地逐一相同', () => {
    expectPlantsDefined();
    const bare = core();
    bare.setTimeOfDay(NIGHT_START);
    const expected = spawnsOver(bare, 1000);
    expect(expected.length).toBeGreaterThan(0);

    const grown = meadow(core(), [SHORT_GRASS, FERN, DANDELION, POPPY]);
    grown.setTimeOfDay(NIGHT_START);
    expect(spawnsOver(grown, 1000)).toEqual(expected);
  });

  describe('候选列（Zombies.spawnNaturally）', () => {
    const player: Vec3 = { x: 0.5, y: S, z: 0.5 };
    const sinks = [{ spawnInBlock: () => {} }, { spawnInBlock: () => {} }] as const;

    function attempt(blocks: ReturnType<typeof flatTestWorld>, tick = ZOMBIE_SPAWN_INTERVAL): ZombieView | undefined {
      const zombies = new Zombies(blocks, SEED, ...sinks, Difficulty.Normal);
      zombies.spawnNaturally(tick, player, NIGHT_SKY_DARKENING);
      return zombies.all()[0];
    }

    it.each(PLANTS)('候选列的列顶长着%s：照常生成，位置与没有植物时相同', (_name, plant) => {
      expectPlantsDefined();
      const plain = attempt(flatTestWorld(3))!;
      expect(plain).toBeDefined();
      const [bx, bz] = [Math.floor(plain.position.x), Math.floor(plain.position.z)];

      const grown = flatTestWorld(3);
      grown.setBlock(bx, S, bz, plant);
      expect(grown.getBlock(bx, S, bz)).toBe(plant);
      expect(attempt(grown)?.position).toEqual(plain.position);
    });

    it('只跳过植物，不跳过水：列顶是水的列仍不生成，水底长不出僵尸', () => {
      const plain = attempt(flatTestWorld(3))!;
      const [bx, bz] = [Math.floor(plain.position.x), Math.floor(plain.position.z)];
      for (const depth of [1, 2]) {
        const pool = flatTestWorld(3);
        for (let d = 0; d < depth; d++) pool.setBlock(bx, S + d, bz, BlockType.Water);
        expect(attempt(pool), `${depth} 格水`).toBeUndefined();
      }
    });
  });
});

describe('植物那一格的天光与上一格相同', () => {
  it.each(PLANTS)('露天的%s那一格天光 15；叠在两层树叶下面时与它上面那一格相同', (_name, plant) => {
    expectPlantsDefined();
    const world = flatTestWorld();
    world.setBlock(3, S, 4, plant);
    expect(world.getBlock(3, S, 4)).toBe(plant);
    expect(world.skyLightAt(3, S, 4)).toBe(15);

    world.setBlock(5, S + 1, 4, BlockType.OakLeaves);
    world.setBlock(5, S + 2, 4, BlockType.OakLeaves);
    world.setBlock(5, S, 4, plant);
    const above = world.skyLightAt(5, S + 1, 4);
    expect(above).toBeLessThan(15);
    expect(world.skyLightAt(5, S, 4)).toBe(above);
  });

  it('屋顶下的植物：植物那一格的天光与它上面那一格相同，植物下面的草方块是 0', () => {
    expectPlantsDefined();
    // 地面以上隔两格整层铺石头，只在 (8, 8) 留一个洞；植物在离洞 3 格处
    const world = flatTestWorld();
    for (let x = -16; x < 32; x++) {
      for (let z = -16; z < 32; z++) world.setBlock(x, G + 3, z, x === 8 && z === 8 ? BlockType.Air : BlockType.Stone);
    }
    world.setBlock(11, S, 8, FERN);
    const above = world.skyLightAt(11, S + 1, 8);
    expect(above).toBeGreaterThan(0);
    expect(above).toBeLessThan(15);
    expect(world.skyLightAt(11, S, 8)).toBe(above);
    expect(world.skyLightAt(11, G, 8)).toBe(0);
  });

  it('植物不发光：植物那一格与周围的方块光都是 0', () => {
    expectPlantsDefined();
    const world = flatTestWorld();
    for (const [, plant] of PLANTS) world.setBlock(3, S, 4, plant);
    expect(world.blockLightAt(3, S, 4)).toBe(0);
    expect(world.blockLightAt(4, S, 4)).toBe(0);
  });
});
