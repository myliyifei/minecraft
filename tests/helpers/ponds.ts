import type { Pond } from '../../src/core/pond';
import type { ColumnCoord } from '../../src/core/terrain';

/** 水塘（#81）的测试工具：接口直接取 `src/core/pond.ts`，这里只加几个标识。 */
export { pondsTouching, type Pond, type PondPlacement } from '../../src/core/pond';

/** 水塘的标识：中心列与水面高度。 */
export function pondKey(pond: Pond): string {
  return `${pond.x},${pond.z}@${pond.waterY}`;
}

/** 列的标识。 */
export function columnKey({ x, z }: ColumnCoord): string {
  return `${x},${z}`;
}
