import { describe, expect, it } from 'vitest';
import { BlockType, type BlockView } from '../../src/core/block';
import { CHUNK_SIZE, FLAT_SURFACE_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { flatTerrain } from '../../src/core/terrain';
import { World } from '../../src/core/world';
import { tileUvRect, TILE } from '../../src/render/atlas';
import { buildChunkMesh, type MeshData } from '../../src/render/mesh';

/** 处处都是同一种方块的视图，用来构造「被完全包围」的极端情形。 */
function uniformView(block: BlockType): BlockView {
  return { getBlock: () => block };
}

/** 只有指定坐标有方块、其余全是空气的视图。 */
function sparseView(blocks: Array<[number, number, number, BlockType]>): BlockView {
  const map = new Map(blocks.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
  return {
    getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? BlockType.Air,
  };
}

function faceCount(mesh: MeshData): number {
  return mesh.indices.length / 6;
}

/** 收集每个面的法线（每 4 个顶点一个面）。 */
function faceNormals(mesh: MeshData): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let f = 0; f < faceCount(mesh); f++) {
    const i = f * 12;
    out.push([mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!]);
  }
  return out;
}

/** 面中心，用来判断顶点绕序对应的朝向是否与法线一致。 */
function faceCenters(mesh: MeshData): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let f = 0; f < faceCount(mesh); f++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let v = 0; v < 4; v++) {
      const i = f * 12 + v * 3;
      cx += mesh.positions[i]!;
      cy += mesh.positions[i + 1]!;
      cz += mesh.positions[i + 2]!;
    }
    out.push([cx / 4, cy / 4, cz / 4]);
  }
  return out;
}

describe('区块网格只生成暴露面', () => {
  it('全是石头时一个面都不生成', () => {
    const mesh = buildChunkMesh(uniformView(BlockType.Stone), 0, 0);
    expect(faceCount(mesh)).toBe(0);
    expect(mesh.positions).toHaveLength(0);
  });

  it('全是空气时一个面都不生成', () => {
    const mesh = buildChunkMesh(uniformView(BlockType.Air), 0, 0);
    expect(faceCount(mesh)).toBe(0);
  });

  it('周围区块都已加载的平地区块只产生 256 个朝上的顶面', () => {
    const world = new World(flatTerrain);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        world.loadChunk(dx, dz);
      }
    }
    const mesh = buildChunkMesh(world, 0, 0);
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    for (const n of faceNormals(mesh)) {
      expect(n).toEqual([0, 1, 0]);
    }
  });

  it('世界底面之下不生成面', () => {
    const world = new World(flatTerrain);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        world.loadChunk(dx, dz);
      }
    }
    const mesh = buildChunkMesh(world, 0, 0);
    for (const [, y] of faceCenters(mesh)) {
      expect(y).toBeGreaterThan(WORLD_MIN_Y);
    }
  });

  it('未加载的相邻区块视为边界，区块侧面暴露', () => {
    const world = new World(flatTerrain);
    world.loadChunk(0, 0);
    const mesh = buildChunkMesh(world, 0, 0);
    // 256 个顶面 + 四条边界上每层 16 个侧面，实心层为 y ∈ [−64, 63]
    const solidLayers = FLAT_SURFACE_Y - WORLD_MIN_Y + 1;
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE + 4 * CHUNK_SIZE * solidLayers);
  });
});

describe('单个悬空方块的网格', () => {
  const x = 8;
  const y = FLAT_SURFACE_Y + 4;
  const z = 8;

  it('六个面全部生成，索引与顶点数量匹配', () => {
    const mesh = buildChunkMesh(sparseView([[x, y, z, BlockType.Stone]]), 0, 0);
    expect(faceCount(mesh)).toBe(6);
    expect(mesh.positions).toHaveLength(6 * 4 * 3);
    expect(mesh.normals).toHaveLength(6 * 4 * 3);
    expect(mesh.uvs).toHaveLength(6 * 4 * 2);
    expect(mesh.indices).toHaveLength(6 * 6);
  });

  it('六个面的法线覆盖六个方向且朝外', () => {
    const mesh = buildChunkMesh(sparseView([[x, y, z, BlockType.Stone]]), 0, 0);
    const normals = faceNormals(mesh);
    const centers = faceCenters(mesh);
    const seen = new Set(normals.map((n) => n.join(',')));
    expect(seen).toEqual(
      new Set(['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']),
    );
    // 面中心相对方块中心的偏移方向应与法线同向
    for (let f = 0; f < normals.length; f++) {
      const [nx, ny, nz] = normals[f]!;
      const [fx, fy, fz] = centers[f]!;
      const dot = (fx - (x + 0.5)) * nx + (fy - (y + 0.5)) * ny + (fz - (z + 0.5)) * nz;
      expect(dot).toBeCloseTo(0.5);
    }
  });

  it('顶点落在方块的单位立方体上', () => {
    const mesh = buildChunkMesh(sparseView([[x, y, z, BlockType.Stone]]), 0, 0);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeGreaterThanOrEqual(x);
      expect(mesh.positions[i]).toBeLessThanOrEqual(x + 1);
      expect(mesh.positions[i + 1]).toBeGreaterThanOrEqual(y);
      expect(mesh.positions[i + 1]).toBeLessThanOrEqual(y + 1);
      expect(mesh.positions[i + 2]).toBeGreaterThanOrEqual(z);
      expect(mesh.positions[i + 2]).toBeLessThanOrEqual(z + 1);
    }
  });
});

