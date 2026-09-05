import { describe, expect, it } from 'vitest';
import { GameCore } from '../../src/core/game';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
  TICK_RATE,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';
import { IDLE_INTENT } from '../../src/core/player';
import {
  DIRT_DEPTH_MAX,
  DIRT_DEPTH_MIN,
  plainsSurfaceHeight,
} from '../../src/core/terrain';
import { flatTestTerrain } from '../helpers/flat-terrain';

/** 默认视距下已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -DEFAULT_VIEW_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (DEFAULT_VIEW_RADIUS + 1) * CHUNK_SIZE - 1;

/** 默认种子下某一列的地表高度。 */
function surfaceAt(x: number, z: number): number {
  return plainsSurfaceHeight(DEFAULT_SEED, x, z);
}

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

describe('GameCore 的种子', () => {
  it('不指定种子时用默认种子', () => {
    expect(new GameCore().seed).toBe(DEFAULT_SEED);
  });

  it('记住构造时传入的种子', () => {
    expect(new GameCore({ seed: 123 }).seed).toBe(123);
  });

  it('同一种子两次进入世界，同一坐标得到相同方块', () => {
    const a = new GameCore({ seed: 4321 });
    const b = new GameCore({ seed: 4321 });
    const differing: string[] = [];
    for (let x = LOADED_MIN; x <= LOADED_MAX; x += 5) {
      for (let z = LOADED_MIN; z <= LOADED_MAX; z += 5) {
        for (let y = WORLD_MIN_Y; y <= 90; y += 7) {
          if (a.getBlock(x, y, z) !== b.getBlock(x, y, z)) differing.push(`(${x}, ${y}, ${z})`);
        }
      }
    }
    expect(differing).toEqual([]);
  });

  it('不同种子得到不同的地形', () => {
    const a = new GameCore({ seed: 1 });
    const b = new GameCore({ seed: 2 });
    let differing = 0;
    for (let x = LOADED_MIN; x <= LOADED_MAX; x++) {
      if (a.highestBlockY(x, 0) !== b.highestBlockY(x, 0)) differing++;
    }
    expect(differing).toBeGreaterThan(10);
  });

  it('可以换掉地形算法，种子仍然传给它', () => {
    const seeds: number[] = [];
    const core = new GameCore({
      seed: 99,
      viewRadius: 0,
      terrain: (seed) => {
        seeds.push(seed);
        return (cx, cz) => new Chunk(cx, cz);
      },
    });
    expect(seeds).toEqual([99]);
    expect(core.getBlock(0, 0, 0)).toBe(BlockType.Air);
  });
});

describe('GameCore 在 Node 中的方块查询', () => {
  // 取几个跨区块、含负坐标的采样列，确认地形在任意位置形态一致。
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
      const surface = surfaceAt(x, z);
      expect(core.getBlock(x, surface + 1, z)).toBe(BlockType.Air);
      expect(core.getBlock(x, surface + 40, z)).toBe(BlockType.Air);
      expect(core.getBlock(x, WORLD_MAX_Y, z)).toBe(BlockType.Air);
    }
  });

  it('地表那一层是草方块', () => {
    const core = new GameCore();
    for (const [x, z] of columns) {
      expect(core.getBlock(x, surfaceAt(x, z), z)).toBe(BlockType.Grass);
    }
  });

  it('草方块下方是 3–4 层泥土，再下方是石头', () => {
    const core = new GameCore();
    for (const [x, z] of columns) {
      const surface = surfaceAt(x, z);
      let dirt = 0;
      while (core.getBlock(x, surface - dirt - 1, z) === BlockType.Dirt) dirt++;
      expect(dirt).toBeGreaterThanOrEqual(DIRT_DEPTH_MIN);
      expect(dirt).toBeLessThanOrEqual(DIRT_DEPTH_MAX);
      expect(core.getBlock(x, surface - dirt - 1, z)).toBe(BlockType.Stone);
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
    const surface = surfaceAt(0, 0);
    expect(core.getBlock(0.9, surface + 0.5, -0.1)).toBe(BlockType.Grass);
    expect(core.getBlock(0.9, surface, 0.9)).toBe(BlockType.Grass);
  });
});

