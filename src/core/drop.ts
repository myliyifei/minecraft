import type { BlockView } from './block';
import { TAU } from './constants';
import type { ItemSink, ItemStack, ItemType } from './item';
import { hashCoords } from './noise';
import {
  expand,
  fallStep,
  hitboxAt,
  isOnGround,
  movedAlong,
  overlaps,
  type Hitbox,
} from './physics';
import type { Axis, Vec3 } from './vec3';

/** 掉落物碰撞箱的边长（方块）。与原版一致：比方块小得多，看上去就是一小块。 */
export const DROP_SIZE = 0.25;

/**
 * 生成后这么多 tick 内不被拾取。
 *
 * issue #8 说的是「前 10 tick 内玩家靠近不拾取」，所以判据是 `age > PICKUP_DELAY_TICKS`
 * ——第 10 个 tick 还在「前 10 tick」之内。原版的作用一样：刚挖出来的东西不会在手还没
 * 离开那一格时就被吸走。
 */
export const PICKUP_DELAY_TICKS = 10;

/** 存活这么多 tick 后消失。6000 tick 是 5 分钟，与原版一致。 */
export const DROP_LIFETIME_TICKS = 6000;

/**
 * 吸入范围：玩家碰撞箱各方向外扩这么多格。
 * 玩家不必踩在掉落物上，走过去就收得到——这是原版的手感。
 */
export const PICKUP_MARGIN = 1;

/**
 * 生成时的水平初速度（方块/tick）。方向由坐标与编号哈希出来，见 `spawnVelocity`。
 * 只要够让同一格掉出的几个掉落物散开，又不至于飞出那一格太远。
 */
export const DROP_SPAWN_SPEED = 0.05;

/** 空中水平速度每 tick 保留的比例：几乎不减速，落地前基本沿抛物线走。 */
const AIR_DRAG = 0.98;

/** 贴地时水平速度每 tick 保留的比例：滑一小段就停下来。 */
const GROUND_DRAG = 0.6;

/**
 * 低于这个速度（方块/tick）直接归零。
 * 指数衰减自己到不了零，少了这一刀掉落物会永远以肉眼看不见的速度蠕动，
 * 「落地后停住」就不是真的停住。
 */
const MIN_SPEED = 1e-3;

/** 掉落物的只读视图。渲染层读它摆那些漂浮旋转的小方块。 */
export interface DropView {
  /** 掉落物的编号，一直到它消失都不变。渲染层靠它认出哪个小方块是哪个。 */
  readonly id: number;
  readonly item: ItemType;
  /** 这一堆有多少个。被部分收进背包之后会变小。 */
  readonly count: number;
  /** 碰撞箱底面中心。 */
  readonly position: Vec3;
  /** 上一个 tick 结束时的位置。渲染层在两者之间插值（ADR-0002）。 */
  readonly previousPosition: Vec3;
  /** 已经存在了多少 tick。渲染层用它算漂浮与旋转的相位。 */
  readonly age: number;
}

/** 世界里现有的掉落物。 */
export interface DropsView {
  /** 现有的掉落物。渲染层每帧遍历一次。 */
  all(): readonly DropView[];
  readonly count: number;
}

/**
 * 方块碎掉时把掉落物交给谁。
 *
 * 挖掘依赖它而不是 `Drops` 本身：挖掘只需要「掉出来的东西交出去」这一件事，
 * 掉落物怎么落、怎么被拾取与它无关。
 */
export interface DropSink {
  /** 在方块 (x, y, z) 那一格里生成一个掉落物，落点是那一格的中心。 */
  spawnInBlock(stack: ItemStack, x: number, y: number, z: number): void;
}

/**
 * 世界里的全部掉落物：生成、下落、被吸进背包、超时消失。
 *
 * 掉落物是实体，不是方块，所以它不走 `takeChangedBlocks()` 那条网格重建的路——
 * 渲染层每帧读 `all()` 自己摆小方块，见 ADR-0007。
 *
 * 时间只由 `step()` 的调用次数表达（ADR-0002）；水平初速度由种子与坐标哈希出来
 * （ADR-0003），因此同一串 tick 每次都长出同一条轨迹。
 */
export class Drops implements DropsView, DropSink {
  private readonly blocks: BlockView;
  private readonly seed: number;
  private readonly list: Drop[] = [];
  /** 下一个掉落物的编号。同时是哈希初速度的一个输入，同一格掉出的几个因此不重叠。 */
  private nextId = 1;

  constructor(blocks: BlockView, seed: number) {
    this.blocks = blocks;
    this.seed = seed;
  }

  get count(): number {
    return this.list.length;
  }

  all(): readonly DropView[] {
    return this.list;
  }

  spawnInBlock(stack: ItemStack, x: number, y: number, z: number): void {
    const id = this.nextId++;
    // 碰撞箱的中心对准那一格的中心，所以底面比格底高半个箱高。
    const position: Vec3 = { x: x + 0.5, y: y + 0.5 - DROP_SIZE / 2, z: z + 0.5 };
    this.list.push(new Drop(id, stack, position, spawnVelocity(this.seed, x, y, z, id)));
  }

