import { BlockType, isSolid } from '../core/block';
import { MAX_LIGHT_LEVEL } from '../core/constants';
import type { BrokenBlock, MiningView } from '../core/mining';
import { isTorch } from '../core/torch';
import type { Vec3 } from '../core/vec3';
import { BLOCK_TILES, faceTile, TILE, tileUvRect, type UvRect } from './atlas';
import { CUBE_FACES, type FaceSpec } from './cube-faces';
import type { GlowingBlock } from './mesh';
import { selectionBounds } from './selection';
import { SELF_LIT_BLOCK_LIGHT } from './shading';
import { TORCH_STICK_UV, torchTip } from './torch-model';

/**
 * 粒子（见 GLOSSARY.md 的「粒子」，#59）：只画在画面上的小片，不碰实体、不进任何规则。
 *
 * 这个文件是粒子池与发射规则（火把与熔炉冒火焰光点与烟，挖掘溅碎屑），纯数学、不 import three，因此能在
 * Node 里测。池子里的几条数组按显卡实例属性的排布存（`positions`、`sizes`、`uvRects`、`lights`、`alphas`），
 * 存活的粒子总排在前 `count` 个：渲染层直接把这几条数组交给实例化几何体，不必每帧再复制一遍。
 *
 * 随机数走渲染层自己的（默认 `Math.random`），不要求可复现：粒子不在核心，不受 ADR-0014 约束。
 */

/** 粒子的种类。值是字符串：读回视图按它报数量（`ParticleCounts`），不进存档。 */
export const ParticleKind = {
  Flame: 'flame',
  Smoke: 'smoke',
  /** 碎屑（见 GLOSSARY.md 的「碎屑」，#60）：挖掘时从方块上溅出的小块。 */
  Debris: 'debris',
} as const;

export type ParticleKind = (typeof ParticleKind)[keyof typeof ParticleKind];

/**
 * 粒子总数的上限：所有种类共用。满了不再生成，已有的照常消失。
 *
 * 一个火把同时存活的粒子平均不到 3 个（`TORCH_EMISSIONS` 的频率乘存活时间），16 格内插满火把也到不了这么多；
 * 挖掘碎屑每碎一块爆 64 个，持铁铲连续挖泥土也只有几百个。这个数是为最坏情况设的上限。Windows 无头 Edge
 * 实测池子装满时帧率不变（#59）。
 */
export const PARTICLE_LIMIT = 2000;

/** 只有玩家眼睛这么多格内（到方块中心的直线距离）的发光方块冒粒子。 */
export const EMIT_RANGE = 16;

/**
 * 一帧最多推进多少秒。标签页切回前台时两帧之间可能隔了几十秒：按实际间隔算，所有粒子同时到期，
 * 发射又按这段间隔一次生成大量粒子。
 */
const MAX_STEP_SECONDS = 0.1;

/**
 * 每种粒子的样子与运动：自不自发光、会不会变淡，大小在存活期间从 1 倍变到 `endScale` 倍，受不受重力、
 * 撞不撞方块。贴图不在这里：碎屑的贴图看是哪种方块，每个粒子生成时给出（`ParticleSpawn.uv`）。
 */
interface KindLook {
  /** 自发光的粒子不读所在格的光照，按贴图本色画（与火把本身同一个标记，见 `SELF_LIT_BLOCK_LIGHT`）。 */
  readonly selfLit: boolean;
  /** 刚生成时的不透明度；会变淡的粒子到期时降到 0，不变淡的一直是它。 */
  readonly opacity: number;
  readonly fades: boolean;
  readonly endScale: number;
  /** 重力加速度（格/秒²），不受重力的是 0。 */
  readonly gravity: number;
  /** 撞到实心方块就停住（`ParticlePool.step`）。 */
  readonly collides: boolean;
}

/**
 * 碎屑的重力加速度（格/秒²）。原版是每 tick 0.04 格/tick，折合 16 格/秒²，再加每 tick 2% 的阻力；
 * 这里没有阻力，取小一点，下落的样子与原版相近。
 */
const DEBRIS_GRAVITY = 12;

/**
 * 撞方块的粒子一步最多走多远（格）。一帧的位移超过它就拆成几步，每步各查一次：帧间隔 0.1 秒时碎屑一帧能落
 * 一格多，只查终点会穿过一层厚的平台。
 */
const MAX_COLLIDING_STEP = 0.25;

