import {
  ItemType,
  ToolClass,
  ToolMaterial,
  materialAtLeast,
  type ItemStack,
  type MiningTool,
} from './item';
import type { Vec3 } from './vec3';

/**
 * 方块种类。数值直接存进区块的 Uint8Array，因此已发布的编号不可改动，新方块追加即可。
 */
export const BlockType = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Bedrock: 4,
  OakLog: 5,
  OakLeaves: 6,
  OakPlanks: 7,
  CraftingTable: 8,
  Cobblestone: 9,
  Furnace: 10,
  /**
   * 燃烧中的熔炉（见 CONTEXT.md 的「熔炉」）：与 `Furnace` 是同一种方块的两个编号，只有正面贴图
   * 不同。放置永远放熄火那个编号；点火与熄火在两个编号之间切换（`stepFurnaces`、ADR-0012），
   * 两者挖掉都掉熔炉物品，共用同一条方块状态。
   */
  LitFurnace: 11,
  /** 煤矿石（见 CONTEXT.md 的「矿石」，issue #31）：嵌在石层里，持任何镐挖掉后掉煤炭。 */
  CoalOre: 12,
  /** 铁矿石（issue #31）：最低材质档石，持木镐挖得动但什么都不掉。 */
  IronOre: 13,
  /**
   * 火把（见 CONTEXT.md 的「火把」，#56）：每个朝向一个编号（ADR-0012 补记），五个是同一种方块，
   * `baseBlock` 都归到 `Torch`。`Torch` 立在下面那块的顶面上；`WallTorchNegX` 贴在它 −X 那一侧的
   * 墙上（墙在 x − 1），其余三个同理。贴着哪一格见支撑表 `supportCell`。
   */
  Torch: 14,
  WallTorchNegX: 15,
  WallTorchPosX: 16,
  WallTorchNegZ: 17,
  WallTorchPosZ: 18,
  /**
   * 白桦与云杉（#85）：各有原木、树叶、木板三种方块，数值与橡树那三种相同（`log`、`LEAVES`、`planks`）。
   * 三种树的同一种方块是不同的方块，不是外观变体：连锁挖掘里互不算同一类型（`baseBlock` 归到自己）。
   */
  BirchLog: 19,
  BirchLeaves: 20,
  BirchPlanks: 21,
  SpruceLog: 22,
  SpruceLeaves: 23,
  SprucePlanks: 24,
  /**
   * 水（见 CONTEXT.md 的「流体」，#74）：不实心、不是不透明，视线穿过它，挖不到，没有物品。目前不流动。
   */
  Water: 25,
  /**
   * 冰（见 CONTEXT.md 的「冰面」，#74）：实心、不是不透明，挖掉什么都不掉，原处变成一格水（`blockAfterMining`）。
   */
  Ice: 26,
  /**
   * 沙子、沙砾、雪草方块（#76）：地表铺法用的三种方块（见 CONTEXT.md「沙滩」「雪线」）。沙子与沙砾在原版是重力方块，
   * 这一切片不下落，悬空时停在原处（CONTEXT.md「重力方块」）。雪草方块与草方块一样没有物品，挖掉掉泥土；
   * 两者是不同的方块，连锁挖掘里互不算同一类型。
   */
  Sand: 27,
  Gravel: 28,
  SnowyGrass: 29,
  /**
   * 地表植物（见 CONTEXT.md「地表植物」，#80）：矮草、蕨、蒲公英、虞美人。不实心、不挡光、按下即碎、给 5 点经验，
   * 下面那一格没了随之碎掉（`supportCell`）。矮草与蕨什么都不掉、没有物品，放方块时可以直接替换它们（`canPlaceInto`）；
   * 两种花掉它自己，可以种回草方块、雪草方块与泥土上。四种是不同的方块，连锁挖掘里互不算同一类型。
   */
  ShortGrass: 30,
  Fern: 31,
  Dandelion: 32,
  Poppy: 33,
} as const;

export type BlockType = (typeof BlockType)[keyof typeof BlockType];

/**
 * 使用键对着这种方块（见 CONTEXT.md 的「使用」、ADR-0009）打开哪种界面；`None` 是不可使用，
 * 那一下走放置。
 *
 * 值是字符串而不是编号：它不进存档（由方块种类查出来），与 `ToolClass` 同一个理由。
 * 箱子进来时再加一个值，核心那边多一条分派，挖掘与放置的逻辑不必动。
 */
export const BlockUse = {
  None: 'none',
  CraftingTable: 'crafting-table',
  /** 熔炉界面（issue #33）。熔炉的两个编号都是这一档。 */
  Furnace: 'furnace',
} as const;

export type BlockUse = (typeof BlockUse)[keyof typeof BlockUse];

/**
 * 这种方块带哪一种方块状态（见 CONTEXT.md 的「方块状态」、ADR-0011）；`None` 是没有额外状态，
 * 绝大多数方块都是。
 *
 * 状态的形状在 `block-state.ts` 里，这里只记种类：方块表说「熔炉带熔炉状态」，世界据此在
 * 放下时建一条、挖掉时删一条。两个编号记同一种，编号之间切换时那条状态不动。
 * 值是字符串，理由同 `BlockUse`：它不进存档。
 */
