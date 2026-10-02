import { BlockType, placedBlock } from '../core/block';
import { isTorch } from '../core/torch';
import { ItemType } from '../core/item';

/**
 * 图集的格数与每格像素数。贴图是 16×16 像素风，图集为 8 列 8 行，目前用了前 45 格里的 44 格（第 43 格不用）。
 *
 * 行列数都取 2 的幂：uv 是格号除以行列数，除以 8 在 float32 里是精确的，除以 5 就不是
 * ——顶点属性存的是 Float32Array，1/5 一进去就带上舍入误差，一个面的边缘会取到相邻那一格的像素。
 * 第三切片（#30）从 4 列扩到 8 列：矿石、材料、铁制工具还要十来格，4x8 的 32 格装不下。
 */
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
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
  oakPlanks: 8,
  stick: 9,
  craftingTableTop: 10,
  craftingTableSide: 11,
  craftingTableFront: 12,
  woodenPickaxe: 13,
  woodenAxe: 14,
  woodenShovel: 15,
  cobblestone: 16,
  stonePickaxe: 17,
  stoneAxe: 18,
  stoneShovel: 19,
  furnaceTop: 20,
  furnaceSide: 21,
  furnaceFront: 22,
  litFurnaceFront: 23,
  coalOre: 24,
  ironOre: 25,
  coal: 26,
  rawIron: 27,
  ironIngot: 28,
  ironPickaxe: 29,
  ironAxe: 30,
  ironShovel: 31,
  charcoal: 32,
  // 天上的太阳与月亮（#38）：各是一张方片，不属于任何方块或物品。
  sun: 33,
  moon: 34,
  // 僵尸模型（#41）的四张：头的正面、皮肤（头的其余五面与两条手臂）、上衣（身体）、裤子（两条腿）。
  zombieFace: 35,
  zombieSkin: 36,
  zombieShirt: 37,
  zombiePants: 38,
  // 僵尸掉的腐肉（#42）。
  rottenFlesh: 39,
  // 木石铁三把剑（#45）。
  woodenSword: 40,
  stoneSword: 41,
  ironSword: 42,
  // 火把（#57）：居中一根两像素宽、十像素高的木杆，顶端两行是火——细杆几何（`torch-model.ts`）的侧面与
  // 顶面只取这一竖条，手持与格子里的平面图标是整格。第 43 格不用：那是 #56 的临时贴图，火焰画在细杆之外。
  torch: 44,
} as const;

/**
 * 一种方块（或物品小方块）六个面各取哪一格。
 *
 * `front` 是可选的：绝大多数方块四个侧面同一张图，只有工作台这类有「正面」的方块才填。
 * 填了的话它贴在 −X 与 −Z 两面（西面与北面），另两面仍是 `side`——与原版工作台的朝向
 * 一致。本项目的方块没有朝向，所以正面固定朝这两个方向。取面用 `faceTile`，没填的
 * `front` 落回 `side`。
 */
export interface FaceTiles {
  readonly top: number;
  readonly bottom: number;
  readonly side: number;
  readonly front?: number;
}

/** 一个面的名字：`FaceTiles` 的键。 */
export type Face = keyof FaceTiles;

/** 这个面取哪一格。没有正面贴图的方块，正面就是侧面。 */
export function faceTile(tiles: FaceTiles, face: Face): number {
  return tiles[face] ?? tiles.side;
}

/** 圆石：六面同一张。方块与物品小方块共用这一份。 */
const COBBLESTONE_TILES: FaceTiles = {
  top: TILE.cobblestone,
  bottom: TILE.cobblestone,
  side: TILE.cobblestone,
};

/** 工作台：顶面是台面，底面是木板，侧面与正面各一张。方块与物品小方块共用这一份。 */
const CRAFTING_TABLE_TILES: FaceTiles = {
  top: TILE.craftingTableTop,
  bottom: TILE.oakPlanks,
  side: TILE.craftingTableSide,
  front: TILE.craftingTableFront,
};

/**
 * 熔炉：顶面与底面同一张，侧面一张，正面是熄火的炉口。方块与物品小方块共用这一份。
 * 燃烧中的那个编号只把正面换成燃烧中的炉口，其余四面与它相同。
 */
const FURNACE_TILES: FaceTiles = {
  top: TILE.furnaceTop,
  bottom: TILE.furnaceTop,
  side: TILE.furnaceSide,
  front: TILE.furnaceFront,
};

