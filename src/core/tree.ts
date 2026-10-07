import { BlockType } from './block';
import type { Chunk } from './chunk';
import { CHUNK_SIZE, SEA_LEVEL } from './constants';
import { Biome } from './biome';
import { hashCoords } from './noise';
import { SNOW_LINE_Y } from './surface';
import type { ColumnCoord } from './world';

/**
 * 某一列的地表高度（Surface Height）。
 *
 * 放树要问它，而且要问到邻近区块里的列去：树冠越过区块边界时两边的区块都得算出同一棵
 * 树，所以不能只看自己区块里已有的方块。
 */
export type SurfaceHeightAt = (x: number, z: number) => number;

/**
 * 放树要的五样输入：世界种子（决定哪里长树、长哪种、树长多高）、任意一列的群系（决定长哪种树，大海里不长树）、
 * 任意一列的地表高度（决定树根落在哪）、任意一列的列顶地表方块（只长在草方块与雪草方块上），与出生列（它周围不长树）。
 *
 * 地表高度当参数传进来而不是直接调地形模块：树的规则与地形算法因此互不依赖，
 * 换了地形算法照样复用，两个模块之间也不必绕一个循环 import。成员名与地形对象
 * （`Terrain`）的同名成员一致，地形对象因此可以直接当它传。
 */
export interface TreePlacement {
  readonly seed: number;
  readonly biomeAt: (x: number, z: number) => Biome;
  readonly surfaceHeightAt: SurfaceHeightAt;
  readonly surfaceBlockAt: (x: number, z: number) => BlockType;
  /** 出生列（见 GLOSSARY.md「出生点」），树根不落在它周围 `TREE_SPAWN_CLEARANCE` 格内。 */
  readonly spawnColumn: ColumnCoord;
}

/** 树干能长在哪些列顶地表方块上（GLOSSARY.md「树」）：沙滩、陡坡的石头、水底的沙子与沙砾都不长。 */
const TREE_GROUND: ReadonlySet<BlockType> = new Set([BlockType.Grass, BlockType.SnowyGrass]);

/**
 * 树种（GLOSSARY.md「树」）。写法同 `Biome`：同名的类型是这几个值的联合。
 */
export const TreeSpecies = {
  Oak: 'oak',
  Birch: 'birch',
  Spruce: 'spruce',
} as const;
export type TreeSpecies = (typeof TreeSpecies)[keyof typeof TreeSpecies];

/** 一棵树。位置、树种与形状全由种子决定，所以这几个数就足以描述它。 */
export interface Tree {
  /** 树干所在的列。 */
  readonly x: number;
  readonly z: number;
  /** 最下面那格原木的 y，也就是地表之上一格。 */
  readonly rootY: number;
  /** 树干的原木格数。 */
  readonly trunkHeight: number;
  readonly species: TreeSpecies;
}

/** 最上面那格原木的 y。树冠每一层的高度都相对它。 */
export function trunkTopY(tree: Tree): number {
  return tree.rootY + tree.trunkHeight - 1;
}

/**
 * 树格的边长（方块）。
 *
 * 世界按它切成方格，一格最多长一棵树：密度因此有上界，而一棵树只由自己那一格、加紧邻
 * 几格的哈希决定，不必顺着别的树查下去——每个区块因此能独立算出所有该写的树，
 * 见 ADR-0005。
 */
export const TREE_CELL_SIZE = 8;

/** 树格坐标用位移算，负坐标也向下取整。满足 `1 << TREE_CELL_SHIFT === TREE_CELL_SIZE`。 */
const TREE_CELL_SHIFT = 3;

/** 格内落点的掩码：树落在格内哪一列。 */
const TREE_CELL_MASK = TREE_CELL_SIZE - 1;

/** 橡树与白桦树干的原木格数：每棵树在这个闭区间里由种子确定性地取一个。 */
export const OAK_TRUNK_MIN = 4;
export const OAK_TRUNK_MAX = 6;

/** 橡树与白桦树冠的水平半径（方块）：最宽那两层是 (2r+1)×(2r+1) 去掉四角。 */
export const OAK_CANOPY_RADIUS = 2;

