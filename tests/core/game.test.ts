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
import { PICKUP_DELAY_TICKS } from '../../src/core/drop';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../../src/core/inventory';
import { BARE_HAND, ItemType } from '../../src/core/item';
import { IDLE_INTENT, MAX_PITCH, WALK_SPEED, WALK_STEP } from '../../src/core/player';
import {
  DIRT_DEPTH_MAX,
  DIRT_DEPTH_MIN,
  plainsSurfaceHeight,
  plainsTreePlacement,
} from '../../src/core/terrain';
import { oakTreesTouching } from '../../src/core/tree';
import type { Vec3 } from '../../src/core/vec3';
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

/** 一格的三元坐标换成 Vec3，好跟核心报出来的坐标对照。 */
function toVec([x, y, z]: [number, number, number]): Vec3 {
  return { x, y, z };
}

/** 平地上出生点正下方那一格。挖掘、放置、背包界面几节都从挖穿它开始。 */
const UNDERFOOT: [number, number, number] = [0, FLAT_GROUND_Y, 0];

/** 挖穿之后再等这么多 tick：掉落物落定，并被吸进背包。 */
const PICKUP_TICKS = PICKUP_DELAY_TICKS + 2;

/** 朝 +X 看的偏航。 */
const EAST_YAW = -Math.PI / 2;

/**
 * 站在一格深的坑里斜着往下看的俯仰：−30°。
 * 视线越过坑沿，落在旁边那块草的顶面上——所以放置的落点在坑外，不与玩家相交。
 */
const ASIDE_PITCH = -Math.PI / 6;

/** 站在坑里斜着往下看时对准的那一格，以及它的顶面外侧那一格（放置的落点）。 */
const ASIDE: [number, number, number] = [1, FLAT_GROUND_Y, 0];
const ABOVE_ASIDE: [number, number, number] = [1, FLAT_GROUND_Y + 1, 0];

/** 把视角转到绝对的偏航与俯仰上。核心只收增量，这里换算一次。 */
function look(core: GameCore, yaw: number, pitch: number): void {
  core.turn(yaw - core.player.yaw, pitch - core.player.pitch);
}

/** 低头对准脚下那块草的核心。俯仰到底，视线几乎竖直向下。 */
function lookingDown(): GameCore {
  const core = coreOnFlatGround();
  core.turn(0, -MAX_PITCH);
  return core;
}

/** 低头挖穿脚下那一格，掉出来的东西进背包，玩家掉进坑里。 */
function digUnderfoot(core: GameCore, block: BlockType): void {
  look(core, 0, -MAX_PITCH);
  core.setMining(true);
  core.tick(miningTicks(block, BARE_HAND));
  core.setMining(false);
  core.tick(PICKUP_TICKS);
}

/**
 * 手上有一个泥土、站在一格深的坑里斜着看着旁边那块草的核心。
 *
 * 东西只能挖来——核心没有「往背包里塞物品」的入口，也不该为测试开一个。
 * 传进来的核心决定视距那类设定，默认是采样视距的平地核心。
 */
