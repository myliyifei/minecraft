import { isWater, type BlockView } from './block';
import { TAU, TICK_RATE } from './constants';
import { isBoxInLoadedChunks, type LoadedChunks } from './entity';
import {
  decayedKnockback,
  FallTracker,
  fallStep,
  hitboxAt,
  isBlockedAlong,
  isOnGround,
  KNOCKBACK_LIFT,
  knockbackFrom,
  movedAlong,
  NO_WALK,
  type Hitbox,
  type HorizontalDelta,
} from './physics';
import type { PlayerSnapshot } from './snapshot';
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

/*
 * 在水里（见 CONTEXT.md「流体」）的移动参数，数值取原版的观感。只有玩家用：僵尸、掉落物在水里照旧（#72 Out of Scope）。
 * 在水里时竖直这一步不走 `fallStep`，按下面四个数另算：每 tick 先按住跳加上浮速度、夹住下沉上限，按这个速度移动，
 * 再乘阻力、减重力。不按跳时收敛到 `WATER_MAX_SINK_SPEED` 下沉，按住跳时收敛到每 tick 上升 0.1 格。
 */

/** 在水里时步行位移乘的系数。原版不疾跑游泳约 2.2 方块/秒，步行 4.317。 */
export const WATER_WALK_FACTOR = 0.5;

/** 在水里的重力加速度（方块/tick²）。空气里是 `GRAVITY`（0.08）。 */
export const WATER_GRAVITY = 0.02;

/** 在水里竖直速度每 tick 保留的比例。空气里是 `VERTICAL_DRAG`（0.98）。 */
export const WATER_DRAG = 0.8;

/**
 * 在水里的下落速度上限（方块/tick，正数）。`WATER_GRAVITY` 与 `WATER_DRAG` 从静止起正好收敛到它；从高处落进水里时
 * 第一个在水里的 tick 就把下落速度夹到它，之后每 tick 的下降都不超过它。
 */
export const WATER_MAX_SINK_SPEED = 0.1;

/** 在水里按住跳时每 tick 加的上浮速度（方块/tick）。不是起跳：不要求踩在地上。 */
export const WATER_SWIM_UP_SPEED = 0.04;

/**
 * 爬岸的上升速度（方块/tick）：在水里按住跳、水平移动被挡住时竖直速度直接设成它。
 *
 * 按住跳浮在水面时脚底在水面下约 0.3 格到水面上约 0.05 格之间起伏，爬上比水面高一格的岸要从起伏的低处抬高 1.3 格以上。
 * 设速之后还在水里走一 tick（加上浮速度），出水之后按空气里的重力减速，一共抬高约 1.6 格。原版是 0.3，但原版判定在水里
 * 用的是收窄过的碰撞箱，浮得更高；这里按整个碰撞箱判定，0.3 只抬高约 1 格，从起伏的低处够不着岸顶。
 */
export const WATER_CLIMB_SPEED = 0.4;

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

/** 快照里归 `Player` 管的那几项：位置、视角与运动。生命值、经验与背包在别的模块上。 */
export type PlayerMotion = Pick<
  PlayerSnapshot,
  'position' | 'yaw' | 'pitch' | 'velocityY' | 'fallHighest' | 'knockback'
>;

/** 玩家状态的只读视图。渲染层与调试句柄拿到的是这个，改状态只能经由核心的 tick。 */
export interface PlayerView {
  readonly position: Vec3;
  readonly previousPosition: Vec3;
  readonly eyePosition: Vec3;
  readonly lookDirection: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  /**
   * 在水里（见 CONTEXT.md「流体」）：碰撞箱与水格重叠出体积，只贴着水格的面不算。与 `onGround` 一样随查随算。
   * 在水里时移动按水里的参数算（`WATER_WALK_FACTOR` 等）。
   */
  readonly inWater: boolean;
  /** 眼睛在水下：眼睛所在那一格（`eyePosition` 取整）是水。渲染层每帧读它开关水下的雾。 */
  readonly eyeInWater: boolean;
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
   * 击退的水平速度，每 tick 乘 `KNOCKBACK_DECAY`，只由 `knockBack` 写入。移动的位移另算、没有惯性，
   * 两者每 tick 相加，与僵尸一致。没被打过时是 `NO_WALK`。
   */
  private knock: HorizontalDelta = NO_WALK;
  /** 摔落的落差，与僵尸同一份（`FallTracker`）。摔落伤害按落差算（`fallDamage`）。 */
  private readonly fallHeight: FallTracker;
  private yawAngle = 0;
  private pitchAngle = 0;

