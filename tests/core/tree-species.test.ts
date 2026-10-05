import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { SNOW_LINE_Y } from '../../src/core/surface';
import { Biome, createTerrain, type ColumnCoord, type Terrain } from '../../src/core/terrain';
import { OAK_TRUNK_MAX, OAK_TRUNK_MIN } from '../../src/core/tree';
import type { ChunkCoord } from '../../src/core/world';
import { chunkCache, columnIn, SURVEY_SEEDS } from '../helpers/terrain-survey';
import {
  canopyRadiusOf,
  chunksTouchedBy,
  crossesChunk,
  flatForest,
  footprint,
  LEAVES,
  LOGS,
  surveyChunks,
  surveyTrees,
  treeApi,
  treeKey,
  treesRootedIn,
  type SurveyedTree,
  type Tree,
  type TreeCell,
} from '../helpers/trees';
import { BIRCH, OAK, SPRUCE } from '../helpers/wood-species';

/**
 * 树种按群系分布（#79）：平原长橡树、约三成白桦；高山雪线以下长云杉，雪线以上不长；冰雪零散长云杉；大海与沙滩不长。
 * 白桦与橡树同形，云杉是尖塔形树冠、半径不超过 3。接缝与判定方法见 .scratch/seams-79.md。
 *
 * 统计方法：真实地形每个种子取 `surveyChunks`（区块坐标 cx、cz 在 [−160, 160]、步长 4，共 6561 个区块），
 * 每个区块调一次 `treesTouching`，只留树根落在这个区块里的树，所以每棵树只算一次；按树根那一列的群系归类。
 * 现有代码下每个种子平原约 2000 棵、高山约 900 棵、冰雪约 1000 到 1250 棵。
 *
 * 生成出来的方块另按群系挑区块检查：取 `surveyChunks` 里中心那一列（区块内第 8 列、第 8 行）满足条件的区块，
 * 均匀挑若干个生成。
 */

/** 树根能落在哪些列顶地表方块上（CONTEXT.md「树」）。 */
const TREE_GROUND: ReadonlySet<BlockType> = new Set([BlockType.Grass, BlockType.SnowyGrass]);

/** 平原里白桦占橡树与白桦合计的比例，验收条件给的范围。 */
const BIRCH_SHARE_MIN = 0.2;
const BIRCH_SHARE_MAX = 0.4;

/** 算白桦占比时每个种子平原里至少要有这么多棵树，比例的标准误差才在 0.02 以内。 */
const MIN_PLAINS_SAMPLE = 500;

/** 每个种子按群系挑多少个区块生成出来检查方块。 */
const CHUNKS_PER_SITE = 24;

/** 每个种子逐棵检查形状的树最多取多少棵。 */
const SHAPE_SAMPLE = 120;

const chunkAt = chunkCache(createTerrain);

const terrains = new Map<number, Terrain>();
function terrainOf(seed: number): Terrain {
  let terrain = terrains.get(seed);
  if (!terrain) {
    terrain = createTerrain(seed);
    terrains.set(seed, terrain);
  }
  return terrain;
}

/** 从一串里均匀挑 n 个。 */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(items[Math.floor((i * items.length) / n)]!);
  return picked;
}

/** 采样到的、树根在这个群系里的树。 */
function treesOfBiome(seed: number, biome: Biome): Tree[] {
  return surveyTrees(seed)
    .filter((surveyed) => surveyed.biome === biome)
    .map((surveyed) => surveyed.tree);
}

/** 一串树里每种树各有几棵。 */
function countBySpecies(trees: readonly Tree[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tree of trees) counts.set(tree.species, (counts.get(tree.species) ?? 0) + 1);
  return counts;
}

/** 一串树的树种，去重排好。 */
function speciesOf(trees: readonly Tree[]): string[] {
  return [...new Set(trees.map((tree) => tree.species))].sort();
}

/**
 * `surveyChunks` 里中心那一列满足条件的区块，均匀挑 n 个。中心列取区块内第 8 列、第 8 行。
 */
