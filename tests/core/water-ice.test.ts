import { describe, expect, it } from 'vitest';
import { BlockType, miningTicks } from '../../src/core/block';
import { TICK_RATE } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import { Inventory } from '../../src/core/inventory';
import { BARE_HAND, ItemType, miningToolOf, type ItemStack } from '../../src/core/item';
import { hitboxAt, type Hitbox } from '../../src/core/physics';
import { placeBlock } from '../../src/core/placement';
import { MAX_PITCH, PLAYER_HEIGHT, PLAYER_REACH, PLAYER_WIDTH } from '../../src/core/player';
import { raycastBlocks, type BlockHit } from '../../src/core/raycast';
import type { Vec3 } from '../../src/core/vec3';
import {
  AIM_EYE as EYE,
  AIM_LAYER_Y as LAYER_Y,
  aimAt,
  worldWithBlocks,
  type BlockCoord,
} from '../helpers/aiming';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain } from '../helpers/flat-terrain';

/*
 * 水与冰的核心规则（#74）：视线穿过水、放置替换水、冰挖掉变水。全部在平地上用 `setBlock` 放出来验收，
 * 不依赖新地形；不断言具体的方块编号。方块表那几列的字面值在 tests/core/block.test.ts，天光在
 * tests/core/sky-light.test.ts，生成僵尸在 tests/core/zombie-spawn.test.ts，存档在 tests/storage/。
 */

const G = FLAT_GROUND_Y;

/** 朝 +X 平视。 */
const EAST: Vec3 = { x: 1, y: 0, z: 0 };

describe('目标方块的视线穿过水（#74）', () => {
  it('隔着两格水看后面的石头，目标是石头，命中面是它朝向眼睛的那一面', () => {
    const world = worldWithBlocks(
      [[1, LAYER_Y, 0], BlockType.Water],
      [[2, LAYER_Y, 0], BlockType.Water],
      [[3, LAYER_Y, 0], BlockType.Stone],
    );
    expect(raycastBlocks(world, EYE, EAST, PLAYER_REACH)).toEqual({
      x: 3,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
      // 起点在格中心，石头的 −X 面在 x = 3 上
      distance: 2.5,
    });
  });

  it('隔着两格水竖直往下看水底的石头，命中的是石头的顶面', () => {
    const world = worldWithBlocks(
      [[0, LAYER_Y - 1, 0], BlockType.Water],
      [[0, LAYER_Y - 2, 0], BlockType.Water],
      [[0, LAYER_Y - 3, 0], BlockType.Stone],
    );
    expect(raycastBlocks(world, EYE, { x: 0, y: -1, z: 0 }, PLAYER_REACH)).toMatchObject({
      x: 0,
      y: LAYER_Y - 3,
      z: 0,
      normal: { x: 0, y: 1, z: 0 },
    });
  });

  it('眼睛在水里时照常选目标：前方的石头是目标', () => {
    const world = worldWithBlocks(
      // 眼睛所在的那一格与前面一格都是水
      [[0, LAYER_Y, 0], BlockType.Water],
      [[1, LAYER_Y, 0], BlockType.Water],
      [[3, LAYER_Y, 0], BlockType.Stone],
    );
    expect(world.getBlock(Math.floor(EYE.x), Math.floor(EYE.y), Math.floor(EYE.z))).toBe(BlockType.Water);
    expect(raycastBlocks(world, EYE, EAST, PLAYER_REACH)).toMatchObject({
      x: 3,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
    });
  });

  it('水不会成为目标：触及距离内只有水时没有目标', () => {
    const water: Array<[BlockCoord, BlockType]> = [1, 2, 3, 4].map((x) => [[x, LAYER_Y, 0], BlockType.Water]);
    const world = worldWithBlocks(...water);
    expect(raycastBlocks(world, EYE, EAST, PLAYER_REACH)).toBeUndefined();
  });

  it('冰是目标：视线停在冰上，不穿过它', () => {
    const world = worldWithBlocks(
      [[2, LAYER_Y, 0], BlockType.Ice],
      [[3, LAYER_Y, 0], BlockType.Stone],
    );
    expect(raycastBlocks(world, EYE, EAST, PLAYER_REACH)).toMatchObject({
      x: 2,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
    });
  });
});

/*
 * 核心里的水池：玩家站在出生点 (0.5, FLAT_STAND_Y, 0.5)，东边 x 1 到 3、z −1 到 1 挖一个两格深的坑灌满水
 * （y 是 G − 1 与 G），坑底是平地原有的石头。玩家脚下那块草方块不动，人不在水里。
 */

/** 水池里的一格：两层水。 */
const POOL_X = [1, 2, 3] as const;
const POOL_Z = [-1, 0, 1] as const;
const POOL_Y = [G - 1, G] as const;

/** 水池正中那一列的坑底石头，以及它上面紧挨着的那一格水（放置的落点）。 */
const POOL_FLOOR: BlockCoord = [2, G - 2, 0];
const ABOVE_FLOOR: BlockCoord = [2, G - 1, 0];

