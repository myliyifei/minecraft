import { BlockType } from './block';
import { Chunk } from './chunk';
import { CHUNK_SIZE, MIN_SURFACE_Y, WORLD_MIN_Y } from './constants';
import { fbm2, hashCoords } from './noise';
import { plantOreVeins } from './ore';
import { plantOakTrees, type SurfaceHeightAt, type TreePlacement } from './tree';

/**
 * 地形生成是纯函数：区块坐标决定区块内容，不依赖相邻区块的加载顺序。
 * 种子由 `createTerrain(seed)` 捕获在闭包里，因此生成器本身只需要区块坐标。
 */
export type TerrainGenerator = (cx: number, cz: number) => Chunk;

/**
 * 群系（见 CONTEXT.md「群系」）。值是字符串，不进存档：存档里只有方块，群系随时由种子与列坐标查得。
 * 现在只有平原，#75 补齐高山、冰雪、大海。
 */
export const Biome = {
  Plains: 'plains',
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

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
 * 地形对象本身就是一份 `TreePlacement`（种子与地表高度），放树时直接传它。
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

/** 世界原点那一列。 */
const ORIGIN_COLUMN: ColumnCoord = Object.freeze({ x: 0, z: 0 });

/**
 * 由种子构造地形对象。
 *
 * 现在全部按平原实现：群系总是平原，地表高度是平原的高度场，列顶地表方块总是草方块，出生列是原点。
 * #75 换成三维密度与四种群系，#76 按铺地表的规则给出列顶地表方块，#84 改为螺旋搜索出生列。
 */
export function createTerrain(seed: number): Terrain {
  const queries = {
    seed,
    biomeAt: (): Biome => Biome.Plains,
    surfaceHeightAt: (x: number, z: number) => plainsSurfaceHeight(seed, x, z),
    surfaceBlockAt: () => BlockType.Grass,
    spawnColumn: ORIGIN_COLUMN,
  };
  return { ...queries, generateChunk: plainsGenerator(queries) };
}

/**
 * 平原地表的基准高度。
 * 与起伏幅度的关系是一条硬约束：`PLAINS_BASE_Y − PLAINS_RELIEF ≥ MIN_SURFACE_Y`，
 * 否则地形会跌到海平面以下。
 */
const PLAINS_BASE_Y = 69;

/**
 * 平原地表相对基准高度的起伏上界（方块）。
 * 这是上界不是实际幅度：多层噪声叠加后极值很少贴到 ±1，实测起伏约 ±3。
 */
const PLAINS_RELIEF = 5;

/**
 * 一次起伏的水平跨度（方块）。
 * 跨度远大于起伏幅度，坡度因此很缓：相邻两列的高度差不超过一格。连续的高度场取整之后
 * 那一格台阶仍然存在，而本切片没有自动上台阶，所以走上坡要跳一下。
 */
const PLAINS_FEATURE_SIZE = 64;

/** 高度场叠加几层噪声。三层足够让平缓的大起伏上带一点碎起伏。 */
const PLAINS_OCTAVES = 3;

/** 草方块之下的泥土层数：每一列在这个闭区间里由种子确定性地取一个。 */
const DIRT_DEPTH_MIN = 3;
const DIRT_DEPTH_MAX = 4;

/**
 * 泥土层数用的种子偏移量。
 * 由同一个世界种子派生出一条与高度场无关的哈希流，泥土的厚薄才不会跟着地形起伏
 * 走出可见的条纹。
 */
const DIRT_DEPTH_SALT = 0x5bf0_3635;

/** 泥土层数的取值个数（DIRT_DEPTH_MIN..DIRT_DEPTH_MAX 闭区间）。 */
const DIRT_DEPTH_SPAN = DIRT_DEPTH_MAX - DIRT_DEPTH_MIN + 1;

/**
 * 某一列的地表高度（最高那层草方块的 y）。
 *
 * 分形噪声给出 [−1, 1] 的起伏，乘幅度加到基准高度上再取整。
 * 起伏跨度远大于幅度，所以坡很缓；结果恒在海平面之上，本切片因此不出现水。
 */
function plainsSurfaceHeight(seed: number, x: number, z: number): number {
  const relief = fbm2(
    seed,
    x / PLAINS_FEATURE_SIZE,
    z / PLAINS_FEATURE_SIZE,
    PLAINS_OCTAVES,
  );
  const height = Math.round(PLAINS_BASE_Y + relief * PLAINS_RELIEF);
  // 常量已经保证了下界，这里再保证一次「地表高于海平面」这条不变量，改常量改错也不会淹掉平原。
  return Math.max(MIN_SURFACE_Y, height);
}

/** 某一列草方块之下的泥土层数。 */
function dirtDepthAt(seed: number, x: number, z: number): number {
  return DIRT_DEPTH_MIN + (hashCoords(seed ^ DIRT_DEPTH_SALT, x, z) % DIRT_DEPTH_SPAN);
}

/**
 * 平原地形的区块生成器。铺地表与放树都按传入的地表高度查询，与地形对象的查询是同一个函数，
 * 查询值与生成结果因此一致。传入的就是地形对象的查询部分，直接当放树的参数用。
 *
 * 每一列自上而下是：一层草方块、3–4 层泥土、一路石头到 y = −63、最底层 y = −64 基岩；
 * 石层里嵌着煤与铁的矿脉，地表之上散布橡树。同一个种子与区块坐标永远得到同样的区块——这是
 * ADR-0003 的核心约束。
 */
function plainsGenerator(terrain: TreePlacement): TerrainGenerator {
  const { seed, surfaceHeightAt } = terrain;
  return (cx, cz) => {
    const chunk = new Chunk(cx, cz);
    chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);

    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const z = originZ + lz;
        const surface = surfaceHeightAt(x, z);
        const dirtBottom = surface - dirtDepthAt(seed, x, z);
        chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, dirtBottom - 1, BlockType.Stone);
        chunk.fillColumn(lx, lz, dirtBottom, surface - 1, BlockType.Dirt);
        chunk.set(lx, surface, lz, BlockType.Grass);
      }
    }

    // 土石铺完再嵌矿脉：矿石只替换石头，得先有石头。
    plantOreVeins(seed, chunk);
    // 再种树：树叶只往空气里长，得先有地面才知道哪里是空气。
    plantOakTrees(terrain, chunk);
    return chunk;
  };
}
