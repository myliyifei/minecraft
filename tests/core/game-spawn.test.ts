import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, SEA_LEVEL, UNLOAD_MARGIN } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import { IDLE_INTENT, WALK_STEP } from '../../src/core/player';
import { createTerrain } from '../../src/core/terrain';
import { chunkOf } from '../../src/core/world';
import { FLAT_STAND_Y } from '../helpers/flat-terrain';
import { OCEAN_ORIGIN_SPAWN, oceanOriginChunk, oceanOriginTerrain } from '../helpers/ocean-origin-terrain';

/**
 * 核心的出生点跟着地形对象的出生列走（#84，CONTEXT.md「出生点」、ADR-0018）：构造时先加载出生列所在区块周围，
 * 首次出生点按那一列「最高的实心方块之上」站上去；重生回到同一点，出生列所在区块卸载之后也一样。
 *
 * 真实地形的原点总是平原，出生列几乎总是原点，所以「出生列不在原点」用原点是大海的假地形测
 * （tests/helpers/ocean-origin-terrain.ts）：出生列固定为 (112, −96)，区块 (7, −6)，在视距 2 覆盖的范围之外。
 */

// 与 DEFAULT_SEED 无关的几个种子，加上默认种子
const SEEDS = [314_159, 777, -42, DEFAULT_SEED];

/** 站在假地形出生列的草方块上时，出生点的坐标（方块中心）。 */
const OCEAN_SPAWN_POINT = { x: OCEAN_ORIGIN_SPAWN.x + 0.5, y: FLAT_STAND_Y, z: OCEAN_ORIGIN_SPAWN.z + 0.5 };

/** 假地形出生列所在的区块。 */
const SPAWN_CHUNK = { cx: chunkOf(OCEAN_ORIGIN_SPAWN.x), cz: chunkOf(OCEAN_ORIGIN_SPAWN.z) };

/** 落差这么多格摔 21 点，满血也扣到 0（与 tests/core/death.test.ts 相同）。 */
const LETHAL_DEPTH = 24;

/** 朝 +X 看的偏航。 */
const EAST_YAW = -Math.PI / 2;

/** 转向 +X、走 ticks 个 tick 再站定。假地形出生列以东全是平地。 */
function walkEast(game: GameCore, ticks: number): void {
  game.turn(EAST_YAW - game.player.yaw, 0);
  game.setMoveIntent({ ...IDLE_INTENT, forward: true });
  game.tick(ticks);
  game.setMoveIntent(IDLE_INTENT);
}

/** 挖空玩家脚下那一列，推进到摔死为止。 */
function fallToDeath(game: GameCore): void {
  const { x, z } = game.player.position;
  const top = game.highestBlockY(Math.floor(x), Math.floor(z));
  for (let y = top; y > top - LETHAL_DEPTH; y--) game.setBlock(Math.floor(x), y, Math.floor(z), BlockType.Air);
  for (let n = 0; n < 100 && !game.health.dead; n++) game.tick();
  if (!game.health.dead) throw new Error('100 tick 还没摔死');
}

describe('真实地形：多个种子下新建世界，出生点站在出生列的草方块上', () => {
  it.each(SEEDS)('种子 %i', (seed) => {
    const terrain = createTerrain(seed);
    const { x, z } = terrain.spawnColumn;
    const core = new GameCore({ seed, viewRadius: 1 });
    const spawn = core.spawnPoint;

    expect(spawn).toEqual({ x: x + 0.5, y: terrain.surfaceHeightAt(x, z) + 1, z: z + 0.5 });
    expect(core.player.position).toEqual(spawn);
    expect(core.getBlock(x, spawn.y - 1, z)).toBe(BlockType.Grass);
    expect(core.getBlock(x, spawn.y, z)).toBe(BlockType.Air);
    expect(core.getBlock(x, spawn.y + 1, z)).toBe(BlockType.Air);
  });
});

describe('原点是大海：出生列不在原点', () => {
  it('新建世界后出生列所在区块已加载，首次出生点站在出生列的草方块上，而不是海底或 y −63 一带', () => {
    const core = new GameCore({ viewRadius: 2, terrain: oceanOriginTerrain });

    expect(core.isChunkLoaded(SPAWN_CHUNK.cx, SPAWN_CHUNK.cz)).toBe(true);
    const spawn = core.spawnPoint;
    expect(spawn.y).toBeGreaterThan(SEA_LEVEL);
    expect(spawn).toEqual(OCEAN_SPAWN_POINT);
    expect(core.player.position).toEqual(OCEAN_SPAWN_POINT);
    expect(core.getBlock(OCEAN_ORIGIN_SPAWN.x, FLAT_STAND_Y - 1, OCEAN_ORIGIN_SPAWN.z)).toBe(BlockType.Grass);
  });

  it('先加载的是出生列所在区块周围：视距之内的区块以出生列所在区块为中心', () => {
    const core = new GameCore({ viewRadius: 1, terrain: oceanOriginTerrain });
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        expect(core.isChunkLoaded(SPAWN_CHUNK.cx + dx, SPAWN_CHUNK.cz + dz)).toBe(true);
      }
    }
  });

  it('出生后几秒仍站在原地：脚下的地面已经在世界里，不往下掉', () => {
    const core = new GameCore({ viewRadius: 1, terrain: oceanOriginTerrain });
    core.tick(40);
    expect(core.player.position).toEqual(OCEAN_SPAWN_POINT);
    expect(core.player.onGround).toBe(true);
  });
});