describe('面到图集贴图的映射', () => {
  const x = 8;
  const y = FLAT_SURFACE_Y + 4;
  const z = 8;

  /** 取指定法线那一面的 uv，并断言它落在某个 tile 的矩形内。 */
  function expectFaceTile(
    mesh: MeshData,
    normal: [number, number, number],
    tile: number,
  ): void {
    const normals = faceNormals(mesh);
    const index = normals.findIndex((n) => n.join(',') === normal.join(','));
    expect(index).toBeGreaterThanOrEqual(0);
    const rect = tileUvRect(tile);
    for (let v = 0; v < 4; v++) {
      const i = index * 8 + v * 2;
      expect(mesh.uvs[i]).toBeGreaterThanOrEqual(rect.u0);
      expect(mesh.uvs[i]).toBeLessThanOrEqual(rect.u1);
      expect(mesh.uvs[i + 1]).toBeGreaterThanOrEqual(rect.v0);
      expect(mesh.uvs[i + 1]).toBeLessThanOrEqual(rect.v1);
    }
  }

  it('草方块顶面用草贴图、侧面用草泥过渡、底面用泥土', () => {
    const mesh = buildChunkMesh(sparseView([[x, y, z, BlockType.Grass]]), 0, 0);
    expectFaceTile(mesh, [0, 1, 0], TILE.grassTop);
    expectFaceTile(mesh, [0, 0, 1], TILE.grassSide);
    expectFaceTile(mesh, [0, -1, 0], TILE.dirt);
  });

  it('橡木原木顶面是年轮、侧面是树皮', () => {
    const mesh = buildChunkMesh(sparseView([[x, y, z, BlockType.OakLog]]), 0, 0);
    expectFaceTile(mesh, [0, 1, 0], TILE.oakLogTop);
    expectFaceTile(mesh, [1, 0, 0], TILE.oakLogSide);
  });

  it('石头、基岩、泥土、树叶六面同贴图', () => {
    const cases: Array<[BlockType, number]> = [
      [BlockType.Stone, TILE.stone],
      [BlockType.Bedrock, TILE.bedrock],
      [BlockType.Dirt, TILE.dirt],
      [BlockType.OakLeaves, TILE.oakLeaves],
    ];
    for (const [block, tile] of cases) {
      const mesh = buildChunkMesh(sparseView([[x, y, z, block]]), 0, 0);
      for (const n of faceNormals(mesh)) {
        expectFaceTile(mesh, n, tile);
      }
    }
  });

  it('所有 uv 都在图集范围内', () => {
    const mesh = buildChunkMesh(
      sparseView([
        [x, y, z, BlockType.Grass],
        [x + 2, y, z, BlockType.OakLog],
        [x + 4, y, z, BlockType.OakLeaves],
      ]),
      0,
      0,
    );
    for (const uv of mesh.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });
});

describe('区块网格的坐标系', () => {
  it('顶点使用区块局部的 x/z 与世界 y', () => {
    const world = new World(flatTerrain);
    world.loadChunk(2, -3);
    const mesh = buildChunkMesh(world, 2, -3);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.positions[i]).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(mesh.positions[i + 2]).toBeGreaterThanOrEqual(0);
      expect(mesh.positions[i + 2]).toBeLessThanOrEqual(CHUNK_SIZE);
    }
    const normals = faceNormals(mesh);
    const tops = faceCenters(mesh).filter((_, f) => normals[f]![1] === 1);
    expect(tops.length).toBeGreaterThan(0);
    for (const [, cy] of tops) {
      expect(cy).toBe(FLAT_SURFACE_Y + 1);
    }
  });
});
