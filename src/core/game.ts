import { Attack } from './attack';
import { BlockStateKind, BlockType, BlockUse, blockUse, isSolid, type BlockEdit } from './block';
import type { BlockState, BlockStateEntry, BlockStateView } from './block-state';
import type { ChunkView } from './chunk';
import { DEFAULT_SEED, DEFAULT_VIEW_RADIUS, UNLOAD_MARGIN, WORLD_MIN_Y } from './constants';
import { CRAFTING_TABLE_GRID, CraftingGrid, INVENTORY_CRAFTING_GRID } from './crafting-grid';
import { DEFAULT_DIFFICULTY, deletesWorldOnDeath, type Difficulty } from './difficulty';
import { Drops, type DropsView } from './drop';
import { Experience, type ExperienceView } from './experience';
import { stepFurnaces } from './furnace';
import { FurnaceSlots } from './furnace-slots';
import { fallDamage, Health, type HealthView } from './health';
import { INVENTORY_SIZE, Inventory, wrapHotbarSlot, type InventoryView } from './inventory';
import type { ItemType } from './item';
import { InventoryScreen, type InventoryScreenView } from './inventory-screen';
import { IDLE_MINING, Mining, type MiningView } from './mining';
import { placeBlock } from './placement';
import { IDLE_INTENT, Player, type MoveIntent, type PlayerView } from './player';
import type { Snapshot } from './snapshot';
import { streamChunks } from './streaming';
import { createTerrain, type ColumnCoord, type Terrain } from './terrain';
import { effectiveSkyLight, isNightAt, skyDarkeningAt, timeOfDayAt, wrapTimeOfDay } from './time-of-day';
import type { Vec3 } from './vec3';
import { XpOrbs, type XpOrbsView } from './xp-orb';
import { Zombies, type ZombiesView } from './zombie';
import {
  chunkOf,
  World,
  type ChunkCoord,
  type ChunkSource,
  type StaleChunks,
} from './world';

/**
 * 界面上的一下点击：点了第几格、点了输出格，或点了配方书的第几条。
 *
 * 三种点击排进同一条队列而不是三条：「点配方填入材料、点输出格、把成品放到别处」是同一个 tick
 * 里可能连着来的三下，分成几条队列就丢了先后。点的是哪个界面不必记：同一时刻最多开
 * 一个界面，点击就落在开着的那个上。
 */
type ScreenClick =
  | { readonly kind: 'slot'; readonly index: number }
  | { readonly kind: 'split'; readonly index: number }
  | { readonly kind: 'output' }
  | { readonly kind: 'recipe'; readonly index: number };

const OUTPUT_CLICK: ScreenClick = Object.freeze({ kind: 'output' });

export interface GameCoreOptions {
  /** 世界种子。同一种子每次进入得到同样的地形。 */
  readonly seed?: number;
  /** 视距（区块数）：这个半径内的区块保持加载，见 CONTEXT.md 的「视距」。之后可以改，见 `setViewRadius`。 */
  readonly viewRadius?: number;
  /**
   * 自动跳跃（见 CONTEXT.md）是否开启，省略时开（与设置的默认值一致）。之后可以改，见 `setAutoJump`。它是设置里的
   * 一项，不进快照：从快照构造时同样按这里给的值（ADR-0020）。
   */
  readonly autoJump?: boolean;
  /** 难度（见 CONTEXT.md），默认普通。只在新建世界时给；读档时以快照里的为准。 */
  readonly difficulty?: Difficulty;
  /**
   * 从快照构造（ADR-0018）：种子、难度与世界的持续状态都取快照里的，`seed` 与 `difficulty` 不看。快照里的
   * 已改区块要是存档里的全部，构造之后它们的方块数组归核心所有。
   */
  readonly restore?: Snapshot;
  /**
   * 由本世界的种子造出地形对象，默认 `createTerrain`。新建与读档都只调一次，读档时拿到的是快照里的种子。
   * 测试里换成平地那一份地形对象，浏览器里把生成器换成由 Worker 生成区块的来源。
   */
  readonly terrain?: (seed: number) => CoreTerrain;
}

/**
 * 核心接的地形对象：与 `Terrain` 相同，只是生成器可以当场给不出区块（返回 `undefined`，即
 * `ChunkSource`，下一 tick 再问）。浏览器里区块由 Worker 生成，就是这种情形；`Terrain` 可以直接当它用。
 */
export type CoreTerrain = Omit<Terrain, 'generateChunk'> & { readonly generateChunk: ChunkSource };

/**
 * 无头游戏核心：纯 TypeScript，不依赖 Three.js 与 DOM，可在 Node 中直接实例化。
 * 核心层的测试都从这里驱动游戏，渲染与输入适配器也只通过这里的指令和查询读写游戏。
 *
 * 第一切片有「推进时间」「查询/写入方块」「玩家移动」「区块随玩家流式加载」「空手挖掘」
 * 「掉落物与背包」「经验球与等级」「放置方块」「背包界面」九件事，第二切片起加「合成」
 * 与「使用（工作台界面）」，第三切片加「熔炉界面」与「熔炼」，第四切片加「世界时刻」「生命值」
 * 「死亡与重生」「僵尸」与「攻击」，第六切片加「导出快照与从快照构造」（ADR-0018）。别的生物由后续切片挂进 step()。
 */
