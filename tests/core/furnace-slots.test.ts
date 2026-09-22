import { describe, expect, it } from 'vitest';
import { newFurnaceState, type FurnaceState } from '../../src/core/block-state';
import {
  FURNACE_FUEL_SLOT,
  FURNACE_INPUT_SLOT,
  FURNACE_RESULT_SLOT,
  FurnaceSlots,
} from '../../src/core/furnace-slots';
import { CRAFTING_TABLE_GRID, CraftingGrid } from '../../src/core/crafting-grid';
import { INVENTORY_SIZE, Inventory } from '../../src/core/inventory';
import { InventoryScreen } from '../../src/core/inventory-screen';
import { ItemType, type ItemStack } from '../../src/core/item';
import { SMELT_TICKS } from '../../src/core/smelting';

function stack(item: ItemType, count: number): ItemStack {
  return { item, count };
}

const rawIron = (count: number): ItemStack => stack(ItemType.RawIron, count);
const ingots = (count: number): ItemStack => stack(ItemType.IronIngot, count);
const coal = (count: number): ItemStack => stack(ItemType.Coal, count);
const logs = (count: number): ItemStack => stack(ItemType.OakLog, count);
const dirt = (count: number): ItemStack => stack(ItemType.Dirt, count);

/** 三格在界面里的格号：接在背包 36 格之后。 */
const INPUT = INVENTORY_SIZE + FURNACE_INPUT_SLOT;
const FUEL = INVENTORY_SIZE + FURNACE_FUEL_SLOT;
const RESULT = INVENTORY_SIZE + FURNACE_RESULT_SLOT;

/**
 * 一条熔炉状态、一个背包、一个开着的熔炉界面。背包里的东西由 `fill` 摆，熔炉三格由 `furnace` 摆。
 */
function opened(
  fill: (inventory: Inventory) => void = () => {},
  furnace: (state: FurnaceState) => void = () => {},
): { state: FurnaceState; inventory: Inventory; screen: InventoryScreen } {
  const state = newFurnaceState();
  furnace(state);
  const slots = new FurnaceSlots();
  slots.bind(state);
  const inventory = new Inventory();
  fill(inventory);
  const screen = new InventoryScreen(inventory, slots);
  screen.toggle();
  return { state, inventory, screen };
}

describe('熔炉三格是状态表里那条状态的三个格子', () => {
  it('读的是状态里的原料、燃料、成品', () => {
    const state = newFurnaceState();
    state.input = rawIron(3);
    state.fuel = coal(2);
    state.output = ingots(4);
    const slots = new FurnaceSlots();
    slots.bind(state);
    expect(slots.size).toBe(3);
    expect(slots.slot(FURNACE_INPUT_SLOT)).toEqual(rawIron(3));
    expect(slots.slot(FURNACE_FUEL_SLOT)).toEqual(coal(2));
    expect(slots.slot(FURNACE_RESULT_SLOT)).toEqual(ingots(4));
  });

  it('写一格就是写状态里那一格', () => {
    const state = newFurnaceState();
    const slots = new FurnaceSlots();
    slots.bind(state);
    slots.setSlot(FURNACE_INPUT_SLOT, rawIron(1));
    slots.setSlot(FURNACE_FUEL_SLOT, coal(1));
    slots.setSlot(FURNACE_RESULT_SLOT, ingots(1));
    expect(state.input).toEqual(rawIron(1));
    expect(state.fuel).toEqual(coal(1));
    expect(state.output).toEqual(ingots(1));
    slots.setSlot(FURNACE_INPUT_SLOT, undefined);
    expect(state.input).toBeUndefined();
  });

  it('指不到格子的下标什么都不写、读出来是 undefined', () => {
    const state = newFurnaceState();
    const slots = new FurnaceSlots();
    slots.bind(state);
    slots.setSlot(3, rawIron(1));
    slots.setSlot(-1, rawIron(1));
    slots.setSlot(0.5, rawIron(1));
    expect(state).toEqual(newFurnaceState());
    expect(slots.slot(3)).toBeUndefined();
  });

  it('重绑到另一条状态后读写的是那一条，原来那条不再变', () => {
    const a = newFurnaceState();
    a.input = rawIron(3);
    const b = newFurnaceState();
    b.fuel = coal(5);
    const slots = new FurnaceSlots();
    slots.bind(a);
    slots.bind(b);
    expect(slots.slot(FURNACE_INPUT_SLOT)).toBeUndefined();
    expect(slots.slot(FURNACE_FUEL_SLOT)).toEqual(coal(5));
    slots.setSlot(FURNACE_INPUT_SLOT, logs(1));
    expect(b.input).toEqual(logs(1));
    expect(a.input).toEqual(rawIron(3));
  });

  it('还没绑到任何熔炉时三格都是空的，写了也不留下', () => {
    const slots = new FurnaceSlots();
    slots.setSlot(FURNACE_INPUT_SLOT, rawIron(1));
    expect(slots.slot(FURNACE_INPUT_SLOT)).toBeUndefined();
    expect(slots.smelting.fuelRatio).toBe(0);
    expect(slots.smelting.progressRatio).toBe(0);
  });

  it('关闭界面时留在原处，没有合成能力', () => {
    const slots = new FurnaceSlots();
    expect(slots.returnsOnClose).toBe(false);
    expect(slots.crafting).toBeUndefined();
  });
});

