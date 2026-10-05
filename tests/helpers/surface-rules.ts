import { expect } from 'vitest';
import { BlockType } from '../../src/core/block';
import { ItemType } from '../../src/core/item';
import type { Terrain } from '../../src/core/terrain';

/**
 * 地表铺法（#76）的三种新方块、两种新物品与铺法的阈值。各测试文件共用。
 *
 * 只按名称取编号，不写编号的值：方块与物品编号都是追加的，别的切片也在追加，谁先合并编号就不同。
 * 按字符串键取而不是写 `BlockType.Sand`：新编号未定义时类型检查仍然通过，`npm run build`（端到端的生产预览要它）
 * 不因测试文件加载失败，测试按断言失败。编号定义好之后可以改回直接取属性。
 */
function blockNamed(name: string): BlockType {
  return (BlockType as Readonly<Record<string, BlockType>>)[name]!;
}

function itemNamed(name: string): ItemType {
  return (ItemType as Readonly<Record<string, ItemType>>)[name]!;
}

export const SAND = blockNamed('Sand');
export const GRAVEL = blockNamed('Gravel');
export const SNOWY_GRASS = blockNamed('SnowyGrass');
export const SAND_ITEM = itemNamed('Sand');
export const GRAVEL_ITEM = itemNamed('Gravel');

/** 三种新方块，标题里用的名称在前。 */
export const NEW_SURFACE_BLOCKS: ReadonlyArray<readonly [string, BlockType]> = [
  ['沙子', SAND],
  ['沙砾', GRAVEL],
  ['雪草方块', SNOWY_GRASS],
];

/**
 * 三种新方块与两种新物品的编号都已定义。编号未定义时后面的断言可能因为两边都是 undefined 而偶然成立，
 * 所以每个用到新编号的测试先调它。
 */
export function expectSurfaceBlocksDefined(): void {
  expect(SAND, '沙子的方块编号未定义').toBeTypeOf('number');
  expect(GRAVEL, '沙砾的方块编号未定义').toBeTypeOf('number');
  expect(SNOWY_GRASS, '雪草方块的方块编号未定义').toBeTypeOf('number');
  expect(SAND_ITEM, '沙子的物品编号未定义').toBeTypeOf('number');
  expect(GRAVEL_ITEM, '沙砾的物品编号未定义').toBeTypeOf('number');
}

/*
 * 铺法的阈值（测试设定）。
 */

/** 陡坡：与东南西北四个相邻列的地表高度差，最大的那个不小于它。 */
export const STEEP_RISE = 3;

/** 雪线：高山的顶面 y 不小于它铺雪草方块。 */
export const SNOW_LINE_Y = 150;

/** 被水覆盖的顶面 y 不小于它铺沙子（上面最多 7 格水），更低铺沙砾。 */
export const SHALLOW_MIN_Y = 56;

/** 沙滩的地表最高在海平面之上几格。 */
export const BEACH_MAX_ABOVE_SEA = 4;

/** 草方块与雪草方块之下的泥土层数。 */
export const DIRT_LAYERS_MIN = 3;
export const DIRT_LAYERS_MAX = 4;

/** 沙滩的顶层连同其下，至少几层是沙子；最多几层。 */
export const BEACH_SAND_LAYERS_MIN = 3;
export const BEACH_SAND_LAYERS_MAX = 6;

/** 一列与东南西北四个相邻列的地表高度差的绝对值里最大的那个。 */
export function maxNeighborRise(terrain: Terrain, x: number, z: number): number {
  const h = terrain.surfaceHeightAt(x, z);
  return Math.max(
    Math.abs(terrain.surfaceHeightAt(x + 1, z) - h),
    Math.abs(terrain.surfaceHeightAt(x - 1, z) - h),
    Math.abs(terrain.surfaceHeightAt(x, z + 1) - h),
    Math.abs(terrain.surfaceHeightAt(x, z - 1) - h),
  );
}

/** 这一列是陡坡。 */
export function isSteep(terrain: Terrain, x: number, z: number): boolean {
  return maxNeighborRise(terrain, x, z) >= STEEP_RISE;
}

/** 被水覆盖的顶面应铺的方块：浅处沙子，深处沙砾。 */
export function underwaterFloorAt(y: number): BlockType {
  return y >= SHALLOW_MIN_Y ? SAND : GRAVEL;
}

/** 方块名称，失败信息里用：新方块未定义时也读得懂。 */
export function blockName(block: BlockType | undefined): string {
  const entry = Object.entries(BlockType).find(([, id]) => id === block);
  return entry ? entry[0] : String(block);
}
