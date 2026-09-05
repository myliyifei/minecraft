import { BlockType, isOpaque, type BlockView } from '../core/block';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../core/constants';
import { BLOCK_TILES, tileUvRect, type FaceTiles } from './atlas';

/**
 * 一个区块的网格数据。纯 TypedArray，不含任何 three.js 类型——
 * 这样面剔除与贴图映射能在 Node 里测，Three.js 只负责把它包成 BufferGeometry。
 */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

type Corner = readonly [number, number, number];

interface FaceSpec {
  /** 邻居方向，同时是这个面的法线。 */
  readonly dir: Corner;
  /** 面的四个角（单位立方体内），从外部看是逆时针。 */
  readonly corners: readonly [Corner, Corner, Corner, Corner];
  /** 四个角对应的 uv 归一化坐标，v 向上。 */
  readonly uv: readonly [Corner2, Corner2, Corner2, Corner2];
  /** 取方块的哪一张贴图。 */
  readonly face: keyof FaceTiles;
}

type Corner2 = readonly [number, number];

const FACES: readonly FaceSpec[] = [
  {
    dir: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'side',
  },
  {
    dir: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'side',
  },
  {
    dir: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'top',
  },
  {
    dir: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'bottom',
  },
  {
    dir: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'side',
  },
  {
    dir: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'side',
  },
];

/**
 * 为一个区块生成网格：只有暴露面进网格，被不透光方块挡住的面直接跳过。
 *
 * 顶点用区块局部的 x/z（[0, 16]）与世界 y，渲染层把网格整体平移到区块位置。
 * 邻居查询走世界坐标，因此区块边界上的面是否生成取决于相邻区块是否已加载——
 * 未加载的相邻区块读到空气，边界面会暴露。
 */
export function buildChunkMesh(view: BlockView, cx: number, cz: number): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = originX + lx;
        const wz = originZ + lz;
        const block = view.getBlock(wx, y, wz);
        if (block === BlockType.Air) continue;
        const tiles = BLOCK_TILES[block];
        if (!tiles) continue;

        for (const spec of FACES) {
          const [dx, dy, dz] = spec.dir;
          const ny = y + dy;
          // 世界底面之下永远看不见，省掉每个区块 256 个无用面。
          if (ny < WORLD_MIN_Y) continue;
          if (isOpaque(view.getBlock(wx + dx, ny, wz + dz))) continue;

          const base = positions.length / 3;
          const rect = tileUvRect(tiles[spec.face]);
          for (let v = 0; v < 4; v++) {
            const [ox, oy, oz] = spec.corners[v]!;
            positions.push(lx + ox, y + oy, lz + oz);
            normals.push(dx, dy, dz);
            const [du, dv] = spec.uv[v]!;
            uvs.push(
              rect.u0 + du * (rect.u1 - rect.u0),
              rect.v0 + dv * (rect.v1 - rect.v0),
            );
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}
