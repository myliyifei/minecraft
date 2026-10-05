import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Biome } from '../../src/core/biome';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import { PLANT_SPAWN_CLEARANCE, plantSurfacePlants } from '../../src/core/plant';
import { chunkOf } from '../../src/core/world';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain } from '../helpers/flat-terrain';
import { DANDELION, SHORT_GRASS, expectPlantsDefined, isPlantBlock } from '../helpers/plants';

/**
 * 地表植物的两条补充规则（#80，开发补的用例）：
 * - 支撑撑不住的条件是「下面那格不再实心」，不只是「不再不透明」：长在树叶或冰上的植物，树叶挖成空气、冰挖成水时也碎。
 * - 生成避开的是地形对象给的出生列，不是原点：真实地形的三个调查种子出生列都在原点，分不出这两种写法，这里直接给一份
 *   出生列在别处的放植物参数。
 */

const S = FLAT_STAND_Y;

describe('下面那格不再实心，植物随之碎掉', () => {
  it.each([
    ['橡树叶挖成空气', BlockType.OakLeaves, BlockType.Air],
    ['冰挖成水', BlockType.Ice, BlockType.Water],
  ] as const)('%s：上面的花掉 1 个花物品、矮草消失', (_name, support, after) => {
    expectPlantsDefined();
    const game = new GameCore({ viewRadius: 2, terrain: flatTerrain });
    game.setBlock(3, S, 0, support);
    game.setBlock(3, S + 1, 0, DANDELION);
    game.setBlock(5, S, 0, support);
    game.setBlock(5, S + 1, 0, SHORT_GRASS);
    game.setBlock(3, S, 0, after);
    game.setBlock(5, S, 0, after);
    expect(game.getBlock(3, S + 1, 0)).toBe(BlockType.Air);
    expect(game.getBlock(5, S + 1, 0)).toBe(BlockType.Air);
    expect(game.drops.all().map(({ count, item }) => ({ count, item }))).toHaveLength(1);
  });

  it('下面那格从草方块换成另一种实心方块（石头）：植物不动', () => {
    expectPlantsDefined();
    const game = new GameCore({ viewRadius: 2, terrain: flatTerrain });
    game.setBlock(3, S, 0, DANDELION);
    game.setBlock(3, FLAT_GROUND_Y, 0, BlockType.Stone);
    expect(game.getBlock(3, S, 0)).toBe(DANDELION);
    expect(game.drops.count).toBe(0);
  });
});

describe('生成避开地形对象给的出生列', () => {
  const SPAWN = { x: 200, z: -120 };

  /** 平原平地上 cx、cz 那个区块：草方块铺在 FLAT_GROUND_Y，按出生列在 spawn 放植物。 */
  function plainsChunk(cx: number, cz: number, spawn: { x: number; z: number }): Chunk {
    const chunk = new Chunk(cx, cz);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) chunk.set(lx, FLAT_GROUND_Y, lz, BlockType.Grass);
    }
    plantSurfacePlants(
      { seed: 314_159, spawnColumn: spawn, biomeAt: () => Biome.Plains, surfaceHeightAt: () => FLAT_GROUND_Y },
      chunk,
    );
    return chunk;
  }

  /** 出生列周围 radius 格内（切比雪夫距离）按距离分的植物格数。 */
  function plantsByDistance(spawn: { x: number; z: number }, center: { x: number; z: number }, radius: number): number[] {
    const counts = new Array<number>(radius + 1).fill(0);
    for (let cz = chunkOf(center.z - radius); cz <= chunkOf(center.z + radius); cz++) {
      for (let cx = chunkOf(center.x - radius); cx <= chunkOf(center.x + radius); cx++) {
        const chunk = plainsChunk(cx, cz, spawn);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const d = Math.max(Math.abs(cx * CHUNK_SIZE + lx - center.x), Math.abs(cz * CHUNK_SIZE + lz - center.z));
            if (d <= radius && isPlantBlock(chunk.get(lx, FLAT_GROUND_Y + 1, lz))) counts[d]!++;
          }
        }
      }
    }
    return counts;
  }

  it('出生列周围 7 格内一株都没有，8 到 16 格有', () => {
    expectPlantsDefined();
    const counts = plantsByDistance(SPAWN, SPAWN, 16);
    expect(counts.slice(0, PLANT_SPAWN_CLEARANCE + 1)).toEqual(new Array(PLANT_SPAWN_CLEARANCE + 1).fill(0));
    expect(counts.slice(PLANT_SPAWN_CLEARANCE + 1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('原点不是出生列时原点周围照常长', () => {
    expectPlantsDefined();
    const counts = plantsByDistance(SPAWN, { x: 0, z: 0 }, PLANT_SPAWN_CLEARANCE);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
