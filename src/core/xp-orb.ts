import { stepEntities } from './entity';
import type { ExperienceSink } from './experience';
import { boxCenter, hitboxAt, overlaps, type Hitbox } from './physics';
import type { Vec3 } from './vec3';

/** 经验球碰撞箱的边长（方块）。比掉落物再小一点，看上去是一小团光而不是一小块方块。 */
export const XP_ORB_SIZE = 0.2;

/**
 * 玩家离得这么近（方块）经验球就开始朝他飞，从经验球中心量到玩家碰撞箱中心。
 * 8 格来自 issue #9，与原版一致。触及距离只有 4.5 格，所以挖出来的经验球总在范围内。
 */
export const XP_ATTRACT_RANGE = 8;

/** 朝玩家飞时每 tick 加多少速（方块/tick²）。 */
export const XP_ORB_ACCELERATION = 0.04;

/** 飞行速度上限（方块/tick）。远小于经验球与玩家碰撞箱合起来的厚度，因此不会穿过玩家。 */
export const XP_ORB_MAX_SPEED = 0.4;

/**
 * 没被吸收的经验球存活这么多 tick 后消失，5 分钟。
 *
 * 与 `DROP_LIFETIME_TICKS` 同一个数，但两个常量各自独立：改掉落物的存活时间不该跟着
 * 改经验球的。经验球一生成就朝玩家飞，正常玩下来根本活不到这个数——它防的是玩家跑得
 * 比经验球快、把它甩在吸引范围之外那种情形，不让世界里攒下一堆没人收的经验球。
 */
export const XP_ORB_LIFETIME_TICKS = 6000;

/** 经验球的只读视图。渲染层读它摆那些飞向玩家的小方块。 */
export interface XpOrbView {
  /** 经验球的编号，一直到它消失都不变。渲染层靠它认出哪个小方块是哪个。 */
  readonly id: number;
  /** 被吸收时给玩家几点经验值。 */
  readonly amount: number;
  /** 碰撞箱底面中心。 */
  readonly position: Vec3;
  /** 上一个 tick 结束时的位置。渲染层在两者之间插值（ADR-0002）。 */
  readonly previousPosition: Vec3;
  /** 已经存在了多少 tick。 */
  readonly age: number;
}

/** 世界里现有的经验球。 */
export interface XpOrbsView {
  /** 现有的经验球。渲染层每帧遍历一次。 */
  all(): readonly XpOrbView[];
  readonly count: number;
}

/**
 * 方块碎掉时把经验交给谁。
 *
 * 挖掘依赖它而不是 `XpOrbs` 本身：挖掘只需要「这一块给几点经验」这一件事，经验球
 * 怎么飞、什么时候被吸收与它无关。与 `DropSink` 分成两个接口，因为经验与掉落是独立的
 * ——空手挖石头什么都不掉，经验照给。
 */
export interface XpOrbSink {
  /** 在方块 (x, y, z) 那一格里生成一个经验球，落点是那一格的中心。 */
  spawnInBlock(amount: number, x: number, y: number, z: number): void;
}

/**
 * 世界里的全部经验球：生成、朝玩家飞、接触即被吸收、超时消失。
 *
 * 经验球是实体，不是方块，所以它不走 `takeChangedBlocks()` 那条网格重建的路——渲染层
 * 每帧读 `all()` 自己摆小方块，见 ADR-0007。
 *
 * 与掉落物不同的三处：
 *
 * 1. **不受重力、也不与方块碰撞。** 经验球一生成就在吸引范围内（触及距离 4.5 格远
 *    小于 8 格），下一个 tick 就朝玩家飞过去，几 tick 内被吸收，重力与碰撞根本没有
 *    机会起作用。给它一套用不上的物理只会多一份要维护的解算。
 * 2. **没有拾取延迟，接触即吸收。** 掉落物的延迟是为了不让刚挖出来的东西在手边就被
 *    吸走；经验球本来就该飞过来，没有这个问题。
 * 3. **不需要种子。** 一个方块只掉一个经验球，不必像同格几个掉落物那样哈希出各自
 *    散开的初速度，所以这个类连构造参数都不需要。
 */
