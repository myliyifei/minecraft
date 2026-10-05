import { expect } from 'vitest';
import * as blockModule from '../../src/core/block';
import { BlockType } from '../../src/core/block';
import { ItemType } from '../../src/core/item';
import type { Vec3 } from '../../src/core/vec3';

/**
 * 地表植物（#80）的四种方块、两种物品与支撑表，各测试文件共用。
 *
 * 与 tests/helpers/surface-rules.ts 同一个理由按名称取：方块与物品编号都是追加的，谁先合并编号就不同；新编号未定义时
 * 类型检查仍然通过，`npm run build`（端到端的生产预览要它）不因测试文件加载失败，测试按断言失败。编号与函数定义好
 * 之后可以改回直接取属性。
 */
function blockNamed(name: string): BlockType {
  return (BlockType as Readonly<Record<string, BlockType>>)[name]!;
}

function itemNamed(name: string): ItemType {
  return (ItemType as Readonly<Record<string, ItemType>>)[name]!;
}

export const SHORT_GRASS = blockNamed('ShortGrass');
export const FERN = blockNamed('Fern');
export const DANDELION = blockNamed('Dandelion');
export const POPPY = blockNamed('Poppy');
export const DANDELION_ITEM = itemNamed('Dandelion');
export const POPPY_ITEM = itemNamed('Poppy');

/** 四种植物，标题里用的名称在前。 */
export const PLANTS: ReadonlyArray<readonly [string, BlockType]> = [
  ['矮草', SHORT_GRASS],
  ['蕨', FERN],
  ['蒲公英', DANDELION],
  ['虞美人', POPPY],
];

/** 两种花与它们的物品。 */
export const FLOWERS: ReadonlyArray<readonly [string, BlockType, ItemType]> = [
  ['蒲公英', DANDELION, DANDELION_ITEM],
  ['虞美人', POPPY, POPPY_ITEM],
];

/** 两种碎了不掉东西、放方块时被替换的植物。 */
export const REPLACEABLE_PLANTS: ReadonlyArray<readonly [string, BlockType]> = [
  ['矮草', SHORT_GRASS],
  ['蕨', FERN],
];

/** 四种植物的编号，未定义的不在里面（给只在实现之后才有意义的集合用，例如「地表之上允许出现的方块」）。 */
export const PLANT_BLOCKS: ReadonlySet<BlockType> = new Set(
  PLANTS.map(([, block]) => block).filter((block) => block !== undefined),
);

/** 是不是地表植物。编号未定义时一律 false。 */
export function isPlantBlock(block: BlockType): boolean {
  return PLANT_BLOCKS.has(block);
}

/**
 * 四种方块与两种物品的编号都已定义。编号未定义时后面的断言可能因为两边都是 undefined 而碰巧成立，
 * 所以每个用到新编号的测试先调它。
 */
export function expectPlantsDefined(): void {
  for (const [name, block] of PLANTS) expect(block, `${name}的方块编号未定义`).toBeTypeOf('number');
  expect(DANDELION_ITEM, '蒲公英的物品编号未定义').toBeTypeOf('number');
  expect(POPPY_ITEM, '虞美人的物品编号未定义').toBeTypeOf('number');
}

/** 支撑表（ADR-0012 补记）：方块 → 它贴着哪一格，与几何无关。 */
export type SupportCell = (block: BlockType, x: number, y: number, z: number) => Vec3 | undefined;

/** `src/core/block.ts` 导出的支撑表查询，未导出时 undefined。 */
export function supportCellFn(): SupportCell | undefined {
  return (blockModule as unknown as Readonly<Record<string, SupportCell | undefined>>)['supportCell'];
}

/** 支撑表查询，未导出时让用例失败。 */
export function supportCell(block: BlockType, x: number, y: number, z: number): Vec3 | undefined {
  const fn = supportCellFn();
  expect(fn, 'src/core/block.ts 没有导出 supportCell').toBeTypeOf('function');
  return fn!(block, x, y, z);
}
