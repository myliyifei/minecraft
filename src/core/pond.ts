import { BlockType } from './block';
import { Biome } from './biome';
import type { Chunk } from './chunk';
import { CHUNK_SIZE, SEA_LEVEL } from './constants';
import { hashCoords } from './noise';
import { SNOW_LINE_Y } from './surface';
import type { TreePlacement } from './tree';
import type { ColumnCoord } from './world';

/**
 * 水塘（CONTEXT.md「水塘」，#81）：平原与高山雪线以下地表上的小片湖泊。位置与形状只由种子、水塘格坐标与
 * 群系、地表高度两个查询决定；每个区块按 ADR-0005 从邻近的水塘格拉取会写进自己的水塘，区块外的列一律调查询。
 *
 * 一个水塘格里最多一个水塘：
 * 1. 格的哈希决定有没有、中心列、椭圆的两个半径与中心深度。
 * 2. 水面 = 椭圆外紧挨椭圆的那一圈列里最低的地表高度。盆地边缘因此都不低于水面，水不会从边上漫出去。
 * 3. 从中心列起按东南西北相邻漫开，只收椭圆内、地表高度不超过水面的列，这些列是水塘列。
 * 4. 每一列的深度从中心往外变浅（至少 1）；塘底 = min(地表高度 − 1, 水面 − 深度)，塘底铺沙子，其上到水面灌水。
 *    塘底至少比地表高度低一格，所以水塘列地表高度那一格总是水，列顶地表方块查询给出水与生成结果一致。
 * 5. 下面任何一条成立就整个不放：中心列高于水面、有一列水深超过 POND_DEPTH_MAX、跨度不到 POND_DIAMETER_MIN、
 *    最深一列不到 POND_DEEPEST_MIN、水面不高于海平面、有一列在大海或冰雪里、有一列在高山雪线以上、
 *    有一列离出生列不超过 POND_SPAWN_CLEARANCE 格。
 *
 * 地表高度查询不随水塘变（CONTEXT.md「地表高度」）：这里读的是挖之前的高度，挖水塘只改区块里写下的方块。
 */

/** 放水塘要的输入。成员名与地形对象、`TreePlacement` 的同名成员一致，地形对象可以直接当它传。不含列顶地表方块：那个查询要问水塘。 */
export type PondPlacement = Pick<TreePlacement, 'seed' | 'spawnColumn' | 'biomeAt' | 'surfaceHeightAt'>;

/** 一个水塘。 */
export interface Pond {
  /** 中心列：盆地最深处，本身是水塘列。 */
  readonly x: number;
  readonly z: number;
  /** 水面那一层（最上面一层水）的 y。 */
  readonly waterY: number;
  /** 水塘列（世界坐标），东南西北相邻连成一片，第一列是中心列。 */
  readonly columns: readonly ColumnCoord[];
  /** 与 columns 一一对应的塘底 y（铺沙子的那一格）。 */
  readonly floors: readonly number[];
}

/** 水塘格的边长（方块）：两个区块宽，边界与区块对齐。 */
export const POND_CELL_SIZE = 32;

/** 水塘格坐标用位移算，负坐标也向下取整。满足 `1 << POND_CELL_SHIFT === POND_CELL_SIZE`。 */
const POND_CELL_SHIFT = 5;

/** 椭圆半径的取值：POND_RADIUS_MIN 起，每档 POND_RADIUS_STEP，共 8 档，最大 4.6。 */
const POND_RADIUS_MIN = 2.5;
const POND_RADIUS_STEP = 0.3;
const POND_RADIUS_STEPS = 8;

/** 椭圆最大半径：2.5 + 7 × 0.3。 */
export const POND_RADIUS_MAX = POND_RADIUS_MIN + (POND_RADIUS_STEPS - 1) * POND_RADIUS_STEP;

/**
 * 水塘的水平伸展上界（方块，离中心列的切比雪夫距离）：水塘列在椭圆内，最远 ⌊4.6⌋ = 4 格；求水面要看的那一圈
 * 在椭圆外紧挨着，最远 5 格。区块按它扩一圈扫水塘格（ADR-0005）。
 */
export const POND_REACH = Math.floor(POND_RADIUS_MAX) + 1;

/**
 * 中心列离水塘格边的最小距离：伸展上界再加 1，水塘连同求水面要看的那一圈都在自己的格里，两个水塘因此不会
 * 重叠，也不会挨在一起连成一片。
 */
