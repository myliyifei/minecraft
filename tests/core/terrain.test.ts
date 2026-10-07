import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, createTerrain } from '../../src/core/terrain';
import { isPondColumn, NON_TERRAIN } from '../helpers/terrain-survey';
import { STONE_LAYER } from '../helpers/stone-layer';
import { expectSurfaceBlocksDefined, SNOWY_GRASS } from '../helpers/surface-rules';

// 两个与 DEFAULT_SEED 无关的种子：地形的性质不该只在默认种子下成立。
const SEED = 314_159;
const OTHER_SEED = 777;

const terrain = createTerrain(SEED);
const surfaceAt = terrain.surfaceHeightAt;

/** 草方块之下的泥土层数（GLOSSARY.md「草方块，其下 3 到 4 层泥土」）。 */
const DIRT_LAYERS_MIN = 3;
const DIRT_LAYERS_MAX = 4;

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

// 确定性与整数两条由 tests/core/terrain-object.test.ts 覆盖；高度范围、群系交界处的高差在
// tests/core/terrain-biomes.test.ts（#75）。
describe('地表高度查询', () => {
  it('地形有起伏：一条采样线上出现多种高度', () => {
    const heights = new Set<number>();
    for (let x = -200; x <= 200; x++) heights.add(surfaceAt(x, 7));
    expect(heights.size).toBeGreaterThan(3);
  });

  it('换种子得到不同的高度剖面', () => {
    let differing = 0;
    for (let x = -100; x <= 100; x++) {
      if (surfaceAt(x, 3) !== createTerrain(OTHER_SEED).surfaceHeightAt(x, 3)) {
        differing++;
      }
    }
    expect(differing).toBeGreaterThan(100);
  });
});

describe('地形对象生成的区块', () => {
  const generate = terrain.generateChunk;

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

  it('每一列自上而下是 草方块（冰雪是雪草方块）→ 泥土（3–4 层）→ 石层（这一块横跨平原与冰雪，#76；水塘列除外，#81）', () => {
    expectSurfaceBlocksDefined();
    const chunk = generate(-2, 4);
    const tops = new Set<BlockType>();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const x = -2 * CHUNK_SIZE + lx;
        const z = 4 * CHUNK_SIZE + lz;
        if (isPondColumn(terrain, x, z)) continue;
        const surface = surfaceAt(x, z);
        const expected = terrain.biomeAt(x, z) === Biome.Snowy ? SNOWY_GRASS : BlockType.Grass;
        expect(chunk.get(lx, surface, lz), `(${x}, ${z})`).toBe(expected);
        tops.add(expected);

        const dirt = dirtDepthBelow(chunk, lx, surface, lz);
        expect(dirt).toBeGreaterThanOrEqual(DIRT_LAYERS_MIN);
        expect(dirt).toBeLessThanOrEqual(DIRT_LAYERS_MAX);
        // 泥土之下就是石层：大多数是石头，煤矿脉伸到这么高时也可能是煤矿石
        expect(STONE_LAYER).toContain(chunk.get(lx, surface - dirt - 1, lz));
      }
    }
    // 这一块确实横跨两种群系：两种顶层都出现
    expect([...tops].sort()).toEqual([BlockType.Grass, SNOWY_GRASS].sort());
  });

  it('泥土层数在 3 与 4 之间变化，不是一个定值（水塘列除外，#81）', () => {
    const chunk = generate(0, 0);
    const depths = new Set<number>();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        if (isPondColumn(terrain, lx, lz)) continue;
        depths.add(dirtDepthBelow(chunk, lx, surfaceAt(lx, lz), lz));
      }
    }
    expect([...depths].sort()).toEqual([DIRT_LAYERS_MIN, DIRT_LAYERS_MAX]);
  });

  it('石层一直铺到基岩之上：除石头只有矿石', () => {
    const chunk = generate(3, -7);
    const strays: string[] = [];
    let stone = 0;
    for (const y of [WORLD_MIN_Y + 1, -32, 0, 32]) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const block = chunk.get(lx, y, lz);
          if (block === BlockType.Stone) stone++;
          if (!STONE_LAYER.has(block)) strays.push(`(${lx}, ${y}, ${lz}) 是 ${block}`);
        }
      }
    }
    expect(strays).toEqual([]);
    // 矿石只是石层里的少数：四层一千多格里绝大多数仍是石头
    expect(stone).toBeGreaterThan(4 * CHUNK_SIZE * CHUNK_SIZE * 0.9);
  });

  it('石层里嵌着煤矿石与铁矿石，煤偏浅、铁偏深', () => {
    // 密度是一区块几十条，扫几个区块两种都找得到。矿脉的形状与分布断言在 tests/core/ore.test.ts。
    const coalYs: number[] = [];
    const ironYs: number[] = [];
    for (let cx = 0; cx < 2; cx++) {
      for (let cz = 0; cz < 2; cz++) {
        const chunk = generate(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const surface = surfaceAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
            for (let y = WORLD_MIN_Y; y <= surface; y++) {
              const block = chunk.get(lx, y, lz);
              if (block === BlockType.CoalOre) coalYs.push(y);
              if (block === BlockType.IronOre) ironYs.push(y);
            }
          }
        }
      }
    }
    expect(coalYs.length).toBeGreaterThan(0);
    expect(ironYs.length).toBeGreaterThan(0);
    expect(Math.min(...coalYs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...coalYs)).toBeLessThanOrEqual(64);
    expect(Math.min(...ironYs)).toBeGreaterThanOrEqual(-63);
    expect(Math.max(...ironYs)).toBeLessThanOrEqual(32);
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

  it('地表以上只有空气、水、冰与树', () => {
    // 树是长在地表之上的，土石不是——「地表高度」说的是地面，见 GLOSSARY.md。
    const chunk = generate(-1, -1);
    const strays: string[] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const surface = surfaceAt(-CHUNK_SIZE + lx, -CHUNK_SIZE + lz);
        for (let y = surface + 1; y <= WORLD_MAX_Y; y++) {
          const block = chunk.get(lx, y, lz);
          if (!NON_TERRAIN.has(block)) strays.push(`(${lx}, ${y}, ${lz}) 是 ${block}`);
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
            const surface = surfaceAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
            for (let y = surface + 1; y <= WORLD_MAX_Y; y++) kinds.add(chunk.get(lx, y, lz));
          }
        }
      }
    }
    // 三种树（#79）哪一种都算：这一片长的是哪种由种子与群系决定
    expect([BlockType.OakLog, BlockType.BirchLog, BlockType.SpruceLog].some((log) => kinds.has(log))).toBe(true);
    expect([BlockType.OakLeaves, BlockType.BirchLeaves, BlockType.SpruceLeaves].some((leaves) => kinds.has(leaves))).toBe(true);
  });

  it('换种子得到不同的地形', () => {
    expect(firstDifference(createTerrain(OTHER_SEED).generateChunk(0, 0), generate(0, 0))).not.toBeNull();
  });

  it('区块记住自己的坐标', () => {
    const chunk = generate(-4, 6);
    expect(chunk.cx).toBe(-4);
    expect(chunk.cz).toBe(6);
  });
});
