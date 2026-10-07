import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, createTerrain } from '../../src/core/terrain';
import { chunkOf, localOf } from '../../src/core/world';
import { isPondColumn, NON_TERRAIN } from '../helpers/terrain-survey';
import { LOGS } from '../helpers/trees';

/**
 * 地形对象（#73）：由种子构造，含区块生成器、三个纯函数查询（群系、地表高度、列顶地表方块）与出生列。
 *
 * 这里断言的是对外的约定：查询只依赖种子与列坐标，与生成结果一致；真实地形上的出生列。三维密度地形本身的断言在
 * terrain-biomes 与 terrain-generation，铺地表的规则在 terrain-surface。
 */

// 与 DEFAULT_SEED 无关的几个种子：地形对象的性质不该只在默认种子下成立。
const SEEDS = [314_159, 777, -42];

/** 出生列周围不长树的半径（切比雪夫距离，GLOSSARY.md「出生点」、父 spec #72）。 */
const SPAWN_CLEARANCE = 7;

/**
 * 一批区块，每个区块里取四角、四边中点与正中的列：区块边缘的列最容易出错（树冠与查询都要跨到邻区块）。
 * 区块含原点区块（出生列那一带不长树）与远处、负坐标的区块。
 */
const CHUNKS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, -1],
  [3, -2],
  [-5, 7],
  [40, -33],
];
const LOCAL_COLUMNS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [15, 0],
  [0, 15],
  [15, 15],
  [7, 0],
  [0, 8],
  [15, 7],
  [8, 15],
  [7, 8],
];

/** 大范围的采样列：含负坐标与跨区块的，步长取一个与区块边长互质的数，各个局部坐标都碰得到。 */
function* sampleColumns(): Generator<readonly [number, number]> {
  for (let x = -300; x <= 300; x += 37) {
    for (let z = -300; z <= 300; z += 41) yield [x, z];
  }
}

/** 某一列从上往下第一格不在「地表之上」的方块（树与空气之下的那一格）的 y。 */
function highestTerrainY(chunk: Chunk, lx: number, lz: number): number {
  let y = WORLD_MAX_Y;
  while (y > WORLD_MIN_Y && NON_TERRAIN.has(chunk.get(lx, y, lz))) y--;
  return y;
}

describe('地形对象的构造', () => {
  it('由种子构造，记着自己的种子', () => {
    for (const seed of SEEDS) expect(createTerrain(seed).seed).toBe(seed);
  });

  it('区块生成器给出那个坐标的区块', () => {
    const chunk = createTerrain(SEEDS[0]).generateChunk(3, -2);
    expect(chunk.cx).toBe(3);
    expect(chunk.cz).toBe(-2);
  });

  it('同一种子构造两次，生成同一个区块逐字节相同', () => {
    for (const seed of SEEDS) {
      const a = createTerrain(seed).generateChunk(-5, 7);
      const b = createTerrain(seed).generateChunk(-5, 7);
      expect(Buffer.from(b.blocks).equals(Buffer.from(a.blocks))).toBe(true);
    }
  });

  it('换种子得到不同的区块', () => {
    const a = createTerrain(SEEDS[0]).generateChunk(0, 0);
    const b = createTerrain(SEEDS[1]).generateChunk(0, 0);
    expect(Buffer.from(b.blocks).equals(Buffer.from(a.blocks))).toBe(false);
  });
});