  /**
   * 推进一个 tick：先让每个掉落物落一步，再看它是不是该被吸走或消失。
   *
   * `playerBox` 是玩家的碰撞箱，吸入范围是把它外扩 `PICKUP_MARGIN` 格；`into` 是收物品的
   * 地方。排在玩家移动之后调，吸入判定用的才是这一 tick 走完之后的位置。
   *
   * 先判拾取再判到期：正好在第 6000 tick 上玩家贴着它时，宁可让他捡到，也不要眼前一空。
   */
  step(playerBox: Hitbox, into: ItemSink): void {
    const pickupBox = expand(playerBox, PICKUP_MARGIN);
    // 原地压缩：留下来的往前挪，消失的直接跳过。每 tick 不必新建一个数组。
    let write = 0;
    for (const drop of this.list) {
      drop.step(this.blocks);
      if (drop.collectInto(pickupBox, into)) continue;
      if (drop.age >= DROP_LIFETIME_TICKS) continue;
      this.list[write++] = drop;
    }
    this.list.length = write;
  }
}

/** 一个掉落物：位置、速度、物品与数量、存活 tick。 */
class Drop implements DropView {
  readonly id: number;
  readonly item: ItemType;
  private amount: number;
  // 与玩家一样存成三个数而不是一个 Vec3：逐轴解算碰撞时每次只改一个分量。
  private x: number;
  private y: number;
  private z: number;
  private prevX: number;
  private prevY: number;
  private prevZ: number;
  private velocityX: number;
  private velocityY = 0;
  private velocityZ: number;
  private ticks = 0;

  constructor(id: number, stack: ItemStack, position: Vec3, velocity: Horizontal) {
    this.id = id;
    this.item = stack.item;
    this.amount = stack.count;
    this.x = this.prevX = position.x;
    this.y = this.prevY = position.y;
    this.z = this.prevZ = position.z;
    this.velocityX = velocity.x;
    this.velocityZ = velocity.z;
  }

  get count(): number {
    return this.amount;
  }

  get age(): number {
    return this.ticks;
  }

  get position(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }

  get previousPosition(): Vec3 {
    return { x: this.prevX, y: this.prevY, z: this.prevZ };
  }

  get hitbox(): Hitbox {
    return hitboxAt(this.position, DROP_SIZE, DROP_SIZE);
  }

  /**
   * 试着把自己交给背包。全被收下就返回 true——调用方随即把它从世界里去掉。
   * 收下一部分时留下剩的那些，下一个 tick 再试。
   */
  collectInto(pickupBox: Hitbox, into: ItemSink): boolean {
    if (this.ticks <= PICKUP_DELAY_TICKS) return false;
    if (!overlaps(pickupBox, this.hitbox)) return false;
    const left = into.add({ item: this.item, count: this.amount });
    if (left === 0) return true;
    this.amount = left;
    return false;
  }

  /** 推进一个 tick：重力、阻力、与方块的碰撞。 */
  step(blocks: BlockView): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.ticks++;

    // 摩擦按这一 tick 开始时贴不贴地取：落地那一 tick 还算在空中滑行。
    const drag = isOnGround(blocks, this.hitbox) ? GROUND_DRAG : AIR_DRAG;
    this.velocityX = settle(this.velocityX * drag);
    this.velocityZ = settle(this.velocityZ * drag);

    // 竖直与玩家共用同一份重力解算。
    const fall = fallStep(blocks, this.hitbox, this.velocityY);
    this.y = fall.y;
    this.velocityY = fall.velocityY;

    // 速度为零就一步都不走：`movedAlong` 会把半宽减掉再加回来，浮点上不保证还原成
    // 原值，而「落地后停住」要求位置一个数都不变。
    if (this.velocityX !== 0) this.x = this.movedAlong(blocks, 'x', this.velocityX);
    if (this.velocityZ !== 0) this.z = this.movedAlong(blocks, 'z', this.velocityZ);
  }

  private movedAlong(blocks: BlockView, axis: Axis, delta: number): number {
    return movedAlong(blocks, this.hitbox, axis, delta);
  }
}

/** 一个水平速度。 */
interface Horizontal {
  readonly x: number;
  readonly z: number;
}

/**
 * 生成时的水平初速度：方向由种子、方块坐标与掉落物编号哈希出来。
 *
 * 不用 `Math.random`——核心必须是确定性的（ADR-0003），而且同一格同时掉出的几个
 * 掉落物要各自散开，编号正好把它们区分开。
 */
function spawnVelocity(
  seed: number,
  x: number,
  y: number,
  z: number,
  id: number,
): Horizontal {
  const spin = hashCoords(hashCoords(seed, x, z), y, id);
  // hashCoords 给的是 32 位无符号整数，除以 2³² 摊成 [0, 1)。
  const angle = (spin / 0x1_0000_0000) * TAU;
  return {
    x: Math.cos(angle) * DROP_SPAWN_SPEED,
    z: Math.sin(angle) * DROP_SPAWN_SPEED,
  };
}

/** 小于 `MIN_SPEED` 的速度归零。 */
function settle(velocity: number): number {
  return Math.abs(velocity) < MIN_SPEED ? 0 : velocity;
}
