import { isAir, type BlockView } from './block';
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
