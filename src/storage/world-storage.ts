import type { ChunkBlocks } from '../core/chunk';
import type { Difficulty } from '../core/difficulty';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION, type BlockStateRecord, type Snapshot } from '../core/snapshot';
import type { ChunkCoord } from '../core/world';
import { gunzipChunk, gzipChunk } from './chunk-codec';

/*
 * 存档的存储模块（ADR-0018）：把核心导出的快照写进 IndexedDB、读回、删除。一个库四张表，都按世界 id 分隔：
 *
 * - `worlds`：世界元数据，键是记录里的 `id`。
 * - `states`：快照里除方块状态表与已改区块之外的部分（`WorldState`），键是世界 id。
 * - `blockStates`：方块状态表（`Snapshot.blockStates`），键是世界 id。
 * - `chunks`：每个已改区块一条，键是 `[世界 id, cx, cz]`，值是方块数组的 gzip。
 *
 * 前三张每次写盘整体重写，`chunks` 只写快照里带的那些，即上次写盘之后改过的。记录就是快照里对应的那部分，
 * 不另造结构；导出文件的各段与这里的记录相同。
 */

const DB_NAME = 'voxel-worlds';
const DB_VERSION = 1;
const WORLDS = 'worlds';
const STATES = 'states';
const BLOCK_STATES = 'blockStates';
const CHUNKS = 'chunks';
const ALL_STORES = [WORLDS, STATES, BLOCK_STATES, CHUNKS];

/** 世界列表显示的与读档前比对的字段。种子、难度、已死亡标记以快照为准，这里的副本每次写盘时从快照复制。 */
export interface WorldMeta {
  /** 新建与导入时由调用方用 `crypto.randomUUID()` 生成。只在安全上下文可用，不做降级（ADR-0018）。 */
  readonly id: string;
  readonly name: string;
  readonly seed: number;
  readonly difficulty: Difficulty;
  /** 写这份存档时的快照格式版本（`SNAPSHOT_FORMAT_VERSION`）。 */
  readonly formatVersion: number;
  /** 写这份存档时的地形算法版本（`TERRAIN_VERSION`）。 */
  readonly terrainVersion: number;
  /** 第一次写盘的时刻，毫秒。 */
  readonly createdAt: number;
  /** 最近一次写盘的时刻，毫秒。世界列表按它倒序。 */
  readonly lastPlayedAt: number;
  readonly hardcoreDead: boolean;
}

/** `states` 表里的一条：快照去掉方块状态表与已改区块。 */
export type WorldState = Omit<Snapshot, 'blockStates' | 'editedChunks'>;

/** 世界列表里的一条。版本与当前不同的不能进入，只能删除或导出。 */
export interface WorldEntry {
  readonly meta: WorldMeta;
  readonly compatible: boolean;
}

/**
 * 写盘的结果。失败时整次回滚，`chunks` 是这次快照带的区块坐标：调用方交给 `GameCore.returnUnsavedChunks`
 * 放回，下次写盘再写。
 */
export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown; readonly chunks: ChunkCoord[] };

/** 读档的结果。版本不兼容时不读区块。 */
export type LoadResult =
  | { readonly status: 'ok'; readonly meta: WorldMeta; readonly snapshot: Snapshot }
  | { readonly status: 'incompatible'; readonly meta: WorldMeta }
  | { readonly status: 'missing' };

/** 当前代码的两个版本号。存档里的与它们任一不同就不兼容。 */
export interface StorageVersions {
  readonly format: number;
  readonly terrain: number;
}

export interface WorldStorageOptions {
  /** 默认是浏览器的 `indexedDB`；Node 下的测试传 fake-indexeddb 的。 */
  readonly indexedDB: IDBFactory;
  /** 写进元数据的时刻，默认 `Date.now`。 */
  readonly now: () => number;
  /** 默认是 `SNAPSHOT_FORMAT_VERSION` 与 `TERRAIN_VERSION`。 */
  readonly versions: StorageVersions;
}

/** 打开存档库，第一次打开时建四张表。 */
export async function openWorldStorage(options: Partial<WorldStorageOptions> = {}): Promise<WorldStorage> {
  const factory = options.indexedDB ?? indexedDB;
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(WORLDS, { keyPath: 'id' });
    db.createObjectStore(STATES);
    db.createObjectStore(BLOCK_STATES);
    db.createObjectStore(CHUNKS);
  };
  const db = await result(request);
  // 另一个标签页要升级库时关闭这个连接，否则它的升级一直被阻塞。
  db.onversionchange = () => db.close();
  return new WorldStorage(db, options.now ?? Date.now, options.versions ?? { format: SNAPSHOT_FORMAT_VERSION, terrain: TERRAIN_VERSION });
}

export class WorldStorage {
  /** 每个世界最后一次排进来的写盘或删除。同一个世界的这些操作按调用顺序一个接一个执行。 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: IDBDatabase,
    private readonly now: () => number,
    private readonly versions: StorageVersions,
  ) {}

  /** 全部世界，按上次游玩时间倒序。 */
  async listWorlds(): Promise<WorldEntry[]> {
    const metas: WorldMeta[] = await result(this.db.transaction(WORLDS).objectStore(WORLDS).getAll());
    return metas
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .map((meta) => ({ meta, compatible: this.compatible(meta) }));
  }