function holdingDirt(core: GameCore = coreOnFlatGround()): GameCore {
  digUnderfoot(core, BlockType.Grass);
  look(core, EAST_YAW, ASIDE_PITCH);
  core.tick();
  return core;
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

  it('地表以上只有空气与树，树冠之上什么都没有', () => {
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
  /**
   * 挖掉一块草要多少 tick。
   * 从耗时表里取而不是写 18：这一节测的是「按键 → tick → 方块消失」这条线接上了没有，
   * 耗时表本身由 tests/core/block.test.ts 与 tests/core/mining.test.ts 断言。
   */
  const GRASS_TICKS = miningTicks(BlockType.Grass, BARE_HAND);

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

  describe('挖掉的东西进背包', () => {
    /** 把脚下那一格换成另一种方块，再低头对准它。 */
    function lookingDownAt(block: BlockType): GameCore {
      const core = lookingDown();
      core.setBlock(...UNDERFOOT, block);
      return core;
    }

    it('新开的世界背包是空的', () => {
      const core = coreOnFlatGround();
      expect(core.inventory.size).toBe(INVENTORY_SIZE);
      expect(core.inventory.hotbar().every((slot) => slot === undefined)).toBe(true);
      expect(core.drops.count).toBe(0);
    });

    it('挖掉脚下那块草，原地掉出一个泥土', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);

      expect(core.drops.count).toBe(1);
      const [drop] = core.drops.all();
      expect(drop!.item).toBe(ItemType.Dirt);
      expect(drop!.count).toBe(1);
      // 掉在原来那一格里，不是别处（初速度已经让它偏离格心一点点）
      expect(Math.floor(drop!.position.x)).toBe(UNDERFOOT[0]);
      expect(Math.floor(drop!.position.z)).toBe(UNDERFOOT[2]);
    });

    it('掉落物被吸进快捷栏的第一格', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);
      expect(core.inventory.slot(0)).toBeUndefined();

      // 玩家就站在坑口，拾取延迟一过就吸进来
      core.tick(PICKUP_DELAY_TICKS + 1);
      expect(core.drops.count).toBe(0);
      expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
      expect(core.inventory.hotbar()[0]).toEqual({ item: ItemType.Dirt, count: 1 });
    });

    it('挖两块草得到一堆 2 个泥土，不是两堆', () => {
      const core = lookingDown();
      core.setMining(true);
      // 第一块碎了之后目标当场落到下面那块上，按住不放接着挖
      core.tick(GRASS_TICKS);
      core.setBlock(UNDERFOOT[0], UNDERFOOT[1] - 1, UNDERFOOT[2], BlockType.Grass);
      core.tick(GRASS_TICKS + PICKUP_DELAY_TICKS + 1);
      core.setMining(false);
      core.tick(PICKUP_DELAY_TICKS + 1);

      expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 2 });
      expect(core.inventory.slot(1)).toBeUndefined();
    });

    it('空手挖石头，方块碎了但什么都拿不到', () => {
      const core = lookingDownAt(BlockType.Stone);
      core.setMining(true);
      core.tick(miningTicks(BlockType.Stone, BARE_HAND));
      core.setMining(false);

      expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
      expect(core.drops.count).toBe(0);
      core.tick(PICKUP_DELAY_TICKS + 1);
      expect(core.inventory.hotbar().every((slot) => slot === undefined)).toBe(true);
    });

    it('挖树叶什么都拿不到', () => {
      const core = lookingDownAt(BlockType.OakLeaves);
      core.setMining(true);
      core.tick(miningTicks(BlockType.OakLeaves, BARE_HAND));
      core.setMining(false);

      expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
      expect(core.drops.count).toBe(0);
    });

    it('掉落物是实体，不进「变过的方块」那份记录', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);
      // 挖掉那一格是方块变更，取走之后记录就该是空的
      expect(core.takeChangedBlocks()).toHaveLength(1);

      // 掉落物在这几十 tick 里下落、被吸走，一次都不该让网格重建
      core.tick(PICKUP_DELAY_TICKS + TICK_RATE);
      expect(core.drops.count).toBe(0);
      expect(core.takeChangedBlocks()).toEqual([]);
    });
  });

  describe('挖掉的方块给经验', () => {
    /** 把脚下那一格换成另一种方块，再低头对准它。 */
    function lookingDownAt(block: BlockType): GameCore {
      const core = lookingDown();
      core.setBlock(...UNDERFOOT, block);
      return core;
    }

    /** 经验球飞完全程要的 tick 数：玩家就在旁边，几 tick 就到。 */
    const ABSORB_TICKS = TICK_RATE;

    it('新开的世界没有经验，也没有经验球', () => {
      const core = coreOnFlatGround();
      expect(core.experience.total).toBe(0);
      expect(core.experience.level).toBe(0);
      expect(core.xpOrbs.count).toBe(0);
    });

    it('挖掉脚下那块草，原地生成一个 3 点的经验球', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);

      expect(core.xpOrbs.count).toBe(1);
      const [orb] = core.xpOrbs.all();
      expect(orb!.amount).toBe(3);
      expect(Math.floor(orb!.position.x)).toBe(UNDERFOOT[0]);
      expect(Math.floor(orb!.position.y)).toBe(UNDERFOOT[1]);
      expect(Math.floor(orb!.position.z)).toBe(UNDERFOOT[2]);
    });

    it('经验球飞过来被吸收，玩家经验增加', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);
      expect(core.experience.total).toBe(0);

      core.tick(ABSORB_TICKS);
      expect(core.xpOrbs.count).toBe(0);
      expect(core.experience.total).toBe(3);
    });

    it('挖原木给 6 点', () => {
      const core = lookingDownAt(BlockType.OakLog);
      core.setMining(true);
      core.tick(miningTicks(BlockType.OakLog, BARE_HAND));
      core.setMining(false);
      core.tick(ABSORB_TICKS);

      expect(core.experience.total).toBe(6);
    });

    it('空手挖石头拿不到东西，经验照给 3 点', () => {
      const core = lookingDownAt(BlockType.Stone);
      core.setMining(true);
      core.tick(miningTicks(BlockType.Stone, BARE_HAND));
      core.setMining(false);
      core.tick(ABSORB_TICKS);

      expect(core.inventory.hotbar().every((slot) => slot === undefined)).toBe(true);
      expect(core.experience.total).toBe(3);
    });

    it('连着挖十几块，等级从 0 升到 1 以上', () => {
      const core = lookingDown();
      // 平地测试世界里草下面是石头（空手 150 tick 一块），把脚下这一列换成草，
      // 「挖十几块」才是十几个 GRASS_TICKS 而不是几分钟
      const blocks = 15;
      for (let depth = 0; depth < blocks; depth++) {
        core.setBlock(UNDERFOOT[0], UNDERFOOT[1] - depth, UNDERFOOT[2], BlockType.Grass);
      }
      core.takeChangedBlocks();

      core.setMining(true);
      // 一路往下挖：每挖穿一块，目标当场落到下面那块上。每块多给几 tick 的落地余量
      core.tick(blocks * (GRASS_TICKS + 4));
      core.setMining(false);
      core.tick(ABSORB_TICKS);

      // 一块 3 点，7 点升 1 级、16 点升 2 级
      expect(core.experience.total).toBeGreaterThanOrEqual(16);
      expect(core.experience.total % 3).toBe(0);
      expect(core.experience.level).toBeGreaterThanOrEqual(2);
      expect(core.experience.progress).toBeGreaterThanOrEqual(0);
      expect(core.experience.progress).toBeLessThan(1);
    });

    it('经验球是实体，不进「变过的方块」那份记录', () => {
      const core = lookingDown();
      core.setMining(true);
      core.tick(GRASS_TICKS);
      core.setMining(false);
      expect(core.takeChangedBlocks()).toHaveLength(1);

      // 经验球在这几十 tick 里飞过来、被吸收，一次都不该让网格重建
      core.tick(ABSORB_TICKS);
      expect(core.xpOrbs.count).toBe(0);
      expect(core.takeChangedBlocks()).toEqual([]);
    });
  });
});

