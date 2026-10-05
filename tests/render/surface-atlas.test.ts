import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import {
  BLOCK_TILES,
  HeldItemShape,
  ITEM_TILES,
  TILE,
  TILE_PX,
  heldItemShape,
  tileCell,
  tileUvRect,
} from '../../src/render/atlas';
import { buildChunkMesh, type MeshData, type MeshView } from '../../src/render/mesh';
import {
  GRAVEL,
  GRAVEL_ITEM,
  SAND,
  SAND_ITEM,
  SNOWY_GRASS,
  expectSurfaceBlocksDefined,
} from '../helpers/surface-rules';

/**
 * 沙子、沙砾、雪草方块的贴图（#76）：四格，占第 57 到 60 格。第 47、48 格是 #74 的水与冰，第 49 到 56 格是 #85 的
 * 白桦与云杉。雪草方块顶面是雪、侧面带雪边、底面是泥土；沙子与沙砾六面同图。
 */

/** 四格贴图在 TILE 表里的名称与格号。 */
const NEW_TILES: ReadonlyArray<readonly [name: string, index: number]> = [
  ['sand', 57],
  ['gravel', 58],
  ['snowyGrassTop', 59],
  ['snowyGrassSide', 60],
];

/** TILE 表里按名称取格号，没有这个名称时是 undefined。 */
function tile(name: string): number | undefined {
  return (TILE as Readonly<Record<string, number>>)[name];
}

describe('三种新方块的贴图格号', () => {
  it('沙子 57、沙砾 58、雪草方块顶面 59、雪草方块侧面 60', () => {
    expect(NEW_TILES.map(([name]) => tile(name))).toEqual(NEW_TILES.map(([, index]) => index));
  });

  it('现有格号不变：草方块三格仍是 0、1、2，水与冰仍是 47、48，白桦与云杉仍是 49 到 56', () => {
    expect([TILE.grassTop, TILE.grassSide, TILE.dirt]).toEqual([0, 1, 2]);
    expect([TILE.water, TILE.ice]).toEqual([47, 48]);
    expect([TILE.birchLogTop, TILE.sprucePlanks]).toEqual([49, 56]);
  });

  it('沙子与沙砾六面同图', () => {
    expectSurfaceBlocksDefined();
    const sand = tile('sand');
    const gravel = tile('gravel');
    expect(BLOCK_TILES[SAND]).toEqual({ top: sand, bottom: sand, side: sand });
    expect(BLOCK_TILES[GRAVEL]).toEqual({ top: gravel, bottom: gravel, side: gravel });
  });

  it('雪草方块顶面是雪、侧面带雪边、底面是泥土，与草方块的顶面与侧面都不同', () => {
    expectSurfaceBlocksDefined();
    expect(BLOCK_TILES[SNOWY_GRASS]).toEqual({ top: tile('snowyGrassTop'), bottom: TILE.dirt, side: tile('snowyGrassSide') });
    expect(tile('snowyGrassTop')).not.toBe(TILE.grassTop);
    expect(tile('snowyGrassSide')).not.toBe(TILE.grassSide);
  });

  it('沙子与沙砾物品的小方块与方块本身六面相同，手持画立方体', () => {
    expectSurfaceBlocksDefined();
    expect(ITEM_TILES[SAND_ITEM]).toEqual(BLOCK_TILES[SAND]);
    expect(ITEM_TILES[GRAVEL_ITEM]).toEqual(BLOCK_TILES[GRAVEL]);
    expect(heldItemShape(SAND_ITEM)).toBe(HeldItemShape.Cube);
    expect(heldItemShape(GRAVEL_ITEM)).toBe(HeldItemShape.Cube);
  });
});

