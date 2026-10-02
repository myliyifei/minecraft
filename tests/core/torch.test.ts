import { describe, expect, it } from 'vitest';
import { baseBlock, BlockType, blockDrop, blockExperience, isOpaque, isSolid, miningTicks } from '../../src/core/block';
import { chainConnectedBlocks } from '../../src/core/chain-mining';
import { CRAFTING_TABLE_GRID, INVENTORY_CRAFTING_GRID } from '../../src/core/crafting-grid';
import { GameCore } from '../../src/core/game';
import { BARE_HAND, ItemType, miningToolOf, stackLimit, toolOf } from '../../src/core/item';
import { MAX_PITCH } from '../../src/core/player';
import { matchRecipe, recipesFor } from '../../src/core/recipe';
import { isFuel } from '../../src/core/smelting';
import { isTorch, torchSupportCell } from '../../src/core/torch';
import type { Vec3 } from '../../src/core/vec3';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTestTerrain } from '../helpers/flat-terrain';
import { worldWithBlocks } from '../helpers/aiming';

/*
 * 火把核心（#56）。玩家站在原点那一格中心 (0.5, 71, 0.5)，眼睛在 72.62。
 */

const G = FLAT_GROUND_Y;
const S = FLAT_STAND_Y;

const TORCHES = [
  BlockType.Torch,
  BlockType.WallTorchNegX,
  BlockType.WallTorchPosX,
  BlockType.WallTorchNegZ,
  BlockType.WallTorchPosZ,
] as const;

/** 平地核心。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 2, chunkSource: () => flatTestTerrain });
}

/** 让视线正对世界里的 point（眼睛到它的方向），推进一 tick 让目标按新视线重算。 */
function lookAt(game: GameCore, point: Vec3): void {
  const eye = game.player.eyePosition;
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  game.turn(yaw - game.player.yaw, pitch - game.player.pitch);
  game.tick();
}

/** 手上拿着 count 支火把的平地核心。 */
function holdingTorches(count = 4): GameCore {
  const game = core();
  expect(game.giveItem(ItemType.Torch, count)).toBe(0);
  game.selectHotbarSlot(0);
  game.tick();
  return game;
}

function useOnce(game: GameCore): void {
  game.use();
  game.tick();
}

/** 掉落物里的火把，各在哪一格。 */
function torchDrops(game: GameCore): Array<[number, number, number]> {
  return game.drops
    .all()
    .filter((drop) => drop.item === ItemType.Torch)
    .map((drop) => [Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z)]);
}

describe('火把的方块表与物品表（#56）', () => {
  it('五个编号：不实心、非不透明、硬度 0 按下即碎、掉 1 个火把、经验 0，都归到地面火把', () => {
    for (const block of TORCHES) {
      expect(isSolid(block), `编号 ${block}`).toBe(false);
      expect(isOpaque(block), `编号 ${block}`).toBe(false);
      expect(miningTicks(block, BARE_HAND), `编号 ${block}`).toBe(0);
      expect(miningTicks(block, miningToolOf({ item: ItemType.StonePickaxe, count: 1 })), `编号 ${block}`).toBe(0);
      expect(blockDrop(block, BARE_HAND)).toEqual({ item: ItemType.Torch, count: 1 });
      expect(blockExperience(block)).toBe(0);
      expect(baseBlock(block)).toBe(BlockType.Torch);
    }
  });

  it('支撑表与 baseBlock 认的是同一批火把：每个火把编号都贴着一格，其余方块都不贴', () => {
    for (const block of Object.values(BlockType)) {
      expect(torchSupportCell(block, 0, 0, 0) !== undefined, `编号 ${block}`).toBe(isTorch(block));
    }
    expect(Object.values(BlockType).filter(isTorch)).toEqual([...TORCHES]);
  });

  it('火把堆叠 64，不是工具，燃料格不收', () => {
    expect(stackLimit(ItemType.Torch)).toBe(64);
    expect(toolOf(ItemType.Torch)).toBeUndefined();
    expect(isFuel(ItemType.Torch)).toBe(false);
  });
});

