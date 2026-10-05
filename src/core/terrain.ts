import { BlockType } from './block';
import { Chunk } from './chunk';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_MIN_Y } from './constants';
import { hashCoords } from './noise';
import { plantOreVeins } from './ore';
import {
  climateAt,
  COLD_TEMPERATURE,
  densitySurfaceHeight,
  fillDensity,
  isColdAt,
  MOUNTAIN_RELIEF,
  OCEAN_CONTINENTALNESS,
  type Climate,
} from './terrain-density';
import { Biome } from './biome';
import { plantOakTrees, type SurfaceHeightAt, type TreePlacement } from './tree';

export { Biome } from './biome';

/**
 * 地形生成是纯函数：区块坐标决定区块内容，不依赖相邻区块的加载顺序。
 * 种子由 `createTerrain(seed)` 捕获在闭包里，因此生成器本身只需要区块坐标。
 */
export type TerrainGenerator = (cx: number, cz: number) => Chunk;

/** 一列的水平坐标。 */
export interface ColumnCoord {
  readonly x: number;
  readonly z: number;
}

/**
 * 地形对象：由种子构造，含区块生成器、三个纯函数查询与出生列（ADR-0021）。
 *
 * 核心、Worker 与测试都只经这个对象使用地形，换地形算法不必改调用方。成员都是不依赖 `this` 的
 * 函数属性：可以单独取出来传，也可以展开成新对象再换掉生成器（浏览器把生成器换成 Worker 那一侧的区块来源）。
 * 地形对象本身就是一份 `TreePlacement`（种子、群系、地表高度与出生列），放树时直接传它。
 */