/** 视距 1 的平地核心，东边灌好一池水。 */
function coreWithPool(): GameCore {
  const core = new GameCore({ viewRadius: 1, terrain: flatTerrain });
  for (const x of POOL_X) {
    for (const z of POOL_Z) {
      for (const y of POOL_Y) core.setBlock(x, y, z, BlockType.Water);
    }
  }
  return core;
}

/** 让视线对准坑底石头顶面的中心附近，推进一个 tick 让目标方块按新视线重算。 */
function aimAtPoolFloor(core: GameCore): void {
  aimAt(core, { x: POOL_FLOOR[0] + 0.5, y: POOL_FLOOR[1] + 0.9, z: POOL_FLOOR[2] + 0.5 });
  core.tick();
}

/** 按一次使用键并推进一个 tick。 */
function useOnce(core: GameCore): void {
  core.use();
  core.tick();
}

describe('核心里隔着水挖掘与放置（#74）', () => {
  it('站在池边看水底的石头，目标是坑底石头的顶面', () => {
    const core = coreWithPool();
    aimAtPoolFloor(core);
    expect(core.mining.target).toMatchObject({
      x: POOL_FLOOR[0],
      y: POOL_FLOOR[1],
      z: POOL_FLOOR[2],
      normal: { x: 0, y: 1, z: 0 },
    });
  });

  it('持木镐对着水底的石头挖掘：石头碎了掉出圆石，上面的水原样留着', () => {
    const core = coreWithPool();
    core.giveItem(ItemType.WoodenPickaxe, 1);
    aimAtPoolFloor(core);

    core.setMining(true);
    // 耗时表本身由 block.test 断言，这里只看挖掘这条线隔着水接得上
    core.tick(miningTicks(BlockType.Stone, miningToolOf(core.inventory.held)));
    core.setMining(false);

    expect(core.getBlock(...POOL_FLOOR)).not.toBe(BlockType.Stone);
    expect(core.drops.all().map(({ item }) => item)).toContain(ItemType.Cobblestone);
    for (const y of POOL_Y) expect(core.getBlock(POOL_FLOOR[0], y, POOL_FLOOR[2]), `y=${y}`).toBe(BlockType.Water);
  });

  it('对着水底石头的顶面放圆石：那一格水变成圆石，手持数量减 1', () => {
    const core = coreWithPool();
    core.giveItem(ItemType.Cobblestone, 2);
    aimAtPoolFloor(core);

    useOnce(core);
    expect(core.getBlock(...ABOVE_FLOOR)).toBe(BlockType.Cobblestone);
    expect(core.getBlock(...POOL_FLOOR)).toBe(BlockType.Stone);
    expect(core.inventory.held).toEqual({ item: ItemType.Cobblestone, count: 1 });
  });

  it('火把放不进水格：对着水底石头的顶面按使用键，那一格还是水，火把一支不少', () => {
    const core = coreWithPool();
    core.giveItem(ItemType.Torch, 1);
    aimAtPoolFloor(core);

    useOnce(core);
    expect(core.getBlock(...ABOVE_FLOOR)).toBe(BlockType.Water);
    expect(core.inventory.held).toEqual({ item: ItemType.Torch, count: 1 });
  });

  it('火把对着冰放没有反应：顶面与侧面都放不上，火把一支不少', () => {
    const core = new GameCore({ viewRadius: 1, terrain: flatTerrain });
    const ice: BlockCoord = [2, FLAT_STAND_Y, 0];
    core.setBlock(...ice, BlockType.Ice);
    core.giveItem(ItemType.Torch, 1);

    // 冰的顶面
    aimAt(core, { x: ice[0] + 0.5, y: ice[1] + 0.9, z: ice[2] + 0.5 });
    core.tick();
    expect(core.mining.target).toMatchObject({ x: ice[0], y: ice[1], z: ice[2], normal: { x: 0, y: 1, z: 0 } });
    useOnce(core);
    expect(core.getBlock(ice[0], ice[1] + 1, ice[2])).toBe(BlockType.Air);

    // 冰朝向玩家的 −X 面
    aimAt(core, { x: ice[0] + 0.05, y: ice[1] + 0.5, z: ice[2] + 0.5 });
    core.tick();
    expect(core.mining.target).toMatchObject({ x: ice[0], y: ice[1], z: ice[2], normal: { x: -1, y: 0, z: 0 } });
    useOnce(core);
    expect(core.getBlock(ice[0] - 1, ice[1], ice[2])).toBe(BlockType.Air);

    expect(core.getBlock(...ice)).toBe(BlockType.Ice);
    expect(core.inventory.held).toEqual({ item: ItemType.Torch, count: 1 });
  });
});