export const BlockStateKind = {
  None: 'none',
  Furnace: 'furnace',
} as const;

export type BlockStateKind = (typeof BlockStateKind)[keyof typeof BlockStateKind];

/**
 * 天光与方块光经过这种方块时怎么走（见 CONTEXT.md 的「天光」「方块光」「不透明」、ADR-0017）。
 *
 * - `Opaque`：不透明，两种光都完全挡住。与 `BlockDef.opaque` 为 true 的方块是同一批。
 * - `Leaves`：树叶式，天光竖直穿过每格减 1；横向传播与方块光按空格算。
 * - `Clear`：不衰减，光照常通过。空气与火把是这一档。
 *
 * 值是字符串，理由同 `BlockUse`：它不进存档。
 */
export const LightPassage = {
  Opaque: 'opaque',
  Leaves: 'leaves',
  Clear: 'clear',
} as const;

export type LightPassage = (typeof LightPassage)[keyof typeof LightPassage];

/** 挖不动的方块的硬度。基岩是唯一一个。 */
export const UNBREAKABLE = Infinity;

export interface BlockDef {
  /** 是否完全遮挡视线。false 的方块（空气、树叶、火把）不会剔除邻居的面。 */
  readonly opaque: boolean;
  /**
   * 是否阻挡玩家与生物移动。
   * 与 `opaque` 是两件事：树叶不遮挡视线，但站在树冠里会被它挡住。
   */
  readonly solid: boolean;
  /** 硬度（见 CONTEXT.md），挖掘耗时按它算。`UNBREAKABLE` 表示怎么挖都挖不掉。 */
  readonly hardness: number;
  /**
   * 合格工具（见 CONTEXT.md）的两个条件之一：类别。挖它更快的那一类工具，石头是镐，原木是斧，
   * 草与泥土是铲。`None` 是「没有哪种工具挖它更快」，树叶就是这一档。
   *
   * 与 `requiresTool` 是两件事：这一列说「哪一类工具算合格」，那一列说「手上没有合格工具时还能不能
   * 拿到东西」。草方块有合格工具（铲）但空手挖也照样掉泥土。
   */
  readonly qualifiedToolClass: ToolClass;
  /**
   * 合格工具的另一个条件：最低材质档。类别对了，材质档还得不低于这一档（`materialAtLeast`）。
   * 类别对但档不够视同没有合格工具——需要工具的方块按每点硬度 100 tick 且什么都不掉，
   * 不需要工具的方块按倍率 1。
   *
   * 铁矿石记石：持木镐挖它挖得动，但按没有合格工具算。其余方块全部为木，任何镐、斧、铲在它们上面
   * 都合格。没有合格工具的方块（树叶）与不是挖掘目标的方块（空气、基岩）也填木，只是占位。
   */
  readonly minimumMaterial: ToolMaterial;
  /**
   * 挖它要合格工具（石头与圆石要镐）。空手照样挖得动，只是慢得多——每点硬度从 30 tick
   * 变成 100 tick，石头因此是 150 tick 而不是 45——而且什么都拿不到（见 `blockDrop`）。
   */
  readonly requiresTool: boolean;
  /**
   * 挖掉它掉出什么（见 CONTEXT.md 的「掉落表」），`null` 表示什么都不掉。
   *
   * 这一列是「拿着合格工具时掉什么」。需要工具的方块在没有合格工具时一律什么都不掉，
   * 那条规则在 `dropFor` 里，不在数据里：石头这一行记的是圆石，空手挖石头仍然什么都拿不到。
   */
  readonly drop: ItemStack | null;
  /**
   * 挖掉它生成的经验球给几点经验值（见 CONTEXT.md 的「经验球」），0 表示不生成经验球。
   *
   * 与 `drop` 是两列，不是一列：任何挖得动的方块都给经验，掉落却可能是空的——空手挖
   * 石头什么都拿不到，经验照给 30 点。矿石各有自己的档（煤 90、铁 120，整张表见
   * docs/design-decisions.md）。
   */
  readonly experience: number;
  /**
   * 使用键对着它是使用还是放置（见 `BlockUse`）。绝大多数方块是 `None`：对着它们
   * 走放置。工作台这类带界面的方块填自己那一档，对着它时不看手上拿的是什么。
   */
  readonly use: BlockUse;
  /**
   * 带哪一种方块状态（见 `BlockStateKind`）。绝大多数方块是 `None`。熔炉的两个编号都填
   * `Furnace`：世界按这一列决定放下时建不建状态、换成别的方块时删不删。
   */
  readonly state: BlockStateKind;
  /**
   * 发光等级：这种方块发出多强的方块光（0 到 15，见 CONTEXT.md 的「方块光」），0 是不发光。
   *
   * 火把是 14，燃烧中的熔炉是 13，其余方块为 0。
   */
  readonly lightEmission: number;
  /** 光经过它时怎么走（见 `LightPassage`）。 */
  readonly lightPassage: LightPassage;
}

/** 一个某种物品的掉落。掉落表里绝大多数行都是这个形状。 */
function one(item: ItemType): ItemStack {
  return { item, count: 1 };
}

