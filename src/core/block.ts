import { TICK_RATE } from './constants';

/**
 * 方块种类。数值直接存进区块的 Uint8Array，因此已发布的编号不可改动，新方块追加即可。
 */
export const BlockType = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Bedrock: 4,
  OakLog: 5,
  OakLeaves: 6,
} as const;

export type BlockType = (typeof BlockType)[keyof typeof BlockType];

/** 挖不动的方块的硬度。基岩是唯一一个。 */
export const UNBREAKABLE = Infinity;

export interface BlockDef {
  /** 是否完全遮挡视线。false 的方块（空气、树叶）不会剔除邻居的面。 */
  readonly opaque: boolean;
  /**
   * 是否阻挡玩家与生物移动。
   * 与 `opaque` 是两件事：树叶不遮挡视线，但站在树冠里会被它挡住。
   */
  readonly solid: boolean;
  /** 硬度（见 CONTEXT.md），挖掘耗时按它算。`UNBREAKABLE` 表示怎么挖都挖不掉。 */
  readonly hardness: number;
  /**
   * 挖它要对应的工具（石头要镐）。空手照样挖得动，只是慢得多——耗时从每点硬度
   * 1.5 秒变成 5 秒，石头因此是 150 tick 而不是 45。工具本身是 #8 之后的事。
   */
  readonly requiresTool: boolean;
}

/** 方块属性表。掉落表、经验表是后续切片往这里加的数据列。 */
export const BLOCKS: Readonly<Record<BlockType, BlockDef>> = {
  // 空气不是挖掘目标，硬度只是占位。
  [BlockType.Air]: { opaque: false, solid: false, hardness: 0, requiresTool: false },
  [BlockType.Grass]: { opaque: true, solid: true, hardness: 0.6, requiresTool: false },
  [BlockType.Dirt]: { opaque: true, solid: true, hardness: 0.5, requiresTool: false },
  [BlockType.Stone]: { opaque: true, solid: true, hardness: 1.5, requiresTool: true },
  [BlockType.Bedrock]: {
    opaque: true,
    solid: true,
    hardness: UNBREAKABLE,
    requiresTool: false,
  },
  [BlockType.OakLog]: { opaque: true, solid: true, hardness: 2, requiresTool: false },
  [BlockType.OakLeaves]: { opaque: false, solid: true, hardness: 0.2, requiresTool: false },
};

export function isAir(block: BlockType): boolean {
  return block === BlockType.Air;
}

/** 完全遮挡视线的方块会让邻居对应的面被剔除。 */
export function isOpaque(block: BlockType): boolean {
  return BLOCKS[block].opaque;
}

/** 阻挡移动的方块参与实体的碰撞箱判定。 */
export function isSolid(block: BlockType): boolean {
  return BLOCKS[block].solid;
}

/** 挖得动的方块。空气不是挖掘目标，基岩挖不动。 */
export function isBreakable(block: BlockType): boolean {
  return block !== BlockType.Air && BLOCKS[block].hardness !== UNBREAKABLE;
}

/** 空手挖一点硬度要多少秒。 */
const SECONDS_PER_HARDNESS = 1.5;

/** 需要工具而空着手时，一点硬度要多少秒。 */
const SECONDS_PER_HARDNESS_WITHOUT_TOOL = 5;

/**
 * 取整到 tick 时先减掉的容差。
 *
 * 硬度是 0.2、0.6 这类十进制小数，二进制存不精确：`0.2 × 1.5 × 20` 算出来是
 * 6.000000000000001，直接向上取整树叶就要挖 7 tick 而不是 6。容差比一个 tick 小得多，
 * 只吃掉舍入噪声，不改变任何本该取整的结果。
 */
const TICK_EPSILON = 1e-9;

/**
 * 空手挖掉一个方块要多少 tick，挖不动的返回 `Infinity`。
 *
 * 硬度换成耗时的公式在 `SECONDS_PER_HARDNESS` 那两个常量里，以 tick 计时向上取整。
 * 结果：草 18、泥土 15、树叶 6、原木 60、石头 150。
 * 持有工具时的加成要等快捷栏（#8）落地，本切片只有空手。
 */
export function miningTicks(block: BlockType): number {
  const { hardness, requiresTool } = BLOCKS[block];
  const seconds = requiresTool ? SECONDS_PER_HARDNESS_WITHOUT_TOOL : SECONDS_PER_HARDNESS;
  return Math.ceil(hardness * seconds * TICK_RATE - TICK_EPSILON);
}

/**
 * 按世界坐标读方块的最小接口。
 * 网格生成、射线检测这些只读消费者依赖它而不是 World 本身，便于用假数据测试。
 */
export interface BlockView {
  getBlock(x: number, y: number, z: number): BlockType;
}

/**
 * 按世界坐标读写方块的最小接口。
 * 挖掘要把方块改成空气，因此比只读的 `BlockView` 多一个写入；返回值表示这次写入
 * 落到世界里了没有（区块未加载、y 越界都算没落地）。
 */
export interface BlockEdit extends BlockView {
  setBlock(x: number, y: number, z: number, block: BlockType): boolean;
}
