import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import { ItemType } from '../../src/core/item';
import { IDLE_INTENT, MAX_PITCH, PLAYER_REACH } from '../../src/core/player';
import { raycastBlocks } from '../../src/core/raycast';
import type { Vec3 } from '../../src/core/vec3';
import { selectionBounds } from '../../src/render/selection';
import { AIM_EYE as EYE, AIM_LAYER_Y as L, aimAt, unit, worldWithBlocks } from '../helpers/aiming';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain, flatTestWorld } from '../helpers/flat-terrain';
import {
  DANDELION,
  DANDELION_ITEM,
  FERN,
  PLANTS,
  POPPY,
  POPPY_ITEM,
  REPLACEABLE_PLANTS,
  SHORT_GRASS,
  expectPlantsDefined,
} from '../helpers/plants';

/**
 * 地表植物的视线、选框与放置（#80，CONTEXT.md「目标方块」「放置」）。
 *
 * 命中盒的尺寸留给实现定（父 spec「数值留到实现时定」），这里只假设：盒子水平方向在格子的 [0.03, 0.97] 之内、
 * 高不超过 0.97，并且含格中心那一竖条从格底到 0.5 高。所以贴着格子边 0.02 以内或顶上 0.02 以内的视线穿过植物那一格，
 * 正对植物下半截的视线命中它。选框就是视线用的那个盒子。
 *
 * 核心级的用例在平地上：玩家站在原点那一格中心 (0.5, 71, 0.5)，眼睛在 72.62，草方块的顶面是 y 71。
 */

const G = FLAT_GROUND_Y;
const S = FLAT_STAND_Y;

/** 朝 +X 平视。 */
const EAST: Vec3 = { x: 1, y: 0, z: 0 };

