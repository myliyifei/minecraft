import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { World, type ChunkCoord } from '../../src/core/world';
import { TILE } from '../../src/render/atlas';
import {
  buildChunkMesh,
  meshTiles,
  type ChunkMeshData,
  type MeshData,
  type MeshView,
} from '../../src/render/mesh';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/**
 * #83：水与冰进网格的半透明那一部分，剔除看相邻两格的组合，水的顶面正反两面都画（ADR-0016 补记）。
 * 「挡不挡隔壁」判断邻区块要不要重建的规则与网格的剔除是同一个判定，在最后一组里用两边的可观察结果互相核对。
 */

/** 只给方块的假视图：区块之外的光照一律读作 0。 */
function blocksOnly(getBlock: MeshView['getBlock']): MeshView {
  return { getBlock, skyLightAt: () => 0, blockLightAt: () => 0, chunkAt: () => undefined };
}

type Cell = [number, number, number, BlockType];

/** 区块 (0, 0) 里只有给出的这些格，区块内外其余全是空气。 */
function sparseMesh(cells: Cell[]): ChunkMeshData {
  const chunk = new Chunk(0, 0);
  for (const [x, y, z, block] of cells) chunk.set(x, y, z, block);
  const map = new Map(cells.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
  return buildChunkMesh(
    chunk,
    blocksOnly((x, y, z) => map.get(`${x},${y},${z}`) ?? BlockType.Air),
  );
}

function faceCount(part: MeshData): number {
  return part.indices.length / 6;
}

/** 一个面：法线、面中心（区块局部坐标），以及第一个三角形按绕序算出的朝向（叉积，未归一化）。 */
interface Face {
  readonly normal: [number, number, number];
  readonly center: [number, number, number];
  readonly winding: [number, number, number];
}

function facesOf(part: MeshData): Face[] {
  const faces: Face[] = [];
  const vertex = (i: number): [number, number, number] => [
    part.positions[i * 3]!,
    part.positions[i * 3 + 1]!,
    part.positions[i * 3 + 2]!,
  ];
  for (let f = 0; f < faceCount(part); f++) {
    const base = f * 4;
    const center: [number, number, number] = [0, 0, 0];
    for (let v = 0; v < 4; v++) {
      const p = vertex(base + v);
      for (let axis = 0; axis < 3; axis++) center[axis]! += p[axis]! / 4;
    }
    const [a, b, c] = [part.indices[f * 6]!, part.indices[f * 6 + 1]!, part.indices[f * 6 + 2]!].map(vertex) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const winding: [number, number, number] = [
      u[1]! * w[2]! - u[2]! * w[1]!,
      u[2]! * w[0]! - u[0]! * w[2]!,
      u[0]! * w[1]! - u[1]! * w[0]!,
    ];
    faces.push({
      normal: [part.normals[base * 3]!, part.normals[base * 3 + 1]!, part.normals[base * 3 + 2]!],
      center,
      winding,
    });
  }
  return faces;
}

/** 面中心落在 axis 轴的 value 那个平面上的那些面。 */
function facesOnPlane(part: MeshData, axis: 0 | 1 | 2, value: number): Face[] {
  return facesOf(part).filter((face) => face.center[axis] === value);
}

const Y = FLAT_GROUND_Y + 4;

describe('网格分成不透明与半透明两部分（#83）', () => {
  it('水与冰的面在半透明部分，石头、树叶、火把的面在不透明部分', () => {
    const mesh = sparseMesh([
      [2, Y, 2, BlockType.Water],
      [5, Y, 2, BlockType.Ice],
      [8, Y, 2, BlockType.Stone],
      [11, Y, 2, BlockType.OakLeaves],
      [14, Y, 2, BlockType.Torch],
    ]);
    expect(meshTiles(mesh.translucent.uvs)).toEqual(new Set([TILE.water, TILE.ice]));
    expect(meshTiles(mesh.opaque.uvs)).toEqual(new Set([TILE.stone, TILE.oakLeaves, TILE.torch]));
  });

  it('只有一格水的区块：不透明部分一个面都没有，半透明部分有面', () => {
    const mesh = sparseMesh([[8, Y, 8, BlockType.Water]]);
    expect(faceCount(mesh.opaque)).toBe(0);
    expect(faceCount(mesh.translucent)).toBeGreaterThan(0);
  });

  it('没有水与冰的区块：半透明部分一个面都没有', () => {
    const mesh = sparseMesh([[8, Y, 8, BlockType.Stone]]);
    expect(faceCount(mesh.translucent)).toBe(0);
    expect(faceCount(mesh.opaque)).toBe(6);
  });

  it('两部分各自的数组长度对得上：每面 4 个顶点、6 个下标', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [8, Y + 3, 8, BlockType.Stone],
    ]);
    for (const part of [mesh.opaque, mesh.translucent]) {
      const faces = faceCount(part);
      expect(part.positions).toHaveLength(faces * 4 * 3);
      expect(part.normals).toHaveLength(faces * 4 * 3);
      expect(part.uvs).toHaveLength(faces * 4 * 2);
      expect(part.light).toHaveLength(faces * 4 * 2);
    }
  });
});

