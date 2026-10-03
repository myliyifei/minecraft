/**
 * 难度（见 CONTEXT.md）：新建世界时选定的五档之一，之后不可改，随存档保存。
 *
 * 值是字符串：它进存档（`Snapshot.difficulty`），已发布的值因此不可改、不可复用，与物品编号同一条规矩。
 * 用字符串而不是编号，导出文件里的 JSON 段读得出是哪一档，导入校验也只需比对这五个值。
 */
export const Difficulty = {
  Peaceful: 'peaceful',
  Easy: 'easy',
  Normal: 'normal',
  Hard: 'hard',
  Hardcore: 'hardcore',
} as const;

export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

/** 没指定难度时取这一档。新建世界的表单默认也是它。 */
export const DEFAULT_DIFFICULTY: Difficulty = Difficulty.Normal;

/** 这一档生成敌对生物吗。和平不生成，已有的随即消失（见 CONTEXT.md「难度」）。 */
export function spawnsHostiles(difficulty: Difficulty): boolean {
  return difficulty !== Difficulty.Peaceful;
}

/**
 * 这一档死了就删档吗。只有极限是：死亡那一 tick 存档标记已死亡，不能重生，死亡画面上只有删除世界
 * （见 CONTEXT.md「死亡画面」）。
 */
export function deletesWorldOnDeath(difficulty: Difficulty): boolean {
  return difficulty === Difficulty.Hardcore;
}

/**
 * 这一档下僵尸打玩家一下扣几点：简单 2、普通 3、困难与极限 4。和平下没有僵尸，也给普通的值，五档都有返回值。
 * 只管僵尸打玩家；玩家打僵尸、摔落、燃烧都不按难度。
 */
export function zombieAttackDamage(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 2;
    case Difficulty.Peaceful:
    case Difficulty.Normal:
      return 3;
    case Difficulty.Hard:
    case Difficulty.Hardcore:
      return 4;
  }
}
