import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, DEFAULT_SEED, WORLD_MIN_Y } from '../../src/core/constants';
import { Biome, createTerrain, type Terrain } from '../../src/core/terrain';
import { OAK_CANOPY_RADIUS, OAK_TRUNK_MAX, OAK_TRUNK_MIN, TreeSpecies, plantTrees, trunkTopY } from '../../src/core/tree';
import {
  chunkOf,
  chunksAround,
  localOf,
  ORIGIN_CHUNK,
  World,
  type ChunkCoord,
  type ColumnCoord,
} from '../../src/core/world';
import { FLAT_GROUND_Y } from '../helpers/flat-terrain';
import { isTerrainBlock } from '../helpers/terrain-survey';
import {
  canopyRadiusOf,
  chebyshev,
  chunksTouchedBy,
  crossesChunk,
  flatForest,
  footprint,
  LOGS,
  treeKey,
  treesRootedIn,
  woodOf,
  worldCells,
  type Tree,
} from '../helpers/trees';

/**
 * 树的放置与形状（ADR-0005，#79 起三种树）。测试共用的工具在 `tests/helpers/trees.ts`。
 * 树种按群系的分布、云杉的形状、白桦与橡树同形在 tests/core/tree-species.test.ts。
 */

// 两个与 DEFAULT_SEED 无关的种子：树的性质不该只在默认种子下成立。
const SEED = 314_159;
const OTHER_SEED = 777;

/** 找树时扫的区块半径。9×9 个区块、平均一区块一棵，样本够断言密度与形状。 */
const SCAN_RADIUS = 4;

/** 出生列周围不长树的半径（切比雪夫距离），spec 原文是 7 格。 */
const SPAWN_CLEARANCE = 7;

/** 平地上测跨区块与台阶时用的出生列：离原点很远，原点附近照常长树。 */
const FAR_SPAWN = { x: -10_000, z: -10_000 };

/**
 * 树根落在原点周围这片区块里的全部树，按位置排好。
 *
 * 一棵树的树冠最多被 4 个区块各算一遍，所以只留树根落在那个区块里的；只留树根在扫描范围内的，
 * 范围边上那些只伸进来半个树冠的不算，密度才数得准。
 */
function treesIn(placement: Terrain, radius: number): Tree[] {
  return treesRootedIn(placement, chunksAround(ORIGIN_CHUNK, radius)).sort((a, b) => a.x - b.x || a.z - b.z);
}

/** 真实地形下的 treesIn，按种子与半径缓存。 */
const realTrees = new Map<string, Tree[]>();
function realTreesIn(seed: number, radius: number): Tree[] {
  const key = `${seed}:${radius}`;
  let trees = realTrees.get(key);
  if (!trees) {
    trees = treesIn(createTerrain(seed), radius);
    realTrees.set(key, trees);
  }
  return trees;
}

/** 加载了这些区块的世界。加载顺序由调用方给，用来断言顺序不影响结果。 */
function worldWith(terrain: Terrain, coords: Iterable<ChunkCoord>): World {
  const world = new World(terrain.generateChunk);
  for (const { cx, cz } of coords) world.loadChunk(cx, cz);
  return world;
}

/** 「x,y,z」拆回三个数。 */
function parseCell(cell: string): [number, number, number] {
  return cell.split(',').map(Number) as [number, number, number];
}

/**
 * 世界里所有原木所在的列与那一列的原木种类，排好序。
 *
 * 直接数方块，而不是问 `treesTouching`：位置的确定性要在「生成出来的世界」这一层
 * 断言，否则拿同一个纯函数比它自己，任何实现都能通过。
 */
function trunkColumnsIn(world: World, radius: number): string[] {
  const columns: string[] = [];
  const from = -radius * CHUNK_SIZE;
  const to = (radius + 1) * CHUNK_SIZE - 1;
  for (let x = from; x <= to; x++) {
    for (let z = from; z <= to; z++) {
      const top = world.highestBlockY(x, z);
      for (let y = top; y > top - 32; y--) {
        const block = world.getBlock(x, y, z);
        if (LOGS.has(block)) {
          columns.push(`${x},${z}:${block}`);
          break;
        }
      }
    }
  }
  return columns.sort();
}