describe('火把的合成（#56）', () => {
  const C = ItemType.Coal;
  const K = ItemType.Charcoal;
  const T = ItemType.Stick;
  const FOUR_TORCHES = { item: ItemType.Torch, count: 4 };

  it('2x2 里煤炭在上木棍在下输出 4 支火把，木炭同理，摆在哪一列都行', () => {
    expect(matchRecipe([C, undefined, T, undefined], INVENTORY_CRAFTING_GRID)).toEqual(FOUR_TORCHES);
    expect(matchRecipe([undefined, K, undefined, T], INVENTORY_CRAFTING_GRID)).toEqual(FOUR_TORCHES);
    // 3x3 也能做
    expect(
      matchRecipe([undefined, undefined, undefined, undefined, C, undefined, undefined, T, undefined], CRAFTING_TABLE_GRID),
    ).toEqual(FOUR_TORCHES);
  });

  it('横排、倒过来都不匹配', () => {
    expect(matchRecipe([C, T, undefined, undefined], INVENTORY_CRAFTING_GRID)).toBeUndefined();
    expect(matchRecipe([T, undefined, C, undefined], INVENTORY_CRAFTING_GRID)).toBeUndefined();
  });

  it('配方书里有两条火把：2x2 与 3x3 都列', () => {
    for (const size of [INVENTORY_CRAFTING_GRID, CRAFTING_TABLE_GRID]) {
      const torches = recipesFor(size).filter((recipe) => recipe.result.item === ItemType.Torch);
      expect(torches).toHaveLength(2);
      expect(torches.every((recipe) => recipe.result.count === 4)).toBe(true);
    }
  });
});

describe('火把的放置（#56）', () => {
  it('对着草方块顶面：上面那格是地面火把，数量减 1，那格方块光 14', () => {
    const game = holdingTorches();
    lookAt(game, { x: 0.5, y: G + 0.9, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: G, z: -1, normal: { x: 0, y: 1, z: 0 } });

    useOnce(game);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Torch);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 3 });
    expect(game.blockLightAt(0, S, -1)).toBe(14);
    expect(game.blockLightAt(0, S, -2)).toBe(13);
  });

  it('对着石墙的四个侧面：外侧那格是贴在这块石头那一侧的墙上火把', () => {
    // 石头在眼睛高度、离玩家两格，四个方向各摆一块，看的是朝玩家的那一面
    const cases: Array<[[number, number, number], Vec3, [number, number, number], BlockType]> = [
      [[2, S + 1, 0], { x: 2.05, y: S + 1.5, z: 0.5 }, [1, S + 1, 0], BlockType.WallTorchPosX],
      [[-2, S + 1, 0], { x: -1.05, y: S + 1.5, z: 0.5 }, [-1, S + 1, 0], BlockType.WallTorchNegX],
      [[0, S + 1, 2], { x: 0.5, y: S + 1.5, z: 2.05 }, [0, S + 1, 1], BlockType.WallTorchPosZ],
      [[0, S + 1, -2], { x: 0.5, y: S + 1.5, z: -1.05 }, [0, S + 1, -1], BlockType.WallTorchNegZ],
    ];
    for (const [stone, aim, cell, expected] of cases) {
      const game = holdingTorches();
      game.setBlock(...stone, BlockType.Stone);
      lookAt(game, aim);
      expect(game.mining.target, `石头在 ${stone.join(', ')}`).toMatchObject({ x: stone[0], y: stone[1], z: stone[2] });
      useOnce(game);
      expect(game.getBlock(...cell), `石头在 ${stone.join(', ')}`).toBe(expected);
      expect(game.blockLightAt(...cell)).toBe(14);
    }
  });

  it('对着底面、树叶、火把细杆都没有反应', () => {
    // 底面：头顶前方悬一块石头，从下面看它
    const below = holdingTorches();
    below.setBlock(0, S + 3, -1, BlockType.Stone);
    lookAt(below, { x: 0.5, y: S + 3.05, z: -0.5 });
    expect(below.mining.target).toMatchObject({ x: 0, y: S + 3, z: -1, normal: { x: 0, y: -1, z: 0 } });
    useOnce(below);
    expect(below.getBlock(0, S + 2, -1)).toBe(BlockType.Air);
    expect(below.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 4 });

    // 树叶顶面
    const leaves = holdingTorches();
    leaves.setBlock(0, S, -1, BlockType.OakLeaves);
    lookAt(leaves, { x: 0.5, y: S + 0.9, z: -0.5 });
    expect(leaves.mining.target).toMatchObject({ x: 0, y: S, z: -1 });
    useOnce(leaves);
    expect(leaves.getBlock(0, S + 1, -1)).toBe(BlockType.Air);
    expect(leaves.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 4 });

    // 火把细杆
    const stick = holdingTorches();
    stick.setBlock(0, S, -1, BlockType.Torch);
    lookAt(stick, { x: 0.5, y: S + 0.3, z: -0.5 });
    expect(stick.mining.target).toMatchObject({ x: 0, y: S, z: -1 });
    useOnce(stick);
    expect(stick.getBlock(0, S + 1, -1)).toBe(BlockType.Air);
    expect(stick.inventory.hotbar()[0]).toEqual({ item: ItemType.Torch, count: 4 });
  });

  it('站在坑里对着脚下放：火把落在玩家脚下那一格，碰撞箱重叠也放得下', () => {
    const game = holdingTorches();
    game.setBlock(0, G, 0, BlockType.Air);
    game.tick(20);
    expect(game.player.position.y).toBe(G);
    game.turn(0, -MAX_PITCH - game.player.pitch);
    game.tick();
    expect(game.mining.target).toMatchObject({ x: 0, y: G - 1, z: 0, normal: { x: 0, y: 1, z: 0 } });

    useOnce(game);
    expect(game.getBlock(0, G, 0)).toBe(BlockType.Torch);
    // 火把不实心：玩家还站在原处
    expect(game.player.position.y).toBe(G);
  });

  it('实心方块的交叠检查不变：站在坑里对着脚下放泥土放不下', () => {
    const game = core();
    game.giveItem(ItemType.Dirt, 1);
    game.setBlock(0, G, 0, BlockType.Air);
    game.tick(20);
    game.turn(0, -MAX_PITCH - game.player.pitch);
    game.tick();
    useOnce(game);
    expect(game.getBlock(0, G, 0)).toBe(BlockType.Air);
  });
});

