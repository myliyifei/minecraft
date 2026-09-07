import { isAir, placedBlock, type BlockEdit } from './block';
import type { Hand } from './item';
import type { MiningView } from './mining';
import { blockHitbox, overlaps } from './physics';
import type { PlayerView } from './player';
import { blockOutsideFace } from './raycast';

/**
 * 放置从挖掘那边借目标方块。视线每 tick 只投一条射线（ADR-0006），挖掘与放置读的是
 * 同一个答案——各投一条的话，选框框着的和放到的可能不是同一块。
 */
export type TargetView = Pick<MiningView, 'target'>;

/** 放置要知道玩家占了哪块空间：新方块不能落在玩家身体里。 */
export type BodyView = Pick<PlayerView, 'hitbox'>;

/**
 * 放置（见 CONTEXT.md）：把手上那一堆方块物品的一个放到目标方块的相邻面上，返回放下了没有。
 *
 * 落点是命中面外侧那一格（`blockOutsideFace`），也就是玩家看着的那一面外侧。三道拦住它的
 * 规则：那一格必须是空气、必须真的写进了世界（世界高度之外与未加载的区块都写不进去）、
 * 不能与玩家的碰撞箱交叠出体积（贴着身体那一格放得下，套住身体就不行）。
 *
 * **触及距离不在这里判**：射线本身只走到 `PLAYER_REACH`，拿得到目标就说明够得着，
 * 这条规则的唯一出处是投射线那一步（ADR-0006）。在这里再判一次就是一段永远不会成立的
 * 分支，而且两处各记一个上限，迟早对不上。
 *
 * 手上不是方块物品（工具、食物）时按了没反应，这条写在放置表里（`placedBlock`）。
 *
 * 写成函数而不是类：它没有跨 tick 的状态，与 `raycastBlocks`、`streamChunks` 一样。
 * 等按住右键要连发（原版约 4 次/秒）时才需要一个记着冷却的对象。
 */
export function placeBlock(
  blocks: BlockEdit,
  aim: TargetView,
  body: BodyView,
  hand: Hand,
): boolean {
  const held = hand.held;
  if (!held) return false;

  const block = placedBlock(held.item);
  if (block === null) return false;

  const hit = aim.target;
  if (!hit) return false;

  const { x, y, z } = blockOutsideFace(hit);
  if (!isAir(blocks.getBlock(x, y, z))) return false;
  if (overlaps(body.hitbox, blockHitbox(x, y, z))) return false;
  // 只有真的写进了世界才扣数量：写不进去（世界顶面之外、区块没加载）时手上那一堆一个
  // 都不少，否则方块就凭空消失了。
  if (!blocks.setBlock(x, y, z, block)) return false;

  hand.takeOne();
  return true;
}
