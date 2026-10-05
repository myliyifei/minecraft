import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, type Terrain, type TerrainGenerator } from '../../src/core/terrain';
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

/**
 * 高度场的实心段查询（`Terrain.isSolidSpan`）：每一列地表高度及以下都是地形方块，没有悬垂。
 * 平地与合成地表的地形对象、水塘放置输入用它。
 */
export function solidUpToSurface(surfaceHeightAt: (x: number, z: number) => number): Terrain['isSolidSpan'] {
  return (x, z, _fromY, toY) => toY <= surfaceHeightAt(x, z);
}

/** 测试世界加载的区块半径。3×3 个区块够物理测试走上一阵，也不必等生成太久。 */
const TEST_CHUNK_RADIUS = 1;

/**
 * 原点周围 3×3 个区块已加载好的固定平地世界。
 * 物理测试拿它当地面，再用 `setBlock` 手工摆墙与台阶——碰撞因此是对真实的
 * `World` 断言，而不是对一个另写的假方块视图。
 *
 * `radius` 换一个更大的半径：僵尸的游走与消失要在几十格外测，3×3 个区块装不下。
 */
export function flatTestWorld(radius = TEST_CHUNK_RADIUS): World {
  const world = new World(flatTestTerrain);
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      world.loadChunk(cx, cz);
    }
  }
  return world;
}

/**
 * 测试用平地的地形对象（#73）：生成器是 `flatTestTerrain`，群系总是平原，地表高度总是 `FLAT_GROUND_Y`，
 * 列顶地表方块总是草方块，出生列是原点。
 *
 * 核心只接地形对象（`GameCoreOptions.terrain`），核心级测试要一块平地时传它：只换生成器不换查询的话，
 * 出生列与树会按真实地形去算。签名与 `GameCoreOptions.terrain` 相同，拿到的是本世界的种子。
 */
export function flatTerrain(seed: number): Terrain {
  return {
    seed,
    generateChunk: flatTestTerrain,
    biomeAt: () => Biome.Plains,
    surfaceHeightAt: () => FLAT_GROUND_Y,
    surfaceBlockAt: () => BlockType.Grass,
    spawnColumn: { x: 0, z: 0 },
    isSolidSpan: solidUpToSurface(() => FLAT_GROUND_Y),
  };
}