describe('火把的视线（#56）', () => {
  /**
   * 正前方两格是一支立在石柱上的地面火把（细杆从 72 到 72.625，与眼睛同高），再往前两格是一堵石墙。
   */
  function torchBeforeWall(): GameCore {
    const game = holdingTorches();
    game.setBlock(0, S, -2, BlockType.Stone);
    game.setBlock(0, S + 1, -2, BlockType.Torch);
    game.setBlock(0, S + 1, -4, BlockType.Stone);
    return game;
  }

  it('视线从细杆旁穿过火把那一格：目标是后面那块墙，放置落在墙的外侧', () => {
    const game = torchBeforeWall();
    lookAt(game, { x: 0.85, y: S + 1.5, z: -3.05 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S + 1, z: -4, normal: { x: 0, y: 0, z: 1 } });

    useOnce(game);
    expect(game.getBlock(0, S + 1, -3)).toBe(BlockType.WallTorchNegZ);
    expect(game.getBlock(0, S + 1, -2)).toBe(BlockType.Torch);
  });

  it('正对细杆：目标是火把那一格，命中面是细杆朝玩家那一面', () => {
    const game = torchBeforeWall();
    lookAt(game, { x: 0.5, y: S + 1.3, z: -1.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S + 1, z: -2, normal: { x: 0, y: 0, z: 1 } });
  });
});