const POND_CELL_MARGIN = POND_REACH + 1;

/** 中心列在格内可取的位置数：离格边至少 POND_CELL_MARGIN。 */
const POND_CENTER_SPAN = POND_CELL_SIZE - 2 * POND_CELL_MARGIN;

/** 中心深度（格）：POND_CENTER_DEPTH_MIN 到 POND_CENTER_DEPTH_MIN + 2。 */
const POND_CENTER_DEPTH_MIN = 2;
const POND_CENTER_DEPTH_CHOICES = 3;

/** 直径下界（格，水塘列沿 x、沿 z 跨度的较大者）。上界由椭圆半径保证：2 × 4 + 1 = 9。 */
export const POND_DIAMETER_MIN = 5;
/** 每一列水深（水面 y − 塘底 y）的上界。 */
export const POND_DEPTH_MAX = 4;
/** 最深一列水深的下界。 */
export const POND_DEEPEST_MIN = 2;

/** 出生列周围多少格内不出现水塘列（切比雪夫距离，含边界），与树、植物相同（CONTEXT.md「出生点」）。 */
export const POND_SPAWN_CLEARANCE = 7;

/** 水塘的种子偏移量，与树、矿脉、植物的盐错开。 */
const POND_SALT = 0x6d2b_79f5;

/**
 * 格的哈希切成几段互不重叠的位：有没有水塘、中心列 x、中心列 z、两个半径、中心深度。
 * 中心列各取 5 位再对 POND_CENTER_SPAN 取余，余数稍有偏斜，看不出来。
 */
const PRESENCE_MASK = 0xff;
const CENTER_X_SHIFT = 8;
const CENTER_Z_SHIFT = 13;
const CENTER_MASK = 0x1f;
const RADIUS_X_SHIFT = 18;
const RADIUS_Z_SHIFT = 21;
const RADIUS_MASK = POND_RADIUS_STEPS - 1;
const DEPTH_SHIFT = 24;
const DEPTH_MASK = 0xff;

/**
 * 有没有水塘那段随机数小于它的格才试着放水塘：160/256 ≈ 63%。三个种子的平原里试放的格约四成因为盆地边缘
 * 太低（水面低于中心列）、太深或太小而不放，结果约每 8 个区块一个（实测见 ADR-0021 的 #81 补记）。
 */
const POND_CHANCE = 160;

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 世界坐标所属的水塘格坐标。 */
function cellOf(worldCoord: number): number {
  return worldCoord >> POND_CELL_SHIFT;
}

/** 格内的形状参数，局部坐标相对中心列。 */
interface Shape {
  readonly x: number;
  readonly z: number;
  readonly rx: number;
  readonly rz: number;
  readonly depth: number;
}

/** 某个水塘格的形状参数；这一格不放水塘则 undefined。 */
function shapeInCell(seed: number, cellX: number, cellZ: number): Shape | undefined {
  const roll = hashCoords(seed ^ POND_SALT, cellX, cellZ);
  if ((roll & PRESENCE_MASK) >= POND_CHANCE) return undefined;
  const offset = (shift: number): number => POND_CELL_MARGIN + (((roll >>> shift) & CENTER_MASK) % POND_CENTER_SPAN);
  const radius = (shift: number): number => POND_RADIUS_MIN + ((roll >>> shift) & RADIUS_MASK) * POND_RADIUS_STEP;
  return {
    x: cellX * POND_CELL_SIZE + offset(CENTER_X_SHIFT),
    z: cellZ * POND_CELL_SIZE + offset(CENTER_Z_SHIFT),
    rx: radius(RADIUS_X_SHIFT),
    rz: radius(RADIUS_Z_SHIFT),
    depth: POND_CENTER_DEPTH_MIN + (((roll >>> DEPTH_SHIFT) & DEPTH_MASK) % POND_CENTER_DEPTH_CHOICES),
  };
}

/** 偏移 (dx, dz) 到椭圆中心的归一化距离的平方：不超过 1 在椭圆内。 */
function ellipse(shape: Shape, dx: number, dz: number): number {
  return (dx / shape.rx) ** 2 + (dz / shape.rz) ** 2;
}

