import { describe, expect, it } from 'vitest';
import { newFurnaceState, type FurnaceState } from '../../src/core/block-state';
import { isBurning, stepFurnace } from '../../src/core/furnace';
import {
  FURNACE_FUEL_SLOT,
  FURNACE_INPUT_SLOT,
  FurnaceSlots,
} from '../../src/core/furnace-slots';
import { INVENTORY_SIZE, Inventory } from '../../src/core/inventory';
import { InventoryScreen } from '../../src/core/inventory-screen';
import { ItemType, type ItemStack } from '../../src/core/item';
import { burnTicksOf, isFuel, isSmeltable, smeltingRecipe } from '../../src/core/smelting';
import { XpOrbs } from '../../src/core/xp-orb';
import { ALL_SPECIES, NEW_SPECIES, expectDefined, named } from '../helpers/wood-species';

/**
 * 白桦与云杉的燃料与熔炼（#85）：燃烧时长与熔炼经验与橡木相同。
 *
 * 数值按字面值写，不从燃料表反读：原木与木板各 300 tick，原木炼出木炭、每件 2 点经验，每件 200 tick。
 */
const WOOD_BURN_TICKS = 300;
const CHARCOAL_EXPERIENCE = 2;
const SMELT = 200;

function stack(item: ItemType, count: number): ItemStack {
  return { item, count };
}

describe.each(named(ALL_SPECIES))('%s的燃料与熔炼表', (_name, species) => {
  it('原木与木板都是燃料，各烧 300 tick', () => {
    expectDefined(species);
    expect(isFuel(species.logItem)).toBe(true);
    expect(isFuel(species.planksItem)).toBe(true);
    expect(burnTicksOf(species.logItem)).toBe(WOOD_BURN_TICKS);
    expect(burnTicksOf(species.planksItem)).toBe(WOOD_BURN_TICKS);
  });

  it('原木炼出木炭、每件 2 点经验；木板不能熔炼', () => {
    expectDefined(species);
    expect(isSmeltable(species.logItem)).toBe(true);
    expect(smeltingRecipe(species.logItem)).toEqual({ result: ItemType.Charcoal, experience: CHARCOAL_EXPERIENCE });
    expect(isSmeltable(species.planksItem)).toBe(false);
  });
});

describe.each(named(NEW_SPECIES))('%s原木在熔炉里', (_name, species) => {
  function furnace(input?: ItemStack, fuel?: ItemStack): FurnaceState {
    const state = newFurnaceState();
    state.input = input;
    state.fuel = fuel;
    return state;
  }

  function run(state: FurnaceState, n: number): void {
    for (let i = 0; i < n; i++) stepFurnace(state);
  }

  it('原料与燃料各 1 个这种原木：第 1 tick 点火、按 300 tick 计时；第 200 tick 出 1 个木炭，待结算 2 点经验', () => {
    expectDefined(species);
    const state = furnace(stack(species.logItem, 1), stack(species.logItem, 1));
    run(state, 1);
    expect(isBurning(state)).toBe(true);
    expect(state.fuel).toBeUndefined();
    expect(state.burnTicksTotal).toBe(WOOD_BURN_TICKS);

    run(state, SMELT - 2);
    expect(state.output).toBeUndefined();
    run(state, 1);
    expect(state.output).toEqual(stack(ItemType.Charcoal, 1));
    expect(state.input).toBeUndefined();
    expect(state.pendingExperience).toBe(CHARCOAL_EXPERIENCE);
  });

  it('这种木板当燃料：一块烧 300 tick，炼得出 1 个木炭', () => {
    expectDefined(species);
    const state = furnace(stack(species.logItem, 2), stack(species.planksItem, 1));
    run(state, 1);
    expect(state.burnTicksTotal).toBe(WOOD_BURN_TICKS);
    run(state, SMELT - 1);
    expect(state.output).toEqual(stack(ItemType.Charcoal, 1));
    run(state, WOOD_BURN_TICKS - SMELT);
    // 300 tick 烧完、燃料格空了：熄火，第二个原木炼到一半
    expect(isBurning(state)).toBe(false);
    expect(state.input).toEqual(stack(species.logItem, 1));
    expect(state.output).toEqual(stack(ItemType.Charcoal, 1));
  });
});

describe.each(named(NEW_SPECIES))('熔炉界面收不收%s的原木与木板', (_name, species) => {
  const INPUT = INVENTORY_SIZE + FURNACE_INPUT_SLOT;
  const FUEL = INVENTORY_SIZE + FURNACE_FUEL_SLOT;

  function opened(item: ItemType): { state: FurnaceState; screen: InventoryScreen } {
    const state = newFurnaceState();
    const slots = new FurnaceSlots(new XpOrbs());
    slots.bind(state, { x: 0, y: 70, z: 0 });
    const inventory = new Inventory();
    inventory.setSlot(0, stack(item, 3));
    const screen = new InventoryScreen(inventory, slots);
    screen.toggle();
    return { state, screen };
  }

  it('原木放得进燃料格', () => {
    expectDefined(species);
    const { state, screen } = opened(species.logItem);
    screen.clickSlot(0);
    screen.clickSlot(FUEL);
    expect(state.fuel).toEqual(stack(species.logItem, 3));
    expect(screen.cursor).toBeUndefined();
  });

  it('原木放得进原料格', () => {
    expectDefined(species);
    const { state, screen } = opened(species.logItem);
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(stack(species.logItem, 3));
  });

  it('木板放得进燃料格，放不进原料格：留在光标上', () => {
    expectDefined(species);
    const { state, screen } = opened(species.planksItem);
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toBeUndefined();
    expect(screen.cursor).toEqual(stack(species.planksItem, 3));
    screen.clickSlot(FUEL);
    expect(state.fuel).toEqual(stack(species.planksItem, 3));
  });
});
