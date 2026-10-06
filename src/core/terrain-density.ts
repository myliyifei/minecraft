import { BlockType } from './block';
import { CHUNK_BLOCK_COUNT, type Chunk } from './chunk';
import { CHUNK_AREA, CHUNK_SIZE, SEA_LEVEL, WORLD_MIN_Y } from './constants';
import { fbm2, fbm3 } from './noise';

/**
 * 三维密度地形（ADR-0021）的密度场：群系参数、基准高度与稀疏格点上的三维密度。
 *
 * 一格是不是地形方块只看密度的正负：密度 = 基准高度 − y + 起伏幅度 × 三维噪声。基准高度与起伏幅度
 * 由三层低频二维噪声（大陆度、起伏、温度里的前两层）给出，三维噪声带来悬崖与悬垂。
 *
 * 密度只在稀疏格点上取（水平每 GRID_XZ 格、竖直每 GRID_Y 格），格点之间三线性插值。区块生成与单列的
 * 地表高度查询走同一个插值函数、同样的运算顺序，所以两边对同一格得出同一个浮点数，查询值与生成结果
 * 逐格一致。
 *
 * 密度为正的格里，不与地面相连的孤立连通块（悬空块，#86）不算地形方块：区块生成时写回空气，地表高度与单列
 * 实心段查询也当它不存在。判定规则见下文「悬空地形块」一节。
 */

/**
 * 群系参数噪声的特征跨度（格）：噪声输入是「世界坐标 / 跨度」。
 *
 * 三层噪声叠在一起决定群系，任何一层越过阈值群系都会变，所以每一层的跨度都要比「一片 300 到 600 格」
 * 大不少。数值是按大范围采样调的：连续一片同一群系的弦长中位数约 490 到 510 格。三层跨度取得互不成
 * 整数倍，各自的格点才不会对齐。
 */
const CONTINENTALNESS_SCALE = 820;
const RELIEF_SCALE = 590;
const TEMPERATURE_SCALE = 710;

/** 群系参数噪声的层数。两层够让边界不是光滑的椭圆；层数再多，交界处会来回跳动。 */
const CLIMATE_OCTAVES = 2;

/** 三层群系参数各自的种子偏移量：三条互不相关的哈希流。 */
const CONTINENTALNESS_SALT = 0x1b87_3593;
const RELIEF_SALT = 0x5c4d_c2a1;
const TEMPERATURE_SALT = 0x2e1f_7d63;

/** 大陆度低于它是大海。 */
export const OCEAN_CONTINENTALNESS = -0.12;

/** 陆地上起伏高于它是高山。 */
export const MOUNTAIN_RELIEF = 0.18;

/**
 * 温度低于它是寒冷处：陆地上的冰雪群系与海平面那层结冰用同一个阈值（CONTEXT.md「群系」「冰面」）。
 */
export const COLD_TEMPERATURE = -0.1;

/**
 * 三层群系参数（都在 [−1, 1]）各自单独求：群系按大陆度、起伏、温度依次判断，判出来就不必再求后面的层（`terrain.ts`）。
 * 大陆度低于 OCEAN_CONTINENTALNESS 是大海，越高离海越远；起伏高于 MOUNTAIN_RELIEF 的陆地是高山；温度低于
 * COLD_TEMPERATURE 是寒冷处。
 */
export function continentalnessAt(seed: number, x: number, z: number): number {
  return fbm2(seed ^ CONTINENTALNESS_SALT, x / CONTINENTALNESS_SCALE, z / CONTINENTALNESS_SCALE, CLIMATE_OCTAVES);
}

export function reliefAt(seed: number, x: number, z: number): number {
  return fbm2(seed ^ RELIEF_SALT, x / RELIEF_SCALE, z / RELIEF_SCALE, CLIMATE_OCTAVES);
}

export function temperatureAt(seed: number, x: number, z: number): number {
  return fbm2(seed ^ TEMPERATURE_SALT, x / TEMPERATURE_SCALE, z / TEMPERATURE_SCALE, CLIMATE_OCTAVES);
}

/**
 * 那一列海平面处是不是寒冷处：只看二维温度噪声，不含随地表高度下降的那一项。
 *
 * 海平面那层结冰与寒冷处大海群系露出水面的雪草方块用它（#87）：结冰看的是水面，水面总在海平面，
 * 不随岸上的地表高度变；含高度项后，内陆洼地湖岸边的山越高、湖面越容易结冰，与水面所在的高度无关。
 */
export function isColdAtSeaLevel(seed: number, x: number, z: number): boolean {
  return temperatureAt(seed, x, z) < COLD_TEMPERATURE;
}

/** 地表高于它的陆地列，温度按高出的格数下降（#87）。平原内部的普通起伏在它以下，温度不变。 */
export const TEMPERATURE_DROP_BASE_Y = 72;

/** 地表每高出 TEMPERATURE_DROP_BASE_Y 一格，温度下降这么多（#87）。 */
export const TEMPERATURE_DROP_PER_BLOCK = 0.006;

