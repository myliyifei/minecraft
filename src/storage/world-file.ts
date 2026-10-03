import { BlockStateKind, blockStateKind, BlockType } from '../core/block';
import { blockIndex, CHUNK_BLOCK_COUNT } from '../core/chunk';
import type { BlockStateRecord } from '../core/snapshot';
import { CHUNK_COORD_LIMIT, chunkKey, chunkOf, localOf } from '../core/world';
import { gunzipChunk } from './chunk-codec';
import { checkFileRecords } from './record-check';
import { CURRENT_VERSIONS, type PackedChunk, type StorageVersions, type WorldMeta, type WorldState } from './world-storage';

/*
 * 导出文件 `.voxelworld`（ADR-0018）：自定的二进制容器，整数一律小端序。
 *
 *   魔数（8 字节）| 格式版本 u32 | JSON 段长 u32 | JSON 段 | 区块数 u32 | 区块段 × 区块数
 *   区块段：cx i32 | cz i32 | gzip 长度 u32 | gzip 数据
 *
 * JSON 段是 `{ meta, state, blockStates }`：元数据去掉 id，`states` 与 `blockStates` 两张表里的记录原样放进来。
 * 区块段的 gzip 数据就是 `chunks` 表里的那份字节。导出是把四张表的记录拼起来，导入是拆开写回，都不解压再压缩。
 * 格式版本取元数据里的快照格式版本：版本不兼容的世界也能导出，文件头上写的是它自己的版本。
 */

/** 文件扩展名。 */
export const WORLD_FILE_EXTENSION = '.voxelworld';

/** 文件开头固定的 8 字节，ASCII 的 `VOXWORLD`。 */
const MAGIC = Uint8Array.from('VOXWORLD', (char) => char.charCodeAt(0));

/**
 * 区块数的上限。已改区块整块留在内存（ADR-0008），4096 个就是 384 MB，再多的世界进入后内存不够用。
 * 导出时也按它查，超过的不导出：导出的文件要能再导入。
 */
export const WORLD_FILE_MAX_CHUNKS = 4096;

/** JSON 段长的上限。掉落物、经验球与方块状态表都在这一段里，正常的世界只用到几十 KB。 */
export const WORLD_FILE_MAX_JSON_BYTES = 16 * 1024 * 1024;

/**
 * 导入时一段 gzip 长度的上限。方块数组完全压不动时，deflate 退回不压缩的存储块，每 64 KB 多 5 字节，加上 gzip 的
 * 头尾也只比原数据多几十字节；多留的 1 KB 是余量。
 */
export const WORLD_FILE_MAX_GZIP_BYTES = CHUNK_BLOCK_COUNT + 1024;

/** 魔数、格式版本、JSON 段长。 */
const HEADER_BYTES = MAGIC.byteLength + 4 + 4;
/** 区块数。 */
const CHUNK_COUNT_BYTES = 4;
/** cx、cz、gzip 长度。 */
const CHUNK_HEADER_BYTES = 4 + 4 + 4;

/** 文件大小的上限：各段都取上限时的总长。导入时先比它，超过的不读进内存。 */
export const WORLD_FILE_MAX_BYTES =
  HEADER_BYTES + WORLD_FILE_MAX_JSON_BYTES + CHUNK_COUNT_BYTES + WORLD_FILE_MAX_CHUNKS * (CHUNK_HEADER_BYTES + WORLD_FILE_MAX_GZIP_BYTES);

/** 导出文件里的元数据：不带 id，导入时另外生成。 */
export type WorldFileMeta = Omit<WorldMeta, 'id'>;

/** 导出文件里的一个世界：四张表里的记录，区块是 gzip 字节。 */
export interface WorldFile {
  readonly meta: WorldFileMeta;
  readonly state: WorldState;
  readonly blockStates: readonly BlockStateRecord[];
  readonly chunks: readonly PackedChunk[];
}

/** 解码的结果。失败时整份不用；原因说的是哪一段、哪一条不符，给控制台看。 */
export type WorldFileResult = { readonly ok: true; readonly file: WorldFile } | { readonly ok: false; readonly reason: string };

/** 编码的结果。区块数或某一段超过导入的上限时不编码：那样的文件导不回来。 */
export type EncodeResult = { readonly ok: true; readonly buffer: ArrayBuffer } | { readonly ok: false; readonly reason: string };

