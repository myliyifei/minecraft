import { BlockType, isBreakable, miningTicks, type BlockEdit } from './block';
import { PLAYER_REACH, type PlayerView } from './player';
import { raycastBlocks, type BlockHit } from './raycast';

/**
 * 挖掘从玩家身上只要两件事：视线从哪儿出发、朝哪儿。
 * 从 `PlayerView` 上挑出来而不是另写一遍两个字段，玩家那边改了签名这边编译期就报。
 */
export type AimView = Pick<PlayerView, 'eyePosition' | 'lookDirection'>;

/** 挖掘状态的只读视图。渲染层读它画选框与裂纹。 */
export interface MiningView {
  /** 目标方块（见 CONTEXT.md），触及距离内没有方块时 undefined。 */
  readonly target: BlockHit | undefined;
  /**
   * 当前目标的挖掘进度：0 是还没开始，越接近 1 越接近碎掉。
   *
   * 取不到 1——挖满的那一 tick 方块已经碎了，进度同时归零。挖不动的方块进度恒为 0，
   * 因此基岩连裂纹都不出。
   */
  readonly progress: number;
}

/**
 * 挖掘：每 tick 重新瞄一次，对着同一个方块按住不放就把它挖掉。
 *
 * 进度绑定目标坐标而不是「正在挖」这么一个布尔：目标一换（换成别的方块，或者视线移开
 * 到空处）进度就归零，松开再按也从零开始。原版就是这个手感——挖到一半移开视线，回来
 * 得重挖。
 *
 * 时间只由 `step()` 的调用次数表达（ADR-0002），耗时表在 `miningTicks`。
 */
export class Mining implements MiningView {
  private readonly blocks: BlockEdit;
  private readonly aim: AimView;
  private hit: BlockHit | undefined;
  /** 已经对着当前目标挖了多少 tick。 */
  private elapsed = 0;

  constructor(blocks: BlockEdit, aim: AimView) {
    this.blocks = blocks;
    this.aim = aim;
  }

  get target(): BlockHit | undefined {
    return this.hit;
  }

  get progress(): number {
    if (!this.hit) return 0;
    const required = miningTicks(this.blocks.getBlock(this.hit.x, this.hit.y, this.hit.z));
    // 基岩的耗时是 Infinity，除出来是 0。耗时为 0 只在目标那一格被别处改成空气之后出现
    // （区块卸载、外部写入），那时候除出来是 NaN，得挡住。
    if (!(required > 0)) return 0;
    // 钳在 1 以内：正常挖掘到不了 1，但目标原地换成一种更软的方块时 elapsed 会超过它。
    return Math.min(this.elapsed / required, 1);
  }

  /**
   * 推进一个 tick。`held` 是这一 tick 里挖掘键按着没有。
   *
   * 排在玩家移动之后调：目标按这一 tick 走完之后的眼睛位置算，选框因此不会落后玩家一步。
   */
  step(held: boolean): void {
    const previous = this.hit;
    this.hit = this.aimedBlock();
    if (!held || !isSameBlock(previous, this.hit)) this.elapsed = 0;
    if (!held || !this.hit) return;

    const block = this.blocks.getBlock(this.hit.x, this.hit.y, this.hit.z);
    if (!isBreakable(block)) return;

    this.elapsed++;
    if (this.elapsed < miningTicks(block)) return;

    // 本切片方块直接消失，不产生掉落物与经验（#8、#9）。
    this.blocks.setBlock(this.hit.x, this.hit.y, this.hit.z, BlockType.Air);
    this.elapsed = 0;
    // 挖穿了，视线随即落到后面那块上。当场重瞄一次，选框不会在这一 tick 里还套着一个
    // 已经不存在的方块；按住不放因此接着挖下一块，与原版一致。
    this.hit = this.aimedBlock();
  }

  private aimedBlock(): BlockHit | undefined {
    return raycastBlocks(
      this.blocks,
      this.aim.eyePosition,
      this.aim.lookDirection,
      PLAYER_REACH,
    );
  }
}

/** 两次瞄的是同一格吗。命中面不算——转到同一块的另一面不该让进度归零。 */
function isSameBlock(a: BlockHit | undefined, b: BlockHit | undefined): boolean {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
