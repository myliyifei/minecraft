import { describe, expect, it } from 'vitest';
import { GameCore } from '../../src/core/game';
import { BlockType } from '../../src/core/block';
import {
  DIRT_DEPTH,
  FLAT_SURFACE_Y,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';

describe('GameCore 的 tick 推进', () => {
  it('新建的核心 tick 计数为 0', () => {
    expect(new GameCore().tickCount).toBe(0);
  });

  it('tick(n) 推进 n 步', () => {
    const core = new GameCore();
    core.tick(5);
    expect(core.tickCount).toBe(5);
    core.tick(3);
    expect(core.tickCount).toBe(8);
  });

  it('tick() 不带参数推进 1 步', () => {
    const core = new GameCore();
    core.tick();
    expect(core.tickCount).toBe(1);
  });

  it('tick(0) 与 tick(负数) 不推进', () => {
    const core = new GameCore();
    core.tick(0);
    core.tick(-3);
    expect(core.tickCount).toBe(0);
  });
});

describe('GameCore 在 Node 中的方块查询', () => {
  // 取几个跨区块、含负坐标的采样列，确认平地在任意位置形态一致。
  const columns: Array<[number, number]> = [
    [0, 0],
    [1, -1],
    [15, 15],
    [-17, 33],
    [31, -32],
  ];

  it('地表以上是空气', () => {
    const core = new GameCore();
    for (const [x, z] of columns) {
      expect(core.getBlock(x, FLAT_SURFACE_Y + 1, z)).toBe(BlockType.Air);
      expect(core.getBlock(x, FLAT_SURFACE_Y + 40, z)).toBe(BlockType.Air);
      expect(core.getBlock(x, WORLD_MAX_Y, z)).toBe(BlockType.Air);
    }
  });

  it('平地顶层是草方块', () => {
    const core = new GameCore();
    for (const [x, z] of columns) {
      expect(core.getBlock(x, FLAT_SURFACE_Y, z)).toBe(BlockType.Grass);
    }
  });

  it('草方块下方是泥土，再下方是石头', () => {
    const core = new GameCore();
    for (const [x, z] of columns) {
      for (let d = 1; d <= DIRT_DEPTH; d++) {
        expect(core.getBlock(x, FLAT_SURFACE_Y - d, z)).toBe(BlockType.Dirt);
      }
      expect(core.getBlock(x, FLAT_SURFACE_Y - DIRT_DEPTH - 1, z)).toBe(BlockType.Stone);
      expect(core.getBlock(x, 0, z)).toBe(BlockType.Stone);
      expect(core.getBlock(x, WORLD_MIN_Y + 1, z)).toBe(BlockType.Stone);
    }
  });

  it('世界底层 y = −64 是基岩', () => {
    const core = new GameCore();
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        expect(core.getBlock(x, WORLD_MIN_Y, z)).toBe(BlockType.Bedrock);
      }
    }
  });

  it('世界高度范围之外一律是空气', () => {
    const core = new GameCore();
    expect(core.getBlock(0, WORLD_MIN_Y - 1, 0)).toBe(BlockType.Air);
    expect(core.getBlock(0, WORLD_MAX_Y + 1, 0)).toBe(BlockType.Air);
    expect(core.getBlock(0, 10_000, 0)).toBe(BlockType.Air);
  });

  it('坐标按 floor 取整，小数落在同一格', () => {
    const core = new GameCore();
    expect(core.getBlock(0.9, FLAT_SURFACE_Y + 0.5, -0.1)).toBe(BlockType.Grass);
    expect(core.getBlock(-0.9, FLAT_SURFACE_Y, -0.9)).toBe(BlockType.Grass);
  });
});

describe('GameCore 的方块写入', () => {
  it('写入后能读回同一种方块', () => {
    const core = new GameCore();
    core.setBlock(3, FLAT_SURFACE_Y + 1, 4, BlockType.OakLog);
    expect(core.getBlock(3, FLAT_SURFACE_Y + 1, 4)).toBe(BlockType.OakLog);
  });

  it('可以把方块挖成空气', () => {
    const core = new GameCore();
    core.setBlock(3, FLAT_SURFACE_Y, 4, BlockType.Air);
    expect(core.getBlock(3, FLAT_SURFACE_Y, 4)).toBe(BlockType.Air);
  });

  it('写入未加载区块无效果，读回仍是空气', () => {
    const core = new GameCore({ viewRadius: 0 });
    const farX = 16 * 50;
    core.setBlock(farX, FLAT_SURFACE_Y + 1, 0, BlockType.Stone);
    expect(core.getBlock(farX, FLAT_SURFACE_Y + 1, 0)).toBe(BlockType.Air);
  });
});

describe('GameCore 的出生点', () => {
  it('出生点在平地地表之上，脚下是实心方块、所在位置是空气', () => {
    const core = new GameCore();
    const spawn = core.spawnPoint;
    expect(spawn.y).toBe(FLAT_SURFACE_Y + 1);
    expect(core.getBlock(spawn.x, spawn.y - 1, spawn.z)).toBe(BlockType.Grass);
    expect(core.getBlock(spawn.x, spawn.y, spawn.z)).toBe(BlockType.Air);
    expect(core.getBlock(spawn.x, spawn.y + 1, spawn.z)).toBe(BlockType.Air);
  });

  it('出生点落在方块中心', () => {
    const spawn = new GameCore().spawnPoint;
    expect(spawn.x).toBe(0.5);
    expect(spawn.z).toBe(0.5);
  });
});

describe('GameCore 的初始区块加载', () => {
  it('构造后已加载区块数大于 0', () => {
    expect(new GameCore().loadedChunkCount).toBeGreaterThan(0);
  });

  it('视距半径决定加载的区块数：半径 r 加载 (2r+1)² 个', () => {
    expect(new GameCore({ viewRadius: 0 }).loadedChunkCount).toBe(1);
    expect(new GameCore({ viewRadius: 1 }).loadedChunkCount).toBe(9);
    expect(new GameCore({ viewRadius: 2 }).loadedChunkCount).toBe(25);
  });

  it('已加载区块坐标可枚举，且围绕原点区块', () => {
    const core = new GameCore({ viewRadius: 1 });
    const keys = core.loadedChunks().map(({ cx, cz }) => `${cx},${cz}`);
    expect(keys).toContain('0,0');
    expect(keys).toContain('-1,-1');
    expect(keys).toContain('1,1');
    expect(keys).toHaveLength(9);
  });
});