export class GameCore implements BlockEdit, BlockStateView {
  private readonly world: World;
  private readonly worldSeed: number;
  private readonly worldDifficulty: Difficulty;
  /** 极限难度下玩家死过没有。进快照，读档时放回；死亡那一 tick 置真（`die`）。 */
  private worldHardcoreDead: boolean;
  private radius: number;
  private autoJumpEnabled: boolean;
  private readonly playerState: Player;
  private readonly dropsState: Drops;
  private readonly xpOrbsState: XpOrbs;
  private readonly zombiesState: Zombies;
  private readonly experienceState: Experience;
  private readonly healthState: Health;
  private readonly inventoryState: Inventory;
  private readonly inventoryCraftingGrid: CraftingGrid;
  private readonly inventoryScreenState: InventoryScreen;
  /**
   * 工作台界面（见 CONTEXT.md）：与背包界面同一套实现，只是合成网格是 3x3。
   * 两个界面各持自己的网格，同一时刻最多开一个（`activeScreen`）。
   */
  private readonly craftingTableGrid: CraftingGrid;
  private readonly craftingTableState: InventoryScreen;
  /**
   * 熔炉界面（见 CONTEXT.md）：同一个界面类，附加的是熔炉三格。世界里有几个熔炉都只有这一个界面，
   * 使用键对着哪个熔炉，三格就重绑到哪一条状态（`FurnaceSlots.bind`）。
   */
  private readonly furnaceSlots: FurnaceSlots;
  private readonly furnaceScreenState: InventoryScreen;
  private readonly miningState: Mining;
  private readonly attackState: Attack;
  /** 出生列（见 CONTEXT.md「出生点」），取自地形对象。出生点总在这一列上。 */
  private readonly spawnColumn: ColumnCoord;
  /** 出生列所在的区块。构造时以它为中心先加载，重生时先把它放回世界。 */
  private readonly spawnChunk: ChunkCoord;
  /**
   * 进入世界时的出生点（首次出生点，ADR-0018）。出生列所在区块卸载了又没改过时，出生点就是它：地形是种子的
   * 纯函数（ADR-0003），重新生成出来与进入世界时一样。见 `spawnPoint`。
   */
  private readonly firstSpawn: Vec3;
  private ticks = 0;
  /**
   * 世界时刻相对 tick 计数的偏移（见 `timeOfDayAt`）。进入世界时是 0，所以开局是早晨；
   * 只有 `setTimeOfDay` 改它。
   */
  private timeOffset = 0;
  private intent: MoveIntent = IDLE_INTENT;
  private miningHeld = false;
  /**
   * 上一个 tick 边界以来挖掘键从没按到按下过没有（一次性输入，ADR-0004）。攻击按它分派（ADR-0015）：
   * 两个 tick 之间按下又松开的一下也算。
   */
  private miningPressQueued = false;
  private chainHeld = false;
  /**
   * 下一个 tick 生效的选中格。数字键写绝对值，滚轮在它上面加减（ADR-0004：改变持续
   * 状态的输入转换成意图，等 tick 边界生效）。
   */
  private nextSlot = 0;
  /*
   * 下面三样是同一个 tick 里到达的一次性输入。折法各不相同，取决于「同一 tick 里来两下
   * 是什么意思」——三者都在 tick 边界消费（ADR-0004）：
   *
   * - 使用归并成一个布尔：一次点击放一块（或开一次界面），两下也只算一下，与原版一致。
   * - 背包开合异或抵消：一开一关，界面状态没有净变化。
   * - 点格子与点输出格排队重放：「拿起再放到别处」本来就是两下，合成一下就丢了一半意思。
   */
  /** 这一 tick 里按过使用键没有。 */
  private useQueued = false;
  /** 这一 tick 里按过背包键没有。 */
  private toggleQueued = false;
  /** 这一 tick 里在界面上点过哪些地方（格子、输出格与配方书），按点击顺序。 */
  private readonly screenClicks: ScreenClick[] = [];

  constructor(options: GameCoreOptions = {}) {
    const restore = options.restore;
    this.worldSeed = restore?.seed ?? options.seed ?? DEFAULT_SEED;
    this.worldDifficulty = restore?.difficulty ?? options.difficulty ?? DEFAULT_DIFFICULTY;
    this.worldHardcoreDead = restore?.hardcoreDead ?? false;
    this.radius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    this.autoJumpEnabled = options.autoJump ?? true;
    // 支撑没了的火把与花交给掉落物（`World.dropDetached`）。掉落物要拿世界算碰撞，比世界晚建，
    // 所以这里传一个转发给掉落物的函数。世界在这个构造函数里只加载区块、不写方块，调用到它时掉落物已经建好。
    const terrain = (options.terrain ?? createTerrain)(this.worldSeed);
    this.spawnColumn = terrain.spawnColumn;
    this.spawnChunk = { cx: chunkOf(this.spawnColumn.x), cz: chunkOf(this.spawnColumn.z) };
    this.world = new World(terrain.generateChunk, {
      spawnInBlock: (stack, x, y, z) => this.dropsState.spawnInBlock(stack, x, y, z),
    });
    if (restore) {
      // 读档：已改区块先进已改区块表再流式加载，加载时就复用它们。加载的是玩家周围；出生点取快照里的，
      // 出生列这时可能还没加载，按「未加载即空气」重算就错了。
      this.world.restore(restore.editedChunks, restore.blockStates);
      this.firstSpawn = restore.firstSpawn;
      this.playerState = new Player(this.world, this.firstSpawn);
      this.playerState.restore(restore.player);
      streamChunks(this.world, this.playerChunk, this.radius);
    } else {
      // 出生点要先有地形才算得出来，所以先加载出生列所在区块周围，玩家最后造。
      // 来源当场给不出区块时（浏览器里 Worker 还在生成）这里只加载得到已经就绪的那些，
      // 其余由 tick 补上——所以浏览器那一侧要先等出生列周围的区块已就绪，见 src/world-session.ts。
      streamChunks(this.world, this.spawnChunk, this.radius);
      this.firstSpawn = this.spawnColumnTop();
      this.playerState = new Player(this.world, this.firstSpawn);
    }
    this.dropsState = new Drops(this.world, this.worldSeed);
    this.xpOrbsState = new XpOrbs();
    // 僵尸死了在原地掉腐肉、被玩家打死的还掉经验球：与挖掘同一条路交给掉落物与经验球。生不生成、
    // 打一下扣几点按难度。
    this.zombiesState = new Zombies(
      this.world,
      this.worldSeed,
      this.dropsState,
      this.xpOrbsState,
      this.worldDifficulty,
    );
    this.experienceState = new Experience();
    this.healthState = new Health();
    this.inventoryState = new Inventory();
    this.inventoryCraftingGrid = new CraftingGrid(INVENTORY_CRAFTING_GRID);
    this.inventoryScreenState = new InventoryScreen(this.inventoryState, this.inventoryCraftingGrid);
    this.craftingTableGrid = new CraftingGrid(CRAFTING_TABLE_GRID);
    this.craftingTableState = new InventoryScreen(this.inventoryState, this.craftingTableGrid);
    // 从成品格取走成品时结算的经验，与挖掘给的经验走同一条路：生成经验球，飞向玩家。
    this.furnaceSlots = new FurnaceSlots(this.xpOrbsState);
    this.furnaceScreenState = new InventoryScreen(this.inventoryState, this.furnaceSlots);
    // 挖掘要看手上的工具、还要让它损耗耐久：背包既是「手」也是收物品的地方。僵尸挡在视线上时
    // 挖掘没有目标。
    this.miningState = new Mining(
      this.world,
      this.playerState,
      this.inventoryState,
      this.dropsState,
      this.xpOrbsState,
      this.zombiesState,
    );
    this.attackState = new Attack(
      this.world,
      this.playerState,
      this.inventoryState,
      this.zombiesState,
    );
    if (restore) this.restoreFrom(restore);
  }

