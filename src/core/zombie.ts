import { isPlant, isSolid, type BlockView } from './block';
import { MAX_LIGHT_LEVEL, TAU, TICK_RATE, WORLD_MAX_Y } from './constants';
import { spawnsHostiles, zombieAttackDamage, type Difficulty } from './difficulty';
import type { DropSink } from './drop';
import { isBoxInLoadedChunks, isInLoadedChunk, stepEntities, type LoadedChunks } from './entity';
import { fallDamage, Health } from './health';
import { ItemType } from './item';
import { hashCoords } from './noise';
import {
  clearsAfterRising,
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
import { JUMP_VELOCITY } from './player';
import { raycastBox, type EntityHit, type EntityRaycast } from './raycast';
import { effectiveSkyLight } from './time-of-day';
import type { Vec3 } from './vec3';
import type { XpOrbSink } from './xp-orb';

/** 碰撞箱的水平边长（方块）。与玩家一样宽。 */
export const ZOMBIE_WIDTH = 0.6;

/** 碰撞箱的高度（方块）。比玩家高一点：模型总高 2 格，头顶留了一点。 */
export const ZOMBIE_HEIGHT = 1.95;

/** 生成时的生命值。 */
export const ZOMBIE_MAX_HEALTH = 20;

/** 死亡时最多掉几件腐肉。件数由哈希在 0 到它之间取（含两端）。 */
export const ZOMBIE_MAX_FLESH = 2;

/** 被玩家打死时掉的经验球有几点。与方块经验乘 10 的规则一致。 */
export const ZOMBIE_XP = 50;

/** 移动速度（方块/秒）。比玩家步行的 4.317 慢，玩家总跑得掉。 */
export const ZOMBIE_SPEED = 1;

/** 一 tick 的移动距离（方块）。 */
export const ZOMBIE_STEP = ZOMBIE_SPEED / TICK_RATE;

/** 距上次出手满这么多 tick 才再出手。 */
export const ZOMBIE_ATTACK_INTERVAL = 20;

/** 与玩家的水平中心距在这么多格以内（含）、碰撞箱竖直区间又重叠，就打得到。 */
export const ZOMBIE_ATTACK_RANGE = 1.5;

/** 与玩家的水平距离在这么多格以内（含）就朝玩家走，隔着墙也追。 */
export const ZOMBIE_CHASE_RANGE = 32;

/** 离玩家超过这么多格（三维距离）就消失。 */
export const ZOMBIE_DESPAWN_RANGE = 64;

/** 游走时每隔这么多 tick 重新选一次方向或停下。 */
export const ZOMBIE_WANDER_TICKS = 60;

/** 燃烧时每隔这么多 tick 扣一次血：tick 计数能被它整除的那些 tick。 */
export const ZOMBIE_BURN_INTERVAL = 20;

/** 燃烧一次扣几点。满血 20 点，露天站着 400 tick 烧死。 */
export const ZOMBIE_BURN_DAMAGE = 1;

/** 自然生成时同时存活的僵尸至多这么多只。`spawnAt` 生成的也算在内。 */
export const ZOMBIE_MAX_COUNT = 8;

/** 自然生成隔这么多 tick 试一次：tick 计数能被它整除的那些 tick。 */
export const ZOMBIE_SPAWN_INTERVAL = 20;

/** 自然生成时离玩家的水平距离至少这么多格（含），不会紧挨着玩家生成。 */
export const ZOMBIE_SPAWN_MIN_DISTANCE = 24;

/** 自然生成时离玩家的水平距离至多这么多格（含）：还在追击范围附近，走得过来。 */
export const ZOMBIE_SPAWN_MAX_DISTANCE = 48;

/** 自然生成的那一格折算天光至多这么多（含）。夜晚露天是 4，白天露天是 15。 */
export const ZOMBIE_SPAWN_MAX_SKY_LIGHT = 7;

/**
 * 游走时选中「停下」的比例。哈希摊成 [0, 1) 之后落在这一段之下就停下，其余的均匀映射成一个方向。
 */
const WANDER_STOP_SHARE = 1 / 3;

/** 游走的哈希与别的哈希（生成、掉落散开）错开用的盐。 */
const WANDER_SALT = 0x6a3d_e91b;

/** 腐肉件数的哈希用的盐，与游走错开：同一 tick、同一编号的两种哈希不该相关。 */
const LOOT_SALT = 0x2f71_c5a3;

/** 自然生成选候选列的哈希用的盐，与游走、腐肉错开。 */
const SPAWN_SALT = 0x51c8_0f27;

/** 僵尸的只读视图。渲染层读它摆模型、按 `age + alpha` 摆臂摆腿（ADR-0007）。 */
export interface ZombieView {
  /** 僵尸的编号，一直到它消失都不变，消失了也不复用。渲染层靠它认出哪个模型是哪只。 */
  readonly id: number;
  /** 碰撞箱底面中心。 */
  readonly position: Vec3;
  /** 上一个 tick 结束时的位置。渲染层在两者之间插值（ADR-0002）。 */
  readonly previousPosition: Vec3;
  /** 偏航（弧度），与玩家同一套约定：0 朝 −Z。最后一次走动时朝着的方向。 */
  readonly yaw: number;
  /** 已经推进了多少 tick。原地等区块的那些 tick 不算。 */
  readonly age: number;
  readonly health: number;
  /** 上一次受伤（真的扣了血）是第几个 tick，还没受过伤是 undefined。渲染层据此叠红。 */
  readonly lastHurtTick: number | undefined;
  /** 是否在燃烧：上一次推进时是白天、它又在露天（脚底那格天光 15）。渲染层据此叠橙。 */
  readonly burning: boolean;
}

/** 僵尸追的、打的那个玩家。 */
export interface ZombieTarget {
  /** 碰撞箱底面中心。追击与消失都按它算。 */
  readonly position: Vec3;
  /** 当前的碰撞箱。打不打得到要看它的竖直区间。 */
  readonly hitbox: Hitbox;
  /**
   * 第 now 个 tick 被在 attacker（僵尸的位置）的僵尸打了 amount 点。玩家还在无敌时间里、已经死了时
   * 不生效，由玩家那边判定。
   */
  hitByZombie(amount: number, attacker: Vec3, now: number): void;
}

/** 世界里现有的僵尸。 */
export interface ZombiesView {
  /** 现有的僵尸。渲染层每帧遍历一次。 */
  all(): readonly ZombieView[];
  readonly count: number;
}

/**
 * 某一列此刻最高的非空气方块的 y。`World` 满足它。
 *
 * 自然生成站在列顶之上。用的是这一列实际堆到的高度，不是地表高度：地表高度是地形生成给出的地面，
 * 不随挖掘与放置变化。
 */
export interface ColumnTops {
  highestBlockY(x: number, z: number): number;
}

/**
 * 某一格的天光与方块光等级，没加载的格子读作 0。`World` 满足它。
 *
 * 燃烧看天光是不是 15（「露天」），生成看方块光与折算天光。折算要用的天光减量随世界时刻变，
 * 世界不知道时刻，由核心每 tick 交给 `spawnNaturally`。
 */
export interface LightLevels {
  skyLightAt(x: number, y: number, z: number): number;
  blockLightAt(x: number, y: number, z: number): number;
}

/**
 * 世界里的全部僵尸：在暗处的列顶生成、朝玩家走或游走、跳上 1 格、够得着就打玩家、被玩家打、白天
 * 露天燃烧、摔落受伤、离得太远或所在区块没加载就消失、生命归零就死。
 *
 * 与掉落物、经验球同一套样式（ADR-0007）：持列表、编号自增不复用、`step` 走 `stepEntities`；
 * 重力与碰撞用 `physics.ts` 里与玩家、掉落物同一份解算，摔落的落差也与玩家同一份（`FallTracker`）。
 * 僵尸之间、僵尸与玩家之间不做碰撞，可以重叠。
 *
 * 打玩家时只管够不够得着、隔没隔够 20 tick，打出去的那一下交给玩家（`ZombieTarget.hitByZombie`）：
 * 生命值、无敌时间与击退都是玩家那边的事。一下扣几点按难度（`zombieAttackDamage`）；和平下不生成，
 * 已有的下一次推进时全部消失。
 *
 * 生成的候选列、游走的方向、腐肉的件数都由种子、tick 与编号哈希出来（ADR-0014），核心不持随机状态，
 * 同一种子、同一串指令每次得到同样的僵尸。
 *
 * 所在区块没加载就消失（ADR-0013）：僵尸是按规则生成的，走远了本来就该没，不必像掉落物那样暂停
 * 保留。中心还在已加载区块里、这一 tick 可能走到的范围（`reach`）却伸进了没加载的区块时，则原地
 * 等这一 tick——否则碰撞把隔壁读成空气，它会走进隔壁本来是墙的位置，区块送到时卡在墙里。
 *
 * 死掉的僵尸在原位掉 0 到 2 件腐肉（件数由种子、tick 与编号哈希出来），最后一下是玩家打的
 * 还掉一个经验球，交给 `DropSink` 与 `XpOrbSink`；之后怎么落、怎么飞是它们的事。
 */
export class Zombies implements ZombiesView, EntityRaycast {
  private readonly blocks: BlockView & LoadedChunks & ColumnTops & LightLevels;
  private readonly seed: number;
  private readonly drops: DropSink;
  private readonly experience: XpOrbSink;
  /** 这一档有没有僵尸：和平下没有（`spawnsHostiles`）。 */
  private readonly hostile: boolean;
  /** 打玩家一下扣几点，按难度。 */
  private readonly attackDamage: number;
  private readonly list: Zombie[] = [];
  /** 下一只僵尸的编号。同时是游走哈希的一个输入，同一 tick 里的几只因此各走各的。 */
  private nextId = 1;

  constructor(
    blocks: BlockView & LoadedChunks & ColumnTops & LightLevels,
    seed: number,
    drops: DropSink,
    experience: XpOrbSink,
    difficulty: Difficulty,
  ) {
    this.blocks = blocks;
    this.seed = seed;
    this.drops = drops;
    this.experience = experience;
    this.hostile = spawnsHostiles(difficulty);
    this.attackDamage = zombieAttackDamage(difficulty);
  }

  get count(): number {
    return this.list.length;
  }

  all(): readonly ZombieView[] {
    return this.list;
  }

  /**
   * 下一只僵尸的编号。僵尸不进快照，编号进：编号是游走与掉落的哈希输入，读档后接着往下编，
   * 之后生成的僵尸才与不读档时的一样（ADR-0018）。
   */
  get nextZombieId(): number {
    return this.nextId;
  }

  /** 读档时放回快照里的编号。在构造之后、生成任何一只之前调。 */
  restoreNextId(nextId: number): void {
    this.nextId = nextId;
  }

  /**
   * 在 position（碰撞箱底面中心）无条件生成一只。不看那里是不是实心，也不看光照，和平下也生成：
   * 下一次推进时它就消失。
   */
  spawnAt(position: Vec3): void {
    this.list.push(new Zombie(this.nextId++, position));
  }

  /**
   * 第 tick 个 tick 的自然生成，player 是玩家碰撞箱底面中心，skyDarkening 是这一 tick 取整之后的天光
   * 减量（`GameCore.skyDarkening`）。每 tick 调一次，至多生成一只。
   *
   * 现有不到 `ZOMBIE_MAX_COUNT` 只、tick 能被 `ZOMBIE_SPAWN_INTERVAL` 整除时试一次：由种子与 tick
   * 哈希出一个角度与一个 24 到 48 格的距离，从玩家的水平位置量过去落在哪一列，那一列就是候选列。
   * 候选列所在区块已加载、列顶方块实心、列顶上面那一格够暗（方块光 0、折算天光不超过
   * `ZOMBIE_SPAWN_MAX_SKY_LIGHT`），就在那一格、列的中心生成一只；列顶之上本来就是空气，身位
   * 两格因此都空着。列的中心离玩家的水平距离也要在 24 到 48 格之间：取整到列上会偏出去不到一格。
   * 列顶在世界最高一层时不生成：上面那一格在光照数组之外，方块光读作 0，炉顶照不亮。
   * 哪一条不满足，这一次就放弃，不另选一列重试。和平下一次都不试。
   *
   * 不看是不是夜晚：白天露天折算天光 15，不生成；黄昏减量取整到 8 时露天折算天光降到 7，从这时起
   * 生成。看的是候选列，不是玩家脚下那一列：玩家头顶盖着东西不影响生成。候选列也只看列顶：白天屋顶
   * 底下折算天光是 0，但列顶是屋顶，屋顶上面那格折算天光 15，不生成。
   *
   * 列顶是地表植物时跳过它看下面那一格（#80，CONTEXT.md「生成」）：僵尸生成在植物那一格里，长满矮草的平原照样生成。
   * 只跳过植物，不跳过一切不实心方块：列顶是水时照旧放弃，不会跳过水生成在水底。
   */
  spawnNaturally(tick: number, player: Vec3, skyDarkening: number): void {
    if (!this.hostile) return;
    if (this.list.length >= ZOMBIE_MAX_COUNT || tick % ZOMBIE_SPAWN_INTERVAL !== 0) return;
    const angle = this.roll(SPAWN_SALT, tick, 0) * TAU;
    const reach =
      ZOMBIE_SPAWN_MIN_DISTANCE +
      this.roll(SPAWN_SALT, tick, 1) * (ZOMBIE_SPAWN_MAX_DISTANCE - ZOMBIE_SPAWN_MIN_DISTANCE);
    const bx = Math.floor(player.x + Math.cos(angle) * reach);
    const bz = Math.floor(player.z + Math.sin(angle) * reach);
    const at = { x: bx + 0.5, y: 0, z: bz + 0.5 };
    if (!isInLoadedChunk(this.blocks, at)) return;
    const away = Math.hypot(at.x - player.x, at.z - player.z);
    if (away < ZOMBIE_SPAWN_MIN_DISTANCE || away > ZOMBIE_SPAWN_MAX_DISTANCE) return;
    let top = this.blocks.highestBlockY(bx, bz);
    if (isPlant(this.blocks.getBlock(bx, top, bz))) top--;
    if (!isSolid(this.blocks.getBlock(bx, top, bz))) return;
    if (top + 1 > WORLD_MAX_Y) return;
    if (!this.isDarkEnough(bx, top + 1, bz, skyDarkening)) return;
    this.spawnAt({ ...at, y: top + 1 });
  }

  /** (x, y, z) 那一格暗得足以生成吗：方块光 0，按 skyDarkening 折算的天光不超过 `ZOMBIE_SPAWN_MAX_SKY_LIGHT`。 */
  private isDarkEnough(x: number, y: number, z: number, skyDarkening: number): boolean {
    if (this.blocks.blockLightAt(x, y, z) > 0) return false;
    return effectiveSkyLight(this.blocks.skyLightAt(x, y, z), skyDarkening) <= ZOMBIE_SPAWN_MAX_SKY_LIGHT;
  }

  /**
   * 视线最先碰到的那一只活着的僵尸（碰撞箱求交，`raycastBox`）。死了还没移除的不算：它们这一 tick
   * 结束前就会消失。
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): EntityHit | undefined {
    let nearest: EntityHit | undefined;
    for (const zombie of this.list) {
      if (zombie.dead) continue;
      const distance = raycastBox(origin, direction, zombie.hitbox, maxDistance);
      if (distance === undefined || (nearest && nearest.distance <= distance)) continue;
      nearest = { id: zombie.id, distance };
    }
    return nearest;
  }

  /**
   * 玩家在 attacker 打了编号 id 的那只一下，伤害 damage，这是第 now 个 tick。attacker 是玩家的
   * 眼睛位置，击退只用它的水平分量。
   * 返回这一下生效了没有：还在受击后的无敌时间里、已经死了、没有这只时都不生效。
   *
   * 生效时扣血、被击退（`knockbackFrom`）。生命归零不当场移除，等 `step` 结算掉落：玩家的攻击排在
   * 僵尸推进之前，同一 tick 里就结算了。
   */
  hitByPlayer(id: number, damage: number, attacker: Vec3, now: number): boolean {
    const zombie = this.list.find((candidate) => candidate.id === id);
    return zombie ? zombie.hitByPlayer(damage, now, attacker) : false;
  }

  /**
   * 推进一个 tick。`tick` 是核心的 tick 计数，游走与掉落的哈希、出手的间隔、燃烧的节奏要用它；
   * `player` 是玩家，追击与消失按它的位置算，走完这一步够得着就打它；`night` 是此刻是不是夜晚，
   * 白天露天（脚底那格天光 15）才燃烧。
   *
   * 已经死了的（被玩家打死的）最先结算：在它此刻所在的那一格掉落，然后移除，不再走这一步。再判消失，
   * 然后走：走这一步之前离玩家正好 64 格的不消失，哪怕这一步会让它远出去一点。原地等区块排在选方向
   * 之前，等着的那些 tick 里游走的方向与剩余 tick、偏航都不动。走完再判燃烧：露天与否按这一 tick 走完
   * 之后的位置算，与渲染层画出来的位置一致。摔落（走的那一步里）与燃烧扣完血再判一次死亡，死了当场
   * 结算，不等下一 tick：掉落落在它挨最后一下的那一格，腐肉件数的哈希用的也是这一 tick。出手排在最后，
   * 死了的不出手，原地等着的照样出手：出手不读方块。
   *
   * 和平下全部按消失移除，排在一切之前：不掉腐肉、不给经验，也不再出手。
   */
  step(tick: number, player: ZombieTarget, night: boolean): void {
    const at = player.position;
    stepEntities(this.list, (zombie) => {
      if (!this.hostile) return false;
      if (zombie.dead) return this.die(zombie, tick);
      if (!isInLoadedChunk(this.blocks, zombie.position)) return false;
      if (distance(zombie.position, at) > ZOMBIE_DESPAWN_RANGE) return false;
      if (isBoxInLoadedChunks(this.blocks, zombie.reach)) {
        const walk = zombie.chooseWalk(at, () => this.roll(WANDER_SALT, tick, zombie.id));
        zombie.step(this.blocks, walk, tick);
      } else {
        zombie.hold();
      }
      zombie.burn(!night && this.isOpenSky(zombie.position), tick);
      if (zombie.dead) return this.die(zombie, tick);
      zombie.attack(player, tick, this.attackDamage);
      return true;
    });
  }

  /** position 在露天吗：它所在那一格的天光是 15（见 CONTEXT.md 的「露天」）。 */
  private isOpenSky({ x, y, z }: Vec3): boolean {
    return this.blocks.skyLightAt(x, y, z) === MAX_LIGHT_LEVEL;
  }

  /**
   * 一只僵尸死了：在它所在的那一格掉 0 到 `ZOMBIE_MAX_FLESH` 件腐肉，合成一堆。最后一下伤害是玩家打的，
   * 再掉一个 `ZOMBIE_XP` 点的经验球；烧死、摔死的不给。返回 false，`stepEntities` 据此移除它。
   */
  private die(zombie: Zombie, tick: number): false {
    const { x, y, z } = zombie.position;
    const [bx, by, bz] = [Math.floor(x), Math.floor(y), Math.floor(z)];
    const flesh = hashCoords(this.seed ^ LOOT_SALT, tick, zombie.id) % (ZOMBIE_MAX_FLESH + 1);
    if (flesh > 0) this.drops.spawnInBlock({ item: ItemType.RottenFlesh, count: flesh }, bx, by, bz);
    if (zombie.lastHurtByPlayer) this.experience.spawnInBlock(ZOMBIE_XP, bx, by, bz);
    return false;
  }

  /**
   * 种子加上 salt、第 tick 个 tick、key 的哈希，摊成 [0, 1)。key 区分同一 tick 里的几次取值：游走用僵尸的
   * 编号，生成用 0（角度）与 1（距离）。
   */
  private roll(salt: number, tick: number, key: number): number {
    // hashCoords 给的是 32 位无符号整数，除以 2³² 摊成 [0, 1)。
    return hashCoords(this.seed ^ salt, tick, key) / 0x1_0000_0000;
  }
}

/**
 * 一只僵尸：位置、速度、生命值、偏航、游走的方向与剩余 tick、上次出手的 tick、是否在燃烧、摔落的落差，
 * 以及最后一下伤害是不是玩家打的。
 */
class Zombie implements ZombieView {
  readonly id: number;
  private readonly life = new Health(ZOMBIE_MAX_HEALTH);
  // 与玩家一样存成三个数而不是一个 Vec3：逐轴解算碰撞时每次只改一个分量。
  private x: number;
  private y: number;
  private z: number;
  private prevX: number;
  private prevY: number;
  private prevZ: number;
  private velocityY = 0;
  /**
   * 击退的水平速度，每 tick 乘 `KNOCKBACK_DECAY`。移动的位移另算、没有惯性，两者每 tick 相加。
   * 没被打过时是 `NO_WALK`。
   */
  private knock: HorizontalDelta = NO_WALK;
  private yawAngle = 0;
  private ticks = 0;
  /** 游走时这一 tick 的位移；选中「停下」时是零位移。 */
  private wanderWalk: HorizontalDelta = NO_WALK;
  /**
   * 离下一次重选游走方向还有几 tick。0 表示这一 tick 就选。追击时归零：走出 32 格的那一 tick
   * 当场重选，不接着走追击之前选的那个方向。
   */
  private wanderLeft = 0;
  /** 上一次出手是第几个 tick，不论玩家受没受伤。还没出过手时比任何 tick 都早。 */
  private lastAttack = -Infinity;
  /** 是否在燃烧，每次推进时由 `burn` 重写。 */
  private onFire = false;
  /** 摔落的落差，与玩家同一份。 */
  private readonly fallHeight: FallTracker;
  /**
   * 最后一次生效的伤害是不是玩家打的。死了的时候据此决定给不给经验：玩家打的记为真，燃烧与摔落
   * 记为假。
   */
  private hurtByPlayer = false;

  constructor(id: number, position: Vec3) {
    this.id = id;
    this.x = this.prevX = position.x;
    this.y = this.prevY = position.y;
    this.z = this.prevZ = position.z;
    this.fallHeight = new FallTracker(position.y);
  }

  get age(): number {
    return this.ticks;
  }

  get health(): number {
    return this.life.points;
  }

  get lastHurtTick(): number | undefined {
    return this.life.lastHurtTick;
  }

  get dead(): boolean {
    return this.life.dead;
  }

  get burning(): boolean {
    return this.onFire;
  }

  /** 最后一次生效的伤害是不是玩家打的。还没受过伤是 false。 */
  get lastHurtByPlayer(): boolean {
    return this.hurtByPlayer;
  }

  /**
   * 第 now 个 tick 的燃烧：sunlit（白天且露天）时燃烧标记为真，tick 能被 `ZOMBIE_BURN_INTERVAL` 整除就
   * 扣 `ZOMBIE_BURN_DAMAGE` 点；否则标记为假。
   *
   * 扣血不看受击后的无敌时间，也不开始无敌时间（`hurtIgnoringInvulnerability`）：刚被玩家打过照样烧掉
   * 那一点，烧完也不挡玩家的下一击。按 tick 计数整除而不是各自计时，走进阴影再出来不会把节奏重置。
   */
  burn(sunlit: boolean, now: number): void {
    this.onFire = sunlit;
    if (!sunlit || now % ZOMBIE_BURN_INTERVAL !== 0) return;
    if (this.life.hurtIgnoringInvulnerability(ZOMBIE_BURN_DAMAGE, now)) this.hurtByPlayer = false;
  }

  /**
   * 第 now 个 tick 被在 attacker 的玩家打了 amount 点，返回生效了没有。无敌时间与扣血的规则在
   * `Health`：与玩家同一份，受击后 10 tick 内（含第 10 tick）再打不掉血。生效时水平被推离攻击者，
   * 带一点上抛。
   */
  hitByPlayer(amount: number, now: number, attacker: Vec3): boolean {
    if (!this.life.hurt(amount, now)) return false;
    this.hurtByPlayer = true;
    this.knock = knockbackFrom(attacker, this.position);
    this.velocityY = KNOCKBACK_LIFT;
    return true;
  }

  /**
   * 第 now 个 tick 距上次出手满 `ZOMBIE_ATTACK_INTERVAL` tick、又够得着 target（`reaches`），就出手打它
   * 一下，扣 damage 点。
   *
   * 玩家在无敌时间里或死了，这一下不生效，但照样算出过手，重新等 20 tick，与原版一致：几只同时围上来
   * 打时，掉血的节奏与只有一只时相同，还是每 20 tick 一下。
   */
  attack(target: ZombieTarget, now: number, damage: number): void {
    if (now - this.lastAttack < ZOMBIE_ATTACK_INTERVAL) return;
    if (!this.reaches(target)) return;
    target.hitByZombie(damage, this.position, now);
    this.lastAttack = now;
  }

  /** 打得到 target 吗：水平中心距不超过 `ZOMBIE_ATTACK_RANGE`，碰撞箱的竖直区间重叠（相切不算）。 */
  private reaches({ position, hitbox }: ZombieTarget): boolean {
    if (Math.hypot(position.x - this.x, position.z - this.z) > ZOMBIE_ATTACK_RANGE) return false;
    const { min, max } = this.hitbox;
    return min.y < hitbox.max.y && max.y > hitbox.min.y;
  }

  get yaw(): number {
    return this.yawAngle;
  }

  get position(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }

  get previousPosition(): Vec3 {
    return { x: this.prevX, y: this.prevY, z: this.prevZ };
  }

  get hitbox(): Hitbox {
    return hitboxAt(this.position, ZOMBIE_WIDTH, ZOMBIE_HEIGHT);
  }

  /**
   * 这一 tick 的碰撞可能读到的范围：碰撞箱水平各向外扩一步。一 tick 在每个轴上至多走
   * `ZOMBIE_STEP` 加上击退的速度，所以不必先知道往哪走——判定因此能排在选方向之前。竖直方向
   * 不涉及别的区块，不外扩。
   */
  get reach(): Hitbox {
    const { min, max } = this.hitbox;
    const dx = ZOMBIE_STEP + Math.abs(this.knock.x);
    const dz = ZOMBIE_STEP + Math.abs(this.knock.z);
    return {
      min: { x: min.x - dx, y: min.y, z: min.z - dz },
      max: { x: max.x + dx, y: max.y, z: max.z + dz },
    };
  }

  /**
   * 这一 tick 的水平位移，还没做碰撞；顺带把偏航转向要走的方向。
   *
   * 水平距离 32 格内朝玩家的水平位置直线走，一步不超过剩下的距离，走到玩家脚下就停住。超过 32 格
   * 按游走的方向走，每 60 tick 用 `roll` 重选一次。`roll` 只在重选时调，给出 [0, 1) 的哈希值。
   */
  chooseWalk(player: Vec3, roll: () => number): HorizontalDelta {
    const dx = player.x - this.x;
    const dz = player.z - this.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= ZOMBIE_CHASE_RANGE) {
      this.wanderLeft = 0;
      if (horizontal === 0) return NO_WALK;
      const step = Math.min(ZOMBIE_STEP, horizontal);
      return this.facing({ x: (dx / horizontal) * step, z: (dz / horizontal) * step });
    }

    if (this.wanderLeft === 0) {
      this.wanderWalk = wanderWalkFor(roll());
      this.wanderLeft = ZOMBIE_WANDER_TICKS;
    }
    this.wanderLeft--;
    return this.facing(this.wanderWalk);
  }

  /** 把偏航转向 walk 的方向，原样返回 walk。零位移时偏航不变：停下来还朝着原来的方向。 */
  private facing(walk: HorizontalDelta): HorizontalDelta {
    // 前方是 (−sin 偏航, −cos 偏航)，与玩家一致。
    if (walk.x !== 0 || walk.z !== 0) this.yawAngle = Math.atan2(-walk.x, -walk.z);
    return walk;
  }

  /**
   * 原地停一个 tick：位置、速度、存活 tick 都不变，只把上一个 tick 的位置对齐到现在。
   * 渲染层在两个位置之间插值（ADR-0002），不对齐的话它会一遍遍重放停下之前的最后一步。
   */
  hold(): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
  }

  /**
   * 推进第 now 个 tick：重力与竖直碰撞，再沿两个水平轴各走一步。水平那一步是移动的位移加上击退的速度，
   * 走完击退速度衰减一次。
   *
   * 竖直那一步落地时按落差受摔落伤害，规则与玩家同一条（`fallDamage`），受击后的无敌时间里不生效。
   * 摔死了就停在落点，这一 tick 不再水平走。
   *
   * 水平方向被挡住、脚下踩实、挡住它的那一格上方两格是空气（碰撞箱抬高 1 格再走这一步就走得通）
   * 时起跳。起跳速度在下一 tick 的竖直那一步里生效，与玩家按住跳跃键同一套物理，最高点 1.252 格：
   * 翻得过 1 格高的墙，翻不过 2 格的。
   */
  step(blocks: BlockView, walk: HorizontalDelta, now: number): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.ticks++;

    // 竖直在前、水平在后，与玩家一致：起跳之后身子已经抬到墙顶之上，水平那一步才不再被挡。
    const fall = fallStep(blocks, this.hitbox, this.velocityY);
    this.y = fall.y;
    this.velocityY = fall.velocityY;
    // 落差在竖直这一步之后、水平之前结算，理由与玩家相同（`Player.step`）。摔死的不再水平走：掉落要落在
    // 它落地的那一格，走完这一步可能已经跨进了下一格。
    const fell = this.fallHeight.settle(this.y, isOnGround(blocks, this.hitbox));
    if (this.life.hurt(fallDamage(fell), now)) this.hurtByPlayer = false;
    if (this.life.dead) return;

    // 两个轴分开做碰撞，斜着撞墙时沿着墙滑过去。
    const move = { x: walk.x + this.knock.x, z: walk.z + this.knock.z };
    this.knock = decayedKnockback(this.knock);
    const blockedX = this.walkAlong(blocks, 'x', move.x);
    const blockedZ = this.walkAlong(blocks, 'z', move.z);
    if (!blockedX && !blockedZ) return;
    if (!isOnGround(blocks, this.hitbox)) return;
    // 斜着走进墙角时两个轴都被挡，哪个轴上挡住的只有 1 格高就跳。
    const stepUp =
      (blockedX && this.canStepUp(blocks, 'x', move.x)) ||
      (blockedZ && this.canStepUp(blocks, 'z', move.z));
    if (stepUp) this.velocityY = JUMP_VELOCITY;
  }

  /**
   * 沿一个轴走 delta，返回有没有被挡住。
   *
   * 零位移就一步都不走：`movedAlong` 会把半宽减掉再加回来，浮点上不保证还原成原值，而原地站着
   * 要求位置一个数都不变。
   */
  private walkAlong(blocks: BlockView, axis: 'x' | 'z', delta: number): boolean {
    if (delta === 0) return false;
    const blocked = isBlockedAlong(blocks, this.hitbox, axis, delta);
    this[axis] = movedAlong(blocks, this.hitbox, axis, delta);
    return blocked;
  }

  /** 碰撞箱抬高 1 格之后，沿 axis 走 delta 还会不会被挡：不会就说明挡住的只有 1 格高。 */
  private canStepUp(blocks: BlockView, axis: 'x' | 'z', delta: number): boolean {
    return clearsAfterRising(blocks, { x: this.x, y: this.y, z: this.z }, ZOMBIE_WIDTH, ZOMBIE_HEIGHT, 1, axis, delta);
  }
}

/**
 * 游走一次选中的每 tick 位移：`roll` 落在前三分之一是停下，其余均匀映射成一个水平方向。
 */
function wanderWalkFor(roll: number): HorizontalDelta {
  if (roll < WANDER_STOP_SHARE) return NO_WALK;
  const angle = ((roll - WANDER_STOP_SHARE) / (1 - WANDER_STOP_SHARE)) * TAU;
  return { x: Math.cos(angle) * ZOMBIE_STEP, z: Math.sin(angle) * ZOMBIE_STEP };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