describe('GameCore 的连锁挖掘', () => {
  /** 脚下那一列往下摆几格原木。整根一起碎，玩家跟着掉进坑里。 */
  const TRUNK_HEIGHT = 5;

  /** 原木挖满要多少 tick。连锁的耗时与它相同，耗时表本身由别处断言。 */
  const LOG_TICKS = miningTicks(BlockType.OakLog, BARE_HAND);

  /** 掉落物落定并被吸走、经验球飞完全程要的 tick 数：玩家就掉在这堆东西里。 */
  const SETTLE_TICKS = PICKUP_DELAY_TICKS + 3 * TICK_RATE;

  /** 脚下那一列换成一根原木树干，再低头对准最上面那块。返回自上而下的那些格。 */
  function trunkUnderfoot(): { core: GameCore; cells: Vec3[] } {
    const core = coreOnFlatGround();
    const cells = Array.from({ length: TRUNK_HEIGHT }, (_, i) => ({
      x: 0,
      y: FLAT_GROUND_Y - i,
      z: 0,
    }));
    for (const { x, y, z } of cells) core.setBlock(x, y, z, BlockType.OakLog);
    core.turn(0, -MAX_PITCH);
    return { core, cells };
  }

  /** 树干上还剩下的那些格。 */
  function remaining(core: GameCore, cells: Vec3[]): Vec3[] {
    return cells.filter(({ x, y, z }) => core.getBlock(x, y, z) !== BlockType.Air);
  }

  it('按住连锁键开始挖，一整根树干一起碎，每块各掉一份、各给一份经验', () => {
    const { core, cells } = trunkUnderfoot();
    core.setMining(true);
    core.setChainMining(true);

    core.tick(LOG_TICKS - 1);
    expect(remaining(core, cells)).toEqual(cells);

    core.tick(1);
    expect(remaining(core, cells)).toEqual([]);
    expect(core.drops.count).toBe(TRUNK_HEIGHT);
    expect(core.xpOrbs.count).toBe(TRUNK_HEIGHT);

    // 掉落物被吸进背包并成一堆，经验球的经验全并进累计经验值
    core.setMining(false);
    core.tick(SETTLE_TICKS);
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.OakLog, count: TRUNK_HEIGHT });
    expect(core.experience.total).toBe(TRUNK_HEIGHT * 6);
  });

  it('不按连锁键只挖对准的那一块', () => {
    const { core, cells } = trunkUnderfoot();
    core.setMining(true);
    core.tick(LOG_TICKS);

    expect(remaining(core, cells)).toEqual(cells.slice(1));
    expect(core.drops.count).toBe(1);
  });

  it('连锁键下一个 tick 才生效（ADR-0004），预览随即查得到', () => {
    const { core, cells } = trunkUnderfoot();
    core.setMining(true);
    core.setChainMining(true);
    // 还没 tick，什么都没瞄
    expect(core.mining.chainPreview).toEqual([]);

    core.tick();
    expect(core.mining.chainPreview).toEqual(cells);
  });

  it('松开连锁键预览就没了，进度留着接着挖单块', () => {
    const { core, cells } = trunkUnderfoot();
    core.setMining(true);
    core.setChainMining(true);
    core.tick(LOG_TICKS - 2);

    core.setChainMining(false);
    core.tick(1);
    expect(core.mining.chainPreview).toEqual([]);
    expect(remaining(core, cells)).toEqual(cells);

    core.tick(1);
    expect(remaining(core, cells)).toEqual(cells.slice(1));
  });

  it('挖掉的每一格都出现在「变过的方块」里', () => {
    const { core, cells } = trunkUnderfoot();
    core.setMining(true);
    core.setChainMining(true);
    core.tick(LOG_TICKS);

    // 顺序是连锁的发现顺序，这里只关心「一格都没漏、也没多」
    const changed = core.takeChangedBlocks();
    expect(changed).toHaveLength(TRUNK_HEIGHT);
    expect(changed).toEqual(expect.arrayContaining(cells));
    expect(core.takeChangedBlocks()).toEqual([]);
  });
});

describe('GameCore 的快捷栏选中格', () => {
  it('新世界选中第一格', () => {
    const core = coreOnFlatGround();
    expect(core.inventory.selectedSlot).toBe(0);
    expect(core.inventory.held).toBeUndefined();
  });

  it('选中格下一个 tick 生效（ADR-0004）', () => {
    const core = coreOnFlatGround();
    core.selectHotbarSlot(3);
    expect(core.inventory.selectedSlot).toBe(0);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(3);
  });

  it('滚轮沿快捷栏挪格，正向往右', () => {
    const core = coreOnFlatGround();
    core.scrollHotbar(1);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(1);

    core.scrollHotbar(-1);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(0);
  });

  it('滚到头从另一端接着来', () => {
    const core = coreOnFlatGround();
    core.scrollHotbar(-1);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(HOTBAR_SIZE - 1);

    core.scrollHotbar(1);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(0);
  });

  it('同一个 tick 里滚三下就挪三格', () => {
    const core = coreOnFlatGround();
    core.scrollHotbar(1);
    core.scrollHotbar(1);
    core.scrollHotbar(1);
    core.tick();
    expect(core.inventory.selectedSlot).toBe(3);
  });
});

