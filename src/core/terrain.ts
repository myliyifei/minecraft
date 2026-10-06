import { BlockType } from './block';
import { Chunk } from './chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MIN_Y } from './constants';
import { hashCoords } from './noise';
import { plantOreVeins } from './ore';
import { plantSurfacePlants } from './plant';
import { digPonds, isPondColumn, type PondPlacement } from './pond';
import {
  COLD_TEMPERATURE,
  continentalnessAt,
  createDensityField,
  type DensityField,
  HEIGHT_WINDOW,
  isColdAt,
  MOUNTAIN_RELIEF,
  OCEAN_CONTINENTALNESS,
  reliefAt,
  temperatureAt,
} from './terrain-density';
import { Biome } from './biome';
import { BEACH_REACH, coverColumn, highestTopBlock, isSteepColumn, type SurfaceSamples } from './surface';
import { plantTrees, type SurfaceHeightAt, type TreePlacement } from './tree';

import type { ColumnCoord } from './world';

export { Biome } from './biome';
export type { ColumnCoord } from './world';

/**
 * 地形生成是纯函数：区块坐标决定区块内容，不依赖相邻区块的加载顺序。
 * 种子由 `createTerrain(seed)` 捕获在闭包里，因此生成器本身只需要区块坐标。
 */
export type TerrainGenerator = (cx: number, cz: number) => Chunk;


/**
 * 地形对象：由种子构造，含区块生成器、四个纯函数查询（群系、地表高度、列顶地表方块、单列实心段）与出生列（ADR-0021）。
 *
 * 核心、Worker 与测试都只经这个对象使用地形，换地形算法不必改调用方。成员都是不依赖 `this` 的
 * 函数属性：可以单独取出来传，也可以展开成新对象再换掉生成器（浏览器把生成器换成 Worker 那一侧的区块来源）。
 * 地形对象本身就是一份 `TreePlacement`（种子、群系、地表高度、列顶地表方块与出生列），放树时直接传它。
 */
export interface Terrain {
  readonly seed: number;
  /** 区块生成器，纯函数（ADR-0003）。 */
  readonly generateChunk: TerrainGenerator;
  /** 那一列的群系。 */
  readonly biomeAt: (x: number, z: number) => Biome;
  /** 那一列的地表高度（见 CONTEXT.md「地表高度」）。 */
  readonly surfaceHeightAt: SurfaceHeightAt;
  /** 那一列地表高度那一格的方块（列顶地表方块）：水塘列是水（`pond.ts`），其余按铺地表的规则（`surface.ts`）给出。 */
  readonly surfaceBlockAt: (x: number, z: number) => BlockType;
  /** 出生列（见 CONTEXT.md「出生点」）。 */
  readonly spawnColumn: ColumnCoord;
  /**
   * 那一列 fromY 到 toY（含两端）是不是全是地形方块（挖水塘之前）。水塘判断盆地边缘是否封闭要用（`pond.ts`）；
   * 没有悬垂的地形（平地测试用的那几份）按地表高度及以下都是地形方块回答。
   */
  readonly isSolidSpan: (x: number, z: number, fromY: number, toY: number) => boolean;
}

/** 出生列搜索的步长（方块）：只查 x、z 都是它的倍数的列。 */
const SPAWN_SEARCH_STEP = 16;

/** 出生列搜索的范围（方块，与原点的切比雪夫距离），含边界。 */
const SPAWN_SEARCH_RADIUS = 1024;

/** 出生列搜索要的三个查询。 */
export type SpawnColumnQueries = Pick<Terrain, 'biomeAt' | 'surfaceHeightAt' | 'surfaceBlockAt'>;

