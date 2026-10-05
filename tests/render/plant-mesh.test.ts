import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { faceCulling } from '../../src/core/face-culling';
import { ItemType } from '../../src/core/item';
import { ORIGIN_CHUNK, World, chunksAround } from '../../src/core/world';
import {
  BLOCK_TILES,
  HeldItemShape,
  ITEM_TILES,
  TILE,
  TILE_PX,
  heldItemShape,
  itemCubeUvs,
  tileAtUv,
  tileCell,
  tileUvRect,
} from '../../src/render/atlas';
import { buildChunkMesh, meshTiles, type MeshData, type MeshView } from '../../src/render/mesh';
import { SELF_LIT_BLOCK_LIGHT } from '../../src/render/shading';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';
import {
  DANDELION,
  DANDELION_ITEM,
  FERN,
  FLOWERS,
  PLANTS,
  POPPY,
  POPPY_ITEM,
  SHORT_GRASS,
  expectPlantsDefined,
} from '../helpers/plants';

/**
 * 地表植物的网格、贴图与手持形状（#80，ADR-0016 补记）。
 *
 * 网格：植物那一格输出两片交叉面片，正反两面各一份，共 4 个四边形，进不透明部分；不输出立方体；顶点光照取植物自己那一格
 * （不是火把那样的自发光）；剔除把植物当空气，邻格朝向植物的面照常生成。
 * 贴图：四种植物各一格，占第 61 到 64 格（第 57 到 60 格是 #76 的沙子、沙砾、雪草方块）。透明底，与树叶一样靠透明裁剪。
 */

const S = FLAT_GROUND_Y + 1;

/** 四种植物在 TILE 表里的名称与格号。 */
const PLANT_TILES: ReadonlyArray<readonly [name: string, index: number, block: () => BlockType]> = [
  ['shortGrass', 61, () => SHORT_GRASS],
  ['fern', 62, () => FERN],
  ['dandelion', 63, () => DANDELION],
  ['poppy', 64, () => POPPY],
];

/** TILE 表里按名称取格号，没有这个名称时是 undefined。 */
function tile(name: string): number | undefined {
  return (TILE as Readonly<Record<string, number>>)[name];
}

/** 只给方块的假视图：区块之外一律空气、光照读作 0。 */
function blocksOnly(getBlock: MeshView['getBlock']): MeshView {
  return { getBlock, skyLightAt: () => 0, blockLightAt: () => 0, chunkAt: () => undefined };
}

/** 区块 (0, 0) 里只有这几格有方块，其余全是空气；区块之外也是空气。 */
function sparse(blocks: Array<[number, number, number, BlockType]>): { chunk: Chunk; view: MeshView } {
  const chunk = new Chunk(0, 0);
  for (const [x, y, z, block] of blocks) chunk.set(x, y, z, block);
  const map = new Map(blocks.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
  return { chunk, view: blocksOnly((x, y, z) => map.get(`${x},${y},${z}`) ?? BlockType.Air) };
}

function opaqueOf(blocks: Array<[number, number, number, BlockType]>): MeshData {
  const { chunk, view } = sparse(blocks);
  return buildChunkMesh(chunk, view).opaque;
}

function faceCount(mesh: MeshData): number {
  return mesh.indices.length / 6;
}

/** 一个四边形：四个顶点的位置、法线（取第一个顶点的）、uv 中点落在哪一格。 */
interface Quad {
  readonly corners: Array<[number, number, number]>;
  readonly normal: [number, number, number];
  readonly tile: number;
  readonly light: Array<[number, number]>;
}

function quadsOf(mesh: MeshData): Quad[] {
  const quads: Quad[] = [];
  for (let f = 0; f < faceCount(mesh); f++) {
    const corners: Array<[number, number, number]> = [];
    const light: Array<[number, number]> = [];
    let u = 0;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const p = (f * 4 + k) * 3;
      corners.push([mesh.positions[p]!, mesh.positions[p + 1]!, mesh.positions[p + 2]!]);
      const t = (f * 4 + k) * 2;
      u += mesh.uvs[t]! / 4;
      v += mesh.uvs[t + 1]! / 4;
      light.push([mesh.light[t]!, mesh.light[t + 1]!]);
    }
    const n = f * 12;
    quads.push({ corners, normal: [mesh.normals[n]!, mesh.normals[n + 1]!, mesh.normals[n + 2]!], tile: tileAtUv(u, v), light });
  }
  return quads;
}

