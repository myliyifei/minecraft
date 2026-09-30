import type { BlockView } from './block';
import { attackDamageOf, attackWearOf, type ToolHand } from './item';
import { IDLE_MINING, type AimView, type MiningInput } from './mining';
import { raycastBlocks, type EntityHit, type EntityRaycast } from './raycast';
import type { Vec3 } from './vec3';

/**
 * 攻击距离（方块）：从眼睛量起，打得到的最远距离。比触及距离（`PLAYER_REACH`，4.5）短：
 * 4.5 格处的方块挖得到，同样距离的僵尸打不到，与原版一致。
 */
export const ATTACK_RANGE = 3;

/** 出手之后这么多 tick 内再按左键不出手（第 10 tick 起可以）。 */
export const ATTACK_COOLDOWN_TICKS = 10;

/**
 * 攻击要从被打的那一批实体那里拿到的两件事：视线最先碰到哪一只，打它一下。僵尸集合满足它。
 */
export interface AttackTargets extends EntityRaycast {
  /** 玩家在 attacker 打了编号 id 的那只一下，返回生效了没有（无敌时间里不生效）。 */
  hitByPlayer(id: number, damage: number, attacker: Vec3, now: number): boolean;
}

/** 攻击状态的只读视图。渲染层读它让手持物品挥动。 */
export interface AttackView {
  /**
   * 上一次按下左键是第几个 tick，不论这一下打中了什么（僵尸、方块、空处）、在不在冷却里。
   * 还没按过是 undefined。挥动是纯表现（`render/held-swing.ts`），核心只记这一个数。
   */
  readonly lastSwingTick: number | undefined;
}

/**
 * 攻击（见 CONTEXT.md 的「攻击」，分派规则见 ADR-0015）：左键按下那一 tick 按视线先碰到什么分派——
 * 先碰到僵尸是攻击，先碰到方块（或什么都没碰到）是挖掘。
 *
 * 「按下」是一次性输入（ADR-0004）：核心在两个 tick 之间看到挖掘键从没按到按下就排一次，下一个 tick
 * 边界交给这里。按下又在同一个 tick 之前松开的一下因此不丢。
 *
 * 分派只在按下那一 tick 做一次，整次按住都照它来：分给攻击的，按住多久都只出这一下手，也不转去
 * 挖后面的方块，松开再按才是下一次；分给挖掘的，挖掘照 `Mining` 的规则每 tick 重瞄。挖到一半僵尸
 * 挡到视线前面时挖掘丢失目标，不改打僵尸——那条规则在 `Mining` 的瞄准里。
 *
 * 出手的规则：距上次出手不满 `ATTACK_COOLDOWN_TICKS` 忽略；否则按手上那一堆的伤害打一下
 * （`attackDamageOf`），手上的工具损耗耐久（`attackWearOf`），记下这一 tick。僵尸还在受击后的
 * 无敌时间里时这一下仍算出手（损耗耐久、记下这一 tick），只是不掉血。
 *
 * 排在挖掘之前、玩家移动之后：瞄准用玩家这一 tick 走完之后的眼睛，与挖掘同一条视线（ADR-0006）。
 * 僵尸的位置是上一 tick 结束时的，它们排在后面才走。
 */
export class Attack implements AttackView {
  private readonly blocks: BlockView;
  private readonly aim: AimView;
  private readonly hand: ToolHand;
  private readonly targets: AttackTargets;
  /** 这一次按住在按下那一 tick 分给了攻击。松开时清掉。 */
  private striking = false;
  /** 上一次出手是第几个 tick。冷却从它起算，还没出过手时比任何 tick 都早。 */
  private lastStrike = -Infinity;
  private lastSwing: number | undefined;

  constructor(blocks: BlockView, aim: AimView, hand: ToolHand, targets: AttackTargets) {
    this.blocks = blocks;
    this.aim = aim;
    this.hand = hand;
    this.targets = targets;
  }

  get lastSwingTick(): number | undefined {
    return this.lastSwing;
  }

  /**
   * 推进一个 tick：input 是这一 tick 挖掘键与连锁键的状态，pressed 是上一个 tick 边界以来挖掘键
   * 按下过没有，now 是核心的 tick 计数。返回挖掘这一 tick 该收到的输入——这一次按住分给了攻击时是
   * 「什么都没按」，挖掘因此不开始、不推进。
   *
   * 按下又已经松开（pressed 为真、input.held 为假）时照样分派、出手，只是没有按住的后续。
   */
  step(input: MiningInput, pressed: boolean, now: number): MiningInput {
    if (pressed) {
      this.lastSwing = now;
      const target = this.aimedTarget();
      this.striking = target !== undefined;
      if (target) this.strike(target, now);
    }
    if (!input.held) this.striking = false;
    return this.striking ? IDLE_MINING : input;
  }

  /**
   * 攻击距离内视线最先碰到的那一只，方块比它更近时 undefined。两者一样近算僵尸：僵尸的碰撞箱
   * 进不了方块，一样近只会是它贴着方块站在前面。
   */
  private aimedTarget(): EntityHit | undefined {
    const { eyePosition, lookDirection } = this.aim;
    const target = this.targets.raycast(eyePosition, lookDirection, ATTACK_RANGE);
    if (!target) return undefined;
    const block = raycastBlocks(this.blocks, eyePosition, lookDirection, target.distance);
    return block && block.distance < target.distance ? undefined : target;
  }

  /** 对 target 出一下手。冷却没过就什么都不做。 */
  private strike(target: EntityHit, now: number): void {
    if (now - this.lastStrike < ATTACK_COOLDOWN_TICKS) return;
    this.lastStrike = now;
    const held = this.hand.held;
    this.targets.hitByPlayer(target.id, attackDamageOf(held), this.aim.eyePosition, now);
    this.hand.wearHeld(attackWearOf(held));
  }
}