/** 每个方块编号是不是已知的、是不是带状态的方块，下标是编号。区块的每个字节都要查一次，用表不用 `includes`。 */
const KNOWN_BLOCKS = new Uint8Array(256);
const STATEFUL_BLOCKS = new Uint8Array(256);
for (const id of Object.values(BlockType)) {
  KNOWN_BLOCKS[id] = 1;
  if (blockStateKind(id) !== BlockStateKind.None) STATEFUL_BLOCKS[id] = 1;
}

/** 把一个世界的记录拼成导出文件。meta 带不带 id 都行，不写进文件。超过导入的上限时不编码。 */
export function encodeWorldFile(file: WorldFile): EncodeResult {
  if (file.chunks.length > WORLD_FILE_MAX_CHUNKS) {
    return { ok: false, reason: `已改区块有 ${file.chunks.length} 个，超过 ${WORLD_FILE_MAX_CHUNKS}` };
  }
  if (file.chunks.some(({ data }) => data.byteLength > WORLD_FILE_MAX_GZIP_BYTES)) return { ok: false, reason: 'gzip 段超过长度上限' };
  const json = new TextEncoder().encode(
    JSON.stringify({ meta: fileMeta(file.meta), state: file.state, blockStates: file.blockStates }),
  );
  if (json.byteLength > WORLD_FILE_MAX_JSON_BYTES) return { ok: false, reason: 'JSON 段超过长度上限' };
  let size = HEADER_BYTES + json.byteLength + CHUNK_COUNT_BYTES;
  for (const { data } of file.chunks) size += CHUNK_HEADER_BYTES + data.byteLength;

  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(MAGIC, 0);
  let offset = MAGIC.byteLength;
  const u32 = (value: number): void => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const i32 = (value: number): void => {
    view.setInt32(offset, value, true);
    offset += 4;
  };
  const put = (data: Uint8Array): void => {
    bytes.set(data, offset);
    offset += data.byteLength;
  };
  u32(file.meta.formatVersion);
  u32(json.byteLength);
  put(json);
  u32(file.chunks.length);
  for (const { cx, cz, data } of file.chunks) {
    i32(cx);
    i32(cz);
    u32(data.byteLength);
    put(data);
  }
  return { ok: true, buffer };
}

/**
 * 拆开一份导出文件并逐项校验，任一不符整份拒绝，不抛出。先查完结构与 JSON 段，再逐个解压区块段。区块一个接一个
 * 解压，解压出来的方块数组查完就不再引用，同一时刻只占一个区块的内存；返回的仍是 gzip 字节，写回时不再压缩。
 *
 * 解压要等 `DecompressionStream`，所以是异步的；除此之外不读写任何外部状态。
 */
export async function decodeWorldFile(buffer: ArrayBuffer, versions: StorageVersions = CURRENT_VERSIONS): Promise<WorldFileResult> {
  try {
    const file = readContainer(buffer, versions);
    const statesByChunk = new Map<number, BlockStateRecord[]>();
    for (const record of file.blockStates) {
      const key = chunkKey(chunkOf(record.x), chunkOf(record.z));
      const list = statesByChunk.get(key);
      if (list) list.push(record);
      else statesByChunk.set(key, [record]);
    }
    for (const { cx, cz, data } of file.chunks) {
      const states = statesByChunk.get(chunkKey(cx, cz)) ?? [];
      statesByChunk.delete(chunkKey(cx, cz));
      checkBlocks(cx, cz, await gunzipChunk(data), states);
    }
    if (statesByChunk.size > 0) throw new Error('方块状态表里有一条落在文件里没有的区块');
    return { ok: true, file };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message ? error.message : String(error) };
  }
}

/**
 * 一个区块的方块数组：编号都是已知的；方块状态表里落在这个区块的每一条，那一格都是带状态的方块；带状态的方块
 * 与这些条目一样多。三条合起来就是区块里带状态的方块与状态表一一对应，与核心里的规则相同：放下熔炉就有一条
 * 状态，挖掉就删掉。否则进入世界时状态表的条目被丢掉，或者熔炉打不开。
 */
function checkBlocks(cx: number, cz: number, blocks: Uint8Array, states: readonly BlockStateRecord[]): void {
  let stateful = 0;
  for (const block of blocks) {
    if (!KNOWN_BLOCKS[block]) throw new Error(`区块 (${cx}, ${cz}) 里有未知的方块编号 ${block}`);
    stateful += STATEFUL_BLOCKS[block]!;
  }
  for (const { x, y, z } of states) {
    if (!STATEFUL_BLOCKS[blocks[blockIndex(localOf(x), y, localOf(z))]!]) throw new Error(`方块状态 (${x}, ${y}, ${z}) 那一格不是带状态的方块`);
  }
  if (stateful !== states.length) throw new Error(`区块 (${cx}, ${cz}) 里带状态的方块与方块状态表的条数不同`);
}

