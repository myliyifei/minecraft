import { BlockType } from './core/block';
import type { GameCore } from './core/game';

/**
 * 本切片的临时演示内容：在生成的平原上挖一个露出泥土的坑，再把石头与基岩各摆一块在
 * 地面上——地下的方块看不见，但贴图得能验证。橡木原木与橡树叶自 issue #6 起由地形
 * 生成器自己长出来，不再摆假的。
 *
 * 所有位置都按各自那一列的地面算，地形起伏后不会悬空也不会埋进土里。
 *
 * issue #7（挖掘）落地后，这个文件应当删掉。
 */
export function buildDemoScene(core: GameCore): void {
  digPit(core, 4, 3);
  placeOnGround(core, -2, 5, BlockType.Bedrock);
  placeOnGround(core, 1, 6, BlockType.Stone);
}

/**
 * 某一列草方块的 y。
 *
 * 自上而下找草，而不是问 `highestBlockY`：头上有树冠时那一列最高的方块是树叶，
 * 不是地面。
 */
function grassTopY(core: GameCore, x: number, z: number): number {
  for (let y = core.highestBlockY(x, z); y > 0; y--) {
    if (core.getBlock(x, y, z) === BlockType.Grass) return y;
  }
  throw new Error(`(${x}, ${z}) 这一列没有草方块`);
}

/** 挖掉草皮，露出下面的泥土层。 */
function digPit(core: GameCore, ox: number, oz: number): void {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = ox + dx;
      const z = oz + dz;
      core.setBlock(x, grassTopY(core, x, z), z, BlockType.Air);
    }
  }
}

/** 把一块方块摆在某一列的地面上。 */
function placeOnGround(core: GameCore, x: number, z: number, block: BlockType): void {
  core.setBlock(x, grassTopY(core, x, z) + 1, z, block);
}
