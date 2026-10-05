import { expect } from 'vitest';
import { BlockType } from '../../src/core/block';
import { ItemType } from '../../src/core/item';

/**
 * 一种树（#85）的三种方块与两种物品。橡树一行是现有的，白桦与云杉两行是 #85 追加的。
 *
 * 只按名称取编号，不写编号的值：方块与物品编号都是追加的，另一条切片（#74）也在追加，谁先合并编号就不同。
 */
export interface WoodSpecies {
  readonly name: string;
  readonly log: BlockType;
  readonly leaves: BlockType;
  readonly planks: BlockType;
  readonly logItem: ItemType;
  readonly planksItem: ItemType;
}

export const OAK: WoodSpecies = {
  name: '橡木',
  log: BlockType.OakLog,
  leaves: BlockType.OakLeaves,
  planks: BlockType.OakPlanks,
  logItem: ItemType.OakLog,
  planksItem: ItemType.OakPlanks,
};

export const BIRCH: WoodSpecies = {
  name: '白桦',
  log: BlockType.BirchLog,
  leaves: BlockType.BirchLeaves,
  planks: BlockType.BirchPlanks,
  logItem: ItemType.BirchLog,
  planksItem: ItemType.BirchPlanks,
};

export const SPRUCE: WoodSpecies = {
  name: '云杉',
  log: BlockType.SpruceLog,
  leaves: BlockType.SpruceLeaves,
  planks: BlockType.SprucePlanks,
  logItem: ItemType.SpruceLog,
  planksItem: ItemType.SprucePlanks,
};

/** #85 追加的两种树。 */
export const NEW_SPECIES: readonly WoodSpecies[] = [BIRCH, SPRUCE];

/** 三种树，橡树在前。 */
export const ALL_SPECIES: readonly WoodSpecies[] = [OAK, BIRCH, SPRUCE];

/** 三种木板物品，顺序同 `ALL_SPECIES`。 */
export const ALL_PLANKS: readonly ItemType[] = ALL_SPECIES.map((s) => s.planksItem);

/**
 * 这种树的方块与物品编号都已定义。编号未定义时后面的断言可能因为两边都是 undefined 而碰巧成立，
 * 所以每个用到新编号的测试先调它。
 */
export function expectDefined(species: WoodSpecies): void {
  for (const key of ['log', 'leaves', 'planks', 'logItem', 'planksItem'] as const) {
    expect(species[key], `${species.name}的 ${key} 未定义`).toBeTypeOf('number');
  }
}

/** 三种树的编号都已定义。 */
export function expectAllDefined(): void {
  for (const species of ALL_SPECIES) expectDefined(species);
}

/**
 * 给 `describe.each` / `it.each` 用的「名称, 树种」对，标题里用 `%s` 取名称。
 *
 * 不用 `$name`：vitest 把 `$` 后面连着的汉字也当成键名的一部分，`$name的原木` 会去取 `name的原木`。
 */
export function named(list: readonly WoodSpecies[]): Array<[string, WoodSpecies]> {
  return list.map((species) => [species.name, species]);
}
