import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BlockType,
  LightPassage,
  baseBlock,
  blockAfterMining,
  blockDrop,
  blockExperience,
  canPlaceInto,
  isBreakable,
  isOpaque,
  isSolid,
  miningTicks,
  placedBlock,
  sightPassesThrough,
} from '../../src/core/block';
import { chainConnectedBlocks } from '../../src/core/chain-mining';
import { GameCore } from '../../src/core/game';
import { BARE_HAND, ItemType, miningToolOf, stackLimit, toolOf, type MiningTool } from '../../src/core/item';
import { isFuel } from '../../src/core/smelting';
import { isTorch, torchOnFace, torchSupportCell } from '../../src/core/torch';
import type { Vec3 } from '../../src/core/vec3';
import { ITEM_NAMES } from '../../src/ui/strings';
import { aimAt, worldWithBlocks } from '../helpers/aiming';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain } from '../helpers/flat-terrain';
import {
  DANDELION,
  DANDELION_ITEM,
  FERN,
  FLOWERS,
  PLANTS,
  POPPY,
  POPPY_ITEM,
  REPLACEABLE_PLANTS,
  SHORT_GRASS,
  expectPlantsDefined,
  supportCell,
} from '../helpers/plants';

/**
 * 地表植物的方块表、支撑表、挖掘与「下面那格没了随之碎掉」（#80）。
 *
 * 数值按父 spec #72 的方块表写字面值：四种植物不实心、不挡光（与火把同一种透光方式）、硬度 0 按下即碎、经验 5；
 * 矮草与蕨什么都不掉、没有物品；蒲公英与虞美人掉它自己，有物品。玩家站在平地原点那一格中心 (0.5, 71, 0.5)。
 */

const G = FLAT_GROUND_Y;
const S = FLAT_STAND_Y;

const STONE_PICKAXE = miningToolOf({ item: ItemType.StonePickaxe, count: 1 });
const TOOLS: ReadonlyArray<[string, MiningTool]> = [
  ['空手', BARE_HAND],
  ['木镐', miningToolOf({ item: ItemType.WoodenPickaxe, count: 1 })],
  ['石镐', STONE_PICKAXE],
  ['木斧', miningToolOf({ item: ItemType.WoodenAxe, count: 1 })],
  ['木铲', miningToolOf({ item: ItemType.WoodenShovel, count: 1 })],
  ['木剑', miningToolOf({ item: ItemType.WoodenSword, count: 1 })],
];

const TORCHES = [
  BlockType.Torch,
  BlockType.WallTorchNegX,
  BlockType.WallTorchPosX,
  BlockType.WallTorchNegZ,
  BlockType.WallTorchPosZ,
] as const;

/** 平地核心。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 2, terrain: flatTerrain });
}

/** 让视线正对世界里的 point，推进一 tick 让目标按新视线重算。 */
function lookAt(game: GameCore, point: Vec3): void {
  aimAt(game, point);
  game.tick();
}

/** 掉落物各是什么、多少个、在哪一格。 */
function dropsOf(game: GameCore): Array<{ item: ItemType; count: number; cell: [number, number, number] }> {
  return game.drops.all().map((drop) => ({
    item: drop.item,
    count: drop.count,
    cell: [Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z)],
  }));
}

describe.each(PLANTS)('%s的方块表', (_name, plant) => {
  it('不实心、不是不透明方块、与火把同一种透光方式（不挡光）、不发光', () => {
    expectPlantsDefined();
    expect(isSolid(plant)).toBe(false);
    expect(isOpaque(plant)).toBe(false);
    expect(BLOCKS[plant].lightPassage).toBe(LightPassage.Clear);
    expect(BLOCKS[plant].lightPassage).toBe(BLOCKS[BlockType.Torch].lightPassage);
    expect(BLOCKS[plant].lightEmission).toBe(0);
  });

  it('硬度 0：拿什么都按下那一 tick 就碎，不损耗工具；给 5 点经验；挖掉原处是空气', () => {
    expectPlantsDefined();
    expect(BLOCKS[plant].hardness).toBe(0);
    for (const [label, tool] of TOOLS) expect(miningTicks(plant, tool), label).toBe(0);
    expect(blockExperience(plant)).toBe(5);
    expect(blockAfterMining(plant)).toBe(BlockType.Air);
  });

  it('视线选得中（不是视线穿过的方块），挖得掉；不是火把，归到它自己', () => {
    expectPlantsDefined();
    expect(sightPassesThrough(plant)).toBe(false);
    expect(isBreakable(plant)).toBe(true);
    expect(isTorch(plant)).toBe(false);
    expect(baseBlock(plant)).toBe(plant);
  });
});

