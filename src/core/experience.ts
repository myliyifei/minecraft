/**
 * 经验值与等级（见 CONTEXT.md）。
 *
 * 纯算术，不碰世界也不碰实体：经验球把吸收到的点数交给 `Experience`，它只负责把累计
 * 经验值换算成等级与等级内进度。第一版等级只用于显示，没有消耗途径。
 */

/**
 * 三段公式的分界等级：0 到 `EARLY_LAST_LEVEL` 每级所需 2L+7，到 `MID_LAST_LEVEL`
 * 是 5L−38，再往上是 9L−158。
 *
 * 这是 issue #9 写的分界。原版的分界比它各早一级（0–15、16–30、31 以上），所以从
 * 16 级起两边每级所需会差几点：issue 的 16 级要 39 点，原版是 42 点。按 issue 来——
 * 它的验收条件「16 级满 → 17 级所需按新公式」说的就是这个分界。要改回原版，把下面
 * 两个数各减 1，`tests/core/experience.test.ts` 那两张表会把新数字报出来。
 */
const EARLY_LAST_LEVEL = 16;
const MID_LAST_LEVEL = 31;

/** 从 `level` 级升到下一级需要多少经验值。 */
export function levelSpan(level: number): number {
  if (level <= EARLY_LAST_LEVEL) return 2 * level + 7;
  if (level <= MID_LAST_LEVEL) return 5 * level - 38;
  return 9 * level - 158;
}

/** 累计经验值换算出的等级，与它在这一级里的位置。 */
export interface LevelBreakdown {
  /** 当前等级。 */
  readonly level: number;
  /** 当前等级内已经攒下的经验值，恒小于 `levelSpan`。 */
  readonly intoLevel: number;
  /** 当前等级升到下一级共需多少经验值。 */
  readonly levelSpan: number;
}

/**
 * 累计经验值对应的等级与等级内进度。
 *
 * 逐级减去每级所需，而不是解那三段闭式：分界一改这里不用跟着改，而且每级所需是递增
 * 的正整数，循环次数就是等级数——挖方块攒出来的等级是几十的量级。
 */
export function levelBreakdown(total: number): LevelBreakdown {
  let level = 0;
  let left = Math.max(total, 0);
  for (;;) {
    const span = levelSpan(level);
    if (left < span) return { level, intoLevel: left, levelSpan: span };
    left -= span;
    level++;
  }
}

/**
 * 玩家经验的只读视图。HUD 读它画等级条，改只能经由经验球被吸收。
 * 等级那三样就是 `LevelBreakdown`，不再抄一遍。
 */
export interface ExperienceView extends LevelBreakdown {
  /** 累计经验值。 */
  readonly total: number;
  /** 当前等级内的进度，0 到 1（取不到 1——攒满就升级了）。 */
  readonly progress: number;
}

/**
 * 经验的去处，返回值没有意义：经验没有容量上限，交出去就一定收下。
 *
 * 经验球依赖它而不是 `Experience` 本身：吸收那条路只需要「把点数交出去」这一件事，
 * 换算等级与它无关。
 */
export interface ExperienceSink {
  gain(amount: number): void;
}

/**
 * 玩家的经验：累计经验值，加由它换算出的等级。
 *
 * 只存累计值这一个数，等级是算出来的——两份状态就会有对不上的可能，而换算一次的代价
 * 是几十次整数减法。换算结果在 `gain()` 里算一遍存下，四个查询因此都是常数时间。
 */
export class Experience implements ExperienceView, ExperienceSink {
  private points = 0;
  private breakdown = levelBreakdown(0);

  get total(): number {
    return this.points;
  }

  get level(): number {
    return this.breakdown.level;
  }

  get intoLevel(): number {
    return this.breakdown.intoLevel;
  }

  get levelSpan(): number {
    return this.breakdown.levelSpan;
  }

  get progress(): number {
    return this.breakdown.intoLevel / this.breakdown.levelSpan;
  }

  gain(amount: number): void {
    if (amount <= 0) return;
    this.points += amount;
    this.breakdown = levelBreakdown(this.points);
  }
}