const LOOKS: Readonly<Record<ParticleKind, KindLook>> = {
  // 火焰光点越来越小，不变淡，到期消失
  [ParticleKind.Flame]: { selfLit: true, opacity: 1, fades: false, endScale: 0.5, gravity: 0, collides: false },
  // 烟越飘越大、越来越淡
  [ParticleKind.Smoke]: { selfLit: false, opacity: 0.85, fades: true, endScale: 2, gravity: 0, collides: false },
  // 碎屑大小不变、不变淡，受重力，落到方块上停住，到期消失
  [ParticleKind.Debris]: {
    selfLit: false,
    opacity: 1,
    fades: false,
    endScale: 1,
    gravity: DEBRIS_GRAVITY,
    collides: true,
  },
};

/**
 * 生成一个粒子要给的东西：位置与速度（格、格/秒）、存活时间（秒）、刚生成时的边长（格），与贴图在图集里的
 * uv 矩形——火焰光点与烟是整格，碎屑是方块贴图里的一小块。
 */
export interface ParticleSpawn {
  readonly kind: ParticleKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly life: number;
  readonly size: number;
  readonly uv: UvRect;
}

/**
 * 粒子从世界里读的三样：按格读两个光照等级（烟与碎屑按所在格的亮度画），与方块（碎屑撞到实心方块停住，
 * 溅出的碎屑看被挖的是哪种方块）。核心的 `skyLightAt`、`blockLightAt`、`getBlock` 就是这三个。
 */
export interface ParticleWorldView {
  skyLightAt(x: number, y: number, z: number): number;
  blockLightAt(x: number, y: number, z: number): number;
  getBlock(x: number, y: number, z: number): BlockType;
}

/**
 * 溅碎屑从挖掘视图里读的那几样：瞄着哪块、在不在挖、挖了多少。碎掉的方块不在这里：它只在一 tick 里有值，
 * 渲染层每推进一个 tick 读一次，交给 `ParticleSystem.burst`。
 */
export type DiggingView = Pick<MiningView, 'target' | 'digging' | 'progress'>;

/** 当前存活的粒子按种类的数量与总数。读回视图报的就是它。 */
export type ParticleCounts = Readonly<Record<ParticleKind, number>> & { readonly total: number };

/**
 * 固定大小的粒子池：每帧推进、到期回收，满了不再生成。
 *
 * 回收是把最后一个存活的粒子移入空出来的位置：存活的总在前 `count` 个，渲染层画前 `count` 个就是全部。
 * 回收会打乱先后顺序，所以每帧画之前按离相机的距离重排一次（`sortBackToFront`）。
 */
export class ParticlePool {
  readonly capacity: number;
  /** 每个粒子的中心，3 个数一组（世界坐标）。 */
  readonly positions: Float32Array;
  /** 每个粒子这一帧的边长（格）。 */
  readonly sizes: Float32Array;
  /** 每个粒子贴图在图集里的 uv 矩形，4 个数一组：u0、v0、u1、v1。 */
  readonly uvRects: Float32Array;
  /** 每个粒子这一帧的天光与方块光，2 个数一组。自发光的粒子是 15 与 `SELF_LIT_BLOCK_LIGHT`。 */
  readonly lights: Float32Array;
  /** 每个粒子这一帧的不透明度。 */
  readonly alphas: Float32Array;
  /** 每个粒子的种类。 */
  readonly kinds: ParticleKind[] = [];
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly lives: Float32Array;
  private readonly startSizes: Float32Array;
  /** 每个粒子占一段的那些数组与每段的长度。回收与重排对它们逐一做同样的移动。 */
  private readonly columns: readonly (readonly [Float32Array, number])[];
  /** 重排用的暂存：每个粒子到相机的距离平方、排好的下标、一份数组的副本。 */
  private readonly depths: Float32Array;
  private readonly order: number[] = [];
  private readonly scratch: Float32Array;
  private readonly kindScratch: ParticleKind[] = [];
  private alive = 0;