describe('植物那一格的网格：两片交叉面片，正反两面', () => {
  const x = 8;
  const z = 8;

  it.each(PLANTS)('%s：4 个四边形，都在不透明部分，半透明部分是空的', (_name, plant) => {
    expectPlantsDefined();
    const { chunk, view } = sparse([[x, S, z, plant]]);
    const mesh = buildChunkMesh(chunk, view);
    expect(faceCount(mesh.opaque)).toBe(4);
    expect(mesh.opaque.positions).toHaveLength(4 * 4 * 3);
    expect(mesh.opaque.light).toHaveLength(4 * 4 * 2);
    expect(faceCount(mesh.translucent)).toBe(0);
    expect(mesh.glowingBlocks).toEqual([]);
  });

  it.each(PLANTS)('%s：每片的四个顶点落在这一格的一条竖直对角面上，两条对角面各两片，不是立方体的面', (_name, plant) => {
    expectPlantsDefined();
    const quads = quadsOf(opaqueOf([[x, S, z, plant]]));
    const diagonals = quads.map(({ corners }) => {
      const onA = corners.every(([px, , pz]) => Math.abs(px - x - (pz - z)) < 1e-5);
      const onB = corners.every(([px, , pz]) => Math.abs(px - x + (pz - z) - 1) < 1e-5);
      return onA ? 'a' : onB ? 'b' : 'none';
    });
    expect(diagonals.sort()).toEqual(['a', 'a', 'b', 'b']);
    for (const { corners, normal } of quads) {
      // 竖着立在格底到格顶之间，法线水平
      const ys = corners.map(([, py]) => py);
      expect(Math.min(...ys)).toBeCloseTo(S);
      expect(Math.max(...ys)).toBeGreaterThan(S + 0.5);
      expect(Math.max(...ys)).toBeLessThanOrEqual(S + 1 + 1e-6);
      // 一片面片在水平方向上铺开不止半格：不是缩在中间的一根细杆
      const xs = corners.map(([px]) => px);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
      expect(normal[1]).toBe(0);
      expect(Math.hypot(...normal)).toBeGreaterThan(0);
    }
  });

  it.each(PLANTS)('%s：正反两面——同一条对角面上的两片位置相同、法线相反', (_name, plant) => {
    expectPlantsDefined();
    const quads = quadsOf(opaqueOf([[x, S, z, plant]]));
    const key = (corners: Quad['corners']) =>
      corners
        .map((c) => c.map((n) => n.toFixed(4)).join(','))
        .sort()
        .join(';');
    const byPosition = new Map<string, Quad[]>();
    for (const quad of quads) byPosition.set(key(quad.corners), [...(byPosition.get(key(quad.corners)) ?? []), quad]);
    expect([...byPosition.values()].map((pair) => pair.length)).toEqual([2, 2]);
    for (const [front, back] of byPosition.values()) {
      for (let k = 0; k < 3; k++) expect(front!.normal[k]! + back!.normal[k]!).toBeCloseTo(0);
    }
  });

  it.each(PLANT_TILES)('%s 的四片都贴第 %i 格，每片铺满那一格', (name, index, block) => {
    expectPlantsDefined();
    const mesh = opaqueOf([[x, S, z, block()]]);
    expect([...meshTiles(mesh.uvs)]).toEqual([index]);
    expect(tile(name)).toBe(index);
    const rect = tileUvRect(index);
    for (let f = 0; f < faceCount(mesh); f++) {
      const us = [0, 1, 2, 3].map((k) => mesh.uvs[(f * 4 + k) * 2]!);
      const vs = [0, 1, 2, 3].map((k) => mesh.uvs[(f * 4 + k) * 2 + 1]!);
      expect(Math.min(...us)).toBeCloseTo(rect.u0);
      expect(Math.max(...us)).toBeCloseTo(rect.u1);
      expect(Math.min(...vs)).toBeCloseTo(rect.v0);
      expect(Math.max(...vs)).toBeCloseTo(rect.v1);
    }
  });
});

