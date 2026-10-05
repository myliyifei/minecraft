import { BlockType } from '../../src/core/block';
import { CHUNK_SIZE } from '../../src/core/constants';
import { Difficulty } from '../../src/core/difficulty';
import { GameCore } from '../../src/core/game';
import { ItemType } from '../../src/core/item';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION, type Snapshot } from '../../src/core/snapshot';
import { gzipChunk } from '../../src/storage/chunk-codec';
import type { WorldFile } from '../../src/storage/world-file';
import { FLAT_GROUND_Y, flatTerrain } from './flat-terrain';

const G = FLAT_GROUND_Y;

/**
 * 平地上的核心：(0,0)、(1,0) 两个区块各挖一格，(-1,2) 放一个熔炉，背包里有 5 个圆石。快照里另外塞一个带损耗的
 * 掉落物与一个经验球，导出文件的校验要走到这两张表。
 */
export function editedSnapshot(difficulty: Difficulty = Difficulty.Normal): Snapshot {
  const game = new GameCore({ viewRadius: 3, difficulty, terrain: flatTerrain });
  game.setBlock(3, G, 3, BlockType.Air);
  game.setBlock(CHUNK_SIZE + 3, G, 3, BlockType.Air);
  game.setBlock(-5, G, 2 * CHUNK_SIZE + 5, BlockType.Furnace);
  game.giveItem(ItemType.Cobblestone, 5);
  game.tick();
  const snapshot = game.snapshot();
  return {
    ...snapshot,
    nextDropId: 4,
    nextXpOrbId: 2,
    drops: [
      {
        id: 3,
        stack: { item: ItemType.StonePickaxe, count: 1, damage: 7 },
        position: { x: 1.5, y: G + 1, z: -2.25 },
        velocity: { x: 0.01, y: -0.2, z: 0 },
        age: 40,
      },
    ],
    xpOrbs: [{ id: 1, amount: 3, position: { x: 0.5, y: G + 1.2, z: 0.5 }, speed: 0.1, age: 12 }],
  };
}

/** 把快照拆成导出文件里的记录：区块各自 gzip，元数据按存储模块写盘时的规则填。 */
export async function worldFileOf(snapshot: Snapshot, name = '洞'): Promise<WorldFile> {
  const { blockStates, editedChunks, ...state } = snapshot;
  const chunks = await Promise.all(editedChunks.map(async ({ cx, cz, blocks }) => ({ cx, cz, data: await gzipChunk(blocks) })));
  return {
    meta: {
      name,
      seed: snapshot.seed,
      difficulty: snapshot.difficulty,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      terrainVersion: TERRAIN_VERSION,
      createdAt: 1_000,
      lastPlayedAt: 2_000,
      hardcoreDead: snapshot.hardcoreDead,
    },
    state,
    blockStates,
    chunks,
  };
}
