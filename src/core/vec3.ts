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