  constructor(capacity = PARTICLE_LIMIT) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.uvRects = new Float32Array(capacity * 4);
    this.lights = new Float32Array(capacity * 2);
    this.alphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
    this.startSizes = new Float32Array(capacity);
    this.columns = [
      [this.positions, 3],
      [this.velocities, 3],
      [this.uvRects, 4],
      [this.lights, 2],
      [this.sizes, 1],
      [this.alphas, 1],
      [this.ages, 1],
      [this.lives, 1],
      [this.startSizes, 1],
    ];
    this.depths = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity * 4);
  }

  /** 当前存活的粒子数。 */
  get count(): number {
    return this.alive;
  }

  /** 生成一个粒子。池子满了返回 false，什么都不做。 */
  spawn(p: ParticleSpawn): boolean {
    if (this.alive >= this.capacity) return false;
    const i = this.alive++;
    const look = LOOKS[p.kind];
    this.kinds[i] = p.kind;
    this.positions.set([p.x, p.y, p.z], i * 3);
    this.velocities.set([p.vx, p.vy, p.vz], i * 3);
    this.uvRects.set([p.uv.u0, p.uv.v0, p.uv.u1, p.uv.v1], i * 4);
    this.ages[i] = 0;
    this.lives[i] = p.life;
    this.startSizes[i] = p.size;
    this.sizes[i] = p.size;
    this.alphas[i] = look.opacity;
    // 不自发光的粒子在下一次 `step` 读到所在格之前按 0 级画：在洞里生成时第一帧偏暗，不会先亮后暗
    this.lights.set(look.selfLit ? [MAX_LIGHT_LEVEL, SELF_LIT_BLOCK_LIGHT] : [0, 0], i * 2);
    return true;
  }

  /**
   * 推进 `seconds` 秒：按速度移动位置，到期的回收，留下的按存活进度改大小与不透明度，不自发光的重读所在格的光照。
   *
   * 受重力的先把重力加进速度。撞方块的（碎屑）推进前先看下一位置是不是实心（`advanceColliding`），实心就停住、
   * 速度归零，不穿进方块里。停住之后重力每帧又给它一点往下的速度，下面还是实心就接着停着；撞的是侧面的墙，
   * 下一帧往下落，于是沿墙落到地上。
   */
  step(seconds: number, world: ParticleWorldView): void {
    let i = 0;
    while (i < this.alive) {
      const age = this.ages[i]! + seconds;
      if (age >= this.lives[i]!) {
        this.remove(i);
        continue;
      }
      this.ages[i] = age;
      const look = LOOKS[this.kinds[i]!];
      const { positions, velocities } = this;
      const p = i * 3;
      if (look.gravity > 0) velocities[p + 1] = velocities[p + 1]! - look.gravity * seconds;
      if (look.collides) {
        this.advanceColliding(i, seconds, world);
      } else {
        for (let axis = 0; axis < 3; axis++) positions[p + axis] = positions[p + axis]! + velocities[p + axis]! * seconds;
      }
      const x = positions[p]!;
      const y = positions[p + 1]!;
      const z = positions[p + 2]!;

      const progress = age / this.lives[i]!;
      this.sizes[i] = this.startSizes[i]! * (1 + (look.endScale - 1) * progress);
      if (look.fades) this.alphas[i] = look.opacity * (1 - progress);
      if (!look.selfLit) {
        this.lights[i * 2] = world.skyLightAt(x, y, z);
        this.lights[i * 2 + 1] = world.blockLightAt(x, y, z);
      }
      i++;
    }
  }

  /**
   * 把存活的粒子按离 `eye` 由远到近重排。
   *
   * 粒子按不透明度混合，后画的盖在先画的上面：远处的先画，近处的烟才会叠在远处的火焰光点上面，
   * 而不是被它盖住。粒子都不写深度，彼此之间只能靠绘制顺序。
   */
  sortBackToFront(eye: Vec3): void {
    const n = this.alive;
    const { depths, order, positions } = this;
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3]! - eye.x;
      const dy = positions[i * 3 + 1]! - eye.y;
      const dz = positions[i * 3 + 2]! - eye.z;
      depths[i] = dx * dx + dy * dy + dz * dz;
      order[i] = i;
    }
    order.length = n;
    order.sort((a, b) => depths[b]! - depths[a]!);

    for (const [array, size] of this.columns) {
      this.scratch.set(array.subarray(0, n * size));
      for (let i = 0; i < n; i++) array.set(this.scratch.subarray(order[i]! * size, order[i]! * size + size), i * size);
    }
    for (let i = 0; i < n; i++) this.kindScratch[i] = this.kinds[i]!;
    for (let i = 0; i < n; i++) this.kinds[i] = this.kindScratch[order[i]!]!;
  }

  /** 当前存活的粒子按种类的数量与总数。 */
  counts(): ParticleCounts {
    const counts = Object.fromEntries(Object.values(ParticleKind).map((kind) => [kind, 0])) as Record<ParticleKind, number>;
    for (let i = 0; i < this.alive; i++) counts[this.kinds[i]!]++;
    return { ...counts, total: this.alive };
  }

  /**
   * 撞方块的第 i 个粒子按速度推进 `seconds` 秒。位移拆成不超过 `MAX_COLLIDING_STEP` 的几步，每步先看下一位置
   * 是不是实心：往下与水平走看粒子底边中点那一格，往上走看顶边中点那一格。碰到实心就停住、速度归零；往下落时
   * 碰到的是脚下那块，就把底边贴到那块的顶面上，不悬在半空——低帧率时一步落得多，停在原处会离地面明显一截。
   */
  private advanceColliding(i: number, seconds: number, world: ParticleWorldView): void {
    const { positions, velocities } = this;
    const p = i * 3;
    const half = this.sizes[i]! / 2;
    const dx = velocities[p]! * seconds;
    const dy = velocities[p + 1]! * seconds;
    const dz = velocities[p + 2]! * seconds;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / MAX_COLLIDING_STEP));
    const solidAt = (x: number, y: number, z: number) =>
      isSolid(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
    for (let step = 0; step < steps; step++) {
      const x = positions[p]!;
      const y = positions[p + 1]!;
      const z = positions[p + 2]!;
      const nextX = x + dx / steps;
      const nextY = y + dy / steps;
      const nextZ = z + dz / steps;
      const edge = dy > 0 ? nextY + half : nextY - half;
      if (solidAt(nextX, edge, nextZ)) {
        // 正下方那块挡住了：底边贴到它的顶面。底边本来就在实心方块里（生成在方块里）时不往上挪。
        const floorTop = Math.floor(edge) + 1 + half;
        if (dy < 0 && solidAt(x, edge, z) && floorTop <= y) positions[p + 1] = floorTop;
        velocities.fill(0, p, p + 3);
        return;
      }
      positions[p] = nextX;
      positions[p + 1] = nextY;
      positions[p + 2] = nextZ;
    }
  }

  /** 回收第 i 个：最后一个存活的移入它的位置。 */
  private remove(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    this.kinds[i] = this.kinds[last]!;
    for (const [array, size] of this.columns) array.copyWithin(i * size, last * size, last * size + size);
  }
}

