import type { ItemStack, ItemType, SlotBatch } from './item';
import type { GridSize } from './recipe';

/**
 * 一批格子里每一格的规则：收不收某种物品，是不是只取格（见 CONTEXT.md）。
 *
 * 与 `RuledSlotBatch` 分开是因为背包那 36 格也按这两条规则处理（每格都收、都不是只取），
 * 但背包不是附加的格子批，「关闭界面时退不退回背包」对它没有意义。
 */
export interface SlotRules {
  /** 第 index 格收不收这种物品。放下、合并、交换之前都先按它判定；只取格的这一条不被读。 */
  accepts(index: number, item: ItemType): boolean;
  /** 第 index 格是不是只取格：只能从里面拿，不能往里放。 */
  isTakeOnly(index: number): boolean;
}

/**
 * 一个格子批的合成能力：网格几列几行、输出格显示什么、合成一份。
 *
 * 界面依赖它而不是 `CraftingGrid` 本身：点输出格、点配方书、画输出格要的只有这三样。
 * 没有输出格的格子批没有它（`RuledSlotBatch.crafting` 为 undefined），界面上就没有输出格
 * 与配方书。
 *
 * 带这份能力的格子批，前 `width * height` 格就是网格，按行编号，每格都收任何物品、都不是只取格：
 * 配方书填入材料时按图案下标直接写格子，不再逐格判定规则。
 */
export interface Crafting extends GridSize {
  /** 输出格（见 CONTEXT.md）里显示的成品，不匹配任何配方时 undefined。 */
  readonly output: ItemStack | undefined;
  /** 合成一份：每个非空格各消耗 1 个。调用方先看 `output` 确认匹配到了配方再来消耗。 */
  consumeOne(): void;
}

/**
 * 格子批（见 CONTEXT.md）：界面里接在背包 36 格之后的那一批附加格子，带着自己的规则。
 * 每格两条——收不收某种物品、是不是只取格；整批一条——关闭界面时里面的东西退不退回背包。
 * 合成网格是它的一个实现：每格都收、都不是只取、关闭时退回。熔炉的三格将是另一个：原料格
 * 与燃料格各只收特定物品、成品格只取、关闭时留在熔炉里。
 *
 * 界面依赖这个接口而不是某一种格子批：拿起、放下、合并、交换、拆堆、关闭时归还这套规则
 * 只写一遍，按每格的规则分派。
 *
 * 它是 `SlotBatch` 而不是 `SlotStore`：归还时东西一律往背包里进，格子批不按入包规则收东西。
 */
export interface RuledSlotBatch extends SlotBatch, SlotRules {
  /** 关闭界面时里面的东西退回背包吗。合成网格是；熔炉不是，里面的东西留在熔炉里。 */
  readonly returnsOnClose: boolean;
  /** 这批格子旁边的输出格与合成能力，没有输出格的格子批是 undefined。 */
  readonly crafting: Crafting | undefined;
}
