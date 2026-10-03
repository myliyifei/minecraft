import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_SIZE } from '../../src/core/constants';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { ItemType } from '../../src/core/item';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION, type Snapshot } from '../../src/core/snapshot';
import { openWorldStorage, type WorldStorage, type WorldStorageOptions } from '../../src/storage/world-storage';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

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
  const game = new GameCore({ viewRadius: 3, difficulty, chunkSource: () => flatTestTerrain });
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

  it('读回的快照能直接构造核心，方块与玩家都在', async () => {
    const { open } = fixture();
    const storage = await open();
    const game = editedGame();
    await storage.saveWorld('a', '洞', game.snapshot());

    const restored = new GameCore({ viewRadius: 3, chunkSource: () => flatTestTerrain, restore: await loaded(storage, 'a') });
    expect(restored.getBlock(3, G, 3)).toBe(BlockType.Air);
    expect(restored.getBlock(-5, G, 2 * CHUNK_SIZE + 5)).toBe(BlockType.Furnace);
    expect(restored.inventory.slot(0)).toEqual({ item: ItemType.Cobblestone, count: 5 });
    expect(restored.tickCount).toBe(game.tickCount);
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
    const a = new GameCore({ viewRadius: 1, seed: 1, chunkSource: () => flatTestTerrain });
    const b = new GameCore({ viewRadius: 1, seed: 2, chunkSource: () => flatTestTerrain });
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

    const restored = new GameCore({ viewRadius: 3, chunkSource: () => flatTestTerrain, restore: await loaded(storage, 'a') });
    expect(restored.getBlock(4, G, 4)).toBe(BlockType.Air);
    expect(restored.getBlock(CHUNK_SIZE + 4, G, 4)).toBe(BlockType.Furnace);
  });
});