describe('GameCore 的地形形态', () => {
  it('已加载范围内每一列的地表都高于海平面', () => {
    const core = new GameCore();
    const tooLow: string[] = [];
    for (let x = LOADED_MIN; x <= LOADED_MAX; x++) {
      for (let z = LOADED_MIN; z <= LOADED_MAX; z++) {
        if (core.highestBlockY(x, z) <= SEA_LEVEL) tooLow.push(`(${x}, ${z})`);
      }
    }
    expect(tooLow).toEqual([]);
  });

  it('地形有起伏，不是一片同高的平地', () => {
    const core = new GameCore();
    const heights = new Set<number>();
    for (let x = LOADED_MIN; x <= LOADED_MAX; x++) heights.add(core.highestBlockY(x, 0));
    expect(heights.size).toBeGreaterThan(1);
  });

  it('highestBlockY 就是那一列草方块的高度', () => {
    const core = new GameCore();
    for (const [x, z] of [
      [0, 0],
      [-9, 21],
      [40, -20],
    ] as Array<[number, number]>) {
      expect(core.highestBlockY(x, z)).toBe(surfaceAt(x, z));
    }
  });

  it('未加载区块的列没有最高方块', () => {
    const core = new GameCore({ viewRadius: 0 });
    expect(core.highestBlockY(16 * 50, 0)).toBe(WORLD_MIN_Y - 1);
  });
});

describe('GameCore 的方块写入', () => {
  it('写入后能读回同一种方块', () => {
    const core = new GameCore();
    core.setBlock(3, surfaceAt(3, 4) + 1, 4, BlockType.OakLog);
    expect(core.getBlock(3, surfaceAt(3, 4) + 1, 4)).toBe(BlockType.OakLog);
  });

  it('可以把方块挖成空气', () => {
    const core = new GameCore();
    const y = surfaceAt(3, 4);
    core.setBlock(3, y, 4, BlockType.Air);
    expect(core.getBlock(3, y, 4)).toBe(BlockType.Air);
  });

  it('写入未加载区块无效果，读回仍是空气', () => {
    const core = new GameCore({ viewRadius: 0 });
    const farX = 16 * 50;
    core.setBlock(farX, 100, 0, BlockType.Stone);
    expect(core.getBlock(farX, 100, 0)).toBe(BlockType.Air);
  });
});

describe('GameCore 的出生点', () => {
  it('出生点在地表之上，脚下是实心方块、脚位与头位是空气', () => {
    const core = new GameCore();
    const spawn = core.spawnPoint;
    expect(spawn.y).toBe(surfaceAt(0, 0) + 1);
    expect(core.getBlock(spawn.x, spawn.y - 1, spawn.z)).toBe(BlockType.Grass);
    expect(core.getBlock(spawn.x, spawn.y, spawn.z)).toBe(BlockType.Air);
    expect(core.getBlock(spawn.x, spawn.y + 1, spawn.z)).toBe(BlockType.Air);
  });

  it('出生点落在方块中心', () => {
    const spawn = new GameCore().spawnPoint;
    expect(spawn.x).toBe(0.5);
    expect(spawn.z).toBe(0.5);
  });

  it('换种子后出生点跟着地形走', () => {
    const core = new GameCore({ seed: 555 });
    expect(core.spawnPoint.y).toBe(plainsSurfaceHeight(555, 0, 0) + 1);
  });
});

describe('GameCore 的玩家', () => {
  /** 固定平地上的核心：移动断言要的是可预测的地面，不是真实地形的起伏。 */
  function coreOnFlatGround(): GameCore {
    return new GameCore({ terrain: () => flatTestTerrain });
  }

  it('新建世界后玩家位于出生点', () => {
    const core = new GameCore();
    expect(core.player.position).toEqual(core.spawnPoint);
    expect(core.player.onGround).toBe(true);
  });

  it('没有输入时 tick 多少次玩家都站着不动', () => {
    const core = new GameCore();
    core.tick(100);
    expect(core.player.position).toEqual(core.spawnPoint);
  });

  it('设定移动意图后，tick 让玩家走起来', () => {
    const core = coreOnFlatGround();
    const before = core.player.position;
    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    core.tick(TICK_RATE);
    expect(core.player.position.z).toBeLessThan(before.z);
    expect(core.player.position.x).toBeCloseTo(before.x, 10);
  });

  it('意图收回后玩家立刻停下，没有惯性', () => {
    const core = coreOnFlatGround();
    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    core.tick(TICK_RATE);
    const stopped = core.player.position;
    core.setMoveIntent(IDLE_INTENT);
    core.tick(TICK_RATE);
    expect(core.player.position).toEqual(stopped);
  });

  it('转动视角不等 tick，鼠标一动就生效', () => {
    const core = new GameCore();
    core.turn(0.5, -0.2);
    expect(core.player.yaw).toBeCloseTo(0.5, 10);
    expect(core.player.pitch).toBeCloseTo(-0.2, 10);
    expect(core.tickCount).toBe(0);
  });

  it('上一个 tick 的位置留给渲染层插值', () => {
    const core = coreOnFlatGround();
    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    const spawn = core.player.position;
    core.tick();
    expect(core.player.previousPosition).toEqual(spawn);
    expect(core.player.position).not.toEqual(spawn);
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