/** 同 `decodeWorldFile`，拆的是玩家选的文件：超过大小上限的不读进内存，读不出来（文件被删了）也是失败。 */
export async function decodeWorldBlob(blob: Blob, versions: StorageVersions = CURRENT_VERSIONS): Promise<WorldFileResult> {
  if (blob.size > WORLD_FILE_MAX_BYTES) return { ok: false, reason: '文件超过大小上限' };
  let buffer: ArrayBuffer;
  try {
    buffer = await blob.arrayBuffer();
  } catch (error) {
    return { ok: false, reason: `读不出文件：${String(error)}` };
  }
  return decodeWorldFile(buffer, versions);
}

/** 按布局拆开文件，查魔数、版本、各段长度与 JSON 段，不解压区块。 */
function readContainer(buffer: ArrayBuffer, versions: StorageVersions): WorldFile {
  if (buffer.byteLength > WORLD_FILE_MAX_BYTES) throw new Error('文件超过大小上限');
  const reader = new Reader(buffer);
  const magic = reader.bytes(MAGIC.byteLength);
  if (!magic.every((byte, i) => byte === MAGIC[i])) throw new Error('魔数不对');
  const version = reader.u32();
  if (version !== versions.format) throw new Error(`格式版本是 ${version}，当前是 ${versions.format}`);

  const jsonLength = reader.u32();
  if (jsonLength > WORLD_FILE_MAX_JSON_BYTES) throw new Error('JSON 段超过长度上限');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(reader.bytes(jsonLength));
  const records = checkFileRecords(JSON.parse(text), versions);
  if (records.meta.formatVersion !== version) throw new Error('元数据里的格式版本与文件头不同');

  const count = reader.u32();
  if (count > WORLD_FILE_MAX_CHUNKS) throw new Error('区块数超过上限');
  const chunks: PackedChunk[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const cx = reader.i32();
    const cz = reader.i32();
    if (Math.abs(cx) >= CHUNK_COORD_LIMIT || Math.abs(cz) >= CHUNK_COORD_LIMIT) throw new Error(`区块 (${cx}, ${cz}) 超出世界范围`);
    const key = chunkKey(cx, cz);
    if (seen.has(key)) throw new Error(`区块 (${cx}, ${cz}) 出现了两次`);
    seen.add(key);
    const length = reader.u32();
    if (length > WORLD_FILE_MAX_GZIP_BYTES) throw new Error(`区块 (${cx}, ${cz}) 的 gzip 段超过长度上限`);
    chunks.push({ cx, cz, data: reader.bytes(length) });
  }
  if (reader.remaining !== 0) throw new Error('最后一个区块段之后还有多余的字节');
  return { ...records, chunks };
}

/** 元数据里写进文件的那几个字段，按固定的顺序：同一份记录每次编码出来的字节相同。 */
function fileMeta(meta: WorldFileMeta): WorldFileMeta {
  return {
    name: meta.name,
    seed: meta.seed,
    difficulty: meta.difficulty,
    formatVersion: meta.formatVersion,
    terrainVersion: meta.terrainVersion,
    createdAt: meta.createdAt,
    lastPlayedAt: meta.lastPlayedAt,
    hardcoreDead: meta.hardcoreDead,
  };
}

/** 从头往后读文件。要读的超出剩下的长度时抛出：文件被截断了，或者段长与实际内容不符。 */
class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get remaining(): number {
    return this.buffer.byteLength - this.offset;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /**
   * 接下来 length 个字节，复制成独立的一份：写进 IndexedDB 时结构化克隆复制的是视图背后的整个 `ArrayBuffer`，
   * 只取视图的话每个区块记录里都是一整份文件。
   */
  bytes(length: number): Uint8Array<ArrayBuffer> {
    this.need(length);
    const copy = new Uint8Array(this.buffer.slice(this.offset, this.offset + length));
    this.offset += length;
    return copy;
  }

  private need(length: number): void {
    if (length > this.remaining) throw new Error('文件被截断，或段长超出文件剩下的长度');
  }
}
