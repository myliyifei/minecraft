import { baseBlock, BlockType } from './block';
import type { Hitbox } from './physics';
import type { Vec3 } from './vec3';

/**
 * 火把（见 CONTEXT.md 的「火把」，#56）的几条几何规则：贴着哪一格、命中面选哪个编号、视线碰得到的那根细杆。
 *
 * 方块表里那一行（不实心、发光 14、硬度 0……）在 `block.ts`；这里只放由朝向决定的规则。
 * 放置、射线、世界的支撑检查都从这里查，不各记一份朝向表。
 */

/**
 * 支撑：每个火把编号贴着的那一格相对火把的偏移。地面火把贴下方，墙上火把贴编号上写的那一侧。
 *
 * 「哪些编号是火把」在这张表与 `baseBlock` 里各记了一次，两者由测试对齐。
 */
const SUPPORT: Readonly<Partial<Record<BlockType, Vec3>>> = {
  [BlockType.Torch]: { x: 0, y: -1, z: 0 },
  [BlockType.WallTorchNegX]: { x: -1, y: 0, z: 0 },
  [BlockType.WallTorchPosX]: { x: 1, y: 0, z: 0 },
  [BlockType.WallTorchNegZ]: { x: 0, y: 0, z: -1 },
  [BlockType.WallTorchPosZ]: { x: 0, y: 0, z: 1 },
};

/**
 * 一格方块周围可能贴着它的火把在哪：上方与四侧，相对那一格的偏移。下方不算——没有倒挂的火把。
 *
 * 世界把一格改成非不透明方块之后按它查五个邻格（`World.setBlock`）。
 */
export const TORCH_ATTACH_OFFSETS: readonly Vec3[] = Object.freeze(
  Object.values(SUPPORT).map(({ x, y, z }) => ({ x: -x, y: -y, z: -z })),
);

/** 这个编号是火把吗（地面或墙上的任何一个）。 */
export function isTorch(block: BlockType): boolean {
  return baseBlock(block) === BlockType.Torch;
}

/**
 * (x, y, z) 那一格的火把贴着哪一格，不是火把时 undefined。贴着的那一格不再是不透明方块时，
 * 火把在原位变成掉落物（见 CONTEXT.md 的「火把」）。
 */
export function torchSupportCell(block: BlockType, x: number, y: number, z: number): Vec3 | undefined {
  const offset = SUPPORT[block];
  return offset && { x: x + offset.x, y: y + offset.y, z: z + offset.z };
}

/**
 * 对着一块不透明方块的这一面放火把，放下去是哪个编号：顶面是地面火把，四个侧面是贴在那块方块那一侧的
 * 墙上火把（命中 +X 面，火把落在 x + 1，墙在它的 −X 侧），底面是 undefined——没有反应。
 *
 * `normal` 是命中面的外法线（`BlockHit.normal`），三个分量里恰有一个是 ±1。
 */
export function torchOnFace(normal: Vec3): BlockType | undefined {
  // 底面的外法线朝下，对应的支撑在上方，表里没有这样的火把
  for (const [block, offset] of Object.entries(SUPPORT)) {
    if (offset.x === -normal.x && offset.y === -normal.y && offset.z === -normal.z) return Number(block) as BlockType;
  }
  return undefined;
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
  const support = SUPPORT[block];
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
  const support = SUPPORT[block];
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
