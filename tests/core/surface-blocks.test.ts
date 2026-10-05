import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BlockType,
  LightPassage,
  baseBlock,
  blockDrop,
  blockExperience,
  isBreakable,
  isOpaque,
  isSolid,
  miningTicks,
  placedBlock,
} from '../../src/core/block';
import { chainConnectedBlocks } from '../../src/core/chain-mining';
import { GameCore } from '../../src/core/game';
import {
  BARE_HAND,
  ItemType,
  ToolClass,
  ToolMaterial,
  stackLimit,
  type MiningTool,
} from '../../src/core/item';
import type { Vec3 } from '../../src/core/vec3';
import { ITEM_NAMES } from '../../src/ui/strings';
import { AIM_LAYER_Y, aimAt, worldWithBlocks, type BlockCoord } from '../helpers/aiming';
import { FLAT_GROUND_Y, flatTerrain } from '../helpers/flat-terrain';
import {
  GRAVEL,
  GRAVEL_ITEM,
  NEW_SURFACE_BLOCKS,
  SAND,
  SAND_ITEM,
  SNOWY_GRASS,
  expectSurfaceBlocksDefined,
} from '../helpers/surface-rules';

/**
 * 沙子、沙砾、雪草方块（#76）：挖掘、掉落、经验、放置、连锁挖掘，以及沙子与沙砾这一切片不下落。
 *
 * 数值按父 spec #72 的方块表写死字面值：沙子硬度 0.5、铲、掉自己、经验 30；沙砾硬度 0.6、铲、掉自己、经验 30；
 * 雪草方块硬度 0.6、铲、掉泥土、经验 30、没有物品。耗时按公式向上取整（硬度 × 30 ÷ 倍率）换算：
 * 硬度 0.5 空手 15 tick、木铲（倍率 2）8 tick、石铲（倍率 4）4 tick；硬度 0.6 空手 18 tick、木铲 9 tick、石铲 5 tick。
 */

function tool(toolClass: ToolClass, material: ToolMaterial, speed: number): MiningTool {
  return { toolClass, material, speed };
}

const WOODEN_SHOVEL = tool(ToolClass.Shovel, ToolMaterial.Wood, 2);
const STONE_SHOVEL = tool(ToolClass.Shovel, ToolMaterial.Stone, 4);
const WOODEN_PICKAXE = tool(ToolClass.Pickaxe, ToolMaterial.Wood, 2);
const WOODEN_AXE = tool(ToolClass.Axe, ToolMaterial.Wood, 2);
const ALL_TOOLS: ReadonlyArray<[string, MiningTool]> = [
  ['空手', BARE_HAND],
  ['木铲', WOODEN_SHOVEL],
  ['石铲', STONE_SHOVEL],
  ['木镐', WOODEN_PICKAXE],
  ['木斧', WOODEN_AXE],
];

/** 每种新方块的期望：硬度、空手、木铲、石铲、木镐的耗时，掉什么。 */
const TABLE: ReadonlyArray<
  readonly [name: string, block: () => BlockType, hardness: number, ticks: readonly number[], drop: () => ItemType]
> = [
  ['沙子', () => SAND, 0.5, [15, 8, 4, 15], () => SAND_ITEM],
  ['沙砾', () => GRAVEL, 0.6, [18, 9, 5, 18], () => GRAVEL_ITEM],
  ['雪草方块', () => SNOWY_GRASS, 0.6, [18, 9, 5, 18], () => ItemType.Dirt],
];

