import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_TILES,
  HeldItemShape,
  ITEM_TILES,
  TILE,
  TILE_PX,
  heldItemShape,
  tileCell,
} from '../../src/render/atlas';
import { BIRCH, OAK, SPRUCE, expectDefined, type WoodSpecies } from '../helpers/wood-species';

/**
 * 白桦与云杉的贴图（#85）：每种树 4 格（原木顶、原木侧、树叶、木板），共 8 格，占第 49 到 56 格。
 * 第 47、48 格留给并行的 #74（水与冰）。
 */

/** 一种树的四格贴图在 TILE 表里的名称。 */
const TILE_NAMES: ReadonlyArray<readonly [WoodSpecies, Record<'logTop' | 'logSide' | 'leaves' | 'planks', string>]> = [
  [BIRCH, { logTop: 'birchLogTop', logSide: 'birchLogSide', leaves: 'birchLeaves', planks: 'birchPlanks' }],
  [SPRUCE, { logTop: 'spruceLogTop', logSide: 'spruceLogSide', leaves: 'spruceLeaves', planks: 'sprucePlanks' }],
];

/** TILE 表里按名称取格号，没有这个名称时是 undefined。 */
function tile(name: string): number | undefined {
  return (TILE as Readonly<Record<string, number>>)[name];
}

describe('白桦与云杉的贴图格号', () => {
  it('白桦四格是 49、50、51、52，云杉四格是 53、54、55、56', () => {
    expect([tile('birchLogTop'), tile('birchLogSide'), tile('birchLeaves'), tile('birchPlanks')]).toEqual([
      49, 50, 51, 52,
    ]);
    expect([tile('spruceLogTop'), tile('spruceLogSide'), tile('spruceLeaves'), tile('sprucePlanks')]).toEqual([
      53, 54, 55, 56,
    ]);
  });

  it('现有格号不变：橡树四格仍是 5、6、7、8，第 47、48 格不被 #85 占用', () => {
    expect([TILE.oakLogTop, TILE.oakLogSide, TILE.oakLeaves, TILE.oakPlanks]).toEqual([5, 6, 7, 8]);
    const ours = TILE_NAMES.flatMap(([, names]) => Object.values(names).map(tile));
    expect(ours).not.toContain(47);
    expect(ours).not.toContain(48);
  });
});

describe.each(TILE_NAMES.map(([species, names]) => [species.name, species, names] as const))(
  '%s的方块与物品贴图',
  (_name, species, names) => {
  it('原木顶面底面是年轮、四个侧面是树皮', () => {
    expectDefined(species);
    expect(BLOCK_TILES[species.log]).toEqual({ top: tile(names.logTop), bottom: tile(names.logTop), side: tile(names.logSide) });
  });

  it('树叶与木板六面同图', () => {
    expectDefined(species);
    const leaves = tile(names.leaves);
    const planks = tile(names.planks);
    expect(BLOCK_TILES[species.leaves]).toEqual({ top: leaves, bottom: leaves, side: leaves });
    expect(BLOCK_TILES[species.planks]).toEqual({ top: planks, bottom: planks, side: planks });
  });

  it('原木与木板物品的小方块与方块本身六面相同，手持画立方体', () => {
    expectDefined(species);
    expect(ITEM_TILES[species.logItem]).toEqual(BLOCK_TILES[species.log]);
    expect(ITEM_TILES[species.planksItem]).toEqual(BLOCK_TILES[species.planks]);
    expect(heldItemShape(species.logItem)).toBe(HeldItemShape.Cube);
    expect(heldItemShape(species.planksItem)).toBe(HeldItemShape.Cube);
  });

  it('四格都与橡树对应的那一格不同', () => {
    expectDefined(species);
    expect(BLOCK_TILES[species.log]).not.toEqual(BLOCK_TILES[OAK.log]);
    expect(BLOCK_TILES[species.leaves]).not.toEqual(BLOCK_TILES[OAK.leaves]);
    expect(BLOCK_TILES[species.planks]).not.toEqual(BLOCK_TILES[OAK.planks]);
  });
  },
);

describe('已提交的图集 PNG 画了这 8 格', () => {
  const ATLAS_PNG = fileURLToPath(new URL('../../public/textures/atlas.png', import.meta.url));

  /** 解码已提交的图集 PNG（只认 gen-atlas.mjs 写出的 8 位 RGBA、不隔行、每行滤波 0）。 */
  function decodeAtlas(): { rgba: Uint8Array; width: number; height: number } {
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
    return { rgba, width, height };
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

  /** 这一格里不透明（alpha 为 255）的像素数。 */
  function opaquePixels(pixels: Uint8Array): number {
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 255) count++;
    return count;
  }

  const ALL = TILE_PX * TILE_PX;

  it('原木顶、原木侧、木板三格每个像素都不透明；树叶格有不透明的像素（可以有镂空）', () => {
    const atlas = decodeAtlas();
    for (const [, names] of TILE_NAMES) {
      for (const key of ['logTop', 'logSide', 'planks'] as const) {
        const index = tile(names[key]);
        expect(index, names[key]).toBeTypeOf('number');
        expect(opaquePixels(tilePixels(atlas, index!)), names[key]).toBe(ALL);
      }
      const leaves = tile(names.leaves);
      expect(leaves, names.leaves).toBeTypeOf('number');
      expect(opaquePixels(tilePixels(atlas, leaves!)), names.leaves).toBeGreaterThan(0);
    }
  });

  it('8 格像素两两不同，也都与橡树的四格不同', () => {
    const atlas = decodeAtlas();
    const indices = [
      ...TILE_NAMES.flatMap(([, names]) => Object.values(names).map(tile)),
      TILE.oakLogTop,
      TILE.oakLogSide,
      TILE.oakLeaves,
      TILE.oakPlanks,
    ];
    for (const index of indices) expect(index).toBeTypeOf('number');
    const hex = indices.map((index) => Buffer.from(tilePixels(atlas, index!)).toString('hex'));
    expect(new Set(hex).size).toBe(12);
  });
});