describe('视线与地表植物的命中盒', () => {
  it.each(PLANTS)('正对%s的下半截：目标是植物那一格，命中面是盒子朝眼睛那一面，比整格的面远', (_name, plant) => {
    expectPlantsDefined();
    const world = worldWithBlocks([[2, L, 0], plant], [[4, L, 0], BlockType.Stone]);
    const direction = unit({ x: 2, y: -0.25, z: 0 });
    const hit = raycastBlocks(world, EYE, direction, PLAYER_REACH);
    expect(hit).toMatchObject({ x: 2, y: L, z: 0, normal: { x: -1, y: 0, z: 0 } });
    // 整格的 −X 面在 x = 2 上，沿这条视线 1.5 / cos ≈ 1.51；盒子比整格小，至少再远 0.03
    expect(hit!.distance).toBeGreaterThan(1.53 / direction.x);
    // 选框就是视线用的那个盒子：命中距离正好是到选框 −X 面的距离
    const box = selectionBounds(plant, 2, L, 0);
    expect(hit!.distance).toBeCloseTo((box.min.x - EYE.x) / direction.x, 6);
  });

  it.each(PLANTS)('视线贴着%s那一格的边穿过：碰不到命中盒，目标是后面的石头', (_name, plant) => {
    expectPlantsDefined();
    const world = worldWithBlocks([[2, L, 0], plant], [[4, L, 0], BlockType.Stone]);
    expect(world.getBlock(2, L, 0)).toBe(plant);
    const nearEdge = { x: EYE.x, y: EYE.y, z: 0.02 };
    expect(raycastBlocks(world, nearEdge, EAST, PLAYER_REACH)).toEqual({
      x: 4,
      y: L,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
      distance: 3.5,
    });
  });

  it.each(PLANTS)('视线从%s那一格的顶上 0.02 以内穿过：目标是后面的石头', (_name, plant) => {
    expectPlantsDefined();
    const world = worldWithBlocks([[2, L, 0], plant], [[4, L, 0], BlockType.Stone]);
    const nearTop = { x: EYE.x, y: L + 0.98, z: EYE.z };
    expect(raycastBlocks(world, nearTop, EAST, PLAYER_REACH)).toMatchObject({ x: 4, y: L, z: 0 });
  });

  it('从上往下看植物：命中盒子的顶面，目标是植物那一格', () => {
    expectPlantsDefined();
    const world = worldWithBlocks([[2, L, 0], SHORT_GRASS], [[2, L - 1, 0], BlockType.Stone]);
    const hit = raycastBlocks(world, { x: 2.5, y: L + 3.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, PLAYER_REACH);
    expect(hit).toMatchObject({ x: 2, y: L, z: 0, normal: { x: 0, y: 1, z: 0 } });
    // 盒子比整格矮：到顶面的距离大于到整格顶面的 2.5
    expect(hit!.distance).toBeGreaterThan(2.5);
    expect(hit!.distance).toBeCloseTo(L + 3.5 - selectionBounds(SHORT_GRASS, 2, L, 0).max.y, 6);
  });

  it('眼睛在植物那一格里：照常往前看，前方的石头是目标', () => {
    expectPlantsDefined();
    const world = worldWithBlocks([[0, L, 0], SHORT_GRASS], [[3, L, 0], BlockType.Stone]);
    expect(world.getBlock(0, L, 0)).toBe(SHORT_GRASS);
    expect(raycastBlocks(world, EYE, EAST, PLAYER_REACH)).toMatchObject({ x: 3, y: L, z: 0 });
  });

  it.each([
    ['两格外瞄准上排花瓣', 2.5, 0.53],
    ['两格外瞄准花心', 2.5, 0.41],
    ['三格外瞄准上排花瓣', 3.5, 0.53],
  ] as const)('平地上的花，%s：目标是花，不是后面的地面', (_name, eyeX, height) => {
    expectPlantsDefined();
    // 花瓣画在第 7 到 12 行（高 0.25 到 0.5625），瞄准点取上排花瓣与花心的高度（贴图与命中盒的对齐另见 plant-mesh 测试）
    for (const flower of [DANDELION, POPPY]) {
      const world = flatTestWorld();
      world.setBlock(0, S, 0, flower);
      const eye = { x: eyeX, y: S + 1.62, z: 0.5 };
      const target = { x: 0.5, y: S + height, z: 0.5 };
      const direction = unit({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
      expect(raycastBlocks(world, eye, direction, PLAYER_REACH), `编号 ${flower}`).toMatchObject({ x: 0, y: S, z: 0 });
    }
  });

  it('触及距离内只有植物而视线都从盒子旁边穿过时没有目标', () => {
    expectPlantsDefined();
    const world = worldWithBlocks([[1, L, 0], SHORT_GRASS], [[2, L, 0], FERN], [[3, L, 0], DANDELION], [[4, L, 0], POPPY]);
    expect(raycastBlocks(world, { x: EYE.x, y: EYE.y, z: 0.02 }, EAST, PLAYER_REACH)).toBeUndefined();
  });
});

describe('地表植物的选框', () => {
  it.each(PLANTS)('%s：选框立在格底，比整格小，水平方向在格子的 [0.03, 0.97] 之内，高 0.5 到 0.97', (_name, plant) => {
    expectPlantsDefined();
    const { min, max } = selectionBounds(plant, 3, 10, -4);
    expect(min.y).toBeCloseTo(10);
    expect(max.y).toBeGreaterThanOrEqual(10.5);
    expect(max.y).toBeLessThanOrEqual(10.97);
    for (const [lo, hi, cell] of [
      [min.x, max.x, 3],
      [min.z, max.z, -4],
    ] as const) {
      expect(lo).toBeGreaterThanOrEqual(cell + 0.03);
      expect(hi).toBeLessThanOrEqual(cell + 0.97);
      // 含格中心那一竖条
      expect(lo).toBeLessThan(cell + 0.5);
      expect(hi).toBeGreaterThan(cell + 0.5);
    }
  });
});

/** 平地核心。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 2, terrain: flatTerrain });
}

/** 让视线正对世界里的 point，推进一 tick 让目标按新视线重算。 */
function lookAt(game: GameCore, point: Vec3): void {
  aimAt(game, point);
  game.tick();
}

/** 手上拿着 count 个 item 的平地核心，选中第一格。 */
function holding(item: ItemType, count: number): GameCore {
  const game = core();
  expect(game.giveItem(item, count)).toBe(0);
  game.selectHotbarSlot(0);
  game.tick();
  return game;
}

function useOnce(game: GameCore): void {
  game.use();
  game.tick();
}

/** (0, S, −1) 那一格放 plant，视线对准它下半截，确认目标是它。 */
function aimAtPlantInFront(game: GameCore, plant: BlockType): void {
  expect(game.setBlock(0, S, -1, plant)).toBe(true);
  expect(game.getBlock(0, S, -1)).toBe(plant);
  lookAt(game, { x: 0.5, y: S + 0.25, z: -0.5 });
  expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -1 });
}

describe('对着矮草或蕨放方块：落点就是它那一格', () => {
  it.each(REPLACEABLE_PLANTS)('对着%s放圆石：那一格变成圆石，手持数量减 1', (_name, plant) => {
    expectPlantsDefined();
    const game = holding(ItemType.Cobblestone, 2);
    aimAtPlantInFront(game, plant);
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Cobblestone);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Cobblestone, count: 1 });
  });

  it.each(REPLACEABLE_PLANTS)('视线从%s的命中盒旁边打在下面草方块的顶面上放圆石：植物那格变成圆石', (_name, plant) => {
    expectPlantsDefined();
    const game = holding(ItemType.Cobblestone, 2);
    expect(game.setBlock(0, S, -1, plant)).toBe(true);
    expect(game.getBlock(0, S, -1)).toBe(plant);
    // 视线在 z = 0 处以 y ≈ 71.05 进入植物那一格，只在贴着 +Z 边 0.02 以内的地方穿过，落在草方块顶面 z ≈ −0.01 处
    lookAt(game, { x: 0.5, y: S - 0.05, z: -0.03 });
    expect(game.mining.target).toMatchObject({ x: 0, y: G, z: -1, normal: { x: 0, y: 1, z: 0 } });
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Cobblestone);
    expect(game.getBlock(0, S + 1, -1)).toBe(BlockType.Air);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Cobblestone, count: 1 });
  });

  it('玩家站在矮草那一格里：低头对着它放泥土放不下（与碰撞箱重叠），矮草还在；放火把可以（火把不实心）', () => {
    expectPlantsDefined();
    const game = holding(ItemType.Dirt, 1);
    game.giveItem(ItemType.Torch, 1);
    expect(game.setBlock(0, S, 0, SHORT_GRASS)).toBe(true);
    game.turn(0, -MAX_PITCH - game.player.pitch);
    game.tick();
    expect(game.mining.target).toMatchObject({ x: 0, y: S, z: 0, normal: { x: 0, y: 1, z: 0 } });

    useOnce(game);
    expect(game.getBlock(0, S, 0)).toBe(SHORT_GRASS);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Dirt, count: 1 });

    game.selectHotbarSlot(1);
    game.tick();
    useOnce(game);
    expect(game.getBlock(0, S, 0)).toBe(BlockType.Torch);
    expect(game.inventory.hotbar()[1]).toBeUndefined();
  });

  it('对着花放圆石：花不被替换', () => {
    expectPlantsDefined();
    const game = holding(ItemType.Cobblestone, 2);
    aimAtPlantInFront(game, DANDELION);
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(DANDELION);
  });
});