/**
 * 地表高度为 surfaceHeight 的陆地列，温度比二维温度噪声低多少（#87，CONTEXT.md「群系」）：
 * 基准高度以下为 0，以上每格 TEMPERATURE_DROP_PER_BLOCK。群系判断用「温度噪声 − 这一项」与 COLD_TEMPERATURE 比较。
 */
export function temperatureDropAt(surfaceHeight: number): number {
  return TEMPERATURE_DROP_PER_BLOCK * Math.max(0, surfaceHeight - TEMPERATURE_DROP_BASE_Y);
}

// ---------------------------------------------------------------------------
// 基准高度与起伏幅度
// ---------------------------------------------------------------------------

/** 海陆交界处（大陆度正好等于 OCEAN_CONTINENTALNESS）的基准高度：海平面之上一格。 */
const COAST_BASE_Y = SEA_LEVEL + 1;

/** 大海从岸边往外，大陆度再低这么多，海底降到最深。 */
const OCEAN_DEEPENING = 0.08;

/** 大海最深处的基准高度比岸边低几格。64 − 16 = y 48，叠上大海的三维噪声（幅度 3），最深处的海底在 y 45 到 51 之间。 */
const OCEAN_DEPTH = 16;

/** 陆地从岸边往里，大陆度再高这么多，平原抬到最高、高山长到最高。岸边因此是缓坡，不是陡坎。 */
const INLAND_RISE = 0.16;

/** 平原内陆比岸边高几格。 */
const PLAINS_LIFT = 4;

/** 起伏低于高山阈值这么多时山就开始长：高山群系的边上已经是丘陵，平原与高山之间因此是缓坡。 */
const MOUNTAIN_LEAD = 0.06;

/** 起伏从「山开始长」再高这么多，山长到最高。 */
const MOUNTAIN_RISE = 0.36;

/**
 * 高山最高处的基准高度比平原高几格：68 + 100 = y 168。三维噪声很少同时取到 +1，大范围采样里最高的地表
 * 约 y 183 到 192（CONTEXT.md「群系」：高山最高约到 y 200）。
 */
const MOUNTAIN_HEIGHT = 100;

/**
 * 三维噪声的起伏幅度（格）：大海、平原、高山最高处。高山的幅度要比竖直跨度大数倍，密度沿 y 才会多次变号，
 * 悬崖与悬垂才出得来：取 48 时高山里约 2% 到 11% 的列有悬垂（随种子），取 30 时不到 1%。
 */
const OCEAN_AMPLITUDE = 3;
const PLAINS_AMPLITUDE = 5;
const MOUNTAIN_AMPLITUDE = 48;

/**
 * 地形方块的最高高度：再往上一律是空气。基准高度加幅度的理论上界是 y 216，实际几乎取不到，
 * 这条只截掉极少的山尖，保证地表不超过 y 210。
 */
export const MAX_TERRAIN_Y = 208;

/** Hermite 缓和曲线，t 先夹到 [0, 1]。基准高度在群系参数上逐段过渡，各段之间一阶导数连续。 */
function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** 一列的基准高度与起伏幅度。 */
interface ColumnShape {
  readonly base: number;
  readonly amplitude: number;
}

function columnShape(seed: number, x: number, z: number): ColumnShape {
  const c = continentalnessAt(seed, x, z);
  const r = reliefAt(seed, x, z);
  const inland = smoothstep((c - OCEAN_CONTINENTALNESS) / INLAND_RISE);
  const offshore = smoothstep((OCEAN_CONTINENTALNESS - c) / OCEAN_DEEPENING);
  const mountain = inland * smoothstep((r - (MOUNTAIN_RELIEF - MOUNTAIN_LEAD)) / MOUNTAIN_RISE);
  const base = COAST_BASE_Y + inland * PLAINS_LIFT - offshore * OCEAN_DEPTH + mountain * MOUNTAIN_HEIGHT;
  const landAmplitude = PLAINS_AMPLITUDE + mountain * (MOUNTAIN_AMPLITUDE - PLAINS_AMPLITUDE);
  const amplitude = OCEAN_AMPLITUDE + inland * (landAmplitude - OCEAN_AMPLITUDE);
  return { base, amplitude };
}

// ---------------------------------------------------------------------------
// 稀疏格点与插值
// ---------------------------------------------------------------------------

/** 格点的水平间距与竖直间距（格），与原版相同。都是 2 的幂，格点坐标用位移算。 */
const GRID_XZ = 4;
const GRID_Y = 8;
const GRID_XZ_SHIFT = 2;
const GRID_Y_SHIFT = 3;

/** 一个区块水平方向的格点数（含另一侧边上那一排）。 */
const CHUNK_GRID = CHUNK_SIZE / GRID_XZ + 1;

/**
 * 三维噪声的特征跨度（格）。水平跨度比竖直大：山体在水平方向延伸得更远，竖直跨度小，密度沿 y 才会多次变号，
 * 出现悬垂。都取不是格点间距整数倍的数，噪声的整数格点（那里恒为 0）才不会与密度格点对齐。
 */
const NOISE_SCALE_XZ = 37;
const NOISE_SCALE_Y = 17;

