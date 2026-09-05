import { Chunk } from '../core/chunk';
import { chunkKey, type ChunkCoord, type ChunkSource } from '../core/world';
import type { ChunkWorkerPort } from './protocol';

/**
 * 进世界之前先等好的区块半径（区块数）。
 *
 * 出生点要有地形才算得出来，否则玩家一进世界就掉进「未加载即空气」的虚空。多等一圈是
 * 为了首帧不是一片虚空：网格要四邻齐全才建（见 `planChunkMeshes`），所以等半径 3
 * 才能铺出半径 2 的一片地。视距内其余的区块由 tick 逐步补上，世界从脚下往外长开。
 */
export const SPAWN_READY_RADIUS = 3;

/**
 * 攒着等核心来取的区块上限。
 *
 * 正常情况下 Worker 送回来的区块会在下一个 tick（50ms 内）被核心取走。核心只要视距内
 * 的区块，所以这里攒的量本来就有界；这个上限防的是另一种情形：区块送到之后玩家恰好
 * 走出了它的视距，没人再来取它，于是它一直占着 96KB。被挤掉的区块下次要用时重新生成
 * 一次即可（0.23ms），地形是纯函数，结果一模一样。
 *
 * 挤掉最后到的那个：请求是由近到远发的，最后到的就是最远的，最不着急要。
 * 上限远大于引导阶段一次要等的那一片（`SPAWN_READY_RADIUS`），否则等到的区块会在
 * `awaitChunks` resolve 之前就被挤掉，出生点算在虚空里；有测试守着这条。
 */
export const MAX_READY_CHUNKS = 512;

export interface ChunkStreamOptions {
  readonly seed: number;
  readonly port: ChunkWorkerPort;
}

/**
 * Worker 供货的区块来源。
 *
 * 核心每 tick 问一遍缺哪些区块（`streamChunks`）：手上有就当场给，没有就替它向 Worker
 * 下单并回答「还没准备好」。这就是 ADR-0003 说的「浏览器适配器负责在 Worker 里调用
 * 生成器并异步回填」——核心那一侧仍然是同步的、可在 Node 里裸跑的。
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
  /** 已经下单、还没送到的区块。用它去重，同一个区块不会请求两次。 */
  const ordered = new Set<number>();
  /** 在等某个区块的那些 `awaitChunks`。同一个区块可能有好几拨人在等。 */
  const waiting = new Map<number, Array<() => void>>();
  let delivered = 0;

  port.onmessage = ({ data }) => {
    const key = chunkKey(data.cx, data.cz);
    ordered.delete(key);
    const awaited = waiting.get(key);
    ready.set(key, new Chunk(data.cx, data.cz, data.blocks));
    delivered++;

    // 攒到上限说明核心没来取（玩家大概已经走远了），那就不留刚到的这个：请求是由近到远
    // 发的，最后到的最远、最不着急。引导阶段在等的那些不算——等到它的人马上就要用。
    if (ready.size > MAX_READY_CHUNKS && !awaited) ready.delete(key);

    for (const resolve of awaited ?? []) resolve();
    waiting.delete(key);
  };

  function order(cx: number, cz: number, key: number): void {
    if (ordered.has(key)) return;
    ordered.add(key);
    port.postMessage({ seed, cx, cz });
  }

  const source: ChunkSource = (cx, cz) => {
    const key = chunkKey(cx, cz);
    const chunk = ready.get(key);
    if (chunk) {
      // 交给核心之后这边就不留了：世界那一侧才是区块的主人（玩家的修改改的是它）。
      ready.delete(key);
      return chunk;
    }
    order(cx, cz, key);
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
        order(cx, cz, key);
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