/**
 * 出生列（CONTEXT.md「出生点」）：从原点那一列起，以 16 格为步长按螺旋顺序查，取第一列群系是平原、列顶地表方块是
 * 草方块的；1024 格以内找不到就取第一列列顶不是水、地表高于海平面的陆地，再找不到就是原点。
 *
 * 只调三个查询，不生成区块：生成器放树要避开出生列，得先有出生列才造得出生成器。陆地同时在同一遍里记下第一列，
 * 与「先查完平原、再从头查陆地」结果相同。群系开销最小，先问；地表高度开销最大，只在还没找到陆地时才问。
 * 每次搜索都返回新对象，原点也不例外：从引用是否相同就看得出出生列是不是只搜了一次。
 * `createTerrain` 传的是挖水塘之前的列顶地表方块：水塘要避开出生列，不能反过来让出生列看水塘。
 */
export function findSpawnColumn(queries: SpawnColumnQueries): ColumnCoord {
  let firstLand: ColumnCoord | undefined;
  for (const column of spawnSearchOrder()) {
    const { x, z } = column;
    const plains = queries.biomeAt(x, z) === Biome.Plains;
    if (!plains && firstLand) continue;
    const block = queries.surfaceBlockAt(x, z);
    if (plains && block === BlockType.Grass) return column;
    if (!firstLand && block !== BlockType.Water && queries.surfaceHeightAt(x, z) > SEA_LEVEL) firstLand = column;
  }
  return firstLand ?? searchColumn(0, 0);
}

/**
 * 出生列搜索查的列，按螺旋顺序：先原点，再由内向外一圈一圈走，第 k 圈是与原点切比雪夫距离 16k 的那 8k 列。
 * 每一圈从上一圈终点 (16(k−1), −16(k−1)) 往 +X 前进一格起，沿 +Z、−X、−Z、+X 四条边走一周，终点 (16k, −16k)。
 */
function* spawnSearchOrder(): Generator<ColumnCoord> {
  yield searchColumn(0, 0);
  const rings = SPAWN_SEARCH_RADIUS / SPAWN_SEARCH_STEP;
  for (let k = 1; k <= rings; k++) {
    for (let j = -k + 1; j <= k; j++) yield searchColumn(k, j);
    for (let i = k - 1; i >= -k; i--) yield searchColumn(i, k);
    for (let j = k - 1; j >= -k; j--) yield searchColumn(-k, j);
    for (let i = -k + 1; i <= k; i++) yield searchColumn(i, -k);
  }
}

/** 以步长为单位的格点 (i, j) 对应的列。 */
function searchColumn(i: number, j: number): ColumnCoord {
  return { x: i * SPAWN_SEARCH_STEP, z: j * SPAWN_SEARCH_STEP };
}

/**
 * 由种子构造地形对象。
 *
 * 地形由三维密度决定（ADR-0021，密度场见 `terrain-density.ts`）：群系按大陆度、起伏、温度三层参数分，
 * 地表高度按那一列的密度求出，列顶地表方块按铺地表的规则（`surface.ts`）由地表高度、群系、大陆度、起伏与温度给出，
 * 水塘列（`pond.ts`）给出水。
 *
 * 出生列构造时按三个查询搜一次（`findSpawnColumn`），存在地形对象上，之后读的都是这一个结果：生成器放树
 * 要避开它，核心与加载画面也读它。
 */
export function createTerrain(seed: number): Terrain {
  const density = createDensityField(seed);
  const samples: SurfaceSamples = {
    heightAt: (x, z) => density.surfaceHeight(x, z),
    biomeAt: (x, z) => biomeAt(seed, x, z, continentalnessAt(seed, x, z)),
    continentalnessAt: (x, z) => continentalnessAt(seed, x, z),
    reliefAt: (x, z) => reliefAt(seed, x, z),
    isColdAt: (x, z) => isColdAt(seed, x, z),
  };
  const beforePonds: SpawnColumnQueries = {
    biomeAt: samples.biomeAt,
    surfaceHeightAt: samples.heightAt,
    surfaceBlockAt: (x, z) => highestTopBlock(samples, x, z),
  };
  // 出生列按挖水塘之前的列顶地表方块找：水塘要避开出生列，出生列再看水塘就成了循环。水塘不进出生列周围
  // POND_SPAWN_CLEARANCE 格，所以出生列那一列挖不挖水塘结论都一样。
  const spawnColumn = findSpawnColumn(beforePonds);
  const isSolidSpan = (x: number, z: number, fromY: number, toY: number): boolean =>
    density.solidSpan(x, z, fromY, toY);
  const ponds: PondPlacement = { seed, spawnColumn, biomeAt: samples.biomeAt, surfaceHeightAt: samples.heightAt, isSolidSpan };
  const placement: Omit<Terrain, 'generateChunk'> = {
    ...beforePonds,
    seed,
    spawnColumn,
    isSolidSpan,
    surfaceBlockAt: (x, z) => surfaceBlockWithPonds(ponds, samples, x, z),
  };
  return { ...placement, generateChunk: densityGenerator(placement, ponds, density) };
}

