import { BlockType } from './block';
import { Chunk } from './chunk';
import { CHUNK_SIZE, MIN_SURFACE_Y, WORLD_MIN_Y } from './constants';
import { fbm2, hashCoords } from './noise';

/**
 * 地形生成是纯函数：区块坐标决定区块内容，不依赖相邻区块的加载顺序。
 * 种子由 `plainsTerrain(seed)` 捕获在闭包里，因此生成器本身只需要区块坐标。
 * issue #6 让橡树以确定性方式跨区块写入。
 */
export type TerrainGenerator = (cx: number, cz: number) => Chunk;

/**
 * 平原地表的基准高度。
 * 与起伏幅度的关系是一条硬约束：`PLAINS_BASE_Y − PLAINS_RELIEF ≥ MIN_SURFACE_Y`，
 * 否则地形会跌到海平面以下。
 */
export const PLAINS_BASE_Y = 69;

/**
 * 平原地表相对基准高度的起伏上界（方块）。
 * 这是上界不是实际幅度：多层噪声叠加后极值很少贴到 ±1，实测起伏约 ±3。
 */
export const PLAINS_RELIEF = 5;

/**
 * 一次起伏的水平跨度（方块）。
 * 跨度远大于起伏幅度，坡度因此很缓——玩家不必跳跃就能走上任何一个坡（issue #4）。
 */
export const PLAINS_FEATURE_SIZE = 64;

/** 高度场叠加几层噪声。三层足够让平缓的大起伏上带一点碎起伏。 */
export const PLAINS_OCTAVES = 3;

/** 草方块之下的泥土层数：每一列在这个闭区间里由种子确定性地取一个。 */
export const DIRT_DEPTH_MIN = 3;
export const DIRT_DEPTH_MAX = 4;

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
export function plainsSurfaceHeight(seed: number, x: number, z: number): number {
  const relief = fbm2(
    seed,
    x / PLAINS_FEATURE_SIZE,
    z / PLAINS_FEATURE_SIZE,
    PLAINS_OCTAVES,
  );
  const height = Math.round(PLAINS_BASE_Y + relief * PLAINS_RELIEF);
  // 常量已经保证了下界，这里兜住「地表高于海平面」这条不变量，改常量改错也不会淹掉平原。
  return Math.max(MIN_SURFACE_Y, height);
}

/** 某一列草方块之下的泥土层数。 */
function dirtDepthAt(seed: number, x: number, z: number): number {
  return DIRT_DEPTH_MIN + (hashCoords(seed ^ DIRT_DEPTH_SALT, x, z) % DIRT_DEPTH_SPAN);
}

/**
 * 由种子生成平原地形的生成器。
 *
 * 每一列自上而下是：一层草方块、3–4 层泥土、一路石头到 y = −63、最底层 y = −64 基岩。
 * 同一个种子与区块坐标永远得到同样的区块——这是 ADR-0003 的核心约束。
 */
export function plainsTerrain(seed: number): TerrainGenerator {
  return (cx, cz) => {
    const chunk = new Chunk(cx, cz);
    chunk.fillLayer(WORLD_MIN_Y, BlockType.Bedrock);

    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + lx;
        const z = originZ + lz;
        const surface = plainsSurfaceHeight(seed, x, z);
        const dirtBottom = surface - dirtDepthAt(seed, x, z);
        chunk.fillColumn(lx, lz, WORLD_MIN_Y + 1, dirtBottom - 1, BlockType.Stone);
        chunk.fillColumn(lx, lz, dirtBottom, surface - 1, BlockType.Dirt);
        chunk.set(lx, surface, lz, BlockType.Grass);
      }
    }

    return chunk;
  };
}
