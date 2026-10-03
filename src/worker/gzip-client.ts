import { gzipChunk } from '../storage/chunk-codec';
import type { ChunkCompressor } from '../storage/world-storage';
import type { GzipWorkerPort } from './protocol';

/**
 * 经压缩 Worker 压一个区块的函数，交给存储模块（`WorldStorageOptions.gzip`）。方块数组转移给 Worker，之后不能
 * 再用。
 *
 * Worker 出错（脚本没加载起来）时正在等的全部拒绝：那些方块数组已经转移过去，拿不回来，这次写盘随之失败、整次
 * 回滚，区块放回核心。之后的请求不再发给 Worker，改在当前线程上压（`gzipChunk`）：下次写盘照常完成，只是写盘期间
 * 的帧会长一些。不能一直等一个不会来的回复，那样退出会卡住；也不能从此一律拒绝，那样这个页面再也写不了盘。
 */
export function createGzipClient(port: GzipWorkerPort): ChunkCompressor {
  const pending = new Map<number, { resolve(data: Uint8Array<ArrayBuffer>): void; reject(error: Error): void }>();
  let nextId = 0;
  let broken: Error | undefined;

  port.onmessage = ({ data }) => {
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    if ('error' in data) waiting.reject(new Error(data.error));
    else waiting.resolve(data.data);
  };
  port.onerror = (event) => {
    broken = new Error(`压缩 Worker 出错：${event.message}`);
    for (const { reject } of pending.values()) reject(broken);
    pending.clear();
  };

  return (blocks) => {
    if (broken) return gzipChunk(blocks);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, blocks }, [blocks.buffer]);
    });
  };
}
