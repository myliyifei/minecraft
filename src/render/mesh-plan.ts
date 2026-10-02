import { byDistanceTo, chunkKey, chunksAround, type ChunkCoord } from '../core/world';

/**
 * 一帧最多建几个区块的网格。
 *
 * 建一个区块的网格在 Windows 上的 Edge 里实测 0.5–1ms（#62 之前 1.3–2.5ms），两个加上这一帧本身的
 * 绘制仍在 145Hz 的 6.9ms 预算里。只有光照变了的重建与新区块的首次建网格共用这个预算（见
 * `planChunkMeshes`）。玩家跨过一条区块边界时要补一整列区块（视距 8 是
 * 17 个），全挤在一帧里就是一次看得见的卡顿；摊到几十帧里则完全看不出来——走一格
 * 区块要 3.7 秒，有两百多帧可用。实测这个预算追得上玩家移动：开局铺满视距要几秒，之后
 * 每跨一条区块边界积压跳到十几个，几帧内消掉，八成以上的帧没有积压
 * （tests/render/mesh-plan.test.ts）。
 */
export const MESH_BUDGET_PER_FRAME = 2;

/** 这一帧要建哪些区块的网格、要重建哪些、要丢哪些、哪些推迟到下一帧。 */
export interface MeshPlan {
  /** 要建网格的区块，按到玩家的距离由近到远。 */
  readonly build: readonly ChunkCoord[];
  /**
   * 已有网格、过期了、8 个邻居都在、这一帧重建的区块：方块变了的全在里面，不论预算；只有光照变了的按预算，
   * 排在后面。
   */
  readonly rebuild: readonly ChunkCoord[];
  /** 要从场景里移除网格的区块。 */
  readonly drop: readonly ChunkCoord[];
  /** 只有光照变了、这一帧没轮到的区块，按到玩家的距离由近到远。下一帧作为 `staleLight` 交回来。 */
  readonly deferred: readonly ChunkCoord[];
}

/** 排网格计划只需要知道区块加载了没有。 */
export interface LoadedChunkView {
  isChunkLoaded(cx: number, cz: number): boolean;
}

export interface MeshPlanOptions {
  readonly world: LoadedChunkView;
  /** 已经有网格的区块。 */
  readonly meshed: Iterable<ChunkCoord>;
  /** 核心报告方块变了的区块（`StaleChunks.blocks`），可以含没有网格、没加载的。 */
  readonly staleBlocks?: Iterable<ChunkCoord>;
  /**
   * 只有光照变了的区块：核心这一帧报的（`StaleChunks.light`）加上上一帧推迟下来的（`MeshPlan.deferred`），
   * 可以有重复，可以含没有网格、没加载的。
   */
  readonly staleLight?: Iterable<ChunkCoord>;
  /** 玩家所在的区块。 */
  readonly center: ChunkCoord;
  /** 视距（区块数）。 */
  readonly radius: number;
  /** 这一帧最多建几个区块的网格。 */
  readonly budget: number;
}

/**
 * 排出这一帧的建网格计划。
 *
 * 三条规则：
 *
 * 1. **周围 8 个邻居（含对角）都已加载才建网格。** 未加载的邻居读到空气，边界上那一整面
 *    石头都会被当成暴露面——一个四邻皆空的区块产生 8842 个面，四邻齐全时只有 273 个。
 *    等邻居到位再建，就不必在邻居后到时重建一遍，也不会把三十倍的几何送上显卡。对角邻居
 *    不影响面数，但光照要从那里读（见 `isMeshable`）。代价是看得见的范围比加载范围小一圈。
 * 2. **方块变了的网格当帧重建，不论预算。** 挖掉的方块必须当帧就从画面上消失，放下的方块当帧就出现，
 *    边上露出或被挡住的那一面在隔壁区块里，同样当帧重建（哪些区块算方块变了由核心定，见 `World.staleBlocks`）。
 * 3. **其余的一帧只建预算内的几个，先建离玩家近的。** 方块变了的重建先用掉这一帧的预算，剩下的分给只有光照变了的
 *    重建与新区块的首次建网格，两者按离玩家的远近排在一起。建一个区块的网格实测约 0.5–1ms，跨过区块边界时一次要补
 *    一整列区块，放挖一支火把要重建最多 3×3 个区块，全挤在一帧里就是一次可见的卡顿（#62）。没轮到的光照重建推迟到
 *    下一帧，那几帧里画面上是旧的明暗。
 *
 * 丢网格的条件是「区块已经不在世界里了」。区块的卸载留了滞后（见 UNLOAD_MARGIN），
 * 所以在区块边界上来回走不会让边上那一圈网格反复拆建。
 *
 * 过期的重建同样要 8 个邻居都在——视距最外一圈的网格因为卸载的滞后还留着，它外侧的邻居却可能已经卸载，
 * 卸载时撤光又会让它过期。这时不重建，而是丢掉旧网格，等邻居回来再按第 1 条重新建。
 * 没有网格的过期区块不管，它按第 1 条等着。
 */