const LIT_FURNACE_TILES: FaceTiles = { ...FURNACE_TILES, front: TILE.litFurnaceFront };

/** 六面同一张图的方块（矿石）与物品（木棍、工具、材料）在两张表里那一行。 */
function flat(tile: number): FaceTiles {
  return { top: tile, bottom: tile, side: tile };
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
  [BlockType.OakPlanks]: { top: TILE.oakPlanks, bottom: TILE.oakPlanks, side: TILE.oakPlanks },
  [BlockType.CraftingTable]: CRAFTING_TABLE_TILES,
  [BlockType.Cobblestone]: COBBLESTONE_TILES,
  [BlockType.Furnace]: FURNACE_TILES,
  [BlockType.LitFurnace]: LIT_FURNACE_TILES,
  // 矿石：以石头贴图为底加矿点，六面同一张。
  [BlockType.CoalOre]: flat(TILE.coalOre),
  [BlockType.IronOre]: flat(TILE.ironOre),
  // 火把五个编号暂画整格立方体、六面贴同一格（#56），细杆几何由 #57 接手。
  [BlockType.Torch]: flat(TILE.torch),
  [BlockType.WallTorchNegX]: flat(TILE.torch),
  [BlockType.WallTorchPosX]: flat(TILE.torch),
  [BlockType.WallTorchNegZ]: flat(TILE.torch),
  [BlockType.WallTorchPosZ]: flat(TILE.torch),
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
  [ItemType.OakPlanks]: { top: TILE.oakPlanks, bottom: TILE.oakPlanks, side: TILE.oakPlanks },
  // 木棍与工具没有对应的方块：掉落物的小方块六面都贴同一张图标，手持画的是平面图标
  // （`heldItemShape`）。
  [ItemType.Stick]: flat(TILE.stick),
  [ItemType.CraftingTable]: CRAFTING_TABLE_TILES,
  [ItemType.WoodenPickaxe]: flat(TILE.woodenPickaxe),
  [ItemType.WoodenAxe]: flat(TILE.woodenAxe),
  [ItemType.WoodenShovel]: flat(TILE.woodenShovel),
  [ItemType.Cobblestone]: COBBLESTONE_TILES,
  [ItemType.StonePickaxe]: flat(TILE.stonePickaxe),
  [ItemType.StoneAxe]: flat(TILE.stoneAxe),
  [ItemType.StoneShovel]: flat(TILE.stoneShovel),
  // 熔炉物品的图标是熄火那个正面：放下去永远是熄火的编号，图标画的就是它。
  [ItemType.Furnace]: FURNACE_TILES,
  // 煤炭、粗铁与铁锭是材料，没有对应的方块：与木棍一样六面同一张图标，手持画平面图标。
  [ItemType.Coal]: flat(TILE.coal),
  [ItemType.RawIron]: flat(TILE.rawIron),
  [ItemType.IronIngot]: flat(TILE.ironIngot),
  [ItemType.IronPickaxe]: flat(TILE.ironPickaxe),
  [ItemType.IronAxe]: flat(TILE.ironAxe),
  [ItemType.IronShovel]: flat(TILE.ironShovel),
  // 木炭是原木炼出来的材料，与煤炭同形状的一块，颜色偏棕（#34）。
  [ItemType.Charcoal]: flat(TILE.charcoal),
  // 腐肉没有对应的方块：六面同一张图标，手持画平面图标。
  [ItemType.RottenFlesh]: flat(TILE.rottenFlesh),
  // 剑与工具一样：六面同一张图标，手持画平面图标（#45）。
  [ItemType.WoodenSword]: flat(TILE.woodenSword),
  [ItemType.StoneSword]: flat(TILE.stoneSword),
  [ItemType.IronSword]: flat(TILE.ironSword),
  [ItemType.Torch]: flat(TILE.torch),
};

/**
 * 手持物品（见 CONTEXT.md）在第一人称右下角画成什么：方块物品画立方体，其余（木棍、工具）
 * 画一张竖着的平面图标。
 *
 * 值是字符串：渲染层据此挑几何体，端到端测试据此断言画的是哪一种，不进存档。
 */
export const HeldItemShape = {
  Cube: 'cube',
  Flat: 'flat',
} as const;

export type HeldItemShape = (typeof HeldItemShape)[keyof typeof HeldItemShape];