describe('原点是大海：重生回到出生列上的同一点', () => {
  /** 走到离出生列所在区块这么多个区块之外，它就卸载了（视距 1 加卸载余量）。 */
  const FAR_CHUNKS = 1 + UNLOAD_MARGIN + 1;
  /** 走到那里要几 tick：多走几格，越过区块边界。 */
  const FAR_TICKS = Math.ceil((FAR_CHUNKS * CHUNK_SIZE + 4) / WALK_STEP);

  /** 出生列所在区块只在 spawnReady 为真时给得出来，其余照常（模拟浏览器里 Worker 还没送到）。 */
  function coreWithGatedSpawnChunk(): { game: GameCore; setSpawnReady(ready: boolean): void } {
    let spawnReady = true;
    const game = new GameCore({
      viewRadius: 1,
      terrain: (seed: number) => ({
        ...oceanOriginTerrain(seed),
        generateChunk: (cx: number, cz: number): Chunk | undefined =>
          cx === SPAWN_CHUNK.cx && cz === SPAWN_CHUNK.cz && !spawnReady ? undefined : oceanOriginChunk(cx, cz),
      }),
    });
    return { game, setSpawnReady: (ready) => (spawnReady = ready) };
  }

  it('死在出生列附近：重生在出生点', () => {
    const game = new GameCore({ viewRadius: 1, terrain: oceanOriginTerrain });
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    walkEast(game, 14);
    fallToDeath(game);

    game.respawn();
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    expect(game.spawnPoint).toEqual(OCEAN_SPAWN_POINT);
  });

  it('走远让出生列所在区块卸载、它没改过也还没送到：重生在首次出生点，等区块送到后站在地面上', () => {
    const { game, setSpawnReady } = coreWithGatedSpawnChunk();
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    walkEast(game, FAR_TICKS);
    setSpawnReady(false);
    fallToDeath(game);
    expect(game.isChunkLoaded(SPAWN_CHUNK.cx, SPAWN_CHUNK.cz)).toBe(false);

    game.respawn();
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    game.tick(20);
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);

    setSpawnReady(true);
    game.tick(20);
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    expect(game.player.onGround).toBe(true);
    expect(game.health.points).toBe(20);
  });

  it('出生列所在区块改过又卸载：重生时先把它放回来，站在出生列上新垒的柱子顶上', () => {
    const { game, setSpawnReady } = coreWithGatedSpawnChunk();
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    walkEast(game, 10);
    game.setBlock(OCEAN_ORIGIN_SPAWN.x, FLAT_STAND_Y, OCEAN_ORIGIN_SPAWN.z, BlockType.Cobblestone);
    game.setBlock(OCEAN_ORIGIN_SPAWN.x, FLAT_STAND_Y + 1, OCEAN_ORIGIN_SPAWN.z, BlockType.Cobblestone);
    walkEast(game, FAR_TICKS);
    setSpawnReady(false);
    fallToDeath(game);
    expect(game.isChunkLoaded(SPAWN_CHUNK.cx, SPAWN_CHUNK.cz)).toBe(false);

    game.respawn();
    expect(game.player.position).toEqual({ ...OCEAN_SPAWN_POINT, y: FLAT_STAND_Y + 2 });
    game.tick(20);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 2);
    expect(game.player.onGround).toBe(true);
  });
});

describe('原点是大海：读档不重算首次出生点', () => {
  /** 读档时玩家所在的列：出生列以东 300 格的平地，出生列所在区块在视距之外。 */
  const FAR = { x: OCEAN_ORIGIN_SPAWN.x + 300 + 0.5, y: FLAT_STAND_Y, z: OCEAN_ORIGIN_SPAWN.z + 0.5 };

  it('读档时玩家在远处：首次出生点仍是快照里的值；在远处死亡，重生仍在出生列上', () => {
    const snapshot = new GameCore({ viewRadius: 1, terrain: oceanOriginTerrain }).snapshot();
    expect(snapshot.firstSpawn).toEqual(OCEAN_SPAWN_POINT);
    const far = { ...snapshot, player: { ...snapshot.player, position: FAR } };

    // 出生列所在区块一直给不出来（模拟浏览器里 Worker 还没送到）：读档时若按「未加载即空气」重算，出生点会落到虚空里
    let spawnReady = false;
    const game = new GameCore({
      viewRadius: 1,
      restore: far,
      terrain: (seed: number) => ({
        ...oceanOriginTerrain(seed),
        generateChunk: (cx: number, cz: number): Chunk | undefined =>
          cx === SPAWN_CHUNK.cx && cz === SPAWN_CHUNK.cz && !spawnReady ? undefined : oceanOriginChunk(cx, cz),
      }),
    });
    expect(game.isChunkLoaded(SPAWN_CHUNK.cx, SPAWN_CHUNK.cz)).toBe(false);
    expect(game.player.position).toEqual(FAR);
    expect(game.spawnPoint).toEqual(OCEAN_SPAWN_POINT);
    expect(game.snapshot().firstSpawn).toEqual(OCEAN_SPAWN_POINT);

    fallToDeath(game);
    game.respawn();
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);

    spawnReady = true;
    game.tick(20);
    expect(game.player.position).toEqual(OCEAN_SPAWN_POINT);
    expect(game.player.onGround).toBe(true);
  });
});