/** 三维噪声的层数。 */
const NOISE_OCTAVES = 2;

/** 三维噪声的种子偏移量。 */
const DENSITY_SALT = 0x7f4a_7c15;

/**
 * 一根格点竖列：某个格点列 (gx, gz) 的形状，与按需算好的各格点密度。
 *
 * 密度 = 基准高度 − y + 幅度 × 噪声，噪声在 [−1, 1]，所以 y < 基准高度 − 幅度 的格点一定为正、
 * y > 基准高度 + 幅度 的一定为负。一个插值单元的 8 个格点都能这样判定时整格同号，不必算噪声；
 * 只有判不定的单元才算，算出来按格点行缓存。判定只是跳过计算，不改变数值：算出来的密度在判定为
 * 正的地方本来就为正，所以跳不跳过都得到同一个结果。
 */
class GridColumn {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly amplitude: number;
  /** 这根竖列上「一定为正」的最高格点 y 之上一格：y 小于它的格点一定为正。 */
  readonly solidBelow: number;
  /** y 大于它的格点一定为负。 */
  readonly airAbove: number;
  private readonly values = new Map<number, number>();
  private readonly seed: number;

  constructor(seed: number, gx: number, gz: number) {
    this.seed = seed;
    this.x = gx * GRID_XZ;
    this.z = gz * GRID_XZ;
    const { base, amplitude } = columnShape(seed, this.x, this.z);
    this.base = base;
    this.amplitude = amplitude;
    this.solidBelow = base - amplitude;
    this.airAbove = base + amplitude;
  }

  /** 第 gy 行格点（y = gy × GRID_Y）的密度。 */
  densityAt(gy: number): number {
    const cached = this.values.get(gy);
    if (cached !== undefined) return cached;
    const y = gy * GRID_Y;
    const noise = fbm3(
      this.seed ^ DENSITY_SALT,
      this.x / NOISE_SCALE_XZ,
      y / NOISE_SCALE_Y,
      this.z / NOISE_SCALE_XZ,
      NOISE_OCTAVES,
    );
    const value = this.base - y + this.amplitude * noise;
    this.values.set(gy, value);
    return value;
  }
}

/** 一列的四根角上格点竖列与列在单元里的水平位置。 */
interface ColumnCorners {
  readonly c00: GridColumn;
  readonly c10: GridColumn;
  readonly c01: GridColumn;
  readonly c11: GridColumn;
  /** 列在单元里的水平位置，[0, 1)。 */
  readonly fx: number;
  readonly fz: number;
  /** 四根竖列里 solidBelow 的最小值：y 低于它的格点四根都为正。 */
  readonly solidBelow: number;
  /** 四根竖列里 airAbove 的最大值：y 高于它的格点四根都为负。 */
  readonly airAbove: number;
}

function cornersOf(
  c00: GridColumn,
  c10: GridColumn,
  c01: GridColumn,
  c11: GridColumn,
  fx: number,
  fz: number,
): ColumnCorners {
  return {
    c00,
    c10,
    c01,
    c11,
    fx,
    fz,
    solidBelow: Math.min(c00.solidBelow, c10.solidBelow, c01.solidBelow, c11.solidBelow),
    airAbove: Math.max(c00.airAbove, c10.airAbove, c01.airAbove, c11.airAbove),
  };
}

/** 一列在第 gy 行格点高度上的密度：四根角上竖列的同行格点按水平位置双线性插值。 */
function rowDensity(corners: ColumnCorners, gy: number): number {
  const { c00, c10, c01, c11, fx, fz } = corners;
  const d0 = c00.densityAt(gy) + fx * (c10.densityAt(gy) - c00.densityAt(gy));
  const d1 = c01.densityAt(gy) + fx * (c11.densityAt(gy) - c01.densityAt(gy));
  return d0 + fz * (d1 - d0);
}

/**
 * 一列从上往下逐格判断是不是地形方块（密度大于 0），对每一格调一次 visit，自 top 到 bottom。
 *
 * 区块生成与地表高度查询都走这里：同一列得到同一串结果。visit 返回 false 时提前停下。
 * top 之上、bottom 之下的格不回调，调用方按 `solidBelow` 与 `MAX_TERRAIN_Y` 自己判定。
 */
function scanColumn(
  corners: ColumnCorners,
  top: number,
  bottom: number,
  visit: (y: number, solid: boolean) => boolean,
): void {
  let rowGy = Number.NaN;
  let lower = 0;
  let upper = 0;
  for (let y = top; y >= bottom; y--) {
    let solid: boolean;
    if (y > MAX_TERRAIN_Y) {
      solid = false;
    } else {
      const gy = y >> GRID_Y_SHIFT;
      const yLow = gy * GRID_Y;
      const yHigh = yLow + GRID_Y;
      if (yHigh < corners.solidBelow) {
        solid = true;
      } else if (yLow > corners.airAbove) {
        solid = false;
      } else {
        if (gy !== rowGy) {
          rowGy = gy;
          lower = rowDensity(corners, gy);
          upper = rowDensity(corners, gy + 1);
        }
        const fy = (y - yLow) / GRID_Y;
        solid = lower + fy * (upper - lower) > 0;
      }
    }
    if (!visit(y, solid)) return;
  }
}

