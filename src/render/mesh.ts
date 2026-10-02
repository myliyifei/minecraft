import { BLOCKS, BlockType, isAir, isOpaque, type BlockView } from '../core/block';
import { BLOCK_LIGHT_MASK, SKY_LIGHT_SHIFT, blockIndex, type ChunkView } from '../core/chunk';
import {
  CHUNK_AREA,
  CHUNK_SIZE,
  MAX_LIGHT_LEVEL,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../core/constants';
import { BLOCK_TILES, faceTile, tileAtUv, tileUvRect, type FaceTiles } from './atlas';
import { CUBE_FACES, type FaceSpec } from './cube-faces';
import { SELF_LIT_BLOCK_LIGHT } from './shading';
import { torchModel } from './torch-model';

/**
 * 一个区块的网格数据。纯 TypedArray，不含任何 three.js 类型——
 * 这样面剔除与贴图映射能在 Node 里测，Three.js 只负责把它包成 BufferGeometry。
 */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /**
   * 每个顶点两个数：天光、方块光（ADR-0016），按平滑光照取的是 4 格的平均，所以是 0.25 的倍数。
   * 存原始等级而不是折算后的亮度：世界时刻与闪烁都只是着色器每帧的输入，网格不必为它们重建。
   */
  readonly light: Float32Array;
  readonly indices: Uint32Array;
  /**
   * 这个区块里的发光方块（火把、燃烧中的熔炉）：粒子系统从这里挑出玩家附近的，让它们冒火焰与烟（#59）。
   * 跟着网格一起建：方块一变区块就重建网格，列表也就跟着变，熄火的熔炉下一次重建就不在了。
   */
  readonly glowingBlocks: readonly GlowingBlock[];
}

/** 一格发光方块：编号与世界坐标（方块的最小角）。编号里带着火把的朝向，冒粒子的位置按它算。 */
export interface GlowingBlock {
  readonly block: BlockType;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 网格构建按世界坐标读区块之外的那些格子：方块，加两个光照等级。
 * 区块边上的面要问隔壁区块的方块，边上的角还要读隔壁（含斜对角）区块的光照。
 */
export interface MeshView extends BlockView {
  skyLightAt(x: number, y: number, z: number): number;
  blockLightAt(x: number, y: number, z: number): number;
}

/** 六个面的法线分量，摊成三条扁平数组：内层循环里取分量不必解构对象。 */
const FACE_DX = Int8Array.from(CUBE_FACES, (spec) => spec.normal[0]);
const FACE_DY = Int8Array.from(CUBE_FACES, (spec) => spec.normal[1]);
const FACE_DZ = Int8Array.from(CUBE_FACES, (spec) => spec.normal[2]);

/**
 * 邻居方块在区块数据里的下标偏移，与 CUBE_FACES 一一对应。
 * 区块内的邻居因此是一次加法，不必重算下标——见 `blockIndex` 的排布约定。
 */
const FACE_OFFSETS = Int32Array.from(
  CUBE_FACES,
  (spec) => spec.normal[1] * CHUNK_AREA + spec.normal[2] * CHUNK_SIZE + spec.normal[0],
);

/**
 * 平滑光照取样的格子：第 f 面第 v 个角挨着的 4 格，相对方块本身的偏移，摊成 `[f][v * 12 + k * 3 + axis]`。
 *
 * 4 格都在这一面外侧那一层（方块加上法线），是那一层里围着这个角的 2×2：沿这一面的两条边各往角
 * 那一侧走 0 或 1 格。角坐标是 1 的那条轴往 +1 走，是 0 的往 −1 走。
 */
const CORNER_SAMPLES = CUBE_FACES.map((spec) => {
  const offsets: number[] = [];
  for (const corner of spec.corners) {
    const toward = corner.map((c) => (c === 1 ? 1 : -1));
    const tangents = [0, 1, 2].filter((axis) => spec.normal[axis] === 0);
    for (const [stepU, stepV] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const offset = [...spec.normal];
      offset[tangents[0]!]! += stepU! * toward[tangents[0]!]!;
      offset[tangents[1]!]! += stepV! * toward[tangents[1]!]!;
      offsets.push(...offset);
    }
  }
  return Int8Array.from(offsets);
});

/** 世界最高一层之上是天空：天光 15、方块光 0，按光照数组的格式打包。 */
const OPEN_SKY = MAX_LIGHT_LEVEL << SKY_LIGHT_SHIFT;

/**
 * 一份网格的 uv 用到了哪些贴图格号。
 *
 * 每个面 4 个顶点、每顶点一对 uv，取四个顶点的中点反查（`tileAtUv`）：四个角正落在格的
 * 边界上，会算进相邻的格里。端到端测试靠它确认画布上那块熔炉贴的是熄火还是燃烧的正面——
 * 读回的是送上显卡的 uv，不必去比像素颜色。
 */
export function meshTiles(uvs: ArrayLike<number>): Set<number> {
  const tiles = new Set<number>();
  for (let i = 0; i + 7 < uvs.length; i += 8) {
    const u = (uvs[i]! + uvs[i + 2]! + uvs[i + 4]! + uvs[i + 6]!) / 4;
    const v = (uvs[i + 1]! + uvs[i + 3]! + uvs[i + 5]! + uvs[i + 7]!) / 4;
    tiles.add(tileAtUv(u, v));
  }
  return tiles;
}

/**
 * 为一个区块生成网格：只有暴露面进网格，被不透明方块挡住的面直接跳过。
 *
 * 每个顶点带天光与方块光（ADR-0016），按**平滑光照**取：这一面外侧那一层里挨着这个角的 4 格，
 * 两个等级各自平均，不透明的格子按 0 计入，墙脚与凹处因此偏暗。4 格可以落在隔壁区块里，
 * 所以要等周围 8 个区块都加载、光照算好再建（`planChunkMeshes`）。
 *
 * 顶点用区块局部的 x/z（[0, 16]）与世界 y，渲染层把网格整体平移到区块位置。
 * 区块内的邻居直接在区块数据上做下标算术；只有跨出区块边界的那些才走 `view`，
 * 因此边界上的面是否生成取决于相邻区块是否已加载——未加载的相邻区块读到空气，
 * 边界面会暴露（一个四邻皆空的区块因此产生 8842 个面，四邻齐全时只有 273 个，
 * 流式加载据此只给周围 8 个邻居齐全的区块建网格，见 `planChunkMeshes`）。
 *
 * 这个函数是每帧预算的大头：一个区块要问二十多万次邻居，逐格走 `view.getBlock`
 * （三次取整 + Map 查找）实测 22ms，下标算术是 4ms。
 */
export function buildChunkMesh(chunk: ChunkView, view: MeshView): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const lights: number[] = [];
  const indices: number[] = [];
  const glowingBlocks: GlowingBlock[] = [];
  const blocks = chunk.blocks;
  const light = chunk.light;
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;