describe('四种植物的掉落、物品与落点', () => {
  it('四个编号互不相同，也与已有的方块都不同', () => {
    expectPlantsDefined();
    const ids = PLANTS.map(([, block]) => block);
    expect(new Set(ids).size).toBe(4);
    const others = Object.values(BlockType).filter((block) => !ids.includes(block));
    expect(others.length + 4).toBe(Object.values(BlockType).length);
  });

  it.each(REPLACEABLE_PLANTS)('%s什么都不掉，拿什么挖都一样；放方块时可以替换它', (_name, plant) => {
    expectPlantsDefined();
    for (const [label, tool] of TOOLS) expect(blockDrop(plant, tool), label).toBeNull();
    expect(canPlaceInto(plant)).toBe(true);
  });

  it.each(FLOWERS)('%s掉 1 个它自己的物品，拿什么挖都一样；放下去是它自己；不能被放方块替换', (_name, flower, item) => {
    expectPlantsDefined();
    for (const [label, tool] of TOOLS) expect(blockDrop(flower, tool), label).toEqual({ item, count: 1 });
    expect(placedBlock(item)).toBe(flower);
    expect(canPlaceInto(flower)).toBe(false);
  });

  it('物品只有两种花：没有哪个物品放下去是矮草或蕨', () => {
    expectPlantsDefined();
    for (const item of Object.values(ItemType)) {
      expect(placedBlock(item), `物品 ${item}`).not.toBe(SHORT_GRASS);
      expect(placedBlock(item), `物品 ${item}`).not.toBe(FERN);
    }
    expect(DANDELION_ITEM).not.toBe(POPPY_ITEM);
  });

  it('两种花的物品叫蒲公英、虞美人，堆叠 64，不是工具，燃料格不收', () => {
    expectPlantsDefined();
    expect(ITEM_NAMES[DANDELION_ITEM]).toBe('蒲公英');
    expect(ITEM_NAMES[POPPY_ITEM]).toBe('虞美人');
    for (const [, , item] of FLOWERS) {
      expect(stackLimit(item)).toBe(64);
      expect(toolOf(item)).toBeUndefined();
      expect(isFuel(item)).toBe(false);
    }
  });

  it('连锁挖掘里同一种植物连成一片，不同种的植物不算同一类型', () => {
    expectPlantsDefined();
    const world = worldWithBlocks(
      [[0, 80, 0], SHORT_GRASS],
      [[1, 80, 0], SHORT_GRASS],
      [[2, 80, 0], FERN],
      [[0, 80, 1], DANDELION],
      [[0, 80, -1], POPPY],
    );
    expect(chainConnectedBlocks(world, { x: 0, y: 80, z: 0 })).toEqual([
      { x: 0, y: 80, z: 0 },
      { x: 1, y: 80, z: 0 },
    ]);
  });
});

describe('支撑表与几何无关（ADR-0012 补记）', () => {
  it('四种植物贴着下面那一格', () => {
    expectPlantsDefined();
    for (const [name, plant] of PLANTS) expect(supportCell(plant, 3, 71, -4), name).toEqual({ x: 3, y: 70, z: -4 });
  });

  it('五个火把编号贴着的那一格与火把自己那份表（torchSupportCell）相同', () => {
    for (const torch of TORCHES) {
      expect(supportCell(torch, 3, 71, -4), `编号 ${torch}`).toEqual(torchSupportCell(torch, 3, 71, -4));
    }
  });

  it('其余方块都不贴着哪一格：支撑表认的正好是火把与植物', () => {
    expectPlantsDefined();
    const plants = PLANTS.map(([, block]) => block);
    for (const block of Object.values(BlockType)) {
      const expected = isTorch(block) || plants.includes(block);
      expect(supportCell(block, 0, 0, 0) !== undefined, `编号 ${block}`).toBe(expected);
    }
  });

  it('火把那份表只认火把：植物没有火把的支撑格，任何一面放火把都不会得到植物编号', () => {
    expectPlantsDefined();
    for (const [name, plant] of PLANTS) expect(torchSupportCell(plant, 0, 0, 0), name).toBeUndefined();
    const normals: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    for (const normal of normals) {
      const block = torchOnFace(normal);
      if (block !== undefined) expect(isTorch(block), JSON.stringify(normal)).toBe(true);
    }
    expect(torchOnFace({ x: 0, y: 1, z: 0 })).toBe(BlockType.Torch);
  });
});

