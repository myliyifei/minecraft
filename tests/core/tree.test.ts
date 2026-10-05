import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, WORLD_MIN_Y } from '../../src/core/constants';
import { createTerrain, type Terrain } from '../../src/core/terrain';
import {
  OAK_CANOPY_RADIUS,
  OAK_MIN_SPACING,
  OAK_SPAWN_CLEARANCE,
  OAK_TRUNK_MAX,
  OAK_TRUNK_MIN,
  oakTreesTouching,
  oakTrunkTopY,
  plantOakTrees,
  type OakTree,
} from '../../src/core/tree';
import {
  chunkOf,
  chunksAround,
  localOf,
  ORIGIN_CHUNK,
  World,
  type ChunkCoord,
} from '../../src/core/world';
import { flatTerrain } from '../helpers/flat-terrain';
import { isTerrainBlock } from '../helpers/terrain-survey';

// 两个与 DEFAULT_SEED 无关的种子：树的性质不该只在默认种子下成立。
const SEED = 314_159;
const OTHER_SEED = 777;

/** 找树时扫的区块半径。9×9 个区块、平均一区块一棵，样本够断言密度与形状。 */
const SCAN_RADIUS = 4;

/**
 * 树根落在这片区块里的全部橡树，按位置排好。
 *
 * 一棵树的树冠最多被 4 个区块各算一遍，所以按列去重；只留树根在扫描范围内的，
 * 范围边上那些只伸进来半个树冠的不算，密度才数得准。
 */
function oakTreesIn(seed: number, radius: number): OakTree[] {
  const placement = createTerrain(seed);
  const found = new Map<string, OakTree>();
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      for (const tree of oakTreesTouching(placement, cx, cz)) {
        if (Math.abs(chunkOf(tree.x)) > radius || Math.abs(chunkOf(tree.z)) > radius) continue;
        found.set(`${tree.x},${tree.z}`, tree);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.x - b.x || a.z - b.z);
}

/** 加载了这些区块的世界。加载顺序由调用方给，用来断言顺序不影响结果。 */
function worldWith(seed: number, coords: ChunkCoord[]): World {
  const world = new World(createTerrain(seed).generateChunk);
  for (const { cx, cz } of coords) world.loadChunk(cx, cz);
  return world;
}

/**
 * 世界里所有原木所在的列，排好序。
 *
 * 直接数方块，而不是问 `oakTreesTouching`：位置的确定性要在「生成出来的世界」这一层
 * 断言，否则拿同一个纯函数比它自己，任何实现都能通过。
 */
function trunkColumnsIn(world: World, radius: number): string[] {
  const columns: string[] = [];
  const from = -radius * CHUNK_SIZE;
  const to = (radius + 1) * CHUNK_SIZE - 1;
  for (let x = from; x <= to; x++) {
    for (let z = from; z <= to; z++) {
      const top = world.highestBlockY(x, z);
      for (let y = top; y > top - OAK_TRUNK_MAX - OAK_CANOPY_RADIUS; y--) {
        if (world.getBlock(x, y, z) === BlockType.OakLog) {
          columns.push(`${x},${z}`);
          break;
        }
      }
    }
  }
  return columns.sort();
}

/** 以树干为中心、半径 radius 的那一层里有几格树叶。 */
function leavesInLayer(world: World, tree: OakTree, y: number, radius: number): number {
  let count = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (world.getBlock(tree.x + dx, y, tree.z + dz) === BlockType.OakLeaves) count++;
    }
  }
  return count;
}

/**
 * 某一层里树冠格的相对坐标，按 dx,dz 排好：长出了树叶的格，加上 shape 里被地形方块占着的格。树叶只往空气里长，
 * 三维密度地形（#75）的平原有起伏，两格外的地面可能高过树冠最下面那层，那一格被地面挡住不算缺。
 */
function canopyLayer(world: World, tree: OakTree, y: number, shape: readonly string[]): string[] {
  const cells: string[] = [];
  for (let dx = -OAK_CANOPY_RADIUS; dx <= OAK_CANOPY_RADIUS; dx++) {
    for (let dz = -OAK_CANOPY_RADIUS; dz <= OAK_CANOPY_RADIUS; dz++) {
      const block = world.getBlock(tree.x + dx, y, tree.z + dz);
      const key = `${dx},${dz}`;
      if (block === BlockType.OakLeaves || (isTerrainBlock(block) && shape.includes(key))) {
        cells.push(key);
      }
    }
  }
  return cells;
}

