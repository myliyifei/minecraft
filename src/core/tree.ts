import { BlockType } from './block';
import type { Chunk } from './chunk';
import { CHUNK_SIZE } from './constants';
import { hashCoords } from './noise';

/**
 * 某一列的地表高度（Surface Height）。
 *
 * 放树要问它，而且要问到邻近区块里的列去：树冠越过区块边界时两边的区块都得算出同一棵
 * 树，所以不能只看自己区块里已有的方块。
 */
export type SurfaceHeightAt = (x: number, z: number) => number;

/**
 * 放树要的两样输入：世界种子（决定哪里长树、树长多高），与任意一列的地表高度
 * （决定树根落在哪）。
 *
 * 地表高度当参数传进来而不是直接调平原地形：树的规则与群系的高度场因此互不依赖，
 * 换个群系换个高度场就能复用，两个模块之间也不必绕一个循环 import。
 */
export interface TreePlacement {
  readonly seed: number;
  readonly surfaceAt: SurfaceHeightAt;
}

/** 一棵橡树。位置与形状全由种子决定，所以这几个数就足以描述它。 */
export interface OakTree {
  /** 树干所在的列。 */
  readonly x: number;
  readonly z: number;
  /** 最下面那格原木的 y，也就是地表之上一格。 */
  readonly rootY: number;
  /** 树干的原木格数。 */
  readonly trunkHeight: number;
}

/** 最上面那格原木的 y。树冠每一层的高度都相对它。 */
export function oakTrunkTopY(tree: OakTree): number {
  return tree.rootY + tree.trunkHeight - 1;
}

/**
 * 树格的边长（方块）。
 *
 * 世界按它切成方格，一格最多长一棵树：密度因此有上界，而一棵树只由自己那一格、加紧邻
 * 几格的哈希决定，不必顺着别的树查下去——每个区块因此能独立算出所有该写的树，
 * 见 ADR-0005。
 */
export const OAK_CELL_SIZE = 8;

/** 树格坐标用位移算，负坐标也向下取整。满足 `1 << OAK_CELL_SHIFT === OAK_CELL_SIZE`。 */
const OAK_CELL_SHIFT = 3;

/** 格内落点的掩码：树落在格内哪一列。 */
const OAK_CELL_MASK = OAK_CELL_SIZE - 1;

/** 树干的原木格数：每棵树在这个闭区间里由种子确定性地取一个。 */
export const OAK_TRUNK_MIN = 4;
export const OAK_TRUNK_MAX = 6;

/** 树干高度的取值个数（OAK_TRUNK_MIN..OAK_TRUNK_MAX 闭区间）。 */
const OAK_TRUNK_SPAN = OAK_TRUNK_MAX - OAK_TRUNK_MIN + 1;

/** 树冠的水平半径（方块）：最宽那两层是 (2r+1)×(2r+1) 去掉四角。 */
export const OAK_CANOPY_RADIUS = 2;

/**
 * 两棵树之间最小的间距（方块，切比雪夫距离）。
 *
 * 取「两个树冠刚好贴到一起」那个距离：再近一格树冠就互相穿插，两棵树长成连体——
 * 原版放树也会检查落点的空间。挨太近时让位的那一棵见 `EARLIER_CELLS`。
 */
export const OAK_MIN_SPACING = 2 * OAK_CANOPY_RADIUS + 1;

/**
 * 出生点周围不长树的半径（方块，切比雪夫距离）。指的是树根：树冠还会再伸出
 * OAK_CANOPY_RADIUS 格。
 *
 * 出生点在世界原点那一列（`GameCore.spawnPoint`）。树叶是实心的：树冠盖到出生点，玩家
 * 一进世界就卡在树叶里；盖到旁边几格，他刚迈步就撞上。所以给出生点留一小片空地，按
 * 「随便朝哪个方向走一秒都还撞不到东西」定大小——一秒 4.3 格，加半个碰撞箱是 4.6 格，
 * 所以树冠不能进 |5| 格，树根因此不能进 |7| 格。
 */
export const OAK_SPAWN_CLEARANCE = 7;

