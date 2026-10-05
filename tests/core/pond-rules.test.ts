import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { SEA_LEVEL } from '../../src/core/constants';
import { perlin2 } from '../../src/core/noise';
import { pondsTouching, type Pond, type PondPlacement } from '../../src/core/pond';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { chunkOf, localOf } from '../../src/core/world';
import { solidUpToSurface } from '../helpers/flat-terrain';

/**
 * 水塘的规则在合成地形上的边界（#81，补 tests/core/pond.test.ts）：真实平原的水塘几乎都落在地表同高的平地上，
 * 盆地边缘、水深上界、直径下界、海平面与出生列的边界在那里碰不到，这里用起伏几格的合成地表与平地逐条压到边界上。
 *
 * 只经 `pondsTouching` 与地形对象的公共查询、生成器。塘底 y 读 `Pond.floors`（与 columns 一一对应）。
 */

const FAR_SPAWN: ColumnCoord = { x: -100_000, z: -100_000 };

/** 原点周围 n×n 个区块。 */
function chunkSquare(n: number): Array<{ cx: number; cz: number }> {
  const coords: Array<{ cx: number; cz: number }> = [];
  for (let cz = -n / 2; cz < n / 2; cz++) for (let cx = -n / 2; cx < n / 2; cx++) coords.push({ cx, cz });
  return coords;
}

/** 一片区块里的水塘，按中心列去重。 */
function pondsIn(placement: PondPlacement, coords: Iterable<{ cx: number; cz: number }>): Pond[] {
  const found = new Map<string, Pond>();
  for (const { cx, cz } of coords) for (const pond of pondsTouching(placement, cx, cz)) found.set(`${pond.x},${pond.z}`, pond);
  return [...found.values()];
}

function placement(surfaceHeightAt: (x: number, z: number) => number, spawnColumn = FAR_SPAWN, seed = 314_159): PondPlacement {
  return { seed, spawnColumn, biomeAt: () => Biome.Plains, surfaceHeightAt, isSolidSpan: solidUpToSurface(surfaceHeightAt) };
}

/**
 * 起伏的合成地表：y 80 的平地上散落着成片的洼地（尺度 6 格的噪声高于 0.4 处往下凹，最深 4 到 5 格），
 * 另有零散高出一格的列。盆地边缘碰到洼地时水面跟着变低，中心列高于水面的、太深的、太小的水塘都碰得到。
 */
const rough = (x: number, z: number): number => {
  const dip = Math.max(0, Math.round(8 * (perlin2(0x1234, x / 6, z / 6) - 0.4)));
  const bump = perlin2(0x777, x / 3, z / 3) > 0.45 ? 1 : 0;
  return 80 - dip + bump;
};

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const key = ({ x, z }: ColumnCoord): string => `${x},${z}`;

function diameterOf(columns: readonly ColumnCoord[]): number {
  const xs = columns.map((c) => c.x);
  const zs = columns.map((c) => c.z);
  return Math.max(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...zs) - Math.min(...zs) + 1);
}

