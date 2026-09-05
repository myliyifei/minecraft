import { Chunk } from '../core/chunk';
import { chunkKey, type ChunkCoord, type ChunkSource } from '../core/world';
import type { ChunkWorkerPort } from './protocol';

/**
 * 攒着等核心来取的区块上限。
 *
 * 正常情况下 Worker 送回来的区块会在下一个 tick（50ms 内）被核心取走，攒不了几个。
 * 万一玩家在区块送到之前就走远了，那个区块没人来取，这个上限保证它不会一直占着
 * 96KB 内存。被挤掉的区块下次要用时重新生成一次即可（0.23ms），地形是纯函数，
 * 结果一模一样。上限必须大于引导阶段一次要等的那一片区块数。
 */
export const MAX_READY_CHUNKS = 128;

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
  /** 在等某个区块的 `awaitChunks`。 */
  const waiting = new Map<number, () => void>();
  let delivered = 0;

  port.onmessage = ({ data }) => {
    const key = chunkKey(data.cx, data.cz);
    ordered.delete(key);
    ready.set(key, new Chunk(data.cx, data.cz, data.blocks));
    delivered++;
    evictOldest();
    waiting.get(key)?.();
    waiting.delete(key);
  };

  /** 攒得太多就把最早到的丢掉。Map 按插入顺序遍历，第一个就是最早的。 */
  function evictOldest(): void {
    while (ready.size > MAX_READY_CHUNKS) {
      const oldest = ready.keys().next();
      if (oldest.done) return;
      ready.delete(oldest.value);
    }
  }

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
        pending.push(new Promise<void>((resolve) => waiting.set(key, resolve)));
      }
      return Promise.all(pending).then(() => undefined);
    },
  };
}
