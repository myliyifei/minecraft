/**
 * 一批实体每 tick 的推进与清理。
 *
 * 掉落物与经验球共用这一份（见 ADR-0007），将来的生物也走这里：三种实体各写一遍
 * 「走一步、该移除的从数组里移除」，迟早有一份忘了移除。各自的动法（下落、朝玩家飞）
 * 与去留的判据（被拾取、被吸收、超时）留在各自的模块里。
 */

/**
 * 推进一批实体，并把不再留在世界里的移除。
 *
 * `step` 让一个实体走一步，返回它还留不留着。留下来的往前挪、覆盖掉走了的那些，
 * 因此每 tick 不必新建一个数组。
 */
export function stepEntities<T>(list: T[], step: (entity: T) => boolean): void {
  let write = 0;
  for (const entity of list) {
    if (step(entity)) list[write++] = entity;
  }
  list.length = write;
}