/**
 * 普通方块给的经验值。原木与将来的矿石各有自己的档，见 `BlockDef.experience`。
 *
 * 是原版数值的 10 倍（#26）：第一切片按原版给 3 点，玩家试玩后认为升级太慢，整张经验表
 * 乘了 10，等级公式不动。
 */
const COMMON_EXPERIENCE = 30;

/**
 * 熔炉（见 CONTEXT.md，issue #30）：石制，比圆石硬得多；要镐，持镐挖掉掉回熔炉本身。
 * 两个编号（熄火与燃烧中）共用这一份：除正面贴图与发光等级外它们没有任何区别，写两遍就是两处可能
 * 对不上。带熔炉状态——原料、燃料、成品三格与燃烧、熔炼的进度存在世界的方块状态表里。
 * 可使用：使用键对着它打开熔炉界面（#33），不看手上拿的是什么。
 */
const FURNACE: BlockDef = {
  opaque: true,
  solid: true,
  hardness: 3.5,
  qualifiedToolClass: ToolClass.Pickaxe,
  minimumMaterial: ToolMaterial.Wood,
  requiresTool: true,
  drop: one(ItemType.Furnace),
  experience: COMMON_EXPERIENCE,
  use: BlockUse.Furnace,
  state: BlockStateKind.Furnace,
  lightEmission: 0,
  lightPassage: LightPassage.Opaque,
};

/**
 * 一种矿石（见 CONTEXT.md 的「矿石」，issue #31）那一行：石制、硬度 3、要镐、需要工具。
 * 两种矿石只差最低材质档、掉什么、给几点经验，其余写两遍就是两处可能对不上。
 *
 * 硬度 3 是石头的两倍：持木镐 45 tick、石镐 23 tick，比挖石头慢但仍在一两秒内。
 */
function ore(minimumMaterial: ToolMaterial, drop: ItemType, experience: number): BlockDef {
  return {
    opaque: true,
    solid: true,
    hardness: 3,
    qualifiedToolClass: ToolClass.Pickaxe,
    minimumMaterial,
    requiresTool: true,
    drop: one(drop),
    experience,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  };
}

/**
 * 火把（#56）：不实心、不挡光、发光 14。硬度 0，挖掘耗时按公式得 0 tick，按下那一 tick 就碎，不损耗耐久
 * （`wearsToolWhenMined`）。没有合格工具也不需要工具，拿什么挖都掉火把自己，不给经验。五个编号共用这一份。
 */
const TORCH: BlockDef = {
  opaque: false,
  solid: false,
  hardness: 0,
  qualifiedToolClass: ToolClass.None,
  minimumMaterial: ToolMaterial.Wood,
  requiresTool: false,
  drop: one(ItemType.Torch),
  experience: 0,
  use: BlockUse.None,
  state: BlockStateKind.None,
  lightEmission: 14,
  lightPassage: LightPassage.Clear,
};

/**
 * 一种树的原木（橡木、白桦、云杉三种共用这一份，#85）：硬度 2、合格工具是斧、不需要工具，掉自己那种原木。
 */
function log(item: ItemType): BlockDef {
  return {
    opaque: true,
    solid: true,
    hardness: 2,
    qualifiedToolClass: ToolClass.Axe,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: one(item),
    // 原木自成一档，比普通方块高一倍。
    experience: 60,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  };
}

/**
 * 一种树的树叶（三种共用这一份，#85）：什么都不掉，树苗与苹果要等树叶凋落（后续切片）。实心但不遮挡视线，
 * 树叶式透光（天光每格减 1）。三种树叶没有物品。
 */
const LEAVES: BlockDef = {
  opaque: false,
  solid: true,
  hardness: 0.2,
  // 原版用剪刀与剑。剪刀还没有，剑（#45）在本项目不是挖掘工具，所以树叶没有合格工具：拿什么挖都一样快。
  qualifiedToolClass: ToolClass.None,
  minimumMaterial: ToolMaterial.Wood,
  requiresTool: false,
  drop: null,
  // 树叶什么都不掉，但「任何方块都给经验」（见 CONTEXT.md 的「经验球」），
  // 所以它照普通方块给 30 点。原版的树叶不给经验，这一条是本项目自己定的。
  experience: COMMON_EXPERIENCE,
  use: BlockUse.None,
  state: BlockStateKind.None,
  lightEmission: 0,
  lightPassage: LightPassage.Leaves,
};

/**
 * 一种树的木板（三种共用这一份，#85）：挖掉掉回木板本身，放下去再挖起来材料不损失，木板因此是可以反复用的建材。
 */
function planks(item: ItemType): BlockDef {
  return {
    opaque: true,
    solid: true,
    hardness: 2,
    qualifiedToolClass: ToolClass.Axe,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: one(item),
    // 木板是加工过的建材，不像原木那样自成一档，按普通方块给。
    experience: COMMON_EXPERIENCE,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  };
}

/**
 * 水（#74）：不实心、不是不透明，天光竖直穿过每格减 1，与树叶同一种透光方式。
 *
 * 水与空气一样不是挖掘目标：视线穿过它（`sightPassesThrough`），`isBreakable` 因此为假。硬度、合格工具的类别
 * 与最低材质档只是占位，与空气同填。没有物品，什么都不掉，不给经验。
 */
