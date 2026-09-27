/**
 * 生命值（见 CONTEXT.md）：受伤、无敌时间与回血。
 *
 * 只是按 tick 计的算术，不碰世界也不碰实体：谁在什么时候受了几点伤由调用方算好交进来，
 * 时间也由调用方给（核心的 tick 计数），这里不自己数 tick。玩家与将来的僵尸共用这一份，
 * 回血只有玩家调。
 */

/** 满血是几点。进入世界时就是这么多。 */
export const MAX_HEALTH = 20;

/** 受伤之后这么多 tick 内再受伤不生效（含第 10 tick，第 11 tick 起生效）。 */
export const INVULNERABLE_TICKS = 10;

/** 距上次受伤满这么多 tick 才开始回血。 */
export const REGEN_DELAY_TICKS = 100;

/** 开始回血之后每隔这么多 tick 回 1 点。 */
export const REGEN_INTERVAL_TICKS = 80;

/** 落差不超过这么多格落地不受伤。 */
export const SAFE_FALL_DISTANCE = 3;

/**
 * 从 distance 格高处落地受几点伤：超过 `SAFE_FALL_DISTANCE` 的部分每格 1 点，不足一格的零头
 * 按一格算，与原版一致。
 *
 * 从整数高度落到方块顶面，落差是精确的整数（碰撞解算停在方块边界上），5 格就是 2 点。
 * 零头只出现在跳下去的时候：从 2 格高的台子上起跳，落差约 3.25（跳跃最高点 1.252 格），受 1 点伤。
 */
export function fallDamage(distance: number): number {
  return Math.max(0, Math.ceil(distance - SAFE_FALL_DISTANCE));
}

/** 生命值的只读视图。HUD 读它画心与红闪，改只能经由核心的 tick。 */
export interface HealthView {
  /** 当前生命值，0 到 `MAX_HEALTH` 的整数。 */
  readonly points: number;
  /** 生命值归零了没有。 */
  readonly dead: boolean;
  /** 上一次受伤（真的扣了血）是第几个 tick。还没受过伤是 undefined。 */
  readonly lastHurtTick: number | undefined;
}

export class Health implements HealthView {
  private current = MAX_HEALTH;
  private lastHurt: number | undefined;
  /** 无敌时间到第几个 tick 为止（含）。还没受过伤时比任何 tick 都早。 */
  private invulnerableUntil = -Infinity;

  get points(): number {
    return this.current;
  }

  get dead(): boolean {
    return this.current === 0;
  }

  get lastHurtTick(): number | undefined {
    return this.lastHurt;
  }

  /**
   * 在第 now 个 tick 受 amount 点伤，返回这一下是否生效。
   *
   * 三种情形不生效：伤害不是正数、已经死了、还在上一次受伤的无敌时间里。生效时扣血
   * （扣到 0 为止），并从这一 tick 起重新计无敌时间与回血的等待。
   */
  hurt(amount: number, now: number): boolean {
    if (amount <= 0 || this.dead || now <= this.invulnerableUntil) return false;
    this.current = Math.max(0, this.current - amount);
    this.lastHurt = now;
    this.invulnerableUntil = now + INVULNERABLE_TICKS;
    return true;
  }

  /**
   * 回到进入世界时的样子：满血，没受过伤，没有无敌时间。重生时调。
   */
  reset(): void {
    this.current = MAX_HEALTH;
    this.lastHurt = undefined;
    this.invulnerableUntil = -Infinity;
  }

  /**
   * 第 now 个 tick 的回血：距上次受伤满 `REGEN_DELAY_TICKS` 的那一 tick 回 1，之后每满
   * `REGEN_INTERVAL_TICKS` 再回 1，到 `MAX_HEALTH` 为止。死了不回，没受过伤也没什么可回。
   *
   * 按「距上次受伤几 tick」判定而不是自己数：受伤一次就从头等起，不必另清一个计数。
   * 调用方要每 tick 调一次，漏掉的那一 tick 不补。
   */
  regenerate(now: number): void {
    if (this.lastHurt === undefined || this.dead || this.current >= MAX_HEALTH) return;
    const waited = now - this.lastHurt - REGEN_DELAY_TICKS;
    if (waited >= 0 && waited % REGEN_INTERVAL_TICKS === 0) this.current++;
  }
}
