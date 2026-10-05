import { BlockType } from './block';
import type { Chunk } from './chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MIN_Y } from './constants';
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

/** 那一列是不是寒冷处。 */
export function isColdAt(seed: number, x: number, z: number): boolean {
  return temperatureAt(seed, x, z) < COLD_TEMPERATURE;
}

// ---------------------------------------------------------------------------
// 基准高度与起伏幅度
// ---------------------------------------------------------------------------

/** 海陆交界处（大陆度正好等于 OCEAN_CONTINENTALNESS）的基准高度：海平面之上一格。 */
const COAST_BASE_Y = SEA_LEVEL + 1;

/** 大海从岸边往外，大陆度再低这么多，海底降到最深。 */
const OCEAN_DEEPENING = 0.08;

/** 大海最深处的基准高度比岸边低几格。64 − 16 = y 48，叠上起伏落在 y 40 到 55 里。 */
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
 * 三维噪声的起伏幅度（格）：大海、平原、高山最高处。高山的幅度要比竖直跨度大好几倍，密度沿 y 才会多次变号，
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
 * 三维噪声的特征跨度（格）。水平跨度比竖直大：山体是横向铺开的，竖直跨度小，密度沿 y 才会多次变号，
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

// ---------------------------------------------------------------------------
// 对外：单列地表高度、区块的实心与空气
// ---------------------------------------------------------------------------

/** 世界坐标所在单元的格点坐标与单元内位置。 */
function gridCell(coord: number): { g: number; f: number } {
  const g = coord >> GRID_XZ_SHIFT;
  return { g, f: (coord - g * GRID_XZ) / GRID_XZ };
}

/** 一列最高的地形方块的 y：自上而下扫到第一格地形方块。单列查询与区块边外那一圈列都走这里。 */
function surfaceOf(corners: ColumnCorners): number {
  let surface = WORLD_MIN_Y;
  scanColumn(corners, topOf(corners), WORLD_MIN_Y + 1, (y, solid) => {
    if (!solid) return true;
    surface = y;
    return false;
  });
  return surface;
}

/**
 * 一列最高的地形方块的 y（密度为正的最高一格）。只求这一列四角的格点，不生成区块。
 *
 * 铺地表只替换地形方块的种类（石头换成草方块、泥土、沙子等）、嵌矿脉只替换石头，都不改哪一格是地形方块，
 * 所以这就是铺好地表之后那一列的地表高度。
 */
export function densitySurfaceHeight(seed: number, x: number, z: number): number {
  const { g: gx, f: fx } = gridCell(x);
  const { g: gz, f: fz } = gridCell(z);
  return surfaceOf(
    cornersOf(
      new GridColumn(seed, gx, gz),
      new GridColumn(seed, gx + 1, gz),
      new GridColumn(seed, gx, gz + 1),
      new GridColumn(seed, gx + 1, gz + 1),
      fx,
      fz,
    ),
  );
}

/** 地表高度窗口的边长：区块本身加四周各一列（铺地表判陡坡要看东南西北四个相邻列）。 */
export const HEIGHT_WINDOW = CHUNK_SIZE + 2;

/**
 * 区块里每一列（下标 `lz * CHUNK_SIZE + lx`）按密度扫描过的范围，与区块连同四周一圈列的地表高度。
 * `top` 之上一定是空气；`solidTop` 及以下整段是石头，从上往下扫到这里为止就不会再遇到露天的顶面。
 * `heights` 的下标是 `(lz + 1) * HEIGHT_WINDOW + (lx + 1)`，lx、lz 从 −1 到 CHUNK_SIZE；四个角上的列不求，
 * 留 `WORLD_MIN_Y`。值与 `densitySurfaceHeight` 逐列相同。
 */
export interface DensityExtent {
  readonly tops: Int16Array;
  readonly solidTops: Int16Array;
  readonly heights: Int16Array;
}

/**
 * 按密度把区块里的地形方块写成石头，其余保持空气；最底层不动（调用方写基岩）。
 *
 * 同时求出区块四周那一圈 64 列的地表高度：格点多取一圈（区块本身的 5×5 根之外再加四条边上各 5 根），
 * 与区块共用边上那一排格点的缓存，比逐列调 `densitySurfaceHeight`（每列新建 4 根格点竖列）计算量少得多。
 */
export function fillDensity(seed: number, chunk: Chunk): DensityExtent {
  const gx0 = (chunk.cx * CHUNK_SIZE) >> GRID_XZ_SHIFT;
  const gz0 = (chunk.cz * CHUNK_SIZE) >> GRID_XZ_SHIFT;
  // 格点下标 k、i 从 −1 到 CHUNK_GRID：四周多一圈，四个角上那 4 根用不到，不建。
  const span = CHUNK_GRID + 2;
  const grid: Array<GridColumn | undefined> = new Array<GridColumn | undefined>(span * span);
  for (let i = -1; i <= CHUNK_GRID; i++) {
    for (let k = -1; k <= CHUNK_GRID; k++) {
      const corner = (i === -1 || i === CHUNK_GRID) && (k === -1 || k === CHUNK_GRID);
      if (!corner) grid[(i + 1) * span + (k + 1)] = new GridColumn(seed, gx0 + k, gz0 + i);
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

  const tops = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  const solidTops = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  const heights = new Int16Array(HEIGHT_WINDOW * HEIGHT_WINDOW).fill(WORLD_MIN_Y);
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const corners = cornersAt(lx, lz);
      const solidTop = Math.max(WORLD_MIN_Y, solidTopOf(corners));
      const top = Math.max(solidTop, topOf(corners));
      chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, solidTop, BlockType.Stone);
      // 扫到的第一格地形方块就是地表高度；整段都没有时是 solidTop（它及以下整段实心）。
      let surface = solidTop;
      let found = false;
      scanColumn(corners, top, solidTop + 1, (y, solid) => {
        if (solid) {
          chunk.set(lx, y, lz, BlockType.Stone);
          if (!found) {
            surface = y;
            found = true;
          }
        }
        return true;
      });
      tops[lz * CHUNK_SIZE + lx] = top;
      solidTops[lz * CHUNK_SIZE + lx] = solidTop;
      heights[(lz + 1) * HEIGHT_WINDOW + (lx + 1)] = surface;
    }
  }
  // 四周那一圈列：只求地表高度，不写区块。
  for (let n = 0; n < CHUNK_SIZE; n++) {
    for (const [lx, lz] of [
      [-1, n],
      [CHUNK_SIZE, n],
      [n, -1],
      [n, CHUNK_SIZE],
    ] as const) {
      heights[(lz + 1) * HEIGHT_WINDOW + (lx + 1)] = surfaceOf(cornersAt(lx, lz));
    }
  }
  return { tops, solidTops, heights };
}