describe('地形对象的三个查询是纯函数', () => {
  it('同一列问两次得到同样的值，两个独立构造的对象也一样', () => {
    for (const seed of SEEDS) {
      const a = createTerrain(seed);
      const b = createTerrain(seed);
      for (const [x, z] of sampleColumns()) {
        expect(a.biomeAt(x, z)).toBe(a.biomeAt(x, z));
        expect(b.biomeAt(x, z)).toBe(a.biomeAt(x, z));
        expect(b.surfaceHeightAt(x, z)).toBe(a.surfaceHeightAt(x, z));
        expect(b.surfaceBlockAt(x, z)).toBe(a.surfaceBlockAt(x, z));
      }
    }
  });

  it('地表高度是整数', () => {
    const terrain = createTerrain(SEEDS[0]);
    for (const [x, z] of sampleColumns()) {
      expect(Number.isInteger(terrain.surfaceHeightAt(x, z))).toBe(true);
    }
  });

  it('查询与生成的先后无关：先生成区块再查，与没生成过就查结果相同', () => {
    const fresh = createTerrain(SEEDS[1]);
    const used = createTerrain(SEEDS[1]);
    for (const [cx, cz] of CHUNKS) used.generateChunk(cx, cz);
    for (const [x, z] of sampleColumns()) {
      expect(used.surfaceHeightAt(x, z)).toBe(fresh.surfaceHeightAt(x, z));
      expect(used.surfaceBlockAt(x, z)).toBe(fresh.surfaceBlockAt(x, z));
      expect(used.biomeAt(x, z)).toBe(fresh.biomeAt(x, z));
    }
  });

  it('查询与生成器可以单独取出来传递：不依赖 this，展开成新对象也照常可用', () => {
    // 树的放置把地形对象直接当 `TreePlacement` 用，浏览器把对象展开后换掉生成器，
    // 所以几个成员必须是不依赖 this 的函数属性。
    const terrain = createTerrain(SEEDS[2]);
    const { generateChunk, biomeAt, surfaceHeightAt, surfaceBlockAt } = terrain;
    const spread = { ...terrain };
    expect(Buffer.from(generateChunk(1, 1).blocks).equals(Buffer.from(terrain.generateChunk(1, 1).blocks))).toBe(true);
    for (const [x, z] of [
      [0, 0],
      [-17, 33],
      [512, -511],
    ] as const) {
      expect(biomeAt(x, z)).toBe(terrain.biomeAt(x, z));
      expect(surfaceHeightAt(x, z)).toBe(terrain.surfaceHeightAt(x, z));
      expect(surfaceBlockAt(x, z)).toBe(terrain.surfaceBlockAt(x, z));
      expect(spread.surfaceHeightAt(x, z)).toBe(terrain.surfaceHeightAt(x, z));
    }
  });
});

describe('地表高度与列顶地表方块的查询与生成结果一致', () => {
  it('查询值就是那一列最高的地形方块的 y，其上只有空气、水、冰与树（水塘列按挖之前：那一格是水，塘底不高于它）', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      for (const [cx, cz] of CHUNKS) {
        const chunk = terrain.generateChunk(cx, cz);
        for (const [lx, lz] of LOCAL_COLUMNS) {
          const x = cx * CHUNK_SIZE + lx;
          const z = cz * CHUNK_SIZE + lz;
          const surface = terrain.surfaceHeightAt(x, z);
          const where = `种子 ${seed}，列 (${x}, ${z})`;
          if (isPondColumn(terrain, x, z)) {
            // 水塘列（#81）：地表高度是挖之前的值，那一格是水，最高的地形方块是塘底
            expect(chunk.get(lx, surface, lz), where).toBe(BlockType.Water);
            expect(highestTerrainY(chunk, lx, lz), where).toBeLessThanOrEqual(surface);
            continue;
          }
          expect(highestTerrainY(chunk, lx, lz), where).toBe(surface);
        }
      }
    }
  });

  it('列顶地表方块查询等于生成结果里地表高度那一格的方块', () => {
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      for (const [cx, cz] of CHUNKS) {
        const chunk = terrain.generateChunk(cx, cz);
        for (const [lx, lz] of LOCAL_COLUMNS) {
          const x = cx * CHUNK_SIZE + lx;
          const z = cz * CHUNK_SIZE + lz;
          expect(terrain.surfaceBlockAt(x, z), `种子 ${seed}，列 (${x}, ${z})`).toBe(
            chunk.get(lx, terrain.surfaceHeightAt(x, z), lz),
          );
        }
      }
    }
  });
});

