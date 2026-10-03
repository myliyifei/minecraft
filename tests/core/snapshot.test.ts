import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Difficulty } from '../../src/core/difficulty';
import { FURNACE_FUEL_SLOT, FURNACE_INPUT_SLOT } from '../../src/core/furnace-slots';
import { GameCore, type GameCoreOptions } from '../../src/core/game';
import { INVENTORY_SIZE } from '../../src/core/inventory';
import { ItemType } from '../../src/core/item';
import type { Snapshot } from '../../src/core/snapshot';
import { aimAt } from '../helpers/aiming';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTestTerrain } from '../helpers/flat-terrain';

const G = FLAT_GROUND_Y;

/** 视距 1 的平地核心。 */
function core(options: GameCoreOptions = {}): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain, ...options });
}

/** 快照里带的已改区块坐标，排好序好比较。 */
function editedKeys(snapshot: Snapshot): string[] {
  return snapshot.editedChunks.map(({ cx, cz }) => `${cx},${cz}`).sort();
}

describe('上次写盘之后改过的区块（ADR-0018）', () => {
  it('写同样的方块不登记；取快照时取走并清空；再改再登记', () => {
    const game = core();
    expect(game.setBlock(3, G, 3, BlockType.Grass)).toBe(true);
    expect(editedKeys(game.snapshot())).toEqual([]);

    game.setBlock(3, G, 3, BlockType.Air);
    game.setBlock(-1, G, 20, BlockType.Air);
    expect(editedKeys(game.snapshot())).toEqual(['-1,1', '0,0']);
    expect(editedKeys(game.snapshot())).toEqual([]);

    game.setBlock(4, G, 4, BlockType.Air);
    expect(editedKeys(game.snapshot())).toEqual(['0,0']);
  });

  it('快照里的区块是复制出来的：取完之后再改世界，快照里的方块不变', () => {
    const game = core();
    game.setBlock(3, G, 3, BlockType.Air);
    const [chunk] = game.snapshot().editedChunks;
    game.setBlock(3, G, 3, BlockType.Stone);
    expect(game.getBlock(3, G, 3)).toBe(BlockType.Stone);
    expect(chunk!.blocks).not.toBe(game.chunkAt(0, 0)!.blocks);
    expect(chunk!.blocks).not.toEqual(game.chunkAt(0, 0)!.blocks);
  });

  it('写盘失败放回之后，下次取快照时还在，与这期间新改的合在一起', () => {
    const game = core();
    game.setBlock(3, G, 3, BlockType.Air);
    const failed = game.snapshot().editedChunks;
    game.returnUnsavedChunks(failed);
    game.setBlock(-1, G, 3, BlockType.Air);
    expect(editedKeys(game.snapshot())).toEqual(['-1,0', '0,0']);
  });

  it('改过几个区块报得出来：离开页面要不要确认看它', () => {
    const game = core();
    expect(game.unsavedChunkCount).toBe(0);
    game.setBlock(3, G, 3, BlockType.Air);
    game.setBlock(4, G, 4, BlockType.Air);
    game.setBlock(-1, G, 3, BlockType.Air);
    expect(game.unsavedChunkCount).toBe(2);
    const taken = game.snapshot().editedChunks;
    expect(game.unsavedChunkCount).toBe(0);
    game.returnUnsavedChunks(taken);
    expect(game.unsavedChunkCount).toBe(2);
  });
});

/** 对着 (x, y, z) 那一格挖到它碎掉为止。瞄的是格内偏移 at 那一点，默认顶面中心附近。 */
function dig(game: GameCore, x: number, y: number, z: number, at = { x: 0.5, y: 0.9, z: 0.5 }): void {
  aimAt(game, { x: x + at.x, y: y + at.y, z: z + at.z });
  game.setMining(true);
  for (let n = 0; n < 200 && game.getBlock(x, y, z) !== BlockType.Air; n++) game.tick();
  game.setMining(false);
  expect(game.getBlock(x, y, z)).toBe(BlockType.Air);
}

/** 对着 (x, y, z) 那一格的顶面按一下使用键。 */
function useOnTop(game: GameCore, x: number, y: number, z: number): void {
  aimAt(game, { x: x + 0.5, y: y + 0.9, z: z + 0.5 });
  game.use();
  game.tick();
}

