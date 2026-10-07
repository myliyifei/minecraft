import { BlockType } from './block';
import type { Chunk } from './chunk';
import { CHUNK_SIZE } from './constants';
import { hashCoords } from './noise';
import type { Vec3 } from './vec3';

/**
 * 矿脉单元的边长（方块），三个方向都是。
 *
 * 上限 8：单元内落点每一维用 3 位哈希（见 `SLOT_X_SHIFT` 那几个位段），边长再大就有格子落不到。
 * 下限 4：等于矿脉水平伸展半径（`ORE_VEIN_RADIUS`）的两倍。矿脉水平最宽 5 格，相邻单元的两条矿脉
 * 仍可能挨在一起或共用几格；边长再小，相邻单元的矿脉大多会连在一起。
 * 两者之间只有 4 和 8 是 2 的幂，单元坐标因此能用位移算。
 */
export type OreCellSize = 4 | 8;

/**
 * 一种矿石的矿脉参数（见 GLOSSARY.md 的「矿脉」，issue #31、#47）。
 *
 * 高度区间说的是矿石方块，不是矿脉中心：中心再往上下各伸 `ORE_VEIN_RISE` 格，所以中心只在
 * 区间内缩一格的范围里取。
 */
export interface OreKindDef {
  /** 这种矿脉写进世界的方块。 */
  readonly block: BlockType;
  /** 矿石方块允许出现的最低 y（闭区间）。 */
  readonly minY: number;
  /** 矿石方块允许出现的最高 y（闭区间）。 */
  readonly maxY: number;
  /** 每条矿脉最少几块。 */
  readonly minCount: number;
  /** 每条矿脉最多几块。 */
  readonly maxCount: number;
  /**
   * 一个矿脉单元里有矿脉的概率，写成 8 位随机数的阈值（0–256）：随机数小于它这一单元就有。
   * 每区块平均条数 = 区块覆盖的有效单元数 × 阈值 ÷ 256，见 `ORE_KINDS` 各行的注释。
   */
  readonly chance: number;
  /**
   * 这种矿石的矿脉单元边长。世界按它切成立方格，一格最多一条矿脉：密度因此有上界，而一条矿脉
   * 只由自己那一格的哈希决定，每个区块能独立算出所有该写的矿脉，见 ADR-0005。
   */
  readonly cellSize: OreCellSize;
  /** 这种矿石分布用的种子偏移量：两种矿石各走一条互不相关的哈希流。 */
  readonly salt: number;
}

/** 一条矿脉：哪种矿石、中心在哪、包含哪些格。位置与形状全由种子决定，所以这几个数就足以描述它。 */
export interface OreVein {
  readonly block: BlockType;
  /** 中心那一格的世界坐标，也是 `cells` 的第一格。 */
  readonly center: Vec3;
  /** 矿脉的每一格（世界坐标），第一格是中心。写进区块时只替换石头。 */
  readonly cells: readonly Vec3[];
}

/** 矿脉离中心最远伸几格：水平（切比雪夫距离）。区块拉取邻近单元的范围按它定。 */
export const ORE_VEIN_RADIUS = 2;

/** 矿脉离中心最远伸几格：竖直。 */
export const ORE_VEIN_RISE = 1;

/**
 * 两种矿石的参数表——纯数据，数值来自 issue #31，铁的单元边长与阈值来自 issue #47。
 *
 * 平均条数的算法：中心可取的 y 是区间内缩一格，按单元竖直切开数有效单元（部分落在区间外的
 * 单元按落在区间内的比例算），乘一区块一层的单元数（边长 8 是 4 个，边长 4 是 16 个），再乘
 * 阈值 ÷ 256。
 * - 煤：中心 1–63，单元 y 0–63 共 8 个，第一个只有 7/8 有效，7.875 × 4 = 31.5 个有效单元，
 *   163/256 ≈ 0.637，平均约 20 条。
 * - 铁：边长 4，中心 −62–31，单元 y −64–31 共 24 个，第一个只有 2/4 有效，23.5 × 16 = 376 个，
 *   68/256 ≈ 0.266，平均约 100 条。
 *
 * 两种矿石各走一套单元（种子偏移量不同），一个单元里可以同时有煤脉与铁脉，重叠靠先后解决：
 * 先煤后铁，先写的那条留下（后写的只替换石头，见 `plantOreVeins`），表的顺序就是这个先后，
 * 任何区块算出来都一样。
 */
