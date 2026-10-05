import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import {
  DAY_LENGTH_TICKS,
  NIGHT_END,
  NIGHT_START,
  isNightAt,
  skyDarkeningAt,
  timeOfDayAt,
} from '../../src/core/time-of-day';
import { IDLE_INTENT, MAX_PITCH } from '../../src/core/player';
import { FLAT_GROUND_Y, flatTerrain } from '../helpers/flat-terrain';

/**
 * 平地上、视距 1 的核心：世界时刻的断言要推进上万 tick，区块少一点跑得快，地形与它无关。
 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, terrain: flatTerrain });
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

describe('天光减量与折算天光（见 CONTEXT.md 的「折算天光」）', () => {
  it('减量白天 0、夜晚 11，黄昏与黎明各 1000 tick 线性过渡，不取整', () => {
    expect(skyDarkeningAt(0)).toBe(0);
    expect(skyDarkeningAt(6000)).toBe(0);
    expect(skyDarkeningAt(12000)).toBe(0);
    expect(skyDarkeningAt(12500)).toBeCloseTo(5.5, 10);
    expect(skyDarkeningAt(12750)).toBeCloseTo(8.25, 10);
    expect(skyDarkeningAt(13000)).toBe(11);
    expect(skyDarkeningAt(18000)).toBe(11);
    expect(skyDarkeningAt(22999)).toBe(11);
    expect(skyDarkeningAt(23500)).toBeCloseTo(5.5, 10);
    expect(skyDarkeningAt(23999.5)).toBeCloseTo(0.0055, 10);
  });

  it('核心透出的减量取整到最近的整数', () => {
    const game = core();
    for (const [t, expected] of [[6000, 0], [12000, 0], [12500, 6], [12700, 8], [13000, 11], [18000, 11], [23500, 6], [23960, 0]] as const) {
      game.setTimeOfDay(t);
      expect(game.skyDarkening, `时刻 ${t}`).toBe(expected);
    }
  });

  it('露天格子的折算天光：6000 是 15，18000 是 4，12000 是 15，13000 是 4，12500 与 23500 是取整后的 9', () => {
    const game = core();
    const open = [3, FLAT_GROUND_Y + 1, 4] as const;
    for (const [t, expected] of [[6000, 15], [18000, 4], [12000, 15], [13000, 4], [12500, 9], [23500, 9]] as const) {
      game.setTimeOfDay(t);
      expect(game.effectiveSkyLightAt(...open), `时刻 ${t}`).toBe(expected);
    }
  });

  it('折算天光不低于 0：天光不超过 11 的格子夜里是 0，地下的格子什么时候都是 0', () => {
    const game = core();
    // 头顶隔一格盖住：那格天光 14（旁边露天横着传进来），夜里 14 − 11 = 3
    game.setBlock(3, FLAT_GROUND_Y + 3, 4, BlockType.Stone);
    expect(game.skyLightAt(3, FLAT_GROUND_Y + 1, 4)).toBe(14);
    game.setTimeOfDay(18000);
    expect(game.effectiveSkyLightAt(3, FLAT_GROUND_Y + 1, 4)).toBe(3);
    // 地面挖一个三格深的竖井，井口上方隔一格盖住：光从旁边绕进井口那格是 14，往下每格减 1，
    // 井底 11，夜里折算天光正好是 0
    game.setBlock(8, FLAT_GROUND_Y, 8, BlockType.Air);
    game.setBlock(8, FLAT_GROUND_Y - 1, 8, BlockType.Air);
    game.setBlock(8, FLAT_GROUND_Y - 2, 8, BlockType.Air);
    game.setBlock(8, FLAT_GROUND_Y + 2, 8, BlockType.Stone);
    expect(game.skyLightAt(8, FLAT_GROUND_Y - 2, 8)).toBe(11);
    expect(game.effectiveSkyLightAt(8, FLAT_GROUND_Y - 1, 8)).toBe(1);
    expect(game.effectiveSkyLightAt(8, FLAT_GROUND_Y - 2, 8)).toBe(0);
    expect(game.effectiveSkyLightAt(3, FLAT_GROUND_Y - 1, 4)).toBe(0);
    game.setTimeOfDay(6000);
    expect(game.effectiveSkyLightAt(8, FLAT_GROUND_Y - 2, 8)).toBe(11);
    expect(game.effectiveSkyLightAt(3, FLAT_GROUND_Y - 1, 4)).toBe(0);
  });
});
