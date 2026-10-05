import type { ChunkBlocks } from './chunk';
import type { Difficulty } from './difficulty';
import type { ItemStack, ItemType } from './item';
import type { HorizontalDelta } from './physics';
import type { Vec3 } from './vec3';

/*
 * 快照（ADR-0018）：核心导出、也能从它构造的世界持续状态，全是普通对象、数组与 `Uint8Array`，不含函数与类实例。
 * 存储模块（IndexedDB、导出文件）只读写这里的形状，核心之外不必知道任何一个类的内部。
 *
 * 不在快照里的是瞬态，从快照构造时取初始值：僵尸、光照、挖掘与攻击进度、排队输入、界面开合、光标物品、
 * 合成网格，以及实体上一 tick 的位置（取当前位置）与无敌时间（由上次受伤的 tick 重建）。
 */

/**
 * 快照的格式版本。存储模块把它写进世界元数据，读档时与这里不同的世界不能进入，只能删除或导出。
 * 下面这些类型的字段增删、含义变了都要加 1；本切片不写迁移。
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/**
 * 地形算法的版本。已改区块整块存，没改过的区块读档时按种子重新生成：地形算法一变，新生成的区块与存下来的
 * 已改区块就不一致（ADR-0008），所以它与格式版本一样写进元数据、读档时比对。改 `terrain.ts` 的生成结果时加 1。
 *
 * 版本 1 是前六个切片的二维平原；版本 2 是三维密度地形与四种群系（ADR-0021，#75）。
 */
export const TERRAIN_VERSION = 2;

/** 世界的持续状态。 */
export interface Snapshot {
  readonly seed: number;
  readonly difficulty: Difficulty;
  /** 极限难度下玩家死过：这个世界只剩删除。 */
  readonly hardcoreDead: boolean;
  /**
   * 进入世界时的出生点（`GameCore.spawnPoint`）。读档时出生列可能还没加载，不能重算。
   */
  readonly firstSpawn: Vec3;
  /** tick 计数。运行时随机的哈希输入之一（ADR-0014）。 */
  readonly ticks: number;
  /** 世界时刻相对 tick 计数的偏移（`timeOfDayAt`）。 */
  readonly timeOffset: number;
  /** 下一个掉落物、僵尸、经验球的编号。也是哈希输入，读档后接着往下编。 */
  readonly nextDropId: number;
  readonly nextZombieId: number;
  readonly nextXpOrbId: number;
  readonly player: PlayerSnapshot;
  readonly drops: readonly DropSnapshot[];
  readonly xpOrbs: readonly XpOrbSnapshot[];
  /** 方块状态表（ADR-0011），每条带坐标，不带种类：种类由那一格的方块编号查出来（`blockStateKind`）。 */
  readonly blockStates: readonly BlockStateRecord[];
  /**
   * 已改区块，每个只有方块数组。
   *
   * 导出快照（`GameCore.snapshot`）时这里只有上次写盘之后改过的那些，从快照构造时这里要给存档里的全部已改区块。
   * 数组归收到它的一方所有：导出的是复制出来的，从快照构造时核心直接接管，调用方之后不要再改它。
   */
  readonly editedChunks: readonly ChunkRecord[];
}

/** 玩家的持续状态。 */
export interface PlayerSnapshot {
  /** 碰撞箱底面中心。 */
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly velocityY: number;
  /** 离地之后到过的最高 y（`FallTracker`）：在半空中存档，读档后这次摔落照样按整段落差算。 */
  readonly fallHighest: number;
  /** 击退的水平速度，没被打过时两个分量都是 0。 */
  readonly knockback: HorizontalDelta;
  readonly health: number;
  /** 上一次受伤是第几个 tick，没受过伤是 null。 */
  readonly lastHurtTick: number | null;
  /** 累计经验值。等级由它算出来。 */
  readonly experience: number;
  /**
   * 背包 36 格，空格是 null。快照里的「没有」一律写 null 而不是 undefined：导出文件的 JSON 段里 undefined
   * 在数组里变成 null、在对象里整个字段丢掉，统一成 null，读写两边只认一种写法。
   */
  readonly inventory: ReadonlyArray<ItemStack | null>;
  readonly selectedSlot: number;
}

/** 一个掉落物。 */
export interface DropSnapshot {
  readonly id: number;
  /** 那一堆物品，工具带着损耗（ADR-0010）。 */
  readonly stack: ItemStack;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly age: number;
}

/** 一个经验球。速度只存速率：方向每 tick 重新对准玩家。 */
export interface XpOrbSnapshot {
  readonly id: number;
  readonly amount: number;
  readonly position: Vec3;
  readonly speed: number;
  readonly age: number;
}

/** 方块状态表里的一条：哪一格、状态的字段。目前只有熔炉一种。 */
export interface BlockStateRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly state: FurnaceStateRecord;
}

/** 熔炉状态去掉 `kind` 之后的字段（见 `FurnaceState`）。空格与还没炼过都是 null，理由见背包那一条。 */
export interface FurnaceStateRecord {
  readonly input: ItemStack | null;
  readonly fuel: ItemStack | null;
  readonly output: ItemStack | null;
  readonly burnTicksLeft: number;
  readonly burnTicksTotal: number;
  readonly smeltProgress: number;
  readonly progressItem: ItemType | null;
  readonly pendingExperience: number;
}

/** 一个已改区块：区块坐标与 96 KB 方块数组。 */
export interface ChunkRecord {
  readonly cx: number;
  readonly cz: number;
  readonly blocks: ChunkBlocks;
}
