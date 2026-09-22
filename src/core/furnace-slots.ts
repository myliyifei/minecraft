import type { FurnaceState } from './block-state';
import { isSlotIndex } from './inventory';
import type { ItemStack, ItemType } from './item';
import type { RuledSlotBatch, SmeltingProgress } from './slot-batch';
import { isFuel, isSmeltable, SMELT_TICKS } from './smelting';

/** 原料格（见 CONTEXT.md）在熔炉三格里的下标。 */
export const FURNACE_INPUT_SLOT = 0;
/** 燃料格在熔炉三格里的下标。 */
export const FURNACE_FUEL_SLOT = 1;
/** 成品格在熔炉三格里的下标：只取格。 */
export const FURNACE_RESULT_SLOT = 2;

/**
 * 熔炉三格按下标对应熔炉状态的哪个字段：第 0 格原料、第 1 格燃料、第 2 格成品。
 *
 * 读与写共用这一张表：对应关系只写一遍，与上面三个下标常量对得上。
 */
const SLOT_FIELDS = ['input', 'fuel', 'output'] as const satisfies ReadonlyArray<keyof FurnaceState>;

/** 熔炉有几格：原料、燃料、成品。 */
const FURNACE_SLOT_COUNT = SLOT_FIELDS.length;

/**
 * 熔炉界面（见 CONTEXT.md）附加的那个格子批：原料格、燃料格、成品格。
 *
 * 它不存东西：三格直接读写状态表里那条熔炉状态的 `input`、`fuel`、`output`（ADR-0011）。
 * 界面上放进原料格的粗铁因此就在熔炉里，关掉界面还在，熔炼状态机（#34）改的也是同一份。
 *
 * 规则：原料格只收熔炼配方表里的原料，燃料格只收燃料表里的物品，成品格是只取格；关闭界面时
 * 三格留在熔炉里（`returnsOnClose` 为 false）。
 *
 * 核心只造一个，使用键对着哪个熔炉就重绑到哪一条状态（`bind`）：界面对象与界面层的 DOM
 * 都是造一次一直用的，换的只是这三格背后是哪个熔炉。
 */
export class FurnaceSlots implements RuledSlotBatch, SmeltingProgress {
  readonly size = FURNACE_SLOT_COUNT;
  /** 关闭界面时三格留在熔炉里：熔炉是储物点，不是临时摆材料的网格。 */
  readonly returnsOnClose = false;
  /** 熔炉没有输出格与配方书。 */
  readonly crafting = undefined;
  /** 此刻绑着的那条熔炉状态。还没对着哪个熔炉按过使用键时是 undefined，三格都是空的。 */
  private state: FurnaceState | undefined;

  /** 换成另一个熔炉的三格。界面关着时调，开着的界面不换熔炉。 */
  bind(state: FurnaceState): void {
    this.state = state;
  }

  /** 熔炉自己就是那份熔炼进度：两条进度条读的是绑着的那条状态。 */
  get smelting(): SmeltingProgress {
    return this;
  }

  slot(index: number): ItemStack | undefined {
    if (!isSlotIndex(index, FURNACE_SLOT_COUNT)) return undefined;
    return this.state?.[SLOT_FIELDS[index]!];
  }

  /** 指不到格子的下标什么都不写，理由同 `Inventory.setSlot`。没绑熔炉时同样不写。 */
  setSlot(index: number, stack: ItemStack | undefined): void {
    const state = this.state;
    if (!state || !isSlotIndex(index, FURNACE_SLOT_COUNT)) return;
    state[SLOT_FIELDS[index]!] = stack;
  }

  /** 原料格只收能熔炼的，燃料格只收燃料；成品格是只取格，这一条对它不被读。 */
  accepts(index: number, item: ItemType): boolean {
    if (index === FURNACE_INPUT_SLOT) return isSmeltable(item);
    if (index === FURNACE_FUEL_SLOT) return isFuel(item);
    return false;
  }

  isTakeOnly(index: number): boolean {
    return index === FURNACE_RESULT_SLOT;
  }

  /** 当前这件燃料还能烧的比例：剩余 tick 除以这件的总 tick。没点过火（总 tick 为 0）时是 0。 */
  get fuelRatio(): number {
    const state = this.state;
    if (!state || state.burnTicksTotal <= 0) return 0;
    return state.burnTicksLeft / state.burnTicksTotal;
  }

  /** 当前这件原料炼到几分之几：已熔炼 tick 除以每件的熔炼 tick。 */
  get progressRatio(): number {
    return (this.state?.smeltProgress ?? 0) / SMELT_TICKS;
  }
}
