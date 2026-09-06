import { BlockType } from '../../src/core/block';

/**
 * 地表之上允许出现的方块：空气，以及树。
 *
 * 「地表高度」说的是地形生成给出的地面（见 CONTEXT.md）。土石只在它之下，树长在它之上
 * ——地形与树的这条分界在几处测试里都要断言，所以放在一处。
 */
export const ABOVE_SURFACE: ReadonlySet<BlockType> = new Set([
  BlockType.Air,
  BlockType.OakLog,
  BlockType.OakLeaves,
]);