describe('群系查询', () => {
  it('只给出四种群系之一（四种都出现、各自的尺度与高度在 tests/core/terrain-biomes.test.ts）', () => {
    const biomes = new Set<string>(Object.values(Biome));
    for (const seed of SEEDS) {
      const terrain = createTerrain(seed);
      for (const [x, z] of sampleColumns()) expect(biomes.has(terrain.biomeAt(x, z))).toBe(true);
    }
  });
});

// 列顶地表方块按铺地表的规则给出，规则与「查询等于生成结果」的大范围断言在 tests/core/terrain-surface.test.ts（#76）。
/**
 * 真实地形的出生列（#84）。搜索规则本身用假查询断言，在 tests/core/spawn-column.test.ts；这里断言真实地形上的结果。
 * 真实地形的原点总是平原，这几条在出生列仍是原点的实现上也成立，它们保证换上螺旋搜索之后这些性质不丢失。
 */
describe('出生列', () => {
  const ALL_SEEDS = [...SEEDS, DEFAULT_SEED, 555, 20_260_101];

  it('多个种子下出生列的群系是平原、列顶地表方块是草方块，坐标是 16 的倍数', () => {
    for (const seed of ALL_SEEDS) {
      const terrain = createTerrain(seed);
      const { x, z } = terrain.spawnColumn;
      const where = `种子 ${seed}，出生列 (${x}, ${z})`;
      expect(terrain.biomeAt(x, z), where).toBe(Biome.Plains);
      expect(terrain.surfaceBlockAt(x, z), where).toBe(BlockType.Grass);
      expect(Math.abs(x % 16), where).toBe(0);
      expect(Math.abs(z % 16), where).toBe(0);
      expect(Math.max(Math.abs(x), Math.abs(z)), where).toBeLessThanOrEqual(1024);
    }
  });

  it('生成结果里出生列地表高度那一格是草方块', () => {
    for (const seed of ALL_SEEDS) {
      const terrain = createTerrain(seed);
      const { x, z } = terrain.spawnColumn;
      const chunk = terrain.generateChunk(chunkOf(x), chunkOf(z));
      expect(chunk.get(localOf(x), terrain.surfaceHeightAt(x, z), localOf(z)), `种子 ${seed}`).toBe(BlockType.Grass);
    }
  });

  it('同一种子构造两次得到同一列；同一个地形对象读两次是同一个结果，不重算', () => {
    for (const seed of ALL_SEEDS) {
      const terrain = createTerrain(seed);
      expect(createTerrain(seed).spawnColumn).toEqual(terrain.spawnColumn);
      expect(terrain.spawnColumn).toBe(terrain.spawnColumn);
    }
  });

  it('出生列周围 7 格内没有原木（三种树的原木都不算，#79）', () => {
    for (const seed of ALL_SEEDS) {
      const terrain = createTerrain(seed);
      const { x: sx, z: sz } = terrain.spawnColumn;
      const logs: string[] = [];
      for (let cx = chunkOf(sx - SPAWN_CLEARANCE); cx <= chunkOf(sx + SPAWN_CLEARANCE); cx++) {
        for (let cz = chunkOf(sz - SPAWN_CLEARANCE); cz <= chunkOf(sz + SPAWN_CLEARANCE); cz++) {
          const chunk = terrain.generateChunk(cx, cz);
          for (let x = sx - SPAWN_CLEARANCE; x <= sx + SPAWN_CLEARANCE; x++) {
            for (let z = sz - SPAWN_CLEARANCE; z <= sz + SPAWN_CLEARANCE; z++) {
              if (chunkOf(x) !== cx || chunkOf(z) !== cz) continue;
              for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
                if (LOGS.has(chunk.get(localOf(x), y, localOf(z)))) logs.push(`(${x}, ${y}, ${z})`);
              }
            }
          }
        }
      }
      expect(logs, `种子 ${seed}`).toEqual([]);
    }
  });
});