/**
 * 列顶地表方块（ADR-0021）：水塘列是水，其余按铺地表的规则（`surface.ts`）。地形对象的查询与
 * 生成器放树时区块外的列都调它，两边对水塘列给出同一个结论；样本可以是查询用的那份，也可以是区块生成那份。
 */
function surfaceBlockWithPonds(ponds: PondPlacement, samples: SurfaceSamples, x: number, z: number): BlockType {
  return isPondColumn(ponds, x, z) ? BlockType.Water : highestTopBlock(samples, x, z);
}

/**
 * 按群系参数分群系（CONTEXT.md「群系」）：先按大陆度分海与陆，海是大海；陆地上起伏大的是高山，
 * 寒冷处是冰雪，其余是平原。寒冷处的海仍是大海，海面结冰由生成步骤按同一个温度阈值做。
 *
 * 大陆度由调用方先求好（区块生成按列缓存它，铺地表找大海也只看它），起伏与温度判到哪一层才求哪一层。
 */
function biomeAt(seed: number, x: number, z: number, continentalness: number): Biome {
  if (continentalness < OCEAN_CONTINENTALNESS) return Biome.Ocean;
  if (reliefAt(seed, x, z) > MOUNTAIN_RELIEF) return Biome.Mountains;
  if (temperatureAt(seed, x, z) < COLD_TEMPERATURE) return Biome.Snowy;
  return Biome.Plains;
}

/** 草方块与雪草方块之下的泥土层数（沙子、沙砾之下同样层数）：每一列在这个闭区间里由种子确定性地取一个。 */
const DIRT_DEPTH_MIN = 3;
const DIRT_DEPTH_MAX = 4;

/**
 * 泥土层数用的种子偏移量。
 * 由同一个世界种子派生出一条与密度无关的哈希流，泥土的厚薄才不会跟着地形起伏走出可见的条纹。
 */
const DIRT_DEPTH_SALT = 0x5bf0_3635;

/** 泥土层数的取值个数（DIRT_DEPTH_MIN..DIRT_DEPTH_MAX 闭区间）。 */
const DIRT_DEPTH_SPAN = DIRT_DEPTH_MAX - DIRT_DEPTH_MIN + 1;

/** 某一列草方块之下的泥土层数。 */
function dirtDepthAt(seed: number, x: number, z: number): number {
  return DIRT_DEPTH_MIN + (hashCoords(seed ^ DIRT_DEPTH_SALT, x, z) % DIRT_DEPTH_SPAN);
}

/** 区块生成时群系与大陆度缓存的范围：区块四周各 BEACH_REACH 列，铺地表找海岸只看到这么远。 */
const CLIMATE_MARGIN = BEACH_REACH;
const CLIMATE_WINDOW = CHUNK_SIZE + 2 * CLIMATE_MARGIN;

/** 区块生成按列缓存的温度：还没求、不是寒冷处、是寒冷处。 */
const COLD_UNKNOWN = 0;
const COLD_NO = 1;
const COLD_YES = 2;

/**
 * 区块生成用的样本：区块连同四周一圈的地表高度来自 `DensityField.fill` 已求出的数，区块连同四周 CLIMATE_MARGIN 列的
 * 群系与大陆度、区块里各列的温度按列算一次存下；更远的列改调地形对象的查询。每个数都与查询逐列相同，所以生成时
 * 铺地表与列顶地表方块查询得到同一个结果，只是不重复计算。
 */