describe.each(TABLE)('%s的方块表', (name, block, hardness, [hand, wooden, stone, pickaxe], drop) => {
  it(`硬度 ${hardness}、合格工具是铲、不需要工具：空手 ${hand} tick，木铲 ${wooden} tick，石铲 ${stone} tick，木镐按空手算`, () => {
    expectSurfaceBlocksDefined();
    expect(BLOCKS[block()].hardness).toBe(hardness);
    expect(BLOCKS[block()].qualifiedToolClass).toBe(ToolClass.Shovel);
    expect(BLOCKS[block()].minimumMaterial).toBe(ToolMaterial.Wood);
    expect(BLOCKS[block()].requiresTool).toBe(false);
    expect(miningTicks(block(), BARE_HAND)).toBe(hand);
    expect(miningTicks(block(), WOODEN_SHOVEL)).toBe(wooden);
    expect(miningTicks(block(), STONE_SHOVEL)).toBe(stone);
    expect(miningTicks(block(), WOODEN_PICKAXE)).toBe(pickaxe);
  });

  it(`拿什么挖都掉 1 个${name === '雪草方块' ? '泥土' : name}`, () => {
    expectSurfaceBlocksDefined();
    for (const [toolName, held] of ALL_TOOLS) {
      expect(blockDrop(block(), held), toolName).toEqual({ item: drop(), count: 1 });
    }
  });

  it('给 30 点经验', () => {
    expectSurfaceBlocksDefined();
    expect(blockExperience(block())).toBe(30);
  });

  it('实心、不透明、挖得动、不发光，基础方块是它自己', () => {
    expectSurfaceBlocksDefined();
    expect(isSolid(block())).toBe(true);
    expect(isOpaque(block())).toBe(true);
    expect(isBreakable(block())).toBe(true);
    expect(BLOCKS[block()].lightPassage).toBe(LightPassage.Opaque);
    expect(BLOCKS[block()].lightEmission).toBe(0);
    expect(baseBlock(block())).toBe(block());
  });
});