const WATER: BlockDef = {
  opaque: false,
  solid: false,
  hardness: 0,
  qualifiedToolClass: ToolClass.None,
  minimumMaterial: ToolMaterial.Wood,
  requiresTool: false,
  drop: null,
  experience: 0,
  use: BlockUse.None,
  state: BlockStateKind.None,
  lightEmission: 0,
  lightPassage: LightPassage.Leaves,
};

/**
 * 冰（#74）：实心、不是不透明（火把插不上），透光方式与树叶相同。硬度 0.5，合格工具是镐但不需要工具，
 * 空手 15 tick、持木镐 8 tick。挖掉什么都不掉，经验照普通方块给；原处写水而不是空气（`blockAfterMining`）。
 */
const ICE: BlockDef = {
  opaque: false,
  solid: true,
  hardness: 0.5,
  qualifiedToolClass: ToolClass.Pickaxe,
  minimumMaterial: ToolMaterial.Wood,
  requiresTool: false,
  drop: null,
  experience: COMMON_EXPERIENCE,
  use: BlockUse.None,
  state: BlockStateKind.None,
  lightEmission: 0,
  lightPassage: LightPassage.Leaves,
};

/**
 * 地表植物给的经验值：经验表里「地表植物」那一档（docs/design-decisions.md），比普通方块少得多，清理矮草不会成为
 * 大量获取经验的途径。
 */
const PLANT_EXPERIENCE = 5;

/**
 * 一种地表植物（四种共用这一份，#80）：不实心、不是不透明、与火把同一种透光方式、不发光；硬度 0，按下那一 tick 就碎，
 * 不损耗工具；没有合格工具也不需要工具。`drop` 是 null 时什么都不掉（矮草与蕨）。
 */
function plant(drop: ItemType | null): BlockDef {
  return {
    opaque: false,
    solid: false,
    hardness: 0,
    qualifiedToolClass: ToolClass.None,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: drop === null ? null : one(drop),
    experience: PLANT_EXPERIENCE,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Clear,
  };
}

/**
 * 用铲挖更快、不需要工具、经验照普通方块给的一种土类方块（草方块、泥土、沙子、沙砾、雪草方块的属性结构相同）：
 * 只差硬度与掉什么。
 */
function soil(hardness: number, drop: ItemType): BlockDef {
  return {
    opaque: true,
    solid: true,
    hardness,
    qualifiedToolClass: ToolClass.Shovel,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: one(drop),
    experience: COMMON_EXPERIENCE,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  };
}

/** 方块属性表——纯数据。加方块只加一行。 */
export const BLOCKS: Readonly<Record<BlockType, BlockDef>> = {
  // 空气不是挖掘目标，硬度、合格工具的类别与最低材质档只是占位。
  [BlockType.Air]: {
    opaque: false,
    solid: false,
    hardness: 0,
    qualifiedToolClass: ToolClass.None,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: null,
    experience: 0,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Clear,
  },
  // 草方块掉的是泥土，不是草方块本身——与原版一致。
  [BlockType.Grass]: soil(0.6, ItemType.Dirt),
  [BlockType.Dirt]: soil(0.5, ItemType.Dirt),
  // 石头要镐：持镐挖掉掉圆石（与原版一致），空手挖得掉但什么也拿不到。
  [BlockType.Stone]: {
    opaque: true,
    solid: true,
    hardness: 1.5,
    qualifiedToolClass: ToolClass.Pickaxe,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: true,
    drop: one(ItemType.Cobblestone),
    experience: COMMON_EXPERIENCE,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  },
  [BlockType.Bedrock]: {
    opaque: true,
    solid: true,
    hardness: UNBREAKABLE,
    // 挖不动，谈不上哪种工具算合格工具。
    qualifiedToolClass: ToolClass.None,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: null,
    // 挖不动，所以它永远碎不了，也就不会生成经验球。
    experience: 0,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  },
  [BlockType.OakLog]: log(ItemType.OakLog),
  [BlockType.OakLeaves]: LEAVES,
  [BlockType.OakPlanks]: planks(ItemType.OakPlanks),
  // 工作台（见 CONTEXT.md）：木制，比木板硬半点；挖掉掉回工作台本身，搬得走。
  // 它是本切片唯一的可使用方块：使用键对着它打开工作台界面，而不是往它上面放方块。
  [BlockType.CraftingTable]: {
    opaque: true,
    solid: true,
    hardness: 2.5,
    qualifiedToolClass: ToolClass.Axe,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: false,
    drop: one(ItemType.CraftingTable),
    experience: COMMON_EXPERIENCE,
    use: BlockUse.CraftingTable,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  },
  // 圆石（issue #22）：石头持镐挖出来的建材，比石头硬半点。同样要镐，挖掉掉回圆石本身，
  // 放下去再挖起来材料不损失。
  [BlockType.Cobblestone]: {
    opaque: true,
    solid: true,
    hardness: 2,
    qualifiedToolClass: ToolClass.Pickaxe,
    minimumMaterial: ToolMaterial.Wood,
    requiresTool: true,
    drop: one(ItemType.Cobblestone),
    experience: COMMON_EXPERIENCE,
    use: BlockUse.None,
    state: BlockStateKind.None,
    lightEmission: 0,
    lightPassage: LightPassage.Opaque,
  },
  [BlockType.Furnace]: FURNACE,
  // 燃烧中的熔炉发光（#54），比火把暗一级。其余与熄火的那个编号相同：点火熄火换编号走 `setBlock`，
  // 光照随之更新，熔炼那边不必另外通知光照。
  [BlockType.LitFurnace]: { ...FURNACE, lightEmission: 13 },
  // 煤矿石：木镐就合格，掉煤炭，经验是普通方块的三倍。
  [BlockType.CoalOre]: ore(ToolMaterial.Wood, ItemType.Coal, 90),
  // 铁矿石：最低档石，持木镐挖得动却什么都不掉（`dropFor`），持石镐掉粗铁。
  [BlockType.IronOre]: ore(ToolMaterial.Stone, ItemType.RawIron, 120),
  [BlockType.Torch]: TORCH,
  [BlockType.WallTorchNegX]: TORCH,
  [BlockType.WallTorchPosX]: TORCH,
  [BlockType.WallTorchNegZ]: TORCH,
  [BlockType.WallTorchPosZ]: TORCH,
  [BlockType.BirchLog]: log(ItemType.BirchLog),
  [BlockType.BirchLeaves]: LEAVES,
  [BlockType.BirchPlanks]: planks(ItemType.BirchPlanks),
  [BlockType.SpruceLog]: log(ItemType.SpruceLog),
  [BlockType.SpruceLeaves]: LEAVES,
  [BlockType.SprucePlanks]: planks(ItemType.SprucePlanks),
  [BlockType.Water]: WATER,
  [BlockType.Ice]: ICE,
  // 沙子与沙砾（#76）：铲，掉自己。这一切片不下落。
  [BlockType.Sand]: soil(0.5, ItemType.Sand),
  [BlockType.Gravel]: soil(0.6, ItemType.Gravel),
  // 雪草方块（#76）：数值与草方块相同，掉泥土。
  [BlockType.SnowyGrass]: soil(0.6, ItemType.Dirt),
  // 地表植物（#80）：矮草与蕨什么都不掉，两种花掉它自己。
  [BlockType.ShortGrass]: plant(null),
  [BlockType.Fern]: plant(null),
  [BlockType.Dandelion]: plant(ItemType.Dandelion),
  [BlockType.Poppy]: plant(ItemType.Poppy),
};

