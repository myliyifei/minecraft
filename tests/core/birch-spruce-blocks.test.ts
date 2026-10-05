import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  LightPassage,
  blockDrop,
  blockExperience,
  isOpaque,
  isSolid,
  miningTicks,
  placedBlock,
  type BlockType,
} from '../../src/core/block';
import { chainConnectedBlocks } from '../../src/core/chain-mining';
import {
  BARE_HAND,
  ItemType,
  ToolClass,
  ToolMaterial,
  stackLimit,
  type MiningTool,
} from '../../src/core/item';
import type { Vec3 } from '../../src/core/vec3';
import { AIM_LAYER_Y, worldWithBlocks, type BlockCoord } from '../helpers/aiming';
import { FLAT_GROUND_Y } from '../helpers/flat-terrain';
import { box, BUILDS } from '../helpers/light-scenes';
import {
  ALL_SPECIES,
  BIRCH,
  NEW_SPECIES,
  OAK,
  SPRUCE,
  expectAllDefined,
  expectDefined,
  named,
} from '../helpers/wood-species';

/**
 * 白桦与云杉的六种方块（#85）：挖掘、掉落、经验、透光、放置与连锁挖掘。
 *
 * 数值按父 spec #72 的方块表按字面值写：原木硬度 2、斧、掉自己、经验 60；木板硬度 2、斧、掉自己、经验 30；
 * 树叶硬度 0.2、没有合格工具、什么都不掉、经验 30。耗时按公式向上取整（硬度 × 30 ÷ 倍率）换算：
 * 硬度 2 空手 60 tick、木斧（倍率 2）30 tick、石斧（倍率 4）15 tick；硬度 0.2 空手与任何工具都是 6 tick。
 */

function tool(toolClass: ToolClass, material: ToolMaterial, speed: number): MiningTool {
  return { toolClass, material, speed };
}

const WOODEN_AXE = tool(ToolClass.Axe, ToolMaterial.Wood, 2);
const STONE_AXE = tool(ToolClass.Axe, ToolMaterial.Stone, 4);
const WOODEN_PICKAXE = tool(ToolClass.Pickaxe, ToolMaterial.Wood, 2);
const WOODEN_SHOVEL = tool(ToolClass.Shovel, ToolMaterial.Wood, 2);
const ALL_TOOLS: ReadonlyArray<[string, MiningTool]> = [
  ['空手', BARE_HAND],
  ['木斧', WOODEN_AXE],
  ['石斧', STONE_AXE],
  ['木镐', WOODEN_PICKAXE],
  ['木铲', WOODEN_SHOVEL],
];

describe.each(named(NEW_SPECIES))('%s的原木', (_name, species) => {
  it('硬度 2、合格工具是斧：空手 60 tick，木斧 30 tick，石斧 15 tick，木镐与木铲按空手算', () => {
    expectDefined(species);
    expect(miningTicks(species.log, BARE_HAND)).toBe(60);
    expect(miningTicks(species.log, WOODEN_AXE)).toBe(30);
    expect(miningTicks(species.log, STONE_AXE)).toBe(15);
    expect(miningTicks(species.log, WOODEN_PICKAXE)).toBe(60);
    expect(miningTicks(species.log, WOODEN_SHOVEL)).toBe(60);
  });

  it('不需要工具：拿什么挖都掉 1 个自己那种原木', () => {
    expectDefined(species);
    for (const [name, held] of ALL_TOOLS) {
      expect(blockDrop(species.log, held), name).toEqual({ item: species.logItem, count: 1 });
    }
  });

  it('给 60 点经验', () => {
    expectDefined(species);
    expect(blockExperience(species.log)).toBe(60);
  });

  it('实心、不透明，与橡木原木相同', () => {
    expectDefined(species);
    expect(isSolid(species.log)).toBe(true);
    expect(isOpaque(species.log)).toBe(true);
    expect(BLOCKS[species.log].lightPassage).toBe(LightPassage.Opaque);
  });
});