/** 一列可能出现地形方块的最高 y。 */
function topOf(corners: ColumnCorners): number {
  return Math.min(MAX_TERRAIN_Y, Math.ceil(corners.airAbove) + GRID_Y);
}

/** 一列一定是地形方块的最高 y 再往下一格起算：这一格及以下整段实心。 */
function solidTopOf(corners: ColumnCorners): number {
  return (Math.floor(corners.solidBelow) >> GRID_Y_SHIFT) * GRID_Y - 1;
}

/** 世界坐标所在单元的格点坐标与单元内位置。 */
function gridCell(coord: number): { g: number; f: number } {
  const g = coord >> GRID_XZ_SHIFT;
  return { g, f: (coord - g * GRID_XZ) / GRID_XZ };
}

// ---------------------------------------------------------------------------
// 悬空地形块（#86）
// ---------------------------------------------------------------------------

/**
 * 悬空地形块：密度为正、但与地面不相连（6 邻接）的连通块，生成时去掉，查询也当它不存在。
 *
 * 判定只看连通块本身，与从哪个区块、按什么顺序看无关，所以跨区块确定、区块内外一致（ADR-0005 的拉取思路）：
 * - 一列从最底层往上连续实心的那一段与地面竖直相连（「着地」）；之上的地形方块是「悬着的」（悬垂或悬空块）。
 * - 悬着的格按 6 邻接连成块。块里有一格挨着着地的格，它就与山体相连（悬垂），保留。
 * - 不挨着任何着地的格、且水平外接矩形不超过 FLOATING_MAX_EXTENT 格的块是悬空块，去掉。
 *   外接矩形更大的块不再往外找，一律保留：上限给搜索定了边界。改前十个种子各取 5 个山顶与 5 处随机高山的
 *   10×10 区块合并体，共找到 111 块悬空块，水平外接矩形最大 29 格；取 48 留出余量。
 */
const FLOATING_MAX_EXTENT = 48;

/**
 * 密度场缓存的上限（格点竖列数、扫过的列数）。超过时在下一次查询或生成开始前整个清空：
 * 缓存只省计算，清不清空结果都一样。
 */
const GRID_CACHE_LIMIT = 4096;
const COLUMN_CACHE_LIMIT = 8192;

/** 悬着的格搜过之后的结论：没搜过、保留、悬空块。 */
const UNKNOWN = 0;
const ATTACHED = 1;
const DETACHED = 2;

/** 一列按密度扫过的结果：solidTop 及以下整段实心，top 之上全是空气，bits 记 solidTop 到 top 每一格是不是实心。 */
class ColumnSolids {
  /** 悬着的格的结论（下标同 bits），第一次搜到这一列时才建。 */
  verdicts: Uint8Array | undefined;
  /** 每一格最近一次被哪一次搜索访问过（下标同 bits），第一次搜到这一列时才建。 */
  visits: Uint32Array | undefined;

  constructor(
    readonly solidTop: number,
    readonly top: number,
    /** 着地的最高一格：这一格及以下都是实心且与地面竖直相连。 */
    readonly groundedTop: number,
    readonly bits: Uint8Array,
  ) {}
}

const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 2 * KEY_OFFSET;

function columnKey(x: number, z: number): number {
  return (x + KEY_OFFSET) * KEY_SPAN + (z + KEY_OFFSET);
}

// ---------------------------------------------------------------------------
// 对外：密度场（单列地表高度、单列实心段、区块的实心与空气）
// ---------------------------------------------------------------------------

/** 地表高度窗口的边长：区块本身加四周各一列（铺地表判陡坡要看东南西北四个相邻列）。 */
export const HEIGHT_WINDOW = CHUNK_SIZE + 2;

/**
 * 区块里每一列（下标 `lz * CHUNK_SIZE + lx`）按密度扫描过的范围，与区块连同四周一圈列的地表高度。
 * `top` 之上一定是空气；`solidTop` 及以下整段是石头，从上往下扫到这里为止就不会再遇到露天的顶面。
 * `heights` 的下标是 `(lz + 1) * HEIGHT_WINDOW + (lx + 1)`，lx、lz 从 −1 到 CHUNK_SIZE；四个角上的列不求，
 * 留 `WORLD_MIN_Y`。值与 `DensityField.surfaceHeight` 逐列相同。
 */
export interface DensityExtent {
  readonly tops: Int16Array;
  readonly solidTops: Int16Array;
  readonly heights: Int16Array;
}

/**
 * 一个种子的密度场。地形方块 = 密度为正、且不属于悬空块的格；三个方法对同一格得出同一个结论。
 *
 * 内部缓存格点竖列、扫过的列与悬空块判定的结果，都有上限（见 GRID_CACHE_LIMIT），只省计算、不影响结果：
 * 同一个种子的两个密度场、先后顺序不同，得到的都一样。
 */
