import { BlockType } from '../core/block';
import { MAX_LIGHT_LEVEL } from '../core/constants';
import type { Vec3 } from '../core/vec3';
import { TILE, tileUvRect } from './atlas';
import { CUBE_FACES } from './cube-faces';
import type { GlowingBlock } from './mesh';
import { SELF_LIT_BLOCK_LIGHT } from './shading';
import { torchTip } from './torch-model';

/**
 * 粒子（见 CONTEXT.md 的「粒子」，#59）：只画在画面上的小片，不碰实体、不进任何规则。
 *
 * 这个文件是粒子池与发射规则，纯数学、不 import three，因此能在 Node 里测。池子里的几条数组按显卡
 * 实例属性的排布存（`positions`、`sizes`、`uvRects`、`lights`、`alphas`），存活的粒子总排在前
 * `count` 个：渲染层直接把这几条数组交给实例化几何体，不必每帧再复制一遍。
 *
 * 随机数走渲染层自己的（默认 `Math.random`），不要求可复现：粒子不在核心，不受 ADR-0014 约束。
 */

/** 粒子的种类。值是字符串：读回视图按它报数量（`ParticleCounts`），不进存档。 */
export const ParticleKind = {
  Flame: 'flame',
  Smoke: 'smoke',
} as const;

export type ParticleKind = (typeof ParticleKind)[keyof typeof ParticleKind];

/**
 * 粒子总数的上限：所有种类共用。满了不再生成，已有的照常消失。
 *
 * 一个火把同时存活的粒子平均不到 3 个（`TORCH_EMISSIONS` 的频率乘存活时间），16 格内插满火把也到不了这么多；
 * 这个数是为挖掘碎屑（#60）与最坏情况设的上限。Windows 无头 Edge 实测池子装满时帧率不变（#59）。
 */
export const PARTICLE_LIMIT = 2000;

/** 只有玩家眼睛这么多格内（到方块中心的直线距离）的发光方块冒粒子。 */
export const EMIT_RANGE = 16;

/**
 * 一帧最多推进多少秒。标签页切回前台时两帧之间可能隔了几十秒：按实际间隔算，所有粒子同时到期，
 * 发射又按这段间隔一次生成大量粒子。
 */
const MAX_STEP_SECONDS = 0.1;

/** 每种粒子的样子：贴图格、自不自发光、会不会变淡，大小在存活期间从 1 倍变到 `endScale` 倍。 */
interface KindLook {
  readonly tile: number;
  /** 自发光的粒子不读所在格的光照，按贴图本色画（与火把本身同一个标记，见 `SELF_LIT_BLOCK_LIGHT`）。 */
  readonly selfLit: boolean;
  /** 刚生成时的不透明度；会变淡的粒子到期时降到 0，不变淡的一直是它。 */
  readonly opacity: number;
  readonly fades: boolean;
  readonly endScale: number;
}

const LOOKS: Readonly<Record<ParticleKind, KindLook>> = {
  // 火焰光点越来越小，不变淡，到期消失
  [ParticleKind.Flame]: { tile: TILE.flame, selfLit: true, opacity: 1, fades: false, endScale: 0.5 },
  // 烟越飘越大、越来越淡
  [ParticleKind.Smoke]: { tile: TILE.smoke, selfLit: false, opacity: 0.85, fades: true, endScale: 2 },
};

/** 生成一个粒子要给的东西：位置与速度（格、格/秒）、存活时间（秒）、刚生成时的边长（格）。 */
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
}

/** 按格读两个光照等级：烟按所在格的亮度画。核心的 `skyLightAt`/`blockLightAt` 就是这两个。 */
export interface ParticleLightView {
  skyLightAt(x: number, y: number, z: number): number;
  blockLightAt(x: number, y: number, z: number): number;
}

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
    const rect = tileUvRect(look.tile);
    this.uvRects.set([rect.u0, rect.v0, rect.u1, rect.v1], i * 4);
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
   */
  step(seconds: number, light: ParticleLightView): void {
    let i = 0;
    while (i < this.alive) {
      const age = this.ages[i]! + seconds;
      if (age >= this.lives[i]!) {
        this.remove(i);
        continue;
      }
      this.ages[i] = age;
      const p = i * 3;
      const x = (this.positions[p] = this.positions[p]! + this.velocities[p]! * seconds);
      const y = (this.positions[p + 1] = this.positions[p + 1]! + this.velocities[p + 1]! * seconds);
      const z = (this.positions[p + 2] = this.positions[p + 2]! + this.velocities[p + 2]! * seconds);

      const look = LOOKS[this.kinds[i]!];
      const progress = age / this.lives[i]!;
      this.sizes[i] = this.startSizes[i]! * (1 + (look.endScale - 1) * progress);
      if (look.fades) this.alphas[i] = look.opacity * (1 - progress);
      if (!look.selfLit) {
        this.lights[i * 2] = light.skyLightAt(x, y, z);
        this.lights[i * 2 + 1] = light.blockLightAt(x, y, z);
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
  life: [0.4, 0.7],
  size: [0.09, 0.13],
  rise: [0.02, 0.06],
  drift: 0.01,
};

const SMOKE: Omit<Emission, 'rate'> = {
  kind: ParticleKind.Smoke,
  life: [1.2, 2.2],
  size: [0.1, 0.14],
  rise: [0.35, 0.55],
  drift: 0.02,
};

/** 火把一直在烧，冒得勤；燃烧中的熔炉「偶尔」冒（见 CONTEXT.md 的「粒子」）。 */
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

/** 在 [low, high) 里均匀取一个数。 */
function between([low, high]: readonly [number, number], random: () => number): number {
  return low + (high - low) * random();
}

/**
 * 粒子系统：一个池子，加上「玩家附近的发光方块按概率冒粒子」这条规则。渲染层每帧调一次 `update`。
 */
export class ParticleSystem {
  readonly pool: ParticlePool;
  private readonly random: () => number;

  constructor(capacity = PARTICLE_LIMIT, random: () => number = Math.random) {
    this.pool = new ParticlePool(capacity);
    this.random = random;
  }

  /**
   * 推进一帧：`seconds` 是距上一帧的真实时间。先让 `sources` 里离 `eye` 不超过 `EMIT_RANGE` 格的发光方块冒粒子，
   * 再推进整个池子（新冒出来的那几个也在这一步读到所在格的光照），最后按离 `eye` 由远到近重排。
   *
   * 每种粒子这一帧冒几个取 ⌊频率 × 间隔 + 随机数⌋：平均正好是频率 × 间隔，帧率高低不改变冒的快慢。
   */
  update(seconds: number, eye: Vec3, sources: Iterable<GlowingBlock>, light: ParticleLightView): void {
    const dt = Math.min(Math.max(seconds, 0), MAX_STEP_SECONDS);
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
            vx: (random() * 2 - 1) * emission.drift,
            vy: between(emission.rise, random),
            vz: (random() * 2 - 1) * emission.drift,
            life: between(emission.life, random),
            size: between(emission.size, random),
          });
        }
      }
    }
    this.pool.step(dt, light);
    this.pool.sortBackToFront(eye);
  }
}