describe('植物的顶点光照取植物自己那一格', () => {
  /** 平地世界，区块 (0, 0) 周围都加载好；edit 在加载之前改生成出来的区块。 */
  function worldWith(edit: (chunk: Chunk) => void): World {
    const world = new World((cx, cz) => {
      const chunk = flatTestTerrain(cx, cz);
      edit(chunk);
      return chunk;
    });
    for (const { cx, cz } of chunksAround(ORIGIN_CHUNK, 1)) world.loadChunk(cx, cz);
    return world;
  }

  /** 网格里贴着 index 那一格的顶点的光照，去重。 */
  function lightOfTile(mesh: MeshData, index: number): Array<[number, number]> {
    const seen = new Map<string, [number, number]>();
    for (const quad of quadsOf(mesh)) {
      if (quad.tile !== index) continue;
      for (const light of quad.light) seen.set(light.join(','), light);
    }
    return [...seen.values()];
  }

  it('露天的矮草：四片的顶点天光 15、方块光 0（不是火把那样的自发光）', () => {
    expectPlantsDefined();
    const world = worldWith(() => {});
    world.setBlock(8, S, 8, SHORT_GRASS);
    const mesh = buildChunkMesh(world.chunkAt(0, 0)!, world).opaque;
    expect(lightOfTile(mesh, 61)).toEqual([[15, 0]]);
  });

  it('屋顶下离洞口 3 格的蕨：四片的顶点都等于那一格的天光与方块光，天光低于 15；平滑光照关掉也一样', () => {
    expectPlantsDefined();
    const world = worldWith((chunk) => {
      chunk.fillLayer(S + 2, BlockType.Stone);
      if (chunk.cx === 0 && chunk.cz === 0) chunk.set(8, S + 2, 8, BlockType.Air);
    });
    world.setBlock(11, S, 8, FERN);
    const own: [number, number] = [world.skyLightAt(11, S, 8), world.blockLightAt(11, S, 8)];
    expect(own[0]).toBeGreaterThan(0);
    expect(own[0]).toBeLessThan(15);
    for (const smooth of [true, false]) {
      const mesh = buildChunkMesh(world.chunkAt(0, 0)!, world, smooth).opaque;
      expect(lightOfTile(mesh, 62), `平滑光照 ${smooth}`).toEqual([own]);
    }
  });

  it('洞里旁边插着火把的花：顶点方块光是花那一格的等级，低于自发光的标记', () => {
    expectPlantsDefined();
    const world = worldWith((chunk) => chunk.fillLayer(S + 2, BlockType.Stone));
    world.setBlock(8, S, 8, DANDELION);
    world.setBlock(10, S, 8, BlockType.Torch);
    const own: [number, number] = [world.skyLightAt(8, S, 8), world.blockLightAt(8, S, 8)];
    expect(own[1]).toBeGreaterThan(0);
    expect(own[1]).toBeLessThan(SELF_LIT_BLOCK_LIGHT);
    const mesh = buildChunkMesh(world.chunkAt(0, 0)!, world).opaque;
    expect(lightOfTile(mesh, 63)).toEqual([own]);
  });
});

