import { describe, expect, it } from 'vitest';
import { GameCore } from '../../src/core/game';
import {
  DAY_LENGTH_TICKS,
  NIGHT_END,
  NIGHT_START,
  isNightAt,
  timeOfDayAt,
} from '../../src/core/time-of-day';
import { IDLE_INTENT, MAX_PITCH } from '../../src/core/player';
import { flatTestTerrain } from '../helpers/flat-terrain';

/**
 * 平地上、视距 1 的核心：世界时刻的断言要推进上万 tick，区块少一点跑得快，地形与它无关。
 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain });
}

describe('世界时刻的换算', () => {
  it('一天 24000 tick，夜晚是 13000 到 23000', () => {
    expect(DAY_LENGTH_TICKS).toBe(24000);
    expect(NIGHT_START).toBe(13000);
    expect(NIGHT_END).toBe(23000);
  });

  it('时刻是 tick 计数加偏移，按一天取模，结果落在 [0, 24000)', () => {
    expect(timeOfDayAt(0, 0)).toBe(0);
    expect(timeOfDayAt(23999, 0)).toBe(23999);
    expect(timeOfDayAt(24000, 0)).toBe(0);
    expect(timeOfDayAt(100, 23950)).toBe(50);
    // 偏移可以是负的：把时刻往回拨
    expect(timeOfDayAt(10, -20)).toBe(23990);
  });

  it('夜晚含起点不含终点', () => {
    expect(isNightAt(12999)).toBe(false);
    expect(isNightAt(13000)).toBe(true);
    expect(isNightAt(22999)).toBe(true);
    expect(isNightAt(23000)).toBe(false);
    expect(isNightAt(0)).toBe(false);
  });
});

describe('核心的世界时刻', () => {
  it('进入世界时刻 0，是白天', () => {
    const game = core();
    expect(game.timeOfDay).toBe(0);
    expect(game.isNight).toBe(false);
  });

  it('每 tick 走 1，tick(24000) 后回到 0', () => {
    const game = core();
    game.tick(100);
    expect(game.timeOfDay).toBe(100);
    game.tick(24000 - 100);
    expect(game.timeOfDay).toBe(0);
    expect(game.tickCount).toBe(24000);
  });

  it('setTimeOfDay 把当前时刻设成给定值：13000 是夜晚，12999 与 23000 是白天', () => {
    const game = core();
    game.setTimeOfDay(13000);
    expect(game.timeOfDay).toBe(13000);
    expect(game.isNight).toBe(true);
    game.setTimeOfDay(12999);
    expect(game.timeOfDay).toBe(12999);
    expect(game.isNight).toBe(false);
    game.setTimeOfDay(23000);
    expect(game.timeOfDay).toBe(23000);
    expect(game.isNight).toBe(false);
  });

  it('setTimeOfDay 之后 tick(n) 时刻按 n 递增，过了一天从 0 接着走', () => {
    const game = core();
    game.tick(37);
    game.setTimeOfDay(18000);
    game.tick(250);
    expect(game.timeOfDay).toBe(18250);
    game.tick(6000);
    expect(game.timeOfDay).toBe(250);
  });

  it('超出一天的值与负值按一天折回', () => {
    const game = core();
    game.setTimeOfDay(24000 + 500);
    expect(game.timeOfDay).toBe(500);
    game.setTimeOfDay(-1000);
    expect(game.timeOfDay).toBe(23000);
  });

  it('setTimeOfDay 不改 tick 计数，也不影响其他系统', () => {
    // 两个核心走同一串指令，只有一个拨过时刻：tick 计数、玩家位置、掉落物逐一相同
    const plain = core();
    const shifted = core();
    shifted.setTimeOfDay(18000);
    expect(shifted.tickCount).toBe(0);
    // 低头挖穿脚下的草、掉下去拾起泥土，再往前走一段：挖掘、掉落物、拾取与移动都走一遍
    for (const game of [plain, shifted]) {
      game.turn(0, -MAX_PITCH);
      game.setMining(true);
      game.tick(100);
      game.setMining(false);
      game.setMoveIntent({ ...IDLE_INTENT, forward: true, jump: true });
      game.tick(100);
    }
    const slots = (game: GameCore) =>
      Array.from({ length: game.inventory.size }, (_, i) => game.inventory.slot(i));
    expect(slots(plain).some((stack) => stack !== undefined)).toBe(true);
    expect(shifted.tickCount).toBe(plain.tickCount);
    expect(shifted.player.position).toEqual(plain.player.position);
    expect(shifted.drops.all()).toEqual(plain.drops.all());
    expect(slots(shifted)).toEqual(slots(plain));
  });
});
