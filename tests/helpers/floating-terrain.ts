import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import type { ChunkCoord } from '../../src/core/world';
import { isTerrainBlock } from './terrain-survey';

/**
 * 悬空地形块（#86）的三维连通分析：把 n×n 个区块合成一块，按 6 邻接把地形方块分成连通块，
 * 以最底层基岩所在的连通块为地面，其余连通块里完全落在合并体内部的就是不与地面相连的悬空地形块。
 *
 * 只读生成好的区块（调用方经地形对象的生成器给出，可以缓存）。碰到合并体东西南北四个侧面的连通块可能在合并体外与山体相连，判不定，
 * 只计数、不算悬空；没碰到侧面的连通块六个方向的邻格都在合并体里，它在整个世界里也是孤立的，
 * 所以这样判出的悬空块不会误报，只会漏掉跨出合并体的那些（用多个、互相错开的合并体补）。
 */

/** 一个悬空地形块。 */
export interface FloatingBlock {
  /** 格数。 */
  readonly size: number;
  readonly minY: number;
  readonly maxY: number;
  /** 水平方向的外接矩形边长（格）：东西、南北两个方向里较大的那个。 */
  readonly extent: number;
  /** 各格坐标的平均值（世界坐标，取整）。 */
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
}

/** 一次连通分析的结果。 */
export interface ConnectivityReport {
  /** 合并体的cx、cz 最小的那个区块与边长（区块数）。 */
  readonly origin: ChunkCoord;
  readonly chunks: number;
  /** 不与地面相连、完全落在合并体内部的地形块，按格数从大到小。 */
  readonly floating: FloatingBlock[];
  /** 不与合并体里的地面相连、但碰到合并体侧面的连通块数（判不定）。 */
  readonly undecided: number;
  /** 合并体里的地形方块总数。 */
  readonly terrainBlocks: number;
}

const SOLID = 1;
const SEEN = 2;

/**
 * 以区块 origin 为 cx、cz 最小一角的 n×n 个区块做连通分析。合并体竖直方向从最底层到所有列里最高的地形方块之上一格。
 * 不是地形方块的格（空气、水、冰、树、地表植物）都算空：悬空块的判断只看地形方块。
 */
export function analyzeConnectivity(
  chunkAt: (coord: ChunkCoord) => Chunk,
  origin: ChunkCoord,
  n: number,
): ConnectivityReport {
  const w = n * CHUNK_SIZE;
  const chunks: { chunk: Chunk; k: number; i: number }[] = [];
  let top = WORLD_MIN_Y;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const chunk = chunkAt({ cx: origin.cx + k, cz: origin.cz + i });
      chunks.push({ chunk, k, i });
    }
  }
  // 先找最高的地形方块，竖直方向只建到它之上一格
  for (const { chunk } of chunks) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let y = WORLD_MAX_Y; y > top; y--) {
          if (isTerrainBlock(chunk.get(lx, y, lz))) {
            top = y;
            break;
          }
        }
      }
    }
  }
  const h = top + 1 - WORLD_MIN_Y + 1;
  const layer = w * w;
  const cells = new Uint8Array(layer * h);
  let terrainBlocks = 0;
  for (const { chunk, k, i } of chunks) {
    for (let y = WORLD_MIN_Y; y <= top; y++) {
      const base = (y - WORLD_MIN_Y) * layer;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const row = base + (i * CHUNK_SIZE + lz) * w + k * CHUNK_SIZE;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (isTerrainBlock(chunk.get(lx, y, lz))) {
            cells[row + lx] = SOLID;
            terrainBlocks++;
          }
        }
      }
    }
  }

  let stack = new Int32Array(1 << 16);
  /** 从 start 起把一个连通块标成 SEEN，返回格数与是否碰到侧面；collect 给出时逐格回调。 */
  const flood = (start: number, collect?: (index: number) => void): { size: number; touchesSide: boolean } => {
    let sp = 0;
    stack[sp++] = start;
    cells[start] = SEEN;
    let size = 0;
    let touchesSide = false;
    const push = (index: number): void => {
      if (cells[index] !== SOLID) return;
      cells[index] = SEEN;
      if (sp === stack.length) {
        const grown = new Int32Array(stack.length * 2);
        grown.set(stack);
        stack = grown;
      }
      stack[sp++] = index;
    };
    while (sp > 0) {
      const index = stack[--sp]!;
      size++;
      collect?.(index);
      const x = index % w;
      const z = Math.floor(index / w) % w;
      const yi = Math.floor(index / layer);
      if (x === 0 || x === w - 1 || z === 0 || z === w - 1) touchesSide = true;
      if (x > 0) push(index - 1);
      if (x < w - 1) push(index + 1);
      if (z > 0) push(index - w);
      if (z < w - 1) push(index + w);
      if (yi > 0) push(index - layer);
      if (yi < h - 1) push(index + layer);
    }
    return { size, touchesSide };
  };

  // 地面：最底层基岩所在的连通块
  for (let index = 0; index < layer; index++) {
    if (cells[index] === SOLID) flood(index);
  }

  const floating: FloatingBlock[] = [];
  let undecided = 0;
  const originX = origin.cx * CHUNK_SIZE;
  const originZ = origin.cz * CHUNK_SIZE;
  for (let index = layer; index < cells.length; index++) {
    if (cells[index] !== SOLID) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const { size, touchesSide } = flood(index, (cell) => {
      const y = Math.floor(cell / layer) + WORLD_MIN_Y;
      const cx = cell % w;
      const cz = Math.floor(cell / w) % w;
      sx += cx;
      sz += cz;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cz < minZ) minZ = cz;
      if (cz > maxZ) maxZ = cz;
      sy += y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    if (touchesSide) {
      undecided++;
      continue;
    }
    floating.push({
      size,
      minY,
      maxY,
      extent: Math.max(maxX - minX, maxZ - minZ) + 1,
      center: {
        x: originX + Math.round(sx / size),
        y: Math.round(sy / size),
        z: originZ + Math.round(sz / size),
      },
    });
  }
  floating.sort((a, b) => b.size - a.size);
  return { origin, chunks: n, floating, undecided, terrainBlocks };
}
