import type { Face } from './atlas';

/**
 * 一格方块表面的那些四边形，以方块的最小角为原点：整格立方体的六个面，以及按它们缩放、倾斜出来的
 * 火把细杆（`torch-model.ts`）。纯数据，网格构建（`mesh.ts`）按它输出顶点。
 */

/** 单位立方体内的一个点，或一个轴向方向。 */
export type Point3 = readonly [number, number, number];

/** 一对归一化 uv 坐标。 */
export type Uv = readonly [number, number];

export interface FaceSpec {
  /** 这个面的法线。整格立方体的六个面里它同时是邻居方向。 */
  readonly normal: Point3;
  /** 面的四个角（以方块的最小角为原点），从外部看是逆时针。 */
  readonly corners: readonly [Point3, Point3, Point3, Point3];
  /** 四个角对应的 uv 归一化坐标，v 向上。 */
  readonly uv: readonly [Uv, Uv, Uv, Uv];
  /** 取方块的哪一张贴图。正面（`front`）贴在 −X 与 −Z 两面，没有正面贴图的方块落回侧面。 */
  readonly face: Face;
}

/** 整格立方体的六个面：+X、−X、+Y、−Y、+Z、−Z。 */
export const CUBE_FACES: readonly FaceSpec[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'side',
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'front',
  },
  {
    normal: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'top',
  },
  {
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'bottom',
  },
  {
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    uv: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    face: 'side',
  },
  {
    normal: [0, 0, -1],
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    face: 'front',
  },
];
