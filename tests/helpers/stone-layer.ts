import { BlockType } from '../../src/core/block';

/**
 * 石层里可能出现的方块：石头，以及嵌在石头里的两种矿石（issue #31）。
 *
 * 矿脉的形状与分布断言在 tests/core/ore.test.ts。地形测试只检查石层除了石头就只有矿石，
 * 不检查某一格是不是正好有矿石——铁矿脉每区块约 100 条（#47），石层里任何一格都可能是矿石。
 */
export const STONE_LAYER: ReadonlySet<BlockType> = new Set([
  BlockType.Stone,
  BlockType.CoalOre,
  BlockType.IronOre,
]);