export class XpOrbs implements XpOrbsView, XpOrbSink {
  private readonly list: XpOrb[] = [];
  /** 下一个经验球的编号。 */
  private nextId = 1;

  get count(): number {
    return this.list.length;
  }

  all(): readonly XpOrbView[] {
    return this.list;
  }

  spawnInBlock(amount: number, x: number, y: number, z: number): void {
    // 碰撞箱的中心对准那一格的中心，所以底面比格底高半个箱高。
    const position: Vec3 = { x: x + 0.5, y: y + 0.5 - XP_ORB_SIZE / 2, z: z + 0.5 };
    this.list.push(new XpOrb(this.nextId++, amount, position));
  }

  /**
   * 推进一个 tick：先让每个经验球朝玩家飞一步，再看它是不是碰上了玩家或该消失了。
   *
   * `playerBox` 是玩家的碰撞箱，经验球朝它的中心飞（朝脚底飞的话会贴着地面钻过来）；
   * `into` 是收经验的地方。排在玩家移动之后调，接触判定用的才是这一 tick 走完之后的
   * 位置。
   */
  step(playerBox: Hitbox, into: ExperienceSink): void {
    const target = boxCenter(playerBox);
    stepEntities(this.list, (orb) => {
      orb.step(target);
      if (orb.absorbedBy(playerBox, into)) return false;
      return orb.age < XP_ORB_LIFETIME_TICKS;
    });
  }
}

/** 一个经验球：位置、当前速率、经验点数、存活 tick。 */
class XpOrb implements XpOrbView {
  readonly id: number;
  readonly amount: number;
  private x: number;
  private y: number;
  private z: number;
  private prevX: number;
  private prevY: number;
  private prevZ: number;
  /**
   * 当前速率（方块/tick），方向不存——每 tick 都重新对准玩家。
   *
   * 存速度向量的话经验球会带着惯性冲过玩家再绕回来，在他身边打转；只存速率、方向每
   * tick 重取，「加速飞过去」就是单调靠近的。
   */
  private speed = 0;
  private ticks = 0;

  constructor(id: number, amount: number, position: Vec3) {
    this.id = id;
    this.amount = amount;
    this.x = this.prevX = position.x;
    this.y = this.prevY = position.y;
    this.z = this.prevZ = position.z;
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

  private get hitbox(): Hitbox {
    return hitboxAt(this.position, XP_ORB_SIZE, XP_ORB_SIZE);
  }

  /** 碰撞箱中心。飞行是朝玩家中心去的，所以距离也从这里量。 */
  private get center(): Vec3 {
    return { x: this.x, y: this.y + XP_ORB_SIZE / 2, z: this.z };
  }

  /** 朝 `target` 飞一步。超出吸引范围时停在原地，速率归零。 */
  step(target: Vec3): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.ticks++;

    const center = this.center;
    const dx = target.x - center.x;
    const dy = target.y - center.y;
    const dz = target.z - center.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > XP_ATTRACT_RANGE || distance === 0) {
      this.speed = 0;
      return;
    }

    this.speed = Math.min(this.speed + XP_ORB_ACCELERATION, XP_ORB_MAX_SPEED);
    // 一步不超过剩下的距离：这样它只会越飞越近，不会冲过玩家再回头。
    const step = Math.min(this.speed, distance);
    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
    this.z += (dz / distance) * step;
  }

  /** 碰上玩家就把经验交出去。返回 true 时调用方随即把它从世界里去掉。 */
  absorbedBy(playerBox: Hitbox, into: ExperienceSink): boolean {
    if (!overlaps(playerBox, this.hitbox)) return false;
    into.gain(this.amount);
    return true;
  }
}