/**
 * 一种发光方块冒一种粒子的规则：平均每秒几个、存活时间与边长的范围、速度。
 *
 * 数值按画面定（Windows 浏览器实机看），原则是：火焰光点小、存活时间短、几乎不动；烟稍大、存活时间长、往上飘。
 */
interface Emission {
  readonly kind: ParticleKind;
  /** 整格贴图在图集里的 uv 矩形。 */
  readonly uv: UvRect;
  /** 平均每秒冒几个。 */
  readonly rate: number;
  /** 存活时间（秒）：在这两个数之间均匀取。 */
  readonly life: readonly [number, number];
  /** 刚生成时的边长（格）：在这两个数之间均匀取。 */
  readonly size: readonly [number, number];
  /** 往上的速度（格/秒）：在这两个数之间均匀取。 */
  readonly rise: readonly [number, number];
  /** 水平方向的漂移（格/秒）：两个分量各在 ±它之间均匀取。 */
  readonly drift: number;
}

const FLAME: Omit<Emission, 'rate'> = {
  kind: ParticleKind.Flame,
  uv: tileUvRect(TILE.flame),
  life: [0.4, 0.7],
  size: [0.09, 0.13],
  rise: [0.02, 0.06],
  drift: 0.01,
};

const SMOKE: Omit<Emission, 'rate'> = {
  kind: ParticleKind.Smoke,
  uv: tileUvRect(TILE.smoke),
  life: [1.2, 2.2],
  size: [0.1, 0.14],
  rise: [0.35, 0.55],
  drift: 0.02,
};

/** 火把一直在烧，冒得勤；燃烧中的熔炉「偶尔」冒（见 GLOSSARY.md 的「粒子」）。 */
const TORCH_EMISSIONS: readonly Emission[] = [
  { ...FLAME, rate: 1.5 },
  { ...SMOKE, rate: 1.2 },
];
const FURNACE_EMISSIONS: readonly Emission[] = [
  { ...FLAME, rate: 0.5 },
  { ...SMOKE, rate: 0.5 },
];

