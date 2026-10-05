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

/**
 * 海平面高度：海平面那一层的 y。这一层及以下的空气在生成时灌水，寒冷处这一层的水换成冰（ADR-0021）。
 */
export const SEA_LEVEL = 63;

/**
 * 默认世界种子。
 * 固定值让每次打开页面进入同一个世界，端到端测试因此可以断言具体地形；
 * 新建世界时由玩家输入或随机生成种子，是世界列表界面（后续切片）的事。
 *
 * 地形版本 2（#75）起按地形挑过：原点那一列在任何种子下都是平原（三层群系参数的噪声在原点都是 0），
 * 而这个种子从原点往 −Z 走 400 多格仍是平原、相邻列高差不超过一格、没有水。核心测试与端到端测试里
 * 朝 −Z 走一两分钟的那几条靠这一点，换种子要重新挑，出生点改为螺旋搜索（#84）之后再看还要不要。
 */
export const DEFAULT_SEED = 20_261_006;

/** 一整圈的弧度。折回偏航、按哈希取一个随机方向都要用它。 */
export const TAU = Math.PI * 2;

/** 核心的固定推进频率（tick/s）。渲染在两次 tick 之间插值，不参与逻辑。 */
export const TICK_RATE = 20;

/** 一个 tick 的毫秒数。 */
export const TICK_MS = 1000 / TICK_RATE;

/**
 * 默认视距（区块数）：以玩家所在区块为中心，这个半径内的区块保持加载。
 * 建核心时可以换个值（`GameCoreOptions.viewRadius`），之后由设置界面经 `GameCore.setViewRadius` 改。
 */
export const DEFAULT_VIEW_RADIUS = 8;

/**
 * 视距之外再多留几环才卸载（区块数）。
 * 玩家在区块边界上来回走时，没有这点滞后会让边界那一圈区块反复卸载又重新生成。
 */
export const UNLOAD_MARGIN = 1;

/** 光照等级的上限（见 CONTEXT.md 的「天光」「方块光」）：两种光都是 0 到 15。露天的天光就是它。 */
export const MAX_LIGHT_LEVEL = 15;
