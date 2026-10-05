import { sightPassesThrough, type BlockType, type BlockView } from './block';
import type { Hitbox } from './physics';
import { plantHitbox } from './plant';
import { torchHitbox } from './torch';
import type { Axis, Vec3 } from './vec3';

/** 视线命中的方块。 */
export interface BlockHit {
  /** 方块坐标（整数）。 */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * 命中面的外法线，三个分量里恰有一个是 ±1。
   * 放置方块（#10）时新方块就落在它指的那一格。
   */
  readonly normal: Vec3;
  /** 起点到命中面的距离（方块）。 */
  readonly distance: number;
}

const AXES: readonly Axis[] = ['x', 'y', 'z'];

/**
 * (x, y, z) 那一格视线碰的盒子比整格小时，那个盒子（世界坐标）：火把是细杆（`torchHitbox`），地表植物是比整格小的
 * 方盒（`plantHitbox`，#80）。整格命中的方块是 undefined。选框也套这个盒子（`selectionBounds`）。
 */
export function partialHitbox(block: BlockType, x: number, y: number, z: number): Hitbox | undefined {
  return torchHitbox(block, x, y, z) ?? plantHitbox(block, x, y, z);
}

/**
 * 命中面外侧那一格的方块坐标：射线在撞上目标之前正好经过的那一格。
 *
 * 放置就放在这里（见 CONTEXT.md 的「放置」）。走法只有这一处，射线报出命中面的地方与
 * 用它的地方因此不会各算一遍。
 */
export function blockOutsideFace(hit: BlockHit): Vec3 {
  return {
    x: hit.x + hit.normal.x,
    y: hit.y + hit.normal.y,
    z: hit.z + hit.normal.z,
  };
}

/**
 * 体素射线检测：从 `origin` 沿 `direction` 走最远 `maxDistance` 格，返回第一个视线不穿过的方块
 * （`sightPassesThrough`：空气与水穿过，#74）。
 *
 * 走的是 Amanatides–Woo：只在三个轴的格边界上推进，逐格命中。按固定小步长采样的做法
 * 换不来这条保证——斜着看时它会从两个方块的公共角穿过去，准星明明压在方块上却挖不到。
 *
 * `direction` 必须是单位向量，`distance` 与 `maxDistance` 才是真实距离。方向为零向量时
 * 没有命中。
 *
 * 火把（#56）与地表植物（#80）那一格不是整格命中：射线与那一格比整格小的盒子求交（`partialHitbox`），碰到才算
 * 命中这一格，命中面取盒子被碰到的那一面；碰不到就穿过这一格接着走。挖掘、使用、放置、攻击分派都走这一条。
 *
 * 起点那一格本身不是整格候选：眼睛埋在方块里时没有「进入面」可报，继续往前走又会命中墙后面
 * 的方块，所以直接判为没有目标。玩家进得去的格子里视线照常往前走：起点是空气或水（眼睛在水里，#74）
 * 时与别处一样；起点是火把或植物那一格时照样与盒子求交，碰不到（含眼睛就在盒子里面）就接着往前走。
 */
export function raycastBlocks(
  blocks: BlockView,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): BlockHit | undefined {
  const at: Record<Axis, number> = {
    x: Math.floor(origin.x),
    y: Math.floor(origin.y),
    z: Math.floor(origin.z),
  };
  const start = blocks.getBlock(at.x, at.y, at.z);
  if (!sightPassesThrough(start) && !partialHitbox(start, at.x, at.y, at.z)) return undefined;

  /** 沿这个轴每次跨一格，坐标加多少。 */
  const step: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  /** 沿这个轴跨一格，距离增加多少。方向分量为 0 的轴是 Infinity，永远轮不到它。 */
  const perBlock: Record<Axis, number> = { x: Infinity, y: Infinity, z: Infinity };
  /** 到这个轴上下一条格边界的距离。 */
  const toBoundary: Record<Axis, number> = { x: Infinity, y: Infinity, z: Infinity };
  for (const axis of AXES) {
    const d = direction[axis];
    if (d === 0) continue;
    const speed = Math.abs(d);
    step[axis] = d > 0 ? 1 : -1;
    perBlock[axis] = 1 / speed;
    // 正向看的是这一格的上边界，反向看的是下边界。
    const gap = d > 0 ? at[axis] + 1 - origin[axis] : origin[axis] - at[axis];
    toBoundary[axis] = gap / speed;
  }

  // 起点在火把或植物那一格里：先看这一格的盒子挡不挡视线。
  const startHit = partialCellHit(start, at.x, at.y, at.z, origin, direction, maxDistance);
  if (startHit) return startHit;

  for (;;) {
    // 三个轴里哪条边界最近，就沿它跨一格。
    const axis = nearestAxis(toBoundary);
    const distance = toBoundary[axis];
    // 写成「不满足」而不是 `distance > maxDistance`：零方向向量时距离是 Infinity，
    // 这样也一并落到「没有目标」上。
    if (!(distance <= maxDistance)) return undefined;

    at[axis] += step[axis];
    toBoundary[axis] += perBlock[axis];
    const block = blocks.getBlock(at.x, at.y, at.z);
    if (sightPassesThrough(block)) continue;
    const box = partialHitbox(block, at.x, at.y, at.z);
    if (box) {
      const hit = boxHit(box, at.x, at.y, at.z, origin, direction, maxDistance);
      if (hit) return hit;
      continue;
    }
    return {
      x: at.x,
      y: at.y,
      z: at.z,
      // 沿 +x 进入一个方块，进的是它的 −X 面。
      normal: axisNormal(axis, -step[axis]),
      distance,
    };
  }
}

