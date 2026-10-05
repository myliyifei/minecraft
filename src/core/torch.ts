import { baseBlock, BlockType, supportCell } from './block';
import type { Hitbox } from './physics';
import type { Vec3 } from './vec3';

/**
 * 火把（见 CONTEXT.md 的「火把」，#56）的几条几何规则：贴着哪一格、命中面选哪个编号、视线碰得到的那根细杆。
 *
 * 方块表里那一行（不实心、发光 14、硬度 0……）与贴着哪一格（支撑表 `supportCell`，ADR-0012 补记）在 `block.ts`；
 * 这里只放由朝向决定的几何：命中面选哪个编号、细杆与命中盒。朝向都从支撑表的偏移推出，不另记一份。
 */

/** 五个火把编号：地面火把在前，四个墙上火把按 −X、+X、−Z、+Z。 */
const TORCHES: readonly BlockType[] = [
  BlockType.Torch,
  BlockType.WallTorchNegX,
  BlockType.WallTorchPosX,
  BlockType.WallTorchNegZ,
  BlockType.WallTorchPosZ,
];

/** 一个火把编号贴着的那一格相对火把的偏移（取支撑表 `supportCell`），不是火把时 undefined。 */
function supportOffset(block: BlockType): Vec3 | undefined {
  return isTorch(block) ? supportCell(block, 0, 0, 0) : undefined;
}

/** 这个编号是火把吗（地面或墙上的任何一个）。 */
export function isTorch(block: BlockType): boolean {
  return baseBlock(block) === BlockType.Torch;
}

/**
 * (x, y, z) 那一格的火把贴着哪一格，不是火把时 undefined（植物也贴着下面那一格，但不是火把，这里不认）。
 * 贴着的那一格不再是不透明方块时，火把在原位变成掉落物（见 CONTEXT.md 的「火把」）。
 */
export function torchSupportCell(block: BlockType, x: number, y: number, z: number): Vec3 | undefined {
  return isTorch(block) ? supportCell(block, x, y, z) : undefined;
}

/**
 * 对着一块不透明方块的这一面放火把，放下去是哪个编号：顶面是地面火把，四个侧面是贴在那块方块那一侧的
 * 墙上火把（命中 +X 面，火把落在 x + 1，墙在它的 −X 侧），底面是 undefined——没有反应。
 *
 * `normal` 是命中面的外法线（`BlockHit.normal`），三个分量里恰有一个是 ±1。
 */
export function torchOnFace(normal: Vec3): BlockType | undefined {
  // 底面的外法线朝下，对应的支撑在上方，没有这样的火把
  return TORCHES.find((block) => {
    const offset = supportOffset(block)!;
    return offset.x === -normal.x && offset.y === -normal.y && offset.z === -normal.z;
  });
}

/** 细杆截面的半边长：截面 2/16。 */
const STICK_HALF = 1 / 16;
/** 细杆的高度：10/16。 */
const STICK_HEIGHT = 10 / 16;
/** 墙上火把的细杆比格底抬高多少：3/16。 */
const WALL_LIFT = 3 / 16;
/**
 * 墙上火把往外斜的角度：22.5°（#57）。细杆以底面中心为轴，顶端往离开墙的方向倒，底部仍靠墙。
 *
 * 画面按这个角度画（`src/render/torch-model.ts`），视线碰的盒子也按它取外包盒（`torchHitbox`），
 * 所以记在核心里，两边读同一个数。
 */
export const WALL_TORCH_TILT = Math.PI / 8;

/**
 * (x, y, z) 那一格火把的细杆**倾斜之前**占的轴对齐盒子（世界坐标），不是火把时 undefined。
 *
 * 地面火把以格中心为轴、落在格底，它就是细杆本身；墙上火把同样截面与高度，贴着墙那一侧、底部抬高 3/16，
 * 画面再把它绕底面中心斜 `WALL_TORCH_TILT`。视线用的是 `torchHitbox`。
 */
export function torchStickBox(block: BlockType, x: number, y: number, z: number): Hitbox | undefined {
  const support = supportOffset(block);
  if (!support) return undefined;
  const lift = support.y < 0 ? 0 : WALL_LIFT;
  // 截面中心：沿贴墙那个轴挪到紧贴墙面，另一个轴在格中心
  const cx = x + 0.5 + support.x * (0.5 - STICK_HALF);
  const cz = z + 0.5 + support.z * (0.5 - STICK_HALF);
  return {
    min: { x: cx - STICK_HALF, y: y + lift, z: cz - STICK_HALF },
    max: { x: cx + STICK_HALF, y: y + lift + STICK_HEIGHT, z: cz + STICK_HALF },
  };
}

/**
 * (x, y, z) 那一格火把的细杆占的轴对齐盒子（世界坐标），不是火把时 undefined。视线只碰得到它（`raycastBlocks`），
 * 选框也套它。
 *
 * 地面火把就是 `torchStickBox`。墙上火把是斜过 `WALL_TORCH_TILT` 之后那根细杆的外包盒：朝外伸到
 * 截面半边长·cos + 高度·sin，底与顶各被斜过的截面带出半边长·sin，贴墙那一侧缩回半边长·(1 − cos)。
 * 盒子仍是轴对齐的，所以斜杆旁边的一小块空处也算碰到。
 */
export function torchHitbox(block: BlockType, x: number, y: number, z: number): Hitbox | undefined {
  const box = torchStickBox(block, x, y, z);
  const support = supportOffset(block);
  if (!box || !support || support.y < 0) return box;
  const cos = Math.cos(WALL_TORCH_TILT);
  const sin = Math.sin(WALL_TORCH_TILT);
  // 沿离开墙的方向，相对截面中心：贴墙那边到 −半边长·cos，朝外那边到 半边长·cos + 高度·sin
  const near = STICK_HALF * cos;
  const far = STICK_HALF * cos + STICK_HEIGHT * sin;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  // 离开墙的方向是 −support；沿另一个轴的那一对不变
  const spanX = support.x === 0 ? [box.min.x, box.max.x] : support.x < 0 ? [cx - near, cx + far] : [cx - far, cx + near];
  const spanZ = support.z === 0 ? [box.min.z, box.max.z] : support.z < 0 ? [cz - near, cz + far] : [cz - far, cz + near];
  return {
    min: { x: spanX[0]!, y: box.min.y - STICK_HALF * sin, z: spanZ[0]! },
    max: { x: spanX[1]!, y: box.min.y + STICK_HEIGHT * cos + STICK_HALF * sin, z: spanZ[1]! },
  };
}