/**
 * 火把的粒子冒在细杆顶端之上多高（格）：火焰光点比火把头窄，中心正落在顶端的话，下半截埋在火把头里，
 * 上半截也被火把头挡住，画面上看不见。
 */
export const TORCH_EMIT_LIFT = 0.07;

/** 熔炉的粒子冒在正面前方多远（格）。 */
const FURNACE_FRONT_GAP = 0.08;

/**
 * 熔炉的正面朝哪：贴正面贴图的那几面的法线（−X 与 −Z，见 `atlas.ts` 的 `FaceTiles`）。取网格的面表，
 * 冒粒子的那一面与画炉口的那一面不会对不上。
 */
const FRONT_NORMALS = CUBE_FACES.filter((spec) => spec.face === 'front').map((spec) => spec.normal);

/** 一种发光方块怎么冒粒子：冒哪几种，与相对方块最小角的冒出位置（每个粒子取一次，可以带随机）。 */
interface Emitter {
  readonly emissions: readonly Emission[];
  readonly point: (random: () => number) => Vec3;
}

/** 燃烧中的熔炉：随机一个正面前方，横向在面中间那一段、高度在下半截（炉口）。 */
const FURNACE_EMITTER: Emitter = {
  emissions: FURNACE_EMISSIONS,
  point: (random) => {
    const [nx, , nz] = FRONT_NORMALS[Math.floor(random() * FRONT_NORMALS.length)]!;
    const across = 0.2 + random() * 0.6;
    // 法线朝 −X 时面在 x 那一侧，沿 z 横向取；朝 −Z 时反过来
    const offset = (n: number) => (n < 0 ? -FURNACE_FRONT_GAP : n > 0 ? 1 + FURNACE_FRONT_GAP : across);
    return { x: offset(nx), y: 0.1 + random() * 0.3, z: offset(nz) };
  },
};

/**
 * 按方块编号排的冒粒子规则；不冒粒子的编号是 undefined。火把冒在细杆顶端之上一点（`TORCH_EMIT_LIFT`），
 * 每个朝向的顶端不同。
 */
const EMITTERS: (Emitter | undefined)[] = [];
for (const block of Object.values(BlockType)) {
  const tip = torchTip(block);
  if (tip) {
    const point = Object.freeze({ x: tip.x, y: tip.y + TORCH_EMIT_LIFT, z: tip.z });
    EMITTERS[block] = { emissions: TORCH_EMISSIONS, point: () => point };
  }
}
EMITTERS[BlockType.LitFurnace] = FURNACE_EMITTER;

/**
 * 碎屑的数值，按画面定（Windows 浏览器实机看）。原版挖掘中每 tick 从被瞄准的那一面溅一个，碎掉时按 4×4×4
 * 的格点爆 64 个，向外飞散、受重力；这里照着它。
 */
const DEBRIS = {
  /** 挖掘中平均每秒溅几个。 */
  splashRate: 10,
  /** 溅出的碎屑离那一面多远（格）：大于碎屑边长的一半，生成时底边不在方块里。 */
  splashGap: 0.08,
  /** 溅出的碎屑：存活时间（秒）、边长（格）、往外与往上的速度（格/秒）、横向漂移（格/秒，两个分量各在 ±它之间）。 */
  splashLife: [0.3, 0.9],
  splashSize: [0.06, 0.12],
  splashOut: [0.3, 1.2],
  splashRise: [0.5, 1.8],
  splashDrift: 0.8,
  /** 碎掉时每格每个轴几个格点（4 是 64 个）；火把这类小外形按外包盒的大小少一些，每个轴至少 2 个。 */
  burstPerBlock: 4,
  /** 爆出的碎屑：存活时间（秒）、边长（格）。 */
  burstLife: [0.4, 1.4],
  burstSize: [0.1, 0.18],
  /** 爆出的碎屑的初速：离中心的偏移乘它（格/秒每格），再加 ±`burstJitter` 的随机与往上的 `burstLift`。 */
  burstSpread: 3,
  burstJitter: 0.8,
  burstLift: [0.6, 1.8],
} as const;

/** 碎屑是一格贴图里多大的一小块：边长 1/4 格（16 像素里的 4 个），竖条再窄就取竖条那么宽。 */
const DEBRIS_UV_FRACTION = 1 / 4;