describe('网格：雪草方块顶面与侧面用各自的贴图格', () => {
  /** 区块 (0, 0) 里只有一格方块，其余全是空气；区块之外也是空气。 */
  function singleBlockMesh(block: BlockType): MeshData {
    const chunk = new Chunk(0, 0);
    chunk.set(8, 80, 8, block);
    const view: MeshView = {
      getBlock: (x, y, z) => (x === 8 && y === 80 && z === 8 ? block : BlockType.Air),
      skyLightAt: () => 15,
      blockLightAt: () => 0,
      chunkAt: () => undefined,
    };
    return buildChunkMesh(chunk, view).opaque;
  }

  /** 法线为 normal 的那一面四个顶点的 uv 都落在 index 那一格里。 */
  function expectFaceTile(mesh: MeshData, normal: readonly [number, number, number], index: number | undefined): void {
    expect(index, '格号').toBeTypeOf('number');
    const rect = tileUvRect(index!);
    let found = 0;
    for (let face = 0; face < mesh.indices.length / 6; face++) {
      const n = [mesh.normals[face * 12], mesh.normals[face * 12 + 1], mesh.normals[face * 12 + 2]];
      if (n.join(',') !== normal.join(',')) continue;
      found++;
      for (let v = 0; v < 4; v++) {
        const u = mesh.uvs[face * 8 + v * 2]!;
        const w = mesh.uvs[face * 8 + v * 2 + 1]!;
        expect(u, `法线 ${normal.join(',')} 的 u`).toBeGreaterThanOrEqual(rect.u0);
        expect(u, `法线 ${normal.join(',')} 的 u`).toBeLessThanOrEqual(rect.u1);
        expect(w, `法线 ${normal.join(',')} 的 v`).toBeGreaterThanOrEqual(rect.v0);
        expect(w, `法线 ${normal.join(',')} 的 v`).toBeLessThanOrEqual(rect.v1);
      }
    }
    expect(found, `法线 ${normal.join(',')} 的面数`).toBe(1);
  }

  it('顶面取雪草方块顶面那一格，四个侧面取雪草方块侧面那一格，底面取泥土', () => {
    expectSurfaceBlocksDefined();
    const mesh = singleBlockMesh(SNOWY_GRASS);
    expectFaceTile(mesh, [0, 1, 0], tile('snowyGrassTop'));
    for (const side of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      expectFaceTile(mesh, side, tile('snowyGrassSide'));
    }
    expectFaceTile(mesh, [0, -1, 0], TILE.dirt);
  });

  it('沙子与沙砾六个面都取自己那一格', () => {
    expectSurfaceBlocksDefined();
    for (const [block, name] of [
      [SAND, 'sand'],
      [GRAVEL, 'gravel'],
    ] as const) {
      const mesh = singleBlockMesh(block);
      for (const normal of [
        [0, 1, 0],
        [0, -1, 0],
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const) {
        expectFaceTile(mesh, normal, tile(name));
      }
    }
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

  function opaquePixels(pixels: Uint8Array): number {
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 255) count++;
    return count;
  }

  /** 一格的平均亮度（三个通道的平均）。 */
  function meanBrightness(pixels: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
    return sum / (pixels.length / 4);
  }

  it('四格每个像素都不透明', () => {
    const atlas = decodeAtlas();
    for (const [name, index] of NEW_TILES) {
      expect(opaquePixels(tilePixels(atlas, index)), name).toBe(TILE_PX * TILE_PX);
    }
  });

  it('四格像素两两不同，也都与草方块顶面、侧面、泥土、石头不同', () => {
    const atlas = decodeAtlas();
    const indices = [...NEW_TILES.map(([, index]) => index), TILE.grassTop, TILE.grassSide, TILE.dirt, TILE.stone];
    const hex = indices.map((index) => Buffer.from(tilePixels(atlas, index)).toString('hex'));
    expect(new Set(hex).size).toBe(indices.length);
  });

  it('雪草方块顶面是雪：比草方块顶面亮得多，平均亮度在 200 以上', () => {
    const atlas = decodeAtlas();
    const snow = meanBrightness(tilePixels(atlas, 59));
    expect(snow).toBeGreaterThan(200);
    expect(snow).toBeGreaterThan(meanBrightness(tilePixels(atlas, TILE.grassTop)) + 60);
  });

  it('雪草方块侧面上缘是雪边：最上面两行比草方块侧面的最上面两行亮', () => {
    const atlas = decodeAtlas();
    const topRows = (pixels: Uint8Array): Uint8Array => pixels.subarray(0, TILE_PX * 2 * 4);
    expect(meanBrightness(topRows(tilePixels(atlas, 60)))).toBeGreaterThan(
      meanBrightness(topRows(tilePixels(atlas, TILE.grassSide))) + 60,
    );
  });
});