describe('剔除把植物当空气', () => {
  const x = 8;
  const z = 8;

  it('植物在剔除上与空气同一档', () => {
    expectPlantsDefined();
    for (const [name, plant] of PLANTS) expect(faceCulling(plant), name).toBe(faceCulling(BlockType.Air));
  });

  it('植物下面的石头：顶面照常生成，共 6 + 4 个面', () => {
    expectPlantsDefined();
    const mesh = opaqueOf([[x, S - 1, z, BlockType.Stone], [x, S, z, SHORT_GRASS]]);
    expect(faceCount(mesh)).toBe(6 + 4);
    const tops = quadsOf(mesh).filter(({ normal, corners }) => normal[1] === 1 && corners.every(([, py]) => py === S));
    expect(tops).toHaveLength(1);
  });

  it('贴着植物的石头：朝植物那一面照常生成；两格植物相邻也各自出 4 片', () => {
    expectPlantsDefined();
    const wall = opaqueOf([[x - 1, S, z, BlockType.Stone], [x, S, z, POPPY]]);
    expect(faceCount(wall)).toBe(6 + 4);
    const facing = quadsOf(wall).filter(({ normal, corners }) => normal[0] === 1 && corners.every(([px]) => px === x));
    expect(facing).toHaveLength(1);
    expect(faceCount(opaqueOf([[x, S, z, FERN], [x + 1, S, z, FERN]]))).toBe(8);
  });

  it('植物四面与上下都是石头时，石头朝植物的面照样生成', () => {
    expectPlantsDefined();
    const around: Array<[number, number, number, BlockType]> = [
      [x + 1, S, z, BlockType.Stone],
      [x - 1, S, z, BlockType.Stone],
      [x, S, z + 1, BlockType.Stone],
      [x, S, z - 1, BlockType.Stone],
      [x, S + 1, z, BlockType.Stone],
      [x, S - 1, z, BlockType.Stone],
    ];
    const with6 = faceCount(opaqueOf([...around, [x, S, z, SHORT_GRASS]]));
    const withAir = faceCount(opaqueOf(around));
    // 空气那一格四周的石头各有一面朝它；换成植物不少这 6 面，多出植物自己的 4 片或者整格看不见时一片不出
    expect(with6 === withAir + 4 || with6 === withAir).toBe(true);
    expect(withAir).toBe(6 * 6);
  });
});

describe('四种植物的贴图格号', () => {
  it('矮草 61、蕨 62、蒲公英 63、虞美人 64', () => {
    expect(PLANT_TILES.map(([name]) => tile(name))).toEqual(PLANT_TILES.map(([, index]) => index));
  });

  it('现有格号不变：沙子到雪草方块侧面仍是 57 到 60，火把 44', () => {
    expect([tile('sand'), tile('gravel'), tile('snowyGrassTop'), tile('snowyGrassSide')]).toEqual([57, 58, 59, 60]);
    expect(TILE.torch).toBe(44);
  });

  it.each(PLANT_TILES)('%s 的方块六面同图', (name, _index, block) => {
    expectPlantsDefined();
    const index = tile(name);
    expect(BLOCK_TILES[block()]).toEqual({ top: index, bottom: index, side: index });
  });

  it('两种花的物品与方块同图：手持画平面图标（与火把相同），掉落物的小方块六面都贴花那一格', () => {
    expectPlantsDefined();
    for (const [name, flower, item] of FLOWERS) {
      expect(ITEM_TILES[item], name).toEqual(BLOCK_TILES[flower]);
      expect(heldItemShape(item), name).toBe(HeldItemShape.Flat);
      const uvs = itemCubeUvs(item);
      expect(uvs, name).toHaveLength(6 * 4 * 2);
      const index = BLOCK_TILES[flower]!.side;
      for (let f = 0; f < 6; f++) {
        const u = (uvs[f * 8]! + uvs[f * 8 + 2]! + uvs[f * 8 + 4]! + uvs[f * 8 + 6]!) / 4;
        const v = (uvs[f * 8 + 1]! + uvs[f * 8 + 3]! + uvs[f * 8 + 5]! + uvs[f * 8 + 7]!) / 4;
        expect(tileAtUv(u, v), `${name} 第 ${f} 面`).toBe(index);
      }
    }
    expect(heldItemShape(ItemType.Torch)).toBe(HeldItemShape.Flat);
    expect(heldItemShape(ItemType.Dirt)).toBe(HeldItemShape.Cube);
    expect([DANDELION_ITEM, POPPY_ITEM]).toHaveLength(2);
  });
});

