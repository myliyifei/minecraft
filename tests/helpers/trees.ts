import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MIN_Y } from '../../src/core/constants';
import { SNOW_LINE_Y } from '../../src/core/surface';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { plantTree, plantTrees, TreeSpecies, treesTouching, trunkTopY, type Tree, type TreePlacement } from '../../src/core/tree';
import { chunkOf, type ChunkCoord } from '../../src/core/world';
import { FLAT_GROUND_Y } from './flat-terrain';
import { BIRCH, OAK, SPRUCE, type WoodSpecies } from './wood-species';

/**
 * 三种树（#79）几个测试共用的工具：树的形状（`footprint`）、群系固定的平地（`flatForest`）、
 * 真实地形的大范围树木采样（`surveyTrees`）。
 */

export type { Tree };

/** 测试要用的 `tree.ts` 导出。 */
export interface TreeApi {
  readonly TreeSpecies: typeof TreeSpecies;
  readonly treesTouching: typeof treesTouching;
  readonly plantTrees: typeof plantTrees;
  readonly plantTree: typeof plantTree;
  readonly trunkTopY: typeof trunkTopY;
}

const API: TreeApi = { TreeSpecies, treesTouching, plantTrees, plantTree, trunkTopY };

/** `tree.ts` 的三种树接口。测试先于实现写成时，这里按名称取导出、缺了按断言报出来；现在直接 import。 */
export function treeApi(): TreeApi {
  return API;
}

/** 树种对应的原木、树叶等方块（`wood-species.ts` 的表）。 */
export function woodOf(species: TreeSpecies): WoodSpecies {
  if (species === TreeSpecies.Oak) return OAK;
  if (species === TreeSpecies.Birch) return BIRCH;
  if (species === TreeSpecies.Spruce) return SPRUCE;
  throw new Error(`未知树种 ${species}`);
}

/** 三种原木。 */
export const LOGS: ReadonlySet<BlockType> = new Set([BlockType.OakLog, BlockType.BirchLog, BlockType.SpruceLog]);

/** 三种树叶。 */
export const LEAVES: ReadonlySet<BlockType> = new Set([BlockType.OakLeaves, BlockType.BirchLeaves, BlockType.SpruceLeaves]);

/** 两棵树的切比雪夫距离（水平）。 */
export function chebyshev(a: ColumnCoord, b: ColumnCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/** 树的标识：位置与树种。 */
export function treeKey(tree: Tree): string {
  return `${tree.x},${tree.z}:${tree.species}`;
}

/** 一棵树的一格，相对树根：dy 相对 rootY。 */
export interface TreeCell {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly block: BlockType;
}

/** footprint 放树的那一列（区块 (0, 0) 里），四周各留 8 格，足够任何半径不超过 7 的树冠。 */
const FOOTPRINT_COLUMN = 8;
/** footprint 往上读多少层。 */
const FOOTPRINT_HEIGHT = 64;

/**
 * 一棵树的形状：把它平移到一个全空气区块里调 `plantTree`，读出相对树根的全部非空气格，按 dy、dz、dx 排好。
 * 全空气区块里树叶不会被地面挡住，读到的就是完整的树。
 */
export function footprint(tree: Tree): TreeCell[] {
  const api = treeApi();
  const chunk = new Chunk(0, 0);
  api.plantTree(chunk, { ...tree, x: FOOTPRINT_COLUMN, z: FOOTPRINT_COLUMN });
  const cells: TreeCell[] = [];
  for (let dy = -1; dy <= FOOTPRINT_HEIGHT; dy++) {
    for (let dz = -FOOTPRINT_COLUMN; dz < CHUNK_SIZE - FOOTPRINT_COLUMN; dz++) {
      for (let dx = -FOOTPRINT_COLUMN; dx < CHUNK_SIZE - FOOTPRINT_COLUMN; dx++) {
        const block = chunk.get(FOOTPRINT_COLUMN + dx, tree.rootY + dy, FOOTPRINT_COLUMN + dz);
        if (block !== BlockType.Air) cells.push({ dx, dy, dz, block });
      }
    }
  }
  return cells;
}

/** 树冠的水平半径：树叶格与树干那一列的切比雪夫距离的最大值。 */
export function canopyRadiusOf(cells: readonly TreeCell[]): number {
  let radius = 0;
  for (const { dx, dz, block } of cells) {
    if (LEAVES.has(block)) radius = Math.max(radius, Math.abs(dx), Math.abs(dz));
  }
  return radius;
}

/** 这棵树的各格在世界里的坐标与方块，键是「x,y,z」。 */
export function worldCells(tree: Tree): Map<string, BlockType> {
  const cells = new Map<string, BlockType>();
  for (const { dx, dy, dz, block } of footprint(tree)) {
    cells.set(`${tree.x + dx},${tree.rootY + dy},${tree.z + dz}`, block);
  }
  return cells;
}

/** 这棵树的各格落在哪些区块里。 */
export function chunksTouchedBy(tree: Tree): ChunkCoord[] {
  const seen = new Map<string, ChunkCoord>();
  for (const { dx, dz } of footprint(tree)) {
    const coord = { cx: chunkOf(tree.x + dx), cz: chunkOf(tree.z + dz) };
    seen.set(`${coord.cx},${coord.cz}`, coord);
  }
  return [...seen.values()];
}

/** 这棵树有没有格落在树根所在区块之外。 */
export function crossesChunk(tree: Tree): boolean {
  return chunksTouchedBy(tree).length > 1;
}

/** 平地的列顶地表方块：冰雪与雪线以上的高山是雪草方块，其余是草方块（与 `surface.ts` 的规则一致）。 */
function flatTopBlock(biome: Biome, surfaceY: number): BlockType {
  if (biome === Biome.Snowy || (biome === Biome.Mountains && surfaceY >= SNOW_LINE_Y)) return BlockType.SnowyGrass;
  return BlockType.Grass;
}

/** `flatForest` 的选项。 */
export interface FlatForestOptions {
  /** 每一列的群系，缺省处处是 `biome`。 */
  readonly biomeAt?: (x: number, z: number) => Biome;
  /** 地表高度，缺省 `FLAT_GROUND_Y`（70）。 */
  readonly surfaceY?: number;
  /** 出生列，缺省原点。 */
  readonly spawnColumn?: ColumnCoord;
}

/**
 * 群系固定的平地地形对象：地表一样高，列顶是草方块（冰雪与雪线以上的高山是雪草方块），往下石头到底。
 * 生成器先铺平地再调 `plantTrees`，哪里长什么树只由种子与群系决定，样本可以放得很大。
 */
export function flatForest(seed: number, biome: Biome, options: FlatForestOptions = {}): Terrain {
  const surfaceY = options.surfaceY ?? FLAT_GROUND_Y;
  const biomeAt = options.biomeAt ?? (() => biome);
  const placement: Omit<Terrain, 'generateChunk'> = {
    seed,
    biomeAt,
    surfaceHeightAt: () => surfaceY,
    surfaceBlockAt: (x, z) => flatTopBlock(biomeAt(x, z), surfaceY),
    spawnColumn: options.spawnColumn ?? { x: 0, z: 0 },
  };
  return {
    ...placement,
    generateChunk: (cx, cz) => {
      const chunk = new Chunk(cx, cz);
      chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const top = placement.surfaceBlockAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
          chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, surfaceY - 1, BlockType.Stone);
          chunk.set(lx, surfaceY, lz, top);
        }
      }
      treeApi().plantTrees(placement, chunk);
      return chunk;
    },
  };
}