describe('水贴着空气的顶面正反两面都画（#83）', () => {
  it('悬空一格水：七个面，顶面那个平面上一正一反两个面，绕序与各自的法线同向', () => {
    const mesh = sparseMesh([[8, Y, 8, BlockType.Water]]);
    // 六个面加上顶面的背面
    expect(faceCount(mesh.translucent)).toBe(7);
    const top = facesOnPlane(mesh.translucent, 1, Y + 1);
    expect(top.map((face) => face.normal).sort()).toEqual([
      [0, -1, 0],
      [0, 1, 0],
    ]);
    for (const face of top) {
      // 正面朝上，背面朝下：从水下往上看，单面材质也画得出背面那一份
      expect(Math.sign(face.winding[1]), `法线 ${face.normal}`).toBe(face.normal[1]);
      expect(face.center[0]).toBe(8.5);
      expect(face.center[2]).toBe(8.5);
    }
  });

  it('悬空一格冰：六个面，顶面不画背面', () => {
    const mesh = sparseMesh([[8, Y, 8, BlockType.Ice]]);
    expect(faceCount(mesh.translucent)).toBe(6);
    expect(facesOnPlane(mesh.translucent, 1, Y + 1)).toHaveLength(1);
  });

  it('水的底面与侧面只有一个面', () => {
    const mesh = sparseMesh([[8, Y, 8, BlockType.Water]]);
    expect(facesOnPlane(mesh.translucent, 1, Y)).toHaveLength(1);
    expect(facesOnPlane(mesh.translucent, 0, 8)).toHaveLength(1);
    expect(facesOnPlane(mesh.translucent, 0, 9)).toHaveLength(1);
    expect(facesOnPlane(mesh.translucent, 2, 8)).toHaveLength(1);
    expect(facesOnPlane(mesh.translucent, 2, 9)).toHaveLength(1);
  });
});