/** 整格贴图（一格里的归一化 uv）。 */
const WHOLE_TILE: UvRect = Object.freeze({ u0: 0, v0: 0, u1: 1, v1: 1 });

/**
 * 碎屑贴图：这种方块 `face` 那一面贴图里随机一小块，在图集里的 uv 矩形。火把只在画着细杆的那一竖条里取
 * （`TORCH_STICK_UV`），竖条之外是透明的。没有贴图的方块（空气）返回 undefined。
 */
function debrisUv(block: BlockType, face: FaceSpec['face'], random: () => number): UvRect | undefined {
  const tiles = BLOCK_TILES[block];
  if (!tiles) return undefined;
  const cell = tileUvRect(faceTile(tiles, face));
  const region = isTorch(block) ? TORCH_STICK_UV : WHOLE_TILE;
  const side = Math.min(DEBRIS_UV_FRACTION, region.u1 - region.u0, region.v1 - region.v0);
  const u = region.u0 + random() * (region.u1 - region.u0 - side);
  const v = region.v0 + random() * (region.v1 - region.v0 - side);
  const width = cell.u1 - cell.u0;
  const height = cell.v1 - cell.v0;
  return {
    u0: cell.u0 + u * width,
    v0: cell.v0 + v * height,
    u1: cell.u0 + (u + side) * width,
    v1: cell.v0 + (v + side) * height,
  };
}

/** 在 [low, high) 里均匀取一个数。 */
function between([low, high]: readonly [number, number], random: () => number): number {
  return low + (high - low) * random();
}

/** 在 ±`half` 之间均匀取一个数。 */
function spread(half: number, random: () => number): number {
  return (random() * 2 - 1) * half;
}

/**
 * 粒子系统：一个池子，加上「玩家附近的发光方块按概率冒粒子」这条规则。渲染层每帧调一次 `update`。
 */
export class ParticleSystem {
  readonly pool: ParticlePool;
  /**
   * 生不生成新粒子：设置里的粒子开关（ADR-0020），渲染层每帧照它写。关掉时火把不冒、挖掘不溅、碎掉不爆，
   * 池子里已有的照常推进、到期消失。
   */
  emitting = true;
  private readonly random: () => number;

  constructor(capacity = PARTICLE_LIMIT, random: () => number = Math.random) {
    this.pool = new ParticlePool(capacity);
    this.random = random;
  }

  /**
   * 推进一帧：`seconds` 是距上一帧的真实时间。先让 `sources` 里离 `eye` 不超过 `EMIT_RANGE` 格的发光方块冒粒子，
   * 再按 `mining` 溅碎屑，然后推进整个池子（新冒出来的那几个也在这一步读到所在格的光照），最后按离
   * `eye` 由远到近重排。
   *
   * 每种粒子这一帧冒几个取 ⌊频率 × 间隔 + 随机数⌋：平均正好是频率 × 间隔，帧率高低不改变冒的快慢。
   */
  update(
    seconds: number,
    eye: Vec3,
    sources: Iterable<GlowingBlock>,
    world: ParticleWorldView,
    mining: DiggingView,
  ): void {
    const dt = Math.min(Math.max(seconds, 0), MAX_STEP_SECONDS);
    if (this.emitting) {
      this.emitFromGlowing(dt, eye, sources);
      this.splash(dt, mining, world);
    }
    this.pool.step(dt, world);
    this.pool.sortBackToFront(eye);
  }

  /** 离 `eye` 不超过 `EMIT_RANGE` 格的火把与燃烧中的熔炉按概率冒火焰光点与烟。 */
  private emitFromGlowing(dt: number, eye: Vec3, sources: Iterable<GlowingBlock>): void {
    const random = this.random;
    for (const source of sources) {
      const emitter = EMITTERS[source.block];
      if (!emitter) continue;
      const dx = source.x + 0.5 - eye.x;
      const dy = source.y + 0.5 - eye.y;
      const dz = source.z + 0.5 - eye.z;
      if (dx * dx + dy * dy + dz * dz > EMIT_RANGE * EMIT_RANGE) continue;
      for (const emission of emitter.emissions) {
        const n = Math.floor(emission.rate * dt + random());
        for (let k = 0; k < n; k++) {
          const at = emitter.point(random);
          this.pool.spawn({
            kind: emission.kind,
            x: source.x + at.x,
            y: source.y + at.y,
            z: source.z + at.z,
            vx: spread(emission.drift, random),
            vy: between(emission.rise, random),
            vz: spread(emission.drift, random),
            life: between(emission.life, random),
            size: between(emission.size, random),
            uv: emission.uv,
          });
        }
      }
    }
  }