export interface Terrain {
  readonly seed: number;
  /** 区块生成器，纯函数（ADR-0003）。 */
  readonly generateChunk: TerrainGenerator;
  /** 那一列的群系。 */
  readonly biomeAt: (x: number, z: number) => Biome;
  /** 那一列的地表高度（见 CONTEXT.md「地表高度」）。 */
  readonly surfaceHeightAt: SurfaceHeightAt;
  /** 那一列地表高度那一格的方块（列顶地表方块）。 */
  readonly surfaceBlockAt: (x: number, z: number) => BlockType;
  /** 出生列（见 CONTEXT.md「出生点」）。 */
  readonly spawnColumn: ColumnCoord;
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
 * 只调三个查询，不生成区块：生成器放树要避开出生列，得先有出生列才造得出生成器。陆地顺带在同一遍里记下第一列，
 * 与「先查完平原、再从头查陆地」结果相同。群系最便宜，先问；地表高度最贵，只在还没找到陆地时才问。
 * 每次搜索都返回新对象，原点也不例外：从引用是否相同就看得出出生列是不是只搜了一次。
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
 * 每一圈从上一圈终点 (16(k−1), −16(k−1)) 往 +X 迈一步起，沿 +Z、−X、−Z、+X 四条边走一周，终点 (16k, −16k)。
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
 * 地表高度按那一列的密度求出。列顶地表方块这一版仍总是草方块（#76 按铺地表的规则给出）。
 *
 * 出生列构造时按三个查询搜一次（`findSpawnColumn`），存在地形对象上，之后读的都是这一个结果：生成器放树
 * 要避开它，核心与加载画面也读它。
 */
export function createTerrain(seed: number): Terrain {
  const queries = {
    seed,
    biomeAt: (x: number, z: number): Biome => biomeOf(climateAt(seed, x, z)),
    surfaceHeightAt: (x: number, z: number) => densitySurfaceHeight(seed, x, z),
    surfaceBlockAt: () => BlockType.Grass,
  };
  const placement = { ...queries, spawnColumn: findSpawnColumn(queries) };
  return { ...placement, generateChunk: densityGenerator(placement) };
}

/**
 * 按群系参数分群系（CONTEXT.md「群系」）：先按大陆度分海与陆，海是大海；陆地上起伏大的是高山，
 * 寒冷处是冰雪，其余是平原。寒冷处的海仍是大海，海面结冰由生成步骤按同一个温度阈值做。
 */
function biomeOf({ continentalness, relief, temperature }: Climate): Biome {
  if (continentalness < OCEAN_CONTINENTALNESS) return Biome.Ocean;
  if (relief > MOUNTAIN_RELIEF) return Biome.Mountains;
  if (temperature < COLD_TEMPERATURE) return Biome.Snowy;
  return Biome.Plains;
}

/** 草方块之下的泥土层数：每一列在这个闭区间里由种子确定性地取一个。 */
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

/**
 * 三维密度地形的区块生成器。放树按传入的地表高度查询，与地形对象的查询是同一个函数，
 * 查询值与生成结果因此一致。
 *
 * 每一步只读本区块里已写下的方块与纯函数（ADR-0021），同一个种子与区块坐标永远得到同样的区块（ADR-0003）：
 * 1. 最底层基岩；密度为正的格写石头。
 * 2. 海平面那层及以下的空气灌水（内陆洼地因此成湖）。
 * 3. 寒冷处海平面那层的水换成冰（大海与洼地湖都是）。
 * 4. 铺地表：上方是空气或水的每一段石头，顶层换草方块、其下 3 到 4 层泥土（沙滩、雪线、陡坡露石在 #76）。
 * 5. 嵌矿脉，只替换石头。
 * 6. 种树，只长在地表高于海平面的列上。
 */
function densityGenerator(terrain: TreePlacement): TerrainGenerator {
  const { seed } = terrain;
  return (cx, cz) => {
    const chunk = new Chunk(cx, cz);
    chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);
    const { tops, solidTops } = fillDensity(seed, chunk);

    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const z = originZ + lz;
        const column = lz * CHUNK_SIZE + lx;
        const solidTop = solidTops[column]!;
        floodBelowSeaLevel(chunk, lx, lz, solidTop);
        if (chunk.get(lx, SEA_LEVEL, lz) === BlockType.Water && isColdAt(seed, x, z)) {
          chunk.set(lx, SEA_LEVEL, lz, BlockType.Ice);
        }
        coverSurface(chunk, lx, lz, tops[column]!, solidTop, dirtDepthAt(seed, x, z));
      }
    }

    // 土石铺完再嵌矿脉：矿石只替换石头，得先有石头。
    plantOreVeins(seed, chunk);
    // 再种树：树叶只往空气里长，得先有地面才知道哪里是空气。
    plantOakTrees(terrain, chunk);
    return chunk;
  };
}

/** 一列海平面那层及以下的空气灌水。solidTop 及以下整段是石头，不必看。 */
function floodBelowSeaLevel(chunk: Chunk, lx: number, lz: number, solidTop: number): void {
  for (let y = solidTop + 1; y <= SEA_LEVEL; y++) {
    if (chunk.get(lx, y, lz) === BlockType.Air) chunk.set(lx, y, lz, BlockType.Water);
  }
}

/**
 * 铺一列的地表：自上而下，上方不是石头（空气、水或冰）的每一段石头，顶层换草方块，其下 dirtDepth 层换泥土，
 * 那一段不够厚时到段底为止。top 之上没有石头；solidTop 及以下整段是石头，不会再有露天的顶面，泥土铺完就停。
 */
function coverSurface(
  chunk: Chunk,
  lx: number,
  lz: number,
  top: number,
  solidTop: number,
  dirtDepth: number,
): void {
  let aboveSolid = false;
  let dirtLeft = 0;
  for (let y = top; y > solidTop || dirtLeft > 0; y--) {
    const solid = chunk.get(lx, y, lz) === BlockType.Stone;
    if (solid && !aboveSolid) {
      chunk.set(lx, y, lz, BlockType.Grass);
      dirtLeft = dirtDepth;
    } else if (solid && dirtLeft > 0) {
      chunk.set(lx, y, lz, BlockType.Dirt);
      dirtLeft--;
    } else if (!solid) {
      dirtLeft = 0;
    }
    aboveSolid = solid;
  }
}
