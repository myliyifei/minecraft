import { BlockType } from '../core/block';

/** 图集的格数与每格像素数。贴图是 16×16 像素风，图集为 4×4 格。 */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const TILE_PX = 16;
export const ATLAS_PATH = 'textures/atlas.png';

/**
 * 图集中每张贴图的格号，从左上角起按行编号。
 * tools/gen-atlas.mjs 用同一份编号生成 PNG，改这里要同步改那边。
 */
export const TILE = {
  grassTop: 0,
  grassSide: 1,
  dirt: 2,
  stone: 3,
  bedrock: 4,
  oakLogTop: 5,
  oakLogSide: 6,
  oakLeaves: 7,
} as const;

export interface FaceTiles {
  readonly top: number;
  readonly bottom: number;
  readonly side: number;
}

/**
 * 方块到贴图格号的映射——纯数据。后续切片加方块只往这张表加行。
 * 空气没有贴图。
 */
export const BLOCK_TILES: Readonly<Record<BlockType, FaceTiles | null>> = {
  [BlockType.Air]: null,
  [BlockType.Grass]: { top: TILE.grassTop, bottom: TILE.dirt, side: TILE.grassSide },
  [BlockType.Dirt]: { top: TILE.dirt, bottom: TILE.dirt, side: TILE.dirt },
  [BlockType.Stone]: { top: TILE.stone, bottom: TILE.stone, side: TILE.stone },
  [BlockType.Bedrock]: { top: TILE.bedrock, bottom: TILE.bedrock, side: TILE.bedrock },
  [BlockType.OakLog]: {
    top: TILE.oakLogTop,
    bottom: TILE.oakLogTop,
    side: TILE.oakLogSide,
  },
  [BlockType.OakLeaves]: {
    top: TILE.oakLeaves,
    bottom: TILE.oakLeaves,
    side: TILE.oakLeaves,
  },
};

export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * 格号对应的 uv 矩形。
 * v 轴向上，而格号从图集顶行开始编号，因此 row 0 落在 v 接近 1 的一侧——
 * 与 three.js 默认的 flipY 纹理一致，贴图才不会上下颠倒。
 */
export function tileUvRect(tile: number): UvRect {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  return {
    u0: col / ATLAS_COLS,
    u1: (col + 1) / ATLAS_COLS,
    v0: 1 - (row + 1) / ATLAS_ROWS,
    v1: 1 - row / ATLAS_ROWS,
  };
}