describe('新方块的编号与新物品', () => {
  it('三种新方块的编号互不相同，也不与已有的方块重复', () => {
    expectSurfaceBlocksDefined();
    const ids = Object.values(BlockType);
    for (const [name, block] of NEW_SURFACE_BLOCKS) expect(ids, name).toContain(block);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('沙子与沙砾各是一种物品，放下去是对应的方块，堆叠上限 64，名称是「沙子」「沙砾」', () => {
    expectSurfaceBlocksDefined();
    expect(placedBlock(SAND_ITEM)).toBe(SAND);
    expect(placedBlock(GRAVEL_ITEM)).toBe(GRAVEL);
    expect(stackLimit(SAND_ITEM)).toBe(64);
    expect(stackLimit(GRAVEL_ITEM)).toBe(64);
    expect(ITEM_NAMES[SAND_ITEM]).toBe('沙子');
    expect(ITEM_NAMES[GRAVEL_ITEM]).toBe('沙砾');
  });

  it('雪草方块与草方块一样没有物品：没有哪种物品放下去是雪草方块', () => {
    expectSurfaceBlocksDefined();
    for (const item of Object.values(ItemType)) {
      expect(placedBlock(item), `物品 ${item}`).not.toBe(SNOWY_GRASS);
    }
  });

  it('新物品只有两个：放下去落在三种新方块里的物品正好是沙子与沙砾', () => {
    expectSurfaceBlocksDefined();
    const newBlocks = new Set<BlockType>(NEW_SURFACE_BLOCKS.map(([, block]) => block));
    const items = Object.values(ItemType).filter((item) => {
      const block = placedBlock(item);
      return block !== null && newBlocks.has(block);
    });
    expect(new Set(items)).toEqual(new Set([SAND_ITEM, GRAVEL_ITEM]));
  });

  it('沙子与沙砾放下去再空手挖掉，拿回同一种物品', () => {
    expectSurfaceBlocksDefined();
    for (const item of [SAND_ITEM, GRAVEL_ITEM]) {
      const block = placedBlock(item);
      expect(block).not.toBeNull();
      expect(blockDrop(block!, BARE_HAND)).toEqual({ item, count: 1 });
    }
  });
});

describe('连锁挖掘：雪草方块与草方块不算同一类型（父 spec #72）', () => {
  /** 空中一排：x 从 1 起往东。 */
  function row(i: number): Vec3 {
    return { x: 1 + i, y: AIM_LAYER_Y, z: 0 };
  }

  function at(cell: Vec3, block: BlockType): [BlockCoord, BlockType] {
    return [[cell.x, cell.y, cell.z], block];
  }

  it('一排两格草方块、两格雪草方块：从哪一段开始都只连上同种的那两格', () => {
    expectSurfaceBlocksDefined();
    const blocks = [BlockType.Grass, BlockType.Grass, SNOWY_GRASS, SNOWY_GRASS];
    const world = worldWithBlocks(...blocks.map((block, i) => at(row(i), block)));
    expect(chainConnectedBlocks(world, row(0))).toEqual([row(0), row(1)]);
    expect(chainConnectedBlocks(world, row(2))).toEqual([row(2), row(3)]);
  });

  it('沙子与沙砾之间、沙子与泥土之间也不连；同种的沙子照常连成一片', () => {
    expectSurfaceBlocksDefined();
    const world = worldWithBlocks(at(row(0), SAND), at(row(1), SAND), at(row(2), GRAVEL), at(row(3), BlockType.Dirt));
    expect(chainConnectedBlocks(world, row(0))).toEqual([row(0), row(1)]);
    expect(chainConnectedBlocks(world, row(2))).toEqual([row(2)]);
  });
});

describe('核心：挖雪草方块（#76）', () => {
  const G = FLAT_GROUND_Y;

  it('空手挖掉脚下一格雪草方块：掉 1 个泥土，生成一个 30 点的经验球', () => {
    expectSurfaceBlocksDefined();
    const core = new GameCore({ viewRadius: 1, terrain: flatTerrain });
    core.setBlock(0, G, 0, SNOWY_GRASS);
    // 低头对准脚下那块
    aimAt(core, { x: 0.5, y: G + 0.9, z: 0.5 });
    core.tick();
    core.setMining(true);
    for (let n = 0; n < 100 && core.getBlock(0, G, 0) === SNOWY_GRASS; n++) core.tick();
    core.setMining(false);

    expect(core.getBlock(0, G, 0)).toBe(BlockType.Air);
    expect(core.drops.all().map(({ item, count }) => ({ item, count }))).toEqual([{ item: ItemType.Dirt, count: 1 }]);
    expect(core.xpOrbs.all().map(({ amount }) => amount)).toEqual([30]);
  });
});

describe('核心：沙子与沙砾这一切片不下落（CONTEXT.md「重力方块」）', () => {
  const G = FLAT_GROUND_Y;
  /** 玩家东边两格的那一列：下面一格泥土，上面一格沙子或沙砾，悬在平地上方。 */
  const COLUMN = { x: 2, z: 0 } as const;
  const SUPPORT_Y = G + 1;
  const FALLING_Y = G + 2;
  /** 挖掉之后再等这么多 tick：真会下落的话早就落下去了。 */
  const SETTLE_TICKS = 40;

  /** 两种重力方块。编号在用例里才取：未定义时只让用例失败。 */
  const FALLING_BLOCKS: ReadonlyArray<readonly [string, () => BlockType]> = [
    ['沙子', () => SAND],
    ['沙砾', () => GRAVEL],
  ];

  function coreWith(falling: BlockType): GameCore {
    const core = new GameCore({ viewRadius: 1, terrain: flatTerrain });
    core.setBlock(COLUMN.x, SUPPORT_Y, COLUMN.z, BlockType.Dirt);
    core.setBlock(COLUMN.x, FALLING_Y, COLUMN.z, falling);
    return core;
  }

  it.each(FALLING_BLOCKS)('空手挖掉%s下面那格泥土：它仍停在原处，下面那格是空气', (_name, falling) => {
    expectSurfaceBlocksDefined();
    const core = coreWith(falling());
    // 平视对准泥土朝玩家的那一面（−X 面）的中心
    aimAt(core, { x: COLUMN.x + 0.05, y: SUPPORT_Y + 0.5, z: COLUMN.z + 0.5 });
    core.tick();
    core.setMining(true);
    for (let n = 0; n < 100 && core.getBlock(COLUMN.x, SUPPORT_Y, COLUMN.z) === BlockType.Dirt; n++) core.tick();
    core.setMining(false);
    expect(core.getBlock(COLUMN.x, SUPPORT_Y, COLUMN.z), '下面那格挖掉了').toBe(BlockType.Air);

    core.tick(SETTLE_TICKS);
    expect(core.getBlock(COLUMN.x, FALLING_Y, COLUMN.z)).toBe(falling());
    expect(core.getBlock(COLUMN.x, SUPPORT_Y, COLUMN.z)).toBe(BlockType.Air);
  });

  it.each(FALLING_BLOCKS)('经 setBlock 把%s下面那格换成空气：它仍停在原处', (_name, falling) => {
    expectSurfaceBlocksDefined();
    const core = coreWith(falling());
    core.setBlock(COLUMN.x, SUPPORT_Y, COLUMN.z, BlockType.Air);
    core.tick(SETTLE_TICKS);
    expect(core.getBlock(COLUMN.x, FALLING_Y, COLUMN.z)).toBe(falling());
    expect(core.getBlock(COLUMN.x, SUPPORT_Y, COLUMN.z)).toBe(BlockType.Air);
  });
});
