import { isAir, type BlockView } from './block';
import type { Hitbox } from './physics';
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
 * 体素射线检测：从 `origin` 沿 `direction` 走最远 `maxDistance` 格，返回第一个非空气方块。
 *
 * 走的是 Amanatides–Woo：只在三个轴的格边界上推进，逐格命中。按固定小步长采样的做法
 * 换不来这条保证——斜着看时它会从两个方块的公共角穿过去，准星明明压在方块上却挖不到。
 *
 * `direction` 必须是单位向量，`distance` 与 `maxDistance` 才是真实距离。方向为零向量时
 * 没有命中。
 *
 * 起点那一格本身不是候选：眼睛埋在方块里时没有「进入面」可报，继续往前走又会命中墙后面
 * 的方块，所以直接判为没有目标。当前的方块种类下这不会发生——除空气之外都是实心的，
 * 玩家进不去。
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
  if (!isAir(blocks.getBlock(at.x, at.y, at.z))) return undefined;

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

  for (;;) {
    // 三个轴里哪条边界最近，就沿它跨一格。
    const axis = nearestAxis(toBoundary);
    const distance = toBoundary[axis];
    // 写成「不满足」而不是 `distance > maxDistance`：零方向向量时距离是 Infinity，
    // 这样也一并落到「没有目标」上。
    if (!(distance <= maxDistance)) return undefined;

    at[axis] += step[axis];
    toBoundary[axis] += perBlock[axis];
    if (isAir(blocks.getBlock(at.x, at.y, at.z))) continue;
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
  let near = 0;
  let far = maxDistance;
  for (const axis of AXES) {
    const o = origin[axis];
    const d = direction[axis];
    const min = box.min[axis];
    const max = box.max[axis];
    if (d === 0) {
      if (o < min || o > max) return undefined;
      continue;
    }
    const enter = (min - o) / d;
    const exit = (max - o) / d;
    near = Math.max(near, Math.min(enter, exit));
    far = Math.min(far, Math.max(enter, exit));
    if (near > far) return undefined;
  }
  return near;
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