describe('水与冰的剔除看相邻两格的组合（#83）', () => {
  it('两格相邻的水之间没有面', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [9, Y, 8, BlockType.Water],
    ]);
    expect(facesOnPlane(mesh.translucent, 0, 9)).toEqual([]);
    // 各 7 个面，减去贴在一起的那一对
    expect(faceCount(mesh.translucent)).toBe(12);
  });

  it('上下叠着的三格水：中间两层平面上没有面，只有最上面一格的顶面正反两面', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [8, Y + 1, 8, BlockType.Water],
      [8, Y + 2, 8, BlockType.Water],
    ]);
    expect(facesOnPlane(mesh.translucent, 1, Y + 1)).toEqual([]);
    expect(facesOnPlane(mesh.translucent, 1, Y + 2)).toEqual([]);
    expect(facesOnPlane(mesh.translucent, 1, Y + 3)).toHaveLength(2);
    // 3 格 × 4 个侧面 + 底面 + 顶面正反两面
    expect(faceCount(mesh.translucent)).toBe(15);
  });

  it('水贴着石头的那一面没有面，石头朝水的那一面照常画在不透明部分', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [9, Y, 8, BlockType.Stone],
    ]);
    expect(facesOnPlane(mesh.translucent, 0, 9)).toEqual([]);
    expect(faceCount(mesh.translucent)).toBe(6);
    const stoneFace = facesOnPlane(mesh.opaque, 0, 9);
    expect(stoneFace.map((face) => face.normal)).toEqual([[-1, 0, 0]]);
    expect(faceCount(mesh.opaque)).toBe(6);
  });

  it('水上面压着石头：水没有顶面，也就没有顶面的背面', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [8, Y + 1, 8, BlockType.Stone],
    ]);
    expect(facesOnPlane(mesh.translucent, 1, Y + 1)).toEqual([]);
    expect(faceCount(mesh.translucent)).toBe(5);
  });

  it('水与冰相邻的面没有面，两边都不画', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [9, Y, 8, BlockType.Ice],
    ]);
    expect(facesOnPlane(mesh.translucent, 0, 9)).toEqual([]);
    // 水 7 − 1，冰 6 − 1
    expect(faceCount(mesh.translucent)).toBe(11);
  });

  it('冰盖在水上：冰的底面与水的顶面都不画', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Water],
      [8, Y + 1, 8, BlockType.Ice],
    ]);
    expect(facesOnPlane(mesh.translucent, 1, Y + 1)).toEqual([]);
    // 水 5 个面（没有顶面），冰 5 个面（没有底面）
    expect(faceCount(mesh.translucent)).toBe(10);
  });

  it('两格相邻的冰之间没有面', () => {
    const mesh = sparseMesh([
      [8, Y, 8, BlockType.Ice],
      [9, Y, 8, BlockType.Ice],
    ]);
    expect(facesOnPlane(mesh.translucent, 0, 9)).toEqual([]);
    expect(faceCount(mesh.translucent)).toBe(10);
  });

  it('水贴着区块边，隔壁区块那一格也是水：边上那个平面没有面', () => {
    // 隔壁那一格只能经视图读到，走的是跨区块边界那条路
    const chunk = new Chunk(0, 0);
    chunk.set(CHUNK_SIZE - 1, Y, 8, BlockType.Water);
    const neighbor = (x: number, y: number, z: number) =>
      (x === CHUNK_SIZE - 1 || x === CHUNK_SIZE) && y === Y && z === 8 ? BlockType.Water : BlockType.Air;
    const mesh = buildChunkMesh(chunk, blocksOnly(neighbor));
    expect(facesOnPlane(mesh.translucent, 0, CHUNK_SIZE)).toEqual([]);
    expect(faceCount(mesh.translucent)).toBe(6);
  });

  it('被石头整个包住的一格水一个面都不出，石头朝水的六个面都在', () => {
    const cells: Cell[] = [[8, Y, 8, BlockType.Water]];
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      cells.push([8 + dx, Y + dy, 8 + dz, BlockType.Stone]);
    }
    const mesh = sparseMesh(cells);
    expect(faceCount(mesh.translucent)).toBe(0);
    // 六块石头各 6 面，朝水的那一面也画：从水里看得到四壁
    expect(faceCount(mesh.opaque)).toBe(36);
  });
});