/** 边长 2r+1 的方形（可去掉四角），再去掉调用方点名的那些格。 */
function square(r: number, corners: boolean, ...without: string[]): string[] {
  const cells: string[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (!corners && Math.abs(dx) === r && Math.abs(dz) === r) continue;
      if (without.includes(`${dx},${dz}`)) continue;
      cells.push(`${dx},${dz}`);
    }
  }
  return cells;
}

/**
 * 一棵树四层树冠的形状。原版式橡树冠：最宽两层 5×5 去掉四角，树干顶那层 3×3，
 * 顶上一层是 3×3 去掉四角的十字。树干占着正中那一格，所以除了最上层，正中是原木。
 */
function expectVanillaCanopy(world: World, tree: OakTree): void {
  const top = oakTrunkTopY(tree);
  const wide = OAK_CANOPY_RADIUS;
  const layers: Array<[y: number, shape: string[]]> = [
    [top - 2, square(wide, false, '0,0')],
    [top - 1, square(wide, false, '0,0')],
    [top, square(1, true, '0,0')],
    [top + 1, square(1, false)],
  ];
  for (const [y, shape] of layers) expect(canopyLayer(world, tree, y, shape)).toEqual(shape);
  // 树冠到此为止，再往上是空气
  expect(leavesInLayer(world, tree, top + 2, wide)).toBe(0);
}

/** 一棵树连它周围那一圈的方块，摊成可比较的字符串。 */
function dumpAround(world: World, tree: OakTree): string[] {
  const reach = OAK_CANOPY_RADIUS + 1;
  const lines: string[] = [];
  for (let y = tree.rootY - 1; y <= oakTrunkTopY(tree) + 2; y++) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        lines.push(`${dx},${y},${dz}: ${world.getBlock(tree.x + dx, y, tree.z + dz)}`);
      }
    }
  }
  return lines;
}

