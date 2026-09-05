import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { WORLD_MIN_Y } from '../../src/core/constants';
import type { TerrainGenerator } from '../../src/core/terrain';

/** 测试用平地的地表高度。取一个海平面以上的值，与真实地形的量级一致。 */
export const FLAT_GROUND_Y = 70;

/**
 * 测试用的平地地形：地表一层草、往下石头到底、最底层基岩。
 *
 * 区块索引、面剔除这类测试要的是一个形状可预测的世界，而不是真实地形。
 * 用固定平地，它们就不会随平原算法调参而失效；地形本身的断言在
 * `tests/core/terrain.test.ts` 里。
 */
export const flatTestTerrain: TerrainGenerator = (cx, cz) => {
  const chunk = new Chunk(cx, cz);
  chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);
  for (let y = WORLD_MIN_Y + 1; y < FLAT_GROUND_Y; y++) {
    chunk.fillLayer(y, BlockType.Stone);
  }
  chunk.fillLayer(FLAT_GROUND_Y, BlockType.Grass);
  return chunk;
};