export function isAir(block: BlockType): boolean {
  return block === BlockType.Air;
}

/** 完全遮挡视线的方块会让邻居对应的面被剔除。 */
export function isOpaque(block: BlockType): boolean {
  return BLOCKS[block].opaque;
}

/** 阻挡移动的方块参与实体的碰撞箱判定。 */
export function isSolid(block: BlockType): boolean {
  return BLOCKS[block].solid;
}

/** 挖得动的方块。视线穿过的方块（空气与水）不是挖掘目标，基岩挖不动。 */
export function isBreakable(block: BlockType): boolean {
  return !sightPassesThrough(block) && BLOCKS[block].hardness !== UNBREAKABLE;
}

export function isWater(block: BlockType): boolean {
  return block === BlockType.Water;
}

/** 是不是地表植物（四种之一，#80）。 */
export function isPlant(block: BlockType): boolean {
  return block === BlockType.ShortGrass || block === BlockType.Fern || isFlower(block);
}

/** 是不是花（蒲公英或虞美人）：有物品、掉它自己、种得回去，放方块时不被替换。 */
export function isFlower(block: BlockType): boolean {
  return block === BlockType.Dandelion || block === BlockType.Poppy;
}

/**
 * 花种得上去的方块（见 CONTEXT.md「放置」）：花的落点下面那一格必须是其中之一。生成只在草方块与雪草方块上放植物，
 * 是这一集合的子集。
 */
const PLANT_SOIL: ReadonlySet<BlockType> = new Set([BlockType.Grass, BlockType.SnowyGrass, BlockType.Dirt]);

/** 花能不能种在这种方块上面。 */
export function isPlantSoil(block: BlockType): boolean {
  return PLANT_SOIL.has(block);
}

/**
 * 支撑表（见 CONTEXT.md「火把」「地表植物」、ADR-0012 补记）：贴着别的方块才立得住的方块，它贴着的那一格相对它的偏移，
 * 以及那一格要是什么才撑得住它。与几何无关：火把的朝向、细杆与命中盒在 `torch.ts`，植物的命中盒在 `plant.ts`，
 * 这里只回答「贴着哪一格、那一格换成什么之后撑不住」。
 *
 * - 地面火把贴下方，墙上火把贴编号上写的那一侧（`WallTorchNegX` 的墙在 x − 1），那一格要是不透明方块。
 * - 四种地表植物贴下方，那一格要是实心方块：下面那格变成空气或水时随之碎掉。
 */
interface Support {
  readonly offset: Vec3;
  /** 贴着的那一格换成这种方块之后还撑不撑得住。 */
  readonly holds: (support: BlockType) => boolean;
}

