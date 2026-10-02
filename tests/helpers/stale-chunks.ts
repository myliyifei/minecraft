import type { ChunkCoord, StaleChunks } from '../../src/core/world';

/**
 * 两组过期区块合在一起：方块变了的在前，只有光照变了的在后。只关心「哪些区块的网格要重建」、
 * 不关心原因的测试用它。
 */
export function allStale({ blocks, light }: StaleChunks): ChunkCoord[] {
  return [...blocks, ...light];
}
