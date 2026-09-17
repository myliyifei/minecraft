/**
 * 物品种类（见 CONTEXT.md 的「物品」）。数值会进存档，因此已发布的编号不可改动，
 * 新物品追加即可。
 *
 * 与方块是两套编号，不是一套：工具、食物这些物品没有对应的方块，草方块这样的方块
 * 掉的又是另一种物品（泥土）。哪种方块掉什么在 `BLOCKS` 的 `drop` 一列里。
 */
export const ItemType = {
  Dirt: 1,
  OakLog: 2,
  OakPlanks: 3,
  Stick: 4,
  CraftingTable: 5,
  WoodenPickaxe: 6,
  WoodenAxe: 7,
  WoodenShovel: 8,
  Cobblestone: 9,
  StonePickaxe: 10,
  StoneAxe: 11,
  StoneShovel: 12,
} as const;

export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** 一格里的一堆物品。`count` 恒 ≥ 1——数量归零的堆就是空格，用 undefined 表示。 */
export interface ItemStack {
  readonly item: ItemType;
  readonly count: number;
  /**
   * 已损耗的耐久（见 CONTEXT.md 的「耐久」、ADR-0010）：只在工具上出现，材料与方块物品没有
   * 这个字段。没有这个字段就是满耐久，所以新造的工具与材料一样只有种类与数量。
   *
   * 耐久是这一堆的状态而不是一个独立实体：两把损耗不同的木镐是两堆各自带着 `damage` 的物品，
   * 换格、进背包、扔到地上再拾起都跟着走（`withCount`）。
   */
  readonly damage?: number;
}

/**
 * 同一堆物品换个数量：种类与损耗都照旧。
 *
 * 凡是从一堆现成的物品里分出一部分（并进一格、用掉一个、退不回去的余量）都走这条，而不是
 * 手写 `{ item, count }`——那样写会把工具的损耗丢掉，一把用旧的镐经过一次归还就成了新的。
 */
export function withCount(stack: ItemStack, count: number): ItemStack {
  return { ...stack, count };
}

/**
 * 工具类别（见 CONTEXT.md 的「工具」）：镐、斧、铲，加一个「无」。
 *
 * 两侧都用它：物品那边说某件工具属于哪一类（`ToolDef.toolClass`），方块那边说挖它的
 * 正确工具是哪一类（`BlockDef.properTool`）。「无」同时表示三件事——空手、手上那件东西
 * 不是工具、这种方块没有正确工具（树叶）。三者对挖掘的作用相同，不必分开。
 *
 * 值是字符串而不是编号：它不进存档（工具类别是由物品种类查出来的，不单独存），
 * 所以不必像 `ItemType` 那样把编号钉死，读起来还清楚些。
 */
export const ToolClass = {
  None: 'none',
  Pickaxe: 'pickaxe',
  Axe: 'axe',
  Shovel: 'shovel',
} as const;

export type ToolClass = (typeof ToolClass)[keyof typeof ToolClass];

/**
 * 手上那件工具在挖掘上起的作用：算不算正确工具看类别，是正确工具时快多少看倍率。
 *
 * 只有这两个数进得了耗时公式，所以挖掘拿到的是它而不是整堆物品——耐久与图标不参与
 * 算耗时。哪种物品对应哪一件工具是物品表的事（`ToolDef`），倍率按材质档查（`TOOL_MATERIALS`），
 * 两样合成这一个值的地方是 `miningToolOf`。
 *
 * 与 `Hand` 不是一回事，别混：`Hand` 是「选中格里那一堆物品」，这里是「那一堆在挖掘
 * 那一步算什么」。空手也有这么一个值（`BARE_HAND`），它不是一只 `Hand`。
 */
export interface MiningTool {
  readonly toolClass: ToolClass;
  /** 挖掘速度倍率：木 2、石 4（见 #15 的物品属性表）。空手是 1。 */
  readonly speed: number;
}

/** 空手：没有类别，因此对任何方块都不算正确工具，倍率 1。手上拿着的不是工具时也是它。 */
export const BARE_HAND: MiningTool = Object.freeze({ toolClass: ToolClass.None, speed: 1 });

/**
 * 工具的材质档（见 CONTEXT.md 的「材质档」）：目前有木与石。铁、金、钻石在各自的切片里各加一行。
 *
 * 倍率与最大耐久按材质档查（`TOOL_MATERIALS`），不按每件工具各记一份：同一档的镐斧铲三件数值相同，
 * 记三遍就是三处可能对不上。值是字符串，理由同 `ToolClass`：它不进存档。
 */
export const ToolMaterial = {
  Wood: 'wood',
  Stone: 'stone',
} as const;

