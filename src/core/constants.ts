/** 区块的水平边长（方块数）。区块在竖直方向是完整世界高度的柱体。 */
export const CHUNK_SIZE = 16;

/** 区块一层的方块数。区块数据按层排布，这也是相邻两层的下标间距。 */
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

/**
 * CHUNK_SIZE 的位移量，满足 `1 << CHUNK_SHIFT === CHUNK_SIZE`。
 * 世界坐标到区块坐标的换算走位运算而不是除法——这是最热的一条路径。
 */
export const CHUNK_SHIFT = 4;

/** 世界最低一层的 y（基岩层）。 */
export const WORLD_MIN_Y = -64;

/** 世界最高一层的 y。 */
export const WORLD_MAX_Y = 319;

/** 世界的总层数。 */
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y + 1;

/** 海平面高度。 */
export const SEA_LEVEL = 63;

/**
 * 地表的最低高度。
 * 本切片只有平原一种群系，地形恒在海平面以上，因此不出现流体；大海与沙滩见后续切片。
 * 各群系的地形算法都必须守住这条线，平原的参数见 `terrain.ts`。
 */
export const MIN_SURFACE_Y = SEA_LEVEL + 1;

/**
 * 默认世界种子。
 * 固定值让每次打开页面进入同一个世界，端到端测试因此可以断言具体地形；
 * 新建世界时由玩家输入或随机生成种子，是世界列表界面（后续切片）的事。
 */
export const DEFAULT_SEED = 20_260_905;

/** 核心的固定推进频率（tick/s）。渲染在两次 tick 之间插值，不参与逻辑。 */
export const TICK_RATE = 20;

/** 一个 tick 的毫秒数。 */
export const TICK_MS = 1000 / TICK_RATE;

/**
 * 默认视距（区块数）：以玩家所在区块为心，这个半径内的区块保持加载。
 * 玩家可在设置中调整（`GameCoreOptions.viewRadius`）。
 */
export const DEFAULT_VIEW_RADIUS = 8;

/**
 * 视距之外再多留几环才卸载（区块数）。
 * 玩家在区块边界上来回走时，没有这点滞后会让边界那一圈区块反复卸载又重新生成。
 */
export const UNLOAD_MARGIN = 1;
