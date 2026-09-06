import { CHUNK_SIZE } from '../core/constants';
import type { Vec3 } from '../core/vec3';
import {
  byDistanceTo,
  chunkKey,
  chunkOf,
  chunksAround,
  localOf,
  type ChunkCoord,
} from '../core/world';

/**
 * 一帧最多建几个区块的网格。
 *
 * 建一个区块的网格实测 1.3–1.6ms（桌面 Chrome，Node 里 4ms），两个加上这一帧本身的
 * 绘制仍在 60fps 的 16ms 预算里。玩家跨过一条区块边界时要补一整列区块（视距 8 是
 * 17 个），全挤在一帧里就是一次看得见的卡顿；摊到几十帧里则完全看不出来——走一格
 * 区块要 3.7 秒，有两百多帧可用。实测这个预算追得上走路：开局铺满视距要几秒，之后
 * 每跨一条区块边界积压跳到十几个，几帧内消掉，八成以上的帧一个都不欠
 * （tests/render/mesh-plan.test.ts）。
 */
export const MESH_BUDGET_PER_FRAME = 2;

/** 这一帧要建哪些区块的网格、要丢哪些。 */
export interface MeshPlan {
  /** 要建网格的区块，按到玩家的距离由近到远，长度不超过预算。 */
  readonly build: readonly ChunkCoord[];
  /** 要从场景里移除网格的区块。 */
  readonly drop: readonly ChunkCoord[];
}

/** 排网格计划只需要知道区块加载了没有。 */
export interface LoadedChunkView {
  isChunkLoaded(cx: number, cz: number): boolean;
}

export interface MeshPlanOptions {
  readonly world: LoadedChunkView;
  /** 已经有网格的区块。 */
  readonly meshed: Iterable<ChunkCoord>;
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
 * 两条规则：
 *
 * 1. **四个侧面的邻居都已加载才建网格。** 未加载的邻居读到空气，边界上那一整面
 *    石头都会被当成暴露面——一个四邻皆空的区块产生 8842 个面，四邻齐全时只有 273 个。
 *    等邻居到位再建，就不必在邻居后到时重建一遍，也不会把三十倍的几何送上显卡。
 *    代价是看得见的范围比加载范围小一圈。
 * 2. **一帧只建预算内的几个，先建离玩家近的。** 建一个区块的网格实测 1.3–1.6ms，
 *    跨过区块边界时一次要补一整列区块，全挤在一帧里就是一次可见的卡顿。
 *
 * 丢网格的条件只有「区块已经不在世界里了」。区块的卸载留了滞后（见 UNLOAD_MARGIN），
 * 所以在区块边界上来回走不会让边上那一圈网格反复拆建。
 */
export function planChunkMeshes({
  world,
  meshed,
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

  const buildable = chunksAround(center, radius).filter(
    ({ cx, cz }) => !meshedKeys.has(chunkKey(cx, cz)) && isMeshable(world, cx, cz),
  );
  if (buildable.length > 1) buildable.sort(byDistanceTo(center));
  return { build: buildable.slice(0, Math.max(budget, 0)), drop };
}

/**
 * 变过的方块让哪些区块的网格过期了。
 *
 * 方块自己那个区块一定要重建。它坐在区块边界上时，对面那个区块也要：边界上的面生不生成
 * 取决于隔壁那一格是什么（见 `buildChunkMesh`），只重建自己就会在挖开的地方留下一个
 * 看穿到虚空的洞，或者留下一堵本该消失的墙。
 *
 * 只看四个侧向的邻居，不看斜角：网格只问六个轴向的邻居，斜对角那一格与谁的面都无关。
 */
export function staleChunksFor(changed: Iterable<Vec3>): ChunkCoord[] {
  const stale = new Map<number, ChunkCoord>();
  const mark = (cx: number, cz: number): void => {
    stale.set(chunkKey(cx, cz), { cx, cz });
  };

  for (const { x, z } of changed) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const cx = chunkOf(bx);
    const cz = chunkOf(bz);
    mark(cx, cz);
    const lx = localOf(bx);
    const lz = localOf(bz);
    if (lx === 0) mark(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) mark(cx + 1, cz);
    if (lz === 0) mark(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) mark(cx, cz + 1);
  }
  return [...stale.values()];
}

/** 区块自己与四个侧面的邻居都已加载。 */
function isMeshable(world: LoadedChunkView, cx: number, cz: number): boolean {
  return (
    world.isChunkLoaded(cx, cz) &&
    world.isChunkLoaded(cx - 1, cz) &&
    world.isChunkLoaded(cx + 1, cz) &&
    world.isChunkLoaded(cx, cz - 1) &&
    world.isChunkLoaded(cx, cz + 1)
  );
}
