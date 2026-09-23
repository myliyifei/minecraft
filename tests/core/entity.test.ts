import { describe, expect, it } from 'vitest';
import { isBoxInLoadedChunks, isInLoadedChunk } from '../../src/core/entity';
import { World } from '../../src/core/world';
import { flatTestTerrain } from '../helpers/flat-terrain';

describe('实体所在区块是否已加载', () => {
  /** 只加载了 (−1, 0) 那一个区块的世界：x 在 [−16, 0)、z 在 [0, 16) 之内。 */
  function onlyChunkWestOfOrigin(): World {
    const world = new World(flatTestTerrain);
    world.loadChunk(-1, 0);
    return world;
  }

  it('按位置所在的区块判定：小数坐标向下取整，负坐标落在西边那个区块', () => {
    const world = onlyChunkWestOfOrigin();
    // 离区块边界只差半格，截断取整会把它算到 (0, 0) 里去
    expect(isInLoadedChunk(world, { x: -0.5, y: 80, z: 3.5 })).toBe(true);
    expect(isInLoadedChunk(world, { x: 0.5, y: 80, z: 3.5 })).toBe(false);
    expect(isInLoadedChunk(world, { x: -16.5, y: 80, z: 3.5 })).toBe(false);
    expect(isInLoadedChunk(world, { x: -0.5, y: 80, z: -0.5 })).toBe(false);
  });

  it('只看水平坐标：同一列上高处低处都算在那个区块里', () => {
    const world = onlyChunkWestOfOrigin();
    expect(isInLoadedChunk(world, { x: -8, y: 1000, z: 8 })).toBe(true);
    expect(isInLoadedChunk(world, { x: -8, y: -1000, z: 8 })).toBe(true);
  });

  it('区块卸载之后不再算已加载', () => {
    const world = onlyChunkWestOfOrigin();
    world.unloadChunk(-1, 0);
    expect(isInLoadedChunk(world, { x: -8, y: 80, z: 8 })).toBe(false);
  });
});

describe('碰撞箱涉及的区块是否都已加载', () => {
  /** 横跨 x = 0 那条区块边界的一个小碰撞箱：西半在 (−1, 0)，东半在 (0, 0)。 */
  const ACROSS_BORDER = { min: { x: -0.2, y: 80, z: 3 }, max: { x: 0.2, y: 80.5, z: 3.4 } };

  it('横跨区块边界时两边都加载才算', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(-1, 0);
    expect(isBoxInLoadedChunks(world, ACROSS_BORDER)).toBe(false);
    world.loadChunk(0, 0);
    expect(isBoxInLoadedChunks(world, ACROSS_BORDER)).toBe(true);
  });

  it('整个落在一个区块里时只看那一个', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    const inside = { min: { x: 3, y: 80, z: 3 }, max: { x: 3.25, y: 80.25, z: 3.25 } };
    expect(isBoxInLoadedChunks(world, inside)).toBe(true);
  });
});
