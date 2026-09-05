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
  readonly id: BlockType;
  /** 稳定的英文标识。界面显示名在 ui 层的字符串表里按它查。 */
  readonly key: string;
  /** 是否完全遮挡视线。false 的方块（空气、树叶）不会剔除邻居的面。 */
  readonly opaque: boolean;
}

/** 方块属性表。硬度、掉落表、经验表是后续切片往这里加的数据行。 */
export const BLOCKS: Readonly<Record<BlockType, BlockDef>> = {
  [BlockType.Air]: { id: BlockType.Air, key: 'air', opaque: false },
  [BlockType.Grass]: { id: BlockType.Grass, key: 'grass', opaque: true },
  [BlockType.Dirt]: { id: BlockType.Dirt, key: 'dirt', opaque: true },
  [BlockType.Stone]: { id: BlockType.Stone, key: 'stone', opaque: true },
  [BlockType.Bedrock]: { id: BlockType.Bedrock, key: 'bedrock', opaque: true },
  [BlockType.OakLog]: { id: BlockType.OakLog, key: 'oak_log', opaque: true },
  [BlockType.OakLeaves]: { id: BlockType.OakLeaves, key: 'oak_leaves', opaque: false },
};

export function isAir(block: BlockType): boolean {
  return block === BlockType.Air;
}

/** 完全遮挡视线的方块会让邻居对应的面被剔除。 */
export function isOpaque(block: BlockType): boolean {
  return BLOCKS[block].opaque;
}

/**
 * 按世界坐标读方块的最小接口。
 * 网格生成、射线检测这些只读消费者依赖它而不是 World 本身，便于用假数据测试。
 */
export interface BlockView {
  getBlock(x: number, y: number, z: number): BlockType;
}