describe('挖地表植物', () => {
  /** 平地核心，(0, S, −1) 那一格是 plant（长在草方块上），视线对准它下半截。 */
  function facingPlant(plant: BlockType, tool?: ItemType): GameCore {
    const game = core();
    if (tool !== undefined) {
      game.giveItem(tool, 1);
      game.selectHotbarSlot(0);
    }
    expect(game.setBlock(0, S, -1, plant)).toBe(true);
    expect(game.getBlock(0, S, -1)).toBe(plant);
    lookAt(game, { x: 0.5, y: S + 0.25, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -1 });
    return game;
  }

  it.each(REPLACEABLE_PLANTS)('对着%s按下挖掘，一 tick 后碎：那格空气、没有掉落物、一个 5 点的经验球', (_name, plant) => {
    expectPlantsDefined();
    const game = facingPlant(plant);
    game.setMining(true);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(game.drops.count).toBe(0);
    expect(game.xpOrbs.all().map(({ amount }) => amount)).toEqual([5]);
    game.setMining(false);
    game.tick(20);
    expect(game.experience.total).toBe(5);
  });

  it.each(FLOWERS)('对着%s按下挖掘，一 tick 后碎：掉 1 个它的物品，一个 5 点的经验球', (_name, flower, item) => {
    expectPlantsDefined();
    const game = facingPlant(flower);
    game.setMining(true);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(dropsOf(game)).toEqual([{ item, count: 1, cell: [0, S, -1] }]);
    expect(game.xpOrbs.all().map(({ amount }) => amount)).toEqual([5]);
  });

  it('持石镐挖矮草：耐久不变', () => {
    expectPlantsDefined();
    const game = facingPlant(SHORT_GRASS, ItemType.StonePickaxe);
    game.setMining(true);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.StonePickaxe, count: 1 });
  });

  it('两个 tick 之间按下又松开挖掘键：花照样在下一 tick 碎掉', () => {
    expectPlantsDefined();
    const game = facingPlant(POPPY);
    game.setMining(true);
    game.setMining(false);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(dropsOf(game)).toEqual([{ item: POPPY_ITEM, count: 1, cell: [0, S, -1] }]);
  });
});

