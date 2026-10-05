import { BlockType, isOpaque } from './block';
import { isTorch } from './torch';

/**
 * 两格相邻时，它们之间的那个面画不画：一格贴着隔壁的那一面，隔壁不透明、或者两格在剔除上同一档时不画
 * （见 `buildChunkMesh`）。网格构建与「方块变了，隔壁区块要不要重建」（`World.markStale`）用的都是这里的同一个分档，
 * 两边的判定一致。
 */

/** `faceCulling` 里不透明方块的那一档：比任何方块编号都小。 */
export const OPAQUE_FACES = -1;

/**
 * 一格方块在剔除上属于哪一档。不透明方块是 `OPAQUE_FACES`，挡住贴着它的任何面；其余方块不挡，但与隔壁同一档时
 * 两个面一起不画：树叶与同一种树叶（两个面重合）、水与冰（#83，水面贴着冰面，画出来只是两层半透明叠在一起）。
 * 空气与火把是空气那一档：不挡，也不会与隔壁同一档——火把不走六面剔除，它从不让别的方块少画一个面。
 *
 * 一格换了方块之后档不变的话，隔壁贴着它的面就一个都不变，隔壁要重建只可能是因为光照变了。
 */
export function faceCulling(block: BlockType): number {
  if (isOpaque(block)) return OPAQUE_FACES;
  if (isTorch(block)) return BlockType.Air;
  if (block === BlockType.Ice) return BlockType.Water;
  return block;
}
