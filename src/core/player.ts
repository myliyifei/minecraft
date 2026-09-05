import { isSolid, type BlockView } from './block';
import { TICK_RATE } from './constants';
import type { Vec3 } from './vec3';

/** 碰撞箱的水平边长（方块）。 */
export const PLAYER_WIDTH = 0.6;

/** 碰撞箱的高度（方块）。 */
export const PLAYER_HEIGHT = 1.8;

/** 眼睛相对脚底的高度（方块）。第一人称相机放在这里。 */
export const PLAYER_EYE_HEIGHT = 1.62;

/** 步行速度（方块/秒）。与原版一致。疾跑与潜行是后续切片的事。 */
export const WALK_SPEED = 4.317;

/**
 * 俯仰角的上下限（弧度）。
 * 留一点余量而不是取满 90°，视线方向因此不会退化成纯竖直——将来的方块拾取
 * 要拿它当射线方向。
 */
export const MAX_PITCH = Math.PI / 2 - 0.01;

/** 重力加速度（方块/tick²）。 */
export const GRAVITY = 0.08;

/**
 * 竖直速度每 tick 保留的比例。
 * 它让自由落体收敛到约 3.92 方块/tick（≈78 方块/秒）而不是一路加速下去。
 */
export const VERTICAL_DRAG = 0.98;

/**
 * 起跳的竖直初速度（方块/tick）。
 * 与上面的重力、阻力配在一起，最高点落在 1.252 方块：够上一格台阶，够不上两格。
 * 改这三个数中的任何一个都会改变这条手感，`tests/core/player.test.ts` 守着它。
 */
export const JUMP_VELOCITY = 0.42;

const HALF_WIDTH = PLAYER_WIDTH / 2;

/** 一 tick 的步行位移（方块）。 */
const WALK_STEP = WALK_SPEED / TICK_RATE;

/** 一整圈的弧度。 */
const TAU = Math.PI * 2;

/**
 * 贴地探测的深度（方块）。
 * 只用来问「脚下踩实了没有」，取值远小于一 tick 的位移，也远大于浮点误差。
 */
const GROUND_PROBE = 1e-4;

/**
 * 一个 tick 的移动意图。
 * 输入适配器把键盘状态翻译成这个结构，核心不知道任何键位——键位表在 `src/input/`。
 */
export interface MoveIntent {
  readonly forward: boolean;
  readonly back: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly jump: boolean;
}

/** 什么都不按。核心在收到第一份输入之前用它。 */
export const IDLE_INTENT: MoveIntent = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
});

/** 玩家状态的只读视图。渲染层与调试句柄拿到的是这个，改状态只能经由核心的 tick。 */
export interface PlayerView {
  readonly position: Vec3;
  readonly previousPosition: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
}

/**
 * 玩家：位置、速度、视角，以及与方块的碰撞。
 *
 * 纯核心逻辑，只依赖一个 `BlockView`，因此能在 Node 里对任意手工摆出来的地形做断言。
 * 时间只由 `step()` 的调用次数表达（ADR-0002），不读真实时钟。
 */
export class Player implements PlayerView {
  private readonly blocks: BlockView;
  // 位置存成三个数而不是一个 Vec3：逐轴解算碰撞时每次只改一个分量，
  // 存 Vec3 就得每个轴重建一次对象。对外读到的仍然是 Vec3。
  private x: number;
  private y: number;
  private z: number;
  private prevX: number;
  private prevY: number;
  private prevZ: number;
  private velocityY = 0;
  private yawAngle = 0;
  private pitchAngle = 0;

  constructor(blocks: BlockView, spawn: Vec3) {
    this.blocks = blocks;
    this.x = this.prevX = spawn.x;
    this.y = this.prevY = spawn.y;
    this.z = this.prevZ = spawn.z;
  }

  /** 碰撞箱底面中心。y 就是脚底所在的高度。 */
  get position(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }

  /** 上一个 tick 结束时的位置。渲染层在它和当前位置之间插值（ADR-0002）。 */
  get previousPosition(): Vec3 {
    return { x: this.prevX, y: this.prevY, z: this.prevZ };
  }

  /** 水平朝向（弧度）。0 表示看向 −Z，与 Three.js 相机的默认朝向一致。 */
  get yaw(): number {
    return this.yawAngle;
  }

  /** 俯仰（弧度）。正是抬头，负是低头，范围夹在 ±MAX_PITCH。 */
  get pitch(): number {
    return this.pitchAngle;
  }

  /**
   * 脚下紧贴着实心方块。
   * 往下探一丝走不动就算站住了——这样它是个当下的判断，不依赖上一个 tick 碰没碰到东西。
   */
  get onGround(): boolean {
    return this.movedAlong('y', -GROUND_PROBE) === this.y;
  }

