import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  BLOCK_TILES,
  CRACK_STAGES,
  TILE,
  TILE_PX,
  crackStage,
  tileUvRect,
} from '../../src/render/atlas';

const GENERATOR = fileURLToPath(new URL('../../tools/gen-atlas.mjs', import.meta.url));
const ATLAS_PNG = fileURLToPath(new URL('../../public/textures/atlas.png', import.meta.url));
const CRACK_PNG = fileURLToPath(new URL('../../public/textures/crack.png', import.meta.url));

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

describe('挖掘进度换算成裂纹阶', () => {
  it('没在挖时没有裂纹', () => {
    expect(crackStage(0)).toBeUndefined();
  });

  it('进度刚过 0 就出第一阶', () => {
    // 一按下就得看到反馈，否则前 10% 的时间里画面上什么都没发生
    expect(crackStage(1e-6)).toBe(0);
    expect(crackStage(0.05)).toBe(0);
  });

  it('十等分进度，每一阶占一份', () => {
    for (let stage = 0; stage < CRACK_STAGES; stage++) {
      // 取每一份的中点，避开边界上的取整争议
      expect(crackStage((stage + 0.5) / CRACK_STAGES), `第 ${stage} 阶`).toBe(stage);
    }
  });

  it('进度到 1 时钳在最后一阶，不会越界取到下一张图', () => {
    expect(crackStage(1)).toBe(CRACK_STAGES - 1);
    expect(crackStage(2)).toBe(CRACK_STAGES - 1);
  });

  it('阶数随进度单调不减', () => {
    let previous = -1;
    for (let i = 0; i <= 200; i++) {
      const stage = crackStage(i / 200) ?? -1;
      expect(stage).toBeGreaterThanOrEqual(previous);
      previous = stage;
    }
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

  it('生成脚本的裂纹阶数与 atlas.ts 一致', () => {
    expect(generatorConst('CRACK_STAGES')).toBe(CRACK_STAGES);
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

  it('已提交的裂纹条是 10 阶横排一行', () => {
    const png = readFileSync(CRACK_PNG);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // 一行 CRACK_STAGES 张：渲染层就是按 1 / CRACK_STAGES 的 uv 宽度横向偏移取图的
    expect(png.readUInt32BE(16)).toBe(CRACK_STAGES * TILE_PX);
    expect(png.readUInt32BE(20)).toBe(TILE_PX);
  });
});
