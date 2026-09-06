import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import {
  CHUNK_SIZE,
  MIN_SURFACE_Y,
  SEA_LEVEL,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';
import {
  DIRT_DEPTH_MAX,
  DIRT_DEPTH_MIN,
  PLAINS_BASE_Y,
  PLAINS_RELIEF,
  plainsSurfaceHeight,
  plainsTerrain,
} from '../../src/core/terrain';
import { ABOVE_SURFACE } from '../helpers/above-surface';

// 两个与 DEFAULT_SEED 无关的种子：地形的性质不该只在默认种子下成立。
const SEED = 314_159;
const OTHER_SEED = 777;

/** 一批含负数、跨区块的采样列。写死而不是真随机，测试本身也要确定性。 */
const COLUMNS: Array<[number, number]> = [
  [0, 0],
  [1, -1],
  [15, 15],
  [-17, 33],
  [31, -32],
  [-129, -129],
  [512, 511],
];

/** 数一数某一列草方块之下连着几层泥土。 */
function dirtDepthBelow(chunk: Chunk, lx: number, surface: number, lz: number): number {
  let depth = 0;
  while (chunk.get(lx, surface - depth - 1, lz) === BlockType.Dirt) depth++;
  return depth;
}

/** 逐格比较两个区块，返回第一处不同的说明；完全一致则返回 null。 */
function firstDifference(a: Chunk, b: Chunk): string | null {
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
        const left = a.get(lx, y, lz);
        const right = b.get(lx, y, lz);
        if (left !== right) return `(${lx}, ${y}, ${lz}): ${left} ≠ ${right}`;
      }
    }
  }
  return null;
}