/**
 * 树根落在这些区块里的全部树，每棵只算一次（树冠伸进别的区块时 `treesTouching` 在那边也会给出它）。
 */
export function treesRootedIn(placement: TreePlacement, coords: Iterable<ChunkCoord>): Tree[] {
  const api = treeApi();
  const trees: Tree[] = [];
  for (const { cx, cz } of coords) {
    for (const tree of api.treesTouching(placement, cx, cz)) {
      if (chunkOf(tree.x) === cx && chunkOf(tree.z) === cz) trees.push(tree);
    }
  }
  return trees;
}

/** 大范围采样的区块：cx、cz 在 [−SURVEY_HALF_CHUNKS, SURVEY_HALF_CHUNKS]、步长 SURVEY_CHUNK_STEP，共 81×81 个。 */
export const SURVEY_HALF_CHUNKS = 160;
export const SURVEY_CHUNK_STEP = 4;

/** 大范围采样的区块坐标，按 cz、cx 排好。 */
export function* surveyChunks(): Generator<ChunkCoord> {
  for (let cz = -SURVEY_HALF_CHUNKS; cz <= SURVEY_HALF_CHUNKS; cz += SURVEY_CHUNK_STEP) {
    for (let cx = -SURVEY_HALF_CHUNKS; cx <= SURVEY_HALF_CHUNKS; cx += SURVEY_CHUNK_STEP) yield { cx, cz };
  }
}

/** 采样到的一棵树与它树根那一列的群系。 */
export interface SurveyedTree {
  readonly tree: Tree;
  readonly biome: Biome;
}

const surveyCache = new Map<number, SurveyedTree[]>();

/**
 * 真实地形的大范围树木采样：`surveyChunks` 的每个区块调一次 `treesTouching`，只留树根落在那个区块里的树，
 * 记下树根那一列的群系。按种子缓存。
 */
export function surveyTrees(seed: number): SurveyedTree[] {
  const cached = surveyCache.get(seed);
  if (cached) return cached;
  const terrain = createTerrain(seed);
  const found = treesRootedIn(terrain, surveyChunks()).map((tree) => ({ tree, biome: terrain.biomeAt(tree.x, tree.z) }));
  surveyCache.set(seed, found);
  return found;
}
