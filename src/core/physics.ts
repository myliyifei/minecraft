import { isSolid, type BlockView } from './block';
import type { Axis, Vec3 } from './vec3';

/**
 * 实体物理：重力、竖直阻力，以及碰撞箱与方块的碰撞解算。
 *
 * 玩家与掉落物共用这一份——两者都是「一个碰撞箱在方块世界里下落并被挡住」，
 * 各写一份扫掠就会各有一套边界容差，其中一份迟早算错。谁跑得多快、跳多高这类
 * 各自的手感留在各自的模块里。
 */

/** 重力加速度（方块/tick²）。 */
export const GRAVITY = 0.08;

/**
 * 竖直速度每 tick 保留的比例。
 * 它让自由落体收敛到约 3.92 方块/tick（≈78 方块/秒）而不是一路加速下去。
 */
export const VERTICAL_DRAG = 0.98;

/** 世界坐标中的一个轴对齐碰撞箱。 */
export interface Hitbox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * 贴地探测的深度（方块）。
 * 只用来问「脚下踩实了没有」，取值远小于一 tick 的位移，也远大于浮点误差。
 */
const GROUND_PROBE = 1e-4;

/**
 * 实体坐标（碰撞箱底面中心）对应的碰撞箱。
 * 水平截面是正方形，`width` 是它的边长。
 */
export function hitboxAt(
  { x, y, z }: Vec3,
  width: number,
  height: number,
): Hitbox {
  const half = width / 2;
  return {
    min: { x: x - half, y, z: z - half },
    max: { x: x + half, y: y + height, z: z + half },
  };
}

/**
 * 沿一个轴移动之后实体在这个轴上的新坐标，撞上实心方块则停在接触面上。
 *
 * 扫掠算出来的是碰撞箱 min 端的落点。实体坐标是底面中心，所以竖直方向那就是结果本身，
 * 水平方向要把半宽加回来。
 */
export function movedAlong(
  blocks: BlockView,
  hitbox: Hitbox,
  axis: Axis,
  delta: number,
): number {
  const stopped = sweep(blocks, hitbox, axis, delta);
  if (axis === 'y') return stopped;
  return stopped + (hitbox.max[axis] - hitbox.min[axis]) / 2;
}

/**
 * 碰撞箱紧贴着下方的实心方块。
 * 往下探一丝走不动就算站住了——这样它是个当下的判断，不依赖上一个 tick 碰没碰到东西。
 */
export function isOnGround(blocks: BlockView, hitbox: Hitbox): boolean {
  return sweep(blocks, hitbox, 'y', -GROUND_PROBE) === hitbox.min.y;
}

/** 竖直走一步之后的高度与速度。 */
export interface Fall {
  /** 实体新的 y（碰撞箱底面）。 */
  readonly y: number;
  readonly velocityY: number;
}

/**
 * 重力下落一步：先按当前速度移动，撞上东西就把速度清零，再加一个 tick 的重力与阻力。
 *
 * 「先移动再更新速度」的顺序与原版一致，玩家跳跃的最高点（1.252 方块）就是它定出来的。
 * 玩家与掉落物共用这一份，而不是各写一遍那四行：两边一旦一个先加速度一个后加，
 * 落地高度与跳跃手感就会出现细微差异，而这种差异只有专门比对数值时才看得出来。
 */
export function fallStep(blocks: BlockView, hitbox: Hitbox, velocityY: number): Fall {
  const target = hitbox.min.y + velocityY;
  const y = movedAlong(blocks, hitbox, 'y', velocityY);
  const blocked = y !== target;
  return { y, velocityY: ((blocked ? 0 : velocityY) - GRAVITY) * VERTICAL_DRAG };
}

/** 碰撞箱各方向外扩 margin 格。 */
export function expand(box: Hitbox, margin: number): Hitbox {
  return {
    min: { x: box.min.x - margin, y: box.min.y - margin, z: box.min.z - margin },
    max: { x: box.max.x + margin, y: box.max.y + margin, z: box.max.z + margin },
  };
}

