import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';
import { createTerrain } from '../../src/core/terrain';
import { chunkOf, chunksAround, ORIGIN_CHUNK, World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';
import { tileUvRect, TILE } from '../../src/render/atlas';
import {
  buildChunkMesh,
  meshTiles,
  warmUpChunkMeshes,
  type ChunkMeshData,
  type MeshData,
  type MeshView,
} from '../../src/render/mesh';
import { torchHitbox } from '../../src/core/torch';
import { TreeSpecies, treesTouching } from '../../src/core/tree';
import { SELF_LIT_BLOCK_LIGHT } from '../../src/render/shading';

/**
 * 待生成网格的区块，配一个「区块之外」的视图。
 * 网格生成读自己那块方块数据，只有跨出边界时才问视图，所以这两样要一起给。
 */
interface MeshInput {
  readonly chunk: Chunk;
  readonly view: MeshView;
}

/** 只给方块的假视图：区块之外的光照一律读作 0。只看面剔除与贴图的测试用它。 */
function blocksOnly(getBlock: MeshView['getBlock']): MeshView {
  return { getBlock, skyLightAt: () => 0, blockLightAt: () => 0, chunkAt: () => undefined };
}

/** 网格的不透明部分：水与冰之外的方块都在这里（#83）。 */
function meshOf({ chunk, view }: MeshInput): MeshData {
  return buildChunkMesh(chunk, view).opaque;
}

/** 网格构建顺带输出的发光方块。 */
function glowingOf({ chunk, view }: MeshInput): ChunkMeshData['glowingBlocks'] {
  return buildChunkMesh(chunk, view).glowingBlocks;
}

/** 区块内外处处都是同一种方块，用来构造「被完全包围」的极端情形。 */
function uniform(block: BlockType): MeshInput {
  const chunk = new Chunk(0, 0);
  chunk.blocks.fill(block);
  return { chunk, view: blocksOnly(() => block) };
}

/** 只有指定坐标有方块、其余全是空气；坐标必须落在区块 (0, 0) 内。 */
function sparse(blocks: Array<[number, number, number, BlockType]>): MeshInput {
  const chunk = new Chunk(0, 0);
  for (const [x, y, z, block] of blocks) chunk.set(x, y, z, block);
  const map = new Map(blocks.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
  return {
    chunk,
    view: blocksOnly((x, y, z) => map.get(`${x},${y},${z}`) ?? BlockType.Air),
  };
}

/** 已加载区块 (cx, cz) 的网格输入。 */
function fromWorld(world: World, cx: number, cz: number): MeshInput {
  const chunk = world.chunkAt(cx, cz);
  if (!chunk) throw new Error(`区块 (${cx}, ${cz}) 没有加载`);
  return { chunk, view: world };
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
  it('从底填到顶的石头只暴露世界顶面那一层，内部一个面都没有', () => {
    // 世界顶面之上没有方块，所以那 256 个朝上的面是暴露的；其余全被邻居挡住。
    const mesh = meshOf(uniform(BlockType.Stone));
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    for (const n of faceNormals(mesh)) expect(n).toEqual([0, 1, 0]);
    for (const [, cy] of faceCenters(mesh)) expect(cy).toBe(WORLD_MAX_Y + 1);
  });

  it('全是空气时一个面都不生成', () => {
    const mesh = meshOf(uniform(BlockType.Air));
    expect(faceCount(mesh)).toBe(0);
  });

  it('全是树叶时内部一个面都不生成：同种方块之间的重合面互相剔除', () => {
    // 树叶不遮挡视线，剔除靠的是「邻居与自己同种」这一条，结果与石头一样。
    const mesh = meshOf(uniform(BlockType.OakLeaves));
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    for (const n of faceNormals(mesh)) expect(n).toEqual([0, 1, 0]);
  });

  it('周围区块都已加载的平地区块只产生 256 个朝上的顶面', () => {
    const world = new World(flatTestTerrain);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        world.loadChunk(dx, dz);
      }
    }
    const mesh = meshOf(fromWorld(world, 0, 0));
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    for (const n of faceNormals(mesh)) {
      expect(n).toEqual([0, 1, 0]);
    }
  });

  it('世界底面之下不生成面', () => {
    const world = new World(flatTestTerrain);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        world.loadChunk(dx, dz);
      }
    }
    const mesh = meshOf(fromWorld(world, 0, 0));
    for (const [, y] of faceCenters(mesh)) {
      expect(y).toBeGreaterThan(WORLD_MIN_Y);
    }
  });

  it('未加载的相邻区块视为边界，区块侧面暴露', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    const mesh = meshOf(fromWorld(world, 0, 0));
    // 256 个顶面 + 四条边界上每层 16 个侧面，实心层为 y ∈ [−64, FLAT_GROUND_Y]
    const solidLayers = FLAT_GROUND_Y - WORLD_MIN_Y + 1;
    expect(faceCount(mesh)).toBe(CHUNK_SIZE * CHUNK_SIZE + 4 * CHUNK_SIZE * solidLayers);
  });
});