  constructor(blocks: BlockView & LoadedChunks, spawn: Vec3) {
    this.blocks = blocks;
    this.x = this.prevX = spawn.x;
    this.y = this.prevY = spawn.y;
    this.z = this.prevZ = spawn.z;
    this.fallHeight = new FallTracker(spawn.y);
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

  get inWater(): boolean {
    return overlapsWater(this.blocks, this.hitbox);
  }

  get eyeInWater(): boolean {
    const eye = this.eyePosition;
    return isWater(this.blocks.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)));
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
   * 被在 attacker 的东西打了一下：水平被推离它（`knockbackFrom`），带一点上抛。下一 tick 走的时候
   * 才动。上抛的最高点约 1.2 格，落回来不到摔落伤害的 3 格。
   */
  knockBack(attacker: Vec3): void {
    this.knock = knockbackFrom(attacker, this.position);
    this.velocityY = KNOCKBACK_LIFT;
  }

  /**
   * 移动到 spawn 并停住：竖直速度与击退都归零，落差从这里起算，上一个 tick 的位置也对齐过去——渲染层不会
   * 在死亡处与出生点之间插值出一帧。视角不变。
   */
  respawnAt(spawn: Vec3): void {
    this.x = this.prevX = spawn.x;
    this.y = this.prevY = spawn.y;
    this.z = this.prevZ = spawn.z;
    this.velocityY = 0;
    this.knock = NO_WALK;
    this.fallHeight.reset(spawn.y);
  }

  /** 位置、视角与运动的快照（ADR-0018）。 */
  snapshot(): PlayerMotion {
    return {
      position: this.position,
      yaw: this.yawAngle,
      pitch: this.pitchAngle,
      velocityY: this.velocityY,
      fallHighest: this.fallHeight.highestY,
      knockback: { x: this.knock.x, z: this.knock.z },
    };
  }

  /**
   * 回到快照里的位置、视角与运动。上一个 tick 的位置取当前位置：快照不存它，渲染层不会从别处插值过来。
   * 击退两个分量都是 0 时就是没被打过（`NO_WALK`），与刚进入世界时一样。
   */
  restore(motion: PlayerMotion): void {
    const { position, knockback } = motion;
    this.x = this.prevX = position.x;
    this.y = this.prevY = position.y;
    this.z = this.prevZ = position.z;
    this.yawAngle = motion.yaw;
    this.pitchAngle = motion.pitch;
    this.velocityY = motion.velocityY;
    this.fallHeight.reset(motion.fallHighest);
    this.knock = knockback.x === 0 && knockback.z === 0 ? NO_WALK : { x: knockback.x, z: knockback.z };
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
    // 不必等。击退的速度也在等着的 tick 里原样留着。
    // 在不在水里按这一 tick 开始时的位置定，这一 tick 的水平、竖直两步都按它算。
    const swimming = this.inWater;
    const walk = this.walkDelta(intent, swimming ? WATER_WALK_FACTOR : 1);
    const move = { x: walk.x + this.knock.x, z: walk.z + this.knock.z };
    if (!isBoxInLoadedChunks(this.blocks, sweptAlong(this.hitbox, move))) return 0;

    if (swimming) {
      this.swimVertically(intent.jump);
    } else {
      // 只有踩在地上才能起跳，所以按住空格是原地反复起跳，不是二段跳。
      if (intent.jump && this.onGround) this.velocityY = JUMP_VELOCITY;
      // 重力与竖直碰撞和掉落物共用一份（`fallStep`）：那里的「先移动再更新速度」决定了
      // 跳跃最高点是 1.252 方块。
      const fall = fallStep(this.blocks, this.hitbox, this.velocityY);
      this.y = fall.y;
      this.velocityY = fall.velocityY;
    }
    // 竖直走完之后在水里，落差从这里重新算起：从高处落进水里，入水那一 tick 就把空中那一段清掉，之后落到池底
    // 也不受伤。只看竖直走完之后：入水那一 tick 开始时还在空中，竖直这一步按空气里的规则走。
    if (this.inWater) this.fallHeight.reset(this.y);
    // 落差在竖直这一步之后、水平移动之前结算：落地只发生在竖直这一步。放到水平走完之后再看，
    // 同一 tick 里先落到一级台阶、再水平走下它边缘的那一次落地就漏掉了，几级台阶的落差会累计成一段。
    const fell = this.fallHeight.settle(this.y, this.onGround);

    // 竖直走完再走水平：跳到台阶上时这一 tick 已经抬到了台阶顶面之上，
    // 水平方向因此不再被台阶挡住。从边缘走下去时，离地前的高度已经在上面记下，下一 tick 起算落差。
    // 两个轴分开做碰撞，斜着撞墙时会沿着墙滑过去，而不是整步作废。这一步是移动加上击退，走完
    // 击退衰减一次。
    this.knock = decayedKnockback(this.knock);
    // 爬岸：在水里按住跳、水平被方块挡住时给一个向上的速度，下一 tick 起往上走，出水之后靠它越过岸边。
    // 挡没挡住按每个轴走之前的碰撞箱问（`isBlockedAlong`）；拿走完的坐标与起点加位移比不行，
    // 中心坐标是扫掠落点加回半宽算出来的，没被挡时也可能差一丝。
    const climb = swimming && intent.jump;
    let blocked = climb && isBlockedAlong(this.blocks, this.hitbox, 'x', move.x);
    this.x = this.movedAlong('x', move.x);
    blocked ||= climb && isBlockedAlong(this.blocks, this.hitbox, 'z', move.z);
    this.z = this.movedAlong('z', move.z);
    if (blocked) this.velocityY = WATER_CLIMB_SPEED;
    return fell;
  }

