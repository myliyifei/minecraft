import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import {
  ORE_KINDS,
  ORE_VEIN_RADIUS,
  ORE_VEIN_RISE,
  oreVeinsTouching,
  plantOreVeins,
  type OreKindDef,
  type OreVein,
} from '../../src/core/ore';
import { plainsTerrain } from '../../src/core/terrain';
import type { Vec3 } from '../../src/core/vec3';
import { chunkOf, chunksAround, ORIGIN_CHUNK, World, type ChunkCoord } from '../../src/core/world';

// 两个与 DEFAULT_SEED 无关的种子：矿脉的性质不该只在默认种子下成立。
const SEED = 314_159;
const OTHER_SEED = 777;

/** 找矿脉时扫的区块半径。9×9 个区块、每区块几十条，样本够断言密度与形状。 */
const SCAN_RADIUS = 4;

/**
 * issue #31 给的两种矿石的参数，写死字面值，不从 `ORE_KINDS` 反读：这张表是需求那一侧的数字，
 * 数据表填错也该在这里报出来。
 */
const EXPECTED_KINDS: Array<{
  name: string;
  block: BlockType;
  minY: number;
  maxY: number;
  maxCount: number;
  veinsPerChunk: number;
}> = [
  { name: '煤矿脉', block: BlockType.CoalOre, minY: 0, maxY: 64, maxCount: 8, veinsPerChunk: 20 },
  { name: '铁矿脉', block: BlockType.IronOre, minY: -63, maxY: 32, maxCount: 4, veinsPerChunk: 10 },
];

/** 平均条数允许偏离目标的比例。样本是 81 个区块，正负三成够宽松，也足以说明密度没有偏离目标。 */
const DENSITY_TOLERANCE = 0.3;

/** 一格坐标写成可比较的字符串。 */
function key({ x, y, z }: Vec3): string {
  return `${x},${y},${z}`;
}

/**
 * 中心落在这片区块里的全部矿脉。
 *
 * 一条矿脉最多被 4 个区块各算一遍，所以按中心去重；只留中心在扫描范围内的，范围边上那些只
 * 伸进来一部分的不算，密度才统计得准确。
 */
function oreVeinsIn(seed: number, radius: number): OreVein[] {
  const found = new Map<string, OreVein>();
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      for (const vein of oreVeinsTouching(seed, cx, cz)) {
        if (Math.abs(chunkOf(vein.center.x)) > radius || Math.abs(chunkOf(vein.center.z)) > radius) continue;
        found.set(veinKey(vein), vein);
      }
    }
  }
  return [...found.values()];
}

/** 一条矿脉的身份：哪种矿石、中心在哪。 */
function veinKey(vein: OreVein): string {
  return `${vein.block}:${key(vein.center)}`;
}

/** 加载了这些区块的世界。加载顺序由调用方给，用来断言顺序不影响结果。 */
function worldWith(seed: number, coords: ChunkCoord[]): World {
  const world = new World(plainsTerrain(seed));
  for (const { cx, cz } of coords) world.loadChunk(cx, cz);
  return world;
}

/** 一条矿脉的每一格在世界里是什么，写成可比较的字符串。 */
function dumpVein(world: World, vein: OreVein): string[] {
  return vein.cells.map((cell) => `${key(cell)}: ${world.getBlock(cell.x, cell.y, cell.z)}`);
}

/**
 * 整条都在石层深处的矿脉：平原地表不低于 64、泥土最多 4 层，y 不超过 40 的格子在真实地形里
 * 必然是石头。这样的矿脉每一格都该写成了矿石，逐格断言才有意义。
 */
const DEEP_Y = 40;
function isDeep(vein: OreVein): boolean {
  return vein.cells.every((cell) => cell.y <= DEEP_Y);
}

/** 两种矿石。世界里一格是矿石就是其中之一。 */
const ORE_BLOCKS: ReadonlySet<BlockType> = new Set(ORE_KINDS.map((kind) => kind.block));

describe('矿石种类表', () => {
  it('有煤与铁两种，参数就是 issue #31 给的那些', () => {
    expect(ORE_KINDS).toHaveLength(EXPECTED_KINDS.length);
    for (const expected of EXPECTED_KINDS) {
      const kind: OreKindDef | undefined = ORE_KINDS.find((k) => k.block === expected.block);
      expect(kind, expected.name).toBeDefined();
      expect(kind!.minY, `${expected.name}的下界`).toBe(expected.minY);
      expect(kind!.maxY, `${expected.name}的上界`).toBe(expected.maxY);
      expect(kind!.minCount, `${expected.name}最少块数`).toBe(1);
      expect(kind!.maxCount, `${expected.name}最多块数`).toBe(expected.maxCount);
    }
  });

  it('矿脉的伸展范围：水平不超过 2 格、竖直不超过 1 格', () => {
    expect(ORE_VEIN_RADIUS).toBe(2);
    expect(ORE_VEIN_RISE).toBe(1);
  });
});