/** 某一列在不在可以放水塘的地方：不在大海、冰雪里，不在高山雪线以上，离出生列超过 POND_SPAWN_CLEARANCE 格。 */
function allowedAt(placement: PondPlacement, x: number, z: number, surface: number): boolean {
  const spawn = placement.spawnColumn;
  if (Math.max(Math.abs(x - spawn.x), Math.abs(z - spawn.z)) <= POND_SPAWN_CLEARANCE) return false;
  const biome = placement.biomeAt(x, z);
  if (biome === Biome.Ocean || biome === Biome.Snowy) return false;
  return !(biome === Biome.Mountains && surface >= SNOW_LINE_Y);
}

/** 地表高度还没问的标记：比世界最低处低得多。 */
const UNKNOWN_HEIGHT = -0x8000_0000;

/** 某个水塘格里的水塘（规则见本模块开头）；不放则 undefined。只经 placement 的查询读地形。 */
function pondInCell(placement: PondPlacement, cellX: number, cellZ: number): Pond | undefined {
  const shape = shapeInCell(placement.seed, cellX, cellZ);
  if (!shape) return undefined;
  const inside = (dx: number, dz: number): boolean => ellipse(shape, dx, dz) <= 1;

  // 格内偏移 (dx, dz) 的地表高度，每列只问一次。
  const side = 2 * POND_REACH + 1;
  const heights = new Int32Array(side * side).fill(UNKNOWN_HEIGHT);
  const heightAt = (dx: number, dz: number): number => {
    const i = (dz + POND_REACH) * side + (dx + POND_REACH);
    let h = heights[i]!;
    if (h === UNKNOWN_HEIGHT) {
      h = placement.surfaceHeightAt(shape.x + dx, shape.z + dz);
      heights[i] = h;
    }
    return h;
  };

  // 中心列先问：它高于水面就不放，水面要问的那一圈往往比它多得多，高的中心列可以少问几次。
  const center = heightAt(0, 0);
  let waterY = Number.POSITIVE_INFINITY;
  for (let dz = -POND_REACH; dz <= POND_REACH; dz++) {
    for (let dx = -POND_REACH; dx <= POND_REACH; dx++) {
      if (inside(dx, dz)) continue;
      if (!NEIGHBORS.some(([ex, ez]) => inside(dx + ex, dz + ez))) continue;
      waterY = Math.min(waterY, heightAt(dx, dz));
      if (waterY < center || waterY <= SEA_LEVEL) return undefined;
    }
  }

  const columns: ColumnCoord[] = [];
  const floors: number[] = [];
  const queued = new Set<number>([0]);
  const key = (dx: number, dz: number): number => (dz + POND_REACH) * side + (dx + POND_REACH);
  const queue: Array<readonly [number, number]> = [[0, 0]];
  let deepest = 0;
  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;
  for (let head = 0; head < queue.length; head++) {
    const [dx, dz] = queue[head]!;
    const x = shape.x + dx;
    const z = shape.z + dz;
    const surface = heightAt(dx, dz);
    const profile = Math.max(1, Math.round(shape.depth * (1 - ellipse(shape, dx, dz))));
    const floor = Math.min(surface - 1, waterY - profile);
    const depth = waterY - floor;
    if (depth > POND_DEPTH_MAX) return undefined;
    if (!allowedAt(placement, x, z, surface)) return undefined;
    columns.push({ x, z });
    floors.push(floor);
    deepest = Math.max(deepest, depth);
    minX = Math.min(minX, dx);
    maxX = Math.max(maxX, dx);
    minZ = Math.min(minZ, dz);
    maxZ = Math.max(maxZ, dz);
    for (const [ex, ez] of NEIGHBORS) {
      const nx = dx + ex;
      const nz = dz + ez;
      if (!inside(nx, nz) || queued.has(key(nx, nz))) continue;
      queued.add(key(nx, nz));
      if (heightAt(nx, nz) <= waterY) queue.push([nx, nz]);
    }
  }
  if (Math.max(maxX - minX, maxZ - minZ) + 1 < POND_DIAMETER_MIN) return undefined;
  if (deepest < POND_DEEPEST_MIN) return undefined;
  return { x: shape.x, z: shape.z, waterY, columns, floors };
}

/** 缓存里的一格：这一格的水塘与它的水塘列（键见 `columnKey`）；不放水塘是 null。 */
type CachedCell = { readonly pond: Pond; readonly columns: ReadonlySet<number> } | null;

/**
 * 按水塘格缓存的结果：求一个水塘要问几十列的地表高度，一个水塘格覆盖 4 个区块，列顶地表方块查询每列都要问
 * 所在的格。只按 placement 对象缓存，换了对象（比如测试里包一层计数）就重新求。缓存满了整个清空，结果不变。
 */