const sitesCache = new Map<string, ChunkCoord[]>();
function sitesWhere(seed: number, name: string, test: (terrain: Terrain, column: ColumnCoord) => boolean): ChunkCoord[] {
  const key = `${seed}:${name}`;
  const cached = sitesCache.get(key);
  if (cached) return cached;
  const terrain = terrainOf(seed);
  const found: ChunkCoord[] = [];
  for (const coord of surveyChunks()) {
    if (test(terrain, columnIn(coord, CHUNK_SIZE / 2, CHUNK_SIZE / 2))) found.push(coord);
  }
  const sites = spread(found, CHUNKS_PER_SITE);
  sitesCache.set(key, sites);
  return sites;
}

/** 高山里地表在雪线以上至少 8 格的区块：区块里大半的列都在雪线以上。 */
const aboveSnowLine = (terrain: Terrain, { x, z }: ColumnCoord): boolean =>
  terrain.biomeAt(x, z) === Biome.Mountains && terrain.surfaceHeightAt(x, z) >= SNOW_LINE_Y + 8;

/** 高山里地表在海平面以上 8 格、雪线以下 24 格之间的区块。 */
const belowSnowLine = (terrain: Terrain, { x, z }: ColumnCoord): boolean => {
  if (terrain.biomeAt(x, z) !== Biome.Mountains) return false;
  const surface = terrain.surfaceHeightAt(x, z);
  return surface > SEA_LEVEL + 8 && surface < SNOW_LINE_Y - 24;
};

/** 冰雪里地表高于海平面的区块。 */
const snowyLand = (terrain: Terrain, { x, z }: ColumnCoord): boolean =>
  terrain.biomeAt(x, z) === Biome.Snowy && terrain.surfaceHeightAt(x, z) > SEA_LEVEL;

/** 平原里地表高于海平面的区块。 */
const plainsLand = (terrain: Terrain, { x, z }: ColumnCoord): boolean =>
  terrain.biomeAt(x, z) === Biome.Plains && terrain.surfaceHeightAt(x, z) > SEA_LEVEL;

/** 不是大海、列顶是沙子、地表高于海平面的区块：沙滩。 */
const beach = (terrain: Terrain, { x, z }: ColumnCoord): boolean =>
  terrain.biomeAt(x, z) !== Biome.Ocean &&
  terrain.surfaceBlockAt(x, z) === BlockType.Sand &&
  terrain.surfaceHeightAt(x, z) > SEA_LEVEL;

/** 生成出来的区块里的一根树干：最下面那格原木与它下面那格。 */
interface Trunk {
  readonly x: number;
  readonly z: number;
  readonly rootY: number;
  readonly log: BlockType;
  readonly below: BlockType;
}

/** 区块里每一根树干（原木下面不是原木的那一格算树根），从方块里直接读，不问 `treesTouching`。 */
function trunksIn(chunk: Chunk, coord: ChunkCoord): Trunk[] {
  const trunks: Trunk[] = [];
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let y = WORLD_MIN_Y + 1; y <= WORLD_MAX_Y; y++) {
        const block = chunk.get(lx, y, lz);
        if (!LOGS.has(block)) continue;
        const below = chunk.get(lx, y - 1, lz);
        if (LOGS.has(below)) continue;
        const { x, z } = columnIn(coord, lx, lz);
        trunks.push({ x, z, rootY: y, log: block, below });
      }
    }
  }
  return trunks;
}

/** 这些区块里的全部树干。 */
function trunksAt(seed: number, coords: readonly ChunkCoord[]): Trunk[] {
  return coords.flatMap((coord) => trunksIn(chunkAt(seed, coord), coord));
}

function trunkKey(trunk: Trunk): string {
  return `(${trunk.x}, ${trunk.rootY}, ${trunk.z}) 原木 ${trunk.log} 下面 ${trunk.below}`;
}