function chunkSamples(
  seed: number,
  originX: number,
  originZ: number,
  heights: Int16Array,
  queries: Omit<Terrain, 'generateChunk'>,
): SurfaceSamples {
  const continentalness = new Float64Array(CLIMATE_WINDOW * CLIMATE_WINDOW).fill(Number.NaN);
  const cold = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const biomes: Array<Biome | undefined> = new Array<Biome | undefined>(CLIMATE_WINDOW * CLIMATE_WINDOW);
  const climateIndex = (x: number, z: number): number => {
    const wx = x - originX + CLIMATE_MARGIN;
    const wz = z - originZ + CLIMATE_MARGIN;
    return wx >= 0 && wx < CLIMATE_WINDOW && wz >= 0 && wz < CLIMATE_WINDOW ? wz * CLIMATE_WINDOW + wx : -1;
  };
  const continentalnessOf = (x: number, z: number): number => {
    const i = climateIndex(x, z);
    if (i < 0) return continentalnessAt(seed, x, z);
    let c = continentalness[i]!;
    if (Number.isNaN(c)) {
      c = continentalnessAt(seed, x, z);
      continentalness[i] = c;
    }
    return c;
  };
  return {
    heightAt: (x, z) => {
      const wx = x - originX + 1;
      const wz = z - originZ + 1;
      const inWindow = wx >= 0 && wx < HEIGHT_WINDOW && wz >= 0 && wz < HEIGHT_WINDOW;
      // 窗口四个角上的列没有求，改调查询。
      const corner = (wx === 0 || wx === HEIGHT_WINDOW - 1) && (wz === 0 || wz === HEIGHT_WINDOW - 1);
      return inWindow && !corner ? heights[wz * HEIGHT_WINDOW + wx]! : queries.surfaceHeightAt(x, z);
    },
    biomeAt: (x, z) => {
      const i = climateIndex(x, z);
      if (i < 0) return queries.biomeAt(x, z);
      let biome = biomes[i];
      if (biome === undefined) {
        biome = biomeAt(seed, x, z, continentalnessOf(x, z));
        biomes[i] = biome;
      }
      return biome;
    },
    continentalnessAt: continentalnessOf,
    // 起伏只有大海群系里露出水面的低处列才问，每列最多一次，不缓存。
    reliefAt: (x, z) => reliefAt(seed, x, z),
    // 温度只问那一列自身：区块里的列每列最多求一次，生成器结冰时也读这里，与铺地表共用。
    isColdAt: (x, z) => {
      const lx = x - originX;
      const lz = z - originZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return isColdAt(seed, x, z);
      const i = lz * CHUNK_SIZE + lx;
      let known = cold[i]!;
      if (known === COLD_UNKNOWN) {
        known = isColdAt(seed, x, z) ? COLD_YES : COLD_NO;
        cold[i] = known;
      }
      return known === COLD_YES;
    },
  };
}

/**
 * 三维密度地形的区块生成器。铺地表与放树读的样本与地形对象的查询逐列相同，查询值因此与生成结果一致。
 *
 * 每一步只读本区块里已写下的方块与纯函数（ADR-0021），同一个种子与区块坐标永远得到同样的区块（ADR-0003）：
 * 1. 最底层基岩；密度为正的格写石头。
 * 2. 海平面那层及以下的空气灌水（内陆洼地因此成湖）。
 * 3. 寒冷处海平面那层的水换成冰（大海与洼地湖都是）。
 * 4. 铺地表：上方是空气或水的每一段石头按 `surface.ts` 的规则铺顶层与其下几层。
 * 5. 嵌矿脉，只替换石头；列顶是石头的那一格（陡坡、石头岸）不换，列顶地表方块才与查询一致。
 * 6. 挖水塘（`digPonds`）：从邻近的水塘格拉取，塘底铺沙子、其上灌水到水面，水塘列的顶层记成水。
 * 7. 种树，只长在列顶地表方块是草方块或雪草方块的列上，出生列周围不长。
 * 8. 放地表植物（`plantSurfacePlants`）：在区块内逐列放，列顶是草方块或雪草方块、上面是空气时按群系与种子哈希决定，
 *    在树之后放，所以不长在原木与树叶的格里；出生列周围不长。
 */