/**
 * 云杉树干的原木格数。树冠最下面一层在树干顶之下 5 格，树干至少 7 格，那一层才在地表之上至少 1 格。
 */
export const SPRUCE_TRUNK_MIN = 7;
export const SPRUCE_TRUNK_MAX = 9;

/** 云杉树冠的水平半径（方块）：最下面那层 7×7 去掉四角。ADR-0005 补记：不超过 3。 */
export const SPRUCE_CANOPY_RADIUS = 3;

/**
 * 所有树种中最大的树冠半径。区块扫描「树冠还能伸进来」的树格时按它扩一圈（ADR-0005），再按每棵树自己的半径
 * 判断伸不伸进区块（`reachesChunk`）。区块边长是树格边长的两倍、边界对齐，半径 1 到 8 扫到的树格相同；
 * 按最大半径扩，是为了这个结论不依赖两个边长的取值。
 */
export const MAX_CANOPY_RADIUS = Math.max(OAK_CANOPY_RADIUS, SPRUCE_CANOPY_RADIUS);

/**
 * 出生列周围不长树的半径（方块，切比雪夫距离）。指的是树根：树冠还会再伸出
 * 树冠半径那么多格。
 *
 * 出生点在出生列上（`TreePlacement.spawnColumn`、`GameCore.spawnPoint`）。树叶是实心的：树冠伸到出生点，玩家
 * 一进世界碰撞箱就与树叶相交；伸到旁边几格，玩家刚迈步就停在树叶前。所以给出生点留一小片空地，按
 * 「朝任何方向走一秒，碰撞箱都不与树叶相交」定大小——一秒 4.3 格，加半个碰撞箱是 4.6 格，
 * 所以橡树冠不能进 |5| 格，树根因此不能进 |7| 格。出生列在平原（GLOSSARY.md「出生点」），周围长的是橡树与白桦；
 * 云杉的树冠半径大一格，出生列落在平原之外时云杉的树冠能伸到 |4| 格，这种情形少见，不另加大。
 */
export const TREE_SPAWN_CLEARANCE = 7;

/** 树的分布用的种子偏移量。派生出一条与地形密度、泥土层数都无关的哈希流。 */
const TREE_SALT = 0x2f1a_9c37;

/**
 * 一个树格的哈希切成五段互不重叠的位，各当一个独立的随机数用：格内落点 x、格内落点 z、
 * 树干高度、这一格有没有树、长哪种树。`hashCoords` 已经把输入的每一位搅到输出的所有位上，
 * 切位段比对同一格算五次哈希便宜。
 */
const SLOT_X_SHIFT = 0;
const SLOT_Z_SHIFT = 3;
const TRUNK_SHIFT = 6;
const PRESENCE_SHIFT = 14;
const SPECIES_SHIFT = 22;

/** 一段 8 位的随机数，取值 0–255。 */
const ROLL_MASK = 0xff;

/** 随机数小于这个数，这一格就长树。64/256 = 25%，一个区块 4 个树格，平均约一棵。 */
const TREE_CHANCE = 64;

/** 平原的树里，树种那段随机数小于这个数的是白桦：77/256 ≈ 30%（GLOSSARY.md「树」约三成）。 */
const BIRCH_CHANCE = 77;

/**
 * 冰雪的落点里，树种那段随机数小于这个数的才长树：128/256 = 50%。冰雪零散长云杉（GLOSSARY.md「树」）。
 * 三个种子的大范围采样（按区块中心那一列的群系归类）：每个区块平均冰雪约 0.45 棵、平原约 0.9 棵、
 * 高山雪线以下约 0.75 棵（陡坡露石头的列不长）。
 */
const SNOWY_TREE_CHANCE = 128;

/** 树冠的一层：`dy` 相对最上面那格原木。 */
interface CanopyLayer {
  readonly dy: number;
  readonly radius: number;
  /** 这一层保不保留四角。半径 0 的那层只有一格，没有四角可去。 */
  readonly corners: boolean;
}