describe('单个悬空方块的网格', () => {
  const x = 8;
  const y = FLAT_GROUND_Y + 4;
  const z = 8;

  it('六个面全部生成，索引与顶点数量匹配', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.Stone]]));
    expect(faceCount(mesh)).toBe(6);
    expect(mesh.positions).toHaveLength(6 * 4 * 3);
    expect(mesh.normals).toHaveLength(6 * 4 * 3);
    expect(mesh.uvs).toHaveLength(6 * 4 * 2);
    expect(mesh.indices).toHaveLength(6 * 6);
  });

  it('六个面的法线覆盖六个方向且朝外', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.Stone]]));
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
    const mesh = meshOf(sparse([[x, y, z, BlockType.Stone]]));
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

describe('不遮挡视线的方块与邻居', () => {
  const y = FLAT_GROUND_Y + 4;

  it('相邻两块树叶之间不生成重合的两个面', () => {
    const mesh = meshOf(
      sparse([
        [8, y, 8, BlockType.OakLeaves],
        [9, y, 8, BlockType.OakLeaves],
      ]),
    );
    // 各 6 面减去贴在一起的那一对
    expect(faceCount(mesh)).toBe(10);
  });

  it('树叶挡不住邻居的面，石头挡得住', () => {
    const mesh = meshOf(
      sparse([
        [8, y, 8, BlockType.OakLeaves],
        [9, y, 8, BlockType.Stone],
      ]),
    );
    // 树叶朝石头那面被剔除（5 面），石头朝树叶那面保留（6 面）
    expect(faceCount(mesh)).toBe(11);
  });
});

