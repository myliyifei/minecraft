import { BLOCKS, LightPassage } from '../../src/core/block';
import { CHUNK_AREA, CHUNK_SIZE, WORLD_HEIGHT, WORLD_MIN_Y } from '../../src/core/constants';
import type { World } from '../../src/core/world';

/** 平铺数组里一格的状态：不在已加载区块里、不透明、树叶、不衰减。 */
const ABSENT = 0;
const OPAQUE = 1;
const LEAVES = 2;
const CLEAR = 3;

const passageOf = new Uint8Array(256);
const emissionOf = new Uint8Array(256);
for (const [id, def] of Object.entries(BLOCKS)) {
  passageOf[Number(id)] =
    def.lightPassage === LightPassage.Opaque ? OPAQUE : def.lightPassage === LightPassage.Leaves ? LEAVES : CLEAR;
  emissionOf[Number(id)] = def.lightEmission;
}

/**
 * 已加载区块的包围盒铺成的一张大数组：每格的透光方式（没加载的区块那一块记作不在世界里）与
 * 发光等级，以及平铺下标与区块内下标之间的换算。
 */
interface Flat {
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly layer: number;
  readonly kind: Uint8Array;
  readonly emission: Uint8Array;
  at(x: number, y: number, z: number): number;
  /** 按区块拆回去：每个已加载区块一份，与区块的光照数组同样排布。 */
  split(level: Uint8Array): Map<string, Uint8Array>;
}

function flatten(world: World): Flat {
  const loaded = world.loadedChunks();
  const minCx = Math.min(...loaded.map((c) => c.cx));
  const minCz = Math.min(...loaded.map((c) => c.cz));
  const sizeX = (Math.max(...loaded.map((c) => c.cx)) - minCx + 1) * CHUNK_SIZE;
  const sizeZ = (Math.max(...loaded.map((c) => c.cz)) - minCz + 1) * CHUNK_SIZE;
  const layer = sizeX * sizeZ;
  const cells = layer * WORLD_HEIGHT;
  const at = (x: number, y: number, z: number): number => y * layer + z * sizeX + x;
  /** 包围盒里第 (ox, oz) 个区块的每一格：区块内的下标与平铺数组里的下标。 */
  const eachCell = (ox: number, oz: number, visit: (local: number, flat: number) => void): void => {
    let local = 0;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const row = at(ox * CHUNK_SIZE, y, oz * CHUNK_SIZE + lz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) visit(local++, row + lx);
      }
    }
  };

  const kind = new Uint8Array(cells);
  const emission = new Uint8Array(cells);
  for (const { cx, cz } of loaded) {
    const blocks = world.chunkAt(cx, cz)!.blocks;
    eachCell(cx - minCx, cz - minCz, (local, flat) => {
      kind[flat] = passageOf[blocks[local]];
      emission[flat] = emissionOf[blocks[local]];
    });
  }

  const split = (level: Uint8Array): Map<string, Uint8Array> => {
    const result = new Map<string, Uint8Array>();
    for (const { cx, cz } of loaded) {
      const out = new Uint8Array(CHUNK_AREA * WORLD_HEIGHT);
      eachCell(cx - minCx, cz - minCz, (local, flat) => {
        out[local] = level[flat];
      });
      result.set(`${cx},${cz}`, out);
    }
    return result;
  };
  return { sizeX, sizeZ, layer, kind, emission, at, split };
}

/**
 * 从队列里的格子出发按先进先出反复松弛到不再变化：每格往六个邻格传「自己减 1」，
 * 不透明方块与不在世界里的格子不收。
 */
function relaxAll(flat: Flat, level: Uint8Array, queue: Int32Array, tail: number): void {
  const { sizeX, sizeZ, layer, kind } = flat;
  const relax = (j: number, from: number): void => {
    if (kind[j] === ABSENT || kind[j] === OPAQUE || level[j] >= from - 1) return;
    level[j] = from - 1;
    queue[tail++] = j;
  };
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const from = level[i];
    if (from <= 1) continue;
    const y = Math.floor(i / layer);
    const z = Math.floor((i - y * layer) / sizeX);
    const x = i - y * layer - z * sizeX;
    if (x + 1 < sizeX) relax(i + 1, from);
    if (x > 0) relax(i - 1, from);
    if (z + 1 < sizeZ) relax(i + sizeX, from);
    if (z > 0) relax(i - sizeX, from);
    if (y + 1 < WORLD_HEIGHT) relax(i + layer, from);
    if (y > 0) relax(i - layer, from);
  }
}