describe('原料格只收熔炼配方表里的原料', () => {
  it('往原料格放泥土什么都不改变：泥土还在光标上', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, dirt(5)));
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(screen.cursor).toEqual(dirt(5));
    expect(state.input).toBeUndefined();
    screen.splitSlot(INPUT);
    expect(screen.cursor).toEqual(dirt(5));
    expect(state.input).toBeUndefined();
  });

  it('放粗铁成功', () => {
    const { state, inventory, screen } = opened((inv) => inv.setSlot(0, rawIron(5)));
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(rawIron(5));
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('放橡木原木成功', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, logs(2)));
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(logs(2));
  });

  it('原料格里有粗铁时拿着泥土点它不交换', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, dirt(5)),
      (s) => (s.input = rawIron(3)),
    );
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(screen.cursor).toEqual(dirt(5));
    expect(state.input).toEqual(rawIron(3));
  });
});

describe('燃料格只收燃料表里的物品', () => {
  it('往燃料格放圆石什么都不改变', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, stack(ItemType.Cobblestone, 8)));
    screen.clickSlot(0);
    screen.clickSlot(FUEL);
    expect(screen.cursor).toEqual(stack(ItemType.Cobblestone, 8));
    expect(state.fuel).toBeUndefined();
  });

  it('放原木成功', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, logs(3)));
    screen.clickSlot(0);
    screen.clickSlot(FUEL);
    expect(state.fuel).toEqual(logs(3));
    expect(screen.cursor).toBeUndefined();
  });

  it('煤炭、木板、木棍都放得进去；粗铁放不进去', () => {
    for (const item of [ItemType.Coal, ItemType.OakPlanks, ItemType.Stick]) {
      const { state, screen } = opened((inv) => inv.setSlot(0, stack(item, 2)));
      screen.clickSlot(0);
      screen.clickSlot(FUEL);
      expect(state.fuel, `物品 ${item}`).toEqual(stack(item, 2));
    }
    const { state, screen } = opened((inv) => inv.setSlot(0, rawIron(2)));
    screen.clickSlot(0);
    screen.clickSlot(FUEL);
    expect(state.fuel).toBeUndefined();
    expect(screen.cursor).toEqual(rawIron(2));
  });

  it('工作台与木镐放不进去', () => {
    for (const item of [ItemType.CraftingTable, ItemType.WoodenPickaxe]) {
      const { state, screen } = opened((inv) => inv.setSlot(0, stack(item, 1)));
      screen.clickSlot(0);
      screen.clickSlot(FUEL);
      expect(state.fuel, `物品 ${item}`).toBeUndefined();
    }
  });
});

