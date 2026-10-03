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
