import type { ChunkBlocks } from '../core/chunk';

/**
 * 主线程与区块 Worker 之间的消息。
 *
 * 请求里带着种子而不是先发一发「初始化」：Worker 因此没有状态可言，主线程也不必
 * 保证消息顺序。同一个种子与区块坐标在哪一侧生成都得到同样的区块（ADR-0003），
 * Worker 只是换了个地方跑同一个纯函数。
 */
export interface ChunkRequest {
  readonly seed: number;
  readonly cx: number;
  readonly cz: number;
}

/**
 * 生成好的区块。
 * `blocks` 的 ArrayBuffer 是转移（transfer）过来的，不是复制——一个区块 96KB，
 * 视距 8 铺满要送 289 个。
 */
export interface ChunkResponse {
  readonly cx: number;
  readonly cz: number;
  readonly blocks: ChunkBlocks;
}

/**
 * Worker 端口上主线程用到的那部分。
 * 主线程侧的逻辑依赖这个接口而不是 `Worker`，因此能在 Node 里用假端口测试。
 */
export interface ChunkWorkerPort {
  postMessage(request: ChunkRequest): void;
  onmessage: ((event: MessageEvent<ChunkResponse>) => void) | null;
}