describe('橡树的分布', () => {
  it('平原上散布着橡树：扫描范围内找得到树', () => {
    expect(oakTreesIn(SEED, SCAN_RADIUS).length).toBeGreaterThan(0);
  });

  it('是散布而不是森林：平均每个区块半棵到两棵', () => {
    const perChunk = oakTreesIn(SEED, SCAN_RADIUS).length / (2 * SCAN_RADIUS + 1) ** 2;
    expect(perChunk).toBeGreaterThan(0.5);
    expect(perChunk).toBeLessThan(2);
  });

  it('两棵树之间至少隔 OAK_MIN_SPACING 格，树冠因此不会互相穿插', () => {
    // 最小间距大于两倍树冠半径，是「树冠不重叠」这条的全部依据
    expect(OAK_MIN_SPACING).toBeGreaterThan(2 * OAK_CANOPY_RADIUS);

    const trees = oakTreesIn(SEED, SCAN_RADIUS);
    const tooClose: string[] = [];
    for (const a of trees) {
      for (const b of trees) {
        if (a === b) continue;
        const distance = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        if (distance < OAK_MIN_SPACING) {
          tooClose.push(`(${a.x}, ${a.z}) 与 (${b.x}, ${b.z}) 只隔 ${distance}`);
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  it('树干高度在 4 与 6 之间变化，不是一个定值', () => {
    const heights = oakTreesIn(SEED, SCAN_RADIUS).map((tree) => tree.trunkHeight);
    const expected: number[] = [];
    for (let h = OAK_TRUNK_MIN; h <= OAK_TRUNK_MAX; h++) expected.push(h);
    expect([...new Set(heights)].sort((a, b) => a - b)).toEqual(expected);
  });

  it('出生点那一列不会被树冠盖住', () => {
    for (const seed of [SEED, OTHER_SEED, DEFAULT_SEED]) {
      const spawn = createTerrain(seed).spawnColumn;
      const tooClose = oakTreesIn(seed, SCAN_RADIUS)
        .filter((t) => Math.max(Math.abs(t.x - spawn.x), Math.abs(t.z - spawn.z)) <= OAK_SPAWN_CLEARANCE)
        .map((t) => `(${t.x}, ${t.z})`);
      expect(tooClose).toEqual([]);
    }
  });
});

/**
 * 树避开的是出生列周围 7 格，不是原点（#84）。真实地形的出生列几乎总是原点，所以这里把平地那一份地形对象的出生列
 * 换到别处，直接问 `oakTreesTouching`：平地上处处是平原、地表一样高，哪里长不长树只由种子决定。
 */
describe('橡树避开出生列', () => {
  /** 出生列换到这里：远离原点，x 正、z 负。 */
  const SPAWN = { x: 208, z: -192 };
  /** 换出生列用的种子：够多，原点与新出生列附近才一定有种子本该长树。 */
  const CLEARANCE_SEEDS = Array.from({ length: 24 }, (_, i) => 1_000 + i * 7_919);

  /** 平地地形对象，出生列换成 spawn。 */
  function flatWithSpawn(seed: number, spawn: { x: number; z: number }): Terrain {
    return { ...flatTerrain(seed), spawnColumn: spawn };
  }

  /** 树根落在 (x, z) 周围 OAK_SPAWN_CLEARANCE 格内的树（切比雪夫距离）。 */
  function treesNear(placement: Terrain, x: number, z: number): OakTree[] {
    const found = new Map<string, OakTree>();
    for (let cx = chunkOf(x - OAK_SPAWN_CLEARANCE); cx <= chunkOf(x + OAK_SPAWN_CLEARANCE); cx++) {
      for (let cz = chunkOf(z - OAK_SPAWN_CLEARANCE); cz <= chunkOf(z + OAK_SPAWN_CLEARANCE); cz++) {
        for (const tree of oakTreesTouching(placement, cx, cz)) {
          if (Math.max(Math.abs(tree.x - x), Math.abs(tree.z - z)) <= OAK_SPAWN_CLEARANCE) {
            found.set(`${tree.x},${tree.z}`, tree);
          }
        }
      }
    }
    return [...found.values()];
  }

  it('出生列在别处时，出生列周围 7 格内没有树根', () => {
    for (const seed of CLEARANCE_SEEDS) {
      const near = treesNear(flatWithSpawn(seed, SPAWN), SPAWN.x, SPAWN.z).map((t) => `(${t.x}, ${t.z})`);
      expect(near, `种子 ${seed}`).toEqual([]);
    }
  });

  it('出生列在别处时，原点周围 7 格不再特殊：有的种子在那里长树', () => {
    const seedsWithTreeAtOrigin = CLEARANCE_SEEDS.filter(
      (seed) => treesNear(flatWithSpawn(seed, SPAWN), 0, 0).length > 0,
    );
    expect(seedsWithTreeAtOrigin.length).toBeGreaterThan(0);
  });

  it('只空出出生列那一片：出生列在原点时原点附近没有树，别处的树与出生列在更远处时一样', () => {
    // 对照：出生列放在离两处都很远的地方，原点与 SPAWN 附近的树都不受它影响
    const ELSEWHERE = { x: -500, z: 500 };
    for (const seed of CLEARANCE_SEEDS) {
      const atOrigin = flatWithSpawn(seed, { x: 0, z: 0 });
      const atSpawn = flatWithSpawn(seed, SPAWN);
      const elsewhere = flatWithSpawn(seed, ELSEWHERE);
      expect(treesNear(atOrigin, 0, 0), `种子 ${seed}`).toEqual([]);
      expect(treesNear(atSpawn, 0, 0), `种子 ${seed}`).toEqual(treesNear(elsewhere, 0, 0));
      expect(treesNear(atOrigin, SPAWN.x, SPAWN.z), `种子 ${seed}`).toEqual(treesNear(elsewhere, SPAWN.x, SPAWN.z));
    }
  });
});

describe('橡树的位置由种子决定', () => {
  // 树根落在内圈的树才有完整的树冠，位置比对因此只看内圈那片区块
  const radius = SCAN_RADIUS - 1;
  const around = chunksAround(ORIGIN_CHUNK, SCAN_RADIUS);

  it('同一种子、不同加载顺序，长出来的树在同样的位置', () => {
    const forwards = trunkColumnsIn(worldWith(SEED, around), radius);
    const backwards = trunkColumnsIn(worldWith(SEED, [...around].reverse()), radius);
    expect(forwards.length).toBeGreaterThan(10);
    expect(backwards).toEqual(forwards);
  });

  it('世界里的树就是 oakTreesTouching 算出的那些', () => {
    const world = worldWith(SEED, around);
    const predicted = oakTreesIn(SEED, radius)
      .map((tree) => `${tree.x},${tree.z}`)
      .sort();
    expect(trunkColumnsIn(world, radius)).toEqual(predicted);
  });

  it('换种子树就长在别处', () => {
    const mine = trunkColumnsIn(worldWith(SEED, around), radius);
    const theirs = trunkColumnsIn(worldWith(OTHER_SEED, around), radius);
    expect(theirs).not.toEqual(mine);
  });
});

describe('生成出来的橡树', () => {
  const world = worldWith(SEED, chunksAround(ORIGIN_CHUNK, SCAN_RADIUS));
  // 只看树根落在扫描范围内圈的树：它们四周的区块都加载了，树冠是完整的。
  const trees = oakTreesIn(SEED, SCAN_RADIUS - 1);

  it('有树可查', () => {
    expect(trees.length).toBeGreaterThan(10);
  });

  it('树干正下方是草方块或泥土', () => {
    const wrong: string[] = [];
    for (const tree of trees) {
      const below = world.getBlock(tree.x, tree.rootY - 1, tree.z);
      if (below !== BlockType.Grass && below !== BlockType.Dirt) {
        wrong.push(`(${tree.x}, ${tree.z}) 下方是 ${below}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('树干是 4–6 格连续原木', () => {
    const wrong: string[] = [];
    for (const tree of trees) {
      if (tree.trunkHeight < OAK_TRUNK_MIN || tree.trunkHeight > OAK_TRUNK_MAX) {
        wrong.push(`(${tree.x}, ${tree.z}) 树干 ${tree.trunkHeight} 格`);
      }
      for (let y = tree.rootY; y <= oakTrunkTopY(tree); y++) {
        const block = world.getBlock(tree.x, y, tree.z);
        if (block !== BlockType.OakLog) wrong.push(`(${tree.x}, ${y}, ${tree.z}) 是 ${block}`);
      }
      // 树干上下都不是原木，「连续 4–6 格」说的就是这一段
      if (world.getBlock(tree.x, tree.rootY - 1, tree.z) === BlockType.OakLog) {
        wrong.push(`(${tree.x}, ${tree.z}) 树根之下还有原木`);
      }
      if (world.getBlock(tree.x, oakTrunkTopY(tree) + 1, tree.z) === BlockType.OakLog) {
        wrong.push(`(${tree.x}, ${tree.z}) 树干顶上还有原木`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('每一棵的树冠都是原版式形状：两层 5×5 去掉四角、一层 3×3、顶上一层十字', () => {
    // 树冠互不重叠（见最小间距那条），所以每一棵都能逐格断言，不必挑「孤立」的那些
    for (const tree of trees) expectVanillaCanopy(world, tree);
  });

  it('树干顶上那一格是树叶', () => {
    for (const tree of trees) {
      expect(world.getBlock(tree.x, oakTrunkTopY(tree) + 1, tree.z)).toBe(BlockType.OakLeaves);
    }
  });
});

describe('树叶只往空气里长', () => {
  /** 人造地形的基准地表高度。 */
  const LEDGE_BASE_Y = 70;

  /** 台阶的落差（方块）。高过树冠底面（地表往上两格）才挡得住树冠。 */
  const LEDGE_STEP = OAK_CANOPY_RADIUS + 2;

  /** 按某个地表高度函数在一个区块里铺一层草，其余是空气。 */
  function groundOnly(
    cx: number,
    cz: number,
    surfaceAt: (x: number, z: number) => number,
  ): Chunk {
    const chunk = new Chunk(cx, cz);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const y = surfaceAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
        chunk.fillColumn(lx, lz, WORLD_MIN_Y, y, BlockType.Grass);
      }
    }
    return chunk;
  }

  it('高出来的那半边地面不会被树冠顶掉', () => {
    // 真实地形里这条规则只在坡陡的地方触发，哪棵树碰得到要看种子。放树只认一个
    // 「地表高度」函数，所以给它一道确定的陡台阶：某棵树落在矮的那半边，树冠伸进高的那半边的
    // 地里去，规则本身因此被测到。
    const tree = oakTreesIn(SEED, SCAN_RADIUS - 1)[0];
    if (!tree) throw new Error('扫描范围内应有橡树');
    const cx = chunkOf(tree.x);
    const cz = chunkOf(tree.z);
    const surfaceAt = (_x: number, z: number): number =>
      z > tree.z ? LEDGE_BASE_Y + LEDGE_STEP : LEDGE_BASE_Y;

    const chunk = groundOnly(cx, cz, surfaceAt);
    // 平地那一份地形对象换掉地表高度：群系是平原，出生列是原点（树离原点远，不受出生列影响）
    plantOakTrees({ ...flatTerrain(SEED), surfaceHeightAt: surfaceAt }, chunk);

    const eaten: string[] = [];
    let planted = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const surface = surfaceAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
        for (let y = LEDGE_BASE_Y - 1; y <= surface + OAK_TRUNK_MAX + 3; y++) {
          const block = chunk.get(lx, y, lz);
          if (y <= surface && block !== BlockType.Grass) {
            eaten.push(`(${lx}, ${y}, ${lz}) 的草方块变成了 ${block}`);
          }
          if (y > surface && block !== BlockType.Air) planted++;
        }
      }
    }
    // 树叶确实伸到了台阶那一侧，否则这条测不到东西
    expect(planted).toBeGreaterThan(0);
    expect(chunk.get(tree.x - cx * CHUNK_SIZE, LEDGE_BASE_Y + 2, tree.z + 1 - cz * CHUNK_SIZE))
      .toBe(BlockType.Grass);
    expect(eaten).toEqual([]);
  });
});

describe('跨区块边界的橡树', () => {
  /** 树冠伸出了树根所在区块的那些树。 */
  function crossingTrees(trees: OakTree[]): OakTree[] {
    const crosses = (worldCoord: number): boolean => {
      const local = localOf(worldCoord);
      return local < OAK_CANOPY_RADIUS || local >= CHUNK_SIZE - OAK_CANOPY_RADIUS;
    };
    return trees.filter((tree) => crosses(tree.x) || crosses(tree.z));
  }

  const crossing = crossingTrees(oakTreesIn(SEED, SCAN_RADIUS - 1));

  /** 拿一棵跨边界的树。没有就直接报清楚，别让下面的断言读到 undefined。 */
  function someCrossingTree(): OakTree {
    const tree = crossing[0];
    if (!tree) throw new Error('扫描范围内应有树冠跨过区块边界的橡树');
    return tree;
  }

  it('扫描范围内有这样的树', () => {
    expect(crossing.length).toBeGreaterThan(0);
  });

  it('每一棵的形状都完整，与不跨边界的树一样', () => {
    const world = worldWith(SEED, chunksAround(ORIGIN_CHUNK, SCAN_RADIUS));
    // 逐格断言，而不是「两种加载顺序结果相同」——后者在任何实现下都成立，
    // 邻居区块漏写半个树冠时两边一样地漏，测不出东西来。
    for (const tree of crossing) expectVanillaCanopy(world, tree);
  });

  it('先加载哪个区块都得到同一棵树', () => {
    const tree = someCrossingTree();
    const around = chunksAround({ cx: chunkOf(tree.x), cz: chunkOf(tree.z) }, 1);
    const forwards = worldWith(SEED, around);
    const backwards = worldWith(SEED, [...around].reverse());
    expect(dumpAround(backwards, tree)).toEqual(dumpAround(forwards, tree));
  });

  it('只加载树根那个区块时，伸出去的那半个树冠不在世界里', () => {
    const tree = someCrossingTree();
    const rootChunk = { cx: chunkOf(tree.x), cz: chunkOf(tree.z) };
    const alone = worldWith(SEED, [rootChunk]);
    const whole = worldWith(SEED, chunksAround(rootChunk, 1));
    const top = oakTrunkTopY(tree);
    // 树干整根都在树根那个区块里，跨出去的只有树冠
    for (let y = tree.rootY; y <= top; y++) {
      expect(alone.getBlock(tree.x, y, tree.z)).toBe(BlockType.OakLog);
    }
    expect(leavesInLayer(alone, tree, top - 1, OAK_CANOPY_RADIUS)).toBeLessThan(
      leavesInLayer(whole, tree, top - 1, OAK_CANOPY_RADIUS),
    );
  });
});
