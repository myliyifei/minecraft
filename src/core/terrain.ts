import { BlockType } from './block';
import { Chunk } from './chunk';
import { DIRT_DEPTH, FLAT_SURFACE_Y, WORLD_MIN_Y } from './constants';

/**
 * 地形生成是纯函数：区块坐标决定区块内容，不依赖相邻区块的加载顺序。
 * issue #3 把种子加进签名，issue #6 让橡树以确定性方式跨区块写入。
 */
export type TerrainGenerator = (cx: number, cz: number) => Chunk;

/**
 * 硬编码平地：地表一层草方块、下面三层泥土、再往下石头、最底层基岩。
 */
export const flatTerrain: TerrainGenerator = (cx, cz) => {
  const chunk = new Chunk(cx, cz);
  chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);
  const stoneTop = FLAT_SURFACE_Y - DIRT_DEPTH - 1;
  for (let y = WORLD_MIN_Y + 1; y <= stoneTop; y++) {
    chunk.fillLayer(y, BlockType.Stone);
  }
  for (let y = stoneTop + 1; y < FLAT_SURFACE_Y; y++) {
    chunk.fillLayer(y, BlockType.Dirt);
  }
  chunk.fillLayer(FLAT_SURFACE_Y, BlockType.Grass);
  return chunk;
};
