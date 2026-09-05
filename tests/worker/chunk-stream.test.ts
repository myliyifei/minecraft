import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_BLOCK_COUNT } from '../../src/core/chunk';
import { plainsSurfaceHeight, plainsTerrain } from '../../src/core/terrain';
import { createChunkStream, MAX_READY_CHUNKS } from '../../src/worker/chunk-stream';
import type { ChunkRequest, ChunkWorkerPort } from '../../src/worker/protocol';

/**
 * 假的 Worker 端口：请求先攒着，测试自己决定什么时候答、答哪一个。
 * 真 Worker 什么时候回消息不由我们控制，这里把那个时机变成显式的一步。
 */
function fakePort(): ChunkWorkerPort & {
  readonly requests: ChunkRequest[];
  deliver(index?: number): void;
  deliverAll(): void;
} {
  const requests: ChunkRequest[] = [];
  const port = {
    requests,
    onmessage: null as ((event: { data: never }) => void) | null,
    postMessage(request: ChunkRequest): void {
      requests.push(request);
    },
    deliver(index = 0): void {
      const request = requests[index];
      if (!request) throw new Error(`没有第 ${index} 个请求可以答`);
      requests.splice(index, 1);
      const chunk = plainsTerrain(request.seed)(request.cx, request.cz);
      port.onmessage?.({
        data: { cx: request.cx, cz: request.cz, blocks: chunk.blocks },
      } as never);
    },
    deliverAll(): void {
      while (requests.length > 0) port.deliver();
    },
  };
  return port as never;
}

const SEED = 4242;

describe('Worker 供货的区块来源', () => {
  it('第一次问的时候还没有区块，只是发出请求', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });

    expect(stream.source(2, -1)).toBeUndefined();
    expect(port.requests).toEqual([{ seed: SEED, cx: 2, cz: -1 }]);
  });

  it('同一个区块不会重复请求', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });

    stream.source(0, 0);
    stream.source(0, 0);
    stream.source(0, 0);
    expect(port.requests).toHaveLength(1);
  });

  it('Worker 送回来之后，再问就拿到区块', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });

    stream.source(3, 4);
    port.deliverAll();

    const chunk = stream.source(3, 4);
    expect(chunk).toBeDefined();
    expect(chunk!.cx).toBe(3);
    expect(chunk!.cz).toBe(4);
    expect(chunk!.blocks).toHaveLength(CHUNK_BLOCK_COUNT);
  });

  it('拿到的区块就是这个种子该有的地形', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });
    stream.source(1, 0);
    port.deliverAll();

    const chunk = stream.source(1, 0)!;
    const x = 16;
    const surface = plainsSurfaceHeight(SEED, x, 0);
    expect(chunk.get(0, surface, 0)).toBe(BlockType.Grass);
    expect(chunk.get(0, surface + 1, 0)).toBe(BlockType.Air);
  });

  it('区块只交出去一次：核心接管之后来源不再持有它', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });
    stream.source(0, 0);
    port.deliverAll();

    expect(stream.source(0, 0)).toBeDefined();
    // 核心已经收下了。再问说明它又被卸载了，于是重新发一次请求
    expect(stream.source(0, 0)).toBeUndefined();
    expect(port.requests).toEqual([{ seed: SEED, cx: 0, cz: 0 }]);
  });

  it('数得清 Worker 一共送回来多少个区块', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });
    expect(stream.deliveredCount).toBe(0);

    stream.source(0, 0);
    stream.source(1, 0);
    port.deliverAll();
    expect(stream.deliveredCount).toBe(2);
  });
});

describe('等一片区块就位', () => {
  it('全部送到之后 promise 才 resolve', async () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });

    let done = false;
    const waiting = stream
      .awaitChunks([
        { cx: 0, cz: 0 },
        { cx: 1, cz: 0 },
      ])
      .then(() => {
        done = true;
      });

    expect(port.requests).toHaveLength(2);
    port.deliver();
    await Promise.resolve();
    expect(done).toBe(false);

    port.deliverAll();
    await waiting;
    expect(done).toBe(true);
    // 等到的区块留在来源里，交给随后构造的核心
    expect(stream.source(0, 0)).toBeDefined();
    expect(stream.source(1, 0)).toBeDefined();
  });

  it('已经在手上的区块不必再等', async () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });
    stream.source(0, 0);
    port.deliverAll();

    await stream.awaitChunks([{ cx: 0, cz: 0 }]);
    expect(port.requests).toHaveLength(0);
  });
});

describe('攒着的区块有上限', () => {
  it('核心一直不来取，最早的那些会被丢掉，之后重新请求', () => {
    const port = fakePort();
    const stream = createChunkStream({ seed: SEED, port });

    // 请求并收下比上限多一个
    for (let i = 0; i <= MAX_READY_CHUNKS; i++) stream.source(i, 0);
    port.deliverAll();

    // 最早那个被挤掉了，于是又发了一次请求
    expect(stream.source(0, 0)).toBeUndefined();
    expect(port.requests).toEqual([{ seed: SEED, cx: 0, cz: 0 }]);
    // 后面的还在
    expect(stream.source(MAX_READY_CHUNKS, 0)).toBeDefined();
  });
});