describe('平原地表高度', () => {
  it('同一种子、同一坐标两次得到同一高度', () => {
    for (const [x, z] of COLUMNS) {
      expect(plainsSurfaceHeight(SEED, x, z)).toBe(plainsSurfaceHeight(SEED, x, z));
    }
  });

  it('高度是整数', () => {
    for (const [x, z] of COLUMNS) {
      expect(Number.isInteger(plainsSurfaceHeight(SEED, x, z))).toBe(true);
    }
  });

  it('大范围采样都高于海平面，且不超过起伏上界', () => {
    const outOfRange: string[] = [];
    for (let x = -300; x <= 300; x += 3) {
      for (let z = -300; z <= 300; z += 3) {
        const h = plainsSurfaceHeight(SEED, x, z);
        if (h <= SEA_LEVEL || h > PLAINS_BASE_Y + PLAINS_RELIEF) {
          outOfRange.push(`(${x}, ${z}) → ${h}`);
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it('地形有起伏：一条采样线上出现多种高度', () => {
    const heights = new Set<number>();
    for (let x = -200; x <= 200; x++) heights.add(plainsSurfaceHeight(SEED, x, 7));
    expect(heights.size).toBeGreaterThan(3);
  });

  it('起伏平缓：相邻列的高度差不超过 1', () => {
    const steep: string[] = [];
    for (let x = -200; x < 200; x++) {
      for (const z of [-64, 0, 5, 128]) {
        const dx = Math.abs(plainsSurfaceHeight(SEED, x + 1, z) - plainsSurfaceHeight(SEED, x, z));
        const dz = Math.abs(plainsSurfaceHeight(SEED, x, z + 1) - plainsSurfaceHeight(SEED, x, z));
        if (dx > 1 || dz > 1) steep.push(`(${x}, ${z}) → dx ${dx}, dz ${dz}`);
      }
    }
    expect(steep).toEqual([]);
  });

  it('换种子得到不同的高度剖面', () => {
    let differing = 0;
    for (let x = -100; x <= 100; x++) {
      if (plainsSurfaceHeight(SEED, x, 3) !== plainsSurfaceHeight(OTHER_SEED, x, 3)) {
        differing++;
      }
    }
    expect(differing).toBeGreaterThan(100);
  });
});

describe('plainsTerrain 生成的区块', () => {
  const generate = plainsTerrain(SEED);

  it('纯函数：同一区块坐标两次生成逐格一致', () => {
    expect(firstDifference(generate(0, 0), generate(0, 0))).toBeNull();
    expect(firstDifference(generate(-3, 5), generate(-3, 5))).toBeNull();
  });

  it('生成顺序不影响结果：先 A 后 B 与先 B 后 A 一致', () => {
    const a1 = generate(0, 0);
    const b1 = generate(1, 0);
    const b2 = generate(1, 0);
    const a2 = generate(0, 0);
    expect(firstDifference(a1, a2)).toBeNull();
    expect(firstDifference(b1, b2)).toBeNull();
  });

  it('区块坐标决定内容：相邻区块不是同一份数据', () => {
    expect(firstDifference(generate(0, 0), generate(1, 0))).not.toBeNull();
  });

  it('每一列自上而下是 草 → 泥土（3–4 层）→ 石头', () => {
    const chunk = generate(-2, 4);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const surface = plainsSurfaceHeight(SEED, -2 * CHUNK_SIZE + lx, 4 * CHUNK_SIZE + lz);
        expect(chunk.get(lx, surface, lz)).toBe(BlockType.Grass);

        const dirt = dirtDepthBelow(chunk, lx, surface, lz);
        expect(dirt).toBeGreaterThanOrEqual(DIRT_DEPTH_MIN);
        expect(dirt).toBeLessThanOrEqual(DIRT_DEPTH_MAX);
        expect(chunk.get(lx, surface - dirt - 1, lz)).toBe(BlockType.Stone);
      }
    }
  });

  it('泥土层数在 3 与 4 之间变化，不是一个定值', () => {
    const chunk = generate(0, 0);
    const depths = new Set<number>();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        depths.add(dirtDepthBelow(chunk, lx, plainsSurfaceHeight(SEED, lx, lz), lz));
      }
    }
    expect([...depths].sort()).toEqual([DIRT_DEPTH_MIN, DIRT_DEPTH_MAX]);
  });

  it('石头一直铺到基岩之上', () => {
    const chunk = generate(3, -7);
    for (const y of [WORLD_MIN_Y + 1, -32, 0, 32]) {
      for (let lx = 0; lx < CHUNK_SIZE; lx += 5) {
        for (let lz = 0; lz < CHUNK_SIZE; lz += 5) {
          expect(chunk.get(lx, y, lz)).toBe(BlockType.Stone);
        }
      }
    }
  });

  it('y = −64 整层是基岩', () => {
    const chunk = generate(9, 9);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        expect(chunk.get(lx, WORLD_MIN_Y, lz)).toBe(BlockType.Bedrock);
      }
    }
  });

  it('基岩只在最底层', () => {
    const chunk = generate(9, 9);
    const strays: string[] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = WORLD_MIN_Y + 1; y <= WORLD_MAX_Y; y++) {
          if (chunk.get(lx, y, lz) === BlockType.Bedrock) strays.push(`(${lx}, ${y}, ${lz})`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('地表以上只有空气与树', () => {
    // 树是长在地表之上的，土石不是——「地表高度」说的是地面，见 CONTEXT.md。
    const chunk = generate(-1, -1);
    const strays: string[] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const surface = plainsSurfaceHeight(SEED, -CHUNK_SIZE + lx, -CHUNK_SIZE + lz);
        for (let y = surface + 1; y <= WORLD_MAX_Y; y++) {
          const block = chunk.get(lx, y, lz);
          if (!ABOVE_SURFACE.has(block)) strays.push(`(${lx}, ${y}, ${lz}) 是 ${block}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('地表之上长出了树', () => {
    // 密度是平均一个区块一棵，具体某个区块可能一棵也没有，所以扫一小片。
    // 树的形状与分布断言在 tests/core/tree.test.ts，这里只确认地形生成真的种了树。
    const kinds = new Set<BlockType>();
    for (let cx = 0; cx < 3; cx++) {
      for (let cz = 0; cz < 3; cz++) {
        const chunk = generate(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            for (let y = MIN_SURFACE_Y; y <= WORLD_MAX_Y; y++) kinds.add(chunk.get(lx, y, lz));
          }
        }
      }
    }
    expect(kinds).toContain(BlockType.OakLog);
    expect(kinds).toContain(BlockType.OakLeaves);
  });

  it('换种子得到不同的地形', () => {
    expect(firstDifference(plainsTerrain(OTHER_SEED)(0, 0), generate(0, 0))).not.toBeNull();
  });

  it('区块记住自己的坐标', () => {
    const chunk = generate(-4, 6);
    expect(chunk.cx).toBe(-4);
    expect(chunk.cz).toBe(6);
  });
});