export type ToolMaterial = (typeof ToolMaterial)[keyof typeof ToolMaterial];

/** 一档材质的两个数：挖掘速度倍率与最大耐久。 */
export interface ToolMaterialDef {
  /** 手持正确工具时挖掘耗时除的倍率（见 `miningTicks`）。 */
  readonly speed: number;
  /** 满耐久是多少点；损耗到这么多点工具消失（`wornTool`）。 */
  readonly durability: number;
}

/**
 * 材质档属性表——纯数据，数值与原版一致（#15 的物品属性表）。铁、金、钻石各加一行。
 */
export const TOOL_MATERIALS: Readonly<Record<ToolMaterial, ToolMaterialDef>> = {
  [ToolMaterial.Wood]: { speed: 2, durability: 59 },
  [ToolMaterial.Stone]: { speed: 4, durability: 131 },
};

/**
 * 一件工具是哪一类、哪一档。物品表里工具那几行填它，材料与方块物品没有。
 *
 * 两样合成一个对象而不是物品表上的两列：「有类别却没有材质档」这种组合对不上任何物品，
 * 合在一起类型上就不存在这种行。
 */
export interface ToolDef {
  readonly toolClass: ToolClass;
  readonly material: ToolMaterial;
}

export interface ItemDef {
  /** 一格最多堆多少个。工具是 1（`TOOL_STACK_SIZE`）——每把各有自己的耐久（ADR-0010）。 */
  readonly stackSize: number;
  /** 这种物品是哪一件工具，不是工具的物品是 undefined。 */
  readonly tool: ToolDef | undefined;
}

/** 可堆叠物品的堆叠上限。与原版一致。 */
export const DEFAULT_STACK_SIZE = 64;

/** 工具的堆叠上限：每把占一格。 */
export const TOOL_STACK_SIZE = 1;

/** 物品表里材料与方块物品那一行的形状：可堆叠、不是工具。 */
const STACKABLE: ItemDef = Object.freeze({ stackSize: DEFAULT_STACK_SIZE, tool: undefined });

/** 物品表里一件工具那一行的形状：每把占一格。 */
function tool(toolClass: ToolClass, material: ToolMaterial): ItemDef {
  return { stackSize: TOOL_STACK_SIZE, tool: { toolClass, material } };
}

/** 物品属性表——纯数据。耐久、食物回复量是后续切片往这里加的数据列。 */
export const ITEMS: Readonly<Record<ItemType, ItemDef>> = {
  [ItemType.Dirt]: STACKABLE,
  [ItemType.OakLog]: STACKABLE,
  [ItemType.OakPlanks]: STACKABLE,
  [ItemType.Stick]: STACKABLE,
  [ItemType.CraftingTable]: STACKABLE,
  [ItemType.WoodenPickaxe]: tool(ToolClass.Pickaxe, ToolMaterial.Wood),
  [ItemType.WoodenAxe]: tool(ToolClass.Axe, ToolMaterial.Wood),
  [ItemType.WoodenShovel]: tool(ToolClass.Shovel, ToolMaterial.Wood),
  [ItemType.Cobblestone]: STACKABLE,
  [ItemType.StonePickaxe]: tool(ToolClass.Pickaxe, ToolMaterial.Stone),
  [ItemType.StoneAxe]: tool(ToolClass.Axe, ToolMaterial.Stone),
  [ItemType.StoneShovel]: tool(ToolClass.Shovel, ToolMaterial.Stone),
};

/** 这种物品一格最多堆多少个。 */
export function stackLimit(item: ItemType): number {
  return ITEMS[item].stackSize;
}

/**
 * 这种物品一格只放得下一个吗（工具）。
 *
 * 背包界面的合并规则对它退化为交换：光标与格里都是同种工具时换手，而不是「满了所以
 * 没有任何反应」——两把工具各有自己的耐久（ADR-0010），换与不换不是一回事。
 */
export function isUnstackable(item: ItemType): boolean {
  return stackLimit(item) === 1;
}

/** 这种物品是哪一件工具（类别与材质档），不是工具时 undefined。 */
export function toolOf(item: ItemType): ToolDef | undefined {
  return ITEMS[item].tool;
}

/**
 * 手上那一堆在挖掘里算什么工具：工具按类别与材质档的倍率算，其余（空手、材料、方块物品）
 * 都是 `BARE_HAND`。损耗不参与——挖到只剩 1 点耐久的木镐与新的一样快。
 */
export function miningToolOf(stack: ItemStack | undefined): MiningTool {
  const tool = stack && toolOf(stack.item);
  if (!tool) return BARE_HAND;
  return { toolClass: tool.toolClass, speed: TOOL_MATERIALS[tool.material].speed };
}