describe('起伏的合成地表上的水塘', () => {
  const ponds = pondsIn(placement(rough), chunkSquare(24));

  it('有足够多的水塘，其中有地表低于水面的列（盆地真的有高低）', () => {
    expect(ponds.length).toBeGreaterThan(30);
    const low = ponds.flatMap((p) => p.columns.filter((c) => rough(c.x, c.z) < p.waterY));
    expect(low.length).toBeGreaterThan(30);
  });

  it('水塘列的地表不高于水面；紧挨水塘、本身不是水塘列的列地表不低于水面（盆地边缘没有缺口）', () => {
    const wrong: string[] = [];
    for (const pond of ponds) {
      const keys = new Set(pond.columns.map(key));
      for (const c of pond.columns) {
        if (rough(c.x, c.z) > pond.waterY) wrong.push(`水塘列 ${key(c)} 地表 ${rough(c.x, c.z)} 高于水面 ${pond.waterY}`);
        for (const [dx, dz] of NEIGHBORS) {
          const n = { x: c.x + dx, z: c.z + dz };
          if (!keys.has(key(n)) && rough(n.x, n.z) < pond.waterY) wrong.push(`边缘 ${key(n)} 地表 ${rough(n.x, n.z)} 低于水面 ${pond.waterY}`);
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('每列塘底低于地表高度（地表高度那一格是水），水深 1 到 4；每个水塘直径 5 到 10、最深一列 2 到 4', () => {
    const wrong: string[] = [];
    for (const pond of ponds) {
      const depths = pond.floors.map((floor) => pond.waterY - floor);
      pond.columns.forEach((c, i) => {
        const floor = pond.floors[i]!;
        if (floor >= rough(c.x, c.z)) wrong.push(`${key(c)} 塘底 ${floor} 不低于地表 ${rough(c.x, c.z)}`);
        if (depths[i]! < 1 || depths[i]! > 4) wrong.push(`${key(c)} 水深 ${depths[i]}`);
      });
      const deepest = Math.max(...depths);
      if (deepest < 2 || deepest > 4) wrong.push(`(${pond.x}, ${pond.z}) 最深 ${deepest}`);
      const diameter = diameterOf(pond.columns);
      if (diameter < 5 || diameter > 10) wrong.push(`(${pond.x}, ${pond.z}) 直径 ${diameter}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(ponds.some((p) => diameterOf(p.columns) === 5), '直径正好 5 的水塘').toBe(true);
  });
});

describe('平地上的水塘', () => {
  const flat = (y: number) => placement(() => y);

  it('最深一列 2、3、4 格都出现', () => {
    const deepest = new Set(pondsIn(flat(80), chunkSquare(12)).map((p) => Math.max(...p.floors.map((f) => p.waterY - f))));
    expect([...deepest].sort()).toEqual([2, 3, 4]);
  });

  it('中心列的 x 与 z 都各有许多种取值：位置由水塘格的两个坐标共同决定，不按行或列重复', () => {
    const ponds = pondsIn(flat(80), chunkSquare(12));
    expect(ponds.length).toBeGreaterThan(20);
    const within = (v: number): number => ((v % 32) + 32) % 32;
    expect(new Set(ponds.map((p) => within(p.x))).size).toBeGreaterThan(8);
    expect(new Set(ponds.map((p) => within(p.z))).size).toBeGreaterThan(8);
    expect(new Set(ponds.map((p) => `${diameterOf(p.columns)}:${p.columns.length}`)).size).toBeGreaterThan(5);
  });

  it('水面要高于海平面：地表正好在海平面时没有水塘，高一格就有', () => {
    expect(pondsIn(flat(SEA_LEVEL), chunkSquare(12))).toEqual([]);
    expect(pondsIn(flat(SEA_LEVEL + 1), chunkSquare(12)).length).toBeGreaterThan(0);
  });

  it('水深的边界：水塘里一列地表挖低到塘底比水面低 4 格时照常生成，低 5 格时不生成这个水塘', () => {
    const ponds = pondsIn(flat(80), chunkSquare(12)).slice(0, 10);
    expect(ponds.length).toBe(10);
    const wrong: string[] = [];
    for (const pond of ponds) {
      // 不是中心列的一列：塘底 = min(地表 − 1, 水面 − 深度)，地表低到 水面 − 3 时塘底在 水面 − 4
      const pit = pond.columns.find((c) => c.x !== pond.x || c.z !== pond.z)!;
      for (const below of [3, 4]) {
        const surface = (x: number, z: number): number => (x === pit.x && z === pit.z ? pond.waterY - below : 80);
        const found = pondsIn(placement(surface), [{ cx: chunkOf(pond.x), cz: chunkOf(pond.z) }]);
        const present = found.some((p) => p.x === pond.x && p.z === pond.z);
        if (present !== (below === 3)) wrong.push(`(${pond.x}, ${pond.z}) 的 ${key(pit)} 低 ${below} 格：${present ? '生成了' : '没生成'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('盆地边缘的实心段：边缘一列挨着的水塘列里塘底最低的那列之上一格到水面都要实心，那一格是空气时不生成水塘，再低一格是空气时照常生成', () => {
    const ponds = pondsIn(flat(80), chunkSquare(12));
    const wrong: string[] = [];
    let tried = 0;
    for (const pond of ponds) {
      const keys = new Set(pond.columns.map(key));
      // 边缘一列挨着两列水塘列（都不是中心列）：把其中一列挖低，边缘这一列要实心的那一段因此向下延长
      let pick: { rim: ColumnCoord; pit: ColumnCoord } | undefined;
      for (const c of pond.columns) {
        for (const [dx, dz] of NEIGHBORS) {
          const rim = { x: c.x + dx, z: c.z + dz };
          if (keys.has(key(rim))) continue;
          const touching = NEIGHBORS.map(([ex, ez]) => ({ x: rim.x + ex, z: rim.z + ez })).filter(
            (n) => keys.has(key(n)) && (n.x !== pond.x || n.z !== pond.z),
          );
          if (touching.length >= 2) pick = { rim, pit: touching[0]! };
        }
      }
      if (!pick) continue;
      tried++;
      const { rim, pit } = pick;
      // 挖低的那列地表在 水面 − 3，塘底在 水面 − 4，边缘这一列从 水面 − 3 到水面都要实心
      const surface = (x: number, z: number): number => (x === pit.x && z === pit.z ? pond.waterY - 3 : 80);
      for (const gapY of [pond.waterY - 3, pond.waterY - 4]) {
        const holed: PondPlacement = {
          ...placement(surface),
          isSolidSpan: (x, z, from, to) => !(x === rim.x && z === rim.z && from <= gapY && gapY <= to) && to <= surface(x, z),
        };
        const found = pondsIn(holed, [{ cx: chunkOf(pond.x), cz: chunkOf(pond.z) }]);
        const present = found.some((p) => p.x === pond.x && p.z === pond.z);
        const expected = gapY === pond.waterY - 4;
        if (present !== expected) wrong.push(`(${pond.x}, ${pond.z}) 边缘 ${key(rim)} 在 y ${gapY} 是空气：${present ? '生成了' : '没生成'}`);
      }
    }
    expect(tried).toBeGreaterThan(5);
    expect(wrong).toEqual([]);
  });

  it('出生列的边界：出生列离水塘最近的一列正好 8 格时水塘照常生成，7 格时不生成这个水塘', () => {
    const ponds = pondsIn(flat(80), chunkSquare(12)).slice(0, 10);
    expect(ponds.length).toBe(10);
    const wrong: string[] = [];
    for (const pond of ponds) {
      const minX = Math.min(...pond.columns.map((c) => c.x));
      for (const gap of [7, 8]) {
        const spawn = { x: minX - gap, z: pond.z };
        const found = pondsIn(placement(() => 80, spawn), [{ cx: chunkOf(pond.x), cz: chunkOf(pond.z) }]);
        const present = found.some((p) => p.x === pond.x && p.z === pond.z);
        if (present !== (gap === 8)) wrong.push(`(${pond.x}, ${pond.z}) 出生列在 ${gap} 格：${present ? '生成了' : '没生成'}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('真实地形的出生列旁本来会有水塘的种子', () => {
  /** 这几个种子把出生列移远时，出生列周围 7 格内有水塘列（种子 1 到 60 里找出来的）。 */
  const SEEDS = [16, 34, 35];

  it.each(SEEDS)('种子 %i：出生列周围 7 格内列顶地表方块查询都不是水，生成结果里地表高度那一格也都不是水', (seed) => {
    const terrain = createTerrain(seed);
    const spawn = terrain.spawnColumn;
    const near = (c: ColumnCoord): boolean => Math.max(Math.abs(c.x - spawn.x), Math.abs(c.z - spawn.z)) <= 7;
    const coords: Array<{ cx: number; cz: number }> = [];
    for (let cx = chunkOf(spawn.x - 7); cx <= chunkOf(spawn.x + 7); cx++) {
      for (let cz = chunkOf(spawn.z - 7); cz <= chunkOf(spawn.z + 7); cz++) coords.push({ cx, cz });
    }
    const wouldBe = pondsIn({ ...terrain, spawnColumn: FAR_SPAWN }, coords).flatMap((p) => p.columns.filter(near));
    expect(wouldBe.length, '出生列移远时 7 格内的水塘列').toBeGreaterThan(0);

    const wrong: string[] = [];
    const chunks = new Map(coords.map(({ cx, cz }) => [`${cx},${cz}`, terrain.generateChunk(cx, cz)]));
    for (let x = spawn.x - 7; x <= spawn.x + 7; x++) {
      for (let z = spawn.z - 7; z <= spawn.z + 7; z++) {
        if (terrain.surfaceBlockAt(x, z) === BlockType.Water) wrong.push(`查询 (${x}, ${z}) 是水`);
        const chunk = chunks.get(`${chunkOf(x)},${chunkOf(z)}`)!;
        const surface = terrain.surfaceHeightAt(x, z);
        if (surface > SEA_LEVEL && chunk.get(localOf(x), surface, localOf(z)) === BlockType.Water) wrong.push(`生成 (${x}, ${z}) 是水`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('陡坡上的水塘列', () => {
  /**
   * 挖之前列顶是陡坡石头的水塘列（与相邻列的地表高度差有 3 格以上），在三个种子 ±2560 格里找出来的。
   * 嵌矿脉之后要把这种列顶写回石头（矿脉会换掉它），水塘得在那之后挖，否则地表高度那一格又成了石头。
   */
  const STEEP_POND_COLUMNS: ReadonlyArray<readonly [number, number, number]> = [
    [314_159, -2127, -534],
    [314_159, -2126, -534],
    [777, -790, 2322],
    [777, -789, 2323],
    [-42, -1486, 2285],
    [-42, -1487, 2286],
  ];

  it.each(STEEP_POND_COLUMNS)('种子 %i 列 (%i, %i)：列顶地表方块查询是水，生成结果里地表高度那一格也是水', (seed, x, z) => {
    const terrain = createTerrain(seed);
    const h = terrain.surfaceHeightAt(x, z);
    const rise = Math.max(...NEIGHBORS.map(([dx, dz]) => Math.abs(terrain.surfaceHeightAt(x + dx, z + dz) - h)));
    expect(rise, '是陡坡').toBeGreaterThanOrEqual(3);
    expect(terrain.surfaceBlockAt(x, z)).toBe(BlockType.Water);
    expect(terrain.generateChunk(chunkOf(x), chunkOf(z)).get(localOf(x), h, localOf(z))).toBe(BlockType.Water);
  });
});

describe('悬垂地形上的水塘', () => {
  /**
   * 种子 1 的高山里，中心列 (1927, 1514) 一带：邻列 (1927, 1511) 的地表高度是 y 136 一格悬空的石头，其下 y 126 到 135
   * 是空气。只看地表高度时这一列算盆地边缘（地表不低于水面 126），水塘列 (1927, 1512) 在 y 126 的水侧面就挨着空气。
   */
  const SEED = 1;
  const OVERHANG = { x: 1927, z: 1511 };

  it('盆地边缘那一列在水面高度上是空气时不生成水塘：附近的区块里每一格水的四邻是水或地形方块', () => {
    const terrain = createTerrain(SEED);
    const chunkAt = new Map<string, ReturnType<Terrain['generateChunk']>>();
    const blockAt = (x: number, y: number, z: number): BlockType => {
      const k = `${chunkOf(x)},${chunkOf(z)}`;
      let chunk = chunkAt.get(k);
      if (!chunk) {
        chunk = terrain.generateChunk(chunkOf(x), chunkOf(z));
        chunkAt.set(k, chunk);
      }
      return chunk.get(localOf(x), y, localOf(z));
    };
    // 前提：那一列确实是悬垂，地表高度在 y 136，y 126 是空气
    expect(terrain.surfaceHeightAt(OVERHANG.x, OVERHANG.z)).toBe(136);
    expect(blockAt(OVERHANG.x, 126, OVERHANG.z)).toBe(BlockType.Air);

    const wrong: string[] = [];
    for (let x = OVERHANG.x - 24; x <= OVERHANG.x + 24; x++) {
      for (let z = OVERHANG.z - 24; z <= OVERHANG.z + 24; z++) {
        if (terrain.surfaceBlockAt(x, z) !== BlockType.Water) continue;
        const surface = terrain.surfaceHeightAt(x, z);
        for (let y = surface; blockAt(x, y, z) === BlockType.Water; y--) {
          for (const [dx, dz] of NEIGHBORS) {
            const n = blockAt(x + dx, y, z + dz);
            if (n === BlockType.Air) wrong.push(`(${x}, ${y}, ${z}) 旁边 (${x + dx}, ${y}, ${z + dz}) 是空气`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(terrain.surfaceBlockAt(1927, 1512)).not.toBe(BlockType.Water);
  });
});