describe('火把的细杆几何（#57）', () => {
  const x = 8;
  const y = FLAT_GROUND_Y + 1;
  const z = 8;

  it('一支地面火把输出 5 个面——四个侧面与顶面，没有底面，也不是整格立方体', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.Torch]]));
    expect(faceCount(mesh)).toBe(5);
    expect(mesh.positions).toHaveLength(5 * 4 * 3);
    expect(mesh.light).toHaveLength(5 * 4 * 2);
    expect(mesh.indices).toHaveLength(5 * 6);
    expect(new Set(faceNormals(mesh).map((n) => n.join(',')))).toEqual(
      new Set(['1,0,0', '-1,0,0', '0,1,0', '0,0,1', '0,0,-1']),
    );
    // 细杆截面 2/16、高 10/16，以格中心为轴立在格底
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeCloseTo(x + 0.5 + (mesh.positions[i]! > x + 0.5 ? 1 : -1) / 16);
      expect(mesh.positions[i + 1]).toBeGreaterThanOrEqual(y);
      expect(mesh.positions[i + 1]).toBeLessThanOrEqual(y + 10 / 16 + 1e-6);
      expect(mesh.positions[i + 2]).toBeCloseTo(z + 0.5 + (mesh.positions[i + 2]! > z + 0.5 ? 1 : -1) / 16);
    }
  });

  /** 网格全部顶点的平均位置，相对火把那一格的最小角。 */
  function centroid(mesh: MeshData): [number, number, number] {
    const sum = [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i++) sum[i % 3]! += mesh.positions[i]!;
    const n = mesh.positions.length / 3;
    return [sum[0]! / n - x, sum[1]! / n - y, sum[2]! / n - z];
  }

  it('地面火把居中；四个墙上编号各自偏向贴着的那面墙，另一条水平轴仍在格中心', () => {
    const [gx, , gz] = centroid(meshOf(sparse([[x, y, z, BlockType.Torch]])));
    expect(gx).toBeCloseTo(0.5);
    expect(gz).toBeCloseTo(0.5);
    // [编号, 墙在哪条轴上, 墙在那条轴的哪一头]
    const walls: Array<[BlockType, 0 | 2, -1 | 1]> = [
      [BlockType.WallTorchNegX, 0, -1],
      [BlockType.WallTorchPosX, 0, 1],
      [BlockType.WallTorchNegZ, 2, -1],
      [BlockType.WallTorchPosZ, 2, 1],
    ];
    for (const [block, axis, side] of walls) {
      const center = centroid(meshOf(sparse([[x, y, z, block]])));
      // 偏向墙那一侧至少四分之一格，但不越出这一格
      expect((center[axis]! - 0.5) * side, `编号 ${block}`).toBeGreaterThan(0.25);
      expect((center[axis]! - 0.5) * side, `编号 ${block}`).toBeLessThan(0.5);
      expect(center[2 - axis]!, `编号 ${block}`).toBeCloseTo(0.5);
    }
  });

  it('墙上火把是斜的：顶端离墙比底部远，底部贴着墙，整根比地面火把抬高', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.WallTorchNegX]]));
    let bottomX = Infinity;
    let topX = -Infinity;
    let lowest = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const px = mesh.positions[i]! - x;
      const py = mesh.positions[i + 1]! - y;
      lowest = Math.min(lowest, py);
      if (py < 0.25) bottomX = Math.min(bottomX, px);
      if (py > 0.7) topX = Math.max(topX, px);
      // 每个顶点都在这一格里
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(1);
    }
    expect(bottomX).toBeLessThan(1 / 16);
    expect(topX).toBeGreaterThan(0.25);
    expect(lowest).toBeGreaterThan(0.1);
  });

  it('墙上火把的几何正好装进视线用的盒子（torchHitbox），选框套住的就是画出来的整根斜杆', () => {
    for (const block of [
      BlockType.WallTorchNegX,
      BlockType.WallTorchPosX,
      BlockType.WallTorchNegZ,
      BlockType.WallTorchPosZ,
    ]) {
      const mesh = meshOf(sparse([[x, y, z, block]]));
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3]!, mesh.positions[i]!);
        max[i % 3] = Math.max(max[i % 3]!, mesh.positions[i]!);
      }
      // 顶点存在 Float32Array 里，y 在 70 左右时只有五六位小数是准的
      const box = torchHitbox(block, x, y, z)!;
      expect(min[0], `编号 ${block}`).toBeCloseTo(box.min.x, 5);
      expect(min[1], `编号 ${block}`).toBeCloseTo(box.min.y, 5);
      expect(min[2], `编号 ${block}`).toBeCloseTo(box.min.z, 5);
      expect(max[0], `编号 ${block}`).toBeCloseTo(box.max.x, 5);
      expect(max[1], `编号 ${block}`).toBeCloseTo(box.max.y, 5);
      expect(max[2], `编号 ${block}`).toBeCloseTo(box.max.z, 5);
    }
  });

  it('火把顶点的天光与方块光都是 15，夜里洞中也一样', () => {
    // 区块外一律读作 0 的视图里，四周没有任何光源
    for (const block of [BlockType.Torch, BlockType.WallTorchPosZ]) {
      const mesh = meshOf(sparse([[x, y, z, block]]));
      expect([...new Set(mesh.light)], `编号 ${block}`).toEqual([15]);
    }
  });

  it('只有火把自己的顶点带标记的方块光：贴着它的石头，最亮的角也低于这个等级', () => {
    // 真实光照：世界里放一支火把，石头的面按平滑光照取到它那一格的 14
    const world = new World(flatTestTerrain);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    world.setBlock(x, FLAT_GROUND_Y + 1, z, BlockType.Stone);
    world.setBlock(x + 1, FLAT_GROUND_Y + 1, z, BlockType.WallTorchNegX);
    const mesh = meshOf(fromWorld(world, 0, 0));
    let torchVertices = 0;
    let brightestOther = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const blockLight = mesh.light[v * 2 + 1]!;
      if (blockLight === SELF_LIT_BLOCK_LIGHT) torchVertices++;
      else brightestOther = Math.max(brightestOther, blockLight);
    }
    expect(torchVertices).toBe(5 * 4);
    expect(brightestOther).toBeGreaterThan(10);
    expect(brightestOther).toBeLessThan(SELF_LIT_BLOCK_LIGHT);
  });

  it('火把不剔除邻格的面：贴着的石头朝火把那一面照常生成', () => {
    // 石头在下、火把立在它上面；另一块石头在西边、墙上火把贴着它
    const ground = meshOf(sparse([[x, y - 1, z, BlockType.Stone], [x, y, z, BlockType.Torch]]));
    expect(faceCount(ground)).toBe(6 + 5);
    const wall = meshOf(sparse([[x - 1, y, z, BlockType.Stone], [x, y, z, BlockType.WallTorchNegX]]));
    expect(faceCount(wall)).toBe(6 + 5);
    // 石头的 +X 面落在 x 那个平面上，正对着火把
    const normals = faceNormals(wall);
    const stoneFace = faceCenters(wall).filter(([cx], f) => normals[f]![0] === 1 && cx === x);
    expect(stoneFace).toEqual([[x, y + 0.5, z + 0.5]]);
  });

  it('火把贴的是火把那一格；侧面取那一格居中的竖条，顶面取竖条最上面一块', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.Torch]]));
    expect([...meshTiles(mesh.uvs)]).toEqual([TILE.torch]);
    const rect = tileUvRect(TILE.torch);
    // 一个像素在 u、v 上各占多少：图集 8 列 16 行（#73），一格在 u 与 v 上的跨度不同
    const pxU = (rect.u1 - rect.u0) / 16;
    const pxV = (rect.v1 - rect.v0) / 16;
    const normals = faceNormals(mesh);
    for (let f = 0; f < normals.length; f++) {
      const us: number[] = [];
      const vs: number[] = [];
      for (let v = 0; v < 4; v++) {
        us.push(mesh.uvs[f * 8 + v * 2]!);
        vs.push(mesh.uvs[f * 8 + v * 2 + 1]!);
      }
      // 第 7、8 两列像素
      expect(Math.min(...us)).toBeCloseTo(rect.u0 + 7 * pxU);
      expect(Math.max(...us)).toBeCloseTo(rect.u0 + 9 * pxU);
      // 侧面从格底（第 15 行）到第 6 行，顶面是第 6、7 两行
      const top = normals[f]![1] === 1;
      expect(Math.min(...vs)).toBeCloseTo(rect.v0 + (top ? 8 : 0) * pxV);
      expect(Math.max(...vs)).toBeCloseTo(rect.v0 + 10 * pxV);
    }
  });
});