const BELOW: Vec3 = { x: 0, y: -1, z: 0 };
const TORCH_HOLDS = (support: BlockType) => isOpaque(support);
const PLANT_HOLDS = (support: BlockType) => isSolid(support);

const SUPPORTS: Readonly<Partial<Record<BlockType, Support>>> = {
  [BlockType.Torch]: { offset: BELOW, holds: TORCH_HOLDS },
  [BlockType.WallTorchNegX]: { offset: { x: -1, y: 0, z: 0 }, holds: TORCH_HOLDS },
  [BlockType.WallTorchPosX]: { offset: { x: 1, y: 0, z: 0 }, holds: TORCH_HOLDS },
  [BlockType.WallTorchNegZ]: { offset: { x: 0, y: 0, z: -1 }, holds: TORCH_HOLDS },
  [BlockType.WallTorchPosZ]: { offset: { x: 0, y: 0, z: 1 }, holds: TORCH_HOLDS },
  [BlockType.ShortGrass]: { offset: BELOW, holds: PLANT_HOLDS },
  [BlockType.Fern]: { offset: BELOW, holds: PLANT_HOLDS },
  [BlockType.Dandelion]: { offset: BELOW, holds: PLANT_HOLDS },
  [BlockType.Poppy]: { offset: BELOW, holds: PLANT_HOLDS },
};

/** (x, y, z) 那一格的 block 贴着哪一格，不贴着任何一格的方块（绝大多数）是 undefined。 */
export function supportCell(block: BlockType, x: number, y: number, z: number): Vec3 | undefined {
  const offset = SUPPORTS[block]?.offset;
  return offset && { x: x + offset.x, y: y + offset.y, z: z + offset.z };
}

/** block 贴着的那一格换成 support 之后还撑不撑得住它。不贴着任何一格的方块永远撑得住。 */
export function supportHolds(block: BlockType, support: BlockType): boolean {
  return SUPPORTS[block]?.holds(support) ?? true;
}

/**
 * 一格方块周围可能贴着它的方块在哪：支撑表里出现过的偏移反过来，即上方与四侧，相对那一格。下方不算——
 * 没有倒挂的火把与植物。世界把一格换掉之后按它查邻格（`World.setBlock`）。
 */
export const SUPPORT_ATTACH_OFFSETS: readonly Vec3[] = Object.freeze(
  [...new Map(Object.values(SUPPORTS).map(({ offset }) => [`${offset.x},${offset.y},${offset.z}`, offset])).values()].map(
    ({ x, y, z }) => ({ x: -x, y: -y, z: -z }),
  ),
);

/**
 * 一格从 previous 换成 block 之后，有没有可能让贴着它的方块撑不住：从不透明变成非不透明（火把），或从实心变成不实心
 * （植物）。都不是时贴着它的方块都还撑得住，世界不必查邻格。
 */
export function mayDetachNeighbors(previous: BlockType, block: BlockType): boolean {
  return (isOpaque(previous) && !isOpaque(block)) || (isSolid(previous) && !isSolid(block));
}

/**
 * 选目标方块的视线穿不穿过这种方块（见 CONTEXT.md 的「目标方块」）：空气与水穿过，其余方块都能成为目标，
 * 树叶与冰也算。火把那一格另按细杆的盒子求交（`raycastBlocks`），不走这一条。
 */
export function sightPassesThrough(block: BlockType): boolean {
  return isAir(block) || isWater(block);
}

/**
 * 放置的落点能不能是这一格（见 CONTEXT.md 的「放置」）：空气、水、矮草与蕨可以，放下的方块替换原来那一格。
 * 两种花不行：花有物品，放方块时不替换它。火把与花不能放进水里，那一条在 `placeBlock`。
 */
export function canPlaceInto(block: BlockType): boolean {
  return isAir(block) || isWater(block) || block === BlockType.ShortGrass || block === BlockType.Fern;
}

/**
 * 挖掉这种方块之后原处是什么：冰变成一格水（见 CONTEXT.md 的「冰面」），其余方块变成空气。
 * 单块挖掘与连锁挖掘都按它写，连锁挖掉一片冰每一格都变成水。
 */
export function blockAfterMining(block: BlockType): BlockType {
  return block === BlockType.Ice ? BlockType.Water : BlockType.Air;
}

/**
 * 挖穿这种方块损不损耗手上那件工具的耐久：硬度 0 的方块（火把）不损耗，镐斧铲与剑都一样。
 * 损耗几点按工具类别查（`miningWearOf`），这里只回答「这一块算不算」。
 */
export function wearsToolWhenMined(block: BlockType): boolean {
  return BLOCKS[block].hardness > 0;
}

/**
 * 一点硬度要挖多少 tick（倍率为 1 时）。
 * 与原版一致：20 tick/s（ADR-0002）下的 30 tick 就是 1.5 秒。
 */
const TICKS_PER_HARDNESS = 30;

/**
 * 需要工具而手上没有合格工具时，一点硬度要挖多少 tick。
 * 石头因此空手要 150 tick，而不是按上面那一档算出来的 45。
 */
const TICKS_PER_HARDNESS_WITHOUT_TOOL = 100;