function densityGenerator(
  queries: Omit<Terrain, 'generateChunk'>,
  ponds: PondPlacement,
  density: DensityField,
): TerrainGenerator {
  const { seed } = queries;
  return (cx, cz) => {
    const chunk = new Chunk(cx, cz);
    chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);
    const { tops, solidTops, heights } = density.fill(chunk);

    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    const samples = chunkSamples(seed, originX, originZ, heights, queries);
    const highest = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const z = originZ + lz;
        const column = lz * CHUNK_SIZE + lx;
        const solidTop = solidTops[column]!;
        floodBelowSeaLevel(chunk, lx, lz, solidTop);
        // 温度经样本按列缓存：结冰、铺地表与寒冷处大海的雪草方块共用一次计算。
        if (chunk.get(lx, SEA_LEVEL, lz) === BlockType.Water && samples.isColdAt(x, z)) {
          chunk.set(lx, SEA_LEVEL, lz, BlockType.Ice);
        }
        const top = highestTopBlock(samples, x, z);
        const biome = samples.biomeAt(x, z);
        highest[column] = top;
        coverColumn(chunk, lx, lz, {
          top: tops[column]!,
          solidTop,
          depth: dirtDepthAt(seed, x, z),
          highest: top,
          // 高山的列顶是雪草方块即在雪线以上；其余群系的陡坡列顶是石头，不用再判陡坡。
          highestBare: biome === Biome.Mountains && top === BlockType.SnowyGrass && isSteepColumn(samples, x, z),
          biome,
          coldOcean: biome === Biome.Ocean && samples.isColdAt(x, z),
        });
      }
    }

    // 土石铺完再嵌矿脉：矿石只替换石头，得先有石头。
    plantOreVeins(seed, chunk);
    // 列顶是石头的那一格可能被矿脉换掉，写回石头：列顶地表方块查询不知道矿脉。
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        if (highest[lz * CHUNK_SIZE + lx] !== BlockType.Stone) continue;
        chunk.set(lx, heights[(lz + 1) * HEIGHT_WINDOW + (lx + 1)]!, lz, BlockType.Stone);
      }
    }
    // 再挖水塘：水塘列的顶层记成水，下面放树、放植物时区块里的列读到的才与列顶地表方块查询一致。
    digPonds(ponds, chunk, (lx, lz) => {
      highest[lz * CHUNK_SIZE + lx] = BlockType.Water;
    });
    // 再种树：树叶只往空气里长，得先有地面才知道哪里是空气。区块里的列直接读上面铺好的顶层（水塘列是水），
    // 区块外的列调列顶地表方块查询（含水塘）。
    const placement: TreePlacement = {
      seed,
      spawnColumn: queries.spawnColumn,
      biomeAt: samples.biomeAt,
      surfaceHeightAt: samples.heightAt,
      surfaceBlockAt: (x, z) => {
        const lx = x - originX;
        const lz = z - originZ;
        const inChunk = lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE;
        if (inChunk) return highest[lz * CHUNK_SIZE + lx] as BlockType;
        return surfaceBlockWithPonds(ponds, samples, x, z);
      },
    };
    plantTrees(placement, chunk);
    // 最后放地表植物：上面那格是不是空气要等树长完才知道。
    plantSurfacePlants(placement, chunk);
    return chunk;
  };
}

/** 一列海平面那层及以下的空气灌水。solidTop 及以下整段是石头，不必看。 */
function floodBelowSeaLevel(chunk: Chunk, lx: number, lz: number, solidTop: number): void {
  for (let y = solidTop + 1; y <= SEA_LEVEL; y++) {
    if (chunk.get(lx, y, lz) === BlockType.Air) chunk.set(lx, y, lz, BlockType.Water);
  }
}
