import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED } from '../../src/core/constants';
import { plainsTerrain } from '../../src/core/terrain';
import { gunzipChunk, gzipChunk } from '../../src/storage/chunk-codec';
import { createGzipClient } from '../../src/worker/gzip-client';
import type { GzipRequest, GzipResponse, GzipWorkerPort } from '../../src/worker/protocol';

/**
 * 假的压缩 Worker 端口：请求先存下来，由测试决定什么时候答、答哪一个、答成什么。答的时候与真 Worker 一样调
 * `gzipChunk`。
 */
function fakePort(): GzipWorkerPort & {
  readonly requests: { request: GzipRequest; transfer: Transferable[] }[];
  answer(index: number): Promise<void>;
  reply(response: GzipResponse): void;
  fail(): void;
} {
  const requests: { request: GzipRequest; transfer: Transferable[] }[] = [];
  const port = {
    requests,
    onmessage: null as GzipWorkerPort['onmessage'],
    onerror: null as GzipWorkerPort['onerror'],
    postMessage(request: GzipRequest, transfer: Transferable[]): void {
      requests.push({ request, transfer });
    },
    async answer(index: number): Promise<void> {
      const { request } = requests[index]!;
      port.reply({ id: request.id, data: await gzipChunk(request.blocks) });
    },
    reply(response: GzipResponse): void {
      port.onmessage?.({ data: response } as MessageEvent<GzipResponse>);
    },
    fail(): void {
      port.onerror?.({ message: 'Worker 脚本加载失败' } as ErrorEvent);
    },
  };
  return port;
}

const blocksOf = (cx: number) => plainsTerrain(DEFAULT_SEED)(cx, 0).blocks;

describe('在压缩 Worker 里 gzip 区块（ADR-0018 补记，#71）', () => {
  it('方块数组转移给 Worker，不复制；答回来的 gzip 解压后与原数组相同', async () => {
    const port = fakePort();
    const gzip = createGzipClient(port);
    const blocks = blocksOf(0);
    const copy = blocks.slice();

    const packed = gzip(blocks);
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]!.request.blocks).toBe(blocks);
    expect(port.requests[0]!.transfer).toEqual([blocks.buffer]);
    await port.answer(0);
    expect(await gunzipChunk(await packed)).toEqual(copy);
  });

  it('几个请求的回复顺序不同：按编号各自交给对应的那一个', async () => {
    const port = fakePort();
    const gzip = createGzipClient(port);
    const copies = [blocksOf(0).slice(), blocksOf(1).slice()];
    const first = gzip(blocksOf(0));
    const second = gzip(blocksOf(1));
    expect(new Set(port.requests.map(({ request }) => request.id)).size).toBe(2);

    await port.answer(1);
    await port.answer(0);
    expect(await gunzipChunk(await first)).toEqual(copies[0]);
    expect(await gunzipChunk(await second)).toEqual(copies[1]);
  });

  it('Worker 答的是压缩失败：那一个拒绝，别的照常', async () => {
    const port = fakePort();
    const gzip = createGzipClient(port);
    const failed = expect(gzip(blocksOf(0))).rejects.toThrow('压缩出错');
    const ok = gzip(blocksOf(1));
    port.reply({ id: port.requests[0]!.request.id, error: '压缩出错' });
    await port.answer(1);
    await failed;
    await expect(ok).resolves.toBeInstanceOf(Uint8Array);
  });

  it('Worker 出错（脚本加载失败）：正在等的全部拒绝；之后的不再发给 Worker，改在当前线程上压，写盘照常完成', async () => {
    // 正在等的那几个方块数组已经转移给 Worker，拿不回来，只能拒绝：这次写盘失败、区块放回，下次写盘再写。
    const port = fakePort();
    const gzip = createGzipClient(port);
    const pending = expect(gzip(blocksOf(0))).rejects.toThrow();
    port.fail();
    await pending;

    const blocks = blocksOf(1);
    const copy = blocks.slice();
    expect(await gunzipChunk(await gzip(blocks))).toEqual(copy);
    expect(port.requests).toHaveLength(1);
  });
});