describe('种花', () => {
  it.each([
    ['草方块', BlockType.Grass],
    ['泥土', BlockType.Dirt],
    ['雪草方块', (BlockType as Readonly<Record<string, BlockType>>)['SnowyGrass']!],
  ] as const)('对着%s的顶面放蒲公英与虞美人：上面那一格是花，手持数量减 1', (_name, ground) => {
    expectPlantsDefined();
    for (const [item, flower] of [
      [DANDELION_ITEM, DANDELION],
      [POPPY_ITEM, POPPY],
    ] as const) {
      const game = holding(item, 2);
      game.setBlock(0, G, -1, ground);
      lookAt(game, { x: 0.5, y: S - 0.1, z: -0.5 });
      expect(game.mining.target).toMatchObject({ x: 0, y: G, z: -1, normal: { x: 0, y: 1, z: 0 } });
      useOnce(game);
      expect(game.getBlock(0, S, -1), `物品 ${item}`).toBe(flower);
      expect(game.inventory.hotbar()[0], `物品 ${item}`).toEqual({ item, count: 1 });
    }
  });

  it('种在石头上不放：那一格还是空气，花一个不少', () => {
    expectPlantsDefined();
    const game = holding(DANDELION_ITEM, 1);
    game.setBlock(0, G, -1, BlockType.Stone);
    lookAt(game, { x: 0.5, y: S - 0.1, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: G, z: -1, normal: { x: 0, y: 1, z: 0 } });
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(game.inventory.hotbar()[0]).toEqual({ item: DANDELION_ITEM, count: 1 });
  });

  it('放进水里不放：泥土上面那一格是水，对着水底泥土的顶面放花，那一格还是水', () => {
    expectPlantsDefined();
    const game = holding(POPPY_ITEM, 1);
    game.setBlock(0, G, -1, BlockType.Water);
    game.setBlock(0, G - 1, -1, BlockType.Dirt);
    lookAt(game, { x: 0.5, y: G - 0.1, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: G - 1, z: -1, normal: { x: 0, y: 1, z: 0 } });
    useOnce(game);
    expect(game.getBlock(0, G, -1)).toBe(BlockType.Water);
    expect(game.inventory.hotbar()[0]).toEqual({ item: POPPY_ITEM, count: 1 });
  });

  it('对着草方块上的矮草放花：花替换矮草', () => {
    expectPlantsDefined();
    const game = holding(DANDELION_ITEM, 1);
    aimAtPlantInFront(game, SHORT_GRASS);
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(DANDELION);
    expect(game.inventory.hotbar()[0]).toBeUndefined();
  });
});

