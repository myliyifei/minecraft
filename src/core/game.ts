import { BlockType, type BlockView } from './block';
import { DEFAULT_SEED, DEFAULT_VIEW_RADIUS } from './constants';
import { plainsTerrain, type TerrainFactory } from './terrain';
import { World, type ChunkCoord } from './world';

export interface GameCoreOptions {
  /** 世界种子。同一种子每次进入得到同样的地形。 */
  readonly seed?: number;
  /** 初始加载半径（区块数）。 */
  readonly viewRadius?: number;
  /**
   * 换掉地形算法，测试里可以塞一个特定形状的世界。
   * 拿到的是本世界的种子，因此替换实现同样受种子驱动。
   */
  readonly terrain?: TerrainFactory;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 无头游戏核心：纯 TypeScript，不依赖 Three.js 与 DOM，可在 Node 中直接实例化。
 * 这是主测试接缝——渲染与输入适配器只通过这里的指令和查询与游戏交互。
 *
 * 本切片只有「推进时间」和「查询/写入方块」两件事。玩家、挖掘、掉落物等系统
 * 由后续切片挂进 step()。
 */
export class GameCore implements BlockView {
  private readonly world: World;
  private readonly worldSeed: number;
  private ticks = 0;

  constructor(options: GameCoreOptions = {}) {
    this.worldSeed = options.seed ?? DEFAULT_SEED;
    this.world = new World((options.terrain ?? plainsTerrain)(this.worldSeed));
    const radius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    for (let cx = -radius; cx <= radius; cx++) {
      for (let cz = -radius; cz <= radius; cz++) {
        this.world.loadChunk(cx, cz);
      }
    }
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
   * 出生点、树木落地、将来的天光都从这里问「地面在哪」。
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

  /** 出生点：世界原点那一列最高实心方块的顶面，落在方块中心。 */
  get spawnPoint(): Vec3 {
    return { x: 0.5, y: this.highestBlockY(0, 0) + 1, z: 0.5 };
  }

  /** 一个 tick 的全部逻辑。 */
  private step(): void {
    this.ticks++;
  }
}