describe('成品格是只取格', () => {
  it('对成品格放东西什么都不改变：空着的成品格放不进铁锭', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, ingots(5)));
    screen.clickSlot(0);
    screen.clickSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(5));
    expect(state.output).toBeUndefined();
    screen.splitSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(5));
    expect(state.output).toBeUndefined();
  });

  it('成品格里有 10 个铁锭时光标空点它全拿走', () => {
    const { state, screen } = opened(undefined, (s) => (s.output = ingots(10)));
    screen.clickSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(10));
    expect(state.output).toBeUndefined();
  });

  it('光标 60 个铁锭点它：光标 64、格里剩 6', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, ingots(60)),
      (s) => (s.output = ingots(10)),
    );
    screen.clickSlot(0);
    screen.clickSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(64));
    expect(state.output).toEqual(ingots(6));
  });

  it('光标是煤炭点它什么都不改变：不交换', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, coal(3)),
      (s) => (s.output = ingots(10)),
    );
    screen.clickSlot(0);
    screen.clickSlot(RESULT);
    expect(screen.cursor).toEqual(coal(3));
    expect(state.output).toEqual(ingots(10));
  });

  it('拆堆与点击相同：光标空时整堆拿走而不是一半', () => {
    const { state, screen } = opened(undefined, (s) => (s.output = ingots(10)));
    screen.splitSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(10));
    expect(state.output).toBeUndefined();
  });

  it('拆堆与点击相同：光标 60 个铁锭时并到 64，不是只并 1 个', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, ingots(60)),
      (s) => (s.output = ingots(10)),
    );
    screen.clickSlot(0);
    screen.splitSlot(RESULT);
    expect(screen.cursor).toEqual(ingots(64));
    expect(state.output).toEqual(ingots(6));
  });
});

describe('原料格与燃料格支持拿起、放下、合并、交换、拆堆', () => {
  it('拿起：光标空点原料格，整堆到光标上', () => {
    const { state, screen } = opened(undefined, (s) => (s.input = rawIron(7)));
    screen.clickSlot(INPUT);
    expect(screen.cursor).toEqual(rawIron(7));
    expect(state.input).toBeUndefined();
  });

  it('放下：拿起的粗铁放回空的原料格', () => {
    const { state, screen } = opened(undefined, (s) => (s.input = rawIron(7)));
    screen.clickSlot(INPUT);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(rawIron(7));
    expect(screen.cursor).toBeUndefined();
  });

  it('合并：光标 60 个粗铁点 10 个粗铁的原料格，格里 64、光标剩 6', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, rawIron(60)),
      (s) => (s.input = rawIron(10)),
    );
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(rawIron(64));
    expect(screen.cursor).toEqual(rawIron(6));
  });

  it('交换：光标原木点粗铁的原料格，两边互换', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, logs(3)),
      (s) => (s.input = rawIron(2)),
    );
    screen.clickSlot(0);
    screen.clickSlot(INPUT);
    expect(state.input).toEqual(logs(3));
    expect(screen.cursor).toEqual(rawIron(2));
  });

  it('交换：光标木板点煤炭的燃料格，两边互换', () => {
    const { state, screen } = opened(
      (inv) => inv.setSlot(0, stack(ItemType.OakPlanks, 4)),
      (s) => (s.fuel = coal(2)),
    );
    screen.clickSlot(0);
    screen.clickSlot(FUEL);
    expect(state.fuel).toEqual(stack(ItemType.OakPlanks, 4));
    expect(screen.cursor).toEqual(coal(2));
  });

  it('拆堆：光标空对 5 个煤炭的燃料格按拆堆键，拿起 3 个，格里剩 2 个', () => {
    const { state, screen } = opened(undefined, (s) => (s.fuel = coal(5)));
    screen.splitSlot(FUEL);
    expect(screen.cursor).toEqual(coal(3));
    expect(state.fuel).toEqual(coal(2));
  });

  it('拆堆：光标 4 个粗铁对空的原料格按拆堆键，放下 1 个', () => {
    const { state, screen } = opened((inv) => inv.setSlot(0, rawIron(4)));
    screen.clickSlot(0);
    screen.splitSlot(INPUT);
    expect(state.input).toEqual(rawIron(1));
    expect(screen.cursor).toEqual(rawIron(3));
    screen.splitSlot(INPUT);
    expect(state.input).toEqual(rawIron(2));
    expect(screen.cursor).toEqual(rawIron(2));
  });
});

