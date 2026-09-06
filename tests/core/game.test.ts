import { describe, expect, it } from 'vitest';
import { GameCore, type GameCoreOptions } from '../../src/core/game';
import { BlockType, miningTicks } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  DEFAULT_VIEW_RADIUS,
  SEA_LEVEL,
  TICK_RATE,
  UNLOAD_MARGIN,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';
import { IDLE_INTENT, MAX_PITCH, WALK_SPEED, WALK_STEP } from '../../src/core/player';
import {
  DIRT_DEPTH_MAX,
  DIRT_DEPTH_MIN,
  plainsSurfaceHeight,
  plainsTreePlacement,
} from '../../src/core/terrain';
import { oakTreesTouching } from '../../src/core/tree';
import { ABOVE_SURFACE } from '../helpers/above-surface';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/**
 * 采样用的视距（区块数）。
 * 地形形态与方块查询的断言只需要原点周围一小片；按默认视距 8 建一个核心要生成
 * 289 个区块（实测 105ms），这一节几十个核心加起来就是好几秒。视距本身的断言在
 * 「初始区块加载」那一节里，用的是真正的默认值。
 */
const SAMPLE_RADIUS = 2;

/** 采样用的核心：视距收小，其余按默认。 */
function sampleCore(options: GameCoreOptions = {}): GameCore {
  return new GameCore({ viewRadius: SAMPLE_RADIUS, ...options });
}

/** 固定平地上的核心：移动与瞄准的断言要的是可预测的地面，不是真实地形的起伏。 */
function coreOnFlatGround(): GameCore {
  return sampleCore({ chunkSource: () => flatTestTerrain });
}

/** 采样核心的已加载区块覆盖的世界坐标区间。 */
const LOADED_MIN = -SAMPLE_RADIUS * CHUNK_SIZE;
const LOADED_MAX = (SAMPLE_RADIUS + 1) * CHUNK_SIZE - 1;

/** 默认种子下某一列的地表高度。 */
function surfaceAt(x: number, z: number): number {
  return plainsSurfaceHeight(DEFAULT_SEED, x, z);
}

describe('GameCore 的 tick 推进', () => {
  it('新建的核心 tick 计数为 0', () => {
    expect(sampleCore().tickCount).toBe(0);
  });

  it('tick(n) 推进 n 步', () => {
    const core = sampleCore();
    core.tick(5);
    expect(core.tickCount).toBe(5);
    core.tick(3);
    expect(core.tickCount).toBe(8);
  });

  it('tick() 不带参数推进 1 步', () => {
    const core = sampleCore();
    core.tick();
    expect(core.tickCount).toBe(1);
  });

  it('tick(0) 与 tick(负数) 不推进', () => {
    const core = sampleCore();
    core.tick(0);
    core.tick(-3);
    expect(core.tickCount).toBe(0);
  });
});