describe('网格构建顺带输出发光方块（#59）', () => {
  it('列表含火把与燃烧中的熔炉的编号与世界坐标，熄火的熔炉与其他方块不在', () => {
    const chunk = new Chunk(1, -2);
    chunk.set(3, 70, 4, BlockType.Torch);
    chunk.set(5, 71, 6, BlockType.WallTorchPosZ);
    chunk.set(7, 72, 8, BlockType.LitFurnace);
    chunk.set(9, 70, 10, BlockType.Furnace);
    chunk.set(11, 70, 12, BlockType.Stone);
    const { glowingBlocks } = buildChunkMesh(chunk, blocksOnly(() => BlockType.Air));
    const ox = CHUNK_SIZE;
    const oz = -2 * CHUNK_SIZE;
    expect(glowingBlocks).toHaveLength(3);
    expect(glowingBlocks).toEqual(
      expect.arrayContaining([
        { block: BlockType.Torch, x: ox + 3, y: 70, z: oz + 4 },
        { block: BlockType.WallTorchPosZ, x: ox + 5, y: 71, z: oz + 6 },
        { block: BlockType.LitFurnace, x: ox + 7, y: 72, z: oz + 8 },
      ]),
    );
  });

  it('熔炉熄火后重建，列表里就没有它了', () => {
    const world = new World(flatTestTerrain);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    world.setBlock(2, FLAT_GROUND_Y + 1, 2, BlockType.LitFurnace);
    expect(glowingOf(fromWorld(world, 0, 0))).toEqual([
      { block: BlockType.LitFurnace, x: 2, y: FLAT_GROUND_Y + 1, z: 2 },
    ]);
    world.setBlock(2, FLAT_GROUND_Y + 1, 2, BlockType.Furnace);
    expect(glowingOf(fromWorld(world, 0, 0))).toEqual([]);
  });

  it('平地上没有发光方块，列表是空的', () => {
    expect(glowingOf(uniform(BlockType.Stone))).toEqual([]);
  });
});

