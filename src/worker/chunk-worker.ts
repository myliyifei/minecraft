import { createTerrain, type Terrain } from '../core/terrain';
import type { ChunkRequest, ChunkResponse } from './protocol';

/**
 * 区块生成 Worker：收到区块坐标，生成好把方块数据送回主线程。
 *
 * 地形生成本身是纯函数（ADR-0003），搬到这里来只是为了不占主线程——铺满视距 8 要
 * 生成 289 个区块，放在主线程上会连续掉帧。核心那一侧看到的是一个「可能还没准备好」
 * 的区块来源，见 `src/worker/chunk-stream.ts`。
 */

/**
 * Worker 全局作用域里用到的那两样。
 * DOM 与 WebWorker 两套类型不能同时开（同名声明会冲突），所以这里只声明要用的部分。
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ChunkRequest>) => void) | null;
  postMessage(message: ChunkResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

/**
 * 按种子缓存的地形对象。三维密度的地形对象构造时没有耗时的计算，缓存是为 #84 按种子预先计算的数据
 * （出生列等）准备的：每条消息重建一次，那些数据就每条消息重算一次（ADR-0021）。
 *
 * 一个世界只有一个种子，所以只留最近一个：换种子（进了另一个世界）时换掉。地形对象是纯函数的集合，
 * 缓存与否不改变任何一条请求的结果（ADR-0003）。
 */
let cached: Terrain | undefined;

function terrainFor(seed: number): Terrain {
  if (cached?.seed !== seed) cached = createTerrain(seed);
  return cached;
}

scope.onmessage = ({ data }) => {
  const { seed, cx, cz } = data;
  const chunk = terrainFor(seed).generateChunk(cx, cz);
  // 转移 buffer 而不是复制：这一块内存交给主线程之后，Worker 这边就不再持有它。
  scope.postMessage({ cx, cz, blocks: chunk.blocks }, [chunk.blocks.buffer]);
};