describe('树种按群系分布（真实地形大范围采样）', () => {
  it.each(SURVEY_SEEDS)('种子 %i：平原的树里橡树与白桦都有，没有云杉', (seed) => {
    const { TreeSpecies } = treeApi();
    const plains = treesOfBiome(seed, Biome.Plains);
    expect(plains.length, '平原的树').toBeGreaterThanOrEqual(MIN_PLAINS_SAMPLE);
    expect(speciesOf(plains)).toEqual([TreeSpecies.Birch, TreeSpecies.Oak].sort());
  });

  it.each(SURVEY_SEEDS)(
    `种子 %i：平原的树里白桦占 ${BIRCH_SHARE_MIN * 100}% 到 ${BIRCH_SHARE_MAX * 100}%（按树根计数）`,
    (seed) => {
      const { TreeSpecies } = treeApi();
      const counts = countBySpecies(treesOfBiome(seed, Biome.Plains));
      const birch = counts.get(TreeSpecies.Birch) ?? 0;
      const oak = counts.get(TreeSpecies.Oak) ?? 0;
      expect(birch + oak, '平原的橡树与白桦').toBeGreaterThanOrEqual(MIN_PLAINS_SAMPLE);
      const share = birch / (birch + oak);
      expect(share, `白桦 ${birch} 棵、橡树 ${oak} 棵`).toBeGreaterThanOrEqual(BIRCH_SHARE_MIN);
      expect(share, `白桦 ${birch} 棵、橡树 ${oak} 棵`).toBeLessThanOrEqual(BIRCH_SHARE_MAX);
    },
  );

  it.each(SURVEY_SEEDS)('种子 %i：高山的树全是云杉，树根那一列的地表都在雪线以下', (seed) => {
    const { TreeSpecies } = treeApi();
    const terrain = terrainOf(seed);
    const mountains = treesOfBiome(seed, Biome.Mountains);
    expect(mountains.length, '高山的树').toBeGreaterThan(0);
    expect(speciesOf(mountains)).toEqual([TreeSpecies.Spruce]);
    const aboveLine = mountains
      .filter((tree) => terrain.surfaceHeightAt(tree.x, tree.z) >= SNOW_LINE_Y)
      .map((tree) => `${treeKey(tree)} 地表 ${terrain.surfaceHeightAt(tree.x, tree.z)}`);
    expect(aboveLine.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：冰雪零散长着云杉，全是云杉', (seed) => {
    const { TreeSpecies } = treeApi();
    const snowy = treesOfBiome(seed, Biome.Snowy);
    expect(snowy.length, '冰雪的树').toBeGreaterThan(0);
    expect(speciesOf(snowy)).toEqual([TreeSpecies.Spruce]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：大海里没有树根；每个树根的列顶是草方块或雪草方块、地表高于海平面、树根在地表之上一格', (seed) => {
    const terrain = terrainOf(seed);
    const wrong: string[] = [];
    for (const { tree, biome } of surveyTrees(seed)) {
      const surface = terrain.surfaceHeightAt(tree.x, tree.z);
      const top = terrain.surfaceBlockAt(tree.x, tree.z);
      if (biome === Biome.Ocean) wrong.push(`${treeKey(tree)} 在大海里`);
      if (!TREE_GROUND.has(top)) wrong.push(`${treeKey(tree)} 列顶是 ${top}`);
      if (surface <= SEA_LEVEL) wrong.push(`${treeKey(tree)} 地表 ${surface}`);
      if (tree.rootY !== surface + 1) wrong.push(`${treeKey(tree)} 树根 y ${tree.rootY}、地表 ${surface}`);
    }
    expect(surveyTrees(seed).length).toBeGreaterThan(MIN_PLAINS_SAMPLE);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：长在雪草方块上的树都在冰雪群系里，都是云杉', (seed) => {
    const { TreeSpecies } = treeApi();
    const terrain = terrainOf(seed);
    const onSnowyGrass = surveyTrees(seed).filter(
      ({ tree }) => terrain.surfaceBlockAt(tree.x, tree.z) === BlockType.SnowyGrass,
    );
    expect(onSnowyGrass.length, '长在雪草方块上的树').toBeGreaterThan(0);
    const wrong = onSnowyGrass
      .filter(({ tree, biome }) => biome !== Biome.Snowy || tree.species !== TreeSpecies.Spruce)
      .map(({ tree, biome }) => `${treeKey(tree)} 群系 ${biome}`);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('生成出来的区块里各群系的树', () => {
  it.each(SURVEY_SEEDS)('种子 %i：高山雪线以上没有原木（挑地表在雪线以上的高山区块生成）', (seed) => {
    const terrain = terrainOf(seed);
    const sites = sitesWhere(seed, 'aboveSnowLine', aboveSnowLine);
    expect(sites.length, '地表在雪线以上的高山区块').toBeGreaterThan(0);
    const wrong: string[] = [];
    let snowColumns = 0;
    for (const coord of sites) {
      const chunk = chunkAt(seed, coord);
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const { x, z } = columnIn(coord, lx, lz);
          const surface = terrain.surfaceHeightAt(x, z);
          if (terrain.biomeAt(x, z) !== Biome.Mountains || surface < SNOW_LINE_Y) continue;
          snowColumns++;
          for (let y = surface + 1; y <= WORLD_MAX_Y; y++) {
            if (LOGS.has(chunk.get(lx, y, lz))) wrong.push(`(${x}, ${y}, ${z}) 地表 ${surface}`);
          }
        }
      }
    }
    // 查过的雪线以上的列够多：现有代码下这些区块里有树干立在雪线以上的雪草方块上
    expect(snowColumns, '查过的雪线以上的高山列').toBeGreaterThan(CHUNKS_PER_SITE * CHUNK_SIZE * 4);
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：高山雪线以下的区块里有云杉，原木全是云杉原木', (seed) => {
    const trunks = trunksAt(seed, sitesWhere(seed, 'belowSnowLine', belowSnowLine)).filter(
      (trunk) => terrainOf(seed).biomeAt(trunk.x, trunk.z) === Biome.Mountains,
    );
    expect(trunks.length, '高山雪线以下的树干').toBeGreaterThan(0);
    expect(trunks.filter((trunk) => trunk.log !== SPRUCE.log).map(trunkKey).slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：冰雪的雪草方块上长着云杉，冰雪里的原木全是云杉原木', (seed) => {
    const trunks = trunksAt(seed, sitesWhere(seed, 'snowyLand', snowyLand)).filter(
      (trunk) => terrainOf(seed).biomeAt(trunk.x, trunk.z) === Biome.Snowy,
    );
    const onSnowyGrass = trunks.filter((trunk) => trunk.below === BlockType.SnowyGrass && trunk.log === SPRUCE.log);
    expect(onSnowyGrass.length, '立在雪草方块上的云杉').toBeGreaterThan(0);
    expect(trunks.filter((trunk) => trunk.log !== SPRUCE.log).map(trunkKey).slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：平原的区块里橡树与白桦都有，没有云杉原木', (seed) => {
    const trunks = trunksAt(seed, sitesWhere(seed, 'plainsLand', plainsLand)).filter(
      (trunk) => terrainOf(seed).biomeAt(trunk.x, trunk.z) === Biome.Plains,
    );
    const logs = [...new Set(trunks.map((trunk) => trunk.log))].sort((a, b) => a - b);
    expect(logs).toEqual([OAK.log, BIRCH.log].sort((a, b) => a - b));
  });

  it.each(SURVEY_SEEDS)('种子 %i：每根树干下面是草方块或雪草方块，雪草方块上的树干只在冰雪群系里', (seed) => {
    const terrain = terrainOf(seed);
    const coords = [
      ...sitesWhere(seed, 'aboveSnowLine', aboveSnowLine),
      ...sitesWhere(seed, 'belowSnowLine', belowSnowLine),
      ...sitesWhere(seed, 'snowyLand', snowyLand),
      ...sitesWhere(seed, 'plainsLand', plainsLand),
    ];
    const trunks = trunksAt(seed, coords);
    expect(trunks.length, '查过的树干').toBeGreaterThan(CHUNKS_PER_SITE);
    const wrong: string[] = [];
    for (const trunk of trunks) {
      if (!TREE_GROUND.has(trunk.below)) wrong.push(trunkKey(trunk));
      const biome = terrain.biomeAt(trunk.x, trunk.z);
      if (trunk.below === BlockType.SnowyGrass && biome !== Biome.Snowy) wrong.push(`${trunkKey(trunk)} 群系 ${biome}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it.each(SURVEY_SEEDS)('种子 %i：沙滩上没有原木', (seed) => {
    const terrain = terrainOf(seed);
    const sites = sitesWhere(seed, 'beach', beach);
    expect(sites.length, '中心列是沙滩的区块').toBeGreaterThan(0);
    const wrong: string[] = [];
    let sandColumns = 0;
    for (const coord of sites) {
      const chunk = chunkAt(seed, coord);
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const column = columnIn(coord, lx, lz);
          if (!beach(terrain, column)) continue;
          sandColumns++;
          const surface = terrain.surfaceHeightAt(column.x, column.z);
          for (let y = surface + 1; y <= WORLD_MAX_Y; y++) {
            if (LOGS.has(chunk.get(lx, y, lz))) wrong.push(`(${column.x}, ${y}, ${column.z})`);
          }
        }
      }
    }
    expect(sandColumns, '查过的沙滩列').toBeGreaterThan(0);
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

/**
 * 群系固定的平地（`flatForest`）：地表一样高，哪里长树、长哪种只由种子与群系决定，雪线的上下界因此能精确地测。
 */
describe('雪线与群系（平地）', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  /** 每个种子扫 8×8 个区块。 */
  const coords: ChunkCoord[] = [];
  for (let cx = 0; cx < 8; cx++) for (let cz = 0; cz < 8; cz++) coords.push({ cx, cz });
  const FAR_SPAWN = { x: -10_000, z: -10_000 };

  function treesOn(biome: Biome, surfaceY: number): Tree[] {
    return SEEDS.flatMap((seed) => treesRootedIn(flatForest(seed, biome, { surfaceY, spawnColumn: FAR_SPAWN }), coords));
  }

  it('高山地表在雪线以下一格（y 149，草方块）长云杉', () => {
    const { TreeSpecies } = treeApi();
    const trees = treesOn(Biome.Mountains, SNOW_LINE_Y - 1);
    expect(trees.length).toBeGreaterThan(SEEDS.length);
    expect(speciesOf(trees)).toEqual([TreeSpecies.Spruce]);
  });

  it('高山地表在雪线（y 150，雪草方块）及以上不长树', () => {
    expect(treesOn(Biome.Mountains, SNOW_LINE_Y).map(treeKey)).toEqual([]);
    expect(treesOn(Biome.Mountains, SNOW_LINE_Y + 30).map(treeKey)).toEqual([]);
  });

  it('冰雪的雪草方块上长云杉', () => {
    const { TreeSpecies } = treeApi();
    const trees = treesOn(Biome.Snowy, 70);
    expect(trees.length).toBeGreaterThan(SEEDS.length);
    expect(speciesOf(trees)).toEqual([TreeSpecies.Spruce]);
  });

  it('平原长橡树与白桦，大海不长树', () => {
    const { TreeSpecies } = treeApi();
    expect(speciesOf(treesOn(Biome.Plains, 70))).toEqual([TreeSpecies.Birch, TreeSpecies.Oak].sort());
    expect(treesOn(Biome.Ocean, 70).map(treeKey)).toEqual([]);
  });

  it('生成出来的区块里，雪线以上的高山没有原木，雪线以下一格的高山有云杉原木', () => {
    const logsOn = (surfaceY: number): Set<BlockType> => {
      const logs = new Set<BlockType>();
      for (const seed of SEEDS.slice(0, 2)) {
        const terrain = flatForest(seed, Biome.Mountains, { surfaceY, spawnColumn: FAR_SPAWN });
        for (const coord of coords.slice(0, 16)) {
          const chunk = terrain.generateChunk(coord.cx, coord.cz);
          for (const trunk of trunksIn(chunk, coord)) logs.add(trunk.log);
        }
      }
      return logs;
    };
    expect([...logsOn(SNOW_LINE_Y - 1)]).toEqual([SPRUCE.log]);
    expect([...logsOn(SNOW_LINE_Y)]).toEqual([]);
  });
});

describe('树种的选择由种子决定', () => {
  it.each(SURVEY_SEEDS)('种子 %i：两个独立构造的地形对象在同一片区块里给出同样的树与树种', (seed) => {
    const coords = [...surveyChunks()].slice(0, 400);
    const first = treesRootedIn(createTerrain(seed), coords);
    const second = treesRootedIn(createTerrain(seed), coords);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it.each(SURVEY_SEEDS)('种子 %i：跨区块的树，从它伸进的每个区块查到的都是同一棵、同一种', (seed) => {
    const { treesTouching } = treeApi();
    const terrain = terrainOf(seed);
    const crossing = spread(
      surveyTrees(seed).filter(({ tree }) => crossesChunk(tree)),
      SHAPE_SAMPLE,
    );
    expect(speciesOf(crossing.map(({ tree }) => tree)).length, '跨区块的树的树种数').toBe(3);
    const wrong: string[] = [];
    for (const { tree } of crossing) {
      for (const { cx, cz } of chunksTouchedBy(tree)) {
        const seen = treesTouching(terrain, cx, cz).filter((other) => other.x === tree.x && other.z === tree.z);
        if (seen.length !== 1 || JSON.stringify(seen[0]) !== JSON.stringify(tree)) {
          wrong.push(`${treeKey(tree)} 在区块 (${cx}, ${cz}) 查到 ${JSON.stringify(seen)}`);
        }
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('平地上同一种子两次生成同一片区块，树种逐棵相同；换种子则不同', () => {
    const coords: ChunkCoord[] = [];
    for (let cx = 0; cx < 6; cx++) for (let cz = 0; cz < 6; cz++) coords.push({ cx, cz });
    const speciesSeq = (seed: number): string[] =>
      treesRootedIn(flatForest(seed, Biome.Plains, { spawnColumn: { x: -10_000, z: -10_000 } }), coords).map(treeKey);
    expect(speciesSeq(11)).toEqual(speciesSeq(11));
    expect(speciesSeq(12)).not.toEqual(speciesSeq(11));
  });
});

/** 方块换成橡木的那一份：白桦与橡树「只换原木与树叶」就是把白桦的方块换成橡木后与橡树逐格相同。 */
function asOak(cells: readonly TreeCell[]): TreeCell[] {
  return cells.map((cell) => ({
    ...cell,
    block: cell.block === BIRCH.log ? OAK.log : cell.block === BIRCH.leaves ? OAK.leaves : cell.block,
  }));
}

/**
 * 原版式橡树的形状（相对树根），按 dy、dz、dx 排好：树干 trunkHeight 格原木；树干顶下两层是 5×5 去掉四角，
 * 树干顶那层 3×3，顶上一层 3×3 去掉四角；树干占着的格是原木。
 */
function vanillaOakShape(trunkHeight: number, log: BlockType, leaves: BlockType): TreeCell[] {
  const top = trunkHeight - 1;
  const layers: Array<[dy: number, radius: number, corners: boolean]> = [
    [top - 2, 2, false],
    [top - 1, 2, false],
    [top, 1, true],
    [top + 1, 1, false],
  ];
  const cells = new Map<string, TreeCell>();
  for (const [dy, radius, corners] of layers) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!corners && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
        cells.set(`${dx},${dy},${dz}`, { dx, dy, dz, block: leaves });
      }
    }
  }
  for (let dy = 0; dy <= top; dy++) cells.set(`0,${dy},0`, { dx: 0, dy, dz: 0, block: log });
  return [...cells.values()].sort((a, b) => a.dy - b.dy || a.dz - b.dz || a.dx - b.dx);
}

describe('树的形状', () => {
  /** 每个种子取一些这种树，三个种子合在一起。 */
  function sampleOf(species: string): Tree[] {
    return SURVEY_SEEDS.flatMap((seed) =>
      spread(
        surveyTrees(seed)
          .map((surveyed: SurveyedTree) => surveyed.tree)
          .filter((tree) => tree.species === species),
        SHAPE_SAMPLE,
      ),
    );
  }

  it('橡树与白桦是原版式橡树形状，白桦用白桦原木与白桦树叶', () => {
    const { TreeSpecies } = treeApi();
    for (const [species, wood] of [
      [TreeSpecies.Oak, OAK],
      [TreeSpecies.Birch, BIRCH],
    ] as const) {
      const trees = sampleOf(species);
      expect(trees.length, `${wood.name}的样本`).toBeGreaterThan(SURVEY_SEEDS.length);
      for (const tree of trees) {
        expect(tree.trunkHeight, treeKey(tree)).toBeGreaterThanOrEqual(OAK_TRUNK_MIN);
        expect(tree.trunkHeight, treeKey(tree)).toBeLessThanOrEqual(OAK_TRUNK_MAX);
        expect(footprint(tree), treeKey(tree)).toEqual(vanillaOakShape(tree.trunkHeight, wood.log, wood.leaves));
      }
    }
  });

  it('白桦换成橡树的原木与树叶后，与同一位置、同样树干高度的橡树逐格相同', () => {
    const { TreeSpecies } = treeApi();
    const birches = sampleOf(TreeSpecies.Birch);
    expect(birches.length).toBeGreaterThan(SURVEY_SEEDS.length);
    for (const birch of birches) {
      expect(asOak(footprint(birch)), treeKey(birch)).toEqual(footprint({ ...birch, species: TreeSpecies.Oak }));
    }
  });

  describe('云杉是尖塔形树冠', () => {
    const spruces = (): Tree[] => sampleOf(treeApi().TreeSpecies.Spruce);

    /** 有树叶的各层：y（相对树根）与这一层树叶到树干那一列的最大切比雪夫距离。 */
    function leafLayers(cells: readonly TreeCell[]): Array<{ dy: number; radius: number; coversTrunk: boolean }> {
      const byDy = new Map<number, { dy: number; radius: number; coversTrunk: boolean }>();
      for (const { dx, dy, dz, block } of cells) {
        if (!LEAVES.has(block)) continue;
        const layer = byDy.get(dy) ?? { dy, radius: 0, coversTrunk: false };
        layer.radius = Math.max(layer.radius, Math.abs(dx), Math.abs(dz));
        if (dx === 0 && dz === 0) layer.coversTrunk = true;
        byDy.set(dy, layer);
      }
      return [...byDy.values()].sort((a, b) => a.dy - b.dy);
    }

    it('有样本可查', () => {
      expect(spruces().length).toBeGreaterThan(SURVEY_SEEDS.length);
    });

    it('只用云杉原木与云杉树叶；树干从树根连续到树干顶，树根之下没有方块', () => {
      const { trunkTopY } = treeApi();
      const wrong: string[] = [];
      for (const tree of spruces()) {
        const cells = footprint(tree);
        const top = trunkTopY(tree) - tree.rootY;
        for (const { dx, dy, dz, block } of cells) {
          if (block !== SPRUCE.log && block !== SPRUCE.leaves) wrong.push(`${treeKey(tree)} (${dx}, ${dy}, ${dz}) 是 ${block}`);
          if (block === SPRUCE.log && (dx !== 0 || dz !== 0 || dy < 0 || dy > top)) {
            wrong.push(`${treeKey(tree)} 原木在 (${dx}, ${dy}, ${dz})`);
          }
          if (dy < 0) wrong.push(`${treeKey(tree)} 树根之下 (${dx}, ${dy}, ${dz}) 有 ${block}`);
        }
        for (let dy = 0; dy <= top; dy++) {
          const at = cells.find((cell) => cell.dx === 0 && cell.dz === 0 && cell.dy === dy);
          if (at?.block !== SPRUCE.log) wrong.push(`${treeKey(tree)} 树干 dy ${dy} 是 ${at?.block}`);
        }
      }
      expect(wrong.slice(0, 20)).toEqual([]);
    });

    it('云杉之间、云杉与橡树或白桦之间，原木与树叶不落在同一格（平地，一半平原一半高山）', () => {
      // 云杉树冠比橡树宽，两棵树的间距要按较宽的树冠算，否则两个树冠互相穿插
      const half = (x: number): Biome => (x < 0 ? Biome.Plains : Biome.Mountains);
      const overlaps: string[] = [];
      const species = new Set<string>();
      for (const seed of [1, 2, 3, 4]) {
        const terrain = flatForest(seed, Biome.Mountains, {
          biomeAt: (x) => half(x),
          spawnColumn: { x: -10_000, z: -10_000 },
        });
        const coords: ChunkCoord[] = [];
        for (let cx = -4; cx < 4; cx++) for (let cz = -4; cz < 4; cz++) coords.push({ cx, cz });
        const owner = new Map<string, string>();
        for (const tree of treesRootedIn(terrain, coords)) {
          species.add(tree.species);
          for (const { dx, dy, dz } of footprint(tree)) {
            const cell = `${tree.x + dx},${tree.rootY + dy},${tree.z + dz}`;
            const other = owner.get(cell);
            if (other) overlaps.push(`种子 ${seed}：${other} 与 ${treeKey(tree)} 都占 ${cell}`);
            owner.set(cell, treeKey(tree));
          }
        }
      }
      expect(species.size, '三种树都有').toBe(3);
      expect(overlaps.slice(0, 20)).toEqual([]);
    });

    it('树冠半径不超过 3，最宽那层至少 2', () => {
      const wrong: string[] = [];
      for (const tree of spruces()) {
        const radius = canopyRadiusOf(footprint(tree));
        if (radius > 3 || radius < 2) wrong.push(`${treeKey(tree)} 树冠半径 ${radius}`);
      }
      expect(wrong.slice(0, 20)).toEqual([]);
    });

    it('树冠至少 5 层，比橡树的 4 层高；最上一层在树干顶之上、半径不超过 1、盖住树干那一列', () => {
      const { trunkTopY } = treeApi();
      const wrong: string[] = [];
      for (const tree of spruces()) {
        const layers = leafLayers(footprint(tree));
        const topLayer = layers[layers.length - 1];
        if (layers.length < 5) wrong.push(`${treeKey(tree)} 树冠 ${layers.length} 层`);
        if (!topLayer) continue;
        if (topLayer.dy <= trunkTopY(tree) - tree.rootY) wrong.push(`${treeKey(tree)} 最上一层 dy ${topLayer.dy} 不在树干顶之上`);
        if (topLayer.radius > 1) wrong.push(`${treeKey(tree)} 最上一层半径 ${topLayer.radius}`);
        if (!topLayer.coversTrunk) wrong.push(`${treeKey(tree)} 最上一层没盖住树干那一列`);
      }
      expect(wrong.slice(0, 20)).toEqual([]);
    });

    it('上窄下宽：上半部分各层的最大半径小于下半部分各层的最大半径', () => {
      const wrong: string[] = [];
      for (const tree of spruces()) {
        const layers = leafLayers(footprint(tree));
        const half = Math.floor(layers.length / 2);
        const lower = Math.max(0, ...layers.slice(0, half).map((layer) => layer.radius));
        const upper = Math.max(0, ...layers.slice(layers.length - half).map((layer) => layer.radius));
        if (upper >= lower) wrong.push(`${treeKey(tree)} 上半最大半径 ${upper}、下半 ${lower}`);
      }
      expect(wrong.slice(0, 20)).toEqual([]);
    });
  });
});