export interface DensityField {
  /**
   * 一列最高的地形方块的 y。铺地表只替换地形方块的种类（石头换成草方块、泥土、沙子等）、嵌矿脉只替换石头，
   * 都不改哪一格是地形方块，所以这就是铺好地表之后那一列的地表高度。
   */
  surfaceHeight(x: number, z: number): number;
  /**
   * 一列从 fromY 到 toY（含两端）是不是全是地形方块。水塘判断盆地边缘要用：地表高度只说明最高的地形方块在哪，
   * 悬垂下方可能是空气，相邻的水就会直接挨着空气。
   */
  solidSpan(x: number, z: number, fromY: number, toY: number): boolean;
  /** 把区块里的地形方块写成石头，其余保持空气；最底层不动（调用方写基岩）。 */
  fill(chunk: Chunk): DensityExtent;
}

/**
 * 跨区块搜索编号的上限。列上的访问表是 Uint32Array，编号再大就存不下：存进去的值与编号不相等，
 * 搜索认不出这次已经访问过的格，会一直重复访问。编号到上限时清空扫过的列（连同访问表与结论）、从 1 重新计数。
 */
const SEARCH_ID_LIMIT = 0xffff_ffff;

/**
 * `lastSearchId` 只给测试用：从接近 SEARCH_ID_LIMIT 的编号开始，少量搜索就能走到重新计数的那条路径。
 */
export function createDensityField(seed: number, lastSearchId = 0): DensityField {
  return new Field(seed, lastSearchId);
}

/**
 * 区块里悬着的格的标记：不悬着、还没标、保留（与地面相连）、悬空块。标记表的下标与区块方块数组相同
 * （`blockIndex`），由 `cellIndex` 从高度与列下标算出。
 */
const HANGING = 1;
const KEPT = 2;
const FLOATING = 3;

/** 区块边长与一层格数以 2 为底的对数：下面几个换算函数用位运算。 */
const SIZE_BITS = Math.log2(CHUNK_SIZE);
const AREA_BITS = 2 * SIZE_BITS;

/**
 * 区块里一格的下标，与区块方块数组相同（`blockIndex`）。column 是列下标 `lz * CHUNK_SIZE + lx`。
 * 下面几个函数在下标、高度、列下标、局部坐标之间换算。
 */
function cellIndex(y: number, column: number): number {
  return ((y - WORLD_MIN_Y) << AREA_BITS) | column;
}

function cellY(cell: number): number {
  return (cell >> AREA_BITS) + WORLD_MIN_Y;
}

function cellColumn(cell: number): number {
  return cell & (CHUNK_AREA - 1);
}

function columnX(column: number): number {
  return column & (CHUNK_SIZE - 1);
}

function columnZ(column: number): number {
  return column >> SIZE_BITS;
}

/** 列下标在地表高度窗口 `heights` 里的下标（窗口四周多一圈）。 */
function heightIndex(column: number): number {
  return (columnZ(column) + 1) * HEIGHT_WINDOW + columnX(column) + 1;
}

/** 一格悬着的格搜过的结论。 */
function verdictOf(col: ColumnSolids, y: number): number {
  return col.verdicts === undefined ? UNKNOWN : col.verdicts[y - col.solidTop]!;
}

/** 记下这一格被第 id 次搜索访问过；这一列第一次被搜到时建结论表与访问表。 */
function markVisit(col: ColumnSolids, y: number, id: number): void {
  if (col.visits === undefined) {
    col.visits = new Uint32Array(col.bits.length);
    col.verdicts = new Uint8Array(col.bits.length);
  }
  col.visits[y - col.solidTop] = id;
}

class Field implements DensityField {
  private readonly grids = new Map<number, GridColumn>();
  private readonly columns = new Map<number, ColumnSolids>();

  /** 搜索的编号：每次搜索加一，列上记的编号等于它就是这次搜过的格。 */
  private searchId: number;
  /** 跨区块搜索用的栈（x、y、z 依次排）与访问过的格（列、y 依次排），搜索之间复用。 */
  private readonly stack: number[] = [];
  private readonly visited: Array<ColumnSolids | number> = [];

  /** 区块里悬着的格的标记表（下标同区块方块数组），每次生成区块后把用过的那一段清零。 */
  private readonly marks = new Uint8Array(CHUNK_BLOCK_COUNT);
  /** 区块内连通标记用的栈与连通块格表，按需加长，区块之间复用。 */
  private cellStack = new Int32Array(1024);
  private component = new Int32Array(1024);

  constructor(
    private readonly seed: number,
    lastSearchId: number,
  ) {
    this.searchId = lastSearchId;
  }

  /** 缓存超过上限就整个清空。只在对外方法开头调，搜索中途不清（搜索编号用完时另见 `isFloating`）。 */
  private trim(): void {
    if (this.grids.size > GRID_CACHE_LIMIT) this.grids.clear();
    if (this.columns.size > COLUMN_CACHE_LIMIT) this.columns.clear();
  }