/** 世界里此刻看得见的状态，两个核心逐 tick 比它。方块另比（`expectSameBlocks`）。 */
function observed(game: GameCore) {
  const player = game.player;
  return {
    ticks: game.tickCount,
    timeOfDay: game.timeOfDay,
    player: {
      position: player.position,
      previousPosition: player.previousPosition,
      yaw: player.yaw,
      pitch: player.pitch,
      onGround: player.onGround,
    },
    health: { points: game.health.points, lastHurtTick: game.health.lastHurtTick, dead: game.health.dead },
    experience: game.experience.total,
    inventory: Array.from({ length: INVENTORY_SIZE }, (_, i) => game.inventory.slot(i)),
    selectedSlot: game.inventory.selectedSlot,
    blockStates: game.allBlockStates(),
    drops: game.drops.all().map(({ id, item, count, position, previousPosition, age }) => ({
      id,
      item,
      count,
      position,
      previousPosition,
      age,
    })),
    xpOrbs: game.xpOrbs.all().map(({ id, amount, position, previousPosition, age }) => ({
      id,
      amount,
      position,
      previousPosition,
      age,
    })),
    zombies: game.zombies.all().map(({ id, position, yaw, age, health, lastHurtTick }) => ({
      id,
      position,
      yaw,
      age,
      health,
      lastHurtTick,
    })),
    loadedChunks: game.loadedChunks().map(({ cx, cz }) => `${cx},${cz}`).sort(),
    spawnPoint: game.spawnPoint,
  };
}

/** 两个核心在这些区块上的方块逐字节相同。 */
function expectSameBlocks(a: GameCore, b: GameCore, coords: Iterable<{ cx: number; cz: number }>): void {
  for (const { cx, cz } of coords) {
    const left = a.chunkAt(cx, cz)?.blocks;
    const right = b.chunkAt(cx, cz)?.blocks;
    expect(left === undefined, `区块 ${cx},${cz} 两边加载与否不同`).toBe(right === undefined);
    if (left && right) expect(Buffer.compare(left, right), `区块 ${cx},${cz} 的方块不同`).toBe(0);
  }
}

/** 推进一 tick 之后两边方块变了的区块合在一起比。 */
function tickBoth(a: GameCore, b: GameCore): void {
  a.tick();
  b.tick();
  const stale = [...a.takeStaleChunks().blocks, ...b.takeStaleChunks().blocks];
  expectSameBlocks(a, b, stale);
  expect(observed(b)).toEqual(observed(a));
}

/** 从 game 的快照构造另一个核心，种子与区块来源相同。 */
function restored(game: GameCore, viewRadius: number): GameCore {
  return new GameCore({ viewRadius, chunkSource: () => flatTestTerrain, restore: game.snapshot() });
}

/** 确定性回归用的视距：僵尸在玩家 24 到 48 格外生成，候选列要落在已加载区块里。 */
const SPAWN_RADIUS = 4;

/**
 * 玩家站在原点 (0.5, 71, 0.5)。白天里放熔炉、往里放原木与煤点着、放两支火把、挖两块草、在背包界面里把火把
 * 留在合成网格里再塞满背包（关界面时火把掉在脚下），挖空脚下 3 格落到坑底，再挖坑壁一格、挖空脚下 6 格让他
 * 往下掉。返回下落途中、着地之前的核心。
 */