describe('矿脉的分布', () => {
  const veins = oreVeinsIn(SEED, SCAN_RADIUS);
  const chunks = (2 * SCAN_RADIUS + 1) ** 2;

  it('扫描范围内两种矿脉都找得到', () => {
    for (const { name, block } of EXPECTED_KINDS) {
      expect(veins.some((vein) => vein.block === block), name).toBe(true);
    }
  });

  it('每区块平均条数落在目标的宽松区间内：煤约 20、铁约 10', () => {
    for (const seed of [SEED, OTHER_SEED, DEFAULT_SEED]) {
      const all = oreVeinsIn(seed, SCAN_RADIUS);
      for (const { name, block, veinsPerChunk } of EXPECTED_KINDS) {
        const perChunk = all.filter((vein) => vein.block === block).length / chunks;
        expect(perChunk, `种子 ${seed} 的${name}`).toBeGreaterThan(veinsPerChunk * (1 - DENSITY_TOLERANCE));
        expect(perChunk, `种子 ${seed} 的${name}`).toBeLessThan(veinsPerChunk * (1 + DENSITY_TOLERANCE));
      }
    }
  });

  it('每条的块数在 1 与上限之间，第一格是中心，格互不重复', () => {
    const wrong: string[] = [];
    for (const vein of veins) {
      const { maxCount } = EXPECTED_KINDS.find((k) => k.block === vein.block)!;
      if (vein.cells.length < 1 || vein.cells.length > maxCount) {
        wrong.push(`${key(vein.center)} 有 ${vein.cells.length} 块`);
      }
      if (key(vein.cells[0]!) !== key(vein.center)) wrong.push(`${key(vein.center)} 的第一格不是中心`);
      if (new Set(vein.cells.map(key)).size !== vein.cells.length) {
        wrong.push(`${key(vein.center)} 有重复格`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('块数在 1 与上限之间变化，不是一个定值', () => {
    for (const { name, block, maxCount } of EXPECTED_KINDS) {
      const counts = new Set(veins.filter((v) => v.block === block).map((v) => v.cells.length));
      expect(counts.size, name).toBeGreaterThan(maxCount / 2);
      expect(counts.has(maxCount), `${name}出现上限块数`).toBe(true);
    }
  });

  it('每一格离中心水平不超过 2 格、竖直不超过 1 格', () => {
    const wrong: string[] = [];
    for (const vein of veins) {
      for (const cell of vein.cells) {
        const horizontal = Math.max(Math.abs(cell.x - vein.center.x), Math.abs(cell.z - vein.center.z));
        const vertical = Math.abs(cell.y - vein.center.y);
        if (horizontal > ORE_VEIN_RADIUS || vertical > ORE_VEIN_RISE) {
          wrong.push(`${key(vein.center)} 的 ${key(cell)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('每条是连成一团的：每一格都与之前某一格面对面相邻', () => {
    const wrong: string[] = [];
    for (const vein of veins) {
      for (let i = 1; i < vein.cells.length; i++) {
        const cell = vein.cells[i]!;
        const touching = vein.cells.slice(0, i).some(
          (earlier) =>
            Math.abs(earlier.x - cell.x) + Math.abs(earlier.y - cell.y) + Math.abs(earlier.z - cell.z) === 1,
        );
        if (!touching) wrong.push(`${key(vein.center)} 的 ${key(cell)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('煤矿石的每一格 y 在 0 到 64，铁矿石在 −63 到 32', () => {
    const wrong: string[] = [];
    for (const vein of veins) {
      const { minY, maxY, name } = EXPECTED_KINDS.find((k) => k.block === vein.block)!;
      for (const cell of vein.cells) {
        if (cell.y < minY || cell.y > maxY) wrong.push(`${name} ${key(cell)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('两种矿脉各自铺满整个高度区间，不是集中在一端', () => {
    for (const { name, block, minY, maxY } of EXPECTED_KINDS) {
      const ys = veins.filter((v) => v.block === block).map((v) => v.center.y);
      expect(Math.min(...ys), `${name}最低的中心`).toBeLessThan(minY + 8);
      expect(Math.max(...ys), `${name}最高的中心`).toBeGreaterThan(maxY - 8);
    }
  });

  it('同一区块两次算出同样的矿脉', () => {
    expect(oreVeinsTouching(SEED, -3, 5)).toEqual(oreVeinsTouching(SEED, -3, 5));
  });

  it('换种子矿脉就在别处', () => {
    const mine = new Set(veins.map(veinKey));
    const theirs = oreVeinsIn(OTHER_SEED, SCAN_RADIUS).map(veinKey);
    const same = theirs.filter((k) => mine.has(k)).length;
    expect(same).toBeLessThan(theirs.length / 20);
  });
});

describe('矿脉只替换石头', () => {
  /**
   * 人造区块：自下而上基岩、石头、泥土、空气、石头、草交替成层，每一层整层同一种。
   * 矿脉伸进哪一层都可能，规则本身因此被测到：只有石头那几层会被写成矿石。
   */
  function stripedChunk(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    const stripes = [BlockType.Bedrock, BlockType.Stone, BlockType.Dirt, BlockType.Air, BlockType.Stone, BlockType.Grass];
    for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
      chunk.fillLayer(y, stripes[(y - WORLD_MIN_Y) % stripes.length]!);
    }
    return chunk;
  }

  it('非石头的格子一个都没改，改了的格子原来是石头、现在是矿石', () => {
    const before = stripedChunk(1, -2);
    const after = stripedChunk(1, -2);
    plantOreVeins(SEED, after);

    let changed = 0;
    const wrong: string[] = [];
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
          const was = before.get(lx, y, lz);
          const now = after.get(lx, y, lz);
          if (was === now) continue;
          changed++;
          if (was !== BlockType.Stone) wrong.push(`(${lx}, ${y}, ${lz}) 原来是 ${was}`);
          if (!ORE_BLOCKS.has(now)) wrong.push(`(${lx}, ${y}, ${lz}) 变成了 ${now}`);
        }
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it('整块石头的区块里，写进去的正是算出来的那些格', () => {
    const chunk = new Chunk(2, 3);
    for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) chunk.fillLayer(y, BlockType.Stone);
    plantOreVeins(SEED, chunk);

    const predicted = new Map<string, BlockType>();
    // 先算的先写，后算的碰到已经是矿石的格子不再改
    for (const vein of oreVeinsTouching(SEED, 2, 3)) {
      for (const cell of vein.cells) {
        if (!predicted.has(key(cell))) predicted.set(key(cell), vein.block);
      }
    }
    const actual = new Map<string, BlockType>();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
          const block = chunk.get(lx, y, lz);
          if (block !== BlockType.Stone) {
            actual.set(key({ x: 2 * CHUNK_SIZE + lx, y, z: 3 * CHUNK_SIZE + lz }), block);
          }
        }
      }
    }
    // 预测里含伸到邻区块的格子，只留落在这个区块里的
    const inChunk = new Map(
      [...predicted].filter(([k]) => {
        const [x, , z] = k.split(',').map(Number) as [number, number, number];
        return chunkOf(x) === 2 && chunkOf(z) === 3;
      }),
    );
    expect(actual.size).toBeGreaterThan(50);
    expect(actual).toEqual(inChunk);
  });
});

describe('生成出来的矿脉', () => {
  const world = worldWith(SEED, chunksAround(ORIGIN_CHUNK, SCAN_RADIUS));
  // 只看中心落在扫描范围内圈的矿脉：它们四周的区块都加载了，每一条都是完整的。
  const veins = oreVeinsIn(SEED, SCAN_RADIUS - 1);
  const deep = veins.filter(isDeep);

  it('有矿脉可查，深处的也够多', () => {
    expect(veins.length).toBeGreaterThan(100);
    expect(deep.length).toBeGreaterThan(50);
  });

  it('世界里每一格矿石都属于某条算出来的矿脉', () => {
    const predicted = new Set<string>();
    for (const vein of oreVeinsIn(SEED, SCAN_RADIUS)) {
      for (const cell of vein.cells) predicted.add(key(cell));
    }
    const radius = SCAN_RADIUS - 1;
    const strays: string[] = [];
    let ores = 0;
    for (let x = -radius * CHUNK_SIZE; x < (radius + 1) * CHUNK_SIZE; x++) {
      for (let z = -radius * CHUNK_SIZE; z < (radius + 1) * CHUNK_SIZE; z++) {
        for (let y = WORLD_MIN_Y; y <= 70; y++) {
          if (!ORE_BLOCKS.has(world.getBlock(x, y, z))) continue;
          ores++;
          if (!predicted.has(key({ x, y, z }))) strays.push(key({ x, y, z }));
        }
      }
    }
    expect(ores).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });

  it('石层深处的矿脉每一格都是矿石', () => {
    const wrong: string[] = [];
    for (const vein of deep) {
      for (const cell of vein.cells) {
        const block = world.getBlock(cell.x, cell.y, cell.z);
        // 两条矿脉重叠时后算的那条不写那一格，它是另一种矿石，仍是矿石
        if (!ORE_BLOCKS.has(block)) wrong.push(`${key(cell)} 是 ${block}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('大多数深处矿脉整条都是自己那种矿石：重叠是少数', () => {
    const intact = deep.filter((vein) =>
      vein.cells.every((cell) => world.getBlock(cell.x, cell.y, cell.z) === vein.block),
    );
    expect(intact.length).toBeGreaterThan(deep.length * 0.9);
  });

  it('煤脉与铁脉重叠的格子是煤矿石：先煤后铁，与哪个区块算的无关', () => {
    // 预期不来自 oreVeinsTouching 的顺序，而是 issue 定下的规则：煤先写，铁只替换还是石头的格子。
    // 两种矿石的高度区间在 0 到 32 之间重合，81 个区块里总找得到重叠的格子。
    const coalCells = new Set<string>();
    for (const vein of veins) {
      if (vein.block === BlockType.CoalOre) for (const cell of vein.cells) coalCells.add(key(cell));
    }
    const overlaps: Vec3[] = [];
    for (const vein of deep) {
      if (vein.block !== BlockType.IronOre) continue;
      for (const cell of vein.cells) if (coalCells.has(key(cell))) overlaps.push(cell);
    }
    expect(overlaps.length).toBeGreaterThan(0);
    for (const cell of overlaps) {
      expect(world.getBlock(cell.x, cell.y, cell.z), key(cell)).toBe(BlockType.CoalOre);
    }
  });
});

describe('跨区块边界的矿脉', () => {
  /** 伸出了中心所在区块的那些矿脉。 */
  function crossing(veins: OreVein[]): OreVein[] {
    return veins.filter((vein) =>
      vein.cells.some(
        (cell) => chunkOf(cell.x) !== chunkOf(vein.center.x) || chunkOf(cell.z) !== chunkOf(vein.center.z),
      ),
    );
  }

  const deepCrossing = crossing(oreVeinsIn(SEED, SCAN_RADIUS - 1)).filter(isDeep);

  it('扫描范围内有这样的矿脉', () => {
    expect(deepCrossing.length).toBeGreaterThan(5);
  });

  it('两边的区块拼起来，跨边界的矿脉每一格都是矿石', () => {
    const world = worldWith(SEED, chunksAround(ORIGIN_CHUNK, SCAN_RADIUS));
    const wrong: string[] = [];
    for (const vein of deepCrossing) {
      for (const cell of vein.cells) {
        const block = world.getBlock(cell.x, cell.y, cell.z);
        if (!ORE_BLOCKS.has(block)) wrong.push(`${key(cell)} 是 ${block}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('先加载哪个区块都得到同一团', () => {
    const vein = deepCrossing[0]!;
    const around = chunksAround({ cx: chunkOf(vein.center.x), cz: chunkOf(vein.center.z) }, 1);
    const forwards = worldWith(SEED, around);
    const backwards = worldWith(SEED, [...around].reverse());
    expect(dumpVein(backwards, vein)).toEqual(dumpVein(forwards, vein));
  });

  it('只加载中心那个区块时，伸出去的那部分不在世界里', () => {
    const vein = deepCrossing[0]!;
    const home = { cx: chunkOf(vein.center.x), cz: chunkOf(vein.center.z) };
    const alone = worldWith(SEED, [home]);
    for (const cell of vein.cells) {
      const inside = chunkOf(cell.x) === home.cx && chunkOf(cell.z) === home.cz;
      const block = alone.getBlock(cell.x, cell.y, cell.z);
      if (inside) {
        expect(ORE_BLOCKS.has(block), key(cell)).toBe(true);
      } else {
        expect(block, key(cell)).toBe(BlockType.Air);
      }
    }
  });

  it('中心在区块边上的矿脉，邻区块也把它算进去', () => {
    const vein = deepCrossing[0]!;
    const home = { cx: chunkOf(vein.center.x), cz: chunkOf(vein.center.z) };
    const outside = vein.cells.find((cell) => chunkOf(cell.x) !== home.cx || chunkOf(cell.z) !== home.cz)!;
    const neighbour = oreVeinsTouching(SEED, chunkOf(outside.x), chunkOf(outside.z));
    expect(neighbour.some((other) => veinKey(other) === veinKey(vein))).toBe(true);
  });
});
