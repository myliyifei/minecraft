import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { SEA_LEVEL } from '../../src/core/constants';
import { Biome, findSpawnColumn, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { OCEAN_HALF_WIDTH, OCEAN_ORIGIN_SPAWN, oceanOriginQueries } from '../helpers/ocean-origin-terrain';

/**
 * 出生列的搜索规则（#84，CONTEXT.md「出生点」）：从原点那一列起，以 16 格为步长按确定的螺旋顺序查，取第一列群系是平原、
 * 列顶地表方块是草方块的；1024 格以内找不到就取第一列列顶不是水、地表高于海平面的陆地，再找不到就是原点。只调查询。
 *
 * 真实地形的原点总是平原（Perlin 噪声在整数格点为 0），螺旋搜索在真实地形上几乎总是停在原点，所以这里的查询都是假的：
 * 一张「哪几列是什么」的小表，其余列一律是大海。不断言同一圈之内谁先谁后，只断言「离原点更近的那一圈先选」——
 * 那是「从原点起螺旋向外」本身的含义。
 */

type Queries = Pick<Terrain, 'biomeAt' | 'surfaceHeightAt' | 'surfaceBlockAt'>;

interface ColumnInfo {
  readonly biome: Biome;
  readonly height: number;
  readonly block: BlockType;
}

/** 大海的列：海底在海平面以下，顶上是石头（被水盖住的地面，#76 之后是沙子或沙砾，都不是草方块也不是水）。 */
const OCEAN: ColumnInfo = { biome: Biome.Ocean, height: SEA_LEVEL - 15, block: BlockType.Stone };
/** 合格的出生列：平原、草方块、高于海平面。 */
const PLAINS_GRASS: ColumnInfo = { biome: Biome.Plains, height: SEA_LEVEL + 5, block: BlockType.Grass };
/** 高山的草坡：陆地，但群系不是平原。 */
const MOUNTAIN_GRASS: ColumnInfo = { biome: Biome.Mountains, height: SEA_LEVEL + 40, block: BlockType.Grass };
/** 平原上列顶不是草方块的列（陡坡露石；#76 之后的沙滩同理）。 */
const PLAINS_STONE: ColumnInfo = { biome: Biome.Plains, height: SEA_LEVEL + 3, block: BlockType.Stone };

/** 按表给出三个查询，表里没有的列是大海。 */
function queriesFrom(columns: ReadonlyArray<readonly [number, number, ColumnInfo]>): Queries {
  const table = new Map(columns.map(([x, z, info]) => [`${x},${z}`, info]));
  const at = (x: number, z: number): ColumnInfo => table.get(`${x},${z}`) ?? OCEAN;
  return {
    biomeAt: (x, z) => at(x, z).biome,
    surfaceHeightAt: (x, z) => at(x, z).height,
    surfaceBlockAt: (x, z) => at(x, z).block,
  };
}

/** 与原点的切比雪夫距离：螺旋的第 k 圈就是距离 16k 的那一圈。 */
function ring(column: ColumnCoord): number {
  return Math.max(Math.abs(column.x), Math.abs(column.z));
}

describe('出生列首选平原的草方块', () => {
  it('原点那一列合格时就是原点', () => {
    const queries = queriesFrom([
      [0, 0, PLAINS_GRASS],
      [16, 0, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 0, z: 0 });
  });

  it('离原点更近的那一圈先选：第 2 圈与第 4 圈各有一列合格，取第 2 圈那列', () => {
    const queries = queriesFrom([
      [64, 64, PLAINS_GRASS],
      [-32, 16, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: -32, z: 16 });
  });

  it('步长是 16 格：不在 16 的倍数上的列再近也不查', () => {
    const queries = queriesFrom([
      [5, 3, PLAINS_GRASS],
      [17, 0, PLAINS_GRASS],
      [0, -31, PLAINS_GRASS],
      [48, -48, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 48, z: -48 });
  });

  it('群系是平原但列顶不是草方块的不选，列顶是草方块但群系不是平原的也不选', () => {
    const queries = queriesFrom([
      [16, 0, PLAINS_STONE],
      [0, 16, MOUNTAIN_GRASS],
      [-48, 32, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: -48, z: 32 });
  });

  it('1024 格以内有平原的草方块时，更近的陆地也优先选它', () => {
    const queries = queriesFrom([
      [16, 16, MOUNTAIN_GRASS],
      [0, -32, PLAINS_STONE],
      [160, -160, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 160, z: -160 });
  });

  it('1024 格那一圈也查：平原的草方块正好在 1024 格上时选它', () => {
    const queries = queriesFrom([
      [1024, -512, PLAINS_GRASS],
      [1040, 0, PLAINS_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 1024, z: -512 });
  });

  it('原点是大海的假地形：出生列不在原点，落在大海外第一圈上，群系是平原、列顶是草方块', () => {
    const column = findSpawnColumn(oceanOriginQueries);
    expect(column).not.toEqual({ x: 0, z: 0 });
    // 大海外的第一圈：16 的倍数里第一个不小于大海半宽的距离（大海半宽 100 时是第 7 圈，112 格）
    expect(ring(column)).toBe(Math.ceil(OCEAN_HALF_WIDTH / 16) * 16);
    expect(Math.abs(column.x % 16)).toBe(0);
    expect(Math.abs(column.z % 16)).toBe(0);
    expect(oceanOriginQueries.biomeAt(column.x, column.z)).toBe(Biome.Plains);
    expect(oceanOriginQueries.surfaceBlockAt(column.x, column.z)).toBe(BlockType.Grass);
    // 假地形对象上固定的出生列就是搜索的结果：核心的测试按它断言，与搜索不一致就测错了列
    expect(column).toEqual(OCEAN_ORIGIN_SPAWN);
  });
});

describe('1024 格以内没有平原的草方块时取陆地', () => {
  it('平原的草方块只在 1024 格以外：取 1024 格以内最近那一圈上的陆地', () => {
    const queries = queriesFrom([
      [1040, 0, PLAINS_GRASS],
      [0, -2048, PLAINS_GRASS],
      [128, 128, MOUNTAIN_GRASS],
      [80, -16, PLAINS_STONE],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 80, z: -16 });
  });

  it('取的是离原点最近的那一圈上的陆地，不是最后查到的那列：第 2 圈与第 5 圈各有一列平原的石头坡，取第 2 圈那列', () => {
    const queries = queriesFrom([
      [80, 48, PLAINS_STONE],
      [-32, -16, PLAINS_STONE],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: -32, z: -16 });
  });

  it('陆地要求列顶不是水、地表高于海平面：水塘与齐海平面的列都跳过', () => {
    const queries = queriesFrom([
      // 高于海平面的水塘：列顶是水
      [16, 0, { biome: Biome.Mountains, height: SEA_LEVEL + 30, block: BlockType.Water }],
      // 地表正好在海平面上：不算高于海平面
      [-32, 0, { biome: Biome.Snowy, height: SEA_LEVEL, block: BlockType.Grass }],
      // 冰雪的石头坡，比海平面高一格：是陆地
      [0, 48, { biome: Biome.Snowy, height: SEA_LEVEL + 1, block: BlockType.Stone }],
      [96, 96, MOUNTAIN_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 0, z: 48 });
  });
});

describe('什么都找不到时是原点', () => {
  it('1024 格以内全是大海', () => {
    expect(findSpawnColumn(queriesFrom([]))).toEqual({ x: 0, z: 0 });
  });

  it('合格的列都在 1024 格以外', () => {
    const queries = queriesFrom([
      [2048, 0, PLAINS_GRASS],
      [0, 1536, MOUNTAIN_GRASS],
    ]);
    expect(findSpawnColumn(queries)).toEqual({ x: 0, z: 0 });
  });
});

describe('出生列的搜索只调查询', () => {
  it('不生成区块：传入的对象带着生成器，一次都不调', () => {
    let generated = 0;
    const terrain = {
      ...queriesFrom([[-80, 64, PLAINS_GRASS]]),
      generateChunk: () => {
        generated++;
        throw new Error('出生列的搜索不应生成区块');
      },
    };
    expect(findSpawnColumn(terrain)).toEqual({ x: -80, z: 64 });
    // 找不到时要查满 1024 格，也不生成
    const empty = { ...queriesFrom([]), generateChunk: terrain.generateChunk };
    expect(findSpawnColumn(empty)).toEqual({ x: 0, z: 0 });
    expect(generated).toBe(0);
  });

  it('同样的查询两次得到同一列', () => {
    const queries = queriesFrom([
      [32, 32, PLAINS_GRASS],
      [-32, 32, PLAINS_GRASS],
      [32, -32, PLAINS_GRASS],
      [-32, -32, PLAINS_GRASS],
    ]);
    const first = findSpawnColumn(queries);
    expect(ring(first)).toBe(32);
    expect(findSpawnColumn(queries)).toEqual(first);
  });
});
