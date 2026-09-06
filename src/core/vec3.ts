/**
 * 世界坐标中的一个点。
 *
 * 单独一个模块而不是放在 `game.ts` 里：玩家、掉落物、生物都要用它，
 * 谁都不该为了一个坐标类型去 import 游戏核心。
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 轴向。
 * 直接用 Vec3 的字段名，逐轴解算的代码（碰撞扫掠、体素射线检测）因此能按名字取分量，
 * 不必靠「0 是 x」这类下标约定。
 */
export type Axis = keyof Vec3;