  /**
   * 转动视角。
   * 增量由输入适配器按鼠标灵敏度换算成弧度；这里只负责夹住俯仰、折回偏航。
   *
   * 不等 tick，鼠标一动就生效——与 `setMoveIntent` 那条路不同。为什么这样分见
   * ADR-0004（输入的时间性）。
   */
  turn(yawDelta: number, pitchDelta: number): void {
    this.yawAngle = wrapAngle(this.yawAngle + yawDelta);
    this.pitchAngle = clamp(this.pitchAngle + pitchDelta, -MAX_PITCH, MAX_PITCH);
  }

  /** 推进一个 tick。 */
  step(intent: MoveIntent): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    // 只有踩在地上才能起跳，所以按住空格是原地反复起跳，不是二段跳。
    if (intent.jump && this.onGround) this.velocityY = JUMP_VELOCITY;

    // 先按当前速度移动再更新速度，与原版的顺序一致——这个顺序决定了最高点是 1.252 方块。
    const target = this.y + this.velocityY;
    this.y = this.movedAlong('y', this.velocityY);
    if (this.y !== target) this.velocityY = 0;
    this.velocityY = (this.velocityY - GRAVITY) * VERTICAL_DRAG;

    // 竖直走完再走水平：跳到台阶上时这一 tick 已经抬到了台阶顶面之上，
    // 水平方向因此不再被台阶挡住。
    this.moveHorizontally(intent);
  }

  /**
   * 按意图沿视角方向平移一步。
   *
   * 俯仰不参与——抬头看天按 W 仍然是平着走。两个轴分开做碰撞，斜着撞墙时
   * 会沿着墙滑过去，而不是整步作废。
   */
  private moveHorizontally(intent: MoveIntent): void {
    const forward = Number(intent.forward) - Number(intent.back);
    const strafe = Number(intent.right) - Number(intent.left);
    if (forward === 0 && strafe === 0) return;

    // 斜着走不该比直着走快：把意图向量归一化再乘步长。
    const step = WALK_STEP / Math.hypot(forward, strafe);
    const sin = Math.sin(this.yawAngle);
    const cos = Math.cos(this.yawAngle);
    // yaw = 0 时前方是 −Z、右手边是 +X。
    this.x = this.movedAlong('x', (-sin * forward + cos * strafe) * step);
    this.z = this.movedAlong('z', (-cos * forward - sin * strafe) * step);
  }

  /**
   * 沿一个轴移动之后玩家在这个轴上的新坐标，撞上实心方块则停在接触面上。
   *
   * 扫掠算出来的是碰撞箱 min 端的落点：竖直方向那就是脚底高度，水平方向要把半宽
   * 加回来才是玩家坐标。
   */
  private movedAlong(axis: Axis, delta: number): number {
    const stopped = sweep(this.blocks, this.hitbox, axis, delta);
    return axis === 'y' ? stopped : stopped + HALF_WIDTH;
  }

  /** 当前的碰撞箱：0.6 × 1.8 × 0.6，底面中心落在玩家坐标上。 */
  private get hitbox(): Hitbox {
    return {
      min: { x: this.x - HALF_WIDTH, y: this.y, z: this.z - HALF_WIDTH },
      max: { x: this.x + HALF_WIDTH, y: this.y + PLAYER_HEIGHT, z: this.z + HALF_WIDTH },
    };
  }
}

/** 轴向。直接用 Vec3 的字段名，扫掠因此能按名字取分量，不必靠下标约定。 */
type Axis = keyof Vec3;

/** 世界坐标中的一个轴对齐碰撞箱。 */
interface Hitbox {
  readonly min: Vec3;
  readonly max: Vec3;
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
function sweep(blocks: BlockView, hitbox: Hitbox, axis: Axis, delta: number): number {
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
  // 位移。夹住方向：宁可不动，也不要把玩家往回推。
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
 * 容差是必须的，不是保险：钳位落点是算出来的，`(x + 0.3) − (x − 0.3)` 并不总等于
 * 0.6，于是贴住墙面的碰撞箱可能算出比墙面多 1e-16 的坐标（实测约 3% 的位置会这样）。
 * 少了这点容差，那一格就被判成嵌进了墙里，而嵌进方块之后各个方向的扫掠都返回零位移
 * ——玩家永久卡死，走不动也跳不起来。容差远大于那点舍入误差，又远小于一 tick 的位移
 * 与贴地探测深度，所以只吃掉误差，不改变任何看得见的行为。
 */
const TOUCH_EPSILON = 1e-9;

function firstBlock(min: number): number {
  return Math.floor(min + TOUCH_EPSILON);
}

function lastBlock(max: number): number {
  return Math.ceil(max - TOUCH_EPSILON) - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把角度折回 (−π, π]。转多少圈偏航角都不会无界增长，精度因此不随时间变差。 */
function wrapAngle(angle: number): number {
  const wrapped = angle % TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  return wrapped;
}
