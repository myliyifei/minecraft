import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_BLOCK_COUNT } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { ItemType } from '../../src/core/item';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION, type Snapshot } from '../../src/core/snapshot';
import { gunzipChunk, gzipChunk } from '../../src/storage/chunk-codec';
import { decodeWorldFile, encodeWorldFile, type WorldFile } from '../../src/storage/world-file';
import { CHUNK_PUT_BATCH, openWorldStorage, type WorldStorage, type WorldStorageOptions } from '../../src/storage/world-storage';
import { FLAT_GROUND_Y, flatTerrain } from '../helpers/flat-terrain';

const G = FLAT_GROUND_Y;

/** 每个测试一个新的空库。写进元数据的时刻取 `clock.now`，由测试设定。 */
function fixture() {
  const factory = new IDBFactory();
  const clock = { now: 1_000 };
  const open = (options: Partial<WorldStorageOptions> = {}): Promise<WorldStorage> =>
    openWorldStorage({ indexedDB: factory, now: () => clock.now, ...options });
  return { factory, clock, open };
}

/** 平地上的核心：(0,0)、(1,0) 两个区块各挖一格，(-1,2) 放一个熔炉，背包里有 5 个圆石。 */
function editedGame(difficulty: Difficulty = Difficulty.Normal): GameCore {
  const game = new GameCore({ viewRadius: 3, difficulty, terrain: flatTerrain });
  game.setBlock(3, G, 3, BlockType.Air);
  game.setBlock(CHUNK_SIZE + 3, G, 3, BlockType.Air);
  game.setBlock(-5, G, 2 * CHUNK_SIZE + 5, BlockType.Furnace);
  game.giveItem(ItemType.Cobblestone, 5);
  game.tick();
  return game;
}

/** 快照的已改区块按坐标排好序。读回来的顺序不必与写入时相同。 */
function sorted(snapshot: Snapshot): Snapshot {
  const editedChunks = [...snapshot.editedChunks].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  return { ...snapshot, editedChunks };
}

/** 快照里带的区块坐标。 */
function coordsOf(snapshot: Snapshot): { cx: number; cz: number }[] {
  return snapshot.editedChunks.map(({ cx, cz }) => ({ cx, cz }));
}

/** 读档并取出快照。结果不是 ok 时抛出。 */
async function loaded(storage: WorldStorage, id: string): Promise<Snapshot> {
  const result = await storage.loadWorld(id);
  if (result.status !== 'ok') throw new Error(`读档结果是 ${result.status}`);
  return result.snapshot;
}

/** 一个请求的结果。 */
function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 这个工厂里所有库、所有表的记录数，键是「库名/表名」。删除的测试用它直接数四张表。 */
async function recordCounts(factory: IDBFactory): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { name } of await factory.databases()) {
    const db = await requested(factory.open(name!));
    for (const store of db.objectStoreNames) {
      counts[`${name}/${store}`] = await requested(db.transaction(store).objectStore(store).count());
    }
    db.close();
  }
  return counts;
}

/** IndexedDB 里存已改区块的那张表（表名见 issue #65）。 */
function isChunkStore(store: unknown): boolean {
  return (store as IDBObjectStore).name === 'chunks';
}

