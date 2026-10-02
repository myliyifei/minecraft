import * as THREE from 'three';
import { TAU } from '../core/constants';
import type { ZombieView } from '../core/zombie';
import { TILE, boxUvs } from './atlas';
import { setTint, tintOf } from './light-material';

/**
 * 僵尸的六部件人形：头、身体、两条手臂、两条腿，各是一个长方体，拼成一个 `Group`。
 *
 * 表现整个在渲染层（ADR-0007）：核心只报位置、上一 tick 的位置、偏航、存活 tick 数、上次受伤的 tick 与
 * 是否在燃烧，摆臂摆腿的角度由这里按 `age + alpha` 算，受击叠红按 tick 差算，燃烧叠橙。不碰 DOM，所以能在 Node 里建出模型
 * 对它断言。
 */

/** 部件的名字。场景对象按它命名，测试与渲染层都按名字找部件。 */
export const ZombiePart = {
  Head: 'head',
  Body: 'body',
  RightArm: 'rightArm',
  LeftArm: 'leftArm',
  RightLeg: 'rightLeg',
  LeftLeg: 'leftLeg',
} as const;

export type ZombiePart = (typeof ZombiePart)[keyof typeof ZombiePart];

/** 会摆的四个部件，顺序是右臂、左臂、右腿、左腿。 */
export const ZOMBIE_LIMBS: readonly ZombiePart[] = [
  ZombiePart.RightArm,
  ZombiePart.LeftArm,
  ZombiePart.RightLeg,
  ZombiePart.LeftLeg,
];

/** 走动时臂腿前后摆一个来回要多少 tick。 */
export const ZOMBIE_SWING_TICKS = 20;

/** 摆动的幅度（弧度），约 34°。 */
export const ZOMBIE_SWING_ANGLE = 0.6;

/**
 * 受击后叠红持续几 tick：受伤那一 tick 起算，10 tick 之后恢复。
 *
 * 与僵尸的无敌时间同为 10，但两者各管各的，理由同玩家的 `HURT_FLASH_TICKS`：这个数只决定红多久。
 */
export const ZOMBIE_HURT_TINT_TICKS = 10;

/**
 * 叠红的颜色，乘在贴图上：红分量不动，绿与蓝压到四成多。灰绿的皮肤乘出来是暗红，夜里也看得出。
 */
const HURT_TINT = 0xff7070;

/** 燃烧中叠橙的颜色，乘在贴图上：红分量不动，绿压到七成，蓝压到三成。与叠红分得开。 */
const BURNING_TINT = 0xffb050;

/** 不叠色：乘白色，就是贴图本色。 */
const NO_TINT = 0xffffff;

/** 模型按像素量尺寸，16 像素一格，与贴图的像素一样大。 */
const PX = 1 / 16;

/**
 * 一个部件的形状与摆法，都以像素计、相对脚底中心。
 *
 * `pivot` 是部件的转轴：四肢绕肩与胯转，所以四肢的长方体挂在转轴下面（`hangs`），头与身体
 * 立在转轴上面。`tiles` 按 `BoxGeometry` 的面序（+X、−X、+Y、−Y、+Z、−Z）给六面各取哪一格。
 * 模型朝 −Z，与核心偏航 0 的前方一致，所以脸在 −Z 面上；它的右手边是 +X。
 */
interface PartShape {
  readonly size: readonly [number, number, number];
  readonly pivot: readonly [number, number, number];
  readonly hangs: boolean;
  readonly tiles: readonly number[];
}

const SKIN = TILE.zombieSkin;
const all = (tile: number): readonly number[] => [tile, tile, tile, tile, tile, tile];

const PART_SHAPES: Readonly<Record<ZombiePart, PartShape>> = {
  [ZombiePart.Head]: {
    size: [8, 8, 8],
    pivot: [0, 24, 0],
    hangs: false,
    tiles: [SKIN, SKIN, SKIN, SKIN, SKIN, TILE.zombieFace],
  },
  [ZombiePart.Body]: { size: [8, 12, 4], pivot: [0, 12, 0], hangs: false, tiles: all(TILE.zombieShirt) },
  [ZombiePart.RightArm]: { size: [4, 12, 4], pivot: [6, 24, 0], hangs: true, tiles: all(SKIN) },
  [ZombiePart.LeftArm]: { size: [4, 12, 4], pivot: [-6, 24, 0], hangs: true, tiles: all(SKIN) },
  [ZombiePart.RightLeg]: { size: [4, 12, 4], pivot: [2, 12, 0], hangs: true, tiles: all(TILE.zombiePants) },
  [ZombiePart.LeftLeg]: { size: [4, 12, 4], pivot: [-2, 12, 0], hangs: true, tiles: all(TILE.zombiePants) },
};

/** 六个部件的几何体，按部件名索引。 */
export type ZombieGeometries = Readonly<Record<ZombiePart, THREE.BufferGeometry>>;

/**
 * 建六个部件的几何体。所有僵尸长得一样，渲染层建一份让每只共用，僵尸消失时不销毁。
 *
 * 几何体的原点就是部件的转轴：长方体先按 `hangs` 挪到转轴下面或上面，部件的场景对象摆在转轴处，
 * 改 `rotation.x` 就是绕肩、胯摆。
 */
