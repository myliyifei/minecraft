import {
  BlockType,
  blockDrop,
  blockExperience,
  isBreakable,
  miningTicks,
  type BlockEdit,
} from './block';
import { chainConnectedBlocks } from './chain-mining';
import type { DropSink } from './drop';
import { PLAYER_REACH, type PlayerView } from './player';
import { raycastBlocks, type BlockHit } from './raycast';
import type { Vec3 } from './vec3';
import type { XpOrbSink } from './xp-orb';

/**
 * 挖掘从玩家身上只要两件事：视线从哪儿出发、朝哪儿。
 * 从 `PlayerView` 上挑出来而不是另写一遍两个字段，玩家那边改了签名这边编译期就报。
 */
export type AimView = Pick<PlayerView, 'eyePosition' | 'lookDirection'>;

/**
 * 挖掘这一 tick 收到的输入。
 *
 * 写成一个结构而不是两个布尔参数：调用处 `step({ held: true, chain: false })` 读得出
 * 哪个键是哪个，将来再加一个键也不必改签名。核心不知道这两件事各绑哪个键——键位表在
 * `src/input/`。
 */
export interface MiningInput {
  /** 挖掘键按着没有。 */
  readonly held: boolean;
  /** 连锁键（见 CONTEXT.md 的「连锁键」）按着没有。 */
  readonly chain: boolean;
}

/** 挖掘状态的只读视图。渲染层读它画选框、裂纹与连锁预览。 */
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
  /**
   * 连锁预览（见 CONTEXT.md）：这一下挖穿时会一起碎掉的那些方块，含目标本身。
   * 不在连锁挖掘中时是空数组。渲染层读它画那圈高亮轮廓。
   */
  readonly chainPreview: readonly Vec3[];
}

/** 不在连锁中时报出去的空集合。共用一份，免得渲染层每帧读一次就分配一个数组。 */
const NO_CHAIN: readonly Vec3[] = Object.freeze([]);

/**
 * 挖掘：每 tick 重新瞄一次，对着同一个方块按住不放就把它挖掉。
 *
 * 进度绑定目标坐标而不是「正在挖」这么一个布尔：目标一换（换成别的方块，或者视线移开
 * 到空处）进度就归零，松开再按也从零开始。原版就是这个手感——挖到一半移开视线，回来
 * 得重挖。
 *
 * 挖穿的那一刻方块变成空气，掉落表里有东西的方块同时在原地掉出一个掉落物、一个经验球
 * ——挖掘只管把两样交给 `DropSink` 与 `XpOrbSink`，之后怎么落、怎么飞、怎么被收走是
 * `Drops` 与 `XpOrbs` 的事。掉落与经验各算各的：空手挖石头什么都不掉，经验照给。
 *
 * 按住连锁键开始挖，碎的就不止一块：与目标同种、26 向连通的那一片一起碎，每块各掉一份、
 * 各给一份经验（见 CONTEXT.md 的「连锁挖掘」）。耗时仍按目标那一块算，所以一根树干与
 * 一块原木一样快。
 *
 * 时间只由 `step()` 的调用次数表达（ADR-0002），耗时表在 `miningTicks`。
 */
export class Mining implements MiningView {
  private readonly blocks: BlockEdit;
  private readonly aim: AimView;
  private readonly drops: DropSink;
  private readonly experience: XpOrbSink;
  private hit: BlockHit | undefined;
  /** 已经对着当前目标挖了多少 tick。 */
  private elapsed = 0;
  /**
   * 这一下会一起碎掉的那些方块，含目标本身。不在连锁中时是 undefined。
   *
   * 开始挖那一 tick 算一次就存着，不每 tick 重算：玩家看到的预览与最终碎掉的那批因此
   * 必然是同一批，中途世界被别处改动（区块卸载、别处放了一块）也不会让两者分叉。
   */
  private chain: readonly Vec3[] | undefined;

  constructor(blocks: BlockEdit, aim: AimView, drops: DropSink, experience: XpOrbSink) {
    this.blocks = blocks;
    this.aim = aim;
    this.drops = drops;
    this.experience = experience;
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

  get chainPreview(): readonly Vec3[] {
    return this.chain ?? NO_CHAIN;
  }

  /**
   * 推进一个 tick。
   *
   * 排在玩家移动之后调：目标按这一 tick 走完之后的眼睛位置算，选框因此不会落后玩家一步。
   */
  step({ held, chain }: MiningInput): void {
    const previous = this.hit;
    this.hit = this.aimedBlock();
    if (!held || !isSameBlock(previous, this.hit)) this.restart();
    if (!held || !this.hit) return;

    const block = this.blocks.getBlock(this.hit.x, this.hit.y, this.hit.z);
    if (!isBreakable(block)) return;

    if (this.elapsed === 0) {
      // 连锁只在开始挖这一块的那一 tick 判定：这样「按住连锁键再开始挖」是一个明确的
      // 动作，挖到一半按下去不会让已经看了半秒的选框突然扩成一大片。
      if (chain) this.chain = chainConnectedBlocks(this.blocks, this.hit);
    } else if (!chain) {
      // 中途松开连锁键就退出连锁，预览随即消失，但进度留着——接着挖的是单块。
      // 再按回来也不算数：elapsed 已经不是 0 了。
      this.chain = undefined;
    }

    this.elapsed++;
    if (this.elapsed < miningTicks(block)) return;

    // 连锁集合里含目标本身，所以两条路都是「挖掉一批格子」，只是批的大小不同。
    for (const cell of this.chain ?? [this.hit]) {
      this.breakBlock(cell.x, cell.y, cell.z);
    }
    this.restart();
    // 挖穿了，视线随即落到后面那块上。当场重瞄一次，选框不会在这一 tick 里还套着一个
    // 已经不存在的方块；按住不放因此接着挖下一块，与原版一致。
    this.hit = this.aimedBlock();
  }

  /**
   * 挖掉一格：变成空气，掉落表里有东西就在原地掉出一个掉落物，有经验就再生成一个经验球。
   *
   * 方块种类当场重读而不是沿用连锁开始时记下的：那之后世界可能被别处改过（区块卸载、
   * 外部写入），已经不在了的格子直接跳过，不会凭空掉出东西。
   */
  private breakBlock(x: number, y: number, z: number): void {
    const block = this.blocks.getBlock(x, y, z);
    if (!isBreakable(block)) return;
    this.blocks.setBlock(x, y, z, BlockType.Air);
    // 掉落物与经验球都落在方块原来那一格里。什么都不掉的方块（树叶、空手挖的石头）
    // 只是没有掉落物，经验照给——两样各查自己那一列。
    const drop = blockDrop(block);
    if (drop) this.drops.spawnInBlock(drop, x, y, z);
    const experience = blockExperience(block);
    if (experience > 0) this.experience.spawnInBlock(experience, x, y, z);
  }

  /** 这一块从头挖起：进度归零，连锁集合一并清掉（下一 tick 才可能重新判定）。 */
  private restart(): void {
    this.elapsed = 0;
    this.chain = undefined;
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