function worldBeforeSnapshot(): GameCore {
  const game = core({ viewRadius: SPAWN_RADIUS });
  game.setTimeOfDay(11_000);
  game.giveItem(ItemType.Furnace, 1);
  game.giveItem(ItemType.Torch, 4);
  game.giveItem(ItemType.Coal, 2);
  game.giveItem(ItemType.OakLog, 3);

  game.selectHotbarSlot(0);
  useOnTop(game, 2, G, 0);
  expect(game.getBlock(2, G + 1, 0)).toBe(BlockType.Furnace);
  aimAt(game, { x: 2.1, y: G + 1.5, z: 0.5 });
  game.use();
  game.tick();
  expect(game.furnaceScreen.open).toBe(true);
  game.clickSlot(3);
  game.clickSlot(INVENTORY_SIZE + FURNACE_INPUT_SLOT);
  game.clickSlot(2);
  game.clickSlot(INVENTORY_SIZE + FURNACE_FUEL_SLOT);
  game.toggleInventory();
  game.tick(5);
  expect(game.getBlock(2, G + 1, 0)).toBe(BlockType.LitFurnace);

  game.selectHotbarSlot(1);
  useOnTop(game, -2, G, 0);
  useOnTop(game, 0, G, -2);
  expect(game.getBlock(-2, G + 1, 0)).toBe(BlockType.Torch);
  dig(game, 0, G, 2);
  game.tick(20);

  game.toggleInventory();
  game.tick();
  game.clickSlot(1);
  game.clickSlot(game.inventoryScreen.crafting!.firstSlot);
  game.tick();
  game.giveItem(ItemType.Cobblestone, 64 * INVENTORY_SIZE);
  game.toggleInventory();
  game.tick();
  expect(game.drops.all().some((drop) => drop.item === ItemType.Torch)).toBe(true);

  // 先挖 3 格落下去站稳（不受伤），再往下挖 6 格：这一段落差的起点是坑底 68，不是出生点的 71。
  for (let y = G; y > G - 3; y--) game.setBlock(0, y, 0, BlockType.Air);
  game.tick(20);
  expect(game.player.onGround).toBe(true);
  // 坑壁那一格换成泥土挖掉（空手挖石头太慢）：下落途中经验球还在往玩家飞。
  game.setBlock(1, G - 2, 0, BlockType.Dirt);
  dig(game, 1, G - 2, 0, { x: 0.1, y: 0.5, z: 0.5 });
  for (let y = G - 3; y > G - 9; y--) game.setBlock(0, y, 0, BlockType.Air);
  game.tick(3);
  return game;
}

// 玩家始终在原点区块里：跨过区块边界之后视距外那一环两边不同，一致只保证到视距以内（ADR-0018 补记）。
describe('快照往返的确定性（ADR-0018）', () => {
  it('半空中取快照、从快照构造另一个核心，两边推进到夜里、做同样的操作，逐 tick 一致', () => {
    const a = worldBeforeSnapshot();
    expect(a.player.onGround).toBe(false);
    expect(a.player.position.y).toBeLessThan(a.player.previousPosition.y);
    expect(a.zombies.count).toBe(0);
    expect(a.drops.count).toBeGreaterThan(0);
    expect(a.xpOrbs.count).toBeGreaterThan(0);
    const healthBefore = a.health.points;

    const b = restored(a, SPAWN_RADIUS);
    a.takeStaleChunks();
    b.takeStaleChunks();
    expectSameBlocks(a, b, a.loadedChunks());
    expect(b.spawnPoint).toEqual(a.spawnPoint);

    // 着地那一 tick 两边都按 6 格的落差扣血。
    for (let i = 0; i < 20; i++) tickBoth(a, b);
    expect(b.player.onGround).toBe(true);
    expect(b.health.points).toBe(healthBefore - 3);

    // 之后的操作：挖坑壁、放一块、在背包界面里挪一格，再推进到僵尸开始生成之后。
    for (let i = 0; i < 2400; i++) {
      if (i === 0) {
        for (const game of [a, b]) {
          aimAt(game, { x: 1.1, y: G - 7.5, z: 0.5 });
          game.setMining(true);
        }
      }
      if (i === 300) for (const game of [a, b]) game.setMining(false);
      if (i === 310) for (const game of [a, b]) game.use();
      if (i === 400) for (const game of [a, b]) game.toggleInventory();
      if (i === 401) for (const game of [a, b]) [0, 9].forEach((slot) => game.clickSlot(slot));
      if (i === 402) for (const game of [a, b]) game.toggleInventory();
      tickBoth(a, b);
    }
    expectSameBlocks(a, b, a.loadedChunks());
    expect(a.isNight).toBe(true);
    expect(Math.max(...b.zombies.all().map((zombie) => zombie.id), 0)).toBeGreaterThan(0);
  });
});