describe('火把对着矮草或蕨放', () => {
  it.each(REPLACEABLE_PLANTS)('替换%s，立在下面草方块的顶面上：那一格是地面火把，方块光 14', (_name, plant) => {
    expectPlantsDefined();
    const game = holding(ItemType.Torch, 2);
    aimAtPlantInFront(game, plant);
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Torch);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 1 });
    expect(game.blockLightAt(0, S, -1)).toBe(14);
  });

  it('矮草下面那格不是不透明方块（树叶）时不放：矮草还在，火把一支不少', () => {
    expectPlantsDefined();
    const game = holding(ItemType.Torch, 1);
    game.setBlock(0, S, -1, BlockType.OakLeaves);
    expect(game.setBlock(0, S + 1, -1, SHORT_GRASS)).toBe(true);
    lookAt(game, { x: 0.5, y: S + 1.25, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S + 1, z: -1 });
    useOnce(game);
    expect(game.getBlock(0, S + 1, -1)).toBe(SHORT_GRASS);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 1 });
  });

  it('对着花放火把没有反应：花不是不透明方块', () => {
    expectPlantsDefined();
    const game = holding(ItemType.Torch, 1);
    aimAtPlantInFront(game, POPPY);
    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(POPPY);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 1 });
  });
});

describe('玩家穿过植物', () => {
  it('朝 +X 走过一排四种植物：一路走过去，脚底一直在草方块顶面上，植物都还在', () => {
    expectPlantsDefined();
    const game = core();
    const row = [SHORT_GRASS, FERN, DANDELION, POPPY, SHORT_GRASS, FERN];
    row.forEach((plant, i) => expect(game.setBlock(1 + i, S, 0, plant)).toBe(true));
    game.turn(-Math.PI / 2 - game.player.yaw, -game.player.pitch);
    game.setMoveIntent({ ...IDLE_INTENT, forward: true });
    for (let n = 0; n < 60; n++) {
      game.tick();
      expect(game.player.position.y, `第 ${n} tick`).toBe(S);
    }
    game.setMoveIntent(IDLE_INTENT);
    expect(game.player.position.x).toBeGreaterThan(1 + row.length);
    row.forEach((plant, i) => expect(game.getBlock(1 + i, S, 0)).toBe(plant));
  });
});