/** 从现在起在区块表上调用 `method` 的次数。 */
function chunkStoreCalls(method: 'put' | 'getAll'): () => number {
  const spy = vi.spyOn(IDBObjectStore.prototype, method);
  return () => spy.mock.contexts.filter(isChunkStore).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('存档的写与读（ADR-0018）', () => {
  it('写一个带 3 个已改区块的快照，读回来逐字节相同', async () => {
    const { open } = fixture();
    const storage = await open();
    const snapshot = editedGame().snapshot();
    expect(snapshot.editedChunks).toHaveLength(3);
    expect(snapshot.blockStates).toHaveLength(1);

    expect(await storage.saveWorld('a', '洞', snapshot)).toEqual({ ok: true });
    expect(sorted(await loaded(storage, 'a'))).toEqual(sorted(snapshot));
  });

  it('带水与冰的已改区块写盘再读回逐字节相同，构造出的核心里水与冰都在原处（#74）', async () => {
    const { open } = fixture();
    const storage = await open();
    const game = new GameCore({ viewRadius: 1, terrain: flatTerrain });
    // 原点区块里挖一个两格深的坑灌水、水面结冰；隔壁区块单放一格水
    for (const [x, z] of [[3, 3], [4, 3], [3, 4], [4, 4]]) {
      game.setBlock(x, G - 1, z, BlockType.Water);
      game.setBlock(x, G, z, BlockType.Ice);
    }
    game.setBlock(-2, G + 1, 5, BlockType.Water);
    const snapshot = game.snapshot();
    expect(snapshot.editedChunks.map(({ cx, cz }) => `${cx},${cz}`).sort()).toEqual(['-1,0', '0,0']);

    expect(await storage.saveWorld('a', '湖', snapshot)).toEqual({ ok: true });
    const back = sorted(await loaded(storage, 'a'));
    expect(back).toEqual(sorted(snapshot));
    for (const chunk of back.editedChunks) {
      const original = snapshot.editedChunks.find(({ cx, cz }) => cx === chunk.cx && cz === chunk.cz)!;
      expect(chunk.blocks, `区块 (${chunk.cx}, ${chunk.cz})`).toEqual(original.blocks);
    }

    const restored = new GameCore({ viewRadius: 1, terrain: flatTerrain, restore: back });
    expect(restored.getBlock(3, G - 1, 3)).toBe(BlockType.Water);
    expect(restored.getBlock(4, G, 4)).toBe(BlockType.Ice);
    expect(restored.getBlock(-2, G + 1, 5)).toBe(BlockType.Water);
  });

  it('读回的快照能直接构造核心，方块与玩家都在', async () => {
    const { open } = fixture();
    const storage = await open();
    const game = editedGame();
    await storage.saveWorld('a', '洞', game.snapshot());

    const restored = new GameCore({ viewRadius: 3, terrain: flatTerrain, restore: await loaded(storage, 'a') });
    expect(restored.getBlock(3, G, 3)).toBe(BlockType.Air);
    expect(restored.getBlock(-5, G, 2 * CHUNK_SIZE + 5)).toBe(BlockType.Furnace);
    expect(restored.inventory.slot(0)).toEqual({ item: ItemType.Cobblestone, count: 5 });
    expect(restored.tickCount).toBe(game.tickCount);
  });

  it('区块经注入的压缩函数压缩，库里存的就是它返回的字节；压完一个再压下一个，同一时刻最多一个在压', async () => {
    // 浏览器里注入的是压缩 Worker，Node 里默认直接压。逐个压：压缩之前要把方块数组复制进 Blob，在主线程上压时
    // 一起开始的话，所有复制都在暂停的那一帧里（#71，ADR-0018 补记）。
    const { open } = fixture();
    const given: Uint8Array[] = [];
    const returned: Uint8Array[] = [];
    let active = 0;
    let peak = 0;
    const storage = await open({
      gzip: async (blocks) => {
        given.push(blocks);
        peak = Math.max(peak, ++active);
        const data = await gzipChunk(blocks);
        active--;
        returned.push(data);
        return data;
      },
    });
    const snapshot = editedGame().snapshot();
    expect(snapshot.editedChunks).toHaveLength(3);

    expect(await storage.saveWorld('a', '洞', snapshot)).toEqual({ ok: true });
    expect(peak).toBe(1);
    expect(given).toEqual(snapshot.editedChunks.map(({ blocks }) => blocks));
    const records = await storage.readRecords('a');
    expect(new Set(records!.chunks.map(({ data }) => Buffer.from(data).toString('hex')))).toEqual(
      new Set(returned.map((data) => Buffer.from(data).toString('hex'))),
    );
  });

  it('区块的写分批发出：一批写完才发下一批，全部在同一个事务里，读回来一个不少', async () => {
    // 理由见 `CHUNK_PUT_BATCH`。
    // 压缩不是这里要测的：每个区块都是同一块全零，压缩函数直接给预先压好的那份
    const packed = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT));
    const { open } = fixture();
    const storage = await open({ gzip: async () => packed.slice() });
    const base = editedGame().snapshot();
    const count = 2 * CHUNK_PUT_BATCH + 1;
    const editedChunks = Array.from({ length: count }, (_, i) => ({ cx: i, cz: -i, blocks: new Uint8Array(CHUNK_BLOCK_COUNT) }));
    const snapshot: Snapshot = { ...base, blockStates: [], editedChunks };

    // 每个区块的写发出时，之前发出的区块写有几个已经完成
    const issued: IDBRequest[] = [];
    const doneBefore: number[] = [];
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const request = original.apply(this, args);
      if (isChunkStore(this)) {
        doneBefore.push(issued.filter(({ readyState }) => readyState === 'done').length);
        issued.push(request);
      }
      return request;
    });
    expect(await storage.saveWorld('a', '洞', snapshot)).toEqual({ ok: true });
    vi.restoreAllMocks();

    expect(doneBefore).toHaveLength(count);
    // 第一批一起发出；第二批、第三批的第一个发出时，前面那一批已经全部写完
    expect(doneBefore.slice(0, CHUNK_PUT_BATCH).every((done) => done === 0)).toBe(true);
    expect(doneBefore[CHUNK_PUT_BATCH]).toBe(CHUNK_PUT_BATCH);
    expect(doneBefore[2 * CHUNK_PUT_BATCH]).toBe(2 * CHUNK_PUT_BATCH);
    const records = await storage.readRecords('a');
    expect(records!.chunks.map(({ cx, cz }) => `${cx},${cz}`).sort()).toEqual(editedChunks.map(({ cx, cz }) => `${cx},${cz}`).sort());
  });

  it('第二次只改了 1 个区块，区块表只写那一条；其余两条还是第一次写的', async () => {
    const { open } = fixture();
    const storage = await open();
    const game = editedGame();
    const first = sorted(game.snapshot());
    await storage.saveWorld('a', '洞', first);

    game.setBlock(4, G, 4, BlockType.Air);
    const second = game.snapshot();
    expect(coordsOf(second)).toEqual([{ cx: 0, cz: 0 }]);
    const puts = chunkStoreCalls('put');
    expect(await storage.saveWorld('a', '洞', second)).toEqual({ ok: true });
    expect(puts()).toBe(1);

    const back = sorted(await loaded(storage, 'a')).editedChunks;
    expect(back.map(({ cx, cz }) => [cx, cz])).toEqual([[-1, 2], [0, 0], [1, 0]]);
    expect(back[0]).toEqual(first.editedChunks[0]);
    expect(back[1]!.blocks).toEqual(second.editedChunks[0]!.blocks);
    expect(back[2]).toEqual(first.editedChunks[2]);
  });

  it('两个世界的记录各自分开：区块、种子、名称只在自己名下', async () => {
    const { open } = fixture();
    const storage = await open();
    const a = new GameCore({ viewRadius: 1, seed: 1, terrain: flatTerrain });
    const b = new GameCore({ viewRadius: 1, seed: 2, terrain: flatTerrain });
    a.setBlock(1, G, 1, BlockType.Air);
    b.setBlock(-1, G, -1, BlockType.Air);
    await storage.saveWorld('a', '甲', a.snapshot());
    await storage.saveWorld('b', '乙', b.snapshot());

    const backA = await loaded(storage, 'a');
    const backB = await loaded(storage, 'b');
    expect(backA.seed).toBe(1);
    expect(backB.seed).toBe(2);
    expect(coordsOf(backA)).toEqual([{ cx: 0, cz: 0 }]);
    expect(coordsOf(backB)).toEqual([{ cx: -1, cz: -1 }]);
    expect((await storage.listWorlds()).map(({ meta }) => meta.name).sort()).toEqual(['乙', '甲']);
  });

  it('同一个世界的两次写盘重叠时按调用顺序提交：读回后一次的状态，前一次的区块也在', async () => {
    // 先发起的那次带 3 个区块、要先压缩，后发起的那次不带区块、可以立即开事务。不按调用顺序排队时，
    // 后一次先提交，前一次再用旧的玩家与 tick 覆盖它。
    const { open } = fixture();
    const storage = await open();
    const game = editedGame();
    const first = game.snapshot();
    game.tick();
    const second = game.snapshot();
    expect(second.editedChunks).toHaveLength(0);

    const results = await Promise.all([storage.saveWorld('a', '洞', first), storage.saveWorld('a', '洞', second)]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(sorted(await loaded(storage, 'a'))).toEqual(sorted({ ...second, editedChunks: first.editedChunks }));
  });

  it('没有这个世界时读档返回「不存在」', async () => {
    const { open } = fixture();
    const storage = await open();
    expect(await storage.loadWorld('nope')).toEqual({ status: 'missing' });
  });
});