/** 橡树分布用的种子偏移量。派生出一条与高度场、泥土层数都无关的哈希流。 */
const OAK_TREE_SALT = 0x2f1a_9c37;

/**
 * 一个树格的哈希切成四段互不重叠的位，各当一颗骰子用：格内落点 x、格内落点 z、
 * 树干高度、这一格有没有树。`hashCoords` 已经把输入的每一位搅到输出的所有位上，
 * 切位段比对同一格算四次哈希便宜。
 */
const SLOT_X_SHIFT = 0;
const SLOT_Z_SHIFT = 3;
const TRUNK_SHIFT = 6;
const PRESENCE_SHIFT = 14;

/** 一段 8 位的骰子，取值 0–255。 */
const ROLL_MASK = 0xff;

/** 骰子小于这个数，这一格就长树。64/256 = 25%，一个区块 4 个树格，平均约一棵。 */
const OAK_TREE_CHANCE = 64;

/**
 * 树冠自下而上每一层的形状，`dy` 相对最上面那格原木。
 *
 * 原版式橡树冠：最宽的两层是 5×5 去掉四角，树干顶那一层是完整的 3×3，
 * 最上面一层是 3×3 去掉四角的十字。
 */
const OAK_CANOPY_LAYERS: ReadonlyArray<{
  readonly dy: number;
  readonly radius: number;
  /** 这一层保不保留四角。 */
  readonly corners: boolean;
}> = [
  { dy: -2, radius: OAK_CANOPY_RADIUS, corners: false },
  { dy: -1, radius: OAK_CANOPY_RADIUS, corners: false },
  { dy: 0, radius: 1, corners: true },
  { dy: 1, radius: 1, corners: false },
];

/**
 * 判断「挨得够不够开」时要看的邻格。
 *
 * 最小间距只可能被紧邻的 8 个树格破坏：再远的格子隔着一整个树格，两棵树必然够远
 * （OAK_CELL_SIZE 大于 OAK_MIN_SPACING）。这里只取字典序在本格之前的那 4 个，
 * 于是「谁给谁让位」有个固定的先后，不会两棵树互相让、最后一棵都不长。
 *
 * 让位的那一棵仍然算数：它自己被让掉了，却还能挤掉字典序在它之后的树。这么做是为了
 * 一格只算一次、不必顺着链条递归下去；代价只是偶尔多一处空档，看不出来。
 */
const EARLIER_CELLS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
];

/** 世界坐标所属的树格坐标。 */
function cellOf(worldCoord: number): number {
  return worldCoord >> OAK_CELL_SHIFT;
}

/**
 * 某个树格里的落点：树干那一列，与树干高度。这一格不长树则 undefined。
 *
 * 只问种子，不问地表高度——判断两棵树挨得开不开只看水平距离，而地表高度是这里最贵的
 * 一次计算（一次分形噪声），邻格检查不该为它付钱。
 */
function oakSiteInCell(
  seed: number,
  cellX: number,
  cellZ: number,
): Omit<OakTree, 'rootY'> | undefined {
  const roll = hashCoords(seed ^ OAK_TREE_SALT, cellX, cellZ);
  if (((roll >>> PRESENCE_SHIFT) & ROLL_MASK) >= OAK_TREE_CHANCE) return undefined;

  const x = cellX * OAK_CELL_SIZE + ((roll >>> SLOT_X_SHIFT) & OAK_CELL_MASK);
  const z = cellZ * OAK_CELL_SIZE + ((roll >>> SLOT_Z_SHIFT) & OAK_CELL_MASK);
  if (Math.max(Math.abs(x), Math.abs(z)) <= OAK_SPAWN_CLEARANCE) return undefined;

  return {
    x,
    z,
    trunkHeight: OAK_TRUNK_MIN + (((roll >>> TRUNK_SHIFT) & ROLL_MASK) % OAK_TRUNK_SPAN),
  };
}