/**
 * 取整到 tick 时先减掉的容差。
 *
 * 硬度是 0.2、0.6 这类十进制小数，二进制存不精确：`0.2 × 30` 算出来是
 * 6.000000000000001，直接向上取整树叶就要挖 7 tick 而不是 6。容差比一个 tick 小得多，
 * 只抵消舍入误差，不改变任何本该取整的结果。
 */
const TICK_EPSILON = 1e-9;

/**
 * 手上那件工具对这种方块算不算合格工具（见 CONTEXT.md）：类别正确，且材质档不低于方块要求的
 * 最低档。方块没有合格工具（树叶）时任何工具都不合格；空手没有材质档，也不合格。
 */
function isQualifiedTool(def: BlockDef, tool: MiningTool): boolean {
  if (def.qualifiedToolClass === ToolClass.None || def.qualifiedToolClass !== tool.toolClass) return false;
  return tool.material !== undefined && materialAtLeast(tool.material, def.minimumMaterial);
}

/**
 * 手上拿着这件工具，按一份方块定义挖掉一个方块要多少 tick，挖不动的返回 `Infinity`。
 *
 * 公式：向上取整（硬度 × 30 ÷ 倍率）。倍率只在手上那件工具是合格工具时算数，否则是 1——
 * 拿铲挖原木与空手一样慢，拿木镐挖最低档为石的方块也一样慢。需要工具的方块在没有合格工具时另走
 * 一档（每点硬度 100 tick），这条优先于倍率：拿着石斧挖石头仍是 150 tick。
 *
 * 接一份定义而不是方块种类，是让测试拿一份改了最低档的定义验证材质档门槛，不必依赖方块表里
 * 恰好有铁矿石那一行。游戏里走的是 `miningTicks`。
 */
export function miningTicksFor(def: BlockDef, tool: MiningTool): number {
  const qualified = isQualifiedTool(def, tool);
  if (def.requiresTool && !qualified) {
    return Math.ceil(def.hardness * TICKS_PER_HARDNESS_WITHOUT_TOOL - TICK_EPSILON);
  }
  const speed = qualified ? tool.speed : 1;
  // 硬度 0（火把）减掉容差后向上取整是 −0，钳到 0：按下那一 tick 就碎（#56）。
  return Math.max(0, Math.ceil((def.hardness * TICKS_PER_HARDNESS) / speed - TICK_EPSILON));
}

/**
 * 手上拿着这件工具，挖掉一个方块要多少 tick，挖不动的返回 `Infinity`（`miningTicksFor`）。
 *
 * 空手（`BARE_HAND`）的结果：草 18、泥土 15、树叶 6、原木 60、石头 150。
 */
export function miningTicks(block: BlockType, tool: MiningTool): number {
  return miningTicksFor(BLOCKS[block], tool);
}

/**
 * 手上拿着这件工具，按一份方块定义挖掉一个方块掉出什么，什么都不掉时返回 `null`。
 *
 * 需要工具的方块只在手上拿着合格工具时掉东西——空手挖石头挖得掉，什么也拿不到，持木镐挖
 * 最低档为石的方块同样拿不到。其余方块不看工具：草方块拿镐挖照样掉泥土。
 *
 * 只要类别与材质档，不要倍率：掉什么与挖多快无关。接一份定义的理由同 `miningTicksFor`。
 */
export function dropFor(def: BlockDef, tool: MiningTool): ItemStack | null {
  if (def.requiresTool && !isQualifiedTool(def, tool)) return null;
  return def.drop;
}

/** 手上拿着这件工具，挖掉一个方块掉出什么，什么都不掉时返回 `null`（`dropFor`）。 */
export function blockDrop(block: BlockType, tool: MiningTool): ItemStack | null {
  return dropFor(BLOCKS[block], tool);
}

/**
 * 挖掉一个方块生成的经验球给几点经验值，0 表示不生成经验球。
 *
 * 不看工具：经验与掉落独立，空手挖石头拿不到圆石，经验照给。
 */
export function blockExperience(block: BlockType): number {
  return BLOCKS[block].experience;
}

/**
 * 使用键对着这种方块打开哪种界面，`None` 是不可使用（那一下走放置）。
 * 空气也是 `None`：什么都没瞄准时谈不上使用。
 */
export function blockUse(block: BlockType): BlockUse {
  return BLOCKS[block].use;
}

/**
 * 外观变体（ADR-0012）归到的那个编号：燃烧中的熔炉归到熔炉，墙上火把归到地面火把。不在表里的方块归到自己。
 */
const VARIANT_BASE: Readonly<Partial<Record<BlockType, BlockType>>> = {
  [BlockType.LitFurnace]: BlockType.Furnace,
  // 四个墙上火把归到地面火把（#56）：朝向不同，是同一种方块。
  [BlockType.WallTorchNegX]: BlockType.Torch,
  [BlockType.WallTorchPosX]: BlockType.Torch,
  [BlockType.WallTorchNegZ]: BlockType.Torch,
  [BlockType.WallTorchPosZ]: BlockType.Torch,
};

/**
 * 这个编号是哪一种方块：外观变体归到它的基本编号，其余方块是自己。
 *
 * 「与目标同一类型」按它比（连锁挖掘）：熄火与燃烧中的熔炉只是外观不同，排在一起时连成一片；地面与
 * 墙上的火把也是。
 */