describe('面到图集贴图的映射', () => {
  const x = 8;
  const y = FLAT_GROUND_Y + 4;
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
    const mesh = meshOf(sparse([[x, y, z, BlockType.Grass]]));
    expectFaceTile(mesh, [0, 1, 0], TILE.grassTop);
    expectFaceTile(mesh, [0, 0, 1], TILE.grassSide);
    expectFaceTile(mesh, [0, -1, 0], TILE.dirt);
  });

  it('橡木原木顶面是年轮、侧面是树皮', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.OakLog]]));
    expectFaceTile(mesh, [0, 1, 0], TILE.oakLogTop);
    expectFaceTile(mesh, [1, 0, 0], TILE.oakLogSide);
  });

  it('工作台顶面、侧面、正面各一张，正面贴 −X 与 −Z，底面是木板', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.CraftingTable]]));
    expectFaceTile(mesh, [0, 1, 0], TILE.craftingTableTop);
    expectFaceTile(mesh, [0, -1, 0], TILE.oakPlanks);
    expectFaceTile(mesh, [1, 0, 0], TILE.craftingTableSide);
    expectFaceTile(mesh, [0, 0, 1], TILE.craftingTableSide);
    expectFaceTile(mesh, [-1, 0, 0], TILE.craftingTableFront);
    expectFaceTile(mesh, [0, 0, -1], TILE.craftingTableFront);
  });

  it('熔炉顶面、侧面、正面各一张，正面贴 −X 与 −Z（issue #30）', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.Furnace]]));
    expectFaceTile(mesh, [0, 1, 0], TILE.furnaceTop);
    expectFaceTile(mesh, [0, -1, 0], TILE.furnaceTop);
    expectFaceTile(mesh, [1, 0, 0], TILE.furnaceSide);
    expectFaceTile(mesh, [0, 0, 1], TILE.furnaceSide);
    expectFaceTile(mesh, [-1, 0, 0], TILE.furnaceFront);
    expectFaceTile(mesh, [0, 0, -1], TILE.furnaceFront);
  });

  it('燃烧中的熔炉只有正面换成燃烧那一张，其余四面与熄火时相同', () => {
    const mesh = meshOf(sparse([[x, y, z, BlockType.LitFurnace]]));
    expectFaceTile(mesh, [0, 1, 0], TILE.furnaceTop);
    expectFaceTile(mesh, [1, 0, 0], TILE.furnaceSide);
    expectFaceTile(mesh, [-1, 0, 0], TILE.litFurnaceFront);
    expectFaceTile(mesh, [0, 0, -1], TILE.litFurnaceFront);
  });

  it('石头、基岩、泥土、树叶、木板六面同贴图', () => {
    const cases: Array<[BlockType, number]> = [
      [BlockType.Stone, TILE.stone],
      [BlockType.Bedrock, TILE.bedrock],
      [BlockType.Dirt, TILE.dirt],
      [BlockType.OakLeaves, TILE.oakLeaves],
      [BlockType.OakPlanks, TILE.oakPlanks],
    ];
    for (const [block, tile] of cases) {
      const mesh = meshOf(sparse([[x, y, z, block]]));
      for (const n of faceNormals(mesh)) {
        expectFaceTile(mesh, n, tile);
      }
    }
  });

  it('所有 uv 都在图集范围内', () => {
    const mesh = meshOf(
      sparse([
        [x, y, z, BlockType.Grass],
        [x + 2, y, z, BlockType.OakLog],
        [x + 4, y, z, BlockType.OakLeaves],
      ]),
    );
    for (const uv of mesh.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });
});

describe('网格用到了哪些贴图格号', () => {
  const x = 8;
  const y = FLAT_GROUND_Y + 4;
  const z = 8;

  it('一块熔炉的网格用到顶面、侧面与熄火正面三格；燃烧中的正面换成燃烧那一格', () => {
    const off = meshTiles(meshOf(sparse([[x, y, z, BlockType.Furnace]])).uvs);
    expect(off).toEqual(new Set([TILE.furnaceTop, TILE.furnaceSide, TILE.furnaceFront]));
    const lit = meshTiles(meshOf(sparse([[x, y, z, BlockType.LitFurnace]])).uvs);
    expect(lit).toEqual(new Set([TILE.furnaceTop, TILE.furnaceSide, TILE.litFurnaceFront]));
  });

  it('空网格一格都不用', () => {
    expect(meshTiles(new Float32Array(0))).toEqual(new Set());
  });
});

describe('生成地形的网格', () => {

  it('长了树的区块，网格里有这种树的原木与树叶的贴图', () => {
    // 从种子生成的世界一路走到网格：树长出来了，而且带着对的贴图上了画面。
    // 单块方块的六面贴图在上一节断言过，这里补的是「生成的树真的进了网格」这一段。
    // 原点区块的第一棵树是哪一种由种子决定（#79），贴图按它的树种取。
    const terrain = createTerrain(DEFAULT_SEED);
    const world = new World(terrain.generateChunk);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    const tree = treesTouching(terrain, 0, 0)[0];
    if (!tree) throw new Error('原点区块附近应有一棵树');
    const speciesTiles: Record<string, readonly [log: number, leaves: number]> = {
      [TreeSpecies.Oak]: [TILE.oakLogSide, TILE.oakLeaves],
      [TreeSpecies.Birch]: [TILE.birchLogSide, TILE.birchLeaves],
      [TreeSpecies.Spruce]: [TILE.spruceLogSide, TILE.spruceLeaves],
    };
    const [logTile, leavesTile] = speciesTiles[tree.species]!;

    const tiles = meshTiles(meshOf(fromWorld(world, chunkOf(tree.x), chunkOf(tree.z))).uvs);
    expect(tiles).toContain(logTile);
    expect(tiles).toContain(leavesTile);
    // 地面的贴图也在：网格不是只剩一棵树
    expect(tiles).toContain(TILE.grassTop);
  });
});