  /**
   * 世界的持续状态从快照放回：tick 计数与时刻偏移、三个编号、玩家的生命值与经验与背包、掉落物与经验球。
   * 已改区块、状态表与玩家的位置在构造函数里先放回了：流式加载与出生点要用它们。没放回的取初始值（`Snapshot`）。
   */
  private restoreFrom(restore: Snapshot): void {
    const { player } = restore;
    this.ticks = restore.ticks;
    this.timeOffset = restore.timeOffset;
    this.dropsState.restore(restore.nextDropId, restore.drops);
    this.xpOrbsState.restore(restore.nextXpOrbId, restore.xpOrbs);
    this.zombiesState.restoreNextId(restore.nextZombieId);
    this.healthState.restore(player.health, player.lastHurtTick ?? undefined);
    this.experienceState.gain(player.experience);
    player.inventory.forEach((stack, i) => this.inventoryState.setSlot(i, stack ?? undefined));
    this.inventoryState.select(player.selectedSlot);
    this.nextSlot = this.inventoryState.selectedSlot;
  }

  /**
   * 导出快照（ADR-0018）：普通对象加 `Uint8Array`，之后世界怎么变都不影响它。
   *
   * 已改区块只带上次写盘之后改过的那些，取走即清空（`returnUnsavedChunks` 在写盘失败时放回），取快照的同步
   * 耗时因此与改过的区块数成正比。界面、光标物品与合成网格不进快照，调用方先调 `closeAllScreens`，
   * 不然光标与网格里的东西就丢了。
   */
  snapshot(): Snapshot {
    const health = this.healthState;
    return {
      seed: this.worldSeed,
      difficulty: this.worldDifficulty,
      hardcoreDead: this.worldHardcoreDead,
      firstSpawn: { ...this.firstSpawn },
      ticks: this.ticks,
      timeOffset: this.timeOffset,
      nextDropId: this.dropsState.nextDropId,
      nextZombieId: this.zombiesState.nextZombieId,
      nextXpOrbId: this.xpOrbsState.nextXpOrbId,
      player: {
        ...this.playerState.snapshot(),
        health: health.points,
        lastHurtTick: health.lastHurtTick ?? null,
        experience: this.experienceState.total,
        inventory: Array.from({ length: INVENTORY_SIZE }, (_, i) => this.inventoryState.slot(i) ?? null),
        selectedSlot: this.inventoryState.selectedSlot,
      },
      drops: this.dropsState.snapshot(),
      xpOrbs: this.xpOrbsState.snapshot(),
      blockStates: this.world.blockStateRecords(),
      editedChunks: this.world.takeUnsavedChunks(),
    };
  }

  /**
   * 写盘失败时把那次快照里的已改区块放回「上次写盘之后改过的」集合，下次写盘再写（ADR-0018）。给的是那次
   * 快照的 `editedChunks`，或只是它们的坐标。
   */
  returnUnsavedChunks(coords: readonly ChunkCoord[]): void {
    this.world.returnUnsavedChunks(coords);
  }

  /**
   * 上次写盘之后改过的区块有几个（取快照时清零，写盘失败放回时加回来）。外层据此判断离开页面时要不要确认。
   */
  get unsavedChunkCount(): number {
    return this.world.unsavedChunkCount;
  }

  /** 本世界的难度。新建时定，之后不变。死亡画面按它决定给重生还是删除世界。 */
  get difficulty(): Difficulty {
    return this.worldDifficulty;
  }

  /**
   * 极限难度下玩家死过没有（见 CONTEXT.md「死亡画面」）。死亡那一 tick 由假变真，之后不再变回去，快照的
   * `hardcoreDead` 就是它。核心只给出标记：外层在每个 tick 之后读它，由假变真时写一次盘，世界列表据此
   * 只给这个世界留删除。非极限的世界一直是假。
   */
  get hardcoreDead(): boolean {
    return this.worldHardcoreDead;
  }

  /** 玩家状态的只读视图。渲染层读它摆相机，改状态只能通过下面几个指令。 */
  get player(): PlayerView {
    return this.playerState;
  }

  /** 挖掘状态的只读视图：目标方块、命中面与进度。渲染层读它画选框与裂纹。 */
  get mining(): MiningView {
    return this.miningState;
  }

  /** 世界里现有的掉落物，只读。渲染层每帧读它摆那些漂浮旋转的小方块。 */
  get drops(): DropsView {
    return this.dropsState;
  }

  /** 世界里现有的经验球，只读。渲染层每帧读它摆那些飞向玩家的小方块。 */
  get xpOrbs(): XpOrbsView {
    return this.xpOrbsState;
  }

  /**
   * 上一次按下左键是第几个 tick，不论打中了什么，还没按过是 undefined。渲染层据此让手持物品挥动
   * 一下；按住挖掘时的持续挥动看 `mining.digging`。
   */
  get lastSwingTick(): number | undefined {
    return this.attackState.lastSwingTick;
  }

  /** 世界里现有的僵尸，只读。渲染层每帧读它摆人形模型。 */
  get zombies(): ZombiesView {
    return this.zombiesState;
  }