describe('火把的支撑（#56）', () => {
  it('地面火把下面那块挖掉：火把格变空气，原位有火把掉落物，方块光归 0', () => {
    const game = core();
    game.setBlock(3, S, 0, BlockType.Torch);
    expect(game.blockLightAt(3, S, 0)).toBe(14);

    game.setBlock(3, G, 0, BlockType.Air);
    expect(game.getBlock(3, S, 0)).toBe(BlockType.Air);
    expect(torchDrops(game)).toEqual([[3, S, 0]]);
    expect(game.blockLightAt(3, S, 0)).toBe(0);
    expect(game.blockLightAt(3, G, 0)).toBe(0);
  });

  it('墙上火把贴着的那块挖掉：火把掉；挖掉旁边无关的方块火把不动', () => {
    const game = core();
    // 石柱 (3, 71..72, 0)，墙上火把贴在它的 +X 面外侧
    game.setBlock(3, S, 0, BlockType.Stone);
    game.setBlock(3, S + 1, 0, BlockType.Stone);
    game.setBlock(4, S + 1, 0, BlockType.WallTorchNegX);

    // 无关的方块：火把正下方的地面、石柱下面那块
    game.setBlock(4, G, 0, BlockType.Air);
    game.setBlock(3, S, 0, BlockType.Air);
    expect(game.getBlock(4, S + 1, 0)).toBe(BlockType.WallTorchNegX);
    expect(torchDrops(game)).toEqual([]);

    game.setBlock(3, S + 1, 0, BlockType.Air);
    expect(game.getBlock(4, S + 1, 0)).toBe(BlockType.Air);
    expect(torchDrops(game)).toEqual([[4, S + 1, 0]]);
  });

  it('只看贴着它的那一支：同一块石头周围贴着别的方向的火把，换掉另一块不影响', () => {
    const game = core();
    game.setBlock(3, S + 1, 0, BlockType.Stone);
    game.setBlock(5, S + 1, 0, BlockType.Stone);
    // (4, 72, 0) 夹在两块石头之间，贴的是 −X 那块
    game.setBlock(4, S + 1, 0, BlockType.WallTorchNegX);
    game.setBlock(5, S + 1, 0, BlockType.Air);
    expect(game.getBlock(4, S + 1, 0)).toBe(BlockType.WallTorchNegX);
  });

  it('支撑换成树叶：火把也掉', () => {
    const game = core();
    game.setBlock(3, S, 0, BlockType.Torch);
    game.setBlock(3, G, 0, BlockType.OakLeaves);
    expect(game.getBlock(3, S, 0)).toBe(BlockType.Air);
    expect(torchDrops(game)).toEqual([[3, S, 0]]);
  });

  it('连锁挖掉一排石头，上面三支火把都掉', () => {
    const game = core();
    game.giveItem(ItemType.StonePickaxe, 1);
    for (const x of [-1, 0, 1]) {
      game.setBlock(x, S, -2, BlockType.Stone);
      game.setBlock(x, S + 1, -2, BlockType.Torch);
    }
    lookAt(game, { x: 0.5, y: S + 0.5, z: -1.05 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -2 });

    game.setChainMining(true);
    game.setMining(true);
    game.tick(miningTicks(BlockType.Stone, miningToolOf({ item: ItemType.StonePickaxe, count: 1 })));
    for (const x of [-1, 0, 1]) {
      expect(game.getBlock(x, S, -2)).toBe(BlockType.Air);
      expect(game.getBlock(x, S + 1, -2)).toBe(BlockType.Air);
    }
    expect(torchDrops(game).map(([x]) => x).sort()).toEqual([-1, 0, 1]);
  });
});