export const ORE_KINDS: readonly OreKindDef[] = Object.freeze([
  {
    block: BlockType.CoalOre,
    minY: 0,
    maxY: 64,
    minCount: 1,
    maxCount: 8,
    chance: 163,
    cellSize: 8,
    salt: 0x6c0a_1e5d,
  },
  {
    block: BlockType.IronOre,
    minY: -63,
    maxY: 32,
    minCount: 1,
    maxCount: 4,
    chance: 68,
    cellSize: 4,
    salt: 0x1207_9b3f,
  },
]);

/**
 * 一个单元的哈希切成几段互不重叠的位，各当一个独立的随机数用：单元内落点 x、y、z、块数、
 * 这一单元有没有矿脉。`hashCoords` 已经把输入的每一位搅到输出的所有位上，切位段比对同一单元
 * 算五次哈希便宜。
 */
const SLOT_X_SHIFT = 0;
const SLOT_Y_SHIFT = 3;
const SLOT_Z_SHIFT = 6;
const COUNT_SHIFT = 9;
const PRESENCE_SHIFT = 24;

/** 一段 8 位的随机数，取值 0–255。 */
const ROLL_MASK = 0xff;

/**
 * 把竖直那一维搅进单元哈希时用的种子偏移量。水平两维先用 `hashCoords` 搅在一起，再把结果当种子
 * 与 cellY 搅一次，这个数占的是第二次那个 z 参数的位置。
 */
const CELL_Y_SALT = 0x51ed_270a;

/**
 * 矿脉扩展用的种子偏移量：从单元哈希再派生一条流，决定每一步往哪个方向扩展。
 * 与单元哈希本身分开，否则第一步的方向与落点是同一段位，形状会跟着位置走。
 */
const GROWTH_SALT = 0x3a8f_51c9;

/**
 * 矿脉扩展时每加一格最多尝试几次。方框（5×3×5）远大于最大块数，试几次总能落进一个空格；
 * 上界只是让算法在任何输入下都能停下。
 */
const GROWTH_ATTEMPTS_PER_CELL = 8;

/** 面对面相邻的 6 个方向。矿脉只沿它们扩展，所以每一格都与前面某一格面对面挨着，连成一团而不是散开的几格。 */
const FACE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** 世界坐标所属的单元坐标。用位移算，负坐标也向下取整；位移量是边长以 2 为底的对数。 */
function cellOf(worldCoord: number, cellSize: OreCellSize): number {
  return worldCoord >> (31 - Math.clz32(cellSize));
}

/** 三维单元坐标的哈希：先把水平两维搅在一起，再搅进竖直那一维。 */
function hashCell(seed: number, cellX: number, cellY: number, cellZ: number): number {
  return hashCoords(hashCoords(seed, cellX, cellZ), cellY, CELL_Y_SALT);
}

/**
 * 由中心向外扩展成 `count` 格：每一步从已有的格里随机挑一格、随机挑一个面对面的方向，落点
 * 在方框（水平 ±ORE_VEIN_RADIUS、竖直 ±ORE_VEIN_RISE）内且还没占就加进来。
 *
 * 随机数从 `roll` 派生（`hashCoords(roll ^ GROWTH_SALT, step, 0)`），所以形状与位置一样只由
 * 种子与单元坐标决定。
 */
function growVein(roll: number, center: Vec3, count: number): Vec3[] {
  const cells: Vec3[] = [center];
  const taken = new Set<string>([`${center.x},${center.y},${center.z}`]);
  const growth = (roll ^ GROWTH_SALT) | 0;
  let step = 0;
  const maxSteps = count * GROWTH_ATTEMPTS_PER_CELL;
  while (cells.length < count && step < maxSteps) {
    const r = hashCoords(growth, step++, 0);
    const from = cells[r % cells.length]!;
    const [dx, dy, dz] = FACE_NEIGHBOURS[(r >>> 8) % FACE_NEIGHBOURS.length]!;
    const next = { x: from.x + dx, y: from.y + dy, z: from.z + dz };
    if (
      Math.abs(next.x - center.x) > ORE_VEIN_RADIUS ||
      Math.abs(next.z - center.z) > ORE_VEIN_RADIUS ||
      Math.abs(next.y - center.y) > ORE_VEIN_RISE
    ) {
      continue;
    }
    const key = `${next.x},${next.y},${next.z}`;
    if (taken.has(key)) continue;
    taken.add(key);
    cells.push(next);
  }
  return cells;
}

/**
 * 某种矿石在某个单元里的矿脉。这一单元没有矿脉，或中心落在高度区间之外，则 undefined。
 *
 * 只问种子与单元坐标，不问地形：矿脉写进哪个区块只替换石头，落在泥土、空气里的格子由
 * `plantOreVeins` 丢掉。
 */