  /** 区块局部坐标那一格的光照，按光照数组的格式打包；不透明的格子读作 0。 */
  const sample = (lx: number, y: number, lz: number): number => {
    if (y > WORLD_MAX_Y) return OPEN_SKY;
    // 世界底面之下当作不透明：只有贴着最底层的侧面会读到这里。
    if (y < WORLD_MIN_Y) return 0;
    if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      const j = blockIndex(lx, y, lz);
      if (isOpaque(blocks[j] as BlockType)) return 0;
      return light ? light[j]! : 0;
    }
    const x = originX + lx;
    const z = originZ + lz;
    if (isOpaque(view.getBlock(x, y, z))) return 0;
    return (view.skyLightAt(x, y, z) << SKY_LIGHT_SHIFT) | view.blockLightAt(x, y, z);
  };

  /** 区块局部坐标那一格的一个面：位置、法线、uv 与两个三角形。光照由调用处按顶点顺序补上。 */
  const pushQuad = (spec: FaceSpec, lx: number, y: number, lz: number, tiles: FaceTiles): void => {
    const base = positions.length / 3;
    const rect = tileUvRect(faceTile(tiles, spec.face));
    const [nx, ny, nz] = spec.normal;
    for (let v = 0; v < 4; v++) {
      const [ox, oy, oz] = spec.corners[v]!;
      positions.push(lx + ox, y + oy, lz + oz);
      normals.push(nx, ny, nz);
      const [du, dv] = spec.uv[v]!;
      uvs.push(rect.u0 + du * (rect.u1 - rect.u0), rect.v0 + dv * (rect.v1 - rect.v0));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      // 一行 16 格在数据里是连着的，下标随 lx 递增即可。
      let i = blockIndex(0, y, lz);
      for (let lx = 0; lx < CHUNK_SIZE; lx++, i++) {
        const block = blocks[i] as BlockType;
        if (isAir(block)) continue;
        const tiles = BLOCK_TILES[block];
        if (!tiles) continue;
        if (BLOCKS[block].lightEmission > 0) glowingBlocks.push({ block, x: originX + lx, y, z: originZ + lz });

        // 火把不走六面剔除：细杆碰不到邻格，五个面总要画。两个等级写满，方块光那一项同时是着色器认的
        // 标记（`SELF_LIT_BLOCK_LIGHT`）：火把本身不吃光照，按贴图本色画。
        const model = torchModel(block);
        if (model) {
          for (const spec of model) {
            pushQuad(spec, lx, y, lz, tiles);
            for (let v = 0; v < 4; v++) lights.push(MAX_LIGHT_LEVEL, SELF_LIT_BLOCK_LIGHT);
          }
          continue;
        }

        for (let f = 0; f < CUBE_FACES.length; f++) {
          const dy = FACE_DY[f]!;
          const ny = y + dy;
          // 世界底面之下永远看不见，省掉每个区块 256 个无用面。
          if (ny < WORLD_MIN_Y) continue;

          const nlx = lx + FACE_DX[f]!;
          const nlz = lz + FACE_DZ[f]!;
          let neighbor: BlockType;
          if (ny > WORLD_MAX_Y) {
            // 世界顶面之上什么都没有，那一层的顶面因此是暴露的。
            neighbor = BlockType.Air;
          } else if (nlx >= 0 && nlx < CHUNK_SIZE && nlz >= 0 && nlz < CHUNK_SIZE) {
            neighbor = blocks[i + FACE_OFFSETS[f]!] as BlockType;
          } else {
            neighbor = view.getBlock(originX + nlx, ny, originZ + nlz);
          }

          if (isOpaque(neighbor)) continue;
          // 走到这里说明邻居不遮挡视线（空气或树叶）。同种方块相邻时两个面完全重合：
          // 留着只会 z-fighting、还让树冠内部的几何翻倍。整片树叶因此只保留最外层的面。
          if (neighbor === block) continue;

          pushQuad(CUBE_FACES[f]!, lx, y, lz, tiles);
          const samples = CORNER_SAMPLES[f]!;
          for (let v = 0; v < 4; v++) {
            let sky = 0;
            let blockLight = 0;
            for (let k = v * 12; k < v * 12 + 12; k += 3) {
              const s = sample(lx + samples[k]!, y + samples[k + 1]!, lz + samples[k + 2]!);
              sky += s >> SKY_LIGHT_SHIFT;
              blockLight += s & BLOCK_LIGHT_MASK;
            }
            lights.push(sky / 4, blockLight / 4);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    light: new Float32Array(lights),
    indices: new Uint32Array(indices),
    glowingBlocks,
  };
}
