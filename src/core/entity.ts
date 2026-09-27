import type { Hitbox } from './physics';
import type { Vec3 } from './vec3';
import { chunkOf } from './world';

/**
 * 一批实体每 tick 的推进与清理，以及所在区块是否已加载的判定。
 *
 * 掉落物、经验球与僵尸共用这一份（见 ADR-0007），将来的生物也走这里：几种实体各写一遍
 * 「走一步、该移除的从数组里移除」，迟早有一份忘了移除。各自的动法（下落、朝玩家飞）
 * 与去留的判据（被拾取、被吸收、超时）留在各自的模块里。
 */

/**
 * 按区块坐标判断是否已加载的最小接口。`World` 满足它。
 *
 * 实体集合依赖它而不是 `World` 本身：它们只需要知道脚下那个区块在不在，不需要区块数据。
 */
export interface LoadedChunks {
  isChunkLoaded(cx: number, cz: number): boolean;
}

/**
 * 某个位置所在的区块是否已加载。只看水平坐标，小数坐标先向下取整。
 *
 * 实体不随区块持久（ADR-0013）：僵尸（#41）按它决定消失。掉落物要与方块碰撞，改按碰撞箱判定
 * （`isBoxInLoadedChunks`），所在区块没加载时原地暂停。
 */
export function isInLoadedChunk(chunks: LoadedChunks, position: Vec3): boolean {
  return isBoxInLoadedChunks(chunks, { min: position, max: position });
}

/**
 * 一个碰撞箱在水平方向上涉及的区块是否全都已加载。
 *
 * 会与方块碰撞的实体按它判定：中心还在已加载区块里、碰撞箱却伸进了隔壁没加载的区块时，碰撞解算
 * 把隔壁那部分读成空气（「未加载即空气」），实体可能因此掉下去，或移进隔壁本来是实心方块的位置。
 * 碰撞箱正好贴在区块边界上时也算涉及隔壁：多暂停一 tick 没有害处，漏掉隔壁就会读到空气。
 */
export function isBoxInLoadedChunks(chunks: LoadedChunks, box: Hitbox): boolean {
  const maxCx = chunkOf(Math.floor(box.max.x));
  const maxCz = chunkOf(Math.floor(box.max.z));
  for (let cx = chunkOf(Math.floor(box.min.x)); cx <= maxCx; cx++) {
    for (let cz = chunkOf(Math.floor(box.min.z)); cz <= maxCz; cz++) {
      if (!chunks.isChunkLoaded(cx, cz)) return false;
    }
  }
  return true;
}

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