describe('GameCore 的放置方块', () => {
  /** 按一次使用键并推进一个 tick。 */
  function placeOnce(core: GameCore): void {
    core.use();
    core.tick();
  }

  it('对准的那一格没变，新方块落在命中面外侧那一格', () => {
    const core = holdingDirt();
    // 看着旁边那块草的顶面
    expect(core.mining.target).toMatchObject({
      x: ASIDE[0],
      y: ASIDE[1],
      z: ASIDE[2],
      normal: { x: 0, y: 1, z: 0 },
    });
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });

    placeOnce(core);
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Dirt);
    expect(core.getBlock(...ASIDE)).toBe(BlockType.Grass);
  });

  it('放一块，选中格数量减 1；减到 0 时那一格清空', () => {
    const core = holdingDirt();
    // 再挖掉对准的那块草，两个泥土并进同一堆
    core.setMining(true);
    core.tick(miningTicks(BlockType.Grass, BARE_HAND));
    core.setMining(false);
    core.tick(PICKUP_TICKS);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 2 });

    // 挖穿之后视线落到后面那块草的 −X 面上，放置把刚挖掉的那一格填回去
    expect(core.mining.target).toMatchObject({ x: 2, y: ASIDE[1], normal: { x: -1, y: 0, z: 0 } });
    placeOnce(core);
    expect(core.getBlock(...ASIDE)).toBe(BlockType.Dirt);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });

    placeOnce(core);
    expect(core.inventory.held).toBeUndefined();
    expect(core.inventory.slot(0)).toBeUndefined();
  });

  it('朝自己脚下放置被拒绝', () => {
    const core = holdingDirt();
    // 站在坑里低头：对准的是坑底，命中面外侧那一格正是脚所在的位置
    look(core, 0, -MAX_PITCH);
    core.tick();
    expect(core.mining.target).toMatchObject({ y: FLAT_GROUND_Y - 1, normal: { y: 1 } });

    placeOnce(core);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('朝身体所在的位置放置被拒绝', () => {
    const core = holdingDirt();
    // 坑沿上摆一块，平视正对着它的 −X 面：外侧那一格是玩家上半身所在的那一格
    const atEyeLevel: [number, number, number] = [1, FLAT_GROUND_Y + 1, 0];
    core.setBlock(...atEyeLevel, BlockType.Stone);
    look(core, EAST_YAW, 0);
    core.tick();
    expect(core.mining.target).toMatchObject({ ...toVec(atEyeLevel), normal: { x: -1 } });

    placeOnce(core);
    expect(core.getBlock(0, FLAT_GROUND_Y + 1, 0)).toBe(BlockType.Air);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('超过 4.5 格就不是目标，使用键什么都不发生', () => {
    const core = holdingDirt();
    // 6 格外立一块，平视对着它：触及距离之外，没有目标
    core.setBlock(6, FLAT_GROUND_Y + 1, 0, BlockType.Stone);
    look(core, EAST_YAW, 0);
    core.tick();
    expect(core.mining.target).toBeUndefined();

    placeOnce(core);
    expect(core.getBlock(5, FLAT_GROUND_Y + 1, 0)).toBe(BlockType.Air);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('同一块挪到 4 格远就够得着，放得下', () => {
    // 与上一条成对：挡住放置的确实是距离，而不是这个摆法本身有问题
    const core = holdingDirt();
    core.setBlock(4, FLAT_GROUND_Y + 1, 0, BlockType.Stone);
    look(core, EAST_YAW, 0);
    core.tick();
    expect(core.mining.target).toMatchObject({ x: 4, normal: { x: -1 } });

    placeOnce(core);
    expect(core.getBlock(3, FLAT_GROUND_Y + 1, 0)).toBe(BlockType.Dirt);
    expect(core.inventory.held).toBeUndefined();
  });

  it('选中格是空的时候使用键无效', () => {
    // 空手站在地面上，斜着看 3 格外那块草的顶面：手上有东西的话这一下放得下
    const core = coreOnFlatGround();
    look(core, EAST_YAW, ASIDE_PITCH);
    core.tick();
    const target = core.mining.target;
    expect(target).toMatchObject({ normal: { x: 0, y: 1, z: 0 } });
    core.takeChangedBlocks();

    placeOnce(core);
    expect(core.getBlock(target!.x, target!.y + 1, target!.z)).toBe(BlockType.Air);
    expect(core.takeChangedBlocks()).toEqual([]);
  });

  it('切换选中格后放置的是新格里的方块', () => {
    const core = holdingDirt();
    // 把对准的那块草换成原木再挖掉：原木物品另占一格，手上因此有两种东西
    core.setBlock(...ASIDE, BlockType.OakLog);
    core.setMining(true);
    core.tick(miningTicks(BlockType.OakLog, BARE_HAND));
    core.setMining(false);
    core.tick(PICKUP_TICKS);
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
    expect(core.inventory.slot(1)).toEqual({ item: ItemType.OakLog, count: 1 });

    // 选第二格：放下去是原木方块
    core.selectHotbarSlot(1);
    placeOnce(core);
    expect(core.inventory.held).toBeUndefined();
    expect(core.getBlock(...ASIDE)).toBe(BlockType.OakLog);

    // 回到第一格：同一条视线放下去是泥土
    core.selectHotbarSlot(0);
    core.tick();
    expect(core.mining.target).toMatchObject({ ...toVec(ASIDE), normal: { y: 1 } });
    placeOnce(core);
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Dirt);
  });

  it('放下的那一格进「变过的方块」，渲染层据此重建网格', () => {
    const core = holdingDirt();
    core.takeChangedBlocks();

    placeOnce(core);
    expect(core.takeChangedBlocks()).toEqual([toVec(ABOVE_ASIDE)]);
    expect(core.takeChangedBlocks()).toEqual([]);
  });

  it('同一个 tick 里按两次使用键只放一块', () => {
    const core = holdingDirt();
    core.setMining(true);
    core.tick(miningTicks(BlockType.Grass, BARE_HAND));
    core.setMining(false);
    core.tick(PICKUP_TICKS);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 2 });

    core.use();
    core.use();
    core.tick();
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
  });
});

describe('GameCore 的背包界面', () => {
  /** 挖掉脚下那块草，掉出来的泥土进背包第一格。玩家掉进一格深的坑里。 */
  function withOneDirt(): GameCore {
    const core = coreOnFlatGround();
    digUnderfoot(core, BlockType.Grass);
    return core;
  }

  /** 打开背包界面（开合下一个 tick 生效）。 */
  function openInventory(core: GameCore): void {
    core.toggleInventory();
    core.tick();
  }

  it('开合下一个 tick 生效（ADR-0004）', () => {
    const core = coreOnFlatGround();
    expect(core.inventoryScreen.open).toBe(false);

    core.toggleInventory();
    expect(core.inventoryScreen.open).toBe(false);
    core.tick();
    expect(core.inventoryScreen.open).toBe(true);

    core.toggleInventory();
    core.tick();
    expect(core.inventoryScreen.open).toBe(false);
  });

  it('界面模式下移动指令被忽略', () => {
    const core = coreOnFlatGround();
    openInventory(core);
    const standing = core.player.position;

    core.setMoveIntent({ ...IDLE_INTENT, forward: true, jump: true });
    core.tick(TICK_RATE);
    expect(core.player.position).toEqual(standing);
  });

  it('界面模式下视角指令被忽略', () => {
    const core = coreOnFlatGround();
    core.turn(0.5, 0.25);
    openInventory(core);

    core.turn(1, -1);
    expect(core.player.yaw).toBeCloseTo(0.5, 10);
    expect(core.player.pitch).toBeCloseTo(0.25, 10);
  });

  it('进入界面模式时挖掘进度归零，按住左键也挖不动', () => {
    const core = lookingDown();
    core.setMining(true);
    core.tick(miningTicks(BlockType.Grass, BARE_HAND) - 2);
    expect(core.mining.progress).toBeGreaterThan(0);

    openInventory(core);
    expect(core.mining.progress).toBe(0);

    // 挖掘键还按着，界面开着就是挖不动
    core.tick(10 * miningTicks(BlockType.Grass, BARE_HAND));
    expect(core.mining.progress).toBe(0);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Grass);
  });

  it('关掉界面之后挖掘重新从零开始', () => {
    const core = lookingDown();
    core.setMining(true);
    openInventory(core);
    core.toggleInventory();
    core.tick(miningTicks(BlockType.Grass, BARE_HAND) - 1);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Grass);

    core.tick(1);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
  });

  it('界面模式下放置指令被忽略', () => {
    const core = withOneDirt();
    // 站在坑里低头对着坑底：手上那块泥土本来能放到坑沿外侧那一格
    core.tick();
    expect(core.mining.target).toBeDefined();
    // 挖出来那一格的变更记录先取走，剩下的变更就只可能来自放置
    core.takeChangedBlocks();

    openInventory(core);
    core.use();
    core.tick();
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
    expect(core.takeChangedBlocks()).toEqual([]);
  });

  it('界面模式只挡输入，世界照样在跑：掉落物仍被吸进背包', () => {
    const core = lookingDown();
    core.setMining(true);
    core.tick(miningTicks(BlockType.Grass, BARE_HAND));
    core.setMining(false);
    expect(core.drops.count).toBe(1);

    openInventory(core);
    core.tick(PICKUP_TICKS);
    expect(core.drops.count).toBe(0);
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('点格子下一个 tick 生效，拿起的那一堆到光标上', () => {
    const core = withOneDirt();
    openInventory(core);

    core.clickSlot(0);
    expect(core.inventoryScreen.cursor).toBeUndefined();
    core.tick();
    expect(core.inventoryScreen.cursor).toEqual({ item: ItemType.Dirt, count: 1 });
    expect(core.inventory.slot(0)).toBeUndefined();
  });

  it('同一个 tick 里点两格，按点的顺序一格一格来', () => {
    const core = withOneDirt();
    openInventory(core);

    core.clickSlot(0);
    core.clickSlot(20);
    core.tick();
    expect(core.inventoryScreen.cursor).toBeUndefined();
    expect(core.inventory.slot(20)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('界面关着时点格子不动任何东西', () => {
    const core = withOneDirt();
    core.clickSlot(0);
    core.tick();
    expect(core.inventoryScreen.cursor).toBeUndefined();
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('关掉界面时光标上的东西回到原来那一格', () => {
    const core = withOneDirt();
    openInventory(core);
    core.clickSlot(0);
    core.tick();
    expect(core.inventory.slot(0)).toBeUndefined();

    core.toggleInventory();
    core.tick();
    expect(core.inventoryScreen.open).toBe(false);
    expect(core.inventoryScreen.cursor).toBeUndefined();
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('关掉界面那一 tick 里点的格子照样算数', () => {
    const core = withOneDirt();
    openInventory(core);
    // 拿起来，再在同一个 tick 里放到第 20 格并按下 E
    core.clickSlot(0);
    core.tick();
    core.clickSlot(20);
    core.toggleInventory();
    core.tick();
    expect(core.inventory.slot(20)).toEqual({ item: ItemType.Dirt, count: 1 });
    expect(core.inventoryScreen.open).toBe(false);
  });
});

describe('GameCore 的合成网格与输出格', () => {
  /** 合成网格第一格在界面里的格号。 */
  const GRID_FIRST = INVENTORY_SIZE;
  const PLANKS_X4 = { item: ItemType.OakPlanks, count: 4 };

  /**
   * 手上有一个原木、背包界面开着的核心。脚下那块草换成原木再挖，东西只能挖来（理由见
   * `holdingDirt`）。
   */
  function openedWithOneLog(): GameCore {
    const core = coreOnFlatGround();
    core.setBlock(...UNDERFOOT, BlockType.OakLog);
    digUnderfoot(core, BlockType.OakLog);
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.OakLog, count: 1 });
    core.toggleInventory();
    core.tick();
    return core;
  }

  it('背包界面带一块 2x2 合成网格，格号接在 36 格之后，开局输出格是空的', () => {
    const core = coreOnFlatGround();
    const crafting = core.inventoryScreen.crafting!;
    expect(crafting.width).toBe(2);
    expect(crafting.height).toBe(2);
    expect(crafting.firstSlot).toBe(GRID_FIRST);
    expect(crafting.output).toBeUndefined();
  });

  it('把原木放进网格，下一个 tick 输出格显示 4 块木板', () => {
    const core = openedWithOneLog();
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST + 1);
    core.tick();
    const crafting = core.inventoryScreen.crafting!;
    expect(crafting.slot(1)).toEqual({ item: ItemType.OakLog, count: 1 });
    expect(crafting.output).toEqual(PLANKS_X4);
  });

  it('点输出格下一个 tick 生效（ADR-0004）：成品到光标上，材料用掉', () => {
    const core = openedWithOneLog();
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST);
    core.tick();

    core.clickCraftingOutput();
    expect(core.inventoryScreen.cursor).toBeUndefined();
    core.tick();
    expect(core.inventoryScreen.cursor).toEqual(PLANKS_X4);
    expect(core.inventoryScreen.crafting!.slot(0)).toBeUndefined();
    expect(core.inventoryScreen.crafting!.output).toBeUndefined();
  });

  it('同一个 tick 里点格子与点输出格按先后顺序来', () => {
    const core = openedWithOneLog();
    // 拿起原木、放进网格、点输出格、把成品放到第 20 格：四下都在同一个 tick 里
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST + 3);
    core.clickCraftingOutput();
    core.clickSlot(20);
    core.tick();
    expect(core.inventory.slot(20)).toEqual(PLANKS_X4);
    expect(core.inventoryScreen.cursor).toBeUndefined();
    expect(core.inventoryScreen.crafting!.slot(3)).toBeUndefined();
  });

  it('界面关着时点输出格什么都不发生', () => {
    const core = coreOnFlatGround();
    core.clickCraftingOutput();
    core.tick();
    expect(core.inventoryScreen.cursor).toBeUndefined();
  });

  it('关掉界面时网格里的材料回背包', () => {
    const core = openedWithOneLog();
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST);
    core.tick();
    expect(core.inventory.slot(0)).toBeUndefined();

    core.toggleInventory();
    core.tick();
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.OakLog, count: 1 });
    expect(core.inventoryScreen.crafting!.slot(0)).toBeUndefined();
  });

  it('关掉界面时光标上的成品进背包，快捷栏第一格因此拿得到木板', () => {
    const core = openedWithOneLog();
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST);
    core.clickCraftingOutput();
    core.toggleInventory();
    core.tick();
    expect(core.inventoryScreen.open).toBe(false);
    expect(core.inventory.slot(0)).toEqual(PLANKS_X4);
    expect(core.inventory.held).toEqual(PLANKS_X4);
  });

  /**
   * 手上有 4 块木板、站在坑里斜看旁边那块草的核心。
   * 木板只能合成来：把原木放进网格、点输出格、关掉界面，成品就在快捷栏第一格。
   */
  function holdingPlanks(): GameCore {
    const core = openedWithOneLog();
    core.clickSlot(0);
    core.clickSlot(GRID_FIRST);
    core.clickCraftingOutput();
    core.toggleInventory();
    core.tick();
    look(core, EAST_YAW, ASIDE_PITCH);
    core.tick();
    expect(core.inventory.held).toEqual(PLANKS_X4);
    expect(core.mining.target).toMatchObject({ ...toVec(ASIDE), normal: { y: 1 } });
    return core;
  }

  it('手持木板按使用键放置：命中面外侧那一格变成木板方块，手上少 1 块', () => {
    const core = holdingPlanks();
    core.use();
    core.tick();
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.OakPlanks);
    expect(core.inventory.held).toEqual({ item: ItemType.OakPlanks, count: 3 });
  });

  it('空手挖掉放下的木板方块要 60 tick，掉回 1 块木板，给 3 点经验', () => {
    const core = holdingPlanks();
    core.use();
    core.tick();
    const experienceBefore = core.experience.total;
    // 目标方块每 tick 重算（ADR-0006）：放下之后再过一个 tick，视线就落在木板方块上，
    // 它挡在原来那块草的顶面前面
    core.tick();
    expect(core.mining.target).toMatchObject(toVec(ABOVE_ASIDE));

    core.setMining(true);
    core.tick(59);
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.OakPlanks);
    core.tick(1);
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Air);
    core.setMining(false);

    // 掉落物过了拾取延迟才被吸入背包，经验球飞到玩家身上并被吸收再要不到一秒
    core.tick(PICKUP_TICKS + TICK_RATE);
    expect(core.inventory.held).toEqual(PLANKS_X4);
    expect(core.experience.total - experienceBefore).toBe(3);
  });
});