/**
 * 橡树与白桦的树冠，自下而上。
 *
 * 原版式橡树冠：最宽的两层是 5×5 去掉四角，树干顶那一层是完整的 3×3，
 * 最上面一层是 3×3 去掉四角的十字。
 */
const OAK_CANOPY_LAYERS: readonly CanopyLayer[] = [
  { dy: -2, radius: OAK_CANOPY_RADIUS, corners: false },
  { dy: -1, radius: OAK_CANOPY_RADIUS, corners: false },
  { dy: 0, radius: 1, corners: true },
  { dy: 1, radius: 1, corners: false },
];

/**
 * 云杉的尖塔形树冠，自下而上，共 7 层（ADR-0005 补记）。
 *
 * 最下面一层 7×7 去掉四角，往上半径按 2、1、2、1 交替，树干顶那一层是 3×3 去掉四角的十字，
 * 树干顶之上再放一格树叶。半径交替变化与原版云杉一致：从侧面看是分层的，不是平滑的锥面。
 */
const SPRUCE_CANOPY_LAYERS: readonly CanopyLayer[] = [
  { dy: -5, radius: SPRUCE_CANOPY_RADIUS, corners: false },
  { dy: -4, radius: 2, corners: false },
  { dy: -3, radius: 1, corners: true },
  { dy: -2, radius: 2, corners: false },
  { dy: -1, radius: 1, corners: true },
  { dy: 0, radius: 1, corners: false },
  { dy: 1, radius: 0, corners: true },
];

/** 一种树的原木、树叶、树干高度范围与树冠形状。 */
interface TreeForm {
  readonly log: BlockType;
  readonly leaves: BlockType;
  readonly trunkMin: number;
  readonly trunkMax: number;
  readonly canopyRadius: number;
  readonly canopy: readonly CanopyLayer[];
}

const OAK_FORM: TreeForm = {
  log: BlockType.OakLog,
  leaves: BlockType.OakLeaves,
  trunkMin: OAK_TRUNK_MIN,
  trunkMax: OAK_TRUNK_MAX,
  canopyRadius: OAK_CANOPY_RADIUS,
  canopy: OAK_CANOPY_LAYERS,
};

/** 白桦与橡树同形（GLOSSARY.md「树」），只换原木与树叶。 */
const TREE_FORMS: Readonly<Record<TreeSpecies, TreeForm>> = {
  [TreeSpecies.Oak]: OAK_FORM,
  [TreeSpecies.Birch]: { ...OAK_FORM, log: BlockType.BirchLog, leaves: BlockType.BirchLeaves },
  [TreeSpecies.Spruce]: {
    log: BlockType.SpruceLog,
    leaves: BlockType.SpruceLeaves,
    trunkMin: SPRUCE_TRUNK_MIN,
    trunkMax: SPRUCE_TRUNK_MAX,
    canopyRadius: SPRUCE_CANOPY_RADIUS,
    canopy: SPRUCE_CANOPY_LAYERS,
  },
};

/**
 * 判断「挨得够不够开」时要看的邻格。
 *
 * 最小间距只可能被紧邻的 8 个树格破坏：再远的格子隔着一整个树格，两棵树必然够远
 * （TREE_CELL_SIZE 大于最大的间距 2 × MAX_CANOPY_RADIUS + 1）。这里只取字典序在本格之前的那 4 个，
 * 于是哪一棵使另一棵不长有固定的先后，不会两棵树都使对方不长、最后一棵都不长。
 *
 * 因此不长的那一棵仍然参与判断：它自己不长了，仍使字典序在它之后、离它太近的树不长。这么做是为了
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
  return worldCoord >> TREE_CELL_SHIFT;
}

/** 某个树格里的落点：树干那一列、那一列的群系、这一格的哈希，与这里长的树种的树冠半径。 */
interface Site {
  readonly x: number;
  readonly z: number;
  readonly biome: Biome;
  readonly roll: number;
  readonly canopyRadius: number;
}

