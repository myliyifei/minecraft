import { isSolid, type BlockType, type BlockView } from './block';
import type { Axis, Vec3 } from './vec3';

/**
 * 实体物理：重力、竖直阻力，以及碰撞箱与方块的碰撞解算。
 *
 * 玩家、掉落物与僵尸共用这一份——都是「一个碰撞箱在方块世界里下落并被挡住」，
 * 各写一份扫掠就会各有一套边界容差，其中一份迟早算错。谁跑得多快、跳多高这类
 * 各自的移动参数留在各自的模块里。
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

/** 一格方块占的空间。放置要拿它跟玩家的碰撞箱比。 */
export function blockHitbox(x: number, y: number, z: number): Hitbox {
  return { min: { x, y, z }, max: { x: x + 1, y: y + 1, z: z + 1 } };
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
 * 落地高度与跳跃高度就会出现细微差异，而这种差异只有专门比对数值时才看得出来。
 */
export function fallStep(blocks: BlockView, hitbox: Hitbox, velocityY: number): Fall {
  const target = hitbox.min.y + velocityY;
  const y = movedAlong(blocks, hitbox, 'y', velocityY);
  const blocked = y !== target;
  return { y, velocityY: ((blocked ? 0 : velocityY) - GRAVITY) * VERTICAL_DRAG };
}

/**
 * 摔落的落差：离地之后到过的最高 y，落地那一 tick 拿它减去落点。
 *
 * 玩家与僵尸共用这一份，摔落伤害因此是同一条规则：落差怎么算写在一处，受几点伤由调用方按
 * `fallDamage` 算。跳起来的那一段也算在内。
 */
export class FallTracker {
  /** 离地之后到过的最高 y。站在地上时就是脚下的高度。 */
  private highest: number;

  constructor(y: number) {
    this.highest = y;
  }

  /** 离地之后到过的最高 y。快照存它，读档后用 `reset` 放回。 */
  get highestY(): number {
    return this.highest;
  }

  /** 从 y 重新算起：重生这类瞬移之后调，瞬移之前的高度不算进落差。读档时传快照里的最高点。 */
  reset(y: number): void {
    this.highest = y;
  }

  /**
   * 竖直走完一步之后调：y 是新的高度，onGround 是此刻踩实了没有。返回这一步落地时的落差，
   * 没有落地、或者一直站在地上，返回 0。
   *
   * 落点不会高于最高点：落到哪一格顶面之前，碰撞箱一定先在那个高度之上待过一 tick。
   */
  settle(y: number, onGround: boolean): number {
    if (!onGround) {
      this.highest = Math.max(this.highest, y);
      return 0;
    }
    const fell = this.highest - y;
    this.highest = y;
    return fell;
  }
}

/**
 * 沿一个轴移动 `delta` 会不会被实心方块挡住，哪怕只挡住一部分。
 *
 * 与 `movedAlong` 同一次扫掠，只是问的是「走没走满」：落点由扫掠钳在方块边界上，没被挡时
 * 正好等于起点加 `delta`，所以这里可以精确比较，不需要容差。僵尸据此决定要不要起跳。
 */
export function isBlockedAlong(
  blocks: BlockView,
  hitbox: Hitbox,
  axis: Axis,
  delta: number,
): boolean {
  return sweep(blocks, hitbox, axis, delta) !== hitbox.min[axis] + delta;
}

/**
 * 实体抬高 rise 格之后，沿一个轴走 delta 还会不会被挡：不会就说明挡住它的东西顶面不高于脚底加 rise。
 * position 是实体坐标（碰撞箱底面中心），抬高后的碰撞箱按 width、height 重新算。
 *
 * 僵尸据此判断挡在前面的是不是一格高的台阶、要不要起跳（rise 为 1），玩家据此判断在水里挡住它的岸爬不爬得上去
 * （`WATER_CLIMB_HEIGHT`）。#78 的自动跳跃判断「一格高的台阶」也用这一个。
 */
export function clearsAfterRising(
  blocks: BlockView,
  position: Vec3,
  width: number,
  height: number,
  rise: number,
  axis: Axis,
  delta: number,
): boolean {
  const raised = hitboxAt({ x: position.x, y: position.y + rise, z: position.z }, width, height);
  return !isBlockedAlong(blocks, raised, axis, delta);
}

/**
 * 碰撞箱与某一类方块重叠出体积：覆盖到的方块里有一格满足 matches 就算。贴着面不算，取边界的容差与碰撞扫掠相同
 * （`firstBlock`、`lastBlock`）。玩家判断在不在水里用它。
 */
export function overlapsBlock(
  blocks: BlockView,
  { min, max }: Hitbox,
  matches: (block: BlockType) => boolean,
): boolean {
  for (let x = firstBlock(min.x); x <= lastBlock(max.x); x++) {
    for (let y = firstBlock(min.y); y <= lastBlock(max.y); y++) {
      for (let z = firstBlock(min.z); z <= lastBlock(max.z); z++) {
        if (matches(blocks.getBlock(x, y, z))) return true;
      }
    }
  }
  return false;
}

/** 一 tick 的水平位移（方块）。玩家与僵尸的移动都先算出它，再逐轴做碰撞。 */
export interface HorizontalDelta {
  readonly x: number;
  readonly z: number;
}

/** 原地不动的水平位移。 */
export const NO_WALK: HorizontalDelta = Object.freeze({ x: 0, z: 0 });

/** 受击时获得的水平速度（方块/tick），方向由攻击者指向受击者。 */
export const KNOCKBACK_SPEED = 0.4;

/** 受击时获得的竖直速度（方块/tick）：带一点上抛。不到跳跃初速 0.42，落回来不受摔落伤害。 */
export const KNOCKBACK_LIFT = 0.4;

/** 击退的水平速度每 tick 保留的比例。0.4 格/tick 起，一共推出去约 1 格。 */
export const KNOCKBACK_DECAY = 0.6;

/**
 * 击退的水平速度低于这个值（方块/tick）直接归零。理由同掉落物的 `MIN_SPEED`：指数衰减本身到不了零，
 * 不截断的话受过一次击的实体会一直以肉眼看不见的速度被推着走。
 */
const KNOCKBACK_MIN_SPEED = 1e-3;

/**
 * 击退（见 CONTEXT.md）：attacker 打到 target 时 target 获得的水平速度，指向「攻击者到受击者」的
 * 水平方向，大小 `KNOCKBACK_SPEED`。两者水平位置重合时没有方向，不推。竖直那一下（`KNOCKBACK_LIFT`）
 * 由受击者自己写进竖直速度。
 *
 * 僵尸受玩家攻击与玩家受僵尸攻击（#43）共用这一条。
 */
export function knockbackFrom(attacker: Vec3, target: Vec3): HorizontalDelta {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return NO_WALK;
  return { x: (dx / length) * KNOCKBACK_SPEED, z: (dz / length) * KNOCKBACK_SPEED };
}

/** 击退速度过了一 tick 之后：乘 `KNOCKBACK_DECAY`，小到看不出来就归零。 */
export function decayedKnockback(knock: HorizontalDelta): HorizontalDelta {
  if (knock === NO_WALK) return NO_WALK;
  const x = knock.x * KNOCKBACK_DECAY;
  const z = knock.z * KNOCKBACK_DECAY;
  return Math.hypot(x, z) < KNOCKBACK_MIN_SPEED ? NO_WALK : { x, z };
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

/**
 * 两个碰撞箱有没有交叠出体积。边界相切不算。
 *
 * 放置要的是这一个：紧贴玩家侧面的那一格放得下（原版也放得下），相切也算的话贴着墙
 * 站着就放不了脚边那一块。「碰上了没有」那种判断用下面的 `touches`。
 */
export function overlaps(a: Hitbox, b: Hitbox): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

/**
 * 两个碰撞箱碰上了没有。边界相切算碰上——差一丝就判成没碰上反而更奇怪。
 *
 * 拾取与吸收要的是这一个：走到掉落物边上就该收得到。与 `overlaps` 只差相切这一种情形。
 */
export function touches(a: Hitbox, b: Hitbox): boolean {
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
