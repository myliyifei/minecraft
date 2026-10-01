import { BLOCKS, LightPassage } from '../../src/core/block';
import { CHUNK_AREA, CHUNK_SIZE, WORLD_HEIGHT, WORLD_MIN_Y } from '../../src/core/constants';
import type { World } from '../../src/core/world';

/** 平铺数组里一格的状态：不在已加载区块里、不透明、树叶、不衰减。 */
const ABSENT = 0;
const OPAQUE = 1;
const LEAVES = 2;
const CLEAR = 3;

/**
 * 「清零后从头算」的天光：只按已加载区块里的方块，用最直接的办法算一遍，与核心的增量结果比较。
 *
 * 故意不复用 `src/core/light.ts` 的任何做法：把已加载区块的包围盒铺成一张大数组（没加载的
 * 区块那一块记作不在世界里），每一列从顶往下填竖直部分，然后把所有亮着的格子都当光源，按先进
 * 先出反复松弛到不再变化。每一步都对着 CONTEXT.md 的「天光」写，是独立的参照。
 *
 * 返回值以 `"cx,cz"` 为键，值与区块的光照数组同样排布，每格是天光等级。
 */
export function skyLightFromScratch(world: World): Map<string, Uint8Array> {
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

  const passageOf = new Uint8Array(256);
  for (const [id, def] of Object.entries(BLOCKS)) {
    passageOf[Number(id)] =
      def.lightPassage === LightPassage.Opaque ? OPAQUE : def.lightPassage === LightPassage.Leaves ? LEAVES : CLEAR;
  }
  const kind = new Uint8Array(cells);
  for (const { cx, cz } of loaded) {
    const blocks = world.chunkAt(cx, cz)!.blocks;
    eachCell(cx - minCx, cz - minCz, (local, flat) => {
      kind[flat] = passageOf[blocks[local]];
    });
  }

  const level = new Uint8Array(cells);
  const queue = new Int32Array(cells * 7);
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

  const result = new Map<string, Uint8Array>();
  for (const { cx, cz } of loaded) {
    const out = new Uint8Array(CHUNK_AREA * WORLD_HEIGHT);
    eachCell(cx - minCx, cz - minCz, (local, flat) => {
      out[local] = level[flat];
    });
    result.set(`${cx},${cz}`, out);
  }
  return result;
}

/**
 * 核心里每个已加载区块的天光与从头算的逐格比较，返回第一处不同（没有不同返回 undefined）。
 * 断言时打出这一处比打出整个数组有用。
 */
export function firstSkyLightMismatch(world: World): string | undefined {
  for (const [key, expected] of skyLightFromScratch(world)) {
    const [cx, cz] = key.split(',').map(Number);
    const light = world.chunkAt(cx, cz)!.light!;
    for (let i = 0; i < expected.length; i++) {
      if (light[i] >> 4 !== expected[i]) {
        const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const z = cz * CHUNK_SIZE + Math.floor((i % CHUNK_AREA) / CHUNK_SIZE);
        const y = Math.floor(i / CHUNK_AREA) + WORLD_MIN_Y;
        return `(${x}, ${y}, ${z}) 核心 ${light[i] >> 4}，从头算 ${expected[i]}`;
      }
    }
  }
  return undefined;
}
