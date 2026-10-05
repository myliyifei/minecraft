import { expect } from 'vitest';
import type { Biome, ColumnCoord } from '../../src/core/terrain';

/**
 * 水塘（#81）的接口，经 `import.meta.glob` 按文件取：`src/core/pond.ts` 还不存在时类型检查与 `npm run build` 照常通过，
 * 用到它的测试按断言失败（与 tests/helpers/trees.ts、plants.ts 按名称取新接口同一个理由）。模块写好之后可以改回直接 import。
 *
 * 期望的接口（QA 定，见 .scratch/seams-81.md）：
 * - `pondsTouching(placement, cx, cz)`：会写进区块 (cx, cz) 的全部水塘，写法同 `treesTouching`（ADR-0005）。
 *   只经 placement 的查询读地形，区块外的列一律调查询，不生成区块。
 * - `Pond`：中心列 (x, z)、水面那一层的 y（`waterY`）、水塘列（`columns`，列顶地表方块是水的那些列，世界坐标）。
 */

/** 放水塘要的输入：种子、出生列、群系与地表高度。成员名与地形对象的同名成员一致，地形对象可以直接当它传。 */
export interface PondPlacement {
  readonly seed: number;
  readonly spawnColumn: ColumnCoord;
  readonly biomeAt: (x: number, z: number) => Biome;
  readonly surfaceHeightAt: (x: number, z: number) => number;
}

/** 一个水塘。 */
export interface Pond {
  /** 中心列：盆地最深处所在的列，它本身是水塘列。 */
  readonly x: number;
  readonly z: number;
  /** 水面那一层（最上面一层水）的 y。 */
  readonly waterY: number;
  /** 水塘列：列顶地表方块是水的那些列（世界坐标），4 邻接连成一片。 */
  readonly columns: readonly ColumnCoord[];
}

interface PondModule {
  readonly pondsTouching: (placement: PondPlacement, cx: number, cz: number) => Pond[];
}

const modules = import.meta.glob<PondModule>('../../src/core/pond.ts', { eager: true });
const pondModule: Partial<PondModule> | undefined = Object.values(modules)[0];

/** `pondsTouching`；模块或函数还没有时断言失败。 */
export function pondsTouching(placement: PondPlacement, cx: number, cz: number): Pond[] {
  expect(typeof pondModule?.pondsTouching, 'src/core/pond.ts 应导出 pondsTouching(placement, cx, cz)').toBe('function');
  return pondModule!.pondsTouching!(placement, cx, cz);
}

/** 水塘的标识：中心列与水面高度。 */
export function pondKey(pond: Pond): string {
  return `${pond.x},${pond.z}@${pond.waterY}`;
}

/** 列的标识。 */
export function columnKey({ x, z }: ColumnCoord): string {
  return `${x},${z}`;
}