/** 碰撞箱的中心。朝一个实体飞过去时瞄的是这里，而不是它脚底。 */
export function boxCenter(box: Hitbox): Vec3 {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

/** 两个碰撞箱有没有交叠。边界相切算交叠——差一丝就判成没碰上反而更奇怪。 */
export function overlaps(a: Hitbox, b: Hitbox): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

/** 除某个轴之外的另两个轴。 */
const OTHER_AXES: Readonly<Record<Axis, readonly [Axis, Axis]>> = {
  x: ['y', 'z'],
  y: ['x', 'z'],
  z: ['x', 'y'],
};

/**
 * 单轴扫掠：碰撞箱沿 `axis` 移动 `delta` 之后，这个轴上箱 min 端落在哪里。
 *
 * 只动一个轴时，扫掠体正好是「起点箱到终点箱」的外接箱，所以沿移动轴逐个方块扫一遍
 * 就够，速度再快也不会穿过方块——自由落体的终端速度接近 4 方块/tick。
 *
 * 撞上方块时返回的是方块边界本身而不是累加出来的位移，因此落地高度是精确的整数。
 */
export function sweep(blocks: BlockView, hitbox: Hitbox, axis: Axis, delta: number): number {
  const min = hitbox.min[axis];
  if (delta === 0) return min;

  const max = hitbox.max[axis];
  const target = min + delta;
  const from = delta > 0 ? min : target;
  const to = delta > 0 ? max + delta : max;

  let limit = target;
  for (let at = firstBlock(from); at <= lastBlock(to); at++) {
    if (!blockedAt(blocks, hitbox, axis, at)) continue;
    limit =
      delta > 0
        ? Math.min(limit, at - (max - min)) // 箱的 max 端顶在这个方块的下边界上
        : Math.max(limit, at + 1); //         箱的 min 端落在这个方块的上边界上
  }

  // 碰撞箱已经卡在方块里时（比如有方块被放进玩家所在的位置），上面的钳位会算出反向
  // 位移。夹住方向：宁可不动，也不要把实体往回推。
  return delta > 0 ? Math.max(min, limit) : Math.min(min, limit);
}

/**
 * 移动轴上 `at` 这一层截面里有没有实心方块。
 * 有一块就整层挡住，不必看是哪一块。
 */
function blockedAt(blocks: BlockView, hitbox: Hitbox, axis: Axis, at: number): boolean {
  const [first, second] = OTHER_AXES[axis];
  const probe: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  probe[axis] = at;
  for (let a = firstBlock(hitbox.min[first]); a <= lastBlock(hitbox.max[first]); a++) {
    probe[first] = a;
    for (let b = firstBlock(hitbox.min[second]); b <= lastBlock(hitbox.max[second]); b++) {
      probe[second] = b;
      if (isSolid(blocks.getBlock(probe.x, probe.y, probe.z))) return true;
    }
  }
  return false;
}

/**
 * 碰撞箱某一端覆盖到的第一个 / 最后一个方块坐标。
 * 两个函数都把「边界重合」算作不相交——贴着面站着不算卡在方块里。
 *
 * 这点容差是必需的，不是多加一道保险：钳位落点是算出来的，`(x + 0.3) − (x − 0.3)` 并不总等于
 * 0.6，于是贴住墙面的碰撞箱可能算出比墙面多 1e-16 的坐标（实测约 3% 的位置会这样）。
 * 少了这点容差，那一格就被判成嵌进了墙里，而嵌进方块之后各个方向的扫掠都返回零位移
 * ——玩家永久卡死，走不动也跳不起来。容差远大于那点舍入误差，又远小于一 tick 的位移
 * 与贴地探测深度，所以它只抵消误差，不改变任何看得见的行为。
 */
const TOUCH_EPSILON = 1e-9;

function firstBlock(min: number): number {
  return Math.floor(min + TOUCH_EPSILON);
}

function lastBlock(max: number): number {
  return Math.ceil(max - TOUCH_EPSILON) - 1;
}
