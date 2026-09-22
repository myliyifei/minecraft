import { BlockStateKind, blockStateKind, type BlockType } from './block';
import type { ItemStack, ItemType } from './item';

/**
 * 熔炉的方块状态（见 CONTEXT.md 的「方块状态」「熔炉」）：三个格子，加燃烧与熔炼的进度。
 *
 * 字段可写：熔炉界面的三格格子批（`FurnaceSlots`）与熔炼状态机（`stepFurnace`）直接改它们，世界只负责
 * 这条状态什么时候建、什么时候删（ADR-0011）。
 */
export interface FurnaceState {
  readonly kind: typeof BlockStateKind.Furnace;
  /** 原料格：待熔炼的东西。 */
  input: ItemStack | undefined;
  /** 燃料格。 */
  fuel: ItemStack | undefined;
  /** 成品格：熔炼出来的东西，界面里是只取格。 */
  output: ItemStack | undefined;
  /** 当前这份燃料还能烧多少 tick，0 是没在烧。 */
  burnTicksLeft: number;
  /** 当前这份燃料一共能烧多少 tick，界面上的火苗按 left / total 画。 */
  burnTicksTotal: number;
  /** 当前这份原料已经熔炼了多少 tick。 */
  smeltProgress: number;
  /**
   * 这份熔炼进度是哪种原料炼出来的，还没炼过是 undefined。原料格换成另一种原料时进度从 0 算起：
   * 炼了 199 tick 的粗铁换成原木，原木不能接着这 199 tick 下一 tick 就出木炭。
   */
  progressItem: ItemType | undefined;
  /** 熔炼出的成品还没被取走、因此还没结算给玩家的经验。 */
  pendingExperience: number;
}

/**
 * 一个方块的额外状态。目前只有熔炉；箱子进来时在这里多一种，按 `kind` 分派。
 */
export type BlockState = FurnaceState;

/** 一份空的熔炉状态：三格都空，没在烧，没在炼。 */
export function newFurnaceState(): FurnaceState {
  return {
    kind: BlockStateKind.Furnace,
    input: undefined,
    fuel: undefined,
    output: undefined,
    burnTicksLeft: 0,
    burnTicksTotal: 0,
    smeltProgress: 0,
    progressItem: undefined,
    pendingExperience: 0,
  };
}

/**
 * 这种方块刚放下时的状态；没有状态的方块返回 undefined。
 *
 * 按方块表的「方块状态」一列查种类，再造一份新的：每个方块各有自己的一条，两个熔炉不共用。
 */
export function initialBlockState(block: BlockType): BlockState | undefined {
  switch (blockStateKind(block)) {
    case BlockStateKind.Furnace:
      return newFurnaceState();
    case BlockStateKind.None:
      return undefined;
  }
}

/**
 * 状态里装着的物品：熔炉三格里非空的那几堆，按原料、燃料、成品的顺序。
 *
 * 挖掉方块时它们与方块自己的掉落一起在原位生成掉落物（`Mining.breakBlock`）——方块没了，
 * 里面的东西不能凭空消失。给出的是格里那一堆本身，工具的损耗跟着走（ADR-0010）。
 */
export function blockStateContents(state: BlockState): ItemStack[] {
  const contents: ItemStack[] = [];
  for (const stack of [state.input, state.fuel, state.output]) {
    if (stack) contents.push(stack);
  }
  return contents;
}

/** 方块状态表里的一条：哪一格、什么状态。调试句柄遍历整张表时读到的形状。 */
export interface BlockStateEntry {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: BlockState;
}

/**
 * 按世界坐标读方块状态的最小接口。
 *
 * 挖掘依赖它而不是 `World` 本身：挖穿一格之前要问一句「这一格里装着什么」，好把里面的东西
 * 掉出来；与 `BlockView` 分开，只读方块的消费者（网格生成、射线检测）不必知道状态表。
 */
export interface BlockStateView {
  /** (x, y, z) 那一格的方块状态，没有状态的方块与没有方块的格子都是 undefined。坐标按 floor 取整。 */
  blockStateAt(x: number, y: number, z: number): BlockState | undefined;
}