export function zombieGeometries(): ZombieGeometries {
  const geometries = {} as Record<ZombiePart, THREE.BufferGeometry>;
  for (const name of Object.values(ZombiePart)) {
    const { size, hangs, tiles } = PART_SHAPES[name];
    const [w, h, d] = size;
    const geometry = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
    geometry.translate(0, ((hangs ? -h : h) / 2) * PX, 0);
    // BoxGeometry 默认每个面铺满整张贴图，换成图集里那一格（`boxUvs`）。
    geometry.setAttribute('uv', new THREE.BufferAttribute(boxUvs(tiles), 2));
    geometries[name] = geometry;
  }
  return geometries;
}

/**
 * 一只僵尸的模型：一个组，六个部件各一个 `Mesh`，按名字找得到。组的原点在脚底中心。
 *
 * 六个部件共用传进来的这一份材质。渲染层给每只僵尸一份自己的光照材质（`entityMaterial`）：所在格的光照
 * 等级与叠色都是这一只自己的。
 */
export function createZombieModel(
  geometries: ZombieGeometries,
  material: THREE.ShaderMaterial,
): THREE.Group {
  const group = new THREE.Group();
  for (const name of Object.values(ZombiePart)) {
    const mesh = new THREE.Mesh(geometries[name], material);
    mesh.name = name;
    const [x, y, z] = PART_SHAPES[name].pivot;
    mesh.position.set(x * PX, y * PX, z * PX);
    group.add(mesh);
  }
  return group;
}

/**
 * 按核心里那只僵尸摆模型：位置在两个 tick 之间插值（ADR-0002），整体按偏航转，走动时摆臂摆腿。
 *
 * 「走动」看的是这一 tick 水平方向动没动，核心不另报。停下来那一 tick 四肢直接回到 0——僵尸
 * 走走停停的次数不多，不值得为回正再存一份渲染层的状态。
 */
export function poseZombieModel(group: THREE.Group, zombie: ZombieView, alpha: number): void {
  const { position, previousPosition } = zombie;
  group.position.set(
    lerp(previousPosition.x, position.x, alpha),
    lerp(previousPosition.y, position.y, alpha),
    lerp(previousPosition.z, position.z, alpha),
  );
  group.rotation.y = zombie.yaw;

  const moving = position.x !== previousPosition.x || position.z !== previousPosition.z;
  const swing = moving ? limbSwing(zombie.age + alpha) : 0;
  // 右臂与左腿同向、左臂与右腿同向，与人迈步时一样。绕 x 轴转正角是往 −Z（前方）抬。
  const [rightArm, leftArm, rightLeg, leftLeg] = ZOMBIE_LIMBS.map((name) => group.getObjectByName(name)!);
  rightArm!.rotation.x = swing;
  leftArm!.rotation.x = -swing;
  rightLeg!.rotation.x = -swing;
  leftLeg!.rotation.x = swing;
}

/** 上次受伤在 lastHurtTick、此刻是第 now 个 tick 时，该不该叠红。还没受过伤不叠。 */
export function zombieHurtTinted(lastHurtTick: number | undefined, now: number): boolean {
  return lastHurtTick !== undefined && now - lastHurtTick < ZOMBIE_HURT_TINT_TICKS;
}

/**
 * 受击后 `ZOMBIE_HURT_TINT_TICKS` 内叠红；不在叠红里、燃烧中的叠橙；都不是就不叠色。叠色是模型那一份材质
 * 上的 uniform（`setTint`），六个部件一起变。now 是核心的 tick 计数。按 tick 而不是按毫秒算，与玩家的
 * 受伤红闪同一条理由：时长与游戏时间一致。
 *
 * 叠红压过叠橙：燃烧中的僵尸被打了，那一下也要看得出来。燃烧本身每 20 tick 扣一次血，所以烧着的僵尸
 * 红橙交替，与原版一样。
 */
export function tintZombieModel(group: THREE.Group, zombie: ZombieView, now: number): void {
  const tint = zombieHurtTinted(zombie.lastHurtTick, now)
    ? HURT_TINT
    : zombie.burning
      ? BURNING_TINT
      : NO_TINT;
  setTint(zombieMaterial(group), tint);
}

/** 模型此刻的叠色（sRGB 十六进制）：平时是白色，受击后偏红，燃烧中偏橙。 */
export function zombieTint(group: THREE.Group): number {
  return tintOf(zombieMaterial(group));
}

/** 模型那一份光照材质：六个部件共用，读头那一个就够。 */
export function zombieMaterial(group: THREE.Group): THREE.ShaderMaterial {
  return (group.getObjectByName(ZombiePart.Head) as THREE.Mesh).material as THREE.ShaderMaterial;
}

/** 相位（tick，可带小数）对应的摆角（弧度），落在 ±`ZOMBIE_SWING_ANGLE` 之间。 */
function limbSwing(phase: number): number {
  return ZOMBIE_SWING_ANGLE * Math.sin((phase / ZOMBIE_SWING_TICKS) * TAU);
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}
