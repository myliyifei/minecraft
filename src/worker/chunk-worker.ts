import { plainsTerrain, type TerrainGenerator } from '../core/terrain';
import type { ChunkRequest, ChunkResponse } from './protocol';

/**
 * 区块生成 Worker：收到区块坐标，生成好把方块数据送回主线程。
 *
 * 地形生成本身是纯函数（ADR-0003），搬到这里来只是为了不占主线程——铺满视距 8 要
 * 生成 289 个区块，摊在主线程上就是一串掉帧。核心那一侧看到的是一个「可能还没准备好」
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

/** 上一次用的种子与生成器。同一个世界的区块请求源源不断，没必要每次重建生成器。 */
let cachedSeed: number | undefined;
let cachedGenerate: TerrainGenerator | undefined;

function generatorFor(seed: number): TerrainGenerator {
  if (cachedSeed !== seed || !cachedGenerate) {
    cachedSeed = seed;
    cachedGenerate = plainsTerrain(seed);
  }
  return cachedGenerate;
}

scope.onmessage = ({ data }) => {
  const { seed, cx, cz } = data;
  const chunk = generatorFor(seed)(cx, cz);
  // 转移 buffer 而不是复制：这一块内存交给主线程之后，Worker 这边就不再持有它。
  scope.postMessage({ cx, cz, blocks: chunk.blocks }, [chunk.blocks.buffer]);
};