/**
 * 「清零后从头算」的天光：只按已加载区块里的方块，用最直接的办法算一遍，与核心的增量结果比较。
 *
 * 故意不复用 `src/core/light.ts` 的任何做法：把已加载区块的包围盒铺成一张大数组，每一列从顶往下
 * 填竖直部分，然后把所有亮着的格子都当光源，按先进先出反复松弛到不再变化。每一步都对着
 * CONTEXT.md 的「天光」写，是独立的参照。
 *
 * 返回值以 `"cx,cz"` 为键，值与区块的光照数组同样排布，每格是天光等级。
 */
export function skyLightFromScratch(world: World): Map<string, Uint8Array> {
  const flat = flatten(world);
  const { sizeX, sizeZ, kind, at } = flat;
  const level = new Uint8Array(kind.length);
  const queue = new Int32Array(kind.length * 7);
  let tail = 0;
  for (let z = 0; z < sizeZ; z++) {
    for (let x = 0; x < sizeX; x++) {
      if (kind[at(x, 0, z)] === ABSENT) continue;
      let v = 15;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        const i = at(x, y, z);
        if (kind[i] === OPAQUE) v = 0;
        else if (kind[i] === LEAVES) v = Math.max(0, v - 1);
        level[i] = v;
        if (v > 0) queue[tail++] = i;
      }
    }
  }
  relaxAll(flat, level, queue, tail);
  return flat.split(level);
}

/**
 * 「清零后从头算」的方块光（CONTEXT.md 的「方块光」）：发光方块那一格是它的发光等级——不透明的
 * 发光方块（燃烧中的熔炉）也是——再从所有发光方块出发松弛。树叶对方块光与空格一样。
 * 同样不复用核心的做法，返回值的形状同 `skyLightFromScratch`。
 */
export function blockLightFromScratch(world: World): Map<string, Uint8Array> {
  const flat = flatten(world);
  const { kind, emission } = flat;
  const level = new Uint8Array(kind.length);
  const queue = new Int32Array(kind.length * 7);
  let tail = 0;
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] === ABSENT || emission[i] === 0) continue;
    level[i] = emission[i];
    queue[tail++] = i;
  }
  relaxAll(flat, level, queue, tail);
  return flat.split(level);
}

/** 区块内下标 i 那一格的世界坐标，出错信息用。 */
function describeCell(cx: number, cz: number, i: number): string {
  const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
  const z = cz * CHUNK_SIZE + Math.floor((i % CHUNK_AREA) / CHUNK_SIZE);
  const y = Math.floor(i / CHUNK_AREA) + WORLD_MIN_Y;
  return `(${x}, ${y}, ${z})`;
}

/** 核心里每个已加载区块的一种光与从头算的逐格比较，返回第一处不同。 */
function firstMismatch(
  world: World,
  name: string,
  expectedByChunk: Map<string, Uint8Array>,
  read: (byte: number) => number,
): string | undefined {
  for (const [key, expected] of expectedByChunk) {
    const [cx, cz] = key.split(',').map(Number);
    const light = world.chunkAt(cx, cz)!.light!;
    for (let i = 0; i < expected.length; i++) {
      if (read(light[i]) !== expected[i]) {
        return `${describeCell(cx, cz, i)} ${name}：核心 ${read(light[i])}，从头算 ${expected[i]}`;
      }
    }
  }
  return undefined;
}

/**
 * 核心里每个已加载区块的天光与从头算的逐格比较，返回第一处不同（没有不同返回 undefined）。
 * 断言时打出这一处比打出整个数组有用。
 */
export function firstSkyLightMismatch(world: World): string | undefined {
  return firstMismatch(world, '天光', skyLightFromScratch(world), (byte) => byte >> 4);
}

/** 同 `firstSkyLightMismatch`，比的是方块光。 */
export function firstBlockLightMismatch(world: World): string | undefined {
  return firstMismatch(world, '方块光', blockLightFromScratch(world), (byte) => byte & 0x0f);
}

/** 两种光都比，先报天光的不同。 */
export function firstLightMismatch(world: World): string | undefined {
  return firstSkyLightMismatch(world) ?? firstBlockLightMismatch(world);
}
