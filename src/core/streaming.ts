import { UNLOAD_MARGIN } from './constants';
import { byDistanceTo, chunksAround, type ChunkCoord, type World } from './world';

/**
 * 让世界的已加载区块跟上一个中心区块：视距内缺的补上，太远的卸载。
 *
 * 加载范围是以中心为心、边长 2·radius+1 的方形（切比雪夫距离 ≤ radius），
 * 卸载线比它多留 UNLOAD_MARGIN 环。
 *
 * 缺的区块按到中心的距离由近到远向来源要。来源可以答「还没准备好」（浏览器里区块在
 * Worker 里生成），那这次就少加载几个，下次调用再问——所以这个函数每 tick 都该调，
 * 而不是只在玩家跨过区块边界时调。近的先问，Worker 那一侧的队列因此也是近的先生成，
 * 玩家脚下的地形不会等在一堆远处区块后面。
 */
export function streamChunks(world: World, center: ChunkCoord, radius: number): void {
  world.unloadOutside(center, radius + UNLOAD_MARGIN);

  const missing = chunksAround(center, radius).filter(
    ({ cx, cz }) => !world.isChunkLoaded(cx, cz),
  );
  if (missing.length === 0) return;

  missing.sort(byDistanceTo(center));
  for (const { cx, cz } of missing) world.loadChunk(cx, cz);
}
