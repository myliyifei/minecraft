import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  BLOCK_TILES,
  TILE,
  TILE_PX,
  tileUvRect,
} from '../../src/render/atlas';

const GENERATOR = fileURLToPath(new URL('../../tools/gen-atlas.mjs', import.meta.url));
const ATLAS_PNG = fileURLToPath(new URL('../../public/textures/atlas.png', import.meta.url));

describe('方块到贴图格号的映射表', () => {
  it('除空气外每种方块都有贴图', () => {
    for (const block of Object.values(BlockType)) {
      const tiles = BLOCK_TILES[block];
      if (block === BlockType.Air) {
        expect(tiles).toBeNull();
      } else {
        expect(tiles, `方块 ${block} 缺贴图`).not.toBeNull();
      }
    }
  });

  it('引用的格号都在图集范围内', () => {
    const capacity = ATLAS_COLS * ATLAS_ROWS;
    for (const tiles of Object.values(BLOCK_TILES)) {
      if (!tiles) continue;
      for (const tile of [tiles.top, tiles.bottom, tiles.side]) {
        expect(tile).toBeGreaterThanOrEqual(0);
        expect(tile).toBeLessThan(capacity);
      }
    }
  });

  it('不同格的 uv 矩形互不重叠，且都在 [0, 1] 内', () => {
    const rects = Object.values(TILE).map(tileUvRect);
    for (const rect of rects) {
      expect(rect.u0).toBeGreaterThanOrEqual(0);
      expect(rect.v0).toBeGreaterThanOrEqual(0);
      expect(rect.u1).toBeLessThanOrEqual(1);
      expect(rect.v1).toBeLessThanOrEqual(1);
      expect(rect.u1).toBeGreaterThan(rect.u0);
      expect(rect.v1).toBeGreaterThan(rect.v0);
    }
    const keys = new Set(rects.map((r) => `${r.u0},${r.v0}`));
    expect(keys.size).toBe(rects.length);
  });
});

describe('图集与生成脚本、PNG 文件保持同步', () => {
  const source = readFileSync(GENERATOR, 'utf8');

  function generatorConst(name: string): number {
    const match = source.match(new RegExp(`const ${name} = (\\d+)`));
    expect(match, `tools/gen-atlas.mjs 里找不到常量 ${name}`).not.toBeNull();
    return Number(match![1]);
  }

  it('生成脚本的图集布局与 atlas.ts 一致', () => {
    expect(generatorConst('COLS')).toBe(ATLAS_COLS);
    expect(generatorConst('ROWS')).toBe(ATLAS_ROWS);
    expect(generatorConst('TILE_PX')).toBe(TILE_PX);
  });

  it('生成脚本画了 TILE 表里的每一个格号', () => {
    const painted = new Set(
      [...source.matchAll(/^ {2}(\d+): /gm)].map((match) => Number(match[1])),
    );
    for (const [name, tile] of Object.entries(TILE)) {
      expect(painted.has(tile), `gen-atlas.mjs 没画 ${name}（格号 ${tile}）`).toBe(true);
    }
  });

  it('已提交的 PNG 尺寸与图集布局一致', () => {
    const png = readFileSync(ATLAS_PNG);
    // PNG 的 IHDR 宽高就在固定偏移上，读它比解码整张图便宜。
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(ATLAS_COLS * TILE_PX);
    expect(png.readUInt32BE(20)).toBe(ATLAS_ROWS * TILE_PX);
  });
});