describe('区块边上的格直读隔壁区块的数据（#62）', () => {
  it('给出隔壁区块的数据与只能逐格问 getBlock，建出的网格完全一样', () => {
    // 四条区块边上从地表往下挖出竖井、在地下挖出横穿边界的洞，让边上的格既有被挡住的，也有露出来的
    const world = new World(createTerrain(DEFAULT_SEED).generateChunk);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 2)) world.loadChunk(cx, cz);
    for (let k = 0; k < CHUNK_SIZE; k += 3) {
      for (let y = 40; y <= world.highestBlockY(0, k); y++) world.setBlock(0, y, k, BlockType.Air);
      world.setBlock(-1, 30 + k, k, BlockType.Air);
      world.setBlock(k, 35, CHUNK_SIZE - 1, BlockType.Air);
      world.setBlock(k, 36, CHUNK_SIZE, BlockType.Air);
      world.setBlock(CHUNK_SIZE - 1, 20 + k, k, BlockType.Air);
      world.setBlock(k, 50, -1, BlockType.Air);
    }
    const blind: MeshView = {
      getBlock: (x, y, z) => world.getBlock(x, y, z),
      skyLightAt: (x, y, z) => world.skyLightAt(x, y, z),
      blockLightAt: (x, y, z) => world.blockLightAt(x, y, z),
      chunkAt: () => undefined,
    };
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) {
      const chunk = world.chunkAt(cx, cz)!;
      expect(buildChunkMesh(chunk, world), `${cx},${cz}`).toEqual(buildChunkMesh(chunk, blind));
    }
  });
});

describe('建网格共用一份缓冲（#62）', () => {
  it('先建的网格不会被后建的改掉：每份网格的数组都是自己的', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(3, FLAT_GROUND_Y + 1, 3, BlockType.Torch);
    const first = buildChunkMesh(world.chunkAt(0, 0)!, world);
    const copy = structuredClone(first);
    // 第二份比第一份大得多，缓冲要翻倍；第三份又小
    world.loadChunk(1, 0);
    buildChunkMesh(world.chunkAt(1, 0)!, world);
    buildChunkMesh(uniform(BlockType.Air).chunk, blocksOnly(() => BlockType.Air));
    expect(first).toEqual(copy);
  });

  it('预热之后建的网格与没预热时一样', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    const before = buildChunkMesh(world.chunkAt(0, 0)!, world);
    warmUpChunkMeshes();
    expect(buildChunkMesh(world.chunkAt(0, 0)!, world)).toEqual(before);
  });
});

describe('区块网格的坐标系', () => {
  it('顶点使用区块局部的 x/z 与世界 y', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(2, -3);
    const mesh = meshOf(fromWorld(world, 2, -3));
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
      expect(cy).toBe(FLAT_GROUND_Y + 1);
    }
  });
});