/**
 * 某个树格里的落点。这一格不长树、落点在出生列周围、落点是大海，或者落点在冰雪里而树种那段随机数不在长树的范围内，
 * 则 undefined，它也不会使邻格的树不长。
 *
 * 只问种子、出生列与群系，不另问地表高度：判断两棵树是否相距足够只看水平距离与树冠半径。树冠半径由群系定：
 * 平原长橡树与白桦，高山与冰雪长云杉。群系在多数陆地列上要读地表高度（#87 温度随高度下降，见 `terrain.ts` 的
 * `biomeAt`）：区块生成按列缓存区块四周几列的群系，密度场缓存扫过的列，邻格检查与随后求树根高度不重复扫描同一列。
 */
function siteInCell(placement: TreePlacement, cellX: number, cellZ: number): Site | undefined {
  const roll = hashCoords(placement.seed ^ TREE_SALT, cellX, cellZ);
  if (((roll >>> PRESENCE_SHIFT) & ROLL_MASK) >= TREE_CHANCE) return undefined;

  const x = cellX * TREE_CELL_SIZE + ((roll >>> SLOT_X_SHIFT) & TREE_CELL_MASK);
  const z = cellZ * TREE_CELL_SIZE + ((roll >>> SLOT_Z_SHIFT) & TREE_CELL_MASK);
  const spawn = placement.spawnColumn;
  if (Math.max(Math.abs(x - spawn.x), Math.abs(z - spawn.z)) <= TREE_SPAWN_CLEARANCE) return undefined;

  // 大海里不长树（父 spec #72）：岸边的大海列叠上起伏会露出海面，只看地表高度排除不了。
  const biome = placement.biomeAt(x, z);
  if (biome === Biome.Ocean) return undefined;
  // 冰雪只留一部分落点。冰雪不长白桦，树种那段随机数在这里另作他用。
  if (biome === Biome.Snowy && ((roll >>> SPECIES_SHIFT) & ROLL_MASK) >= SNOWY_TREE_CHANCE) return undefined;
  const canopyRadius = TREE_FORMS[biome === Biome.Plains ? TreeSpecies.Oak : TreeSpecies.Spruce].canopyRadius;
  return { x, z, biome, roll, canopyRadius };
}

/** 落点上长哪种树：平原约三成白桦、其余橡树，高山与冰雪是云杉。 */
function speciesAt(site: Site): TreeSpecies {
  if (site.biome !== Biome.Plains) return TreeSpecies.Spruce;
  return ((site.roll >>> SPECIES_SHIFT) & ROLL_MASK) < BIRCH_CHANCE ? TreeSpecies.Birch : TreeSpecies.Oak;
}

/**
 * 某个树格里的树。这一格没有落点、树给邻格让了位、落点的地表不高于海平面、落点是高山雪线以上，或者落点的
 * 列顶地表方块不是草方块与雪草方块，则 undefined。
 */
function treeInCell(placement: TreePlacement, cellX: number, cellZ: number): Tree | undefined {
  const site = siteInCell(placement, cellX, cellZ);
  if (!site) return undefined;

  // 两棵树的最小间距取两个树冠相邻而不重叠的那个距离（切比雪夫距离）：再近一格两个树冠就有重叠的格，
  // 原版放树也会检查落点的空间。云杉与橡树相邻时按各自的半径算。
  for (const [dx, dz] of EARLIER_CELLS) {
    const earlier = siteInCell(placement, cellX + dx, cellZ + dz);
    if (!earlier) continue;
    const distance = Math.max(Math.abs(earlier.x - site.x), Math.abs(earlier.z - site.z));
    if (distance <= earlier.canopyRadius + site.canopyRadius) return undefined;
  }

  // 地表不高于海平面的列不长：低于海平面的上面是水，正好在海平面的是水边那一圈。
  const surface = placement.surfaceHeightAt(site.x, site.z);
  if (surface <= SEA_LEVEL) return undefined;
  // 高山雪线以上不长（GLOSSARY.md「雪线」）：那里的列顶是雪草方块，只看列顶地表方块排除不了。
  if (site.biome === Biome.Mountains && surface >= SNOW_LINE_Y) return undefined;
  // 只长在草方块与雪草方块上（#76）：沙滩是沙子，陡坡与石头岸是石头，这些列都不长。
  if (!TREE_GROUND.has(placement.surfaceBlockAt(site.x, site.z))) return undefined;

  const species = speciesAt(site);
  const { trunkMin, trunkMax } = TREE_FORMS[species];
  const trunkHeight = trunkMin + (((site.roll >>> TRUNK_SHIFT) & ROLL_MASK) % (trunkMax - trunkMin + 1));
  return { x: site.x, z: site.z, rootY: surface + 1, trunkHeight, species };
}