describe('快照往返：被击退与无敌时间', () => {
  /** 一只僵尸贴在玩家西边打了他一下，刚推进完挨打的那一 tick：击退的速度还没走、无敌时间刚开始。 */
  function justHit(): GameCore {
    const game = core();
    game.spawnZombieAt(-0.5, FLAT_STAND_Y, 0.5);
    game.tick();
    expect(game.health.lastHurtTick).toBe(game.tickCount);
    return game;
  }

  // 原核心里那只僵尸还在、读档的那一边没有：两次出手隔 20 tick，下面只比到它能再出手之前。
  it('被击退时取快照：之后几 tick 两边的位置相同', () => {
    const a = justHit();
    const b = restored(a, 1);
    const start = a.player.position;
    for (let i = 0; i < 8; i++) {
      a.tick();
      b.tick();
      expect(b.player.position).toEqual(a.player.position);
    }
    expect(b.player.position.x).toBeGreaterThan(start.x + 0.5);
  });

  it('无敌时间由上次受伤的 tick 重建：取快照后紧接着再挨一下，两边都不掉血', () => {
    const a = justHit();
    const b = restored(a, 1);
    const health = a.health.points;
    for (const game of [a, b]) game.spawnZombieAt(game.player.position.x + 1, FLAT_STAND_Y, 0.5);
    for (let i = 0; i < 5; i++) {
      a.tick();
      b.tick();
      expect(b.health.points).toBe(a.health.points);
    }
    expect(b.health.points).toBe(health);
  });
});

describe('快照不含的东西', () => {
  it('有僵尸时取快照：快照里没有僵尸，恢复后列表为空，之后生成的编号接着原来的', () => {
    const a = core();
    a.spawnZombieAt(10.5, FLAT_STAND_Y, 10.5);
    a.spawnZombieAt(-10.5, FLAT_STAND_Y, 10.5);
    a.tick();
    const snapshot = a.snapshot();
    expect(Object.keys(snapshot)).not.toContain('zombies');
    expect(snapshot.nextZombieId).toBe(3);
    const b = new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain, restore: snapshot });
    expect(b.zombies.count).toBe(0);
    expect(a.zombies.count).toBe(2);
    b.spawnZombieAt(5.5, FLAT_STAND_Y, 5.5);
    expect(b.zombies.all().map((zombie) => zombie.id)).toEqual([3]);
  });

  it('界面、光标物品不进快照：恢复后界面都关着，光标上没有东西', () => {
    const a = core();
    a.giveItem(ItemType.Dirt, 5);
    a.toggleInventory();
    a.tick();
    a.clickSlot(0);
    a.tick();
    const b = restored(a, 1);
    expect(b.uiMode).toBe(false);
    expect(b.inventoryScreen.cursor).toBeUndefined();
    expect(b.inventory.slot(0)).toBeUndefined();
  });
});

describe('快照里的首次出生点', () => {
  it('读档时原点区块没加载，出生点等于快照里的值，不按「未加载即空气」重算', () => {
    const a = core();
    const snapshot = a.snapshot();
    const far = { ...snapshot, player: { ...snapshot.player, position: { x: 500.5, y: FLAT_STAND_Y, z: 0.5 } } };
    const b = new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain, restore: far });
    expect(b.isChunkLoaded(0, 0)).toBe(false);
    expect(b.isChunkLoaded(31, 0)).toBe(true);
    expect(b.player.position).toEqual({ x: 500.5, y: FLAT_STAND_Y, z: 0.5 });
    expect(b.spawnPoint).toEqual({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 });
  });
});

describe('快照往返', () => {
  it('从快照构造之后立即再取快照，除已改区块外与原快照相同；极限已死亡标记照样带过去', () => {
    const snapshot = { ...worldBeforeSnapshot().snapshot(), hardcoreDead: true };
    const b = new GameCore({ viewRadius: SPAWN_RADIUS, chunkSource: () => flatTestTerrain, restore: snapshot });
    const again = b.snapshot();
    expect(again.editedChunks).toEqual([]);
    expect({ ...again, editedChunks: [] }).toEqual({ ...snapshot, editedChunks: [] });
  });
});

describe('难度', () => {
  it('默认普通；构造时给的进快照，读档时取快照里的，不看构造参数', () => {
    expect(core().difficulty).toBe(Difficulty.Normal);
    const a = core({ difficulty: Difficulty.Hard });
    expect(a.difficulty).toBe(Difficulty.Hard);
    const snapshot = a.snapshot();
    expect(snapshot.difficulty).toBe(Difficulty.Hard);
    const b = new GameCore({ difficulty: Difficulty.Peaceful, viewRadius: 1, chunkSource: () => flatTestTerrain, restore: snapshot });
    expect(b.difficulty).toBe(Difficulty.Hard);
  });
});
