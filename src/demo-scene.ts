import { BlockType } from './core/block';
import { FLAT_SURFACE_Y } from './core/constants';
import type { GameCore } from './core/game';

/**
 * 本切片的临时演示内容：在硬编码平地上摆一棵橡树、挖一个露出泥土的坑，
 * 再把石头与基岩各摆一块在地面上——地下的方块看不见，但贴图得能验证。
 * 这样 6 种方块的贴图在页面上一眼可见。
 *
 * issue #6（橡树生成）与 issue #7（挖掘）落地后，这个文件应当删掉。
 */
/** 演示橡树树干所在的列。端到端测试用它定位，不必在测试里抄坐标。 */
export const DEMO_TREE_COLUMN = { x: -5, z: -4 } as const;

export function buildDemoScene(core: GameCore): void {
  placeOakTree(core, DEMO_TREE_COLUMN.x, DEMO_TREE_COLUMN.z);
  digPit(core, 4, 3);
  core.setBlock(-2, FLAT_SURFACE_Y + 1, 5, BlockType.Bedrock);
  core.setBlock(1, FLAT_SURFACE_Y + 1, 6, BlockType.Stone);
}

/** 5 格树干 + 原版式橡树冠。 */
function placeOakTree(core: GameCore, ox: number, oz: number): void {
  const base = FLAT_SURFACE_Y + 1;
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
      core.setBlock(ox + dx, FLAT_SURFACE_Y, oz + dz, BlockType.Air);
    }
  }
}