describe('顶点光照：每个角取这一面外侧挨着它的 4 格的平均（ADR-0016）', () => {
  const G = FLAT_GROUND_Y;

  /**
   * 朝 normal 的那些面里，落在区块局部坐标 corner 上的顶点各带的两个等级 [天光, 方块光]，去重。
   * 同一平面上共用一个角的几个面取的是同样 4 格，读出来应当只有一个值。
   */
  function cornerLight(
    mesh: MeshData,
    normal: readonly [number, number, number],
    corner: readonly [number, number, number],
  ): Array<[number, number]> {
    const seen = new Map<string, [number, number]>();
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const same = (a: ArrayLike<number>, b: readonly number[]) =>
        a[v * 3] === b[0] && a[v * 3 + 1] === b[1] && a[v * 3 + 2] === b[2];
      if (!same(mesh.normals, normal) || !same(mesh.positions, corner)) continue;
      const light: [number, number] = [mesh.light[v * 2]!, mesh.light[v * 2 + 1]!];
      seen.set(light.join(','), light);
    }
    return [...seen.values()];
  }

  const UP = [0, 1, 0] as const;

  it('平地：所有顶面顶点天光 15、方块光 0', () => {
    const world = new World(flatTestTerrain);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    const mesh = meshOf(fromWorld(world, 0, 0));
    expect(mesh.light).toHaveLength((mesh.positions.length / 3) * 2);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      expect([mesh.light[v * 2], mesh.light[v * 2 + 1]]).toEqual([15, 0]);
    }
  });

  it('屋顶开一格洞：洞口地面的顶点天光往外每格减 1', () => {
    // 地面以上隔两格整层铺石头，只在 (8, 8) 留一个洞。光只从洞里进来：洞下那一格 15，
    // 地面上一层离洞水平距离 d 的格子是 15 − d。角上取 4 格平均，所以沿 +X 每过一个角少 1。
    const hole = 8;
    const world = new World((cx, cz) => {
      const chunk = flatTestTerrain(cx, cz);
      chunk.fillLayer(G + 3, BlockType.Stone);
      if (cx === 0 && cz === 0) chunk.set(hole, G + 3, hole, BlockType.Air);
      return chunk;
    });
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    const mesh = meshOf(fromWorld(world, 0, 0));

    // 洞那一格的 +X+Z 角：15、14、14、13 的平均
    expect(cornerLight(mesh, UP, [hole + 1, G + 1, hole + 1])).toEqual([[14, 0]]);
    expect(cornerLight(mesh, UP, [hole + 2, G + 1, hole + 1])).toEqual([[13, 0]]);
    expect(cornerLight(mesh, UP, [hole + 3, G + 1, hole + 1])).toEqual([[12, 0]]);
    expect(cornerLight(mesh, UP, [hole + 4, G + 1, hole + 1])).toEqual([[11, 0]]);
  });

  it('墙脚的顶点暗于平面中央，两面墙的内角更暗：不透明的格子按 0 计入平均', () => {
    // 地面上摆一个 L 形的矮墙：(8, 8)、(9, 8)、(8, 9) 三格石头，内角朝 +X+Z。四周都是露天，天光 15。
    const world = new World(flatTestTerrain);
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    for (const [x, z] of [
      [8, 8],
      [9, 8],
      [8, 9],
    ] as const) {
      world.setBlock(x, G + 1, z, BlockType.Stone);
    }
    const mesh = meshOf(fromWorld(world, 0, 0));

    // 平面中央：4 格都是 15
    expect(cornerLight(mesh, UP, [12, G + 1, 12])).toEqual([[15, 0]]);
    // 贴着一面墙：4 格里 1 格是石头，(0 + 15 × 3) / 4
    expect(cornerLight(mesh, UP, [10, G + 1, 9])).toEqual([[11.25, 0]]);
    // 内角：4 格里 3 格是石头，15 / 4
    expect(cornerLight(mesh, UP, [9, G + 1, 9])).toEqual([[3.75, 0]]);
  });
});