  /** 玩家的经验与等级，只读。HUD 读它画等级条。 */
  get experience(): ExperienceView {
    return this.experienceState;
  }

  /**
   * 玩家的生命值，只读。HUD 读它画心与受伤红闪。
   *
   * 与背包、经验一样是核心的状态而不是界面层的：扣多少、什么时候回、归零算不算死都是游戏规则。
   */
  get health(): HealthView {
    return this.healthState;
  }

  /** 玩家背包的只读视图。HUD 读它画快捷栏。 */
  get inventory(): InventoryView {
    return this.inventoryState;
  }

  /**
   * 背包界面的只读视图：开着没有、光标上拿着什么、合成网格与输出格里是什么。界面层读它画
   * 那层覆盖层。
   *
   * 「界面开着没有」是核心状态而不是界面层自己的一个布尔：它一开，移动、视角、挖掘、
   * 放置就都不算数了（见 `step`），这是游戏规则。
   */
  get inventoryScreen(): InventoryScreenView {
    return this.inventoryScreenState;
  }

  /**
   * 工作台界面的只读视图：开着没有、光标上拿着什么、那块 3x3 网格与输出格里是什么。
   * 只能由使用键对着工作台（`use`）打开，按背包键关闭。
   */
  get craftingTableScreen(): InventoryScreenView {
    return this.craftingTableState;
  }

  /**
   * 熔炉界面的只读视图：开着没有、光标上拿着什么、熔炉三格里是什么、两条进度条多长。
   * 只能由使用键对着熔炉（`use`）打开，按背包键关闭。三格是最近一次打开的那个熔炉的。
   */
  get furnaceScreen(): InventoryScreenView {
    return this.furnaceScreenState;
  }

  /**
   * 这一刻是界面模式吗（见 CONTEXT.md）——有界面开着、或者在死亡画面上就是。
   *
   * 问的是「有没有界面开着」而不是「背包界面开着没有」：移动、视角、挖掘、使用那几处
   * 判定只看这一个答案，再加一种界面也不必改它们。界面层与输入层也读它：准星藏不藏、
   * 底部那一栏收不收、鼠标要不要交还页面，看的都是「有没有界面开着」。
   *
   * 死亡画面也算，但它不是 `activeScreen` 里的一个界面：它没有格子可点，背包键关不掉它，
   * 只有 `respawn` 让它退出。死了没有与生命值归零是同一件事，所以直接看 `health.dead`。
   */
  get uiMode(): boolean {
    return this.activeScreen !== undefined || this.healthState.dead;
  }

  /** 此刻开着的那个界面，一个都没开时 undefined。同一时刻最多开一个。 */
  private get activeScreen(): InventoryScreen | undefined {
    if (this.inventoryScreenState.open) return this.inventoryScreenState;
    if (this.craftingTableState.open) return this.craftingTableState;
    if (this.furnaceScreenState.open) return this.furnaceScreenState;
    return undefined;
  }

  /**
   * 设定当前的移动意图，下一个 tick 生效。
   * 输入适配器每次按键状态变化时调一次，核心因此不知道任何键位。
   */
  setMoveIntent(intent: MoveIntent): void {
    this.intent = intent;
  }

  /**
   * 设定挖掘键按着没有，下一个 tick 生效。
   * 与移动意图同一条路：它改变的是持续状态，不是「看向哪里」——见 ADR-0004。
   *
   * 从没按到按下的那一次还排成一次按下，同样在下一个 tick 生效：攻击按它分派（ADR-0015），
   * 下一个 tick 之前就松开了也不丢。
   */
  setMining(held: boolean): void {
    if (held && !this.miningHeld) this.miningPressQueued = true;
    this.miningHeld = held;
  }

  /**
   * 设定连锁键按着没有，下一个 tick 生效。与 `setMining` 同一条路（ADR-0004）。
   *
   * 它只在开始挖掘那一 tick 起作用：那一 tick 按着就进连锁，之后按下去不算数，
   * 中途松开则退出连锁接着挖单块。规则在 `Mining.step` 里。
   */
  setChainMining(held: boolean): void {
    this.chainHeld = held;
  }

  /**
   * 转动视角（弧度增量）。不等 tick，鼠标一动就生效——见 ADR-0004。
   * 界面模式下不转：那时鼠标已经交还给页面，它在点格子，不是在转头。
   */
  turn(yawDelta: number, pitchDelta: number): void {
    if (this.uiMode) return;
    this.playerState.turn(yawDelta, pitchDelta);
  }

  /**
   * 选中快捷栏的第 index 格（0 起），下一个 tick 生效。
   * 越界的下标由 `Inventory.select` 折回范围内，那里是折返规则的唯一出处。
   */
  selectHotbarSlot(index: number): void {
    this.nextSlot = index;
  }

  /**
   * 沿快捷栏挪 delta 格，下一个 tick 生效。正是往右，转到头从另一端接着来。
   *
   * 输入适配器把滚轮的滚动量换算成 ±1 交给这里：滚了多少像素是输入的事，一格一格地走
   * 是游戏规则。同一个 tick 里滚三下就是挪三格。
   */
  scrollHotbar(delta: number): void {
    this.nextSlot = wrapHotbarSlot(this.nextSlot + delta);
  }

  /**
   * 使用（见 CONTEXT.md、ADR-0009）：目标方块是可使用方块（工作台、熔炉）就打开它的界面，
   * 不看手上拿的是什么；否则把手上那一堆的一个放到目标方块的相邻面上。按一次使用键调一次。
   *
   * 与 `setMining` 同一条路，下一个 tick 生效（ADR-0004）。同一个 tick 里按两次也只算
   * 一下——一次点击放一块，与原版一致。放不下去（那一格不是空气、会跟玩家撞上、
   * 手上不是方块物品）时什么都不发生，规则在 `placeBlock` 里。界面开着时这一下作废。
   */
  use(): void {
    this.useQueued = true;
  }

