import { CHUNK_BLOCK_COUNT, type ChunkBlocks } from '../core/chunk';

/*
 * 已改区块的方块数组整块 gzip（ADR-0018）。用浏览器的 `CompressionStream`，压缩与解压都是异步的；只有开始时把
 * 数组复制进 Blob 是同步的，一个区块不到 1 ms，所以很多个区块要一个接一个压，不要同时开始（见 `saveWorld`）。
 * IndexedDB 里的记录与导出文件里的区块段是同一份字节。
 */

/** 用 gzip 压缩一个区块的方块数组。 */
export async function gzipChunk(blocks: ChunkBlocks): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([blocks]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 把 gzip 数据解压成一个区块的方块数组。解压结果不是正好 `CHUNK_BLOCK_COUNT` 字节时抛出。超出时立即停止解压，
 * 不解压剩下的部分：导入的文件是不可信输入，几 KB 的 gzip 数据可以解压出几 GB。
 */
export async function gunzipChunk(data: Uint8Array<ArrayBuffer>): Promise<ChunkBlocks> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const blocks: ChunkBlocks = new Uint8Array(CHUNK_BLOCK_COUNT);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filled + value.byteLength > CHUNK_BLOCK_COUNT) {
      await reader.cancel();
      throw new Error('区块数据解压后超过一个区块');
    }
    blocks.set(value, filled);
    filled += value.byteLength;
  }
  if (filled !== CHUNK_BLOCK_COUNT) throw new Error('区块数据解压后不足一个区块');
  return blocks;
}
