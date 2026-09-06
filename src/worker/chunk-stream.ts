import { Chunk } from '../core/chunk';
import { chunkKey, type ChunkCoord, type ChunkSource } from '../core/world';
import type { ChunkWorkerPort } from './protocol';

/**
 * 进世界之前先等好的区块半径（区块数）。
 *
 * 出生点要有地形才算得出来，否则玩家一进世界就掉进「未加载即空气」的虚空。多等一圈是
 * 为了首帧不是一片虚空：网格要四邻齐全才建（见 `planChunkMeshes`），所以等半径 3
 * 才能铺出半径 2 的一片地。视距内其余的区块由 tick 逐步补上。
 */
export const SPAWN_READY_RADIUS = 3;

/**
 * 最多存多少个已经生成、还没被核心取走的区块。
 *
 * 正常情况下 Worker 送回来的区块会在下一个 tick（50ms 内）被核心取走。核心只请求视距
 * 内的区块，所以存量本来就有界；这个上限防的是另一种情形：区块送到之后玩家恰好走出了
 * 它的视距，再没人取它，于是它一直占着 96KB。丢掉的区块下次要用时重新生成一次即可
 * （0.23ms），地形是纯函数，结果一模一样。
 *
 * 超上限时丢最后到的那个：请求按由近到远发出，最后到的最远，最晚才会用到。
 * 上限远大于引导阶段一次要等的那一片（`SPAWN_READY_RADIUS`），否则等到的区块会在
 * `awaitChunks` resolve 之前就被丢掉，出生点算在虚空里；有测试守着这条。
 */
export const MAX_READY_CHUNKS = 512;

export interface ChunkStreamOptions {
  readonly seed: number;
  readonly port: ChunkWorkerPort;
}

/**
 * 区块由 Worker 生成的来源。
 *
 * 核心每 tick 问一遍缺哪些区块（`streamChunks`）：手上有就当场给，没有就替它向 Worker
 * 发一次请求，并回答「还没准备好」。这就是 ADR-0003 说的「浏览器适配器负责在 Worker
 * 里调用生成器并异步回填」——核心那一侧仍然是同步的、可在 Node 里裸跑的。
 */
export interface ChunkStream {
  /** 生成这些区块用的种子。核心从这里拿，种子因此只有一个出处。 */
  readonly seed: number;
  /** 交给 `GameCore` 的区块来源。 */
  readonly source: ChunkSource;
  /** Worker 一共送回来多少个区块。端到端测试用它确认生成真的发生在 Worker 里。 */
  readonly deliveredCount: number;
  /**
   * 等这些区块生成好。
   * 引导阶段用：出生点那一带必须先有地形，玩家才不会一进世界就掉进虚空。
   */
  awaitChunks(coords: Iterable<ChunkCoord>): Promise<void>;
}

export function createChunkStream({ seed, port }: ChunkStreamOptions): ChunkStream {
  /** 已经生成好、还没被核心取走的区块。 */
  const ready = new Map<number, Chunk>();
  /** 已经请求、还没送到的区块。用它去重，同一个区块不会请求两次。 */
  const requested = new Set<number>();
  /** 每个区块上挂着的 `awaitChunks` 回调。同一个区块可能被等好几次。 */
  const waiting = new Map<number, Array<() => void>>();
  let delivered = 0;

  port.onmessage = ({ data }) => {
    const key = chunkKey(data.cx, data.cz);
    requested.delete(key);
    const awaited = waiting.get(key);
    ready.set(key, new Chunk(data.cx, data.cz, data.blocks));
    delivered++;

    // 存到上限说明核心没来取（玩家大概已经走远了），那就不留刚到的这个：请求按由近到远
    // 发出，最后到的最远、最晚才用到。引导阶段正在等的那个例外——等到之后马上要用。
    if (ready.size > MAX_READY_CHUNKS && !awaited) ready.delete(key);

    for (const resolve of awaited ?? []) resolve();
    waiting.delete(key);
  };

  function requestChunk(cx: number, cz: number, key: number): void {
    if (requested.has(key)) return;
    requested.add(key);
    port.postMessage({ seed, cx, cz });
  }

  const source: ChunkSource = (cx, cz) => {
    const key = chunkKey(cx, cz);
    const chunk = ready.get(key);
    if (chunk) {
      // 交给核心之后这边不再留着它：区块归世界持有，玩家的修改改的是世界里那一份。
      ready.delete(key);
      return chunk;
    }
    requestChunk(cx, cz, key);
    return undefined;
  };

  return {
    seed,
    source,
    get deliveredCount(): number {
      return delivered;
    },
    awaitChunks(coords): Promise<void> {
      const pending: Array<Promise<void>> = [];
      for (const { cx, cz } of coords) {
        const key = chunkKey(cx, cz);
        if (ready.has(key)) continue;
        requestChunk(cx, cz, key);
        pending.push(
          new Promise<void>((resolve) => {
            const resolvers = waiting.get(key) ?? [];
            resolvers.push(resolve);
            waiting.set(key, resolvers);
          }),
        );
      }
      return Promise.all(pending).then(() => undefined);
    },
  };
}