/** 某个树格里的树，这一格不长树、或者树给邻格让了位则 undefined。 */
function oakTreeInCell(
  placement: TreePlacement,
  cellX: number,
  cellZ: number,
): OakTree | undefined {
  const site = oakSiteInCell(placement.seed, cellX, cellZ);
  if (!site) return undefined;

  for (const [dx, dz] of EARLIER_CELLS) {
    const earlier = oakSiteInCell(placement.seed, cellX + dx, cellZ + dz);
    if (!earlier) continue;
    const distance = Math.max(Math.abs(earlier.x - site.x), Math.abs(earlier.z - site.z));
    if (distance < OAK_MIN_SPACING) return undefined;
  }

  return { ...site, rootY: placement.surfaceAt(site.x, site.z) + 1 };
}

/** 这棵树的树冠有没有伸进以 (originX, originZ) 为角的那个区块。 */
function reachesChunk(tree: OakTree, originX: number, originZ: number): boolean {
  const reaches = (coord: number, origin: number): boolean =>
    coord + OAK_CANOPY_RADIUS >= origin && coord - OAK_CANOPY_RADIUS < origin + CHUNK_SIZE;
  return reaches(tree.x, originX) && reaches(tree.z, originZ);
}

/**
 * 会写进某个区块的全部橡树，按写入顺序排好。
 *
 * 树根可能在邻近区块里：树冠越过边界时两边的区块各写自己那一半，合起来才是一棵完整的
 * 树。所以扫的是「树冠还能伸进这个区块」的那一圈树格，而不只是区块自己盖住的那几格。
 * 每个区块各算一遍、只写自己的格子，结果因此与加载顺序无关，见 ADR-0005。
 *
 * 顺序按树格坐标从小到大，在任何区块里都一样——两棵树写同一格时谁盖住谁因此是确定的。
 */
export function oakTreesTouching(
  placement: TreePlacement,
  cx: number,
  cz: number,
): OakTree[] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const trees: OakTree[] = [];
  const lastCellZ = cellOf(originZ + CHUNK_SIZE - 1 + OAK_CANOPY_RADIUS);
  const lastCellX = cellOf(originX + CHUNK_SIZE - 1 + OAK_CANOPY_RADIUS);
  for (let cellZ = cellOf(originZ - OAK_CANOPY_RADIUS); cellZ <= lastCellZ; cellZ++) {
    for (let cellX = cellOf(originX - OAK_CANOPY_RADIUS); cellX <= lastCellX; cellX++) {
      const tree = oakTreeInCell(placement, cellX, cellZ);
      if (tree && reachesChunk(tree, originX, originZ)) trees.push(tree);
    }
  }
  return trees;
}

/**
 * 把会写进这个区块的橡树种下去。
 *
 * 要在土石铺好之后调：树叶只往空气里长，得先有地面才知道哪里是空气。
 * 落在区块外的格子由 `Chunk` 自己丢掉，那部分是邻居区块的活。
 */
export function plantOakTrees(placement: TreePlacement, chunk: Chunk): void {
  const originX = chunk.cx * CHUNK_SIZE;
  const originZ = chunk.cz * CHUNK_SIZE;
  for (const tree of oakTreesTouching(placement, chunk.cx, chunk.cz)) {
    const lx = tree.x - originX;
    const lz = tree.z - originZ;
    // 先树冠后树干：两者在树顶那几格重叠，原木盖住树叶。
    plantCanopy(chunk, tree, lx, lz);
    chunk.fillColumn(lx, lz, tree.rootY, oakTrunkTopY(tree), BlockType.OakLog);
  }
}

/** 把树冠写进区块，(lx, lz) 是树干在这个区块里的局部坐标。 */
function plantCanopy(chunk: Chunk, tree: OakTree, lx: number, lz: number): void {
  const top = oakTrunkTopY(tree);
  for (const { dy, radius, corners } of OAK_CANOPY_LAYERS) {
    const y = top + dy;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!corners && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
        // 只往空气里长，不顶掉已经在那儿的方块。平原上这一条其实一次也没触发过：树冠
        // 底面只比自己那一列的地表高两格，而两格外的地面最多也就高两格——两者相等时
        // 那一格就是邻居的草方块，顶掉它就是地上一个洞。地形一变陡就不再是余量。
        if (chunk.get(lx + dx, y, lz + dz) !== BlockType.Air) continue;
        chunk.set(lx + dx, y, lz + dz, BlockType.OakLeaves);
      }
    }
  }
}