/** 这棵树的树冠有没有伸进以 (originX, originZ) 为角的那个区块。 */
function reachesChunk(tree: Tree, originX: number, originZ: number): boolean {
  const radius = TREE_FORMS[tree.species].canopyRadius;
  const reaches = (coord: number, origin: number): boolean =>
    coord + radius >= origin && coord - radius < origin + CHUNK_SIZE;
  return reaches(tree.x, originX) && reaches(tree.z, originZ);
}

/**
 * 会写进某个区块的全部树（三种），按写入顺序排好。
 *
 * 树根可能在邻近区块里：树冠越过边界时两边的区块各写自己那一半，合起来才是一棵完整的
 * 树。所以扫的是「最宽的树冠还能伸进这个区块」的那一圈树格，而不只是区块自己范围内的那几格。
 * 每个区块各算一遍、只写自己的格子，结果因此与加载顺序无关，见 ADR-0005。
 *
 * 顺序按树格坐标从小到大，在任何区块里都一样——两棵树写同一格时谁覆盖谁因此是确定的。
 */
export function treesTouching(placement: TreePlacement, cx: number, cz: number): Tree[] {
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const trees: Tree[] = [];
  const lastCellZ = cellOf(originZ + CHUNK_SIZE - 1 + MAX_CANOPY_RADIUS);
  const lastCellX = cellOf(originX + CHUNK_SIZE - 1 + MAX_CANOPY_RADIUS);
  for (let cellZ = cellOf(originZ - MAX_CANOPY_RADIUS); cellZ <= lastCellZ; cellZ++) {
    for (let cellX = cellOf(originX - MAX_CANOPY_RADIUS); cellX <= lastCellX; cellX++) {
      const tree = treeInCell(placement, cellX, cellZ);
      if (tree && reachesChunk(tree, originX, originZ)) trees.push(tree);
    }
  }
  return trees;
}

/**
 * 把会写进这个区块的树种下去。
 *
 * 要在土石铺好之后调：树叶只往空气里长，得先有地面才知道哪里是空气。
 */
export function plantTrees(placement: TreePlacement, chunk: Chunk): void {
  for (const tree of treesTouching(placement, chunk.cx, chunk.cz)) plantTree(chunk, tree);
}

/**
 * 把一棵树落在这个区块里的部分写进去。落在区块外的格子由 `Chunk` 丢弃，那部分由邻居区块写。
 *
 * 先树冠后树干：两者在树干顶端那几格重叠，原木覆盖树叶。
 */
export function plantTree(chunk: Chunk, tree: Tree): void {
  const lx = tree.x - chunk.cx * CHUNK_SIZE;
  const lz = tree.z - chunk.cz * CHUNK_SIZE;
  const form = TREE_FORMS[tree.species];
  plantCanopy(chunk, tree, form, lx, lz);
  chunk.fillColumn(lx, lz, tree.rootY, trunkTopY(tree), form.log);
}

/** 把树冠写进区块，(lx, lz) 是树干在这个区块里的局部坐标。 */
function plantCanopy(chunk: Chunk, tree: Tree, form: TreeForm, lx: number, lz: number): void {
  const top = trunkTopY(tree);
  for (const { dy, radius, corners } of form.canopy) {
    const y = top + dy;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!corners && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
        // 只往空气里长，不替换掉已经在那儿的方块。树冠底面只比自己那一列的地表高两格，三维密度
        // 地形（#75）的平原有起伏、山坡更陡，两格外的地面常常高过它，替换掉就是地上一个洞。
        if (chunk.get(lx + dx, y, lz + dz) !== BlockType.Air) continue;
        chunk.set(lx + dx, y, lz + dz, form.leaves);
      }
    }
  }
}