describe('挖火把（#56）', () => {
  it('对着火把按下挖掘一 tick：那格空气、有火把掉落物，手持石镐耐久不变、没有经验', () => {
    const game = core();
    game.giveItem(ItemType.StonePickaxe, 1);
    game.setBlock(0, S, -1, BlockType.Torch);
    lookAt(game, { x: 0.5, y: S + 0.3, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -1 });

    game.setMining(true);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(torchDrops(game)).toEqual([[0, S, -1]]);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.StonePickaxe, count: 1 });
    expect(game.xpOrbs.all()).toEqual([]);
    expect(game.experience.total).toBe(0);
  });

  it('持剑挖火把同样不损耗', () => {
    const game = core();
    game.giveItem(ItemType.WoodenSword, 1);
    game.setBlock(0, S, -1, BlockType.Torch);
    lookAt(game, { x: 0.5, y: S + 0.3, z: -0.5 });
    game.setMining(true);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.WoodenSword, count: 1 });
  });

  it('连锁挖一排火把：同一 tick 全掉，石镐耐久不变', () => {
    const game = core();
    game.giveItem(ItemType.StonePickaxe, 1);
    for (const x of [-1, 0, 1]) game.setBlock(x, S, -1, BlockType.Torch);
    lookAt(game, { x: 0.5, y: S + 0.3, z: -0.5 });
    game.setChainMining(true);
    game.setMining(true);
    game.tick();
    for (const x of [-1, 0, 1]) expect(game.getBlock(x, S, -1)).toBe(BlockType.Air);
    expect(torchDrops(game)).toHaveLength(3);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.StonePickaxe, count: 1 });
  });

  it('地面与墙上火把在连锁挖掘里算同一类型，与熄火、燃烧中的熔炉同一条规则', () => {
    const world = worldWithBlocks(
      [[0, 80, 0], BlockType.Torch],
      [[1, 80, 0], BlockType.WallTorchNegX],
      [[2, 80, 0], BlockType.WallTorchPosZ],
      [[3, 80, 0], BlockType.Stone],
    );
    expect(chainConnectedBlocks(world, { x: 0, y: 80, z: 0 })).toEqual([
      { x: 0, y: 80, z: 0 },
      { x: 1, y: 80, z: 0 },
      { x: 2, y: 80, z: 0 },
    ]);
  });
});

describe('火把与光照（#56）', () => {
  it('火把不挡天光：火把正下方那格天光仍 15', () => {
    const game = core();
    game.setBlock(0, S + 2, 3, BlockType.Torch);
    expect(game.skyLightAt(0, S + 2, 3)).toBe(15);
    expect(game.skyLightAt(0, S + 1, 3)).toBe(15);
    expect(game.skyLightAt(0, S, 3)).toBe(15);
  });
});

describe('火把与出生点、点按（#56 审查补充）', () => {
  it('出生点按最高的实心方块算：原点那一列插着地面火把、高处贴着墙上火把，出生点仍在地面上', () => {
    const game = core();
    expect(game.spawnPoint.y).toBe(S);
    game.setBlock(0, S, 0, BlockType.Torch);
    expect(game.spawnPoint.y).toBe(S);
    game.setBlock(1, 100, 0, BlockType.Stone);
    game.setBlock(0, 100, 0, BlockType.WallTorchPosX);
    expect(game.highestBlockY(0, 0)).toBe(100);
    expect(game.spawnPoint.y).toBe(S);
  });

  it('两个 tick 之间按下又松开挖掘键：火把照样在下一 tick 碎掉，掉 1 支、不损耗', () => {
    const game = core();
    game.giveItem(ItemType.StonePickaxe, 1);
    game.setBlock(0, S, -1, BlockType.Torch);
    lookAt(game, { x: 0.5, y: S + 0.3, z: -0.5 });
    game.setMining(true);
    game.setMining(false);
    game.tick();
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Air);
    expect(torchDrops(game)).toEqual([[0, S, -1]]);
    expect(game.inventory.hotbar()[0]).toEqual({ item: ItemType.StonePickaxe, count: 1 });
  });

  it('按下即碎的火把也报告为碎掉的方块（#60），下一 tick 清空', () => {
    const game = core();
    game.setBlock(0, S, -1, BlockType.Torch);
    lookAt(game, { x: 0.5, y: S + 0.3, z: -0.5 });
    expect(game.mining.target).toMatchObject({ x: 0, y: S, z: -1 });
    game.setMining(true);
    game.setMining(false);
    game.tick();
    expect(game.mining.broken).toEqual({ x: 0, y: S, z: -1, block: BlockType.Torch });
    game.tick();
    expect(game.mining.broken).toBeUndefined();
  });

  it('点按挖不动硬度大于 0 的方块：下一 tick 进度归零，石头还在', () => {
    const game = core();
    game.setBlock(0, S, -1, BlockType.Stone);
    lookAt(game, { x: 0.5, y: S + 0.5, z: -0.05 });
    game.setMining(true);
    game.setMining(false);
    game.tick(2);
    expect(game.getBlock(0, S, -1)).toBe(BlockType.Stone);
    expect(game.mining.progress).toBe(0);
  });
});
