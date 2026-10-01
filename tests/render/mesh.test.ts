import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import {
  CHUNK_SIZE,
  DEFAULT_SEED,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from '../../src/core/constants';
import { plainsTerrain, plainsTreePlacement } from '../../src/core/terrain';
import { oakTreesTouching } from '../../src/core/tree';
import { chunkOf, chunksAround, ORIGIN_CHUNK, World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';
import { tileUvRect, TILE } from '../../src/render/atlas';
import { buildChunkMesh, meshTiles, type MeshData, type MeshView } from '../../src/render/mesh';

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
  return { getBlock, skyLightAt: () => 0, blockLightAt: () => 0 };
}

function meshOf({ chunk, view }: MeshInput): MeshData {
  return buildChunkMesh(chunk, view);
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

  it('长了树的区块，网格里有橡木原木与橡树叶的贴图', () => {
    // 从种子生成的世界一路走到网格：树长出来了，而且带着对的贴图上了画面。
    // 单块方块的六面贴图在上一节断言过，这里补的是「生成的树真的进了网格」这一段。
    const world = new World(plainsTerrain(DEFAULT_SEED));
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    const tree = oakTreesTouching(plainsTreePlacement(DEFAULT_SEED), 0, 0)[0];
    if (!tree) throw new Error('原点区块附近应有一棵橡树');

    const tiles = meshTiles(meshOf(fromWorld(world, chunkOf(tree.x), chunkOf(tree.z))).uvs);
    expect(tiles).toContain(TILE.oakLogSide);
    expect(tiles).toContain(TILE.oakLeaves);
    // 地面的贴图也在：网格不是只剩一棵树
    expect(tiles).toContain(TILE.grassTop);
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