export function planChunkMeshes({
  world,
  meshed,
  staleBlocks = [],
  staleLight = [],
  center,
  radius,
  budget,
}: MeshPlanOptions): MeshPlan {
  const drop: ChunkCoord[] = [];
  // 每帧都要走一遍全部候选区块，键用 chunkKey 的数字而不是字符串，省掉这些分配。
  const meshedKeys = new Set<number>();
  for (const { cx, cz } of meshed) {
    meshedKeys.add(chunkKey(cx, cz));
    if (!world.isChunkLoaded(cx, cz)) drop.push({ cx, cz });
  }

  /** 过期的、有网格的区块：邻居都在就留给重建，缺邻居就丢掉旧网格。返回要不要重建。 */
  const keepOrDropStale = (cx: number, cz: number, key: number): boolean => {
    if (!meshedKeys.has(key) || !world.isChunkLoaded(cx, cz)) return false;
    if (isMeshable(world, cx, cz)) return true;
    drop.push({ cx, cz });
    meshedKeys.delete(key);
    return false;
  };

  const rebuild: ChunkCoord[] = [];
  const rebuilding = new Set<number>();
  for (const { cx, cz } of staleBlocks) {
    const key = chunkKey(cx, cz);
    if (rebuilding.has(key) || !keepOrDropStale(cx, cz, key)) continue;
    rebuild.push({ cx, cz });
    rebuilding.add(key);
  }

  // 按预算排队的两种：只有光照变了的重建在前，新区块在后，再按距离稳定排序——一样远时先重建。
  const queued: Array<{ readonly coord: ChunkCoord; readonly relight: boolean }> = [];
  const seen = new Set<number>(rebuilding);
  for (const { cx, cz } of staleLight) {
    const key = chunkKey(cx, cz);
    if (seen.has(key)) continue;
    seen.add(key);
    if (keepOrDropStale(cx, cz, key)) queued.push({ coord: { cx, cz }, relight: true });
  }
  for (const coord of chunksAround(center, radius)) {
    if (!meshedKeys.has(chunkKey(coord.cx, coord.cz)) && isMeshable(world, coord.cx, coord.cz)) {
      queued.push({ coord, relight: false });
    }
  }
  if (queued.length > 1) {
    const closer = byDistanceTo(center);
    queued.sort((a, b) => closer(a.coord, b.coord));
  }

  const build: ChunkCoord[] = [];
  const deferred: ChunkCoord[] = [];
  let left = Math.max(budget - rebuild.length, 0);
  for (const { coord, relight } of queued) {
    if (left > 0) {
      (relight ? rebuild : build).push(coord);
      left--;
    } else if (relight) {
      deferred.push(coord);
    }
  }
  return { build, rebuild, drop, deferred };
}

/**
 * 区块自己与周围 8 个邻居（含对角）都已加载。
 *
 * 对角也要：平滑光照（ADR-0016）给区块角上的顶点取亮度时要读斜对角那个区块里的方块与光照，
 * 光照也从对角区块传进来（ADR-0017）。
 */
function isMeshable(world: LoadedChunkView, cx: number, cz: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!world.isChunkLoaded(cx + dx, cz + dz)) return false;
    }
  }
  return true;
}