describe('下面那格没了，植物随之碎掉', () => {
  it.each(FLOWERS)('setBlock 把%s下面的草方块换成空气：花那格变空气，原位掉 1 个花物品', (_name, flower, item) => {
    expectPlantsDefined();
    const game = core();
    game.setBlock(3, S, 0, flower);
    expect(game.getBlock(3, S, 0)).toBe(flower);
    game.setBlock(3, G, 0, BlockType.Air);
    expect(game.getBlock(3, S, 0)).toBe(BlockType.Air);
    expect(dropsOf(game)).toEqual([{ item, count: 1, cell: [3, S, 0] }]);
  });

  it.each(REPLACEABLE_PLANTS)('setBlock 把%s下面的草方块换成空气：那格变空气，没有掉落物', (_name, plant) => {
    expectPlantsDefined();
    const game = core();
    game.setBlock(3, S, 0, plant);
    expect(game.getBlock(3, S, 0)).toBe(plant);
    game.setBlock(3, G, 0, BlockType.Air);
    expect(game.getBlock(3, S, 0)).toBe(BlockType.Air);
    expect(game.drops.count).toBe(0);
  });

  it('只看下面那一格：四周与上面的方块换成空气，植物不动', () => {
    expectPlantsDefined();
    const game = core();
    game.setBlock(3, S, 0, DANDELION);
    for (const [x, y, z] of [
      [2, G, 0],
      [4, G, 0],
      [3, G, 1],
      [3, G, -1],
      [2, S, 0],
      [3, S + 1, 0],
    ] as const) {
      game.setBlock(x, y, z, BlockType.Stone);
      game.setBlock(x, y, z, BlockType.Air);
    }
    expect(game.getBlock(3, S, 0)).toBe(DANDELION);
    expect(game.drops.count).toBe(0);
  });

  /**
   * 前方挖一个坑：(0, G, −1) 换成空气，(0, G, −2) 是泥土、上面长着 plant。视线越过坑看泥土朝 +Z 的侧面。
   */
  function dirtBehindPit(plant: BlockType): GameCore {
    const game = core();
    game.setBlock(0, G, -1, BlockType.Air);
    game.setBlock(0, G, -2, BlockType.Dirt);
    game.setBlock(0, S, -2, plant);
    expect(game.getBlock(0, S, -2)).toBe(plant);
    lookAt(game, { x: 0.5, y: G + 0.5, z: -1.02 });
    expect(game.mining.target).toMatchObject({ x: 0, y: G, z: -2, normal: { x: 0, y: 0, z: 1 } });
    return game;
  }

  it('空手挖掉花下面的泥土：泥土与花各掉 1 个，花那格变空气', () => {
    expectPlantsDefined();
    const game = dirtBehindPit(DANDELION);
    game.setMining(true);
    game.tick(miningTicks(BlockType.Dirt, BARE_HAND));
    game.setMining(false);
    expect(game.getBlock(0, G, -2)).toBe(BlockType.Air);
    expect(game.getBlock(0, S, -2)).toBe(BlockType.Air);
    const items = dropsOf(game).map(({ item, count }) => ({ item, count }));
    expect(items).toContainEqual({ item: DANDELION_ITEM, count: 1 });
    expect(items).toContainEqual({ item: ItemType.Dirt, count: 1 });
    expect(items).toHaveLength(2);
  });

  it('空手挖掉矮草下面的泥土：矮草消失，只掉泥土', () => {
    expectPlantsDefined();
    const game = dirtBehindPit(SHORT_GRASS);
    game.setMining(true);
    game.tick(miningTicks(BlockType.Dirt, BARE_HAND));
    game.setMining(false);
    expect(game.getBlock(0, G, -2)).toBe(BlockType.Air);
    expect(game.getBlock(0, S, -2)).toBe(BlockType.Air);
    expect(dropsOf(game).map(({ item, count }) => ({ item, count }))).toEqual([{ item: ItemType.Dirt, count: 1 }]);
  });

  it('连锁挖掉一排石头：上面的三朵花都掉，三格矮草都消失', () => {
    expectPlantsDefined();
    for (const [plant, flowerDrops] of [
      [POPPY, 3],
      [SHORT_GRASS, 0],
    ] as const) {
      const game = core();
      game.giveItem(ItemType.StonePickaxe, 1);
      for (const x of [-1, 0, 1]) {
        game.setBlock(x, S, -2, BlockType.Stone);
        game.setBlock(x, S + 1, -2, plant);
      }
      lookAt(game, { x: 0.5, y: S + 0.5, z: -1.05 });
      expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -2 });

      game.setChainMining(true);
      game.setMining(true);
      game.tick(miningTicks(BlockType.Stone, STONE_PICKAXE));
      for (const x of [-1, 0, 1]) {
        expect(game.getBlock(x, S, -2), `编号 ${plant}`).toBe(BlockType.Air);
        expect(game.getBlock(x, S + 1, -2), `编号 ${plant}`).toBe(BlockType.Air);
      }
      const flowers = dropsOf(game).filter(({ item }) => item === POPPY_ITEM);
      expect(flowers.map(({ cell }) => cell[0]).sort(), `编号 ${plant}`).toEqual(flowerDrops ? [-1, 0, 1] : []);
      for (const { cell } of flowers) expect(cell.slice(1)).toEqual([S + 1, -2]);
    }
  });

  it('火把的支撑不变：地面火把下面那块挖掉，火把照样掉', () => {
    const game = core();
    game.setBlock(3, S, 0, BlockType.Torch);
    game.setBlock(3, G, 0, BlockType.Air);
    expect(game.getBlock(3, S, 0)).toBe(BlockType.Air);
    expect(dropsOf(game)).toEqual([{ item: ItemType.Torch, count: 1, cell: [3, S, 0] }]);
  });
});