describe.each(named(NEW_SPECIES))('%s的木板', (_name, species) => {
  it('硬度 2、合格工具是斧：空手 60 tick，木斧 30 tick，石斧 15 tick，木镐按空手算', () => {
    expectDefined(species);
    expect(miningTicks(species.planks, BARE_HAND)).toBe(60);
    expect(miningTicks(species.planks, WOODEN_AXE)).toBe(30);
    expect(miningTicks(species.planks, STONE_AXE)).toBe(15);
    expect(miningTicks(species.planks, WOODEN_PICKAXE)).toBe(60);
  });

  it('不需要工具：拿什么挖都掉 1 块自己那种木板', () => {
    expectDefined(species);
    for (const [name, held] of ALL_TOOLS) {
      expect(blockDrop(species.planks, held), name).toEqual({ item: species.planksItem, count: 1 });
    }
  });

  it('给 30 点经验', () => {
    expectDefined(species);
    expect(blockExperience(species.planks)).toBe(30);
  });

  it('实心、不透明', () => {
    expectDefined(species);
    expect(isSolid(species.planks)).toBe(true);
    expect(isOpaque(species.planks)).toBe(true);
    expect(BLOCKS[species.planks].lightPassage).toBe(LightPassage.Opaque);
  });
});

describe.each(named(NEW_SPECIES))('%s的树叶', (_name, species) => {
  it('硬度 0.2、没有合格工具：空手与任何工具都是 6 tick', () => {
    expectDefined(species);
    for (const [name, held] of ALL_TOOLS) {
      expect(miningTicks(species.leaves, held), name).toBe(6);
    }
  });

  it('拿什么挖都什么都不掉', () => {
    expectDefined(species);
    for (const [name, held] of ALL_TOOLS) {
      expect(blockDrop(species.leaves, held), name).toBeNull();
    }
  });

  it('给 30 点经验', () => {
    expectDefined(species);
    expect(blockExperience(species.leaves)).toBe(30);
  });

  it('与橡树叶相同：实心、不遮挡视线、树叶式透光', () => {
    expectDefined(species);
    expect(isSolid(species.leaves)).toBe(true);
    expect(isOpaque(species.leaves)).toBe(false);
    expect(BLOCKS[species.leaves].lightPassage).toBe(LightPassage.Leaves);
    expect(BLOCKS[species.leaves].lightPassage).toBe(BLOCKS[OAK.leaves].lightPassage);
  });
});

describe('新物品与放置表', () => {
  it('两种原木、两种木板各是一种物品，放下去是对应的方块，堆叠上限 64', () => {
    for (const species of NEW_SPECIES) {
      expectDefined(species);
      expect(placedBlock(species.logItem), `${species.name}原木`).toBe(species.log);
      expect(placedBlock(species.planksItem), `${species.name}木板`).toBe(species.planks);
      expect(stackLimit(species.logItem)).toBe(64);
      expect(stackLimit(species.planksItem)).toBe(64);
    }
  });

  it('两种新树叶与橡树叶一样没有物品：没有哪种物品放下去是树叶', () => {
    expectAllDefined();
    const placed = new Set(Object.values(ItemType).map((item) => placedBlock(item)));
    for (const species of ALL_SPECIES) {
      expect(placed.has(species.leaves), `树叶方块 ${species.leaves}`).toBe(false);
    }
  });

  it('新物品只有四个：放下去落在六种新方块里的物品正好是两种原木、两种木板', () => {
    expectAllDefined();
    const newBlocks = new Set<BlockType>(
      NEW_SPECIES.flatMap((s) => [s.log, s.leaves, s.planks]),
    );
    const items = Object.values(ItemType).filter((item) => {
      const block = placedBlock(item);
      return block !== null && newBlocks.has(block);
    });
    expect(new Set(items)).toEqual(
      new Set([BIRCH.logItem, BIRCH.planksItem, SPRUCE.logItem, SPRUCE.planksItem]),
    );
  });

  it('三种原木、三种木板是六种不同的物品，也是六种不同的方块', () => {
    expectAllDefined();
    expect(new Set(ALL_SPECIES.flatMap((s) => [s.logItem, s.planksItem])).size).toBe(6);
    expect(new Set(ALL_SPECIES.flatMap((s) => [s.log, s.leaves, s.planks])).size).toBe(9);
  });

  it('放下去再空手挖掉，拿回同一种物品', () => {
    for (const species of NEW_SPECIES) {
      expectDefined(species);
      for (const item of [species.logItem, species.planksItem]) {
        const block = placedBlock(item);
        expect(block).not.toBeNull();
        expect(blockDrop(block!, BARE_HAND)).toEqual({ item, count: 1 });
      }
    }
  });
});