  private grid(gx: number, gz: number): GridColumn {
    const key = columnKey(gx, gz);
    let g = this.grids.get(key);
    if (!g) {
      g = new GridColumn(this.seed, gx, gz);
      this.grids.set(key, g);
    }
    return g;
  }

  private cornersAt(x: number, z: number): ColumnCorners {
    const { g: gx, f: fx } = gridCell(x);
    const { g: gz, f: fz } = gridCell(z);
    return cornersOf(
      this.grid(gx, gz),
      this.grid(gx + 1, gz),
      this.grid(gx, gz + 1),
      this.grid(gx + 1, gz + 1),
      fx,
      fz,
    );
  }

  /** 一列从 top 扫到 solidTop，记下每一格是不是实心与着地的最高一格。 */
  private column(x: number, z: number): ColumnSolids {
    const key = columnKey(x, z);
    let col = this.columns.get(key);
    if (col) return col;
    const corners = this.cornersAt(x, z);
    const solidTop = Math.max(WORLD_MIN_Y, solidTopOf(corners));
    const top = Math.max(solidTop, topOf(corners));
    const bits = new Uint8Array(top - solidTop + 1);
    bits[0] = 1;
    let lowestAir = top + 1;
    scanColumn(corners, top, solidTop + 1, (y, solid) => {
      if (solid) bits[y - solidTop] = 1;
      else lowestAir = y;
      return true;
    });
    col = new ColumnSolids(solidTop, top, lowestAir - 1, bits);
    this.columns.set(key, col);
    return col;
  }

  /**
   * (x, y, z) 这一格悬着的地形方块是不是悬空块里的。调用方保证这一格实心、且高于那一列着地的最高一格。
   * 从这一格起深度优先搜悬着的格：挨着着地的格或外接矩形超出上限就停下、保留；搜完整块都没有才是悬空块。
   * 结论只取决于这一格所在的连通块，所以从块里哪一格搜起都一样，搜过的格都记下。
   */
  private isFloating(x: number, y: number, z: number): boolean {
    let startColumn = this.column(x, z);
    const known = verdictOf(startColumn, y);
    if (known !== UNKNOWN) return known === DETACHED;
    if (this.searchId >= SEARCH_ID_LIMIT) {
      // 编号用完：清空扫过的列（访问表与结论随列一起丢掉），从 1 重新计数。调用方手上的列对象仍然有效，
      // 它们的实心与着地信息不变，只是之后的搜索不再往它们上面记编号与结论。
      this.columns.clear();
      this.searchId = 0;
      startColumn = this.column(x, z);
    }
    const id = ++this.searchId;
    const stack = this.stack;
    const visited = this.visited;
    stack.length = 0;
    visited.length = 0;
    markVisit(startColumn, y, id);
    stack.push(x, y, z);
    visited.push(startColumn, y);
    let minX = x;
    let maxX = x;
    let minZ = z;
    let maxZ = z;
    let verdict = DETACHED;
    search: while (stack.length > 0) {
      const cz = stack.pop() as number;
      const cy = stack.pop() as number;
      const cx = stack.pop() as number;
      const here = this.column(cx, cz);
      // 依次看下方、东西南北、上方。下方那一格不会着地（悬着的格正下方是空气或另一格悬着的格），只可能是悬着的格。
      for (let n = 0; n < 6; n++) {
        const nx = n === 1 ? cx + 1 : n === 2 ? cx - 1 : cx;
        const nz = n === 3 ? cz + 1 : n === 4 ? cz - 1 : cz;
        const ny = n === 0 ? cy - 1 : n === 5 ? cy + 1 : cy;
        const col = n === 0 || n === 5 ? here : this.column(nx, nz);
        if (ny <= col.groundedTop) {
          verdict = ATTACHED;
          break search;
        }
        if (ny > col.top || col.bits[ny - col.solidTop] !== 1) continue;
        if (col.visits !== undefined && col.visits[ny - col.solidTop] === id) continue;
        const seen = verdictOf(col, ny);
        if (seen !== UNKNOWN) {
          verdict = seen;
          break search;
        }
        markVisit(col, ny, id);
        visited.push(col, ny);
        if (nx < minX) minX = nx;
        if (nx > maxX) maxX = nx;
        if (nz < minZ) minZ = nz;
        if (nz > maxZ) maxZ = nz;
        if (maxX - minX + 1 > FLOATING_MAX_EXTENT || maxZ - minZ + 1 > FLOATING_MAX_EXTENT) {
          verdict = ATTACHED;
          break search;
        }
        stack.push(nx, ny, nz);
      }
    }
    for (let i = 0; i < visited.length; i += 2) {
      const col = visited[i] as ColumnSolids;
      col.verdicts![(visited[i + 1] as number) - col.solidTop] = verdict;
    }
    return verdict === DETACHED;
  }

  surfaceHeight(x: number, z: number): number {
    this.trim();
    return this.surface(x, z);
  }

  /** 一列自上而下第一格「实心且不属于悬空块」的 y；悬着的格都是悬空块时是着地的最高一格。 */
  private surface(x: number, z: number): number {
    const col = this.column(x, z);
    for (let y = col.top; y > col.groundedTop; y--) {
      if (col.bits[y - col.solidTop] === 1 && !this.isFloating(x, y, z)) return y;
    }
    return col.groundedTop;
  }