  /**
   * 在水里竖直走一步：按住跳先加上浮速度，再把下沉夹在 `WATER_MAX_SINK_SPEED` 以内，按这个速度移动；撞上东西
   * 速度清零，再乘阻力、减重力。与 `fallStep` 同样是「先移动再更新速度」。
   */
  private swimVertically(jump: boolean): void {
    const velocity = Math.max(this.velocityY + (jump ? WATER_SWIM_UP_SPEED : 0), -WATER_MAX_SINK_SPEED);
    const target = this.y + velocity;
    this.y = movedAlong(this.blocks, this.hitbox, 'y', velocity);
    const blocked = this.y !== target;
    this.velocityY = (blocked ? 0 : velocity) * WATER_DRAG - WATER_GRAVITY;
  }

  /**
   * 按意图沿视角方向走一步的水平位移，还没做碰撞。什么都没按是零位移。
   *
   * 俯仰不参与——抬头看天按 W 仍然是平着走。`factor` 乘在步长上：在水里是 `WATER_WALK_FACTOR`。
   */
  private walkDelta(intent: MoveIntent, factor: number): HorizontalDelta {
    const forward = Number(intent.forward) - Number(intent.back);
    const strafe = Number(intent.right) - Number(intent.left);
    if (forward === 0 && strafe === 0) return NO_WALK;

    // 斜着走不该比直着走快：把意图向量归一化再乘步长。
    const step = (WALK_STEP * factor) / Math.hypot(forward, strafe);
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

/**
 * 碰撞箱与水格重叠出体积。取边界时与碰撞扫掠同一个容差：贴着水格的面不算，钳位算出的那一丝舍入误差也不算。
 */
function overlapsWater(blocks: BlockView, { min, max }: Hitbox): boolean {
  for (let x = Math.floor(min.x + OVERLAP_EPSILON); x < max.x - OVERLAP_EPSILON; x++) {
    for (let y = Math.floor(min.y + OVERLAP_EPSILON); y < max.y - OVERLAP_EPSILON; y++) {
      for (let z = Math.floor(min.z + OVERLAP_EPSILON); z < max.z - OVERLAP_EPSILON; z++) {
        if (isWater(blocks.getBlock(x, y, z))) return true;
      }
    }
  }
  return false;
}

/** `overlapsWater` 取边界的容差，与 physics.ts 的 `TOUCH_EPSILON` 同一个量级与理由。 */
const OVERLAP_EPSILON = 1e-9;

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