function oreVeinInCell(
  seed: number,
  kind: OreKindDef,
  cellX: number,
  cellY: number,
  cellZ: number,
): OreVein | undefined {
  const roll = hashCell((seed ^ kind.salt) | 0, cellX, cellY, cellZ);
  if (((roll >>> PRESENCE_SHIFT) & ROLL_MASK) >= kind.chance) return undefined;

  // 单元内落点：边长是 2 的幂，减一就是掩码，只取每段位的低几位
  const size = kind.cellSize;
  const slotMask = size - 1;
  const x = cellX * size + ((roll >>> SLOT_X_SHIFT) & slotMask);
  const y = cellY * size + ((roll >>> SLOT_Y_SHIFT) & slotMask);
  const z = cellZ * size + ((roll >>> SLOT_Z_SHIFT) & slotMask);
  // 中心上下各伸 ORE_VEIN_RISE 格都得在区间里：区间说的是矿石方块，不是中心
  if (y - ORE_VEIN_RISE < kind.minY || y + ORE_VEIN_RISE > kind.maxY) return undefined;

  const span = kind.maxCount - kind.minCount + 1;
  const count = kind.minCount + (((roll >>> COUNT_SHIFT) & ROLL_MASK) % span);
  const center = { x, y, z };
  return { block: kind.block, center, cells: growVein(roll, center, count) };
}

/** 这条矿脉有没有格子可能落进以 (originX, originZ) 为角的那个区块。 */
function reachesChunk(vein: OreVein, originX: number, originZ: number): boolean {
  const reaches = (coord: number, origin: number): boolean =>
    coord + ORE_VEIN_RADIUS >= origin && coord - ORE_VEIN_RADIUS < origin + CHUNK_SIZE;
  return reaches(vein.center.x, originX) && reaches(vein.center.z, originZ);
}

/**
 * 会写进某个区块的全部矿脉，按写入顺序排好。
 *
 * 中心可能在邻近区块里：矿脉越过边界时两边的区块各写自己那一半，合起来才是完整的一条。所以扫的
 * 是「矿脉还能伸进这个区块」的那一圈单元（边界外 ORE_VEIN_RADIUS 格），而不只是区块自己覆盖
 * 的那几个。每个区块各算一遍、只写自己的格子，结果因此与加载顺序无关，见 ADR-0005。
 *
 * 竖直方向只扫中心可能落进去的那些单元：区间两端各缩 ORE_VEIN_RISE 格之外的单元里，中心一定
 * 会被 `oreVeinInCell` 拒掉，扫了也是白算。
 *
 * 顺序先按矿石种类（`ORE_KINDS` 的顺序），再按单元坐标从小到大，在任何区块里都一样——两条
 * 矿脉写同一格时谁留下因此是确定的。
 */
export function oreVeinsTouching(seed: number, cx: number, cz: number): OreVein[] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const veins: OreVein[] = [];
  for (const kind of ORE_KINDS) {
    const size = kind.cellSize;
    const firstCellX = cellOf(originX - ORE_VEIN_RADIUS, size);
    const lastCellX = cellOf(originX + CHUNK_SIZE - 1 + ORE_VEIN_RADIUS, size);
    const firstCellZ = cellOf(originZ - ORE_VEIN_RADIUS, size);
    const lastCellZ = cellOf(originZ + CHUNK_SIZE - 1 + ORE_VEIN_RADIUS, size);
    const lastCellY = cellOf(kind.maxY - ORE_VEIN_RISE, size);
    for (let cellY = cellOf(kind.minY + ORE_VEIN_RISE, size); cellY <= lastCellY; cellY++) {
      for (let cellZ = firstCellZ; cellZ <= lastCellZ; cellZ++) {
        for (let cellX = firstCellX; cellX <= lastCellX; cellX++) {
          const vein = oreVeinInCell(seed, kind, cellX, cellY, cellZ);
          if (vein && reachesChunk(vein, originX, originZ)) veins.push(vein);
        }
      }
    }
  }
  return veins;
}

/**
 * 把会写进这个区块的矿脉嵌进去：只替换石头，别的方块（泥土、空气、基岩、已经写好的另一种
 * 矿石）原样不动。
 *
 * 要在土石铺好之后、种树之前调：「只替换石头」得先有石头。落在区块外的格子 `Chunk.get`
 * 读到的是空气，自然跳过，那部分由邻居区块写。
 */
export function plantOreVeins(seed: number, chunk: Chunk): void {
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;
  for (const vein of oreVeinsTouching(seed, chunk.cx, chunk.cz)) {
    for (const { x, y, z } of vein.cells) {
      const lx = x - originX;
      const lz = z - originZ;
      if (chunk.get(lx, y, lz) !== BlockType.Stone) continue;
      chunk.set(lx, y, lz, vein.block);
    }
  }
}