describe('连锁挖掘：三种原木不算同一类型（父 spec #72）', () => {
  const ROOT: Vec3 = { x: 3, y: AIM_LAYER_Y, z: 0 };

  /** 从 `ROOT` 往上第 i 格。 */
  function above(i: number): Vec3 {
    return { x: ROOT.x, y: ROOT.y + i, z: ROOT.z };
  }

  function at(cell: Vec3, block: BlockType): [BlockCoord, BlockType] {
    return [[cell.x, cell.y, cell.z], block];
  }

  it('一根树干自下而上两格橡木、两格白桦、两格云杉：从哪一段开始都只连上同一类型的那两格', () => {
    expectAllDefined();
    const blocks = [OAK.log, OAK.log, BIRCH.log, BIRCH.log, SPRUCE.log, SPRUCE.log];
    const world = worldWithBlocks(...blocks.map((block, i) => at(above(i), block)));
    expect(chainConnectedBlocks(world, above(0))).toEqual([above(0), above(1)]);
    expect(chainConnectedBlocks(world, above(2))).toEqual([above(2), above(3)]);
    expect(chainConnectedBlocks(world, above(4))).toEqual([above(4), above(5)]);
  });

  it('同一类型的白桦原木照常整根相连：一根 5 格白桦树干全部连上', () => {
    expectDefined(BIRCH);
    const cells = Array.from({ length: 5 }, (_, i) => above(i));
    const world = worldWithBlocks(...cells.map((cell) => at(cell, BIRCH.log)));
    expect(chainConnectedBlocks(world, ROOT)).toEqual(cells);
  });

  it('三种树叶、三种木板之间也不连', () => {
    expectAllDefined();
    for (const kind of ['leaves', 'planks'] as const) {
      const world = worldWithBlocks(...ALL_SPECIES.map((s, i) => at(above(i), s[kind])));
      for (let i = 0; i < ALL_SPECIES.length; i++) {
        expect(chainConnectedBlocks(world, above(i)), `${kind} 第 ${i} 格`).toEqual([above(i)]);
      }
    }
  });
});

describe.each(BUILDS)('两种新树叶的天光（%s）', (_name, build) => {
  const G = FLAT_GROUND_Y;

  it.each(named(NEW_SPECIES))('%s树叶一层之下 14，两层之下 13，与橡树叶相同', (_speciesName, species) => {
    expectDefined(species);
    // 25×25 的树叶，中央离边缘足够远，旁边露天的光绕进来不会比竖直穿过的更亮
    const oneLayer = build(box([-12, G + 5, -12], [12, G + 5, 12], species.leaves));
    expect(oneLayer.skyLightAt(0, G + 6, 0)).toBe(15);
    expect(oneLayer.skyLightAt(0, G + 5, 0)).toBe(14);
    expect(oneLayer.skyLightAt(0, G + 1, 0)).toBe(14);

    const twoLayers = build(box([-12, G + 5, -12], [12, G + 6, 12], species.leaves));
    expect(twoLayers.skyLightAt(0, G + 6, 0)).toBe(14);
    expect(twoLayers.skyLightAt(0, G + 5, 0)).toBe(13);
    expect(twoLayers.skyLightAt(0, G + 1, 0)).toBe(13);
  });

  it('橡树叶、白桦树叶、云杉树叶叠三层：每层减 1，最下面一层之下 12', () => {
    expectAllDefined();
    const world = build([
      ...box([-12, G + 7, -12], [12, G + 7, 12], OAK.leaves),
      ...box([-12, G + 6, -12], [12, G + 6, 12], BIRCH.leaves),
      ...box([-12, G + 5, -12], [12, G + 5, 12], SPRUCE.leaves),
    ]);
    expect(world.skyLightAt(0, G + 7, 0)).toBe(14);
    expect(world.skyLightAt(0, G + 6, 0)).toBe(13);
    expect(world.skyLightAt(0, G + 5, 0)).toBe(12);
    expect(world.skyLightAt(0, G + 1, 0)).toBe(12);
  });

  it('两种新原木与新木板不透光：一层 25×25 之下正中只剩从边缘横着绕进来的光，离最近的露天格 13 格，是 2', () => {
    expectAllDefined();
    for (const block of NEW_SPECIES.flatMap((s) => [s.log, s.planks])) {
      const world = build(box([-12, G + 5, -12], [12, G + 5, 12], block));
      expect(world.skyLightAt(0, G + 4, 0), `方块 ${block}`).toBe(2);
    }
  });
});
