import { BlockType } from '../core/block';
import { isTorch, torchStickBox, torchSupportCell, WALL_TORCH_TILT } from '../core/torch';
import { CUBE_FACES, type FaceSpec, type Point3, type Uv } from './cube-faces';

/**
 * 火把的样子（见 CONTEXT.md 的「火把」，#57）：一根细杆，四个侧面加顶面，没有底面。
 *
 * 细杆的尺寸与倾斜角都不另记一份，取核心的 `torchStickBox` 与 `WALL_TORCH_TILT`：地面火把就是那个盒子；
 * 墙上火把从那个盒子出发，绕底面中心往离开墙的方向斜过这个角度，底部仍靠墙。视线与选框用的
 * `torchHitbox` 是斜过之后的外包盒。
 *
 * 贴图约定：细杆在图集那一格里居中、立在格底，侧面取这一竖条，顶面取这一竖条最上面那一小方块——
 * 生成脚本（`tools/gen-atlas.mjs`）按同样的位置画火焰与木杆。
 */

/** 整格立方体的面里细杆用得上的五个：底面贴着地面或埋在墙脚，看不见。 */
const STICK_FACES = CUBE_FACES.filter((spec) => spec.normal[1] !== -1);

function stickModel(block: BlockType): readonly FaceSpec[] {
  const { min, max } = torchStickBox(block, 0, 0, 0)!;
  const support = torchSupportCell(block, 0, 0, 0)!;
  const width = max.x - min.x;
  const height = max.y - min.y;
  // 倾斜绕的是底面中心；地面火把不斜
  const pivot: Point3 = [(min.x + max.x) / 2, min.y, (min.z + max.z) / 2];
  const tilt = block === BlockType.Torch ? 0 : WALL_TORCH_TILT;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  // 离开墙的那个水平方向
  const outX = -support.x;
  const outZ = -support.z;

  /** 相对底面中心的一个向量，往离开墙的方向转 `tilt`：沿 out 的分量与竖直分量在它俩的平面里转。 */
  const rotate = ([x, y, z]: Point3): Point3 => {
    const along = x * outX + z * outZ;
    const turned = along * cos + y * sin;
    return [x + (turned - along) * outX, y * cos - along * sin, z + (turned - along) * outZ];
  };

  return STICK_FACES.map((spec) => {
    const top = spec.normal[1] === 1;
    const corners = map4(spec.corners, ([cx, cy, cz]): Point3 => {
      const [x, y, z] = rotate([
        min.x + cx * width - pivot[0],
        min.y + cy * height - pivot[1],
        min.z + cz * width - pivot[2],
      ]);
      return [x + pivot[0], y + pivot[1], z + pivot[2]];
    });
    // 侧面取居中那一竖条，从格底到细杆高度；顶面取竖条最上面那一块 width 见方
    const uv = map4(spec.uv, ([u, v]): Uv => [
      0.5 - width / 2 + u * width,
      top ? height - width + v * width : v * height,
    ]);
    return { normal: rotate(spec.normal), corners, uv, face: spec.face };
  });
}

/** 对一个面的四个角逐一做同一变换，结果仍是四元组。 */
function map4<T, U>(quad: readonly [T, T, T, T], f: (item: T) => U): readonly [U, U, U, U] {
  return [f(quad[0]), f(quad[1]), f(quad[2]), f(quad[3])];
}

/** 按方块编号排的细杆模型；不是火把的编号是 undefined。网格构建每格查一次，所以先算好。 */
const TORCH_MODELS: (readonly FaceSpec[] | undefined)[] = [];
for (const block of Object.values(BlockType)) {
  if (isTorch(block)) TORCH_MODELS[block] = stickModel(block);
}

/**
 * 这个编号是火把时，它那根细杆的五个面（以方块的最小角为原点）；不是火把时 undefined，按整格立方体画。
 */
export function torchModel(block: BlockType): readonly FaceSpec[] | undefined {
  return TORCH_MODELS[block];
}