  /**
   * 按背包键，下一个 tick 生效（ADR-0004）：有界面开着就关掉它（不管是哪一个），
   * 一个都没开就打开背包界面。工作台界面与熔炉界面因此关得掉、开不了——它们只由 `use` 打开。
   *
   * 同一个 tick 里按两次相互抵消：一开一关，界面状态没有净变化。关闭时光标上与合成网格
   * 里还有东西的话，它们退回背包，一格都放不下的那些掉在玩家脚下（`InventoryScreen.toggle`）；
   * 熔炉三格里的东西留在熔炉里，不退回。
   */
  toggleInventory(): void {
    this.toggleQueued = !this.toggleQueued;
  }

  /**
   * 点开着的那个界面的第 index 格，下一个 tick 生效（ADR-0004）。
   *
   * 同一个 tick 里点几下就按点的顺序处理几下，一下都不丢——「拿起再放到别处」本来
   * 就是两下点击，合成一下就丢了一半的意思。界面关着时点了没有反应。
   */
  clickSlot(index: number): void {
    this.screenClicks.push({ kind: 'slot', index });
  }

  /**
   * 拆堆点击开着的那个界面的第 index 格，下一个 tick 生效（ADR-0004）。与点格子排在同一条
   * 队列里，按点击先后生效。拿起半堆、放下 1 个的规则在 `InventoryScreen.splitSlot` 里。
   *
   * 这是一条独立的界面指令，由界面层从右键事件翻译过来，与世界里的「使用」（`use`）无关：
   * 界面开着时使用作废，右键落在格子上是拆堆；界面关着时右键是使用，拆堆点了没有反应。
   */
  splitSlot(index: number): void {
    this.screenClicks.push({ kind: 'split', index });
  }

  /**
   * 点开着的那个界面的输出格，下一个 tick 生效（ADR-0004）。与点格子排在同一条队列里，
   * 先后顺序照点击的来。成品到光标上、材料各减 1 的规则在 `InventoryScreen.clickOutput` 里。
   */
  clickCraftingOutput(): void {
    this.screenClicks.push(OUTPUT_CLICK);
  }

  /**
   * 点开着的那个界面的配方书第 index 条，下一个 tick 生效（ADR-0004）。与点格子、点输出格
   * 排在同一条队列里。填入材料的规则在 `InventoryScreen.clickRecipe` 里。
   */
  clickRecipe(index: number): void {
    this.screenClicks.push({ kind: 'recipe', index });
  }

  /**
   * 重生：回到出生点，血回满，退出死亡画面。立即生效。没死时什么都不做。
   *
   * 由界面层的重生按钮调。极限难度下死了不能重生（死亡画面上没有这颗按钮），这里也什么都不做。看的是
   * 难度而不是已死亡标记：标记只在死亡那一 tick 置真，这条规则之前存下的极限死亡快照里它是假。
   *
   * 死亡期间积累的输入一并作废：按着的移动键、挖掘键、连锁键、切过的选中格，以及还没到 tick
   * 边界的使用键、背包键与界面点击。死亡画面上这些输入都不生效，重生之后也不该接着生效。
   * 重生时背包是空的——东西都掉在死亡处了。
   *
   * 立即生效而不是等下一个 tick（ADR-0004 的例外，理由写在那里）：按钮按下时输入层当场抓回指针
   * 锁定，而死亡画面期间输入层会把锁定释放掉（`PlayerControls.sync`）。等到下一个 tick，刚抓回的
   * 锁定就被放掉了。
   */
  respawn(): void {
    if (!this.healthState.dead || deletesWorldOnDeath(this.worldDifficulty)) return;
    // 出生列所在区块改过又卸载了，要先放回世界：出生点按改过之后的方块算。没改过又还没传来的，
    // 出生点就是进入世界时那一个（`spawnPoint`），玩家在那里等区块送到（ADR-0013）。
    this.world.loadChunk(this.spawnChunk.cx, this.spawnChunk.cz);
    this.playerState.respawnAt(this.spawnPoint);
    this.healthState.reset();
    this.intent = IDLE_INTENT;
    this.miningHeld = false;
    this.miningPressQueued = false;
    this.chainHeld = false;
    this.nextSlot = this.inventoryState.selectedSlot;
    this.useQueued = false;
    this.toggleQueued = false;
    this.screenClicks.length = 0;
  }

  /**
   * 关闭全部界面，立即生效（ADR-0004 的第二个例外，见那篇补记）：开着的界面按背包键关闭的规则关掉，光标
   * 物品退回原格，合成网格里的退回背包，放不下的掉在玩家脚下；熔炉三格里的留在熔炉里。没有界面开着时
   * 什么都不做。取快照之前与页面隐藏时调：之后不再有 tick，排队的背包键不会生效。
   *
   * 关掉时排着的背包键与界面点击一并作废：它们是冲着刚关掉的那个界面来的，下一个 tick 生效的话，背包键会
   * 把背包界面重新打开。
   */
  closeAllScreens(): void {
    const active = this.activeScreen;
    if (!active) return;
    for (const stack of active.toggle()) this.dropsState.spawnAt(stack, this.playerState.position);
    this.toggleQueued = false;
    this.screenClicks.length = 0;
  }

  /**
   * 往背包里放 count 个 item，立即生效，返回装不下的数量。按物品进背包的规则放（`Inventory.add`）：
   * 先并进同一类型的未满堆，再占空格。
   *
   * 与 `setTimeOfDay` 一样是给测试用的公开指令：测试用它备好背包，不必先挖掘再合成。
   */
  giveItem(item: ItemType, count: number): number {
    return this.inventoryState.add({ item, count });
  }

  /**
   * 在 (x, y, z)（碰撞箱底面中心）生成一只僵尸，立即生效。不看那里是不是实心、是不是夜晚，
   * 也不数已经有几只。
   *
   * 与 `giveItem`、`setTimeOfDay` 一样是给测试用的公开指令，调试句柄与测试都走它。
   */
  spawnZombieAt(x: number, y: number, z: number): void {
    this.zombiesState.spawnAt({ x, y, z });
  }

  /** 本世界的种子。地形完全由它决定，端到端测试用它断言「同一种子同一个世界」。 */
  get seed(): number {
    return this.worldSeed;
  }

