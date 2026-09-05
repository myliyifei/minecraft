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

export interface BlockDef {
  /** 是否完全遮挡视线。false 的方块（空气、树叶）不会剔除邻居的面。 */
  readonly opaque: boolean;
  /**
   * 是否阻挡玩家与生物移动。
   * 与 `opaque` 是两件事：树叶不遮挡视线，但站在树冠里会被它挡住。
   */
  readonly solid: boolean;
}

/** 方块属性表。硬度、掉落表、经验表是后续切片往这里加的数据列。 */
export const BLOCKS: Readonly<Record<BlockType, BlockDef>> = {
  [BlockType.Air]: { opaque: false, solid: false },
  [BlockType.Grass]: { opaque: true, solid: true },
  [BlockType.Dirt]: { opaque: true, solid: true },
  [BlockType.Stone]: { opaque: true, solid: true },
  [BlockType.Bedrock]: { opaque: true, solid: true },
  [BlockType.OakLog]: { opaque: true, solid: true },
  [BlockType.OakLeaves]: { opaque: false, solid: true },
};

export function isAir(block: BlockType): boolean {
  return block === BlockType.Air;
}

/** 完全遮挡视线的方块会让邻居对应的面被剔除。 */
export function isOpaque(block: BlockType): boolean {
  return BLOCKS[block].opaque;
}

/** 阻挡移动的方块参与玩家的 AABB 碰撞。 */
export function isSolid(block: BlockType): boolean {
  return BLOCKS[block].solid;
}

/**
 * 按世界坐标读方块的最小接口。
 * 网格生成、射线检测这些只读消费者依赖它而不是 World 本身，便于用假数据测试。
 */
export interface BlockView {
  getBlock(x: number, y: number, z: number): BlockType;
}
