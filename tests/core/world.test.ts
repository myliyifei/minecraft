import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { FLAT_SURFACE_Y, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { flatTerrain } from '../../src/core/terrain';
import { World } from '../../src/core/world';

describe('World 的区块加载', () => {
  it('新建的世界没有已加载区块，任何坐标都是空气', () => {
    const world = new World(flatTerrain);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_SURFACE_Y, 0)).toBe(BlockType.Air);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
  });

  it('加载区块后该区块范围内可读到地形', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(true);
    expect(world.getBlock(0, FLAT_SURFACE_Y, 0)).toBe(BlockType.Grass);
    // 相邻区块仍未加载
    expect(world.getBlock(16, FLAT_SURFACE_Y, 0)).toBe(BlockType.Air);
  });

  it('重复加载同一区块不会重新生成，已有修改保留', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_SURFACE_Y, 1, BlockType.Air);
    world.loadChunk(0, 0);
    expect(world.getBlock(1, FLAT_SURFACE_Y, 1)).toBe(BlockType.Air);
    expect(world.loadedChunkCount).toBe(1);
  });

  it('卸载区块后坐标回到空气', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    world.unloadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_SURFACE_Y, 0)).toBe(BlockType.Air);
  });

  it('负坐标归属正确的区块', () => {
    const world = new World(flatTerrain);
    world.loadChunk(-1, -1);
    expect(world.getBlock(-1, FLAT_SURFACE_Y, -1)).toBe(BlockType.Grass);
    expect(world.getBlock(-16, FLAT_SURFACE_Y, -16)).toBe(BlockType.Grass);
    expect(world.getBlock(0, FLAT_SURFACE_Y, 0)).toBe(BlockType.Air);
  });
});

describe('World 的写入结果', () => {
  it('写入已加载区块返回 true', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    expect(world.setBlock(0, FLAT_SURFACE_Y, 0, BlockType.Air)).toBe(true);
  });

  it('写入未加载区块返回 false', () => {
    const world = new World(flatTerrain);
    expect(world.setBlock(0, FLAT_SURFACE_Y, 0, BlockType.Air)).toBe(false);
  });

  it('世界高度之外的写入返回 false 且不改变世界', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    expect(world.setBlock(0, WORLD_MAX_Y + 1, 0, BlockType.Stone)).toBe(false);
    expect(world.setBlock(0, WORLD_MIN_Y - 1, 0, BlockType.Stone)).toBe(false);
    expect(world.getBlock(0, WORLD_MAX_Y + 1, 0)).toBe(BlockType.Air);
    expect(world.getBlock(0, WORLD_MIN_Y - 1, 0)).toBe(BlockType.Air);
    // 边界上仍然可写
    expect(world.setBlock(0, WORLD_MAX_Y, 0, BlockType.Stone)).toBe(true);
    expect(world.getBlock(0, WORLD_MAX_Y, 0)).toBe(BlockType.Stone);
  });
});

describe('区块索引', () => {
  it('相邻与远处的区块互不串台', () => {
    const world = new World(flatTerrain);
    const spots: Array<[number, number]> = [
      [0, 0],
      [-1, 0],
      [0, -1],
      [1, 1],
      [1000, -1000],
      [-33_000, 33_000],
    ];
    for (const [cx, cz] of spots) world.loadChunk(cx, cz);
    expect(world.loadedChunkCount).toBe(spots.length);

    // 每个区块挖掉自己的一格，不应影响别的区块
    for (const [cx, cz] of spots) {
      world.setBlock(cx * 16, FLAT_SURFACE_Y, cz * 16, BlockType.Air);
    }
    for (const [cx, cz] of spots) {
      expect(world.getBlock(cx * 16, FLAT_SURFACE_Y, cz * 16)).toBe(BlockType.Air);
      expect(world.getBlock(cx * 16 + 1, FLAT_SURFACE_Y, cz * 16 + 1)).toBe(
        BlockType.Grass,
      );
    }
  });
});

describe('地形生成的确定性', () => {
  it('加载顺序不影响结果', () => {
    const a = new World(flatTerrain);
    a.loadChunk(0, 0);
    a.loadChunk(1, 0);

    const b = new World(flatTerrain);
    b.loadChunk(1, 0);
    b.loadChunk(0, 0);

    for (let x = 0; x < 32; x++) {
      for (const y of [FLAT_SURFACE_Y + 1, FLAT_SURFACE_Y, FLAT_SURFACE_Y - 1, 0, -64]) {
        expect(b.getBlock(x, y, 5)).toBe(a.getBlock(x, y, 5));
      }
    }
  });

  it('卸载后重新加载得到相同地形', () => {
    const world = new World(flatTerrain);
    world.loadChunk(2, 3);
    const before = world.getBlock(33, FLAT_SURFACE_Y, 50);
    world.unloadChunk(2, 3);
    world.loadChunk(2, 3);
    expect(world.getBlock(33, FLAT_SURFACE_Y, 50)).toBe(before);
  });
});