  /**
   * 挖掘中（`digging` 为真且进度大于 0）按概率从目标方块被瞄准的那一面溅碎屑：落在那一面上随机一点、
   * 往外一点，往外飞，贴图取那一面的贴图。顶面与侧面溅出的再往上抛一点，底面溅出的只往下落。
   */
  private splash(dt: number, mining: DiggingView, world: ParticleWorldView): void {
    const { target } = mining;
    if (!mining.digging || !(mining.progress > 0) || !target) return;
    const random = this.random;
    const n = Math.floor(DEBRIS.splashRate * dt + random());
    if (n === 0) return;
    const { normal } = target;
    const face = CUBE_FACES.find(({ normal: [x, y, z] }) => x === normal.x && y === normal.y && z === normal.z);
    if (!face) return;
    const block = world.getBlock(target.x, target.y, target.z);
    for (let k = 0; k < n; k++) {
      const uv = debrisUv(block, face.face, random);
      if (!uv) return;
      // 面上一点在一个轴上的坐标（相对方块的最小角）：法线那个轴落在面所在的那一侧再往外 `splashGap`，
      // 另两个轴在格里随机
      const onFace = (axis: number) =>
        axis > 0 ? 1 + DEBRIS.splashGap : axis < 0 ? -DEBRIS.splashGap : random();
      const out = between(DEBRIS.splashOut, random);
      const lift = normal.y < 0 ? 0 : between(DEBRIS.splashRise, random);
      this.pool.spawn({
        kind: ParticleKind.Debris,
        x: target.x + onFace(normal.x),
        y: target.y + onFace(normal.y),
        z: target.z + onFace(normal.z),
        vx: normal.x * out + (normal.x === 0 ? spread(DEBRIS.splashDrift, random) : 0),
        vy: normal.y * out + lift,
        vz: normal.z * out + (normal.z === 0 ? spread(DEBRIS.splashDrift, random) : 0),
        life: between(DEBRIS.splashLife, random),
        size: between(DEBRIS.splashSize, random),
        uv,
      });
    }
  }

  /**
   * 碎掉的那一格爆一团碎屑：在方块外形里按格点排开，每个点一个，从中心往外飞、往上抛。外形与选框是同一个
   * （`selectionBounds`），火把只在细杆的外包盒里爆、个数少一些。贴图每个各取一个随机的面。池子满了剩下的就不生成。
   *
   * 渲染层每推进一个 tick 读一次核心报的碎掉的方块（`MiningView.broken`），有就调它。不放进每帧的 `update`：
   * 游戏循环一帧可能补几个 tick，碎掉的方块只在一 tick 里有值，等到画这一帧时可能已经清空了。
   */
  burst({ x, y, z, block }: BrokenBlock): void {
    if (!this.emitting) return;
    const random = this.random;
    const { min, max } = selectionBounds(block, x, y, z);
    const sizeX = max.x - min.x;
    const sizeY = max.y - min.y;
    const sizeZ = max.z - min.z;
    const points = (size: number) => Math.max(2, Math.ceil(size * DEBRIS.burstPerBlock));
    const nx = points(sizeX);
    const ny = points(sizeY);
    const nz = points(sizeZ);
    const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++) {
          const face = CUBE_FACES[Math.floor(random() * CUBE_FACES.length)]!;
          const uv = debrisUv(block, face.face, random);
          if (!uv) return;
          const px = min.x + ((i + 0.5) / nx) * sizeX;
          const py = min.y + ((j + 0.5) / ny) * sizeY;
          const pz = min.z + ((k + 0.5) / nz) * sizeZ;
          const spawned = this.pool.spawn({
            kind: ParticleKind.Debris,
            x: px,
            y: py,
            z: pz,
            vx: (px - center.x) * DEBRIS.burstSpread + spread(DEBRIS.burstJitter, random),
            vy: (py - center.y) * DEBRIS.burstSpread + between(DEBRIS.burstLift, random),
            vz: (pz - center.z) * DEBRIS.burstSpread + spread(DEBRIS.burstJitter, random),
            life: between(DEBRIS.burstLife, random),
            size: between(DEBRIS.burstSize, random),
            uv,
          });
          if (!spawned) return;
        }
      }
    }
  }
}
