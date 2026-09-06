import { BlockType } from '../core/block';
import { ItemType } from '../core/item';

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

/**
 * 物品在图集里的贴图格号——纯数据。
 *
 * 单独一张表而不是从 `BLOCK_TILES` 转过来：物品与方块不是一一对应的（工具、食物没有
 * 对应的方块，草方块掉的又是泥土）。掉落物的小方块六个面按这张表取图，快捷栏的图标
 * 取 `side` 那一格——原木的侧面是树皮，比年轮的顶面更像玩家印象里的那个物品。
 */
export const ITEM_TILES: Readonly<Record<ItemType, FaceTiles>> = {
  [ItemType.Dirt]: { top: TILE.dirt, bottom: TILE.dirt, side: TILE.dirt },
  [ItemType.OakLog]: {
    top: TILE.oakLogTop,
    bottom: TILE.oakLogTop,
    side: TILE.oakLogSide,
  },
};

export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * 裂纹贴图条：10 张 16×16 横排成一张图，第 n 张就是第 n 阶裂纹。
 *
 * 单独一张图而不是塞进方块图集：裂纹是贴在方块表面上的另一层，用的是另一种材质
 * （半透明混合，而不是图集那样靠 alphaTest 抠树叶），而且要靠 uv 偏移逐阶切换——
 * 偏移是贴图对象上的属性，两种材质共用一张贴图就得各自克隆一份。
 */
export const CRACK_PATH = 'textures/crack.png';

/** 裂纹分几阶。 */
export const CRACK_STAGES = 10;

/**
 * 挖掘进度对应的裂纹阶（0 到 `CRACK_STAGES` − 1），没在挖时没有裂纹，返回 undefined。
 *
 * 核心只报进度（见 `MiningView.progress`），分几阶是贴图的事：换一套阶数不同的贴图包
 * 只改这个文件。进度刚过 0 就出第一阶——玩家一按下就得看到反馈；进度到 1 时钳在最后
 * 一阶，不会越界取到下一张图。
 */
export function crackStage(progress: number): number | undefined {
  if (!(progress > 0)) return undefined;
  return Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES));
}

/**
 * 格号在图集里的列与行，从左上角起。
 * 快捷栏的图标是一张 CSS 精灵图，要的是格位置而不是 uv。
 */
export function tileCell(tile: number): { readonly col: number; readonly row: number } {
  return { col: tile % ATLAS_COLS, row: Math.floor(tile / ATLAS_COLS) };
}

/**
 * 格号对应的 uv 矩形。
 * v 轴向上，而格号从图集顶行开始编号，因此 row 0 落在 v 接近 1 的一侧——
 * 与 three.js 默认的 flipY 纹理一致，贴图才不会上下颠倒。
 */
export function tileUvRect(tile: number): UvRect {
  const { col, row } = tileCell(tile);
  return {
    u0: col / ATLAS_COLS,
    u1: (col + 1) / ATLAS_COLS,
    v0: 1 - (row + 1) / ATLAS_ROWS,
    v1: 1 - row / ATLAS_ROWS,
  };
}

/**
 * three.js 的 `BoxGeometry` 六个面的顺序，以及每个面取方块的哪一张贴图。
 * 顺序由 three 决定（+X、−X、+Y、−Y、+Z、−Z），改不了，只能对着它写。
 */
const BOX_FACES: readonly (keyof FaceTiles)[] = [
  'side',
  'side',
  'top',
  'bottom',
  'side',
  'side',
];

/**
 * `BoxGeometry` 每个面四个顶点的 uv，归一化到这一面自己的 [0, 1]²。
 * 顺序同样由 three 决定：左上、右上、左下、右下。
 */
const BOX_FACE_UV: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [0, 0],
  [1, 0],
];

/**
 * 一个物品小方块（掉落物）的 uv 数组：六个面各自映射到图集里的那一格。
 *
 * 必须替换掉 `BoxGeometry` 默认的 uv——默认每个面都铺满整张贴图，那样一个面上会贴着
 * 整张图集。这个函数是纯数据变换、不 import three，因此能在 Node 里测。
 */
export function itemCubeUvs(item: ItemType): Float32Array {
  const tiles = ITEM_TILES[item];
  const uvs = new Float32Array(BOX_FACES.length * BOX_FACE_UV.length * 2);
  let i = 0;
  for (const face of BOX_FACES) {
    const rect = tileUvRect(tiles[face]);
    for (const [du, dv] of BOX_FACE_UV) {
      uvs[i++] = rect.u0 + du * (rect.u1 - rect.u0);
      uvs[i++] = rect.v0 + dv * (rect.v1 - rect.v0);
    }
  }
  return uvs;
}
