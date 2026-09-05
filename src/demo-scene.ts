import { BlockType } from './core/block';
import type { GameCore } from './core/game';

/**
 * 本切片的临时演示内容：在生成的平原上摆一棵橡树、挖一个露出泥土的坑，
 * 再把石头与基岩各摆一块在地面上——地下的方块看不见，但贴图得能验证。
 * 这样 6 种方块的贴图在页面上一眼可见。
 *
 * 所有位置都按各自那一列的地表高度算，地形起伏后不会悬空也不会埋进土里。
 *
 * issue #6（橡树生成）与 issue #7（挖掘）落地后，这个文件应当删掉。
 */
/** 演示橡树树干所在的列。端到端测试用它定位，不必在测试里抄坐标。 */
export const DEMO_TREE_COLUMN = { x: -5, z: -4 } as const;

export function buildDemoScene(core: GameCore): void {
  placeOakTree(core, DEMO_TREE_COLUMN.x, DEMO_TREE_COLUMN.z);
  digPit(core, 4, 3);
  placeOnGround(core, -2, 5, BlockType.Bedrock);
  placeOnGround(core, 1, 6, BlockType.Stone);
}

/** 5 格树干 + 原版式橡树冠。 */
function placeOakTree(core: GameCore, ox: number, oz: number): void {
  const base = core.highestBlockY(ox, oz) + 1;
  const trunkHeight = 5;
  for (let i = 0; i < trunkHeight; i++) {
    core.setBlock(ox, base + i, oz, BlockType.OakLog);
  }

  // 下面两层树冠是 5×5 去掉四角，最上一层是 3×3 去掉四角。
  const crownBase = base + trunkHeight - 2;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (dx === 0 && dz === 0) continue;
        core.setBlock(ox + dx, crownBase + dy, oz + dz, BlockType.OakLeaves);
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
      core.setBlock(ox + dx, base + trunkHeight, oz + dz, BlockType.OakLeaves);
    }
  }
}

/** 挖掉草皮，露出下面的泥土层。 */
function digPit(core: GameCore, ox: number, oz: number): void {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = ox + dx;
      const z = oz + dz;
      core.setBlock(x, core.highestBlockY(x, z), z, BlockType.Air);
    }
  }
}

/** 把一块方块摆在某一列的地面上。 */
function placeOnGround(core: GameCore, x: number, z: number, block: BlockType): void {
  core.setBlock(x, core.highestBlockY(x, z) + 1, z, block);
}