describe('GameCore 的种子', () => {
  it('不指定种子时用默认种子', () => {
    expect(sampleCore().seed).toBe(DEFAULT_SEED);
  });

  it('记住构造时传入的种子', () => {
    expect(sampleCore({ seed: 123 }).seed).toBe(123);
  });

  it('同一种子两次进入世界，同一坐标得到相同方块', () => {
    const a = sampleCore({ seed: 4321 });
    const b = sampleCore({ seed: 4321 });
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
    const a = sampleCore({ seed: 1 });
    const b = sampleCore({ seed: 2 });
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
      chunkSource: (seed: number) => {
        seeds.push(seed);
        return (cx: number, cz: number) => new Chunk(cx, cz);
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

  it('地表以上只有空气与树，树顶之上什么都没有', () => {
    const core = sampleCore();
    for (const [x, z] of columns) {
      const surface = surfaceAt(x, z);
      expect(ABOVE_SURFACE.has(core.getBlock(x, surface + 1, z))).toBe(true);
      // 最高的树也就地表往上十来格，40 格之外一定出了树冠
      expect(core.getBlock(x, surface + 40, z)).toBe(BlockType.Air);
      expect(core.getBlock(x, WORLD_MAX_Y, z)).toBe(BlockType.Air);
    }
  });

  it('地表那一层是草方块', () => {
    const core = sampleCore();
    for (const [x, z] of columns) {
      expect(core.getBlock(x, surfaceAt(x, z), z)).toBe(BlockType.Grass);
    }
  });

  it('草方块下方是 3–4 层泥土，再下方是石头', () => {
    const core = sampleCore();
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
    const core = sampleCore();
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        expect(core.getBlock(x, WORLD_MIN_Y, z)).toBe(BlockType.Bedrock);
      }
    }
  });

  it('世界高度范围之外一律是空气', () => {
    const core = sampleCore();
    expect(core.getBlock(0, WORLD_MIN_Y - 1, 0)).toBe(BlockType.Air);
    expect(core.getBlock(0, WORLD_MAX_Y + 1, 0)).toBe(BlockType.Air);
    expect(core.getBlock(0, 10_000, 0)).toBe(BlockType.Air);
  });

  it('坐标按 floor 取整，小数落在同一格', () => {
    const core = sampleCore();
    const surface = surfaceAt(0, 0);
    expect(core.getBlock(0.9, surface + 0.5, -0.1)).toBe(BlockType.Grass);
    expect(core.getBlock(0.9, surface, 0.9)).toBe(BlockType.Grass);
  });
});

describe('GameCore 的地形形态', () => {
  it('已加载范围内每一列的地表都高于海平面', () => {
    const core = sampleCore();
    const tooLow: string[] = [];
    for (let x = LOADED_MIN; x <= LOADED_MAX; x++) {
      for (let z = LOADED_MIN; z <= LOADED_MAX; z++) {
        if (core.highestBlockY(x, z) <= SEA_LEVEL) tooLow.push(`(${x}, ${z})`);
      }
    }
    expect(tooLow).toEqual([]);
  });

  it('地形有起伏，不是一片同高的平地', () => {
    const core = sampleCore();
    const heights = new Set<number>();
    for (let x = LOADED_MIN; x <= LOADED_MAX; x++) heights.add(core.highestBlockY(x, 0));
    expect(heights.size).toBeGreaterThan(1);
  });

  it('没有树的列上 highestBlockY 就是草方块的高度', () => {
    const core = sampleCore();
    // 出生点那一带不长树（见 OAK_SPAWN_CLEARANCE），最高的方块就是地表那层草
    for (const [x, z] of [
      [0, 0],
      [1, -1],
      [-1, 1],
    ] as Array<[number, number]>) {
      expect(core.highestBlockY(x, z)).toBe(surfaceAt(x, z));
    }
  });

  it('有树的列上 highestBlockY 报的是树冠，比地表高', () => {
    // highestBlockY 不是「地表高度」：树一长出来两者就分叉，树冠会把它抬起来。
    const core = sampleCore();
    // 会写进原点区块的第一棵树。树根不一定在这个区块里，但一定在采样视距内。
    const tree = oakTreesTouching(plainsTreePlacement(DEFAULT_SEED), 0, 0)[0];
    if (!tree) throw new Error('原点区块附近应有一棵橡树');
    expect(core.getBlock(tree.x, tree.rootY, tree.z)).toBe(BlockType.OakLog);
    expect(core.highestBlockY(tree.x, tree.z)).toBeGreaterThan(surfaceAt(tree.x, tree.z));
  });

  it('未加载区块的列没有最高方块', () => {
    const core = new GameCore({ viewRadius: 0 });
    expect(core.highestBlockY(16 * 50, 0)).toBe(WORLD_MIN_Y - 1);
  });
});

describe('GameCore 的方块写入', () => {
  it('写入后能读回同一种方块', () => {
    const core = sampleCore();
    core.setBlock(3, surfaceAt(3, 4) + 1, 4, BlockType.OakLog);
    expect(core.getBlock(3, surfaceAt(3, 4) + 1, 4)).toBe(BlockType.OakLog);
  });

  it('可以把方块挖成空气', () => {
    const core = sampleCore();
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
    const core = sampleCore();
    const spawn = core.spawnPoint;
    expect(spawn.y).toBe(surfaceAt(0, 0) + 1);
    expect(core.getBlock(spawn.x, spawn.y - 1, spawn.z)).toBe(BlockType.Grass);
    expect(core.getBlock(spawn.x, spawn.y, spawn.z)).toBe(BlockType.Air);
    expect(core.getBlock(spawn.x, spawn.y + 1, spawn.z)).toBe(BlockType.Air);
  });

  it('出生点落在方块中心', () => {
    const spawn = sampleCore().spawnPoint;
    expect(spawn.x).toBe(0.5);
    expect(spawn.z).toBe(0.5);
  });

  it('换种子后出生点跟着地形走', () => {
    const core = sampleCore({ seed: 555 });
    expect(core.spawnPoint.y).toBe(plainsSurfaceHeight(555, 0, 0) + 1);
  });
});

describe('GameCore 的玩家', () => {
  it('新建世界后玩家位于出生点', () => {
    const core = sampleCore();
    expect(core.player.position).toEqual(core.spawnPoint);
    expect(core.player.onGround).toBe(true);
  });

  it('没有输入时 tick 多少次玩家都站着不动', () => {
    const core = sampleCore();
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
    const core = sampleCore();
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

describe('GameCore 的空手挖掘', () => {
  /** 脚下那块草：平地上出生点正下方的一格。 */
  const UNDERFOOT: [number, number, number] = [0, FLAT_GROUND_Y, 0];

  /**
   * 挖掉一块草要多少 tick。
   * 从耗时表里取而不是写 18：这一节测的是「按键 → tick → 方块消失」这条线接上了没有，
   * 耗时表本身由 tests/core/block.test.ts 与 tests/core/mining.test.ts 钉住。
   */
  const GRASS_TICKS = miningTicks(BlockType.Grass);

  /** 低头看脚下那块草的核心。俯仰到底，视线几乎竖直向下。 */
  function lookingDown(): GameCore {
    const core = coreOnFlatGround();
    core.turn(0, -MAX_PITCH);
    return core;
  }

  it('瞄着脚下那块草，目标坐标与命中面都对', () => {
    const core = lookingDown();
    core.tick();
    expect(core.mining.target).toMatchObject({
      x: UNDERFOOT[0],
      y: UNDERFOOT[1],
      z: UNDERFOOT[2],
      normal: { x: 0, y: 1, z: 0 },
    });
  });

  it('抬头看天时没有目标', () => {
    const core = coreOnFlatGround();
    core.turn(0, MAX_PITCH);
    core.tick();
    expect(core.mining.target).toBeUndefined();
    expect(core.mining.progress).toBe(0);
  });

  it('不按挖掘键时 tick 多久都不掉方块', () => {
    const core = lookingDown();
    core.tick(10 * TICK_RATE);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Grass);
    expect(core.mining.progress).toBe(0);
  });

  it('按住挖掘键，耗时到了那块草变成空气', () => {
    const core = lookingDown();
    core.setMining(true);
    core.tick(GRASS_TICKS - 1);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Grass);
    core.tick(1);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
  });

  it('挖掘键松开后进度归零，再按住也要重新挖满', () => {
    const core = lookingDown();
    core.setMining(true);
    core.tick(GRASS_TICKS - 1);
    core.setMining(false);
    core.tick(1);
    expect(core.mining.progress).toBe(0);

    core.setMining(true);
    core.tick(GRASS_TICKS - 1);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Grass);
  });

  it('挖掉的那一格出现在「变过的方块」里，取走后清空', () => {
    const core = lookingDown();
    core.setMining(true);
    core.tick(GRASS_TICKS);
    expect(core.takeChangedBlocks()).toEqual([
      { x: UNDERFOOT[0], y: UNDERFOOT[1], z: UNDERFOOT[2] },
    ]);
    expect(core.takeChangedBlocks()).toEqual([]);
  });

  it('挖穿脚下之后玩家掉进坑里', () => {
    const core = lookingDown();
    const standing = core.player.position.y;
    core.setMining(true);
    core.tick(GRASS_TICKS + TICK_RATE);
    expect(core.player.position.y).toBe(standing - 1);
    expect(core.player.onGround).toBe(true);
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

  it('不指定视距时用默认视距', () => {
    const core = new GameCore();
    expect(core.viewRadius).toBe(DEFAULT_VIEW_RADIUS);
    expect(core.loadedChunkCount).toBe((2 * DEFAULT_VIEW_RADIUS + 1) ** 2);
  });

  it('已加载区块坐标可枚举，且围绕原点区块', () => {
    const core = new GameCore({ viewRadius: 1 });
    const keys = core.loadedChunks().map(({ cx, cz }) => `${cx},${cz}`);
    expect(keys).toContain('0,0');
    expect(keys).toContain('-1,-1');
    expect(keys).toContain('1,1');
    expect(keys).toHaveLength(9);
  });

  it('来源还没准备好区块时，构造不报错，tick 之后补上', () => {
    let ready = false;
    const core = new GameCore({
      viewRadius: 1,
      chunkSource: () => (cx, cz) => (ready ? flatTestTerrain(cx, cz) : undefined),
    });
    expect(core.loadedChunkCount).toBe(0);

    ready = true;
    core.tick();
    expect(core.loadedChunkCount).toBe(9);
  });
});

describe('GameCore 的区块随玩家流式加载', () => {
  /** 一直往前走：返回走到哪儿了。 */
  function walkForward(core: GameCore, ticks: number): void {
    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    core.tick(ticks);
  }

  /**
   * 侧身让路时，横向挪了这么多才算真挪动了。
   * 半步：斜着走一 tick 横向挪 0.71 步，被挡住则一步不挪，阈值取在两者中间。
   */
  const SIDESTEP_PROGRESS = WALK_STEP / 2;

  /**
   * 在真实地形上一直往前走，绕开挡路的东西，每个 tick 之后调一次 `check`。
   *
   * 边走边跳，因为相邻两列可能差一格，光走会被那一格挡住（没有自动上台阶）。挡路的还有
   * 树：树干与低垂的树冠都是实心的，一味往前只会永远卡在第一棵树上——这条测的是流式
   * 加载，不该让一棵树决定它过不过。所以往前挪不动就侧身让一步，侧身也挪不动就换另一边
   * （树冠是 5×5 的一片，玩家会正好落进右边不通的那个角）。
   *
   * 侧身与前进同时给：两个轴分开解算碰撞，侧出树干之后这一 tick 就能继续往前。
   */
  function walkForwardPastTrees(core: GameCore, ticks: number, check: () => void): void {
    let sidestep: 'none' | 'right' | 'left' = 'none';
    let previous = core.player.position;
    for (let i = 0; i < ticks; i++) {
      core.setMoveIntent({
        ...IDLE_INTENT,
        forward: true,
        jump: true,
        right: sidestep === 'right',
        left: sidestep === 'left',
      });
      core.tick();
      check();
      const now = core.player.position;
      if (now.z < previous.z) {
        sidestep = 'none';
      } else if (sidestep === 'none') {
        sidestep = 'right';
      } else if (Math.abs(now.x - previous.x) < SIDESTEP_PROGRESS) {
        sidestep = sidestep === 'right' ? 'left' : 'right';
      }
      previous = now;
    }
  }

  it('玩家所在区块由脚下的位置决定，负坐标也算对', () => {
    const core = sampleCore({ chunkSource: () => flatTestTerrain });
    expect(core.playerChunk).toEqual({ cx: 0, cz: 0 });
  });

  it('走出初始范围时前方的区块跟着生成，玩家不会掉进虚空', () => {
    const core = sampleCore({ chunkSource: () => flatTestTerrain });
    const standing = core.player.position.y;

    // 视距 2 时初始加载范围只到 z = −32；朝 −Z 走 40 秒足以走出去好几个区块
    walkForward(core, 40 * TICK_RATE);

    expect(core.player.position.z).toBeLessThan(-CHUNK_SIZE * (SAMPLE_RADIUS + 1));
    expect(core.player.position.y).toBe(standing);
    expect(core.player.onGround).toBe(true);
  });

  it('玩家自己走过 20 个区块之后，原点附近已卸载、新位置周围已加载', () => {
    const core = sampleCore({ chunkSource: () => flatTestTerrain });
    expect(core.isChunkLoaded(0, 0)).toBe(true);

    // 20 个区块 = 320 格，按步行速度要走 74 秒
    const chunksToCross = 20;
    walkForward(core, Math.ceil((chunksToCross * CHUNK_SIZE) / WALK_SPEED) * TICK_RATE);

    const { cx, cz } = core.playerChunk;
    expect(cz).toBeLessThanOrEqual(-chunksToCross);
    expect(core.isChunkLoaded(cx, cz)).toBe(true);
    expect(core.isChunkLoaded(cx, cz - SAMPLE_RADIUS)).toBe(true);
    expect(core.isChunkLoaded(0, 0)).toBe(false);
    // 视距内的一定在，卸载线之外的一定不在，之间那一圈滞后的可能还在
    expect(core.loadedChunkCount).toBeGreaterThanOrEqual((2 * SAMPLE_RADIUS + 1) ** 2);
    expect(core.loadedChunkCount).toBeLessThanOrEqual(
      (2 * (SAMPLE_RADIUS + UNLOAD_MARGIN) + 1) ** 2,
    );
  });

  it('真实地形上一路走过去都踩在地表上，不会走进未加载的空气里', () => {
    const core = sampleCore();
    const falls: string[] = [];

    walkForwardPastTrees(core, 60 * TICK_RATE, () => {
      const { x, y, z } = core.player.position;
      // 脚底始终在自己这一列的地表之上——低于它就说明踩进了没加载的区块
      const surface = plainsSurfaceHeight(DEFAULT_SEED, Math.floor(x), Math.floor(z));
      if (y < surface + 1) falls.push(`y=${y}，地表=${surface}`);
    });

    expect(falls).toEqual([]);
    // 一分钟走出去二百多格，跨过十几个区块边界
    expect(core.player.position.z).toBeLessThan(-200);
  });
});
