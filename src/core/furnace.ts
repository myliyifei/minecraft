import { BlockStateKind, BlockType, type BlockEdit } from './block';
import type { BlockStateEntry, FurnaceState } from './block-state';
import { stackLimit, withCount, withoutOne } from './item';
import {
  burnTicksOf,
  SMELT_REGRESS_PER_TICK,
  SMELT_TICKS,
  smeltingRecipe,
  type SmeltingRecipe,
} from './smelting';

/** 熔炉此刻在烧吗：当前这件燃料还剩 tick。 */
export function isBurning(state: FurnaceState): boolean {
  return state.burnTicksLeft > 0;
}

/**
 * 熔炉推进一个 tick（见 GLOSSARY.md 的「熔炼」「熔炼进度」）。
 *
 * - 原料格里的东西能炼、成品格收得下它的成品时才算「能炼」（`recipeToSmelt`）。
 * - 没在烧而能炼、燃料格有燃料：点一件，这一 tick 就算烧了，进度 +1。
 * - 在烧：燃料剩余 −1；能炼就进度 +1，到 200 出 1 件成品，否则进度倒退。
 * - 没在烧也点不着：进度每 tick −2，退到 0 为止。
 * - 这一 tick 把当前这件燃料烧完了，而仍然能炼、还有燃料：同一 tick 接着点下一件，从下一 tick 起烧。
 *   熔炉因此一直在烧，方块编号在两件燃料之间不会短暂换回熄火的那个（`stepFurnaces`）。
 *
 * 两处点火的时机不同，是为了让「一件煤恰好炼 8 件」：没在烧时点着的那一 tick 就是这件煤的第 1 tick，
 * 接续点着的那一件从下一 tick 起算，每件燃料都正好烧满它的燃烧时长。
 *
 * 原料格与成品格都能炼时才点新燃料；原料空了、成品格满了或装着别的东西时不点，正在烧的那件烧完为止。
 */
export function stepFurnace(state: FurnaceState): void {
  if (!isBurning(state)) ignite(state);
  if (!isBurning(state)) {
    regress(state);
    return;
  }
  state.burnTicksLeft--;
  const recipe = recipeToSmelt(state);
  if (recipe) advance(state, recipe);
  else regress(state);
  if (!isBurning(state)) ignite(state);
}

/**
 * 能炼的话点一件燃料：燃料格扣 1 件，剩余与总 tick 都设成它的燃烧时长。不能炼、燃料格空着、
 * 或燃料格里的东西不是燃料（调试路径放进去的）时什么都不做。
 */
function ignite(state: FurnaceState): void {
  const fuel = state.fuel;
  if (!fuel || !recipeToSmelt(state)) return;
  const ticks = burnTicksOf(fuel.item);
  if (ticks === undefined) return;
  state.fuel = withoutOne(fuel);
  state.burnTicksLeft = ticks;
  state.burnTicksTotal = ticks;
}

/**
 * 熔炼进度 +1；炼满一件时原料 −1、成品 +1、待结算经验加上这件的份额、进度归 0。
 *
 * 原料格里换成了另一种原料，进度先归 0 再加：进度是某一种原料炼了多少 tick，不能挪给另一种。
 * 原料格空着时进度照常倒退、记着的原料不变，放回同一种原料接着倒退剩下的进度往上炼。
 */
function advance(state: FurnaceState, recipe: SmeltingRecipe): void {
  const input = state.input!;
  if (state.progressItem !== input.item) {
    state.progressItem = input.item;
    state.smeltProgress = 0;
  }
  state.smeltProgress++;
  if (state.smeltProgress < SMELT_TICKS) return;
  state.smeltProgress = 0;
  state.input = withoutOne(input);
  const output = state.output;
  state.output = output ? withCount(output, output.count + 1) : { item: recipe.result, count: 1 };
  state.pendingExperience += recipe.experience;
}

/** 没在炼：进度倒退，退到 0 为止。 */
function regress(state: FurnaceState): void {
  state.smeltProgress = Math.max(0, state.smeltProgress - SMELT_REGRESS_PER_TICK);
}

/**
 * 此刻能炼的那条配方：原料格里的东西在配方表里，成品格为空，或装着同一种成品且不满一堆。
 * 不能炼时 undefined。
 */
function recipeToSmelt(state: FurnaceState): SmeltingRecipe | undefined {
  const input = state.input;
  const recipe = input && smeltingRecipe(input.item);
  if (!recipe) return undefined;
  const output = state.output;
  if (!output) return recipe;
  if (output.item !== recipe.result || output.count >= stackLimit(output.item)) return undefined;
  return recipe;
}

/**
 * 玩家从成品格取走了 `taken` 个，结算它们的那份待结算经验，返回结算了几点。调用时成品格里已经是
 * 取走之后剩下的。
 *
 * 待结算经验是还没取走的那些成品各自经验的总和，按取走的件数占取走前件数的比例结算、向下取整；
 * 成品格取光时把余下的全给。所以分几次取与一次取完，总量相同。
 */
export function takeExperience(state: FurnaceState, taken: number): number {
  const left = state.output?.count ?? 0;
  const share =
    left === 0 ? state.pendingExperience : Math.floor((state.pendingExperience * taken) / (taken + left));
  state.pendingExperience -= share;
  return share;
}

/**
 * 熔炉推进要的世界：已加载区块里的方块状态，加上写方块。燃烧状态一变就换方块编号，
 * 写入走 `setBlock`，网格重建由「哪些方块变过」那份记录处理（ADR-0012）。
 */
export interface FurnaceWorld extends BlockEdit {
  loadedBlockStates(): Iterable<BlockStateEntry>;
}

/**
 * 世界里已加载区块中的每个熔炉推进一个 tick。所在区块没加载的熔炉跳过，不补算：玩家离开期间
 * 不会凭空多出成品，也不消耗燃料。
 *
 * 方块编号只在燃烧状态变化时换（ADR-0012）：开始燃烧换成燃烧中的熔炉，烧完且没接续换回熔炉。
 * 编号在同一种状态的两个编号之间切换，状态表里那条不动（ADR-0011）。
 */
export function stepFurnaces(world: FurnaceWorld): void {
  for (const { x, y, z, state } of world.loadedBlockStates()) {
    if (state.kind !== BlockStateKind.Furnace) continue;
    const wasBurning = isBurning(state);
    stepFurnace(state);
    const burning = isBurning(state);
    if (burning !== wasBurning) {
      world.setBlock(x, y, z, burning ? BlockType.LitFurnace : BlockType.Furnace);
    }
  }
}