describe('放置的落点是水（#74）', () => {
  /** 目标方块：瞄准层里的一格石头；它 −X 面外侧那一格是水。 */
  const TARGET: BlockCoord = [3, LAYER_Y, 0];
  const WATER_CELL: BlockCoord = [2, LAYER_Y, 0];
  const HIT: BlockHit = { x: TARGET[0], y: TARGET[1], z: TARGET[2], normal: { x: -1, y: 0, z: 0 }, distance: 1 };

  /** 站在平地上的碰撞箱，离瞄准的那一层几格远。 */
  const STANDING: Hitbox = hitboxAt({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 }, PLAYER_WIDTH, PLAYER_HEIGHT);

  function placeInto(held: ItemStack, body: Hitbox) {
    const world = worldWithBlocks([TARGET, BlockType.Stone], [WATER_CELL, BlockType.Water]);
    const inventory = new Inventory();
    inventory.add(held);
    const placed = placeBlock(world, { target: HIT }, { hitbox: body }, inventory);
    return { world, inventory, placed };
  }

  it('落点是水时放下的方块替换那一格水', () => {
    const { world, inventory, placed } = placeInto({ item: ItemType.Dirt, count: 3 }, STANDING);
    expect(placed).toBe(true);
    expect(world.getBlock(...WATER_CELL)).toBe(BlockType.Dirt);
    expect(inventory.held).toEqual({ item: ItemType.Dirt, count: 2 });
  });

  it('与玩家碰撞箱重叠的水格放不了实心方块：那一格还是水，手上的一个不少', () => {
    // 玩家就站在那一格水里
    const inWater = hitboxAt({ x: WATER_CELL[0] + 0.5, y: LAYER_Y, z: 0.5 }, PLAYER_WIDTH, PLAYER_HEIGHT);
    const { world, inventory, placed } = placeInto({ item: ItemType.Dirt, count: 1 }, inWater);
    expect(placed).toBe(false);
    expect(world.getBlock(...WATER_CELL)).toBe(BlockType.Water);
    expect(inventory.held).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('火把的落点是水时不放，哪怕目标是不透明方块', () => {
    const { world, inventory, placed } = placeInto({ item: ItemType.Torch, count: 1 }, STANDING);
    expect(placed).toBe(false);
    expect(world.getBlock(...WATER_CELL)).toBe(BlockType.Water);
    expect(inventory.held).toEqual({ item: ItemType.Torch, count: 1 });
  });
});

describe('挖冰（#74）', () => {
  /** 经验球飞完全程要的 tick 数：玩家就在旁边，几 tick 就到。 */
  const ABSORB_TICKS = TICK_RATE;

  /** 冰空手挖满要多少 tick。字面值由 block.test 断言；用例里才求值，冰还没进方块表时只让用例失败。 */
  const iceTicks = (): number => miningTicks(BlockType.Ice, BARE_HAND);

  /** 平地核心，脚下那一层以 (0, 0) 为中心 (2r+1)² 格换成冰，低头对准脚下那块。 */
  function standingOnIce(radius: number): { core: GameCore; cells: BlockCoord[] } {
    const core = new GameCore({ viewRadius: 1, terrain: flatTerrain });
    const cells: BlockCoord[] = [];
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        cells.push([x, G, z]);
        core.setBlock(x, G, z, BlockType.Ice);
      }
    }
    core.turn(0, -MAX_PITCH);
    return { core, cells };
  }

  it('空手挖掉脚下一格冰：原处变成水，没有掉落物，生成一个 30 点的经验球，被吸收后经验加 30', () => {
    const { core } = standingOnIce(0);
    core.setMining(true);
    core.tick(iceTicks());
    core.setMining(false);

    expect(core.getBlock(0, G, 0)).toBe(BlockType.Water);
    expect(core.drops.count).toBe(0);
    expect(core.xpOrbs.all().map(({ amount }) => amount)).toEqual([30]);

    core.tick(ABSORB_TICKS);
    expect(core.experience.total).toBe(30);
    expect(core.drops.count).toBe(0);
  });

  it('持木镐挖冰同样什么都不掉，原处变成水', () => {
    const { core } = standingOnIce(0);
    core.giveItem(ItemType.WoodenPickaxe, 1);
    core.setMining(true);
    for (let n = 0; n < iceTicks() && core.getBlock(0, G, 0) === BlockType.Ice; n++) core.tick();
    core.setMining(false);

    expect(core.getBlock(0, G, 0)).toBe(BlockType.Water);
    expect(core.drops.count).toBe(0);
    expect(core.xpOrbs.count).toBe(1);
  });

  it('连锁挖掘一片 3×3 的冰：耗时等于单块，九格全部变成水，没有掉落物，每格各一个经验球', () => {
    const { core, cells } = standingOnIce(1);
    core.setMining(true);
    core.setChainMining(true);
    core.tick(iceTicks());
    core.setMining(false);
    core.setChainMining(false);

    for (const cell of cells) expect(core.getBlock(...cell), `(${cell.join(', ')})`).toBe(BlockType.Water);
    expect(core.drops.count).toBe(0);
    expect(core.xpOrbs.count).toBe(cells.length);

    core.tick(3 * ABSORB_TICKS);
    expect(core.experience.total).toBe(30 * cells.length);
  });
});
