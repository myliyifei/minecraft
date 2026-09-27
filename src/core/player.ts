import type { BlockView } from './block';
import { TAU, TICK_RATE } from './constants';
import { isBoxInLoadedChunks, type LoadedChunks } from './entity';
import {
  fallStep,
  hitboxAt,
  isOnGround,
  movedAlong,
  NO_WALK,
  type Hitbox,
  type HorizontalDelta,
} from './physics';
import type { Axis, Vec3 } from './vec3';

/** 碰撞箱的水平边长（方块）。 */
export const PLAYER_WIDTH = 0.6;

/** 碰撞箱的高度（方块）。 */
export const PLAYER_HEIGHT = 1.8;

/** 眼睛相对脚底的高度（方块）。第一人称相机放在这里，视线射线也从这里出发。 */
export const PLAYER_EYE_HEIGHT = 1.62;

/**
 * 触及距离（方块）：从眼睛量起，能挖到、能放到的最远距离。与原版一致。
 * 挖掘（#7）与放置（#10）共用它——玩家的手只有这么长，两件事没道理不一样。
 */
export const PLAYER_REACH = 4.5;

/** 步行速度（方块/秒）。与原版一致。疾跑与潜行是后续切片的事。 */
export const WALK_SPEED = 4.317;

/**
 * 俯仰的上下限（弧度）。
 * 留一点余量而不是取满 90°，视线方向因此不会退化成纯竖直——瞄准要拿它当射线方向。
 */
export const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * 起跳的竖直初速度（方块/tick）。
 * 与 `physics.ts` 的重力、阻力配在一起，最高点落在 1.252 方块：够上一格台阶，够不上
 * 两格。改这三个数中的任何一个都会改变跳跃高度，`tests/core/player.test.ts` 会检查它。
 */
export const JUMP_VELOCITY = 0.42;

/** 一 tick 的步行位移（方块）。 */
export const WALK_STEP = WALK_SPEED / TICK_RATE;

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
  readonly eyePosition: Vec3;
  readonly lookDirection: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  /** 当前的碰撞箱。掉落物的吸入范围是把它外扩一圈，见 `PICKUP_MARGIN`。 */
  readonly hitbox: Hitbox;
}

/**
 * 玩家：位置、速度、视角，以及与方块的碰撞。
 *
 * 纯核心逻辑，只依赖方块视图与「哪些区块已加载」，因此能在 Node 里对任意手工摆出来的地形做断言。
 * 时间只由 `step()` 的调用次数表达（ADR-0002），不读真实时钟。
 */
export class Player implements PlayerView {
  private readonly blocks: BlockView & LoadedChunks;
  // 位置存成三个数而不是一个 Vec3：逐轴解算碰撞时每次只改一个分量，
  // 存 Vec3 就得每个轴重建一次对象。对外读到的仍然是 Vec3。
  private x: number;
  private y: number;
  private z: number;
  private prevX: number;
  private prevY: number;
  private prevZ: number;
  private velocityY = 0;
  /**
   * 离地之后到过的最高 y。站在地上时就是脚下的高度；落地那一 tick 拿它减去落点得到落差，
   * 摔落伤害按落差算（`fallDamage`）。跳起来的那一段也算在内。
   */
  private fallFromY: number;
  private yawAngle = 0;
  private pitchAngle = 0;

  constructor(blocks: BlockView & LoadedChunks, spawn: Vec3) {
    this.blocks = blocks;
    this.x = this.prevX = spawn.x;
    this.y = this.prevY = spawn.y;
    this.z = this.prevZ = spawn.z;
    this.fallFromY = spawn.y;
  }

  /** 碰撞箱底面中心。y 就是脚底所在的高度。 */
  get position(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }

  /** 上一个 tick 结束时的位置。渲染层在它和当前位置之间插值（ADR-0002）。 */
  get previousPosition(): Vec3 {
    return { x: this.prevX, y: this.prevY, z: this.prevZ };
  }

  /** 眼睛的位置。找目标方块的那条视线射线从这里出发，不是从脚底。 */
  get eyePosition(): Vec3 {
    return { x: this.x, y: this.y + PLAYER_EYE_HEIGHT, z: this.z };
  }

  /**
   * 视线方向的单位向量。
   *
   * 与相机的朝向是同一个式子：偏航 0、俯仰 0 时是 (0, 0, −1)，抬头 y 为正。
   * 水平分量和 `moveHorizontally` 的前向量一致，只是多乘了俯仰的余弦——移动不看俯仰，
   * 瞄准看。
   */
  get lookDirection(): Vec3 {
    const cosPitch = Math.cos(this.pitchAngle);
    return {
      x: -Math.sin(this.yawAngle) * cosPitch,
      y: Math.sin(this.pitchAngle),
      z: -Math.cos(this.yawAngle) * cosPitch,
    };
  }

  /** 偏航（弧度）。0 表示看向 −Z，与 Three.js 相机的默认朝向一致。 */
  get yaw(): number {
    return this.yawAngle;
  }

  /** 俯仰（弧度）。正是抬头，负是低头，范围夹在 ±MAX_PITCH。 */
  get pitch(): number {
    return this.pitchAngle;
  }

  /** 脚下紧贴着实心方块。 */
  get onGround(): boolean {
    return isOnGround(this.blocks, this.hitbox);
  }