  /** 已推进的 tick 数。世界时间只由 tick 决定，与真实时钟无关。 */
  get tickCount(): number {
    return this.ticks;
  }

  /**
   * 世界时刻（见 CONTEXT.md）：一天里的第几个 tick，落在 [0, 24000)。进入世界时是 0（早晨），
   * 每 tick 加 1，满一天折回 0。渲染层按它调亮度、天空色与太阳月亮的位置。
   */
  get timeOfDay(): number {
    return timeOfDayAt(this.ticks, this.timeOffset);
  }

  /** 此刻是不是夜晚。分界见 `isNightAt`。 */
  get isNight(): boolean {
    return isNightAt(this.timeOfDay);
  }

  /**
   * 把世界时刻拨到 t，立即生效。超出一天的值与负值按一天折回。
   *
   * 与 `tick(n)` 一样是普通的公开指令，调试句柄与测试都走它。它改的是时刻相对 tick 计数的
   * 偏移，tick 计数不动：之后每 tick 时刻照样加 1，其他按 tick 计数走的系统不受影响。
   */
  setTimeOfDay(t: number): void {
    this.timeOffset = wrapTimeOfDay(t - this.ticks);
  }

  /** 推进 n 个 tick（默认 1）。n ≤ 0 时什么都不做。 */
  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.step();
    }
  }

  getBlock(x: number, y: number, z: number): BlockType {
    return this.world.getBlock(x, y, z);
  }

  setBlock(x: number, y: number, z: number, block: BlockType): boolean {
    return this.world.setBlock(x, y, z, block);
  }

  /**
   * (x, y, z) 那一格的方块状态（见 CONTEXT.md 的「方块状态」），没有的返回 undefined。
   *
   * 给出的是状态表里那一条本身，不是副本：调试句柄与测试往熔炉里放东西走的就是这条路；
   * 游戏里改它的是熔炉界面与熔炼状态机（`stepFurnaces`）。
   */
  blockStateAt(x: number, y: number, z: number): BlockState | undefined {
    return this.world.blockStateAt(x, y, z);
  }

  /** 方块状态表里有几条。 */
  get blockStateCount(): number {
    return this.world.blockStateCount;
  }

  /** 整张方块状态表，每一条带着坐标。调试句柄读它。 */
  allBlockStates(): BlockStateEntry[] {
    return this.world.allBlockStates();
  }

  /**
   * 取走「哪些区块的网格过期了」的记录并清空，方块变了的与只有光照变了的分两组。渲染层每帧取一次，重建其中
   * 已有网格的那些。哪些区块算过期由世界在 `setBlock` 与光照传播时定（见 `World.takeStaleChunks`）。
   */
  takeStaleChunks(): StaleChunks {
    return this.world.takeStaleChunks();
  }

  /** (x, y, z) 那一格的天光等级（见 CONTEXT.md 的「天光」），没加载的格子读作 0。见 `World.skyLightAt`。 */
  skyLightAt(x: number, y: number, z: number): number {
    return this.world.skyLightAt(x, y, z);
  }

  /** (x, y, z) 那一格的方块光等级（见 CONTEXT.md 的「方块光」），没加载的格子读作 0。见 `World.blockLightAt`。 */
  blockLightAt(x: number, y: number, z: number): number {
    return this.world.blockLightAt(x, y, z);
  }

  /**
   * 此刻的天光减量（见 CONTEXT.md 的「折算天光」），取整到最近的整数：规则按等级判断，
   * 所以是逐级的。渲染层要连续的画面，自己按插值后的时刻算浮点值（`skyDarkeningAt`）。
   */
  get skyDarkening(): number {
    return Math.round(skyDarkeningAt(this.timeOfDay));
  }

  /** (x, y, z) 那一格的折算天光：天光减去此刻的减量，不低于 0。 */
  effectiveSkyLightAt(x: number, y: number, z: number): number {
    return effectiveSkyLight(this.skyLightAt(x, y, z), this.skyDarkening);
  }

  /**
   * 某一列最高的非空气方块的 y。整列都是空气（或区块未加载）时返回世界底面之下一格。
   *
   * 注意它不是「地表高度」：地表高度是地形生成给出的地面，不随挖掘与放置变化，
   * 由地形对象的 `surfaceHeightAt` 回答。这里问的是那一列现在实际堆到了多高，
   * 出生点与僵尸的生成要的是这个。水、火把与地表植物也是非空气方块：长着植物的列报的是植物那一格，
   * 要找脚下的地面得往下跳过不实心的方块（出生点见 `spawnColumnTop`，僵尸只跳过植物，见 `Zombies.spawnNaturally`）。
   */
  highestBlockY(x: number, z: number): number {
    return this.world.highestBlockY(x, z);
  }

  get loadedChunkCount(): number {
    return this.world.loadedChunkCount;
  }

  loadedChunks(): ChunkCoord[] {
    return this.world.loadedChunks();
  }

  isChunkLoaded(cx: number, cz: number): boolean {
    return this.world.isChunkLoaded(cx, cz);
  }

  /** 已加载的区块，未加载则 undefined。渲染层建网格时直读它的方块数据。 */
  chunkAt(cx: number, cz: number): ChunkView | undefined {
    return this.world.chunkAt(cx, cz);
  }

  /** 视距（区块数）。渲染层每帧读它决定网格的范围。 */
  get viewRadius(): number {
    return this.radius;
  }

  /**
   * 改视距（见 CONTEXT.md 的「视距」、ADR-0020）：改小时超出范围的区块当场卸载，卸载线照旧比视距多留
   * `UNLOAD_MARGIN` 环；改大时缺的区块从下一个 tick 起按平时的节奏加载。设置界面开在暂停菜单上，那时不推进
   * tick，所以卸载不等 tick。不是非负整数时抛错：视距的取值范围是设置界面的事，这里只拒绝写错的调用。
   */
  setViewRadius(radius: number): void {
    if (!Number.isInteger(radius) || radius < 0) throw new RangeError(`视距应为非负整数，收到 ${radius}`);
    this.radius = radius;
    this.world.unloadOutside(this.playerChunk, radius + UNLOAD_MARGIN);
  }

  /** 自动跳跃（见 CONTEXT.md）是否开启。 */
  get autoJump(): boolean {
    return this.autoJumpEnabled;
  }

  /**
   * 开关自动跳跃（ADR-0020）：设置改动经订阅调这里，与视距（`setViewRadius`）同一种写法。只记下开关，下一个 tick
   * 的移动起按新值判断。
   */
  setAutoJump(enabled: boolean): void {
    this.autoJumpEnabled = enabled;
  }

  /** 玩家所在的区块。加载与卸载都以它为中心。 */
  get playerChunk(): ChunkCoord {
    const { x, z } = this.playerState.position;
    return { cx: chunkOf(Math.floor(x)), cz: chunkOf(Math.floor(z)) };
  }

  /**
   * 出生点：出生列（地形对象的 `spawnColumn`）最高实心方块的顶面，落在方块中心。重生也回到这里。
   *
   * 从最高的非空气方块（`highestBlockY`）往下跳过不实心的方块：火把（#56）、地表植物（#80）。玩家穿得过它们，站在火把顶上
   * 就会掉下去，插在高处墙上的一支足以让重生摔死。树冠是实心的，会把出生点抬到树冠的高度，所以
   * 出生点周围不长树，见 `TREE_SPAWN_CLEARANCE`。
   *
   * 出生列所在区块没加载时读不出那一列（「未加载即空气」），就用进入世界时的出生点。这时那个区块一定
   * 没改过：改过的区块卸载后仍留在世界里（ADR-0008），`respawn` 先把它放回来再问这里。
   */
  get spawnPoint(): Vec3 {
    if (!this.world.isChunkLoaded(this.spawnChunk.cx, this.spawnChunk.cz)) return this.firstSpawn;
    return this.spawnColumnTop();
  }

  /** 出生列此刻最高实心方块的顶面中心。 */
  private spawnColumnTop(): Vec3 {
    const { x, z } = this.spawnColumn;
    let y = this.highestBlockY(x, z);
    while (y >= WORLD_MIN_Y && !isSolid(this.world.getBlock(x, y, z))) y--;
    return { x: x + 0.5, y: y + 1, z: z + 0.5 };
  }

  /** 一个 tick 的全部逻辑。 */
  private step(): void {
    this.ticks++;
    // 先让区块跟上玩家再算物理：玩家脚下的地形必须已经在世界里，否则他会踩进
    // 「未加载即空气」的虚空里往下掉。
    streamChunks(this.world, this.playerChunk, this.radius);
    // 死亡画面期间玩家那几步整个跳过：不移动、不受重力、不受伤、不拾取。世界照常推进——
    // 熔炉、掉落物、经验球都还在走。
    const wasDead = this.healthState.dead;
    // 界面的输入排在最前：这一 tick 是不是界面模式，下面几步都要看它。
    this.stepScreens(wasDead);
    // 界面模式下移动、挖掘、使用一律不算数（见 CONTEXT.md 的「界面模式」）：玩家在
    // 摆物品，不是在操作世界。挡的是输入而不是世界——重力、掉落物、经验球照旧。
    if (wasDead) {
      this.playerState.hold();
    } else {
      const fell = this.playerState.step(this.uiMode ? IDLE_INTENT : this.intent, this.autoJumpEnabled);
      this.healthState.hurt(fallDamage(fell), this.ticks);
      // 选中格先生效，再瞄准与使用：同一 tick 里切了格又按使用键，放下的是新格里的东西。
      this.inventoryState.select(this.nextSlot);
    }
    // 移动之后重读一次：这一 tick 里摔死的，从这里起与已经死了的一样，不挖、不放（拾取见下面）。
    // 否则落地那一 tick 按着的使用键还会放下一块。
    const uiMode = this.uiMode;
    // 攻击与挖掘必须排在移动之后，理由见 Mining.step。界面一开就换成「什么键都没按」，
    // 进度因此当场归零，回头得重挖。攻击排在挖掘之前：左键按下那一 tick 先看视线先碰到的是不是
    // 僵尸，是的话这一次按住不挖（ADR-0015）。
    // 按下也一样：界面模式下按的那一下作废，关掉界面时左键还按着也不算按下。
    // 按下的那一 tick 算按着：两个 tick 之间按下又松开，挖掘也收到一 tick 的按住，硬度 0 的火把因此
    // 照样碎掉（#56）；别的方块挖一 tick 不够，下一 tick 没按着，进度归零。
    const pressed = this.miningPressQueued && !uiMode;
    this.miningPressQueued = false;
    const held = uiMode ? IDLE_MINING : { held: this.miningHeld || pressed, chain: this.chainHeld };
    this.miningState.step(this.attackState.step(held, pressed, this.ticks));
    // 使用排在挖掘之后：目标方块是挖掘那一步按走完之后的眼睛位置重投出来的（ADR-0006），
    // 与玩家碰撞箱的判定用的也是这一 tick 走完之后的位置。
    if (this.useQueued) {
      // 界面模式下这一下作废，不留到关掉界面之后补一下。
      this.useQueued = false;
      if (!uiMode) this.useTarget();
    }
    // 熔炉排在挖掘与使用之后、掉落物与经验球之前（issue #34）。界面开着照样推进：挡的是玩家的输入，
    // 不是世界。所在区块没加载的熔炉暂停，不补算。
    stepFurnaces(this.world);
    // 僵尸排在熔炉之后、掉落物之前（#36 定的每 tick 顺序），追的、打的是玩家这一 tick 走完之后的位置。
    // 死亡画面期间照常推进：世界不停，死了的玩家停在原地，僵尸照样朝那里走，只是他不再受伤。
    // 界面开着照样挨打：挡的是玩家的输入，不是世界。生成排在现有的那些走完之后：这一 tick 生成的
    // 下一 tick 才开始动。燃烧看是不是白天，生成看折算天光，两者都按这一 tick 的世界时刻。
    this.zombiesState.step(
      this.ticks,
      {
        position: this.playerState.position,
        hitbox: this.playerState.hitbox,
        hitByZombie: (amount, attacker, now) => this.hitByZombie(amount, attacker, now),
      },
      this.isNight,
    );
    this.zombiesState.spawnNaturally(this.ticks, this.playerState.position, this.skyDarkening);
    // 掉落物与经验球都排在挖掘之后：这一 tick 刚挖出来的东西同一 tick 就开始动，而
    // 掉落物的拾取延迟（PICKUP_DELAY_TICKS）也从这里起算。拾取与吸收判的都是玩家走完
    // 之后的碰撞箱。两者互不影响，谁先谁后都一样。死了的玩家什么都不拾取、不吸收，这一 tick 摔死的、
    // 被僵尸打死的也一样——否则脚边的掉落物会先被拾起再掉出来。
    const collector = this.healthState.dead ? undefined : this.playerState.hitbox;
    this.dropsState.step(collector, this.inventoryState);
    this.xpOrbsState.step(collector, this.experienceState);
    // 回血与死亡判定排在最后：这一 tick 里所有伤害都结算完了，受伤那一 tick 不会紧跟着回血。
    this.healthState.regenerate(this.ticks);
    if (!wasDead && this.healthState.dead) this.die();
  }

  /**
   * 第 now 个 tick 被在 attacker 的僵尸打了 amount 点。无敌时间与死了不受伤的规则在 `Health`；生效时
   * 被推离那只僵尸（`Player.knockBack`）。生命值不在 `Player` 上，所以由核心把两边拼起来。
   */
  private hitByZombie(amount: number, attacker: Vec3, now: number): void {
    if (this.healthState.hurt(amount, now)) this.playerState.knockBack(attacker);
  }

  /**
   * 生命归零的那一 tick：身上的东西全部留在死亡处，进入死亡画面。
   *
   * 开着的界面先关掉，规则与平时关界面相同（`InventoryScreen.toggle`）：光标上那一堆先回到拿起它
   * 的那一格，合成网格里的退回背包，退不回去的掉在脚下；熔炉三格里的留在熔炉里，所以从熔炉格拿到
   * 光标上的东西回到熔炉，不随身掉落。然后背包每一堆各生成一个掉落物（耐久随堆，ADR-0010），落在同一格，
   * 由各自的编号哈希出不同的初速度散开；累计经验全部装进一个经验球，没有经验就不生成。
   *
   * 进入死亡画面不需要另记一个状态：生命值归零就是（`uiMode`）。极限难度下同时把已死亡标记置真
   * （`hardcoreDead`），写盘由外层做。
   */
  private die(): void {
    if (deletesWorldOnDeath(this.worldDifficulty)) this.worldHardcoreDead = true;
    const at = this.playerState.position;
    for (const stack of this.activeScreen?.toggle() ?? []) this.dropsState.spawnAt(stack, at);
    for (const stack of this.inventoryState.takeAll()) this.dropsState.spawnAt(stack, at);
    const experience = this.experienceState.takeAll();
    if (experience > 0) this.xpOrbsState.spawnAt(experience, at);
  }

  /**
   * 使用键落在目标方块上：可使用方块（工作台、熔炉）开界面，其余走放置（ADR-0009）。
   *
   * 目标由挖掘那一步算出来，这里直接用它（ADR-0006）：射线只走到触及距离，拿得到目标
   * 就说明够得着，触及距离之外的工作台与熔炉因此不是目标，使用键什么都不发生。
   * 分派看的是方块表的「使用」一列（`blockUse`），箱子加进来时这里多一条。
   *
   * 走到这里说明没有界面开着（`uiMode` 为假），下面每一下切换都是打开。
   */
  private useTarget(): void {
    const hit = this.miningState.target;
    if (hit) {
      const use = blockUse(this.world.getBlock(hit.x, hit.y, hit.z));
      if (use === BlockUse.CraftingTable) {
        this.craftingTableState.toggle();
        return;
      }
      if (use === BlockUse.Furnace) {
        this.openFurnace(hit);
        return;
      }
    }
    placeBlock(this.world, this.miningState, this.playerState, this.inventoryState);
  }

  /**
   * 打开那一格熔炉的界面：三格先重绑到它在状态表里的那一条，再打开。
   *
   * 熔炉方块一放下世界就建好那条状态（`World.setBlock`），这里一定查得到；查不到（状态不是
   * 熔炉的）就什么都不做，而不是开一个三格不知道指向哪里的界面。
   */
  private openFurnace({ x, y, z }: Vec3): void {
    const state = this.world.blockStateAt(x, y, z);
    if (state?.kind !== BlockStateKind.Furnace) return;
    this.furnaceSlots.bind(state, { x, y, z });
    this.furnaceScreenState.toggle();
  }

  /**
   * 界面这一 tick 的输入：先处理点击，再处理开合。
   *
   * 点击排在开合之前，按下背包键那一 tick 里点的格子才算数——两件事都在这一 tick 里
   * 到达，而玩家先点了格子才去按键。点击落在开着的那个界面上，一个都没开时点了没有反应。
   *
   * 死亡画面上背包键作废：死亡那一 tick 已经关掉了所有界面（`die`），一个都没开，按下去不打开
   * 背包界面，也关不掉死亡画面。
   */
  private stepScreens(dead: boolean): void {
    const active = this.activeScreen;
    if (active) {
      for (const click of this.screenClicks) {
        if (click.kind === 'slot') active.clickSlot(click.index);
        else if (click.kind === 'split') active.splitSlot(click.index);
        else if (click.kind === 'recipe') active.clickRecipe(click.index);
        else active.clickOutput();
      }
    }
    this.screenClicks.length = 0;

    if (!this.toggleQueued) return;
    this.toggleQueued = false;
    if (dead) return;
    // 有界面开着就关它，没有就开背包界面。关的时候光标上、合成网格里还有东西而背包
    // 一格不剩的，扔在玩家脚下那一格，与原版一样：界面一关就看不见的东西不能凭空消失。
    // 玩家挪出一格来就能拾取回去。
    for (const stack of (active ?? this.inventoryScreenState).toggle()) {
      this.dropsState.spawnAt(stack, this.playerState.position);
    }
  }
}
