import { UNLOAD_MARGIN } from './constants';
import type { ChunkCoord, World } from './world';

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
  unloadFarChunks(world, center, radius + UNLOAD_MARGIN);
  loadMissingChunks(world, center, radius);
}

/** 卸载切比雪夫距离超过 keepRadius 的区块。 */
function unloadFarChunks(world: World, center: ChunkCoord, keepRadius: number): void {
  world.forEachChunk(({ cx, cz }) => {
    const distance = Math.max(Math.abs(cx - center.cx), Math.abs(cz - center.cz));
    if (distance > keepRadius) world.unloadChunk(cx, cz);
  });
}

/** 把视距内还没加载的区块向来源要一遍，由近到远。 */
function loadMissingChunks(world: World, center: ChunkCoord, radius: number): void {
  const missing: ChunkCoord[] = [];
  for (let cx = center.cx - radius; cx <= center.cx + radius; cx++) {
    for (let cz = center.cz - radius; cz <= center.cz + radius; cz++) {
      if (!world.isChunkLoaded(cx, cz)) missing.push({ cx, cz });
    }
  }
  // 常态是一个都不缺，排序与遍历都省掉。
  if (missing.length === 0) return;

  // 按到中心的欧氏距离排（比切比雪夫距离更贴合视觉上的「近」，世界因此是从玩家
  // 脚下往外一圈圈长出来的）。平方距离即可，不必开根号。
  missing.sort(
    (a, b) => squaredDistance(a, center) - squaredDistance(b, center),
  );
  for (const { cx, cz } of missing) world.loadChunk(cx, cz);
}

function squaredDistance(a: ChunkCoord, b: ChunkCoord): number {
  const dx = a.cx - b.cx;
  const dz = a.cz - b.cz;
  return dx * dx + dz * dz;
}