describe('世界元数据与世界列表', () => {
  it('种子、难度、已死亡标记取自快照；创建时间只在第一次写时定，上次游玩时间每次更新', async () => {
    const { open, clock } = fixture();
    const storage = await open();
    const game = editedGame(Difficulty.Hard);
    await storage.saveWorld('a', '洞', game.snapshot());
    clock.now = 5_000;
    await storage.saveWorld('a', '洞', game.snapshot());

    expect(await storage.listWorlds()).toEqual([
      {
        meta: {
          id: 'a',
          name: '洞',
          seed: game.seed,
          difficulty: Difficulty.Hard,
          formatVersion: SNAPSHOT_FORMAT_VERSION,
          terrainVersion: TERRAIN_VERSION,
          createdAt: 1_000,
          lastPlayedAt: 5_000,
          hardcoreDead: false,
        },
        compatible: true,
      },
    ]);
  });

  it('列表按上次游玩时间倒序', async () => {
    const { open, clock } = fixture();
    const storage = await open();
    for (const [id, at] of [['a', 3], ['b', 1], ['c', 2]] as const) {
      clock.now = at;
      await storage.saveWorld(id, id, editedGame().snapshot());
    }
    clock.now = 4;
    await storage.saveWorld('b', 'b', editedGame().snapshot());
    expect((await storage.listWorlds()).map(({ meta }) => meta.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('版本不兼容', () => {
  it.each([
    ['快照格式版本', { format: SNAPSHOT_FORMAT_VERSION + 1, terrain: TERRAIN_VERSION }],
    ['地形版本', { format: SNAPSHOT_FORMAT_VERSION, terrain: TERRAIN_VERSION + 1 }],
  ])('%s与存档里的相差 1 时读档返回不兼容、不读区块，列表里标为不兼容', async (_, versions) => {
    const { open } = fixture();
    await (await open()).saveWorld('a', '洞', editedGame().snapshot());

    const newer = await open({ versions });
    const chunkReads = chunkStoreCalls('getAll');
    const result = await newer.loadWorld('a');
    expect(result.status).toBe('incompatible');
    expect(result.status === 'incompatible' && result.meta.id).toBe('a');
    expect(chunkReads()).toBe(0);
    expect((await newer.listWorlds()).map(({ compatible }) => compatible)).toEqual([false]);
  });

  it('地形算法版本是 2（#75：三维密度地形）', () => {
    expect(TERRAIN_VERSION).toBe(2);
  });

  it('地形版本为 1 的世界（第六切片建的）读档返回不兼容、不读区块，列表里标为不兼容', async () => {
    const { open } = fixture();
    await (await open({ versions: { format: SNAPSHOT_FORMAT_VERSION, terrain: 1 } })).saveWorld('a', '旧地形', editedGame().snapshot());

    const current = await open();
    const chunkReads = chunkStoreCalls('getAll');
    const result = await current.loadWorld('a');
    expect(result.status).toBe('incompatible');
    expect(chunkReads()).toBe(0);
    expect(await current.listWorlds()).toEqual([
      { meta: expect.objectContaining({ id: 'a', terrainVersion: 1 }), compatible: false },
    ]);
  });
});

describe('删除世界', () => {
  it('删掉之后四张表里都没有它的记录', async () => {
    const { open, factory } = fixture();
    const storage = await open();
    await storage.saveWorld('a', '洞', editedGame().snapshot());
    const before = await recordCounts(factory);
    expect(Object.keys(before)).toHaveLength(4);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    await storage.deleteWorld('a');
    expect(Object.values(await recordCounts(factory))).toEqual([0, 0, 0, 0]);
    expect(await storage.loadWorld('a')).toEqual({ status: 'missing' });
    expect(await storage.listWorlds()).toEqual([]);
  });

  it('只删这一个世界，另一个原样读得出', async () => {
    const { open } = fixture();
    const storage = await open();
    const keep = editedGame().snapshot();
    await storage.saveWorld('a', '甲', editedGame().snapshot());
    await storage.saveWorld('b', '乙', keep);
    await storage.deleteWorld('a');
    expect(sorted(await loaded(storage, 'b'))).toEqual(sorted(keep));
  });
});

describe('写盘失败整次回滚（ADR-0018）', () => {
  type PutArgs = Parameters<IDBObjectStore['put']>;

  /**
   * 写一份；再改两个区块、放一个熔炉、多拿一样东西，写第二份。第二份的每次 put 都交给 fail，
   * fail 调 proceed 就照常写。
   */
  async function failSecondSave(fail: (store: IDBObjectStore, proceed: () => IDBRequest) => IDBRequest) {
    const { open, clock } = fixture();
    const storage = await open();
    const game = editedGame();
    const first = game.snapshot();
    await storage.saveWorld('a', '洞', first);
    const listed = await storage.listWorlds();

    game.setBlock(4, G, 4, BlockType.Air);
    game.setBlock(CHUNK_SIZE + 4, G, 4, BlockType.Furnace);
    game.giveItem(ItemType.Coal, 1);
    const second = game.snapshot();
    expect(second.blockStates).toHaveLength(2);
    clock.now = 9_000;

    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: PutArgs) {
      return fail(this, () => original.apply(this, args));
    });
    const result = await storage.saveWorld('a', '洞', second);
    vi.restoreAllMocks();
    return { storage, game, first, second, listed, result };
  }

  /** 返回失败与这次的区块坐标，四张表都是第一次写的内容。 */
  async function expectRolledBack({ storage, first, second, listed, result }: Awaited<ReturnType<typeof failSecondSave>>) {
    expect(result.ok).toBe(false);
    expect(!result.ok && result.chunks).toEqual(coordsOf(second));
    expect(sorted(await loaded(storage, 'a'))).toEqual(sorted(first));
    expect(await storage.listWorlds()).toEqual(listed);
  }

  it('压缩函数拒绝时写盘失败、整次回滚，返回这次的区块坐标', async () => {
    const { open } = fixture();
    const storage = await open({ gzip: () => Promise.reject(new Error('Worker 出错')) });
    const snapshot = editedGame().snapshot();
    const result = await storage.saveWorld('a', '洞', snapshot);
    expect(result).toMatchObject({ ok: false, chunks: coordsOf(snapshot) });
    expect(await storage.listWorlds()).toEqual([]);
  });

  it('第二条区块的 put 同步抛出配额不足', async () => {
    let chunkPuts = 0;
    await expectRolledBack(
      await failSecondSave((store, proceed) => {
        if (isChunkStore(store) && ++chunkPuts === 2) throw new DOMException('配额不足', 'QuotaExceededError');
        return proceed();
      }),
    );
  });

  it('四张表的写都已发出之后事务才中止：失败只能由事务的中止事件报出来', async () => {
    // 元数据是事务里最后一条写。它发出之后再没有同步代码，事务中止只能等 `onabort` 报告。
    await expectRolledBack(
      await failSecondSave((store, proceed) => {
        const request = proceed();
        if (store.name === 'worlds') store.transaction.abort();
        return request;
      }),
    );
  });

  it('返回的区块坐标放回核心之后，下次写盘把这几个区块补上', async () => {
    const { storage, game, result } = await failSecondSave(() => {
      throw new DOMException('配额不足', 'QuotaExceededError');
    });
    if (result.ok) throw new Error('应当写失败');
    game.returnUnsavedChunks(result.chunks);
    expect(await storage.saveWorld('a', '洞', game.snapshot())).toEqual({ ok: true });

    const restored = new GameCore({ viewRadius: 3, terrain: flatTerrain, restore: await loaded(storage, 'a') });
    expect(restored.getBlock(4, G, 4)).toBe(BlockType.Air);
    expect(restored.getBlock(CHUNK_SIZE + 4, G, 4)).toBe(BlockType.Furnace);
  });
});

describe('导出导入读写的原始记录（#70）', () => {
  /** 按坐标排好序的区块段。 */
  function sortedChunks<T extends { cx: number; cz: number }>(chunks: readonly T[]): T[] {
    return [...chunks].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  }

  /** 读出一个世界的记录、编码成导出文件、再解码，像导入时那样拿到文件里的记录。 */
  async function exported(storage: WorldStorage, id: string): Promise<WorldFile> {
    const records = await storage.readRecords(id);
    if (!records) throw new Error(`没有世界 ${id}`);
    const encoded = encodeWorldFile(records);
    if (!encoded.ok) throw new Error(`编码失败：${encoded.reason}`);
    const result = await decodeWorldFile(encoded.buffer);
    if (!result.ok) throw new Error(`解码失败：${result.reason}`);
    return result.file;
  }

  it('读出的是四张表里的原样记录：区块是库里的 gzip 字节，不解压', async () => {
    const { open } = fixture();
    const storage = await open();
    const snapshot = editedGame().snapshot();
    await storage.saveWorld('a', '洞', snapshot);

    const records = await storage.readRecords('a');
    const { blockStates, editedChunks: _, ...state } = snapshot;
    expect(records?.meta).toEqual((await storage.listWorlds())[0]!.meta);
    expect(records?.state).toEqual(state);
    expect(records?.blockStates).toEqual(blockStates);
    expect(sortedChunks(records!.chunks).map(({ cx, cz }) => [cx, cz])).toEqual([[-1, 2], [0, 0], [1, 0]]);
    const back = await loaded(storage, 'a');
    for (const { cx, cz, data } of records!.chunks) {
      const blocks = back.editedChunks.find((chunk) => chunk.cx === cx && chunk.cz === cz)!.blocks;
      expect(await gunzipChunk(data)).toEqual(blocks);
    }
  });

  it('版本不兼容的世界也读得出原始记录；没有这个世界时是 undefined', async () => {
    const { open } = fixture();
    const old = await open({ versions: { format: SNAPSHOT_FORMAT_VERSION + 1, terrain: TERRAIN_VERSION } });
    await old.saveWorld('a', '旧', editedGame().snapshot());
    old.close();
    const storage = await open();
    expect((await storage.loadWorld('a')).status).toBe('incompatible');
    const records = await storage.readRecords('a');
    expect(records?.meta.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION + 1);
    expect(records?.chunks).toHaveLength(3);
    expect(await storage.readRecords('nope')).toBeUndefined();
  });

  it('导入写成一个新世界：名称与创建时间沿用文件里的，上次游玩时间取当前；读回的快照与原世界相同', async () => {
    const { open, clock } = fixture();
    const storage = await open();
    await storage.saveWorld('a', '洞', editedGame().snapshot());
    const file = await exported(storage, 'a');
    clock.now = 7_000;

    await storage.importWorld('b', file);
    const [imported, original] = await storage.listWorlds();
    expect(imported).toEqual({ meta: { ...original!.meta, id: 'b', lastPlayedAt: 7_000 }, compatible: true });
    expect(sorted(await loaded(storage, 'b'))).toEqual(sorted(await loaded(storage, 'a')));
  });

  it('同一个文件导入两次是两个世界，与原世界三者互不影响', async () => {
    const { open } = fixture();
    const storage = await open();
    const game = editedGame();
    await storage.saveWorld('a', '洞', game.snapshot());
    const file = await exported(storage, 'a');
    await storage.importWorld('b', file);
    await storage.importWorld('c', file);
    const before = sorted(await loaded(storage, 'a'));

    const copy = new GameCore({ viewRadius: 3, terrain: flatTerrain, restore: await loaded(storage, 'b') });
    copy.setBlock(5, G, 5, BlockType.Air);
    copy.setBlock(-CHUNK_SIZE * 3, G, 0, BlockType.Air);
    await storage.saveWorld('b', '洞', copy.snapshot());

    expect(sorted(await loaded(storage, 'a'))).toEqual(before);
    expect(sorted(await loaded(storage, 'c'))).toEqual(before);
    const changed = await loaded(storage, 'b');
    expect(changed.editedChunks).toHaveLength(4);
    const restored = new GameCore({ viewRadius: 3, terrain: flatTerrain, restore: changed });
    expect(restored.getBlock(5, G, 5)).toBe(BlockType.Air);
    await storage.deleteWorld('c');
    expect((await storage.listWorlds()).map(({ meta }) => meta.id).sort()).toEqual(['a', 'b']);
  });

  it('写到一半失败时整次回滚，这个 id 在四张表里一条都没有', async () => {
    const { open, factory } = fixture();
    const storage = await open();
    await storage.saveWorld('a', '洞', editedGame().snapshot());
    const file = await exported(storage, 'a');
    const counts = await recordCounts(factory);

    const original = IDBObjectStore.prototype.put;
    let chunkPuts = 0;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (isChunkStore(this) && ++chunkPuts === 2) throw new DOMException('配额不足', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(storage.importWorld('b', file)).rejects.toThrow('配额不足');
    vi.restoreAllMocks();

    expect(await recordCounts(factory)).toEqual(counts);
    expect(await storage.loadWorld('b')).toEqual({ status: 'missing' });
  });
});