/**
 * 射线碰到 (x, y, z) 那一格比整格小的盒子（`partialHitbox`）就是命中这一格：坐标是这一格，命中面是盒子被碰到的那一面。
 * 那一格是整格命中的方块、碰不到、或者起点就在盒子里面（报不出进入面）时 undefined。
 */
function partialCellHit(
  block: BlockType,
  x: number,
  y: number,
  z: number,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): BlockHit | undefined {
  const box = partialHitbox(block, x, y, z);
  return box && boxHit(box, x, y, z, origin, direction, maxDistance);
}

/** 射线碰到 (x, y, z) 那一格的盒子 box 时的命中，碰不到或起点在盒子里面时 undefined。 */
function boxHit(
  box: Hitbox,
  x: number,
  y: number,
  z: number,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): BlockHit | undefined {
  const entry = boxEntry(origin, direction, box, maxDistance);
  if (!entry || entry.axis === undefined) return undefined;
  return {
    x,
    y,
    z,
    // 沿 +x 碰到盒子，碰的是它的 −X 面。
    normal: axisNormal(entry.axis, direction[entry.axis] > 0 ? -1 : 1),
    distance: entry.distance,
  };
}

/**
 * 视线命中的实体：哪一只、从起点到它碰撞箱的距离。
 */
export interface EntityHit {
  /** 实体的编号（见 `ZombieView.id`）。 */
  readonly id: number;
  /** 起点到碰撞箱表面的距离（方块）。起点在碰撞箱里面时是 0。 */
  readonly distance: number;
}

/**
 * 一批实体里视线最先碰到的那一只。
 *
 * 挖掘依赖它而不是僵尸集合本身：挖掘只要知道「视线在碰到方块之前有没有先碰到实体」，
 * 攻击还要知道碰到的是哪一只。将来的生物各自实现它，或合成一份。
 */
export interface EntityRaycast {
  /** 从 origin 沿 direction 走最远 maxDistance 格（含），最先碰到的实体。一只都没碰到时 undefined。 */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): EntityHit | undefined;
}

/**
 * 射线与一个轴对齐碰撞箱求交：从 `origin` 沿 `direction` 走最远 `maxDistance` 格（含）碰得到它的话，
 * 返回碰到的距离，碰不到返回 undefined。起点在碰撞箱里面（含贴在表面上）时返回 0。
 *
 * 走的是分轴求区间（slab）：每个轴上算出射线在两块边界面之间的那一段，三段的交集非空就碰得到，
 * 交集的起点就是距离。方向分量为 0 的轴上射线与边界面平行，起点落在两面之间才可能碰到。
 * `direction` 与 `raycastBlocks` 一样要是单位向量，距离才是真实距离。
 */
export function raycastBox(
  origin: Vec3,
  direction: Vec3,
  box: Hitbox,
  maxDistance: number,
): number | undefined {
  return boxEntry(origin, direction, box, maxDistance)?.distance;
}

/** 射线进入一个碰撞箱的距离，以及从哪个轴的边界面进去的。起点在箱子里面（含贴在表面上）时轴是 undefined。 */
interface BoxEntry {
  readonly distance: number;
  readonly axis: Axis | undefined;
}

/** `raycastBox` 的算法本身，多报一个进入面所在的轴：火把与植物的命中面要它（`boxHit`）。 */
function boxEntry(origin: Vec3, direction: Vec3, box: Hitbox, maxDistance: number): BoxEntry | undefined {
  let near = 0;
  let far = maxDistance;
  let entered: Axis | undefined;
  for (const axis of AXES) {
    const o = origin[axis];
    const d = direction[axis];
    const min = box.min[axis];
    const max = box.max[axis];
    if (d === 0) {
      if (o < min || o > max) return undefined;
      continue;
    }
    const enter = Math.min((min - o) / d, (max - o) / d);
    const exit = Math.max((min - o) / d, (max - o) / d);
    if (enter > near) {
      near = enter;
      entered = axis;
    }
    far = Math.min(far, exit);
    if (near > far) return undefined;
  }
  return { distance: near, axis: entered };
}

function nearestAxis(toBoundary: Record<Axis, number>): Axis {
  if (toBoundary.x <= toBoundary.y && toBoundary.x <= toBoundary.z) return 'x';
  return toBoundary.y <= toBoundary.z ? 'y' : 'z';
}

function axisNormal(axis: Axis, sign: number): Vec3 {
  return {
    x: axis === 'x' ? sign : 0,
    y: axis === 'y' ? sign : 0,
    z: axis === 'z' ? sign : 0,
  };
}