  /** 当前的碰撞箱：0.6 × 1.8 × 0.6，底面中心落在玩家坐标上。 */
  get hitbox(): Hitbox {
    return hitboxAt(this.position, PLAYER_WIDTH, PLAYER_HEIGHT);
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

  /**
   * 原地停一个 tick：不走、不受重力，只把上一个 tick 的位置对齐到现在。死亡画面期间每 tick 调。
   * 渲染层在两个位置之间插值（ADR-0002），不对齐的话相机会一遍遍重放死前的最后一步。
   */
  hold(): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
  }

  /**
   * 移动到 spawn 并停住：竖直速度归零，落差从这里起算，上一个 tick 的位置也对齐过去——渲染层不会
   * 在死亡处与出生点之间插值出一帧。视角不变。
   */
  respawnAt(spawn: Vec3): void {
    this.x = this.prevX = spawn.x;
    this.y = this.prevY = spawn.y;
    this.z = this.prevZ = spawn.z;
    this.velocityY = 0;
    this.fallFromY = spawn.y;
  }

  /**
   * 推进一个 tick，返回这一 tick 落地时的落差（格）：离地之后到过的最高点减去落点。没有落地、
   * 或者一直站在地上，返回 0。跳上台阶时落差只算高出台阶顶面的那一段。受不受伤、受几点由调用方
   * 按 `fallDamage` 算，玩家本身不持生命值。
   */
  step(intent: MoveIntent): number {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    // 这一 tick 可能碰到的方块有一格在没加载的区块里，就整 tick 原地等待：位置、速度、落差的起点
    // 都不变，与掉落物同一条规则（ADR-0013）。不等的话，那一格读出来是空气（「未加载即空气」），
    // 玩家掉下去，区块送到时已经嵌在地面里，还按从开始下落到嵌进地面的整段落差扣血。浏览器里区块由 Worker
    // 异步送来，走得比生成快就会走到这条边上。范围按这一 tick 要走的方向外扩：站在边上转身往回走
    // 不必等。
    const walk = this.walkDelta(intent);
    if (!isBoxInLoadedChunks(this.blocks, sweptAlong(this.hitbox, walk))) return 0;

    // 只有踩在地上才能起跳，所以按住空格是原地反复起跳，不是二段跳。
    if (intent.jump && this.onGround) this.velocityY = JUMP_VELOCITY;

    // 重力与竖直碰撞和掉落物共用一份（`fallStep`）：那里的「先移动再更新速度」决定了
    // 跳跃最高点是 1.252 方块。
    const fall = fallStep(this.blocks, this.hitbox, this.velocityY);
    this.y = fall.y;
    this.velocityY = fall.velocityY;
    // 落差在竖直这一步之后、水平移动之前结算：落地只发生在竖直这一步。放到水平走完之后再看，
    // 同一 tick 里先落到一级台阶、再水平走下它边缘的那一次落地就漏掉了，几级台阶的落差会累计成一段。
    const fell = this.settleFall();

    // 竖直走完再走水平：跳到台阶上时这一 tick 已经抬到了台阶顶面之上，
    // 水平方向因此不再被台阶挡住。从边缘走下去时，离地前的高度已经在上面记下，下一 tick 起算落差。
    // 两个轴分开做碰撞，斜着撞墙时会沿着墙滑过去，而不是整步作废。
    this.x = this.movedAlong('x', walk.x);
    this.z = this.movedAlong('z', walk.z);
    return fell;
  }

  /**
   * 竖直走完这一步之后更新 `fallFromY`，返回这一步落地时的落差，没有落地返回 0。
   *
   * 落点不会高于最高点：落到哪一格顶面之前，碰撞箱一定先在那个高度之上待过一 tick。
   */
  private settleFall(): number {
    if (!this.onGround) {
      this.fallFromY = Math.max(this.fallFromY, this.y);
      return 0;
    }
    const fell = this.fallFromY - this.y;
    this.fallFromY = this.y;
    return fell;
  }

  /**
   * 按意图沿视角方向走一步的水平位移，还没做碰撞。什么都没按是零位移。
   *
   * 俯仰不参与——抬头看天按 W 仍然是平着走。
   */
  private walkDelta(intent: MoveIntent): HorizontalDelta {
    const forward = Number(intent.forward) - Number(intent.back);
    const strafe = Number(intent.right) - Number(intent.left);
    if (forward === 0 && strafe === 0) return NO_WALK;

    // 斜着走不该比直着走快：把意图向量归一化再乘步长。
    const step = WALK_STEP / Math.hypot(forward, strafe);
    const sin = Math.sin(this.yawAngle);
    const cos = Math.cos(this.yawAngle);
    // yaw = 0 时前方是 −Z、右手边是 +X。
    return {
      x: (-sin * forward + cos * strafe) * step,
      z: (-cos * forward - sin * strafe) * step,
    };
  }

  private movedAlong(axis: Axis, delta: number): number {
    return movedAlong(this.blocks, this.hitbox, axis, delta);
  }
}

/**
 * 碰撞箱沿水平位移扫过的范围：只往要走的那一侧外扩。区块是整根柱子，竖直方向不外扩。
 */
function sweptAlong({ min, max }: Hitbox, delta: HorizontalDelta): Hitbox {
  return {
    min: { x: min.x + Math.min(delta.x, 0), y: min.y, z: min.z + Math.min(delta.z, 0) },
    max: { x: max.x + Math.max(delta.x, 0), y: max.y, z: max.z + Math.max(delta.z, 0) },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把角度折回 (−π, π]。转多少圈偏航都不会无界增长，精度因此不随时间变差。 */
function wrapAngle(angle: number): number {
  const wrapped = angle % TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  return wrapped;
}
