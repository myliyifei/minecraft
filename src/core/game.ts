import { BlockType, BlockUse, blockUse, type BlockEdit } from './block';
import type { ChunkView } from './chunk';
import { DEFAULT_SEED, DEFAULT_VIEW_RADIUS } from './constants';
import { CRAFTING_TABLE_GRID, CraftingGrid, INVENTORY_CRAFTING_GRID } from './crafting-grid';
import { Drops, type DropsView } from './drop';
import { Experience, type ExperienceView } from './experience';
import { Inventory, wrapHotbarSlot, type InventoryView } from './inventory';
import { InventoryScreen, type InventoryScreenView } from './inventory-screen';
import { IDLE_MINING, Mining, type MiningView } from './mining';
import { placeBlock } from './placement';
import { IDLE_INTENT, Player, type MoveIntent, type PlayerView } from './player';
import { streamChunks } from './streaming';
import { plainsTerrain } from './terrain';
import type { Vec3 } from './vec3';
import { XpOrbs, type XpOrbsView } from './xp-orb';
import {
  chunkOf,
  ORIGIN_CHUNK,
  World,
  type ChunkCoord,
  type ChunkSourceFactory,
} from './world';

/**
 * 界面上的一下点击：点了第几格，或点了输出格。
 *
 * 两种点击排进同一条队列而不是两条：「放进网格、点输出格、把成品放到别处」是同一个 tick
 * 里可能连着来的三下，分成两条队列就丢了先后。点的是哪个界面不必记：同一时刻最多开
 * 一个界面，点击就落在开着的那个上。
 */
type ScreenClick = { readonly kind: 'slot'; readonly index: number } | { readonly kind: 'output' };

const OUTPUT_CLICK: ScreenClick = Object.freeze({ kind: 'output' });

export interface GameCoreOptions {
  /** 世界种子。同一种子每次进入得到同样的地形。 */
  readonly seed?: number;
  /** 视距（区块数）：这个半径内的区块保持加载，见 CONTEXT.md 的「视距」。 */
  readonly viewRadius?: number;
  /**
   * 换掉区块的来源：测试里塞一个特定形状的世界，浏览器里塞一个由 Worker 生成区块的
   * 来源。拿到的是本世界的种子，因此替换实现同样受种子驱动。
   */
  readonly chunkSource?: ChunkSourceFactory;
}

/**
 * 无头游戏核心：纯 TypeScript，不依赖 Three.js 与 DOM，可在 Node 中直接实例化。
 * 核心层的测试都从这里驱动游戏，渲染与输入适配器也只通过这里的指令和查询与游戏交互。
 *
 * 第一切片有「推进时间」「查询/写入方块」「玩家移动」「区块随玩家流式加载」「空手挖掘」
 * 「掉落物与背包」「经验球与等级」「放置方块」「背包界面」九件事，第二切片起加「合成」
 * 与「使用（工作台界面）」。生物等系统由后续切片挂进 step()。
 */
export class GameCore implements BlockEdit {
  private readonly world: World;
  private readonly worldSeed: number;
  private readonly radius: number;
  private readonly playerState: Player;
  private readonly dropsState: Drops;
  private readonly xpOrbsState: XpOrbs;
  private readonly experienceState: Experience;
  private readonly inventoryState: Inventory;
  private readonly craftingGrid: CraftingGrid;
  private readonly screenState: InventoryScreen;
  /**
   * 工作台界面（见 CONTEXT.md）：与背包界面同一套实现，只是合成网格是 3x3。
   * 两个界面各持自己的网格，同一时刻最多开一个（`activeScreen`）。
   */
  private readonly craftingTableGrid: CraftingGrid;
  private readonly craftingTableState: InventoryScreen;
  private readonly miningState: Mining;
  private ticks = 0;
  private intent: MoveIntent = IDLE_INTENT;
  private miningHeld = false;
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
  /** 这一 tick 里在界面上点过哪些地方（格子与输出格），按点击顺序。 */
  private readonly screenClicks: ScreenClick[] = [];