interface PondCells {
  readonly placement: PondPlacement;
  readonly cells: Map<number, CachedCell>;
}

/** 缓存最多留多少个水塘格：视距 8 约 289 个区块，约 80 个格，留足余量。 */
const POND_CACHE_CELLS = 4096;

const cacheByPlacement = new WeakMap<PondPlacement, PondCells>();

function cellsOf(placement: PondPlacement): PondCells {
  let cache = cacheByPlacement.get(placement);
  if (!cache) {
    cache = { placement, cells: new Map() };
    cacheByPlacement.set(placement, cache);
  }
  return cache;
}

/** 两个坐标编成一个数当 Map 与 Set 的键：各在 ±3 千万以内时不冲突。 */
function pairKey(a: number, b: number): number {
  return a * 0x400_0000 + b;
}
const columnKey = pairKey;

function cachedCell(cache: PondCells, cellX: number, cellZ: number): CachedCell {
  const k = pairKey(cellX, cellZ);
  const known = cache.cells.get(k);
  if (known !== undefined) return known;
  if (cache.cells.size >= POND_CACHE_CELLS) cache.cells.clear();
  const pond = pondInCell(cache.placement, cellX, cellZ);
  const cell: CachedCell = pond ? { pond, columns: new Set(pond.columns.map(({ x, z }) => columnKey(x, z))) } : null;
  cache.cells.set(k, cell);
  return cell;
}

/**
 * 会写进区块 (cx, cz) 的全部水塘，按水塘格坐标排好。
 *
 * 写法同 `treesTouching`（ADR-0005）：扫区块四周扩 POND_REACH 列能碰到的水塘格，只留有水塘列落进区块的。
 * 中心列离格边至少 POND_CELL_MARGIN，水塘总在自己的格里；格的边界与区块对齐，所以实际上只扫到区块所在的那一格，
 * 按伸展上界扩一圈是为了这个结论不依赖两个边长的取值。
 */
export function pondsTouching(placement: PondPlacement, cx: number, cz: number): Pond[] {
  const cache = cellsOf(placement);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const ponds: Pond[] = [];
  const lastCellZ = cellOf(originZ + CHUNK_SIZE - 1 + POND_REACH);
  const lastCellX = cellOf(originX + CHUNK_SIZE - 1 + POND_REACH);
  for (let cellZ = cellOf(originZ - POND_REACH); cellZ <= lastCellZ; cellZ++) {
    for (let cellX = cellOf(originX - POND_REACH); cellX <= lastCellX; cellX++) {
      const pond = cachedCell(cache, cellX, cellZ)?.pond;
      if (!pond) continue;
      const touches = pond.columns.some(
        ({ x, z }) => x >= originX && x < originX + CHUNK_SIZE && z >= originZ && z < originZ + CHUNK_SIZE,
      );
      if (touches) ponds.push(pond);
    }
  }
  return ponds;
}

/** (x, z) 是不是水塘列：列顶地表方块查询在这些列给出水。只看伸展上界内碰得到这一列的水塘格。 */
export function isPondColumn(placement: PondPlacement, x: number, z: number): boolean {
  const cache = cellsOf(placement);
  const key = columnKey(x, z);
  for (let cellZ = cellOf(z - POND_REACH); cellZ <= cellOf(z + POND_REACH); cellZ++) {
    for (let cellX = cellOf(x - POND_REACH); cellX <= cellOf(x + POND_REACH); cellX++) {
      if (cachedCell(cache, cellX, cellZ)?.columns.has(key)) return true;
    }
  }
  return false;
}

/**
 * 把会写进这个区块的水塘挖下去：每一列塘底那格换成沙子，其上到水面灌水。每写完一列调一次 onColumn（区块内坐标），
 * 生成器据此把那一列的顶层记成水。要在矿脉之后、树之前调。
 */
export function digPonds(placement: PondPlacement, chunk: Chunk, onColumn: (lx: number, lz: number) => void): void {
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;
  for (const pond of pondsTouching(placement, chunk.cx, chunk.cz)) {
    pond.columns.forEach(({ x, z }, i) => {
      const lx = x - originX;
      const lz = z - originZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      const floor = pond.floors[i]!;
      chunk.set(lx, floor, lz, BlockType.Sand);
      chunk.fillColumn(lx, lz, floor + 1, pond.waterY, BlockType.Water);
      onColumn(lx, lz);
    });
  }
}
