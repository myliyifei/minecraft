import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_BLOCK_COUNT } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import type { Snapshot } from '../../src/core/snapshot';
import { gzipChunk } from '../../src/storage/chunk-codec';
import { decodeWorldFile, encodeWorldFile, type WorldFile } from '../../src/storage/world-file';
import { openWorldStorage } from '../../src/storage/world-storage';
import { FLAT_GROUND_Y, flatTerrain } from '../helpers/flat-terrain';
import {
  GRAVEL,
  GRAVEL_ITEM,
  NEW_SURFACE_BLOCKS,
  SAND,
  SAND_ITEM,
  SNOWY_GRASS,
  expectSurfaceBlocksDefined,
} from '../helpers/surface-rules';
import { editedSnapshot, worldFileOf } from '../helpers/world-file';

/**
 * 带沙子、沙砾、雪草方块的存档（#76）：已改区块快照往返后逐字节相同，导入校验认得新编号。
 */
const G = FLAT_GROUND_Y;

/** 三种新方块与它们放在哪一格：沙子悬空放（这一切片不下落），两个区块都有。 */
function placements(): Array<[x: number, y: number, z: number, block: BlockType]> {
  return [
    [3, G, 3, SNOWY_GRASS],
    [3, G + 3, 3, SAND],
    [CHUNK_SIZE + 3, G + 1, 3, GRAVEL],
    [CHUNK_SIZE + 4, G, 3, SNOWY_GRASS],
  ];
}

/** 平地上的核心：放下三种新方块，背包里有沙子与沙砾。 */
function editedGame(): GameCore {
  const game = new GameCore({ viewRadius: 3, terrain: flatTerrain });
  for (const [x, y, z, block] of placements()) game.setBlock(x, y, z, block);
  game.giveItem(SAND_ITEM, 7);
  game.giveItem(GRAVEL_ITEM, 9);
  game.tick();
  return game;
}

function sorted(snapshot: Snapshot): Snapshot {
  const editedChunks = [...snapshot.editedChunks].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  return { ...snapshot, editedChunks };
}

describe('带沙子、沙砾、雪草方块的已改区块', () => {
  it('三种新方块放得下去：核心读回来就是放下的那种，悬空的沙子停在原处', () => {
    expectSurfaceBlocksDefined();
    const game = editedGame();
    for (const [x, y, z, block] of placements()) expect(game.getBlock(x, y, z), `(${x}, ${y}, ${z})`).toBe(block);
  });

  it('写进存档再读回来，快照逐字节相同', async () => {
    expectSurfaceBlocksDefined();
    const storage = await openWorldStorage({ indexedDB: new IDBFactory(), now: () => 1_000 });
    const snapshot = editedGame().snapshot();
    expect(snapshot.editedChunks).toHaveLength(2);

    expect(await storage.saveWorld('a', '滩', snapshot)).toEqual({ ok: true });
    const result = await storage.loadWorld('a');
    if (result.status !== 'ok') throw new Error(`读档结果是 ${result.status}`);
    expect(sorted(result.snapshot)).toEqual(sorted(snapshot));
    for (const [i, chunk] of sorted(result.snapshot).editedChunks.entries()) {
      expect(new Uint8Array(chunk.blocks)).toEqual(new Uint8Array(sorted(snapshot).editedChunks[i]!.blocks));
    }
  });

  it('读回的快照构造核心，三种新方块与背包里的沙子、沙砾都在', async () => {
    expectSurfaceBlocksDefined();
    const storage = await openWorldStorage({ indexedDB: new IDBFactory(), now: () => 1_000 });
    const game = editedGame();
    await storage.saveWorld('a', '滩', game.snapshot());
    const result = await storage.loadWorld('a');
    if (result.status !== 'ok') throw new Error(`读档结果是 ${result.status}`);

    const restored = new GameCore({ viewRadius: 3, terrain: flatTerrain, restore: result.snapshot });
    for (const [x, y, z, block] of placements()) expect(restored.getBlock(x, y, z)).toBe(block);
    const items = Array.from({ length: restored.inventory.size }, (_, i) => restored.inventory.slot(i));
    expect(items).toContainEqual({ item: SAND_ITEM, count: 7 });
    expect(items).toContainEqual({ item: GRAVEL_ITEM, count: 9 });
  });

  it('导出文件编码后再解码，记录相同；再编码一次逐字节相同', async () => {
    expectSurfaceBlocksDefined();
    const file = await worldFileOf(editedGame().snapshot());
    const first = encodeWorldFile(file);
    if (!first.ok) throw new Error(`编码失败：${first.reason}`);
    const back = await decodeWorldFile(first.buffer);
    if (!back.ok) throw new Error(`解码失败：${back.reason}`);
    expect(back.file).toEqual(file);
    const second = encodeWorldFile(back.file);
    if (!second.ok) throw new Error(`编码失败：${second.reason}`);
    expect(new Uint8Array(second.buffer)).toEqual(new Uint8Array(first.buffer));
  });
});

describe('导入校验认得新编号', () => {
  /** 一份合法的导出文件，区块只有 (0, 0) 一个、全是 block。熔炉所在的区块不在了，方块状态表一起清空。 */
  async function fileWithChunkOf(block: BlockType): Promise<ArrayBuffer> {
    const file: WorldFile = await worldFileOf(editedSnapshot());
    const data = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT).fill(block));
    const result = encodeWorldFile({ ...file, blockStates: [], chunks: [{ cx: 0, cz: 0, data }] });
    if (!result.ok) throw new Error(`编码失败：${result.reason}`);
    return result.buffer;
  }

  it('区块里全是三种新方块之一时导入成功', async () => {
    expectSurfaceBlocksDefined();
    for (const [name, block] of NEW_SURFACE_BLOCKS) {
      const result = await decodeWorldFile(await fileWithChunkOf(block));
      expect(result.ok, name).toBe(true);
    }
  });

  it('对照：这份文件把第一个区块换成全是石头时同样导入成功，换成未知编号时失败', async () => {
    expect((await decodeWorldFile(await fileWithChunkOf(BlockType.Stone))).ok).toBe(true);
    const unknown = Math.max(...Object.values(BlockType)) + 1;
    expect((await decodeWorldFile(await fileWithChunkOf(unknown as BlockType))).ok).toBe(false);
  });

  it('背包、掉落物里的沙子与沙砾导入时认得', async () => {
    expectSurfaceBlocksDefined();
    const snapshot = editedSnapshot();
    const file = await worldFileOf({
      ...snapshot,
      drops: [{ ...snapshot.drops[0]!, stack: { item: GRAVEL_ITEM, count: 12 } }],
    });
    const inventory = [...file.state.player.inventory];
    inventory[1] = { item: SAND_ITEM, count: 64 };
    inventory[2] = { item: GRAVEL_ITEM, count: 64 };
    const withItems: WorldFile = { ...file, state: { ...file.state, player: { ...file.state.player, inventory } } };
    const encoded = encodeWorldFile(withItems);
    if (!encoded.ok) throw new Error(`编码失败：${encoded.reason}`);
    const result = await decodeWorldFile(encoded.buffer);
    if (!result.ok) throw new Error(`解码失败：${result.reason}`);
    expect(result.file).toEqual(withItems);
  });
});