describe('关闭熔炉界面', () => {
  it('三格内容不变，背包不多东西，没有要掉出去的', () => {
    const { state, inventory, screen } = opened(undefined, (s) => {
      s.input = rawIron(3);
      s.fuel = coal(2);
      s.output = ingots(4);
    });
    expect(screen.toggle()).toEqual([]);
    expect(state.input).toEqual(rawIron(3));
    expect(state.fuel).toEqual(coal(2));
    expect(state.output).toEqual(ingots(4));
    for (let i = 0; i < INVENTORY_SIZE; i++) expect(inventory.slot(i)).toBeUndefined();
  });

  it('从原料格拿起的光标物品退回原料格', () => {
    const { state, screen } = opened(undefined, (s) => (s.input = rawIron(3)));
    screen.clickSlot(INPUT);
    expect(screen.toggle()).toEqual([]);
    expect(screen.cursor).toBeUndefined();
    expect(state.input).toEqual(rawIron(3));
  });

  it('从背包第 20 格拿起的光标物品退回第 20 格', () => {
    const { state, inventory, screen } = opened((inv) => inv.setSlot(20, coal(9)));
    screen.clickSlot(20);
    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(20)).toEqual(coal(9));
    expect(state.fuel).toBeUndefined();
  });

  it('从成品格拿起的光标物品按入包规则进背包', () => {
    const { state, inventory, screen } = opened(undefined, (s) => (s.output = ingots(10)));
    screen.clickSlot(RESULT);
    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(0)).toEqual(ingots(10));
    expect(state.output).toBeUndefined();
  });

  it('背包全满时从成品格拿起的光标物品交出去，由调用方掉在玩家脚下', () => {
    const { inventory, screen } = opened(
      (inv) => {
        for (let i = 0; i < INVENTORY_SIZE; i++) inv.setSlot(i, dirt(64));
      },
      (s) => (s.output = ingots(10)),
    );
    screen.clickSlot(RESULT);
    expect(screen.toggle()).toEqual([ingots(10)]);
    expect(inventory.slot(0)).toEqual(dirt(64));
  });
});

describe('两条进度条的比例', () => {
  it('没点火、没在炼时两条都是 0', () => {
    const { screen } = opened();
    expect(screen.smelting!.fuelRatio).toBe(0);
    expect(screen.smelting!.progressRatio).toBe(0);
  });

  it('燃料比例是剩余 tick 除以这件燃料的总 tick', () => {
    const { screen } = opened(undefined, (s) => {
      s.burnTicksLeft = 400;
      s.burnTicksTotal = 1600;
    });
    expect(screen.smelting!.fuelRatio).toBe(0.25);
  });

  it('进度比例是已熔炼 tick 除以每件的熔炼 tick', () => {
    const { screen } = opened(undefined, (s) => (s.smeltProgress = SMELT_TICKS / 2));
    expect(screen.smelting!.progressRatio).toBe(0.5);
  });

  it('比例每次读都当场算：状态变了，视图跟着变', () => {
    const { state, screen } = opened();
    state.smeltProgress = SMELT_TICKS / 4;
    expect(screen.smelting!.progressRatio).toBe(0.25);
  });
});

describe('熔炉界面的视图', () => {
  it('没有合成网格、输出格与配方书', () => {
    const { screen } = opened();
    expect(screen.crafting).toBeUndefined();
  });

  it('三格的格号接在背包 36 格之后，视图读得到三格内容', () => {
    const { screen } = opened(undefined, (s) => {
      s.input = rawIron(1);
      s.output = ingots(2);
    });
    const smelting = screen.smelting!;
    expect(smelting.firstSlot).toBe(INVENTORY_SIZE);
    expect(smelting.slot(FURNACE_INPUT_SLOT)).toEqual(rawIron(1));
    expect(smelting.slot(FURNACE_FUEL_SLOT)).toBeUndefined();
    expect(smelting.slot(FURNACE_RESULT_SLOT)).toEqual(ingots(2));
  });

  it('背包界面与工作台界面没有熔炼视图', () => {
    const screen = new InventoryScreen(new Inventory(), new CraftingGrid(CRAFTING_TABLE_GRID));
    expect(screen.smelting).toBeUndefined();
  });
});
