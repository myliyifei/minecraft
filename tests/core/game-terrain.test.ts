import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import type { Terrain } from '../../src/core/terrain';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain } from '../helpers/flat-terrain';

/**
 * 核心只接一个地形对象（#73）：构造选项 `terrain` 由本世界的种子造出地形对象，区块由它的生成器给出，出生点站在
 * 它的出生列（`spawnColumn`）上（#84）。平地那一份的出生列是原点；换掉出生列的用例保证「核心读的是出生列，不是原点」这一点不丢失。
 *
 * 种子取 555：真实地形在原点那一列的地表是 y = 67，与平地（y = 70）不同。核心若还按真实地形生成区块，
 * 出生点与列顶的断言都会对不上。
 */
const SEED = 555;

describe('核心用传入的地形对象', () => {
  it('用平地那一份地形对象构造的核心，出生点在原点那一列平地之上', () => {
    const core = new GameCore({ seed: SEED, viewRadius: 1, terrain: flatTerrain });
    expect(core.spawnPoint).toEqual({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 });
    expect(core.player.position).toEqual({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 });
  });

  it('平地那一份地形对象换掉出生列：核心出生在那一列上，那一列所在的区块已加载', () => {
    // 出生列所在区块 (2, −2) 在原点视距 1 的范围之外：核心若还按原点加载、取出生点，这里不一致
    const core = new GameCore({
      seed: SEED,
      viewRadius: 1,
      terrain: (seed: number): Terrain => ({ ...flatTerrain(seed), spawnColumn: { x: 40, z: -24 } }),
    });
    expect(core.isChunkLoaded(2, -2)).toBe(true);
    expect(core.spawnPoint).toEqual({ x: 40.5, y: FLAT_STAND_Y, z: -23.5 });
    expect(core.player.position).toEqual({ x: 40.5, y: FLAT_STAND_Y, z: -23.5 });
  });

  it('区块由地形对象的生成器给出：已加载的范围里每一列都是平地', () => {
    const core = new GameCore({ seed: SEED, viewRadius: 1, terrain: flatTerrain });
    const tops = new Set<number>();
    for (let x = -CHUNK_SIZE; x < 2 * CHUNK_SIZE; x += 5) {
      for (let z = -CHUNK_SIZE; z < 2 * CHUNK_SIZE; z += 3) {
        tops.add(core.highestBlockY(x, z));
        expect(core.getBlock(x, FLAT_GROUND_Y, z)).toBe(BlockType.Grass);
      }
    }
    expect([...tops]).toEqual([FLAT_GROUND_Y]);
  });

  it('新建世界时把种子传给构造选项 terrain（由种子造出地形对象的函数），只调一次', () => {
    const seeds: number[] = [];
    const core = new GameCore({
      seed: 99,
      viewRadius: 0,
      terrain: (seed: number): Terrain => {
        seeds.push(seed);
        return { ...flatTerrain(seed), generateChunk: (cx: number, cz: number) => new Chunk(cx, cz) };
      },
    });
    expect(seeds).toEqual([99]);
    expect(core.getBlock(0, 0, 0)).toBe(BlockType.Air);
  });

  it('读档时构造选项 terrain 拿到的是快照里的种子，不看构造参数', () => {
    const before = new GameCore({ seed: 4321, viewRadius: 1, terrain: flatTerrain });
    const seeds: number[] = [];
    const restored = new GameCore({
      seed: 1,
      viewRadius: 1,
      restore: before.snapshot(),
      terrain: (seed: number) => {
        seeds.push(seed);
        return flatTerrain(seed);
      },
    });
    expect(seeds).toEqual([4321]);
    expect(restored.seed).toBe(4321);
  });

  it('地形对象的生成器当场给不出区块时，构造不报错，tick 之后补上', () => {
    // 浏览器里区块由 Worker 生成：核心拿到的地形对象，生成器换成了「可能还没准备好」的区块来源。
    let ready = false;
    const core = new GameCore({
      viewRadius: 1,
      terrain: (seed: number) => ({
        ...flatTerrain(seed),
        generateChunk: (cx: number, cz: number) => (ready ? flatTerrain(seed).generateChunk(cx, cz) : undefined),
      }),
    });
    expect(core.loadedChunkCount).toBe(0);

    ready = true;
    core.tick();
    expect(core.loadedChunkCount).toBe(9);
    expect(core.spawnPoint).toEqual({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 });
  });
});