describe('已提交的图集 PNG 画了这 4 格', () => {
  const ATLAS_PNG = fileURLToPath(new URL('../../public/textures/atlas.png', import.meta.url));

  /** 解码已提交的图集 PNG（只认 gen-atlas.mjs 写出的 8 位 RGBA、不隔行、每行滤波 0）。 */
  function decodeAtlas(): { rgba: Uint8Array; width: number } {
    const png = readFileSync(ATLAS_PNG);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect([png[24], png[25], png[28]], '位深、颜色类型、隔行').toEqual([8, 6, 0]);
    const idat: Buffer[] = [];
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const rgba = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (stride + 1)], `第 ${y} 行的滤波类型`).toBe(0);
      rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
    }
    return { rgba, width };
  }

  function tilePixels(atlas: { rgba: Uint8Array; width: number }, index: number): Uint8Array {
    const { col, row } = tileCell(index);
    const out = new Uint8Array(TILE_PX * TILE_PX * 4);
    for (let y = 0; y < TILE_PX; y++) {
      const start = ((row * TILE_PX + y) * atlas.width + col * TILE_PX) * 4;
      out.set(atlas.rgba.subarray(start, start + TILE_PX * 4), y * TILE_PX * 4);
    }
    return out;
  }

  /** 一格里满足 match 的像素数。 */
  function countPixels(pixels: Uint8Array, match: (r: number, g: number, b: number, a: number) => boolean): number {
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (match(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!)) n++;
    return n;
  }

  const AREA = TILE_PX * TILE_PX;

  it('四格都是透明底上画的图案：alpha 只有 0 与 255，透明的至少两成，不透明的至少一成', () => {
    const atlas = decodeAtlas();
    for (const [name, index] of PLANT_TILES) {
      const pixels = tilePixels(atlas, index);
      expect(countPixels(pixels, (_r, _g, _b, a) => a !== 0 && a !== 255), name).toBe(0);
      expect(countPixels(pixels, (_r, _g, _b, a) => a === 0), name).toBeGreaterThanOrEqual(AREA * 0.2);
      expect(countPixels(pixels, (_r, _g, _b, a) => a === 255), name).toBeGreaterThanOrEqual(AREA * 0.1);
    }
  });

  it('四格像素两两不同，也都与火把、橡树叶不同', () => {
    const atlas = decodeAtlas();
    const indices = [...PLANT_TILES.map(([, index]) => index), TILE.torch, TILE.oakLeaves];
    const hex = indices.map((index) => Buffer.from(tilePixels(atlas, index)).toString('hex'));
    expect(new Set(hex).size).toBe(indices.length);
  });

  it('矮草与蕨以绿色为主；蒲公英有黄色的花，虞美人有红色的花', () => {
    const atlas = decodeAtlas();
    for (const index of [61, 62]) {
      const pixels = tilePixels(atlas, index);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] !== 255) continue;
        r += pixels[i]!;
        g += pixels[i + 1]!;
        b += pixels[i + 2]!;
      }
      expect(g, `第 ${index} 格`).toBeGreaterThan(r);
      expect(g, `第 ${index} 格`).toBeGreaterThan(b);
    }
    const yellow = countPixels(tilePixels(atlas, 63), (r, g, b, a) => a === 255 && r > 180 && g > 150 && b < 110);
    const red = countPixels(tilePixels(atlas, 64), (r, g, b, a) => a === 255 && r > 150 && g < 90 && b < 90);
    expect(yellow).toBeGreaterThanOrEqual(4);
    expect(red).toBeGreaterThanOrEqual(4);
  });
});
