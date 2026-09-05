import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { WORLD_MIN_Y } from '../../src/core/constants';
import type { TerrainGenerator } from '../../src/core/terrain';
import { World } from '../../src/core/world';

/** 测试用平地的地表高度。取一个海平面以上的值，与真实地形的量级一致。 */
export const FLAT_GROUND_Y = 70;

/** 站在测试用平地上时脚底所在的 y：地表方块的顶面。 */
export const FLAT_STAND_Y = FLAT_GROUND_Y + 1;

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

/** 测试世界加载的区块半径。3×3 个区块够物理测试走上一阵，也不必等生成太久。 */
const TEST_CHUNK_RADIUS = 1;

/**
 * 原点周围 3×3 个区块已加载好的固定平地世界。
 * 物理测试拿它当地面，再用 `setBlock` 手工摆墙与台阶——碰撞因此是对真实的
 * `World` 断言，而不是对一个另写的假方块视图。
 */
export function flatTestWorld(): World {
  const world = new World(flatTestTerrain);
  for (let cx = -TEST_CHUNK_RADIUS; cx <= TEST_CHUNK_RADIUS; cx++) {
    for (let cz = -TEST_CHUNK_RADIUS; cz <= TEST_CHUNK_RADIUS; cz++) {
      world.loadChunk(cx, cz);
    }
  }
  return world;
}
