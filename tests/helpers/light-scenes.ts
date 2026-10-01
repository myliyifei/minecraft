import type { BlockType } from '../../src/core/block';
import { chunkOf, localOf, World } from '../../src/core/world';
import { flatTestTerrain, flatTestWorld } from './flat-terrain';

/** 固定种子的伪随机数（mulberry32），落在 [0, 1)。随机测试每次跑的是同一串操作。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一格的世界坐标。 */
export type Cell = readonly [x: number, y: number, z: number];

/** 一处方块改动：世界坐标与改成什么。 */
export type Edit = readonly [x: number, y: number, z: number, block: BlockType];

/** 一个长方体范围里的格子全改成 block。 */
export function box([x0, y0, z0]: Cell, [x1, y1, z1]: Cell, block: BlockType): Edit[] {
  const edits: Edit[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) edits.push([x, y, z, block]);
    }
  }
  return edits;
}

/** 地形里已经有 edits 的平地世界，一个区块都还没加载。 */
export function worldWith(edits: readonly Edit[]): World {
  return new World((cx, cz) => {
    const chunk = flatTestTerrain(cx, cz);
    for (const [x, y, z, block] of edits) {
      if (chunkOf(x) === cx && chunkOf(z) === cz) chunk.set(localOf(x), y, localOf(z), block);
    }
    return chunk;
  });
}

/**
 * 同一个场景的两种造法：一种把改动写进地形，加载时就是这样（测初值）；另一种在平地上
 * 逐格 `setBlock`（测增量更新）。两种造法得到的光照应当一样。两种都加载原点周围
 * 半径 radius 的区块。
 */
export const BUILDS: Array<[string, (edits: readonly Edit[], radius?: number) => World]> = [
  [
    '写进地形、加载时算',
    (edits, radius = 1) => {
      const world = worldWith(edits);
      for (let cx = -radius; cx <= radius; cx++) {
        for (let cz = -radius; cz <= radius; cz++) world.loadChunk(cx, cz);
      }
      return world;
    },
  ],
  [
    '平地上逐格 setBlock',
    (edits, radius = 1) => {
      const world = flatTestWorld(radius);
      for (const [x, y, z, block] of edits) world.setBlock(x, y, z, block);
      return world;
    },
  ],
];

/** 已加载区块的光照数组，按区块坐标排好拷一份。 */
export function lightSnapshot(world: World): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const { cx, cz } of world.loadedChunks()) {
    result.set(`${cx},${cz}`, world.chunkAt(cx, cz)!.light!.slice());
  }
  return new Map([...result].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 两份按区块存的光照逐字节比较，返回第一处不同（相同返回 undefined）。比 `toEqual` 快得多，
 * 出错时也只打出那一处。
 */
export function firstDifference(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string | undefined {
  const keysA = [...a.keys()].join(' ');
  const keysB = [...b.keys()].join(' ');
  if (keysA !== keysB) return `区块不同：${keysA} 对 ${keysB}`;
  for (const [key, bytes] of a) {
    const other = b.get(key)!;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== other[i]) return `区块 ${key} 第 ${i} 格：${bytes[i]} 对 ${other[i]}`;
    }
  }
  return undefined;
}