/** 这种物品的满耐久是多少点，不是工具时 undefined。 */
export function maxDurability(item: ItemType): number | undefined {
  const tool = toolOf(item);
  return tool && TOOL_MATERIALS[tool.material].durability;
}

/** 一件工具还剩几点耐久、满耐久是几点。 */
export interface Durability {
  readonly left: number;
  readonly max: number;
}

/**
 * 这一堆的耐久：还剩几点、满是几点；不是工具时 undefined。
 *
 * 界面上的耐久条读它：剩满不画，其余按 `left / max` 画长度，读屏文字报「58/59」。在这里算
 * 而不是在界面层，「满耐久是多少」这个数只有物品表知道。
 */
export function durabilityOf(stack: ItemStack): Durability | undefined {
  const max = maxDurability(stack.item);
  if (max === undefined) return undefined;
  return { left: max - (stack.damage ?? 0), max };
}

/**
 * 这一堆损耗 `points` 点耐久之后是什么：损耗累加；累加到满耐久工具消失，那一格清空（undefined）。
 * 材料没有耐久，原样返回；空手（undefined）仍是空手。
 *
 * 一次可以损耗好几点：连锁挖掘把集合里每块各 1 点合成一次结算，损耗超过剩余耐久时工具同样
 * 消失（见 CONTEXT.md 的「连锁挖掘」）。
 */
export function wornTool(stack: ItemStack | undefined, points: number): ItemStack | undefined {
  if (!stack || points <= 0) return stack;
  const max = maxDurability(stack.item);
  if (max === undefined) return stack;
  const damage = (stack.damage ?? 0) + points;
  return damage >= max ? undefined : { ...stack, damage };
}

/**
 * 收物品的地方，返回没放下的数量（0 表示全收下了）。
 *
 * 掉落物依赖它而不是 `Inventory` 本身：吸入那条路只需要「能不能收下」这一件事，
 * 测试里因此可以塞一个满的假背包，不必先把 36 格填出来。
 */
export interface ItemSink {
  add(stack: ItemStack): number;
}

/**
 * 一批可以逐格读写的物品格子。
 *
 * 背包界面依赖它而不是 `Inventory` 本身：那套拿起放下只搬格子里的东西，与选中格、
 * 快捷栏无关。合成网格（#17）与将来箱子的 27 格都是这么一批格子。
 */
export interface SlotBatch {
  /** 格子总数。 */
  readonly size: number;
  /** 某一格里的一堆物品，空格与指不到格子的下标都是 undefined。 */
  slot(index: number): ItemStack | undefined;
  /** 把某一格换成一堆物品（undefined 表示清空）。指不到格子的下标什么都不写。 */
  setSlot(index: number, stack: ItemStack | undefined): void;
}

/**
 * 一批格子，还能按入包规则整堆收物品（`add`）。背包是这么一批。
 *
 * 与 `SlotBatch` 分开是因为「收得下入包的东西」不是每一批格子都支持的操作：合成网格
 * 逐格读写，但拾取到的东西不该落进网格里，它因此只是 `SlotBatch`。关闭界面时东西
 * 往回归还，收的那一头必须是这一种。
 */
export interface SlotStore extends SlotBatch, ItemSink {}

/**
 * 手上拿着的那一堆物品，以及从它里面用掉一个。
 *
 * 放置依赖它而不是 `Inventory` 本身：放置只要「手上是什么」和「用掉一个」两件事，
 * 与「手上」是快捷栏的哪一格无关。测试里因此可以塞一只拿着任意东西的手。
 */
export interface Hand {
  /** 手持的那一堆（快捷栏选中格里的），空手时 undefined。 */
  readonly held: ItemStack | undefined;
  /** 用掉手上的一个。空手时什么都不做。 */
  takeOne(): void;
}

/**
 * 手上拿着的那一堆，以及让它损耗耐久。
 *
 * 挖掘依赖它而不是 `Inventory` 本身：挖掘每 tick 要看手上是什么工具（算耗时），挖穿时要
 * 让它损耗几点，与「手上」是快捷栏的哪一格无关。与 `Hand` 分开：放置用掉一个，挖掘磨掉几点，
 * 两件事互不需要对方那一个操作。
 */
export interface ToolHand {
  /** 手持的那一堆，空手时 undefined。 */
  readonly held: ItemStack | undefined;
  /** 手上那件工具损耗 points 点耐久，损耗到满时那一格清空（`wornTool`）。手上不是工具时什么都不做。 */
  wearHeld(points: number): void;
}
