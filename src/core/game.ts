import { BlockType, type BlockView } from './block';
import type { ChunkView } from './chunk';
import { DEFAULT_SEED, DEFAULT_VIEW_RADIUS } from './constants';
import { IDLE_INTENT, Player, type MoveIntent, type PlayerView } from './player';
import { streamChunks } from './streaming';
import { plainsTerrain } from './terrain';
import type { Vec3 } from './vec3';
import {
  chunkOf,
  ORIGIN_CHUNK,
  World,
  type ChunkCoord,
  type ChunkSourceFactory,
} from './world';

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
 * 这是主测试接缝——渲染与输入适配器只通过这里的指令和查询与游戏交互。
 *
 * 本切片有「推进时间」「查询/写入方块」「玩家移动」「区块随玩家流式加载」四件事。
 * 挖掘、掉落物等系统由后续切片挂进 step()。
 */
export class GameCore implements BlockView {
  private readonly world: World;
  private readonly worldSeed: number;
  private readonly radius: number;
  private readonly playerState: Player;
  private ticks = 0;
  private intent: MoveIntent = IDLE_INTENT;

  constructor(options: GameCoreOptions = {}) {
    this.worldSeed = options.seed ?? DEFAULT_SEED;
    this.radius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    this.world = new World((options.chunkSource ?? plainsTerrain)(this.worldSeed));
    // 出生点要先有地形才算得出来，所以先加载原点周围，玩家最后造。
    // 来源当场给不出区块时（浏览器里 Worker 还在生成）这里只加载得到已经就绪的那些，
    // 其余由 tick 补上——所以浏览器那一侧要先把出生点那一带备好，见 src/main.ts。
    streamChunks(this.world, ORIGIN_CHUNK, this.radius);
    this.playerState = new Player(this.world, this.spawnPoint);
  }

  /** 玩家状态的只读视图。渲染层读它摆相机，改状态只能通过下面两个指令。 */
  get player(): PlayerView {
    return this.playerState;
  }

  /**
   * 设定当前的移动意图，下一个 tick 生效。
   * 输入适配器每次按键状态变化时调一次，核心因此不知道任何键位。
   */
  setMoveIntent(intent: MoveIntent): void {
    this.intent = intent;
  }

  /** 转动视角（弧度增量）。不等 tick，鼠标一动就生效——见 ADR-0004。 */
  turn(yawDelta: number, pitchDelta: number): void {
    this.playerState.turn(yawDelta, pitchDelta);
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
   * `highestBlockY` 找的是最高的非空气方块。当前除空气之外的方块都是实心的，
   * 两者等价；issue #6 放树时要让树避开出生点这一列，免得玩家生在树冠上。
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
    this.playerState.step(this.intent);
  }
}