  /** 读一个世界拼回快照。已改区块全部读出并解压，从快照构造核心时整份交进去。 */
  async loadWorld(id: string): Promise<LoadResult> {
    const tx = this.db.transaction(ALL_STORES);
    const meta: WorldMeta | undefined = await result(tx.objectStore(WORLDS).get(id));
    if (!meta) return { status: 'missing' };
    if (!this.compatible(meta)) return { status: 'incompatible', meta };

    const range = chunksOf(id);
    const chunks = tx.objectStore(CHUNKS);
    const [state, blockStates, keys, packed] = await Promise.all([
      result<WorldState>(tx.objectStore(STATES).get(id)),
      result<BlockStateRecord[]>(tx.objectStore(BLOCK_STATES).get(id)),
      result(chunks.getAllKeys(range)),
      result<Uint8Array<ArrayBuffer>[]>(chunks.getAll(range)),
    ]);
    // 解压在事务结束之后：事务里不等待 IndexedDB 以外的 Promise。
    const blocks: ChunkBlocks[] = await Promise.all(packed.map(gunzipChunk));
    const editedChunks = keys.map((key, i) => {
      const [, cx, cz] = key as ChunkKey;
      return { cx, cz, blocks: blocks[i]! };
    });
    return { status: 'ok', meta, snapshot: { ...state, blockStates, editedChunks } };
  }

  /**
   * 写一份快照。快照里的区块全部压缩完才开事务，四张表在同一个读写事务里提交；失败时整次回滚，
   * 返回这次的区块坐标。`name` 是世界的名称，元数据每次整体重写，创建时间保留第一次写的。
   *
   * 同一个世界的写盘按调用顺序提交：暂停时的写盘还没结束、`pagehide` 又发起一次时，后一次要等前一次提交完
   * 才开始压缩。否则区块少的那次先提交，另一次再用旧的玩家与 tick 覆盖它。
   */
  saveWorld(id: string, name: string, snapshot: Snapshot): Promise<SaveResult> {
    return this.inOrder(id, async (): Promise<SaveResult> => {
      try {
        const chunks = await Promise.all(
          snapshot.editedChunks.map(async ({ cx, cz, blocks }) => ({ cx, cz, data: await gzipChunk(blocks) })),
        );
        await this.write(id, name, snapshot, chunks);
        return { ok: true };
      } catch (error) {
        return { ok: false, error, chunks: snapshot.editedChunks.map(({ cx, cz }) => ({ cx, cz })) };
      }
    });
  }

  /** 在一个事务里删掉这个世界在四张表里的全部记录。排在这个世界之前发起的写盘之后执行。 */
  deleteWorld(id: string): Promise<void> {
    return this.inOrder(id, async () => {
      const tx = this.db.transaction(ALL_STORES, 'readwrite');
      const done = completion(tx);
      tx.objectStore(WORLDS).delete(id);
      tx.objectStore(STATES).delete(id);
      tx.objectStore(BLOCK_STATES).delete(id);
      tx.objectStore(CHUNKS).delete(chunksOf(id));
      await done;
    });
  }

  close(): void {
    this.db.close();
  }

  /** 等这个世界之前排进来的操作结束（成功或失败都算）再执行 task。 */
  private inOrder<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return run;
  }

  private compatible(meta: WorldMeta): boolean {
    return meta.formatVersion === this.versions.format && meta.terrainVersion === this.versions.terrain;
  }

  private async write(id: string, name: string, snapshot: Snapshot, chunks: readonly PackedChunk[]): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite');
    const done = completion(tx);
    try {
      // 先等这一个读完成。之后的写不转成 Promise，写到一半出错时就不会有未处理的 Promise 拒绝。
      const worlds = tx.objectStore(WORLDS);
      const previous = await result<WorldMeta | undefined>(worlds.get(id));
      const { blockStates, editedChunks: _, ...state } = snapshot;
      tx.objectStore(STATES).put(state satisfies WorldState, id);
      tx.objectStore(BLOCK_STATES).put(blockStates, id);
      const chunkStore = tx.objectStore(CHUNKS);
      for (const { cx, cz, data } of chunks) chunkStore.put(data, [id, cx, cz] satisfies ChunkKey);

      const now = this.now();
      const meta: WorldMeta = {
        id,
        name,
        seed: snapshot.seed,
        difficulty: snapshot.difficulty,
        formatVersion: this.versions.format,
        terrainVersion: this.versions.terrain,
        createdAt: previous?.createdAt ?? now,
        lastPlayedAt: now,
        hardcoreDead: snapshot.hardcoreDead,
      };
      worlds.put(meta);
    } catch (error) {
      // 写到一半同步抛出（比如配额不足）时主动中止，已经发出的写一并作废。
      try {
        tx.abort();
      } catch {
        // 事务已经因为别的请求出错而中止了。
      }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
  }
}

/** `chunks` 表的键。 */
type ChunkKey = [worldId: string, cx: number, cz: number];

/** 已经压缩、要写进 `chunks` 表的一个区块。 */
interface PackedChunk extends ChunkCoord {
  readonly data: Uint8Array<ArrayBuffer>;
}

/** 一个世界在 `chunks` 表里的全部键。 */
function chunksOf(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, -Infinity, -Infinity], [id, Infinity, Infinity]);
}

/** 请求的结果。它在 IndexedDB 自己的回调里兑现，在事务里等待它不会让事务提前提交。 */
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 事务提交时兑现，中止时（包括请求出错引起的中止）拒绝。 */
function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('事务已中止', 'AbortError'));
  });
}
