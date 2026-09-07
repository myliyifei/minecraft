import { isBreakable, type BlockView } from './block';
import type { Vec3 } from './vec3';

/**
 * 一次连锁挖掘最多挖掉多少块，含起点那一块（见 CONTEXT.md 的「连锁挖掘」）。
 *
 * 上限本身是玩法上的取舍：没有它，一片相连的石头能一下挖穿半个区块。64 与背包一格的
 * 堆叠上限同一个数，一次连锁挖出来的东西刚好并成一堆。
 */
export const CHAIN_MINING_LIMIT = 64;

/**
 * 26 个方向的邻居偏移（六个面、十二条棱、八个角）。
 *
 * 顺序固定：dx、dy、dz 各从 −1 数到 1，跳过原点。连锁到了上限要按发现顺序截断，
 * 邻居的遍历顺序因此不能随手改——同一个世界、同一个起点必须每次给出同一个集合。
 */
const CHAIN_NEIGHBORS: readonly Vec3[] = chainNeighbors();

function chainNeighbors(): Vec3[] {
  const offsets: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0) offsets.push({ x: dx, y: dy, z: dz });
      }
    }
  }
  return offsets;
}

/**
 * 与起点同种、沿 26 个方向连通的方块，按广度优先的发现顺序排列，起点排在最前。
 *
 * 到了 `limit` 就停，因此截下来的是 BFS 距离最近的那些——广度优先是一层一层往外走的，
 * 先发现的一定不比后发现的远。起点是空气或挖不动的方块（基岩）时集合是空的。
 *
 * 搜索跨区块，未加载的区块自然成为边界：那里读出来的是空气（见 `World`），与任何
 * 挖得动的方块都不同种。判据是「方块种类完全相同」而不是「都是原木」——同种才连锁，
 * 挨着树干的树叶、挨着煤矿的石头都不跟着碎。
 *
 * 写成函数而不是类：它没有跨 tick 的状态，与 `raycastBlocks`、`placeBlock` 一样。
 */
export function chainConnectedBlocks(
  blocks: BlockView,
  origin: Vec3,
  limit: number = CHAIN_MINING_LIMIT,
): Vec3[] {
  const block = blocks.getBlock(origin.x, origin.y, origin.z);
  if (!isBreakable(block)) return [];

  const found: Vec3[] = [{ x: origin.x, y: origin.y, z: origin.z }];
  // 已经看过的格子，包括判定为异种的那些：同一格无论从哪个邻居走到，答案都一样，
  // 记下来就不必再读一次世界。键用 `"x,y,z"` 字符串——一次连锁最多问 64 × 26 次，
  // 不是网格生成那种热路径（同一条取舍见 `World.changed`）。
  const seen = new Set<string>([cellKey(origin)]);

  for (let head = 0; head < found.length && found.length < limit; head++) {
    const at = found[head]!;
    for (const offset of CHAIN_NEIGHBORS) {
      if (found.length >= limit) break;
      const next = { x: at.x + offset.x, y: at.y + offset.y, z: at.z + offset.z };
      const key = cellKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      if (blocks.getBlock(next.x, next.y, next.z) !== block) continue;
      found.push(next);
    }
  }
  return found;
}

function cellKey({ x, y, z }: Vec3): string {
  return `${x},${y},${z}`;
}