export function baseBlock(block: BlockType): BlockType {
  return VARIANT_BASE[block] ?? block;
}

/**
 * 这种方块带哪一种方块状态，`None` 是没有。世界放下、换掉一个方块时按它维护状态表
 * （见 `World.setBlock`）。
 */
export function blockStateKind(block: BlockType): BlockStateKind {
  return BLOCKS[block].state;
}

/**
 * 放置表：一种物品放下去变成哪种方块，`null` 表示放不下去（工具、食物那些）。
 *
 * 与 `BLOCKS` 的 `drop` 一列正好反着来，但两张表并不互逆：草方块掉的是泥土，
 * 泥土放下去是泥土方块，草方块因此没有对应的物品；工具与食物则一头都没有。
 *
 * 表放在这个文件里而不是 `item.ts` 里，是因为 `block.ts` 已经 import 了 `item.ts`
 * （掉落表要写 `ItemStack`）。反过来再 import 一次就成了循环依赖，而两个模块顶层都有
 * 常量表要初始化，那种循环会在模块求值顺序上出问题。
 */
export const PLACED_BLOCKS: Readonly<Record<ItemType, BlockType | null>> = {
  [ItemType.Dirt]: BlockType.Dirt,
  [ItemType.OakLog]: BlockType.OakLog,
  [ItemType.OakPlanks]: BlockType.OakPlanks,
  // 木棍只是材料，没有对应的方块。
  [ItemType.Stick]: null,
  [ItemType.CraftingTable]: BlockType.CraftingTable,
  // 工具放不下去：手里拿着工具按使用键，对着不可使用的方块没有任何反应。
  [ItemType.WoodenPickaxe]: null,
  [ItemType.WoodenAxe]: null,
  [ItemType.WoodenShovel]: null,
  [ItemType.Cobblestone]: BlockType.Cobblestone,
  [ItemType.StonePickaxe]: null,
  [ItemType.StoneAxe]: null,
  [ItemType.StoneShovel]: null,
  // 放置永远是熄火那个编号：燃烧中的熔炉没有对应的物品，它挖掉也掉这一种。
  [ItemType.Furnace]: BlockType.Furnace,
  // 煤炭与粗铁只是材料：矿石挖掉不掉矿石方块本身，所以它们没有对应的方块。
  [ItemType.Coal]: null,
  [ItemType.RawIron]: null,
  // 铁锭同样只是材料；三件铁制工具与木石两档一样放不下去（#32）。
  [ItemType.IronIngot]: null,
  [ItemType.IronPickaxe]: null,
  [ItemType.IronAxe]: null,
  [ItemType.IronShovel]: null,
  // 木炭同样只是材料：原木炼出来的，没有对应的方块（#34）。
  [ItemType.Charcoal]: null,
  // 腐肉是僵尸掉的材料，放不下去；饥饿值进来之前也吃不了（#42）。
  [ItemType.RottenFlesh]: null,
  // 三把剑与工具一样放不下去（#45）。
  [ItemType.WoodenSword]: null,
  [ItemType.StoneSword]: null,
  [ItemType.IronSword]: null,
  // 火把放下去先按地面火把查，放置再按命中面换成哪一个朝向（`torchOnFace`，#56）。
  [ItemType.Torch]: BlockType.Torch,
  // 白桦与云杉的原木与木板（#85）放下去是对应的方块。三种树叶没有物品，这张表里没有哪一行放下去是树叶。
  [ItemType.BirchLog]: BlockType.BirchLog,
  [ItemType.BirchPlanks]: BlockType.BirchPlanks,
  [ItemType.SpruceLog]: BlockType.SpruceLog,
  [ItemType.SprucePlanks]: BlockType.SprucePlanks,
  // 沙子与沙砾（#76）放下去是对应的方块。雪草方块与草方块一样没有物品。
  [ItemType.Sand]: BlockType.Sand,
  [ItemType.Gravel]: BlockType.Gravel,
  // 两种花（#80）放下去是对应的方块。矮草与蕨没有物品。
  [ItemType.Dandelion]: BlockType.Dandelion,
  [ItemType.Poppy]: BlockType.Poppy,
};

/**
 * 这种物品放下去是哪种方块，放不下去的返回 `null`。
 *
 * 表里没有的物品编号（存档来自更新的版本，或者测试里的假物品）也当成放不下去，
 * 而不是让调用方拿到 undefined。
 */
export function placedBlock(item: ItemType): BlockType | null {
  return PLACED_BLOCKS[item] ?? null;
}

/**
 * 按世界坐标读方块的最小接口。
 * 网格生成、射线检测这些只读消费者依赖它而不是 World 本身，便于用假数据测试。
 */
export interface BlockView {
  getBlock(x: number, y: number, z: number): BlockType;
}

/**
 * 按世界坐标读写方块的最小接口。
 * 挖掘要把方块改成空气，因此比只读的 `BlockView` 多一个写入；返回值表示这次写入
 * 落到世界里了没有（区块未加载、y 越界都算没落地）。
 */
export interface BlockEdit extends BlockView {
  setBlock(x: number, y: number, z: number, block: BlockType): boolean;
}