describe('顶点光照的取样：六个面、区块边角，每格的等级各不相同', () => {
  const y = FLAT_GROUND_Y + 4;

  /** 每一格一个不同的 [天光, 方块光]，由世界坐标决定；方块本身那一格不管。 */
  function levelsAt(x: number, yy: number, z: number): [number, number] {
    const h = Math.imul(x * 73856093 ^ yy * 19349663 ^ z * 83492791, 0x9e3779b1) >>> 0;
    return [h % 16, (h >>> 8) % 16];
  }

  /**
   * 方块 (bx, by, bz) 周围摆几块不透明的石头：只摆在棱上与角上的那些格，不挡它的六个面，
   * 好让某些角的 4 格里有不透明的格子，验分母仍是 4。
   */
  function opaqueAround(bx: number, by: number, bz: number): Set<string> {
    return new Set([
      `${bx + 1},${by + 1},${bz}`,
      `${bx - 1},${by},${bz - 1}`,
      `${bx + 1},${by - 1},${bz + 1}`,
    ]);
  }

  /**
   * 区块 (cx, cz) 里只有一块石头在 (bx, by, bz)（世界坐标），周围摆几块不透明的格子；区块里外每一格的光照都取
   * `levelsAt`。区块外的格子走视图读，所以石头贴着区块边时，角上的取样要读到隔壁区块。
   */
  function scene(cx: number, cz: number, [bx, by, bz]: readonly [number, number, number], smoothLighting = true) {
    const opaque = opaqueAround(bx, by, bz);
    const isStone = (x: number, yy: number, z: number) =>
      (x === bx && yy === by && z === bz) || opaque.has(`${x},${yy},${z}`);
    const chunk = new Chunk(cx, cz);
    chunk.resetLight();
    for (let ly = WORLD_MIN_Y; ly <= WORLD_MAX_Y; ly++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const x = cx * CHUNK_SIZE + lx;
          const z = cz * CHUNK_SIZE + lz;
          if (isStone(x, ly, z)) chunk.set(lx, ly, lz, BlockType.Stone);
          const [sky, block] = levelsAt(x, ly, z);
          chunk.light![(ly - WORLD_MIN_Y) * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE + lx] = (sky << 4) | block;
        }
      }
    }
    const view: MeshView = {
      getBlock: (x, yy, z) => (isStone(x, yy, z) ? BlockType.Stone : BlockType.Air),
      skyLightAt: (x, yy, z) => levelsAt(x, yy, z)[0],
      blockLightAt: (x, yy, z) => levelsAt(x, yy, z)[1],
      chunkAt: () => undefined,
    };
    return { mesh: buildChunkMesh(chunk, view, smoothLighting).opaque, isStone };
  }

  /**
   * 按定义独立算一个角的期望值：这一面外侧那一层里，单位立方体包住这个角的那 4 格，两个等级各自平均，
   * 不透明的按 0。不经过网格构建里那张偏移表。
   */
  function expectedCorner(
    corner: readonly [number, number, number],
    normal: readonly [number, number, number],
    block: readonly [number, number, number],
    isStone: (x: number, y: number, z: number) => boolean,
  ): [number, number] {
    const choices = [0, 1, 2].map((axis) =>
      normal[axis] !== 0 ? [block[axis]! + normal[axis]!] : [corner[axis]! - 1, corner[axis]!],
    );
    let sky = 0;
    let light = 0;
    for (const x of choices[0]!) {
      for (const yy of choices[1]!) {
        for (const z of choices[2]!) {
          if (isStone(x, yy, z)) continue;
          const [s, b] = levelsAt(x, yy, z);
          sky += s;
          light += b;
        }
      }
    }
    return [sky / 4, light / 4];
  }

  const cases: Array<[string, number, number, readonly [number, number, number]]> = [
    ['区块中间', 2, -3, [2 * CHUNK_SIZE + 8, y, -3 * CHUNK_SIZE + 8]],
    ['+X+Z 角上', 2, -3, [2 * CHUNK_SIZE + 15, y, -3 * CHUNK_SIZE + 15]],
    ['−X−Z 角上', 2, -3, [2 * CHUNK_SIZE, y, -3 * CHUNK_SIZE]],
  ];

  for (const [where, cx, cz, block] of cases) {
    it(`石头在${where}：六个面每个角都等于外侧 4 格的平均`, () => {
      const { mesh, isStone } = scene(cx, cz, block);
      const at = block.map((v, axis) => v - (axis === 0 ? cx * CHUNK_SIZE : axis === 2 ? cz * CHUNK_SIZE : 0));
      const normals = new Set<string>();
      let checked = 0;
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const local = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
        const normal = [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!] as const;
        // 只看这块石头自己的面：别的石头只是取样里的不透明格。面中心往里退半格，落在哪一格就是哪一格的面。
        const face = Math.floor(v / 4);
        const owner = [0, 1, 2].map((axis) => {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += mesh.positions[(face * 4 + k) * 3 + axis]!;
          return Math.floor(sum / 4 - normal[axis]! / 2);
        });
        if (owner.some((p, axis) => p !== at[axis])) continue;
        const corner = [local[0]! + cx * CHUNK_SIZE, local[1]!, local[2]! + cz * CHUNK_SIZE] as const;
        expect([mesh.light[v * 2], mesh.light[v * 2 + 1]], `法线 ${normal} 的角 ${corner}`).toEqual(
          expectedCorner(corner, normal, block, isStone),
        );
        normals.add(normal.join(','));
        checked++;
      }
      expect(normals.size).toBe(6);
      expect(checked).toBe(24);
    });

    it(`平滑光照关闭、石头在${where}：每个面的 4 个角都等于这一面外侧相邻那一格的光照`, () => {
      const { mesh } = scene(cx, cz, block, false);
      const normals = new Set<string>();
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const normal = [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!] as const;
        // 只看这块石头自己的面，做法同上
        const face = Math.floor(v / 4);
        const owner = [0, 1, 2].map((axis) => {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += mesh.positions[(face * 4 + k) * 3 + axis]!;
          return Math.floor(sum / 4 - normal[axis]! / 2) + (axis === 0 ? cx * CHUNK_SIZE : axis === 2 ? cz * CHUNK_SIZE : 0);
        });
        if (owner.some((p, axis) => p !== block[axis])) continue;
        const [nx, ny, nz] = block.map((p, axis) => p + normal[axis]!);
        expect([mesh.light[v * 2], mesh.light[v * 2 + 1]], `法线 ${normal}`).toEqual(levelsAt(nx!, ny!, nz!));
        normals.add(normal.join(','));
      }
      expect(normals.size).toBe(6);
    });
  }
});