describe('GameCore 的工作台', () => {
  /** 眼睛那一层：站在平地上，眼睛在脚上方约 1.6 格，落在地表之上第二格里。 */
  const EYE_LAYER_Y = FLAT_GROUND_Y + 2;
  /**
   * 站在出生点朝 −Z 平视时，正前方紧挨着的那一格。触及距离之内，而且挖掉之后掉落物
   * 落在脚边一格之内，拾得起来。
   */
  const AHEAD: [number, number, number] = [0, EYE_LAYER_Y, -1];
  /** 正前方第二格：放置测试里给工作台身后垫一块石头当目标。 */
  const BEHIND_AHEAD: [number, number, number] = [0, EYE_LAYER_Y, -2];
  /** 正前方六格远的那一格：超出触及距离（4.5 格）。 */
  const FAR_AHEAD: [number, number, number] = [0, EYE_LAYER_Y, -6];
  /** 站在一格深的坑里朝 −Z 平视时，正前方两格远的那一格。 */
  const AHEAD_FROM_PIT: [number, number, number] = [0, FLAT_GROUND_Y + 1, -2];
  const TABLE_X1 = { item: ItemType.CraftingTable, count: 1 };

  /**
   * 站在平地上、正前方摆着一个工作台、朝它平视的核心。
   *
   * 工作台由 `setBlock` 直接摆进世界：4 块木板合成它要把一堆木板拆成四格各一块，
   * 拆堆是 #25 的事；合成本身在 tests/core/recipe.test.ts 里验。
   */
  function facingTable(at: [number, number, number] = AHEAD): GameCore {
    const core = coreOnFlatGround();
    core.setBlock(...at, BlockType.CraftingTable);
    look(core, 0, 0);
    core.tick();
    return core;
  }

  /** 按一次使用键并推进一个 tick。 */
  function useOnce(core: GameCore): void {
    core.use();
    core.tick();
  }

  it('空手挖掉工作台要 75 tick，掉回 1 个工作台，给 3 点经验', () => {
    const core = facingTable();
    expect(core.mining.target).toMatchObject(toVec(AHEAD));
    core.setMining(true);
    core.tick(74);
    expect(core.getBlock(...AHEAD)).toBe(BlockType.CraftingTable);
    core.tick(1);
    expect(core.getBlock(...AHEAD)).toBe(BlockType.Air);
    core.setMining(false);

    // 掉落物落到脚边被吸走，经验球飞过来被吸收
    core.tick(PICKUP_TICKS + 3 * TICK_RATE);
    expect(core.inventory.held).toEqual(TABLE_X1);
    expect(core.experience.total).toBe(3);
  });

  it('手持工作台按使用键放置成工作台方块，手上那一格清空', () => {
    // 先把摆好的工作台挖来，再对着它身后那块石头把它放回去
    const core = facingTable();
    core.setBlock(...BEHIND_AHEAD, BlockType.Stone);
    core.setMining(true);
    core.tick(miningTicks(BlockType.CraftingTable, BARE_HAND));
    core.setMining(false);
    core.tick(PICKUP_TICKS + 3 * TICK_RATE);
    expect(core.inventory.held).toEqual(TABLE_X1);
    expect(core.mining.target).toMatchObject({ ...toVec(BEHIND_AHEAD), normal: { z: 1 } });

    useOnce(core);
    expect(core.getBlock(...AHEAD)).toBe(BlockType.CraftingTable);
    expect(core.inventory.held).toBeUndefined();
  });

  it('对着触及距离内的工作台按使用键，下一个 tick 打开工作台界面（ADR-0004）', () => {
    const core = facingTable();
    core.use();
    expect(core.craftingTableScreen.open).toBe(false);
    core.tick();
    expect(core.craftingTableScreen.open).toBe(true);
    // 开的是工作台界面，不是背包界面；两者都算界面模式
    expect(core.inventoryScreen.open).toBe(false);
    expect(core.uiMode).toBe(true);
  });

  it('工作台界面带一块 3x3 合成网格，格号接在 36 格之后', () => {
    const core = facingTable();
    const crafting = core.craftingTableScreen.crafting!;
    expect(crafting.width).toBe(3);
    expect(crafting.height).toBe(3);
    expect(crafting.firstSlot).toBe(INVENTORY_SIZE);
    expect(crafting.output).toBeUndefined();
  });

  it('工作台界面开着时移动与挖掘指令被忽略', () => {
    const core = facingTable();
    useOnce(core);
    const standing = core.player.position;

    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    core.setMining(true);
    core.tick(2 * miningTicks(BlockType.CraftingTable, BARE_HAND));
    expect(core.player.position).toEqual(standing);
    expect(core.getBlock(...AHEAD)).toBe(BlockType.CraftingTable);
    expect(core.mining.progress).toBe(0);
  });

  it('手里拿着泥土对着工作台按使用键也是打开界面，泥土一块不少（ADR-0009）', () => {
    // 站在坑里、手上一块泥土，正前方两格摆一个工作台
    const core = holdingDirt();
    core.setBlock(...AHEAD_FROM_PIT, BlockType.CraftingTable);
    look(core, 0, 0);
    core.tick();
    expect(core.mining.target).toMatchObject(toVec(AHEAD_FROM_PIT));
    core.takeChangedBlocks();

    useOnce(core);
    expect(core.craftingTableScreen.open).toBe(true);
    expect(core.inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
    expect(core.takeChangedBlocks()).toEqual([]);
  });

  it('对着泥土或草按使用键仍是放置', () => {
    const core = holdingDirt();
    useOnce(core);
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Dirt);
    expect(core.craftingTableScreen.open).toBe(false);
  });

  it('工作台超出触及距离时按使用键什么都不发生', () => {
    const core = facingTable(FAR_AHEAD);
    expect(core.mining.target).toBeUndefined();
    useOnce(core);
    expect(core.craftingTableScreen.open).toBe(false);
    expect(core.uiMode).toBe(false);
  });

  it('工作台界面开着时按背包键关闭它，而不是再开背包界面', () => {
    const core = facingTable();
    useOnce(core);
    core.toggleInventory();
    core.tick();
    expect(core.craftingTableScreen.open).toBe(false);
    expect(core.inventoryScreen.open).toBe(false);
    expect(core.uiMode).toBe(false);
  });

  it('背包界面开着时使用键不生效：工作台界面不会开，也不放置', () => {
    const core = facingTable();
    core.toggleInventory();
    core.tick();
    expect(core.inventoryScreen.open).toBe(true);

    useOnce(core);
    expect(core.craftingTableScreen.open).toBe(false);
    expect(core.inventoryScreen.open).toBe(true);
  });

  it('同一时刻最多开一个界面：关掉工作台界面之后按背包键才开背包界面', () => {
    const core = facingTable();
    useOnce(core);
    core.toggleInventory();
    core.tick();
    core.toggleInventory();
    core.tick();
    expect(core.inventoryScreen.open).toBe(true);
    expect(core.craftingTableScreen.open).toBe(false);
  });

  it('工作台界面里 3x3 摆出原木出木板，关闭后材料回背包', () => {
    // 脚下那块草换成原木挖来，掉进坑里之后正前方两格摆一个工作台
    const core = coreOnFlatGround();
    core.setBlock(...UNDERFOOT, BlockType.OakLog);
    digUnderfoot(core, BlockType.OakLog);
    core.setBlock(...AHEAD_FROM_PIT, BlockType.CraftingTable);
    look(core, 0, 0);
    core.tick();
    useOnce(core);
    expect(core.craftingTableScreen.open).toBe(true);

    // 原木放进 3x3 的正中那一格（第 4 格）
    const center = INVENTORY_SIZE + 4;
    core.clickSlot(0);
    core.clickSlot(center);
    core.tick();
    const crafting = core.craftingTableScreen.crafting!;
    expect(crafting.slot(4)).toEqual({ item: ItemType.OakLog, count: 1 });
    expect(crafting.output).toEqual({ item: ItemType.OakPlanks, count: 4 });
    expect(core.inventory.slot(0)).toBeUndefined();

    core.toggleInventory();
    core.tick();
    expect(core.craftingTableScreen.open).toBe(false);
    expect(crafting.slot(4)).toBeUndefined();
    expect(core.inventory.slot(0)).toEqual({ item: ItemType.OakLog, count: 1 });
  });

  it('工作台界面开着时点输出格拿走成品，关闭后成品进背包', () => {
    const core = coreOnFlatGround();
    core.setBlock(...UNDERFOOT, BlockType.OakLog);
    digUnderfoot(core, BlockType.OakLog);
    core.setBlock(...AHEAD_FROM_PIT, BlockType.CraftingTable);
    look(core, 0, 0);
    core.tick();
    useOnce(core);

    core.clickSlot(0);
    core.clickSlot(INVENTORY_SIZE);
    core.clickCraftingOutput();
    core.tick();
    expect(core.craftingTableScreen.cursor).toEqual({ item: ItemType.OakPlanks, count: 4 });

    core.toggleInventory();
    core.tick();
    expect(core.inventory.held).toEqual({ item: ItemType.OakPlanks, count: 4 });
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

describe('GameCore 的已改区块在玩家走远再回来之后', () => {
  /**
   * 这一节的视距（区块数）。
   * 收到 1 是为了让区块生成便宜些：这一节要走的是 20 个区块的往返，视距本身与卸载线的
   * 断言在上一节里。
   */
  const RETURN_RADIUS = 1;

  /** 走出去多少个区块才折返。 */
  const CHUNKS_TO_CROSS = 20;

  /**
   * 走一趟不该超过这么多 tick。
   * 20 个区块 = 320 格，按步行速度 74 秒；平地上没有要绕的东西，两倍是宽松的上界。
   */
  const MAX_WALK_TICKS = 150 * TICK_RATE;

  /** 视距收到 1 的平地核心。 */
  function coreForRoundTrip(): GameCore {
    return new GameCore({ viewRadius: RETURN_RADIUS, chunkSource: () => flatTestTerrain });
  }

  /**
   * 朝一个方向一直走，直到 done() 成立。
   *
   * 边走边跳：挖穿脚下之后玩家在一格深的坑里，不跳出不来。走满上界还不成立就报错，
   * 免得「没走到」被当成「走到了但断言恰好通过」。
   */
  function walkUntil(core: GameCore, direction: 'away' | 'back', done: () => boolean): void {
    const back = direction === 'back';
    for (let i = 0; i < MAX_WALK_TICKS && !done(); i++) {
      core.setMoveIntent({ ...IDLE_INTENT, forward: !back, back, jump: true });
      core.tick();
    }
    core.setMoveIntent(IDLE_INTENT);
    if (!done()) throw new Error(`走了 ${MAX_WALK_TICKS} tick 还没走到 ${direction}`);
  }

  /** 自己走出 20 个区块（原点那个因此早已卸载），再走回来到它重新加载。 */
  function roundTripFromOrigin(core: GameCore): void {
    expect(core.isChunkLoaded(0, 0)).toBe(true);
    // 走的方向由视角决定：先转回正北，这一路才是没动过的平地——刚放下的那块方块
    // 就在东边一格，朝它走会被自己放的东西挡住（坑里跳 1.25 格上不去两格高）。
    look(core, 0, 0);
    walkUntil(core, 'away', () => core.playerChunk.cz <= -CHUNKS_TO_CROSS);
    expect(core.isChunkLoaded(0, 0)).toBe(false);
    walkUntil(core, 'back', () => core.isChunkLoaded(0, 0));
  }

  it('挖掉脚下那块草，走远到那个区块卸载，再走回来那一格还是空气', () => {
    const core = coreForRoundTrip();
    digUnderfoot(core, BlockType.Grass);
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);

    roundTripFromOrigin(core);

    // 复用留着的那一份，而不是按种子重新生成——重新生成的话这里又是草
    expect(core.getBlock(...UNDERFOOT)).toBe(BlockType.Air);
  });

  it('把拾取到的泥土放在旁边，走远再走回来那一块还在', () => {
    const core = holdingDirt(coreForRoundTrip());
    core.use();
    core.tick();
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Dirt);

    roundTripFromOrigin(core);

    // 重新生成的话这里是空气：平地的地表只到 FLAT_GROUND_Y
    expect(core.getBlock(...ABOVE_ASIDE)).toBe(BlockType.Dirt);
  });
});