/**
 * 这种物品手持时画立方体还是平面图标。
 *
 * 看的是放置表：放得下去的物品就是方块，画立方体；放不下去的（木棍、工具、将来的食物）
 * 没有「六个面」可画，画图标。不另开一张表——「是不是方块物品」这件事放置表已经记了。
 * 火把放得下去，但它的方块是一根细杆，同样没有六个面，画图标（#57）。
 */
export function heldItemShape(item: ItemType): HeldItemShape {
  const block = placedBlock(item);
  return block === null || isTorch(block) ? HeldItemShape.Flat : HeldItemShape.Cube;
}

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
 * 只改这个文件。进度刚过 0 就出第一阶——玩家一按下就得看到反馈；进度到 1 时限制在最后
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
 * 一对 uv 落在哪一格上：`tileUvRect` 的反函数。格的边界上的点归到下标大的那一格，所以要拿
 * 一个面的 uv 中点来反查，不要拿角。渲染层的调试查询与网格测试用它读回「这个面贴的是哪一格」。
 */
export function tileAtUv(u: number, v: number): number {
  const col = Math.floor(u * ATLAS_COLS);
  const row = ATLAS_ROWS - 1 - Math.floor(v * ATLAS_ROWS);
  return row * ATLAS_COLS + col;
}

/**
 * three.js 的 `BoxGeometry` 六个面的顺序，以及每个面取方块的哪一张贴图。
 * 顺序由 three 决定（+X、−X、+Y、−Y、+Z、−Z），改不了，只能对着它写。
 * 正面贴 −X 与 −Z，与区块网格（`src/render/mesh.ts`）一致。
 */
const BOX_FACES: readonly Face[] = ['side', 'front', 'top', 'bottom', 'side', 'front'];

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
 * 一张物品平面图标（手持的木棍与工具）的 uv 数组：`PlaneGeometry` 四个顶点各落在图集里
 * 那一格的四个角上。取的是 `front`，与快捷栏的图标同一张。
 *
 * `PlaneGeometry` 的顶点顺序与 `BoxGeometry` 的一个面相同（左上、右上、左下、右下），
 * 所以复用 `BOX_FACE_UV`。与 `itemCubeUvs` 一样是纯数据变换，不 import three。
 */
export function itemIconUvs(item: ItemType): Float32Array {
  return tileQuadUvs(faceTile(ITEM_TILES[item], 'front'));
}

/**
 * 一张方片贴图格号那一格的 uv 数组：`PlaneGeometry` 四个顶点各落在那一格的四个角上。
 * 手持的平面图标与天上的太阳、月亮都用它。
 */
export function tileQuadUvs(tile: number): Float32Array {
  const rect = tileUvRect(tile);
  const uvs = new Float32Array(BOX_FACE_UV.length * 2);
  let i = 0;
  for (const [du, dv] of BOX_FACE_UV) {
    uvs[i++] = rect.u0 + du * (rect.u1 - rect.u0);
    uvs[i++] = rect.v0 + dv * (rect.v1 - rect.v0);
  }
  return uvs;
}

/**
 * 一个物品小方块（掉落物）的 uv 数组：六个面各自映射到图集里的那一格。
 *
 * 必须替换掉 `BoxGeometry` 默认的 uv——默认每个面都铺满整张贴图，那样一个面上会贴着
 * 整张图集。这个函数是纯数据变换、不 import three，因此能在 Node 里测。
 */
export function itemCubeUvs(item: ItemType): Float32Array {
  const tiles = ITEM_TILES[item];
  return boxUvs(BOX_FACES.map((face) => faceTile(tiles, face)));
}

/**
 * 一个 `BoxGeometry` 的 uv 数组：`tiles` 按 three 的面序（+X、−X、+Y、−Y、+Z、−Z）给出六个面
 * 各取哪一格，每个面铺满那一格。
 *
 * 物品小方块按 `FaceTiles` 取面，正面同时贴在 −X 与 −Z 上；僵尸的头只有 −Z 一面是脸，
 * 所以直接按面序给六个格号。
 */
export function boxUvs(tiles: readonly number[]): Float32Array {
  const uvs = new Float32Array(tiles.length * BOX_FACE_UV.length * 2);
  let i = 0;
  for (const tile of tiles) {
    const rect = tileUvRect(tile);
    for (const [du, dv] of BOX_FACE_UV) {
      uvs[i++] = rect.u0 + du * (rect.u1 - rect.u0);
      uvs[i++] = rect.v0 + dv * (rect.v1 - rect.v0);
    }
  }
  return uvs;
}
