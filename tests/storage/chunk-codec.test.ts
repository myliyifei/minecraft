import { describe, expect, it, vi } from 'vitest';
import { CHUNK_BLOCK_COUNT } from '../../src/core/chunk';
import { DEFAULT_SEED } from '../../src/core/constants';
import { plainsTerrain } from '../../src/core/terrain';
import { gunzipChunk, gzipChunk } from '../../src/storage/chunk-codec';

describe('区块方块数组的 gzip（ADR-0018）', () => {
  it('平原区块压缩后远小于 96 KB，解压后逐字节相同', async () => {
    const blocks = plainsTerrain(DEFAULT_SEED)(0, 0).blocks;
    const packed = await gzipChunk(blocks);
    expect(packed.byteLength).toBeLessThan(10 * 1024);
    expect(await gunzipChunk(packed)).toEqual(blocks);
  });

  it('解压出来不是正好一个区块的字节数就拒绝：短了不行，长了在超出时中止', async () => {
    const short = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT - 1));
    const long = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT * 4));
    await expect(gunzipChunk(short)).rejects.toThrow();
    await expect(gunzipChunk(long)).rejects.toThrow();
  });

  it('解出的字节一超过一个区块就停止解压，不把整段解完', async () => {
    // 64 个区块那么多的零压完只有几十 KB。数一数解压流实际交出了多少字节：
    // 整段解完是 64 个区块，超出即停止时只比一个区块多出流里缓冲的几块。
    const bomb = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT * 64));
    let produced = 0;
    const Real = DecompressionStream;
    vi.stubGlobal(
      'DecompressionStream',
      class {
        readonly writable: WritableStream<BufferSource>;
        readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
        constructor(format: CompressionFormat) {
          const real = new Real(format);
          this.writable = real.writable;
          this.readable = real.readable.pipeThrough(
            new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
              transform(chunk, controller) {
                produced += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          );
        }
      },
    );
    try {
      await expect(gunzipChunk(bomb)).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(produced).toBeLessThan(CHUNK_BLOCK_COUNT * 4);
  });

  it('不是 gzip 的字节拒绝', async () => {
    await expect(gunzipChunk(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