  solidSpan(x: number, z: number, fromY: number, toY: number): boolean {
    this.trim();
    const col = this.column(x, z);
    for (let y = toY; y >= fromY; y--) {
      if (y <= col.groundedTop) return true;
      if (y > col.top || col.bits[y - col.solidTop] !== 1 || this.isFloating(x, y, z)) return false;
    }
    return true;
  }

  /**
   * 同时求出区块四周那一圈 64 列的地表高度：格点多取一圈（区块本身的 5×5 根之外再加四条边上各 5 根），
   * 与区块共用边上那一排格点的缓存。
   *
   * 悬空块先在区块里按悬着的格做一次连通标记（`markFloating`）：挨着着地的格的块保留；碰不到区块边、也不挨着
   * 着地的格的块整块在区块里，外接矩形不超过 16 格，是悬空块；碰到区块边的块才往区块外搜（`isFloating`）。
   */
  fill(chunk: Chunk): DensityExtent {
    this.trim();
    const blocks = chunk.blocks;
    const originX = chunk.cx * CHUNK_SIZE;
    const originZ = chunk.cz * CHUNK_SIZE;
    const gx0 = originX >> GRID_XZ_SHIFT;
    const gz0 = originZ >> GRID_XZ_SHIFT;
    // 格点下标 k、i 从 −1 到 CHUNK_GRID：四周多一圈，四个角上那 4 根用不到，不取。
    const span = CHUNK_GRID + 2;
    const grid: Array<GridColumn | undefined> = new Array<GridColumn | undefined>(span * span);
    for (let i = -1; i <= CHUNK_GRID; i++) {
      for (let k = -1; k <= CHUNK_GRID; k++) {
        const corner = (i === -1 || i === CHUNK_GRID) && (k === -1 || k === CHUNK_GRID);
        if (!corner) grid[(i + 1) * span + (k + 1)] = this.grid(gx0 + k, gz0 + i);
      }
    }
    const at = (k: number, i: number): GridColumn => grid[(i + 1) * span + (k + 1)]!;
    const cornersAt = (lx: number, lz: number): ColumnCorners => {
      const k = lx >> GRID_XZ_SHIFT;
      const i = lz >> GRID_XZ_SHIFT;
      const fx = (lx - k * GRID_XZ) / GRID_XZ;
      const fz = (lz - i * GRID_XZ) / GRID_XZ;
      return cornersOf(at(k, i), at(k + 1, i), at(k, i + 1), at(k + 1, i + 1), fx, fz);
    };

    const tops = new Int16Array(CHUNK_AREA);
    const solidTops = new Int16Array(CHUNK_AREA);
    const groundedTops = new Int16Array(CHUNK_AREA);
    const heights = new Int16Array(HEIGHT_WINDOW * HEIGHT_WINDOW).fill(WORLD_MIN_Y);
    let hanging = false;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const corners = cornersAt(lx, lz);
        const solidTop = Math.max(WORLD_MIN_Y, solidTopOf(corners));
        const top = Math.max(solidTop, topOf(corners));
        const column = lz * CHUNK_SIZE + lx;
        chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, solidTop, BlockType.Stone);
        // 扫到的第一格地形方块就是地表高度；整段都没有时是 solidTop（它及以下整段实心）。
        let surface = solidTop;
        let found = false;
        let lowestAir = top + 1;
        scanColumn(corners, top, solidTop + 1, (y, solid) => {
          if (solid) {
            blocks[cellIndex(y, column)] = BlockType.Stone;
            if (!found) {
              surface = y;
              found = true;
            }
          } else {
            lowestAir = y;
          }
          return true;
        });
        tops[column] = top;
        solidTops[column] = solidTop;
        groundedTops[column] = lowestAir - 1;
        if (surface > lowestAir) hanging = true;
        heights[heightIndex(column)] = surface;
      }
    }
    const marks = this.marks;
    const used = hanging ? this.markFloating(chunk, groundedTops, heights) : undefined;

    // 四周那一圈列：只求地表高度，不写区块。从扫到的第一格往下，连续实心的一段若挨着区块边上那一列着地的格
    // 或保留的悬垂格，它就与地面相连；否则按悬空块判定求。
    for (let n = 0; n < CHUNK_SIZE; n++) {
      for (const [lx, lz, ix, iz] of [
        [-1, n, 0, n],
        [CHUNK_SIZE, n, CHUNK_SIZE - 1, n],
        [n, -1, n, 0],
        [n, CHUNK_SIZE, n, CHUNK_SIZE - 1],
      ] as const) {
        const corners = cornersAt(lx, lz);
        const inner = iz * CHUNK_SIZE + ix;
        const innerGrounded = groundedTops[inner]!;
        let surface = WORLD_MIN_Y;
        let attached = false;
        scanColumn(corners, topOf(corners), WORLD_MIN_Y + 1, (y, solid) => {
          if (surface === WORLD_MIN_Y) {
            if (!solid) return true;
            surface = y;
          } else if (!solid) {
            return false;
          }
          attached = y <= innerGrounded || (used !== undefined && marks[cellIndex(y, inner)] === KEPT);
          return !attached;
        });
        heights[(lz + 1) * HEIGHT_WINDOW + (lx + 1)] =
          attached || surface === WORLD_MIN_Y ? surface : this.surface(originX + lx, originZ + lz);
      }
    }
    if (used !== undefined) marks.fill(0, used.from, used.to);
    return { tops, solidTops, heights };
  }

  /**
   * 区块里悬着的格按 6 邻接做连通标记，悬空块写回空气，区块里各列的地表高度改成去掉悬空块之后的值。
   * 标记留在 `marks` 里，四周那一圈列求地表高度时要看边上那一列的格是不是保留的悬垂；返回用过的下标范围
   * [from, to)，调用方用完清零。
   */
  private markFloating(
    chunk: Chunk,
    groundedTops: Int16Array,
    heights: Int16Array,
  ): { readonly from: number; readonly to: number } {
    const blocks = chunk.blocks;
    const cells = this.marks;
    // 悬着的格所在的高度范围：每一列在着地的最高一格之上、地表高度及以下。
    let low = MAX_TERRAIN_Y;
    let high = WORLD_MIN_Y;
    let count = 0;
    for (let column = 0; column < CHUNK_AREA; column++) {
      const surface = heights[heightIndex(column)]!;
      const groundedTop = groundedTops[column]!;
      if (surface <= groundedTop) continue;
      if (groundedTop + 1 < low) low = groundedTop + 1;
      if (surface > high) high = surface;
      for (let y = surface; y > groundedTop; y--) {
        const cell = cellIndex(y, column);
        if (blocks[cell] !== BlockType.Stone) continue;
        cells[cell] = HANGING;
        count++;
      }
    }
    const from = cellIndex(low, 0);
    const to = cellIndex(high + 1, 0);
    if (this.cellStack.length < count) {
      this.cellStack = new Int32Array(count);
      this.component = new Int32Array(count);
    }
    const stack = this.cellStack;
    const component = this.component;
    for (let start = from; start < to; start++) {
      if (cells[start] !== HANGING) continue;
      let sp = 0;
      let size = 0;
      stack[sp++] = start;
      cells[start] = KEPT;
      let grounded = false;
      let edge = false;
      while (sp > 0) {
        const cell = stack[--sp]!;
        component[size++] = cell;
        const column = cellColumn(cell);
        const lx = columnX(column);
        const lz = columnZ(column);
        const y = cellY(cell);
        if (lx === 0 || lz === 0 || lx === CHUNK_SIZE - 1 || lz === CHUNK_SIZE - 1) edge = true;
        // 上下两格在同一列，不会着地（悬着的格正下方是空气或另一格悬着的格）；东西南北的格可能着地。
        // 标记表在 low 之下、high 之上都是 0，不必另判边界。
        if (cells[cell - CHUNK_AREA] === HANGING) {
          cells[cell - CHUNK_AREA] = KEPT;
          stack[sp++] = cell - CHUNK_AREA;
        }
        if (cells[cell + CHUNK_AREA] === HANGING) {
          cells[cell + CHUNK_AREA] = KEPT;
          stack[sp++] = cell + CHUNK_AREA;
        }
        for (let n = 0; n < 4; n++) {
          let next: number;
          if (n === 0) {
            if (lx === CHUNK_SIZE - 1) continue;
            next = cell + 1;
          } else if (n === 1) {
            if (lx === 0) continue;
            next = cell - 1;
          } else if (n === 2) {
            if (lz === CHUNK_SIZE - 1) continue;
            next = cell + CHUNK_SIZE;
          } else {
            if (lz === 0) continue;
            next = cell - CHUNK_SIZE;
          }
          if (y <= groundedTops[cellColumn(next)]!) grounded = true;
          else if (cells[next] === HANGING) {
            cells[next] = KEPT;
            stack[sp++] = next;
          }
        }
      }
      if (grounded) continue;
      const first = component[0]!;
      const firstColumn = cellColumn(first);
      const floating =
        !edge ||
        this.isFloating(
          chunk.cx * CHUNK_SIZE + columnX(firstColumn),
          cellY(first),
          chunk.cz * CHUNK_SIZE + columnZ(firstColumn),
        );
      if (!floating) continue;
      for (let c = 0; c < size; c++) {
        const cell = component[c]!;
        cells[cell] = FLOATING;
        blocks[cell] = BlockType.Air;
      }
    }
    // 区块里各列的地表高度：最高的格若是悬空块，往下找第一格保留的悬着的格，都没有就是着地的最高一格。
    for (let column = 0; column < CHUNK_AREA; column++) {
      const index = heightIndex(column);
      const groundedTop = groundedTops[column]!;
      let y = heights[index]!;
      while (y > groundedTop && cells[cellIndex(y, column)] !== KEPT) y--;
      heights[index] = y;
    }
    return { from, to };
  }
}