describe('邻区块要不要重建与网格的剔除是同一个判定（#83）', () => {
  /** 区块 (0, 0) 与西边 (−1, 0) 都已加载的平地世界。 */
  function twoChunkWorld(): World {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.loadChunk(-1, 0);
    return world;
  }

  const Z = 7;
  /** 区块 (0, 0) 的 −X 边，与隔壁区块 (−1, 0) 的 +X 边贴着。 */
  const EDGE_X = 0;
  const NEIGHBOR_X = -1;
  /** 隔壁区块的区块坐标。 */
  const NEIGHBOR_CX = -1;

  function keysOf(coords: readonly ChunkCoord[]): string[] {
    return coords.map(({ cx, cz }) => `${cx},${cz}`);
  }

  it('区块边上一格水换成冰：隔壁的面不变，隔壁不过期', () => {
    const world = twoChunkWorld();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Water);
    world.takeStaleChunks();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Ice);
    expect(keysOf(world.takeStaleChunks().blocks)).toEqual(['0,0']);
  });

  it('区块边上一格冰换成水：隔壁不过期', () => {
    const world = twoChunkWorld();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Ice);
    world.takeStaleChunks();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Water);
    expect(keysOf(world.takeStaleChunks().blocks)).toEqual(['0,0']);
  });

  it('区块边上一格水换成石头：隔壁贴着它的面变了，隔壁过期', () => {
    const world = twoChunkWorld();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Water);
    world.takeStaleChunks();
    world.setBlock(EDGE_X, FLAT_GROUND_Y + 1, Z, BlockType.Stone);
    expect(keysOf(world.takeStaleChunks().blocks)).toEqual(['0,0', '-1,0']);
  });

  /** 隔壁那一列摆的方块：每一档挡不挡隔壁的表现各出一种。火把从不让别的方块少画面，隔壁放它看不出差别，不放。 */
  const NEIGHBORS: readonly BlockType[] = [
    BlockType.Air,
    BlockType.Stone,
    BlockType.Dirt,
    BlockType.Water,
    BlockType.Ice,
    BlockType.OakLeaves,
    BlockType.BirchLeaves,
  ];
  /** 边上那一格在其间互换的方块：上面那些再加火把。 */
  const SWAPS: readonly BlockType[] = [...NEIGHBORS, BlockType.Torch];

  /**
   * 隔壁区块网格里地面以上的那些面，两部分都算，不含光照：只看面变没变。地面以下与区块侧边上那些面
   * 与这一格无关，不比，省得每次都序列化整个区块。
   */
  function facesAboveGround(world: World): string[] {
    const mesh = buildChunkMesh(world.chunkAt(NEIGHBOR_CX, 0)!, world);
    const out: string[] = [];
    for (const [name, part] of [
      ['opaque', mesh.opaque],
      ['translucent', mesh.translucent],
    ] as const) {
      facesOf(part).forEach((face, f) => {
        if (face.center[1] <= FLAT_GROUND_Y + 1) return;
        const uv = Array.from(part.uvs.subarray(f * 8, f * 8 + 8));
        out.push(`${name} ${face.center} ${face.normal} ${face.winding} ${uv}`);
      });
    }
    return out.sort();
  }

  /** 第 k 种隔壁方块所在的高度：隔两格一层，上下互不相邻。 */
  const rowY = (k: number) => FLAT_GROUND_Y + 2 + 3 * k;

  it('边上一格在各种方块之间互换：隔壁过期，当且仅当隔壁网格的面变了', () => {
    const mismatches: string[] = [];
    for (const from of SWAPS) {
      // 每个起点一个世界：换过去、核对、再换回来，隔壁那一列不动
      const world = twoChunkWorld();
      const setEdge = (block: BlockType) => NEIGHBORS.forEach((_, k) => world.setBlock(EDGE_X, rowY(k), Z, block));
      NEIGHBORS.forEach((block, k) => world.setBlock(NEIGHBOR_X, rowY(k), Z, block));
      setEdge(from);
      world.takeStaleChunks();
      const before = JSON.stringify(facesAboveGround(world));
      for (const to of SWAPS) {
        if (from === to) continue;
        setEdge(to);
        const neighborStale = keysOf(world.takeStaleChunks().blocks).includes('-1,0');
        const facesChanged = JSON.stringify(facesAboveGround(world)) !== before;
        if (neighborStale !== facesChanged) {
          mismatches.push(`${from} → ${to}：隔壁过期 ${neighborStale}，隔壁的面变了 ${facesChanged}`);
        }
        setEdge(from);
        world.takeStaleChunks();
      }
    }
    expect(mismatches).toEqual([]);
  });
});
