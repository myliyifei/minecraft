import { gzipChunk } from '../storage/chunk-codec';
import type { GzipRequest, GzipResponse } from './protocol';

/**
 * 压缩 Worker：收到已改区块的方块数组，压成 gzip 送回主线程（ADR-0018 补记）。
 *
 * `CompressionStream` 的压缩在调用它的线程上做。写盘时在主线程上压 1000 个区块，暂停菜单底下的画面每帧要多花
 * 1 到 5 ms（#71）；在这里压，主线程只剩收发消息。解压仍在主线程：读档在加载画面上，导入在世界列表上，
 * 那时没有要画的世界。
 */

/** Worker 全局作用域里用到的那两样，理由见 chunk-worker.ts。 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<GzipRequest>) => void) | null;
  postMessage(message: GzipResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = ({ data: { id, blocks } }) => {
  gzipChunk(blocks).then(
    (data) => scope.postMessage({ id, data }, [data.buffer]),
    (error: unknown) => scope.postMessage({ id, error: String(error) }, []),
  );
};
