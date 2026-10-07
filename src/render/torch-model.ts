import { BlockType } from '../core/block';
import { isTorch, torchStickBox, torchSupportCell, WALL_TORCH_TILT } from '../core/torch';
import type { Hitbox } from '../core/physics';
import type { Vec3 } from '../core/vec3';
import type { UvRect } from './atlas';
import { CUBE_FACES, type FaceSpec, type Point3, type Uv } from './cube-faces';

/**
 * 火把的样子（见 GLOSSARY.md 的「火把」，#57）：一根细杆，四个侧面加顶面，没有底面。
 *
 * 细杆的尺寸与倾斜角都不另记一份，取核心的 `torchStickBox` 与 `WALL_TORCH_TILT`：地面火把就是那个盒子；
 * 墙上火把从那个盒子出发，绕底面中心往离开墙的方向斜过这个角度，底部仍靠墙。视线与选框用的
 * `torchHitbox` 是斜过之后的外包盒。
 *
 * 贴图约定：细杆在图集那一格里居中、立在格底，侧面取这一竖条，顶面取这一竖条最上面那一小方块——
 * 生成脚本（`tools/gen-atlas.mjs`）按同样的位置画火焰与木杆。
 */

/**
 * 火把贴图里画着细杆的那一竖条，以一格贴图为单位（0 到 1，v 向上）：居中、立在格底，宽与高同细杆。
 * 细杆的侧面取这一竖条，碎屑也只从这里取小块——竖条之外是透明的。
 */
export const TORCH_STICK_UV: UvRect = (() => {
  const { min, max } = torchStickBox(BlockType.Torch, 0, 0, 0)!;
  const width = max.x - min.x;
  return Object.freeze({ u0: 0.5 - width / 2, v0: 0, u1: 0.5 + width / 2, v1: max.y - min.y });
})();

/** 整格立方体的面里细杆用得上的五个：底面贴着地面或埋在墙脚，看不见。 */
const STICK_FACES = CUBE_FACES.filter((spec) => spec.normal[1] !== -1);

/**
 * 一个火把编号的细杆：倾斜之前的盒子（以方块的最小角为原点），与按倾斜摆过去的两个变换。
 * 细杆几何与顶端的位置都用它，两者斜得一样。
 */
interface StickPose {
  readonly box: Hitbox;
  /** 倾斜之前细杆上的一点（以方块的最小角为原点）斜过之后在哪。 */
  readonly place: (point: Point3) => Point3;
  /** 一个方向（法线）斜过之后朝哪。 */
  readonly turn: (direction: Point3) => Point3;
}

function stickPose(block: BlockType): StickPose {
  const box = torchStickBox(block, 0, 0, 0)!;
  const support = torchSupportCell(block, 0, 0, 0)!;
  const { min, max } = box;
  // 倾斜绕的是底面中心；地面火把不斜
  const pivot: Point3 = [(min.x + max.x) / 2, min.y, (min.z + max.z) / 2];
  const tilt = block === BlockType.Torch ? 0 : WALL_TORCH_TILT;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  // 离开墙的那个水平方向
  const outX = -support.x;
  const outZ = -support.z;

  /** 相对底面中心的一个向量，往离开墙的方向转 `tilt`：沿 out 的分量与竖直分量在它俩的平面里转。 */
  const turn = ([x, y, z]: Point3): Point3 => {
    const along = x * outX + z * outZ;
    const turned = along * cos + y * sin;
    return [x + (turned - along) * outX, y * cos - along * sin, z + (turned - along) * outZ];
  };
  const place = ([x, y, z]: Point3): Point3 => {
    const [tx, ty, tz] = turn([x - pivot[0], y - pivot[1], z - pivot[2]]);
    return [tx + pivot[0], ty + pivot[1], tz + pivot[2]];
  };
  return { box, place, turn };
}

function stickModel(block: BlockType): readonly FaceSpec[] {
  const { box, place, turn } = stickPose(block);
  const { min, max } = box;
  const width = max.x - min.x;
  const height = max.y - min.y;

  return STICK_FACES.map((spec) => {
    const top = spec.normal[1] === 1;
    const corners = map4(spec.corners, ([cx, cy, cz]): Point3 =>
      place([min.x + cx * width, min.y + cy * height, min.z + cz * width]),
    );
    // 侧面取居中那一竖条（`TORCH_STICK_UV`），从格底到细杆高度；顶面取竖条最上面那一块 width 见方
    const { u0, v1 } = TORCH_STICK_UV;
    const uv = map4(spec.uv, ([u, v]): Uv => [u0 + u * width, top ? v1 - width + v * width : v * v1]);
    return { normal: turn(spec.normal), corners, uv, face: spec.face };
  });
}

/** 细杆顶端（斜过之后的顶面中心），以方块的最小角为原点。地面火把就是竖直细杆的顶面中心。 */
function stickTip(block: BlockType): Vec3 {
  const { box, place } = stickPose(block);
  const [x, y, z] = place([(box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2]);
  return { x, y, z };
}

/** 对一个面的四个角逐一做同一变换，结果仍是四元组。 */
function map4<T, U>(quad: readonly [T, T, T, T], f: (item: T) => U): readonly [U, U, U, U] {
  return [f(quad[0]), f(quad[1]), f(quad[2]), f(quad[3])];
}

/** 按方块编号排的细杆模型；不是火把的编号是 undefined。网格构建每格查一次，所以先算好。 */
const TORCH_MODELS: (readonly FaceSpec[] | undefined)[] = [];
const TORCH_TIPS: (Vec3 | undefined)[] = [];
for (const block of Object.values(BlockType)) {
  if (!isTorch(block)) continue;
  TORCH_MODELS[block] = stickModel(block);
  TORCH_TIPS[block] = Object.freeze(stickTip(block));
}

/**
 * 这个编号是火把时，它那根细杆的五个面（以方块的最小角为原点）；不是火把时 undefined，按整格立方体画。
 */
export function torchModel(block: BlockType): readonly FaceSpec[] | undefined {
  return TORCH_MODELS[block];
}

/**
 * 这个火把编号的细杆顶端（斜过之后的顶面中心），以方块的最小角为原点。不是火把时 undefined。
 * 火焰光点与烟从它上方一点冒出（`TORCH_EMIT_LIFT`）。
 */
export function torchTip(block: BlockType): Vec3 | undefined {
  return TORCH_TIPS[block];
}
