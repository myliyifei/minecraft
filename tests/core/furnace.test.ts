import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { newFurnaceState, type FurnaceState } from '../../src/core/block-state';
import { isBurning, stepFurnace, stepFurnaces, takeExperience } from '../../src/core/furnace';
import { ItemType, type ItemStack } from '../../src/core/item';
import { World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

function stack(item: ItemType, count: number): ItemStack {
  return { item, count };
}

const rawIron = (count: number): ItemStack => stack(ItemType.RawIron, count);
const ingots = (count: number): ItemStack => stack(ItemType.IronIngot, count);
const coal = (count: number): ItemStack => stack(ItemType.Coal, count);
const planks = (count: number): ItemStack => stack(ItemType.OakPlanks, count);
const logs = (count: number): ItemStack => stack(ItemType.OakLog, count);
const charcoal = (count: number): ItemStack => stack(ItemType.Charcoal, count);
const sticks = (count: number): ItemStack => stack(ItemType.Stick, count);

/**
 * 数值写死字面值，不从燃料表与配方表反读：这里断言的是「第几 tick 发生什么」，表里的数是输入的一部分。
 * 煤炭 1600、木板与原木 300、木棍 100；每件 200 tick；粗铁每件 7 点经验、原木每件 2 点。
 */
const COAL_TICKS = 1600;
const PLANK_TICKS = 300;
const STICK_TICKS = 100;
const SMELT = 200;

/** 一份熔炉状态，三格按参数摆好。 */
function furnace(input?: ItemStack, fuel?: ItemStack, output?: ItemStack): FurnaceState {
  const state = newFurnaceState();
  state.input = input;
  state.fuel = fuel;
  state.output = output;
  return state;
}

/** 推进 n 个 tick。 */
function run(state: FurnaceState, n: number): void {
  for (let i = 0; i < n; i++) stepFurnace(state);
}

describe('熔炼状态机：点火与出成品（issue #34）', () => {
  it('原料 1 个粗铁、燃料 1 个煤炭：第 1 tick 点火、燃料格空；第 200 tick 出 1 个铁锭、原料空；第 1600 tick 熄火', () => {
    const state = furnace(rawIron(1), coal(1));
    expect(isBurning(state)).toBe(false);

    run(state, 1);
    expect(state.fuel).toBeUndefined();
    expect(isBurning(state)).toBe(true);
    expect(state.burnTicksTotal).toBe(COAL_TICKS);
    expect(state.smeltProgress).toBe(1);

    run(state, SMELT - 2);
    expect(state.output).toBeUndefined();
    expect(state.smeltProgress).toBe(SMELT - 1);
    run(state, 1);
    expect(state.output).toEqual(ingots(1));
    expect(state.input).toBeUndefined();
    expect(state.smeltProgress).toBe(0);
    expect(state.pendingExperience).toBe(7);

    // 原料没了，正在烧的这件烧完为止
    run(state, COAL_TICKS - SMELT - 1);
    expect(isBurning(state)).toBe(true);
    run(state, 1);
    expect(isBurning(state)).toBe(false);
    expect(state.burnTicksLeft).toBe(0);
  });

  it('原料 8 个粗铁、1 个煤炭：1600 tick 后成品 8、原料空、熄火，一件煤正好 8 件', () => {
    const state = furnace(rawIron(8), coal(1));
    run(state, COAL_TICKS - 1);
    expect(state.output).toEqual(ingots(7));
    expect(isBurning(state)).toBe(true);
    run(state, 1);
    expect(state.output).toEqual(ingots(8));
    expect(state.input).toBeUndefined();
    expect(isBurning(state)).toBe(false);
    expect(state.pendingExperience).toBe(56);
  });

  it('原料 9 个粗铁、1 个煤炭：第 9 件不炼，熄火之后进度停在 0', () => {
    const state = furnace(rawIron(9), coal(1));
    run(state, COAL_TICKS);
    expect(state.output).toEqual(ingots(8));
    expect(state.input).toEqual(rawIron(1));
    expect(isBurning(state)).toBe(false);
    expect(state.smeltProgress).toBe(0);

    run(state, SMELT);
    expect(state.output).toEqual(ingots(8));
    expect(state.input).toEqual(rawIron(1));
    expect(state.smeltProgress).toBe(0);
  });

  it('断火时进度每 tick 倒退 2 到 0：1 根木棍烧 100 tick 炼到一半，熄火后 50 tick 退回 0', () => {
    const state = furnace(rawIron(1), sticks(1));
    run(state, STICK_TICKS);
    expect(isBurning(state)).toBe(false);
    expect(state.smeltProgress).toBe(STICK_TICKS);

    run(state, 1);
    expect(state.smeltProgress).toBe(STICK_TICKS - 2);
    run(state, STICK_TICKS / 2 - 1);
    expect(state.smeltProgress).toBe(0);
    run(state, 1);
    expect(state.smeltProgress).toBe(0);
    expect(state.input).toEqual(rawIron(1));
  });

  it('燃料 2 块木板炼 2 个粗铁：第 200 tick 出第 1 件，第 300 tick 自动点第二块，第 400 tick 出第 2 件，第 600 tick 熄火', () => {
    const state = furnace(rawIron(2), planks(2));
    run(state, 1);
    expect(state.fuel).toEqual(planks(1));

    run(state, SMELT - 1);
    expect(state.output).toEqual(ingots(1));

    run(state, PLANK_TICKS - SMELT - 1);
    expect(state.fuel).toEqual(planks(1));
    // 第一块在这一 tick 烧完，同一 tick 接着点第二块：一直在烧，中间不熄火
    run(state, 1);
    expect(state.fuel).toBeUndefined();
    expect(isBurning(state)).toBe(true);
    expect(state.burnTicksLeft).toBe(PLANK_TICKS);
    expect(state.burnTicksTotal).toBe(PLANK_TICKS);

    run(state, 2 * SMELT - PLANK_TICKS);
    expect(state.output).toEqual(ingots(2));
    expect(state.input).toBeUndefined();

    run(state, 2 * PLANK_TICKS - 2 * SMELT - 1);
    expect(isBurning(state)).toBe(true);
    run(state, 1);
    expect(isBurning(state)).toBe(false);
  });

  it('燃料 2 块木板炼 1 个粗铁：第一块烧完时原料已经空了，不点第二块', () => {
    const state = furnace(rawIron(1), planks(2));
    run(state, PLANK_TICKS);
    expect(state.output).toEqual(ingots(1));
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(planks(1));
  });

  it('原木放原料格出木炭、每件 2 点经验；放燃料格当 300 tick 燃料', () => {
    const state = furnace(logs(1), logs(1));
    run(state, 1);
    expect(state.fuel).toBeUndefined();
    expect(state.burnTicksTotal).toBe(PLANK_TICKS);
    run(state, SMELT - 1);
    expect(state.output).toEqual(charcoal(1));
    expect(state.input).toBeUndefined();
    expect(state.pendingExperience).toBe(2);
  });

  it('木炭是 1600 tick 的燃料', () => {
    const state = furnace(rawIron(1), charcoal(1));
    run(state, 1);
    expect(state.burnTicksTotal).toBe(COAL_TICKS);
  });
});

describe('熔炼状态机：不点火的情形（issue #34）', () => {
  it('原料格空、燃料格有煤：不点火，煤炭一个都不少', () => {
    const state = furnace(undefined, coal(1));
    run(state, SMELT);
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(coal(1));
  });

  it('原料不能熔炼（圆石）：不点火', () => {
    const state = furnace(stack(ItemType.Cobblestone, 3), coal(1));
    run(state, SMELT);
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(coal(1));
  });

  it('成品格 64 个铁锭：不点火、不炼', () => {
    const state = furnace(rawIron(1), coal(1), ingots(64));
    run(state, SMELT);
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(coal(1));
    expect(state.input).toEqual(rawIron(1));
    expect(state.output).toEqual(ingots(64));
    expect(state.smeltProgress).toBe(0);
  });

  it('成品格 63 个铁锭：炼 1 件满到 64 就停，这件煤烧完为止，不点下一件', () => {
    const state = furnace(rawIron(3), coal(2), ingots(63));
    run(state, SMELT);
    expect(state.output).toEqual(ingots(64));
    expect(state.input).toEqual(rawIron(2));
    run(state, COAL_TICKS - SMELT);
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(coal(1));
    expect(state.smeltProgress).toBe(0);
  });

  it('成品格是木炭时炼粗铁不点火', () => {
    const state = furnace(rawIron(1), coal(1), charcoal(1));
    run(state, SMELT);
    expect(isBurning(state)).toBe(false);
    expect(state.fuel).toEqual(coal(1));
    expect(state.output).toEqual(charcoal(1));
  });

  it('燃料格不是燃料（调试路径放进去的圆石）：不点火', () => {
    const state = furnace(rawIron(1), stack(ItemType.Cobblestone, 1));
    run(state, SMELT);
    expect(isBurning(state)).toBe(false);
  });

  it('炼到 199 tick 时把粗铁换成原木：进度从 0 算起，200 tick 后才出木炭', () => {
    const state = furnace(rawIron(1), coal(1));
    run(state, SMELT - 1);
    expect(state.smeltProgress).toBe(SMELT - 1);
    state.input = logs(1);
    run(state, 1);
    expect(state.smeltProgress).toBe(1);
    expect(state.output).toBeUndefined();
    run(state, SMELT - 1);
    expect(state.output).toEqual(charcoal(1));
    expect(state.pendingExperience).toBe(2);
  });

  it('拿走原料再放回同一种：进度从倒退剩下的地方接着往上加', () => {
    const state = furnace(rawIron(1), coal(1));
    run(state, 100);
    state.input = undefined;
    run(state, 10);
    expect(state.smeltProgress).toBe(80);
    state.input = rawIron(1);
    run(state, 1);
    expect(state.smeltProgress).toBe(81);
  });

  it('烧到一半拿走原料：燃料接着烧到 0，进度每 tick 倒退 2', () => {
    const state = furnace(rawIron(1), coal(2));
    run(state, 100);
    expect(state.smeltProgress).toBe(100);
    state.input = undefined;
    run(state, 1);
    expect(state.smeltProgress).toBe(98);
    expect(isBurning(state)).toBe(true);
    run(state, COAL_TICKS - 101);
    expect(isBurning(state)).toBe(false);
    expect(state.smeltProgress).toBe(0);
    // 原料空着，下一件煤不点
    expect(state.fuel).toEqual(coal(1));
  });
});

describe('取走成品时结算待结算经验（issue #34）', () => {
  it('3 个铁锭一次取走：21 点，待结算经验清零', () => {
    const state = furnace(rawIron(3), coal(1));
    run(state, 3 * SMELT);
    expect(state.output).toEqual(ingots(3));
    state.output = undefined;
    expect(takeExperience(state, 3)).toBe(21);
    expect(state.pendingExperience).toBe(0);
  });

  it('先取 1 再取 2：7 点加 14 点，合计 21', () => {
    const state = furnace(rawIron(3), coal(1));
    run(state, 3 * SMELT);
    state.output = ingots(2);
    expect(takeExperience(state, 1)).toBe(7);
    state.output = undefined;
    expect(takeExperience(state, 2)).toBe(14);
    expect(state.pendingExperience).toBe(0);
  });

  it('调试路径放进成品格、没有待结算经验的成品：取走不给经验', () => {
    const state = furnace(undefined, undefined, ingots(10));
    state.output = undefined;
    expect(takeExperience(state, 10)).toBe(0);
  });

  it('按取走的比例结算、向下取整，最后一次取光时把余下的全给：总量等于待结算经验', () => {
    const state = furnace();
    // 与每件经验对不上的一份（外部写入）：3 件 10 点，逐件取走给 3、3、4
    state.pendingExperience = 10;
    state.output = ingots(2);
    expect(takeExperience(state, 1)).toBe(3);
    state.output = ingots(1);
    expect(takeExperience(state, 1)).toBe(3);
    state.output = undefined;
    expect(takeExperience(state, 1)).toBe(4);
    expect(state.pendingExperience).toBe(0);
  });
});

describe('世界里的熔炉每 tick 推进，只推进已加载区块里的（issue #34）', () => {
  /** 原点区块里地表之上的一格。 */
  const SPOT: [number, number, number] = [3, FLAT_GROUND_Y + 1, 5];

  /** 原点区块已加载的平地世界，SPOT 那一格摆着熔炉，原料 1 个粗铁、燃料 1 个煤炭。 */
  function worldWithFurnace(): { world: World; state: FurnaceState } {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(...SPOT, BlockType.Furnace);
    const state = world.blockStateAt(...SPOT) as FurnaceState;
    state.input = rawIron(1);
    state.fuel = coal(1);
    return { world, state };
  }

  function runWorld(world: World, n: number): void {
    for (let i = 0; i < n; i++) stepFurnaces(world);
  }

  it('点火时方块换成燃烧中的编号，熄火时换回熔炉；状态还是那一条', () => {
    const { world, state } = worldWithFurnace();
    world.takeChangedBlocks();
    runWorld(world, 1);
    expect(world.getBlock(...SPOT)).toBe(BlockType.LitFurnace);
    expect(world.blockStateAt(...SPOT)).toBe(state);
    // 走正常的写方块路径：网格重建靠「哪些方块变过」这份记录
    expect(world.takeChangedBlocks()).toEqual([{ x: SPOT[0], y: SPOT[1], z: SPOT[2] }]);

    runWorld(world, COAL_TICKS - 2);
    expect(world.getBlock(...SPOT)).toBe(BlockType.LitFurnace);
    // 一直在烧，中间没有换过编号
    expect(world.takeChangedBlocks()).toEqual([]);
    runWorld(world, 1);
    expect(world.getBlock(...SPOT)).toBe(BlockType.Furnace);
    expect(world.blockStateAt(...SPOT)).toBe(state);
    expect(state.output).toEqual(ingots(1));
  });

  it('原料格空、燃料格有煤：方块一直是熔炉，中间没有换过编号', () => {
    const { world, state } = worldWithFurnace();
    state.input = undefined;
    world.takeChangedBlocks();
    runWorld(world, SMELT);
    expect(world.getBlock(...SPOT)).toBe(BlockType.Furnace);
    // 点火又熄火会留下变过的记录，只看最后的编号查不出来
    expect(world.takeChangedBlocks()).toEqual([]);
  });

  it('所在区块卸载 500 tick，进度与燃料不变；重新加载后接着推进', () => {
    const { world, state } = worldWithFurnace();
    runWorld(world, 50);
    const before = { ...state };

    world.unloadChunk(0, 0);
    runWorld(world, 500);
    expect(state).toEqual(before);

    world.loadChunk(0, 0);
    runWorld(world, 1);
    expect(state.smeltProgress).toBe(before.smeltProgress + 1);
    expect(state.burnTicksLeft).toBe(before.burnTicksLeft - 1);
    expect(world.getBlock(...SPOT)).toBe(BlockType.LitFurnace);
  });

  it('只在燃烧状态变化时换编号：直接写成燃烧中编号的空熔炉不会被改回去', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(...SPOT, BlockType.LitFurnace);
    runWorld(world, 10);
    expect(world.getBlock(...SPOT)).toBe(BlockType.LitFurnace);
  });
});