/** 以树干为中心、半径 radius 的那一层里有几格这种树的树叶。 */
function leavesInLayer(world: World, tree: Tree, y: number, radius: number): number {
  const leaves = woodOf(tree.species).leaves;
  let count = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (world.getBlock(tree.x + dx, y, tree.z + dz) === leaves) count++;
    }
  }
  return count;
}

/**
 * 某一层里树冠格的相对坐标，按 dx,dz 排好：长出了这种树叶的格，加上 shape 里被地形方块占着的格。树叶只往空气里长，
 * 三维密度地形（#75）的平原有起伏，两格外的地面可能高过树冠最下面那层，那一格被地面挡住不算缺。
 */
function canopyLayer(world: World, tree: Tree, y: number, shape: readonly string[]): string[] {
  const leaves = woodOf(tree.species).leaves;
  const cells: string[] = [];
  for (let dx = -OAK_CANOPY_RADIUS; dx <= OAK_CANOPY_RADIUS; dx++) {
    for (let dz = -OAK_CANOPY_RADIUS; dz <= OAK_CANOPY_RADIUS; dz++) {
      const block = world.getBlock(tree.x + dx, y, tree.z + dz);
      const key = `${dx},${dz}`;
      if (block === leaves || (isTerrainBlock(block) && shape.includes(key))) cells.push(key);
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
 * 橡树与白桦四层树冠的形状。原版式橡树冠：最宽两层 5×5 去掉四角，树干顶那层 3×3，
 * 顶上一层是 3×3 去掉四角的十字。树干占着正中那一格，所以除了最上层，正中是原木。
 */
function expectVanillaCanopy(world: World, tree: Tree): void {
  const top = trunkTopY(tree);
  const wide = OAK_CANOPY_RADIUS;
  const layers: Array<[y: number, shape: string[]]> = [
    [top - 2, square(wide, false, '0,0')],
    [top - 1, square(wide, false, '0,0')],
    [top, square(1, true, '0,0')],
    [top + 1, square(1, false)],
  ];
  for (const [y, shape] of layers) {
    expect(canopyLayer(world, tree, y, shape), `${treeKey(tree)} y ${y}`).toEqual(shape);
  }
  // 树冠到此为止，再往上是空气
  expect(leavesInLayer(world, tree, top + 2, wide)).toBe(0);
}

/** 橡树与白桦：形状相同的两种树。 */
function isOakShaped(tree: Tree): boolean {
  return tree.species === TreeSpecies.Oak || tree.species === TreeSpecies.Birch;
}

describe('树的分布', () => {
  it('平原上散布着树：扫描范围内找得到树', () => {
    expect(realTreesIn(SEED, SCAN_RADIUS).length).toBeGreaterThan(0);
  });

  it('是散布而不是森林：平均每个区块半棵到两棵', () => {
    const perChunk = realTreesIn(SEED, SCAN_RADIUS).length / (2 * SCAN_RADIUS + 1) ** 2;
    expect(perChunk).toBeGreaterThan(0.5);
    expect(perChunk).toBeLessThan(2);
  });

  it('两棵树的原木与树叶不落在同一格，树冠因此不会互相穿插', () => {
    const owner = new Map<string, string>();
    const overlaps: string[] = [];
    for (const tree of realTreesIn(SEED, SCAN_RADIUS)) {
      for (const cell of worldCells(tree).keys()) {
        const other = owner.get(cell);
        if (other) overlaps.push(`${other} 与 ${treeKey(tree)} 都占 ${cell}`);
        owner.set(cell, treeKey(tree));
      }
    }
    expect(overlaps.slice(0, 20)).toEqual([]);
  });

  it('橡树与白桦的树干高度在 4 与 6 之间变化，不是一个定值', () => {
    const heights = realTreesIn(SEED, SCAN_RADIUS)
      .filter(isOakShaped)
      .map((tree) => tree.trunkHeight);
    const expected: number[] = [];
    for (let h = OAK_TRUNK_MIN; h <= OAK_TRUNK_MAX; h++) expected.push(h);
    expect([...new Set(heights)].sort((a, b) => a - b)).toEqual(expected);
  });

  it('出生列周围 7 格内没有树根', () => {
    for (const seed of [SEED, OTHER_SEED, DEFAULT_SEED]) {
      const spawn = createTerrain(seed).spawnColumn;
      const tooClose = realTreesIn(seed, SCAN_RADIUS)
        .filter((t) => chebyshev(t, spawn) <= SPAWN_CLEARANCE)
        .map(treeKey);
      expect(tooClose, `种子 ${seed}`).toEqual([]);
    }
  });
});

/**
 * 树避开的是出生列周围 7 格，不是原点（#84），三种树都是（#79）。真实地形的出生列几乎总是原点，所以这里用群系固定的平地
 * 地形对象（`flatForest`），把出生列换到别处：平地上地表一样高，哪里长不长树、长哪种只由种子与群系决定。
 * 平原里长橡树与白桦，高山（雪线以下）与冰雪里长云杉，三个群系各测一遍。
 */
describe.each([
  ['平原', Biome.Plains],
  ['高山', Biome.Mountains],
  ['冰雪', Biome.Snowy],
] as const)('%s的树避开出生列', (_name, biome) => {
  /** 出生列换到这里：远离原点，x 正、z 负。 */
  const SPAWN = { x: 208, z: -192 };
  /** 对照：出生列放在离原点与 SPAWN 都很远的地方。 */
  const ELSEWHERE = { x: -500, z: 500 };
  /** 换出生列用的种子：够多，原点与新出生列附近才一定有种子本该长树，平原里两种树都碰得到。 */
  const CLEARANCE_SEEDS = Array.from({ length: 48 }, (_, i) => 1_000 + i * 7_919);

  function forest(seed: number, spawnColumn: ColumnCoord): Terrain {
    return flatForest(seed, biome, { spawnColumn });
  }

  /** 列 at 周围 7 格所在的区块。 */
  function chunksNear(at: ColumnCoord): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let cx = chunkOf(at.x - SPAWN_CLEARANCE); cx <= chunkOf(at.x + SPAWN_CLEARANCE); cx++) {
      for (let cz = chunkOf(at.z - SPAWN_CLEARANCE); cz <= chunkOf(at.z + SPAWN_CLEARANCE); cz++) coords.push({ cx, cz });
    }
    return coords;
  }

  /** 树根落在 at 周围 7 格内的树（切比雪夫距离）。 */
  function treesNear(placement: Terrain, at: ColumnCoord): Tree[] {
    return treesRootedIn(placement, chunksNear(at)).filter((tree) => chebyshev(tree, at) <= SPAWN_CLEARANCE);
  }

  it('出生列在别处时，出生列周围 7 格内没有树根', () => {
    for (const seed of CLEARANCE_SEEDS) {
      expect(treesNear(forest(seed, SPAWN), SPAWN).map(treeKey), `种子 ${seed}`).toEqual([]);
    }
  });

  it('出生列在别处时，生成出来的区块里出生列周围 7 格内没有原木', () => {
    const wrong: string[] = [];
    for (const seed of CLEARANCE_SEEDS) {
      const terrain = forest(seed, SPAWN);
      for (const { cx, cz } of chunksNear(SPAWN)) {
        const chunk = terrain.generateChunk(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const column = { x: cx * CHUNK_SIZE + lx, z: cz * CHUNK_SIZE + lz };
            if (chebyshev(column, SPAWN) > SPAWN_CLEARANCE) continue;
            for (let y = FLAT_GROUND_Y + 1; y <= FLAT_GROUND_Y + 32; y++) {
              if (LOGS.has(chunk.get(lx, y, lz))) wrong.push(`种子 ${seed} (${column.x}, ${y}, ${column.z})`);
            }
          }
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('出生列在更远处时，那 7 格里本来会长这个群系的树，上面两条因此测得到东西', () => {
    const near = CLEARANCE_SEEDS.flatMap((seed) => treesNear(forest(seed, ELSEWHERE), SPAWN));
    const expected = biome === Biome.Plains ? [TreeSpecies.Birch, TreeSpecies.Oak] : [TreeSpecies.Spruce];
    expect([...new Set(near.map((tree) => tree.species))].sort()).toEqual([...expected].sort());
  });

  it('出生列在原点时原点附近没有树，别处的树与出生列在更远处时一样', () => {
    for (const seed of CLEARANCE_SEEDS) {
      const atOrigin = forest(seed, { x: 0, z: 0 });
      const atSpawn = forest(seed, SPAWN);
      const elsewhere = forest(seed, ELSEWHERE);
      expect(treesNear(atOrigin, { x: 0, z: 0 }), `种子 ${seed}`).toEqual([]);
      expect(treesNear(atSpawn, { x: 0, z: 0 }), `种子 ${seed}`).toEqual(treesNear(elsewhere, { x: 0, z: 0 }));
      expect(treesNear(atOrigin, SPAWN), `种子 ${seed}`).toEqual(treesNear(elsewhere, SPAWN));
    }
  });
});

describe('树的位置与树种由种子决定', () => {
  // 树根落在内圈的树才有完整的树冠，位置比对因此只看内圈那片区块
  const radius = SCAN_RADIUS - 1;
  const around = chunksAround(ORIGIN_CHUNK, SCAN_RADIUS);

  it('同一种子、不同加载顺序，长出来的树在同样的位置、是同一种', () => {
    const forwards = trunkColumnsIn(worldWith(createTerrain(SEED), around), radius);
    const backwards = trunkColumnsIn(worldWith(createTerrain(SEED), [...around].reverse()), radius);
    expect(forwards.length).toBeGreaterThan(10);
    expect(backwards).toEqual(forwards);
  });

  it('世界里的树就是 treesTouching 算出的那些，原木是各自树种的原木', () => {
    const world = worldWith(createTerrain(SEED), around);
    const predicted = realTreesIn(SEED, radius)
      .map((tree) => `${tree.x},${tree.z}:${woodOf(tree.species).log}`)
      .sort();
    expect(trunkColumnsIn(world, radius)).toEqual(predicted);
  });

  it('两个独立构造的地形对象给出同样的树与树种', () => {
    expect(treesIn(createTerrain(SEED), SCAN_RADIUS)).toEqual(treesIn(createTerrain(SEED), SCAN_RADIUS));
  });

  it('换种子树就长在别处', () => {
    const mine = trunkColumnsIn(worldWith(createTerrain(SEED), around), radius);
    const theirs = trunkColumnsIn(worldWith(createTerrain(OTHER_SEED), around), radius);
    expect(theirs).not.toEqual(mine);
  });
});

describe('生成出来的树', () => {
  // 只看树根落在扫描范围内圈的树：它们四周的区块都加载了，树冠是完整的。
  let cachedWorld: World | undefined;
  const world = (): World => (cachedWorld ??= worldWith(createTerrain(SEED), chunksAround(ORIGIN_CHUNK, SCAN_RADIUS)));
  const trees = (): Tree[] => realTreesIn(SEED, SCAN_RADIUS - 1);

  it('有树可查', () => {
    expect(trees().length).toBeGreaterThan(10);
  });

  it('树干正下方是草方块或雪草方块', () => {
    const wrong: string[] = [];
    for (const tree of trees()) {
      const below = world().getBlock(tree.x, tree.rootY - 1, tree.z);
      if (below !== BlockType.Grass && below !== BlockType.SnowyGrass) wrong.push(`${treeKey(tree)} 下方是 ${below}`);
    }
    expect(wrong).toEqual([]);
  });

  it('树干是连续的这种树的原木；橡树与白桦是 4–6 格', () => {
    const wrong: string[] = [];
    for (const tree of trees()) {
      const log = woodOf(tree.species).log;
      if (isOakShaped(tree) && (tree.trunkHeight < OAK_TRUNK_MIN || tree.trunkHeight > OAK_TRUNK_MAX)) {
        wrong.push(`${treeKey(tree)} 树干 ${tree.trunkHeight} 格`);
      }
      for (let y = tree.rootY; y <= trunkTopY(tree); y++) {
        const block = world().getBlock(tree.x, y, tree.z);
        if (block !== log) wrong.push(`${treeKey(tree)} y ${y} 是 ${block}`);
      }
      // 树干上下都不是原木，「连续」说的就是这一段
      if (LOGS.has(world().getBlock(tree.x, tree.rootY - 1, tree.z))) wrong.push(`${treeKey(tree)} 树根之下还有原木`);
      if (LOGS.has(world().getBlock(tree.x, trunkTopY(tree) + 1, tree.z))) wrong.push(`${treeKey(tree)} 树干顶上还有原木`);
    }
    expect(wrong).toEqual([]);
  });

  it('每一棵橡树与白桦的树冠都是原版式形状：两层 5×5 去掉四角、一层 3×3、顶上一层十字', () => {
    // 树冠互不重叠（见上面那条），所以每一棵都能逐格断言，不必挑「孤立」的那些
    const oakShaped = trees().filter(isOakShaped);
    expect(oakShaped.length).toBeGreaterThan(0);
    for (const tree of oakShaped) expectVanillaCanopy(world(), tree);
  });

  it('树干顶上那一格是这种树的树叶', () => {
    for (const tree of trees()) {
      expect(world().getBlock(tree.x, trunkTopY(tree) + 1, tree.z), treeKey(tree)).toBe(woodOf(tree.species).leaves);
    }
  });
});

describe.each([
  ['平原（橡树与白桦）', Biome.Plains],
  ['高山（云杉）', Biome.Mountains],
] as const)('%s的树叶只往空气里长', (_name, biome) => {
  /** 人造地形的基准地表高度。 */
  const LEDGE_BASE_Y = 70;

  /** 按某个地表高度函数在一个区块里铺一层草，其余是空气。 */
  function groundOnly(cx: number, cz: number, surfaceAt: (x: number, z: number) => number): Chunk {
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
    // 真实地形里这条规则只在坡陡的地方触发，哪棵树碰得到要看种子。放树只认一个「地表高度」函数，所以给它一道
    // 确定的陡台阶：某棵树落在矮的那半边，树冠伸进高的那半边的地里去，规则本身因此被测到。
    // 挑整棵都在自己区块里的那棵，只种这一个区块就够。
    const base = flatForest(SEED, biome, { spawnColumn: FAR_SPAWN });
    const tree = treesIn(base, SCAN_RADIUS).find((t) => !crossesChunk(t));
    if (!tree) throw new Error('扫描范围内应有不跨区块的树');
    // 台阶比基准高出树干高度减一格：顶面在树干顶之下一格，覆盖树干顶之下的树冠层
    const step = tree.trunkHeight - 1;
    const cx = chunkOf(tree.x);
    const cz = chunkOf(tree.z);
    const surfaceAt = (_x: number, z: number): number => (z > tree.z ? LEDGE_BASE_Y + step : LEDGE_BASE_Y);
    const chunk = groundOnly(cx, cz, surfaceAt);
    plantTrees({ ...base, surfaceHeightAt: surfaceAt }, chunk);

    const eaten: string[] = [];
    let planted = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const surface = surfaceAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
        for (let y = LEDGE_BASE_Y - 1; y <= surface + 32; y++) {
          const block = chunk.get(lx, y, lz);
          if (y <= surface && block !== BlockType.Grass) eaten.push(`(${lx}, ${y}, ${lz}) 的草方块变成了 ${block}`);
          if (y > surface && block !== BlockType.Air) planted++;
        }
      }
    }
    // 树确实长了，树冠确实有格落在台阶那一侧的地里，否则这条测不到东西
    expect(planted).toBeGreaterThan(0);
    const buried = footprint(tree).filter(
      ({ dz, dy, block }) => !LOGS.has(block) && dz > 0 && tree.rootY + dy <= LEDGE_BASE_Y + step,
    );
    expect(buried.length, '落在台阶里的树冠格').toBeGreaterThan(0);
    expect(eaten).toEqual([]);
  });
});

/**
 * 跨区块边界的树（ADR-0005）：三种树各测一遍。用群系固定的平地（`flatForest`），地面平整，树冠不会被地面挡住，
 * 所以几个区块里的部分合起来必须与 `footprint`（同一棵树种在一个全空气区块里）逐格相同。
 * 真实地形下的同一条在 tests/core/terrain-generation.test.ts。
 */
describe.each([
  ['橡树', Biome.Plains, 'Oak'],
  ['白桦', Biome.Plains, 'Birch'],
  ['云杉', Biome.Mountains, 'Spruce'],
] as const)('跨区块边界的%s', (_name, biome, speciesKey) => {
  const terrain = flatForest(SEED, biome, { spawnColumn: FAR_SPAWN });
  const loaded = chunksAround(ORIGIN_CHUNK, SCAN_RADIUS);
  const inLoaded = ({ cx, cz }: ChunkCoord): boolean => Math.abs(cx) <= SCAN_RADIUS && Math.abs(cz) <= SCAN_RADIUS;

  /** 树冠伸出了树根所在区块、各格都落在已加载区块里的这种树。 */
  const crossing = (): Tree[] => {
    const species = TreeSpecies[speciesKey];
    return treesIn(terrain, SCAN_RADIUS).filter(
      (tree) => tree.species === species && crossesChunk(tree) && chunksTouchedBy(tree).every(inLoaded),
    );
  };

  /** 树连同它周围一圈的方块，转换成可比较的字符串。 */
  function dumpAround(world: World, tree: Tree): string[] {
    const cells = footprint(tree);
    const reach = Math.max(...cells.map(({ dx, dz }) => Math.max(Math.abs(dx), Math.abs(dz)))) + 1;
    const maxDy = Math.max(...cells.map(({ dy }) => dy)) + 1;
    const lines: string[] = [];
    for (let dy = -1; dy <= maxDy; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          lines.push(`${dx},${dy},${dz}: ${world.getBlock(tree.x + dx, tree.rootY + dy, tree.z + dz)}`);
        }
      }
    }
    return lines;
  }

  /** 世界里这棵树的各格与 footprint 不同的地方。 */
  function mismatches(world: World, tree: Tree): string[] {
    const wrong: string[] = [];
    for (const [cell, block] of worldCells(tree)) {
      const actual = world.getBlock(...parseCell(cell));
      if (actual !== block) wrong.push(`${treeKey(tree)} (${cell}) 应为 ${block}，实为 ${actual}`);
    }
    return wrong;
  }

  it('扫描范围内有这样的树', () => {
    expect(crossing().length).toBeGreaterThanOrEqual(3);
  });

  it('每一棵在几个区块里的部分合起来，与种在一个区块里的同一棵树逐格相同', () => {
    // 逐格断言，而不是「两种加载顺序结果相同」——后者在任何实现下都成立，
    // 邻居区块漏写半个树冠时两边一样地漏，测不出东西来。
    const world = worldWith(terrain, loaded);
    expect(crossing().flatMap((tree) => mismatches(world, tree)).slice(0, 20)).toEqual([]);
  });

  it('先加载哪个区块都得到同一棵树', () => {
    for (const tree of crossing().slice(0, 3)) {
      const around = chunksTouchedBy(tree);
      const forwards = worldWith(terrain, around);
      const backwards = worldWith(terrain, [...around].reverse());
      expect(dumpAround(backwards, tree), treeKey(tree)).toEqual(dumpAround(forwards, tree));
    }
  });

  it('只加载树根那个区块时，伸出去的那部分树冠不在世界里', () => {
    const tree = crossing()[0];
    if (!tree) throw new Error('扫描范围内应有树冠跨过区块边界的树');
    const rootChunk = { cx: chunkOf(tree.x), cz: chunkOf(tree.z) };
    const alone = worldWith(terrain, [rootChunk]);
    // 树干整根都在树根那个区块里，跨出去的只有树冠
    for (let y = tree.rootY; y <= trunkTopY(tree); y++) expect(alone.getBlock(tree.x, y, tree.z)).toBe(woodOf(tree.species).log);
    const outside = [...worldCells(tree).keys()].filter((cell) => {
      const [x, , z] = parseCell(cell);
      return chunkOf(x) !== rootChunk.cx || chunkOf(z) !== rootChunk.cz;
    });
    expect(outside.length).toBeGreaterThan(0);
    for (const cell of outside) expect(alone.getBlock(...parseCell(cell)), cell).toBe(BlockType.Air);
  });

  if (speciesKey === 'Spruce') {
    it('树冠伸得最远的那一圈正好越过区块边的云杉，那一圈也写上了（扫描半径按两种树冠中较大的算）', () => {
      // 云杉树冠半径 R（不超过 3，可能大于橡树的 2）：树根在区块里第 R − 1 列或第 16 − R 列时，
      // 树冠最外一圈正好落在邻区块的第 15 列或第 0 列。扫描半径按橡树算就会漏掉这一圈。
      const trees = crossing();
      const radius = Math.max(0, ...trees.map((tree) => canopyRadiusOf(footprint(tree))));
      const edgeLocals = [radius - 1, CHUNK_SIZE - radius];
      const reachingOut = trees.filter(
        (tree) =>
          (edgeLocals.includes(localOf(tree.x)) || edgeLocals.includes(localOf(tree.z))) &&
          canopyRadiusOf(footprint(tree)) === radius,
      );
      expect(reachingOut.length, `树冠半径 ${radius}、树根离区块边 ${radius} 格的云杉`).toBeGreaterThan(0);
      const world = worldWith(terrain, loaded);
      expect(reachingOut.flatMap((tree) => mismatches(world, tree)).slice(0, 20)).toEqual([]);
    });
  }
});