  constructor(options: GameCoreOptions = {}) {
    this.worldSeed = options.seed ?? DEFAULT_SEED;
    this.radius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    this.world = new World((options.chunkSource ?? plainsTerrain)(this.worldSeed));
    // 出生点要先有地形才算得出来，所以先加载原点周围，玩家最后造。
    // 来源当场给不出区块时（浏览器里 Worker 还在生成）这里只加载得到已经就绪的那些，
    // 其余由 tick 补上——所以浏览器那一侧要先把出生点那一带备好，见 src/main.ts。
    streamChunks(this.world, ORIGIN_CHUNK, this.radius);
    this.playerState = new Player(this.world, this.spawnPoint);
    this.dropsState = new Drops(this.world, this.worldSeed);
    this.xpOrbsState = new XpOrbs();
    this.experienceState = new Experience();
    this.inventoryState = new Inventory();
    this.craftingGrid = new CraftingGrid(INVENTORY_CRAFTING_GRID);
    this.screenState = new InventoryScreen(this.inventoryState, this.craftingGrid);
    this.craftingTableGrid = new CraftingGrid(CRAFTING_TABLE_GRID);
    this.craftingTableState = new InventoryScreen(this.inventoryState, this.craftingTableGrid);
    this.miningState = new Mining(
      this.world,
      this.playerState,
      this.dropsState,
      this.xpOrbsState,
    );
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

  /** 玩家的经验与等级，只读。HUD 读它画等级条。 */
  get experience(): ExperienceView {
    return this.experienceState;
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
    return this.screenState;
  }

  /**
   * 工作台界面的只读视图：开着没有、光标上拿着什么、那块 3x3 网格与输出格里是什么。
   * 只能由使用键对着工作台（`use`）打开，按背包键关闭。
   */
  get craftingTableScreen(): InventoryScreenView {
    return this.craftingTableState;
  }

  /**
   * 这一刻是界面模式吗（见 CONTEXT.md）——有界面开着就是。
   *
   * 问的是「有没有界面开着」而不是「背包界面开着没有」：移动、视角、挖掘、使用那几处
   * 判定只看这一个答案，再加一种界面也不必改它们。界面层与输入层也读它：准星藏不藏、
   * 底部那一栏收不收、鼠标要不要交还页面，看的都是「有没有界面开着」。
   */
  get uiMode(): boolean {
    return this.activeScreen !== undefined;
  }

  /** 此刻开着的那个界面，一个都没开时 undefined。同一时刻最多开一个。 */
  private get activeScreen(): InventoryScreen | undefined {
    if (this.screenState.open) return this.screenState;
    if (this.craftingTableState.open) return this.craftingTableState;
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
   */
  setMining(held: boolean): void {
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
   * 使用（见 CONTEXT.md、ADR-0009）：目标方块是可使用方块（工作台）就打开它的界面，
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
   * 一个都没开就打开背包界面。工作台界面因此关得掉、开不了——它只由 `use` 打开。
   *
   * 同一个 tick 里按两次相互抵消：一开一关，界面状态没有净变化。关闭时光标上与合成网格
   * 里还有东西的话，它们回背包，一格都放不下的那些掉在玩家脚下（`InventoryScreen.toggle`）。
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
   * 点开着的那个界面的输出格，下一个 tick 生效（ADR-0004）。与点格子排在同一条队列里，
   * 先后顺序照点击的来。成品到光标上、材料各减 1 的规则在 `InventoryScreen.clickOutput` 里。
   */
  clickCraftingOutput(): void {
    this.screenClicks.push(OUTPUT_CLICK);
  }

  /** 本世界的种子。地形完全由它决定，端到端测试用它断言「同一种子同一个世界」。 */
  get seed(): number {
    return this.worldSeed;
  }

  /** 已推进的 tick 数。世界时间只由 tick 决定，与真实时钟无关。 */
  get tickCount(): number {
    return this.ticks;
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

  /** 取走「哪些方块变过」的记录并清空。渲染层每帧取一次，据此重建过期的区块网格。 */
  takeChangedBlocks(): Vec3[] {
    return this.world.takeChangedBlocks();
  }

  /**
   * 某一列最高的非空气方块的 y。整列都是空气（或区块未加载）时返回世界底面之下一格。
   *
   * 注意它不是「地表高度」：地表高度是地形生成给出的地面，不随挖掘与放置变化，
   * 由 `plainsSurfaceHeight` 那类函数回答。这里问的是那一列现在实际堆到了多高，
   * 出生点与将来的天光要的是这个。
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

  /** 视距（区块数）。渲染层按它决定网格的范围。 */
  get viewRadius(): number {
    return this.radius;
  }

  /** 玩家所在的区块。加载与卸载都以它为中心。 */
  get playerChunk(): ChunkCoord {
    const { x, z } = this.playerState.position;
    return { cx: chunkOf(Math.floor(x)), cz: chunkOf(Math.floor(z)) };
  }

  /**
   * 出生点：世界原点那一列最高实心方块的顶面，落在方块中心。
   *
   * `highestBlockY` 找的是最高的非空气方块。当前除空气之外的方块都是实心的，两者等价。
   * 树冠会把它抬到树冠的高度，所以出生点那一带干脆不长树，见 `OAK_SPAWN_CLEARANCE`。
   */
  get spawnPoint(): Vec3 {
    return { x: 0.5, y: this.highestBlockY(0, 0) + 1, z: 0.5 };
  }

  /** 一个 tick 的全部逻辑。 */
  private step(): void {
    this.ticks++;
    // 先让区块跟上玩家再算物理：玩家脚下的地形必须已经在世界里，否则他会踩进
    // 「未加载即空气」的虚空里往下掉。
    streamChunks(this.world, this.playerChunk, this.radius);
    // 界面的输入排在最前：这一 tick 是不是界面模式，下面几步都要看它。
    this.stepScreens();
    // 界面模式下移动、挖掘、使用一律不算数（见 CONTEXT.md 的「界面模式」）：玩家在
    // 摆物品，不是在操作世界。挡的是输入而不是世界——重力、掉落物、经验球照旧。
    const uiMode = this.uiMode;
    this.playerState.step(uiMode ? IDLE_INTENT : this.intent);
    // 选中格先生效，再瞄准与使用：同一 tick 里切了格又按使用键，放下的是新格里的东西。
    this.inventoryState.select(this.nextSlot);
    // 挖掘必须排在移动之后，理由见 Mining.step。界面一开就换成「什么键都没按」，
    // 进度因此当场归零，回头得重挖。
    this.miningState.step(uiMode ? IDLE_MINING : { held: this.miningHeld, chain: this.chainHeld });
    // 使用排在挖掘之后：目标方块是挖掘那一步按走完之后的眼睛位置重投出来的（ADR-0006），
    // 与玩家碰撞箱的判定用的也是这一 tick 走完之后的位置。
    if (this.useQueued) {
      // 界面模式下这一下作废，不留到关掉界面之后补一下。
      this.useQueued = false;
      if (!uiMode) this.useTarget();
    }
    // 掉落物与经验球都排在挖掘之后：这一 tick 刚挖出来的东西同一 tick 就开始动，而
    // 掉落物的拾取延迟（PICKUP_DELAY_TICKS）也从这里起算。拾取与吸收判的都是玩家走完
    // 之后的碰撞箱。两者互不影响，谁先谁后都一样。
    this.dropsState.step(this.playerState.hitbox, this.inventoryState);
    this.xpOrbsState.step(this.playerState.hitbox, this.experienceState);
  }

  /**
   * 使用键落在目标方块上：可使用方块（工作台）开界面，其余走放置（ADR-0009）。
   *
   * 目标由挖掘那一步算出来，这里直接用它（ADR-0006）：射线只走到触及距离，拿得到目标
   * 就说明够得着，触及距离之外的工作台因此不是目标，使用键什么都不发生。
   * 分派看的是方块表的「使用」一列（`blockUse`），熔炉、箱子加进来时这里各多一条。
   */
  private useTarget(): void {
    const hit = this.miningState.target;
    if (hit && blockUse(this.world.getBlock(hit.x, hit.y, hit.z)) === BlockUse.CraftingTable) {
      // 走到这里说明没有界面开着（`uiMode` 为假），这一下切换就是打开。
      this.craftingTableState.toggle();
      return;
    }
    placeBlock(this.world, this.miningState, this.playerState, this.inventoryState);
  }

  /**
   * 界面这一 tick 的输入：先处理点击，再处理开合。
   *
   * 点击排在开合之前，按下背包键那一 tick 里点的格子才算数——两件事都在这一 tick 里
   * 到达，而玩家先点了格子才去按键。点击落在开着的那个界面上，一个都没开时点了没有反应。
   */
  private stepScreens(): void {
    const active = this.activeScreen;
    if (active) {
      for (const click of this.screenClicks) {
        if (click.kind === 'slot') active.clickSlot(click.index);
        else active.clickOutput();
      }
    }
    this.screenClicks.length = 0;

    if (!this.toggleQueued) return;
    this.toggleQueued = false;
    // 有界面开着就关它，没有就开背包界面。关的时候光标上、合成网格里还有东西而背包
    // 一格不剩的，扔在玩家脚下那一格，与原版一样：界面一关就看不见的东西不能凭空消失。
    // 玩家挪出一格来就能拾取回去。
    for (const stack of (active ?? this.screenState).toggle()) {
      this.dropsState.spawnAt(stack, this.playerState.position);
    }
  }
}
