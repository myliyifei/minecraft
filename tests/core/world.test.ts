import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { plainsSurfaceHeight, plainsTerrain } from '../../src/core/terrain';
import { World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

describe('World 的区块加载', () => {
  it('新建的世界没有已加载区块，任何坐标都是空气', () => {
    const world = new World(flatTestTerrain);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
  });

  it('加载区块后该区块范围内可读到地形', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(true);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Grass);
    // 相邻区块仍未加载
    expect(world.getBlock(16, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });

  it('重复加载同一区块不会重新生成，已有修改保留', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);
    world.loadChunk(0, 0);
    expect(world.getBlock(1, FLAT_GROUND_Y, 1)).toBe(BlockType.Air);
    expect(world.loadedChunkCount).toBe(1);
  });

  it('卸载区块后坐标回到空气', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.unloadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });

  it('负坐标归属正确的区块', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(-1, -1);
    expect(world.getBlock(-1, FLAT_GROUND_Y, -1)).toBe(BlockType.Grass);
    expect(world.getBlock(-16, FLAT_GROUND_Y, -16)).toBe(BlockType.Grass);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });
});

describe('World 的写入结果', () => {
  it('写入已加载区块返回 true', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air)).toBe(true);
  });

  it('写入未加载区块返回 false', () => {
    const world = new World(flatTestTerrain);
    expect(world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air)).toBe(false);
  });

  it('世界高度之外的写入返回 false 且不改变世界', () => {
    const world = new World(flatTestTerrain);
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

describe('World 记下变过的方块', () => {
  /** 一个已加载区块的平地世界。 */
  function loadedWorld(): World {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    return world;
  }

  it('新建的世界没有变过的方块', () => {
    expect(loadedWorld().takeChangedBlocks()).toEqual([]);
  });

  it('挖掉一格之后记下它的方块坐标', () => {
    const world = loadedWorld();
    world.setBlock(3.7, FLAT_GROUND_Y, 4.2, BlockType.Air);
    // 坐标按 floor 取整，记的是格子而不是传进来的小数
    expect(world.takeChangedBlocks()).toEqual([{ x: 3, y: FLAT_GROUND_Y, z: 4 }]);
  });

  it('取走之后清空，同一次改动不会报两遍', () => {
    const world = loadedWorld();
    world.setBlock(3, FLAT_GROUND_Y, 4, BlockType.Air);
    expect(world.takeChangedBlocks()).toHaveLength(1);
    expect(world.takeChangedBlocks()).toEqual([]);
  });

  it('同一格改了几次只报一遍', () => {
    const world = loadedWorld();
    world.setBlock(3, FLAT_GROUND_Y, 4, BlockType.Air);
    world.setBlock(3, FLAT_GROUND_Y, 4, BlockType.Stone);
    expect(world.takeChangedBlocks()).toEqual([{ x: 3, y: FLAT_GROUND_Y, z: 4 }]);
  });

  it('写成原本就是的方块不算变过', () => {
    const world = loadedWorld();
    expect(world.setBlock(3, FLAT_GROUND_Y, 4, BlockType.Grass)).toBe(true);
    expect(world.takeChangedBlocks()).toEqual([]);
  });

  it('没落到世界里的写入不算变过', () => {
    const world = loadedWorld();
    // 区块未加载
    world.setBlock(1000, FLAT_GROUND_Y, 0, BlockType.Air);
    // y 越界
    world.setBlock(3, WORLD_MAX_Y + 1, 4, BlockType.Stone);
    expect(world.takeChangedBlocks()).toEqual([]);
  });
});

describe('区块索引', () => {
  it('相邻与远处的区块互不串台', () => {
    const world = new World(flatTestTerrain);
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
      world.setBlock(cx * 16, FLAT_GROUND_Y, cz * 16, BlockType.Air);
    }
    for (const [cx, cz] of spots) {
      expect(world.getBlock(cx * 16, FLAT_GROUND_Y, cz * 16)).toBe(BlockType.Air);
      expect(world.getBlock(cx * 16 + 1, FLAT_GROUND_Y, cz * 16 + 1)).toBe(BlockType.Grass);
    }
  });
});

describe('地形生成的确定性', () => {
  const SEED = 8_675_309;

  /** 一个区块的全部方块。用它比较两次生成的结果是否逐格一致。 */
  function sampleChunk(world: World, cx: number, cz: number): string {
    const parts: string[] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const x = cx * CHUNK_SIZE + lx;
        const z = cz * CHUNK_SIZE + lz;
        for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
          parts.push(String(world.getBlock(x, y, z)));
        }
      }
    }
    return parts.join(',');
  }

  it('加载顺序不影响结果：先 A 后 B 与先 B 后 A 得到相同的两个区块', () => {
    const a = new World(plainsTerrain(SEED));
    a.loadChunk(0, 0);
    a.loadChunk(1, 0);

    const b = new World(plainsTerrain(SEED));
    b.loadChunk(1, 0);
    b.loadChunk(0, 0);

    expect(sampleChunk(b, 0, 0)).toBe(sampleChunk(a, 0, 0));
    expect(sampleChunk(b, 1, 0)).toBe(sampleChunk(a, 1, 0));
  });

  it('卸载后重新加载得到相同地形', () => {
    const world = new World(plainsTerrain(SEED));
    world.loadChunk(2, 3);
    const before = sampleChunk(world, 2, 3);
    world.unloadChunk(2, 3);
    world.loadChunk(2, 3);
    expect(sampleChunk(world, 2, 3)).toBe(before);
  });

  it('只加载单个区块时，区块内的地表与高度场一致', () => {
    const world = new World(plainsTerrain(SEED));
    world.loadChunk(-2, 7);
    for (const [lx, lz] of [
      [0, 0],
      [7, 9],
      [15, 15],
    ] as Array<[number, number]>) {
      const x = -2 * CHUNK_SIZE + lx;
      const z = 7 * CHUNK_SIZE + lz;
      expect(world.highestBlockY(x, z)).toBe(plainsSurfaceHeight(SEED, x, z));
    }
  });
});
