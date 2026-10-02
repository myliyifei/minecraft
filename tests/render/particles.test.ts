import { describe, expect, it } from 'vitest';
import { BlockType, isSolid } from '../../src/core/block';
import type { BrokenBlock } from '../../src/core/mining';
import { MAX_LIGHT_LEVEL } from '../../src/core/constants';
import type { Vec3 } from '../../src/core/vec3';
import type { GlowingBlock } from '../../src/render/mesh';
import {
  EMIT_RANGE,
  PARTICLE_LIMIT,
  ParticleKind,
  ParticlePool,
  ParticleSystem,
  TORCH_EMIT_LIFT,
  type DiggingView,
  type ParticleSpawn,
  type ParticleWorldView,
} from '../../src/render/particles';
import { TILE, tileUvRect, type UvRect } from '../../src/render/atlas';
import { TORCH_STICK_UV } from '../../src/render/torch-model';
import { SELF_LIT_BLOCK_LIGHT } from '../../src/render/shading';
import { torchTip } from '../../src/render/torch-model';

/** 60 帧/秒的一帧（秒）。 */
const FRAME = 1 / 60;

/** 处处是空气、天光 15、方块光 0：露天的白天。 */
const OPEN_AIR: ParticleWorldView = {
  skyLightAt: () => MAX_LIGHT_LEVEL,
  blockLightAt: () => 0,
  getBlock: () => BlockType.Air,
};

/** 没在挖掘。 */
const NOT_DIGGING: DiggingView = { target: undefined, digging: false, progress: 0 };

/** 固定种子的伪随机数（mulberry32）：发射按概率走，测试要每次相同。 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnOf(kind: ParticleKind, life = 1): ParticleSpawn {
  return { kind, x: 0.5, y: 0.5, z: 0.5, vx: 0, vy: 0, vz: 0, life, size: 0.1, uv: tileUvRect(TILE.smoke) };
}

/** 推进 `frames` 帧，每帧之后记一次各种类的数量。 */
function run(system: ParticleSystem, frames: number, eye: Vec3, sources: readonly GlowingBlock[]) {
  const seen = { flame: 0, smoke: 0 };
  for (let i = 0; i < frames; i++) {
    system.update(FRAME, eye, sources, OPEN_AIR, NOT_DIGGING);
    const counts = system.pool.counts();
    seen.flame = Math.max(seen.flame, counts.flame);
    seen.smoke = Math.max(seen.smoke, counts.smoke);
  }
  return seen;
}

describe('粒子池', () => {
  it('满了之后再生成被拒绝，总数不超过上限', () => {
    const pool = new ParticlePool(3);
    for (let i = 0; i < 3; i++) expect(pool.spawn(spawnOf(ParticleKind.Smoke))).toBe(true);
    expect(pool.spawn(spawnOf(ParticleKind.Flame))).toBe(false);
    expect(pool.count).toBe(3);
    expect(pool.counts()).toEqual({ flame: 0, smoke: 3, debris: 0, total: 3 });
  });

  it('到期的粒子回收，回收之后又能生成；没到期的照常留着', () => {
    const pool = new ParticlePool(2);
    pool.spawn(spawnOf(ParticleKind.Flame, 0.2));
    pool.spawn(spawnOf(ParticleKind.Smoke, 1));
    expect(pool.spawn(spawnOf(ParticleKind.Smoke))).toBe(false);

    for (let t = 0; t < 0.3; t += FRAME) pool.step(FRAME, OPEN_AIR);
    expect(pool.counts()).toEqual({ flame: 0, smoke: 1, debris: 0, total: 1 });
    expect(pool.spawn(spawnOf(ParticleKind.Flame))).toBe(true);
    expect(pool.counts()).toEqual({ flame: 1, smoke: 1, debris: 0, total: 2 });
  });

  it('默认上限是 PARTICLE_LIMIT', () => {
    expect(new ParticlePool().capacity).toBe(PARTICLE_LIMIT);
  });

  it('按离眼睛由远到近重排：后画的是近处的，每个粒子的数据跟着一起移动', () => {
    const pool = new ParticlePool(3);
    // 离原点 1、5、3 格；存活时间各不相同，用来认出重排之后谁是谁
    pool.spawn({ ...spawnOf(ParticleKind.Smoke, 2), x: 1, y: 0, z: 0 });
    pool.spawn({ ...spawnOf(ParticleKind.Flame, 0.3), x: 5, y: 0, z: 0 });
    pool.spawn({ ...spawnOf(ParticleKind.Smoke, 4), x: 3, y: 0, z: 0 });
    pool.sortBackToFront({ x: 0, y: 0, z: 0 });
    const xs = () => Array.from({ length: pool.count }, (_, i) => pool.positions[i * 3]);
    expect(xs()).toEqual([5, 3, 1]);
    expect(pool.kinds.slice(0, 3)).toEqual([ParticleKind.Flame, ParticleKind.Smoke, ParticleKind.Smoke]);

    // 5 格外那个火焰光点存活 0.3 秒，到期之后剩下的两个仍各是原来的位置
    pool.step(0.35, OPEN_AIR);
    expect(pool.counts()).toEqual({ flame: 0, smoke: 2, debris: 0, total: 2 });
    expect(xs().sort()).toEqual([1, 3]);
    pool.step(2, OPEN_AIR);
    expect(xs()).toEqual([3]);
  });

  it('按速度推进位置', () => {
    const pool = new ParticlePool(1);
    pool.spawn({ ...spawnOf(ParticleKind.Smoke, 5), vx: 1, vy: 2, vz: -1 });
    pool.step(0.5, OPEN_AIR);
    expect([...pool.positions.subarray(0, 3)]).toEqual([1, 1.5, 0]);
  });

  it('烟越往后越淡；火焰光点自发光，不变淡', () => {
    const pool = new ParticlePool(2);
    pool.spawn(spawnOf(ParticleKind.Smoke, 1));
    pool.spawn(spawnOf(ParticleKind.Flame, 1));
    const alphas: number[][] = [];
    for (let i = 0; i < 3; i++) {
      pool.step(0.25, OPEN_AIR);
      alphas.push([...pool.alphas.subarray(0, 2)]);
    }
    const smoke = alphas.map(([a]) => a!);
    expect(smoke[0]).toBeGreaterThan(smoke[1]!);
    expect(smoke[1]).toBeGreaterThan(smoke[2]!);
    expect(smoke[2]).toBeGreaterThan(0);
    expect(alphas.map(([, a]) => a)).toEqual([1, 1, 1]);
  });

  it('烟按所在格的天光与方块光画；火焰光点带自发光的标记，不读光照', () => {
    const light: ParticleWorldView = {
      ...OPEN_AIR,
      skyLightAt: (_x, y) => (y >= 10 ? 15 : 3),
      blockLightAt: (x) => (x >= 0 ? 9 : 0),
    };
    const pool = new ParticlePool(2);
    pool.spawn({ ...spawnOf(ParticleKind.Smoke, 5), x: 0.5, y: 9.5, vy: 1 });
    pool.spawn({ ...spawnOf(ParticleKind.Flame, 5), x: -0.5, y: 9.5 });
    pool.step(0.1, light);
    expect([...pool.lights.subarray(0, 4)]).toEqual([3, 9, MAX_LIGHT_LEVEL, SELF_LIT_BLOCK_LIGHT]);
    // 烟升进上面那一格，那一格的天光是 15
    pool.step(0.5, light);
    expect([...pool.lights.subarray(0, 2)]).toEqual([15, 9]);
  });
});

describe('火把与燃烧中的熔炉冒粒子', () => {
  /** 眼睛在 (0.5, 70.5, 0.5)：距离按格中心量，沿 x 轴摆的方块离眼睛正好整数格。 */
  const eye = { x: 0.5, y: 70.5, z: 0.5 };
  const at = (block: BlockType, dx: number): GlowingBlock => ({ block, x: dx, y: 70, z: 0 });

  it('玩家 16 格内的火把若干帧后冒出火焰光点与烟，17 格外的一个都不冒', () => {
    expect(EMIT_RANGE).toBe(16);
    const near = run(new ParticleSystem(PARTICLE_LIMIT, seeded(1)), 600, eye, [at(BlockType.Torch, 16)]);
    expect(near.flame).toBeGreaterThan(0);
    expect(near.smoke).toBeGreaterThan(0);

    const far = new ParticleSystem(PARTICLE_LIMIT, seeded(1));
    run(far, 600, eye, [at(BlockType.Torch, 17), at(BlockType.WallTorchPosX, -17)]);
    expect(far.pool.count).toBe(0);
  });

  it('燃烧中的熔炉同样冒火焰光点与烟；熄火的熔炉与其他方块不冒', () => {
    const lit = run(new ParticleSystem(PARTICLE_LIMIT, seeded(2)), 600, eye, [at(BlockType.LitFurnace, 3)]);
    expect(lit.flame).toBeGreaterThan(0);
    expect(lit.smoke).toBeGreaterThan(0);

    const off = new ParticleSystem(PARTICLE_LIMIT, seeded(2));
    run(off, 600, eye, [at(BlockType.Furnace, 3), at(BlockType.Stone, 2)]);
    expect(off.pool.count).toBe(0);
  });

  it('火把的粒子从细杆顶端之上一点冒出：墙上火把的顶端离墙，不在竖直细杆的正上方', () => {
    for (const block of [BlockType.Torch, BlockType.WallTorchNegX, BlockType.WallTorchPosZ]) {
      const system = new ParticleSystem(PARTICLE_LIMIT, seeded(3));
      const source = { block, x: 4, y: 70, z: 0 };
      const tip = torchTip(block)!;
      for (let i = 0; i < 600 && system.pool.count === 0; i++) system.update(FRAME, eye, [source], OPEN_AIR, NOT_DIGGING);
      expect(system.pool.count).toBeGreaterThan(0);
      // 刚冒出来的那一个离冒出的位置不到一帧的位移
      const [x, y, z] = system.pool.positions.subarray(0, 3);
      expect(Math.hypot(x! - (4 + tip.x), y! - (70 + tip.y + TORCH_EMIT_LIFT), z! - tip.z)).toBeLessThan(0.02);
    }
    // 地面火把：竖直细杆的顶面中心
    expect(torchTip(BlockType.Torch)).toEqual({ x: 0.5, y: 10 / 16, z: 0.5 });
    // 墙上火把贴着 −X 那面墙：细杆截面中心在 x = 1/16，顶端往 +X 斜出去约 10/16·sin 22.5°，
    // 也因倾斜比竖直的杆顶（3/16 + 10/16）低
    const wall = torchTip(BlockType.WallTorchNegX)!;
    expect(wall.x).toBeCloseTo(1 / 16 + (10 / 16) * Math.sin(Math.PI / 8));
    expect(wall.y).toBeCloseTo(3 / 16 + (10 / 16) * Math.cos(Math.PI / 8));
    expect(wall.z).toBeCloseTo(0.5);
  });

  it('熔炉的粒子从正面（−X 或 −Z）前方冒出', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(4));
    const source = { block: BlockType.LitFurnace, x: 4, y: 70, z: 0 };
    for (let i = 0; i < 1200; i++) system.update(FRAME, eye, [source], OPEN_AIR, NOT_DIGGING);
    const { positions, count } = system.pool;
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]!;
      const z = positions[i * 3 + 2]!;
      // 在熔炉那一格之外、贴着 −X 或 −Z 那一面
      const inFrontOfNegX = x < 4 && x > 3.7 && z > 0 && z < 1;
      const inFrontOfNegZ = z < 0 && z > -0.3 && x > 4 && x < 5;
      expect(inFrontOfNegX || inFrontOfNegZ).toBe(true);
    }
  });

  it('烟往上升', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(5));
    const source = at(BlockType.Torch, 2);
    for (let i = 0; i < 600; i++) system.update(FRAME, eye, [source], OPEN_AIR, NOT_DIGGING);
    const { positions, count, kinds } = system.pool;
    let risen = 0;
    for (let i = 0; i < count; i++) {
      if (kinds[i] === ParticleKind.Smoke && positions[i * 3 + 1]! > 70 + 10 / 16 + TORCH_EMIT_LIFT + 0.1) risen++;
    }
    expect(risen).toBeGreaterThan(0);
  });

  it('插再多火把，总数也不超过上限', () => {
    const sources = Array.from({ length: 400 }, (_, i) => ({ block: BlockType.Torch, x: i % 20 - 10, y: 70, z: Math.floor(i / 20) - 10 }));
    const system = new ParticleSystem(50, seeded(6));
    let most = 0;
    for (let i = 0; i < 600; i++) {
      system.update(FRAME, eye, sources, OPEN_AIR, NOT_DIGGING);
      most = Math.max(most, system.pool.count);
    }
    expect(most).toBe(50);
  });

  it('两帧之间隔了很久（切回标签页），这一帧也只按 0.1 秒冒粒子', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(7));
    system.update(30, eye, [at(BlockType.Torch, 2)], OPEN_AIR, NOT_DIGGING);
    expect(system.pool.count).toBeLessThanOrEqual(2);
  });
});

/** y 低于 `floor` 的格都是石头，其余是空气；光照处处是 `light`。 */
function groundAt(floor: number, light = MAX_LIGHT_LEVEL): ParticleWorldView {
  return {
    skyLightAt: () => light,
    blockLightAt: () => 0,
    getBlock: (_x, y) => (y < floor ? BlockType.Stone : BlockType.Air),
  };
}

/** 第 i 个粒子的 uv 矩形。 */
function uvOf(pool: ParticlePool, i: number): UvRect {
  const [u0, v0, u1, v1] = pool.uvRects.subarray(i * 4, i * 4 + 4);
  return { u0: u0!, v0: v0!, u1: u1!, v1: v1! };
}

/** 一格贴图里的一小块落在 `tile` 那一格的 `region`（一格里的归一化 uv）之内，而且比整格小。 */
function expectInside(rect: UvRect, tile: number, region: UvRect = { u0: 0, v0: 0, u1: 1, v1: 1 }): void {
  const cell = tileUvRect(tile);
  const width = cell.u1 - cell.u0;
  const height = cell.v1 - cell.v0;
  const eps = 1e-6;
  expect(rect.u0).toBeGreaterThanOrEqual(cell.u0 + region.u0 * width - eps);
  expect(rect.u1).toBeLessThanOrEqual(cell.u0 + region.u1 * width + eps);
  expect(rect.v0).toBeGreaterThanOrEqual(cell.v0 + region.v0 * height - eps);
  expect(rect.v1).toBeLessThanOrEqual(cell.v0 + region.v1 * height + eps);
  expect(rect.u1 - rect.u0).toBeLessThan(width / 2);
  expect(rect.u1).toBeGreaterThan(rect.u0);
  expect(rect.v1).toBeGreaterThan(rect.v0);
}

function debrisOf(kind: BlockType, x: number, y: number, z: number): BrokenBlock {
  return { x, y, z, block: kind };
}

describe('碎屑的运动（#60）', () => {
  const debris = (at: Partial<ParticleSpawn>): ParticleSpawn => ({
    ...spawnOf(ParticleKind.Debris, 10),
    uv: tileUvRect(TILE.stone),
    ...at,
  });

  it('受重力下落，停在实心方块上方，不穿进去', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ x: 0.5, y: 12.5, z: 0.5, vx: 0.3, vy: 2 }));
    const world = groundAt(10);
    let highest = 12.5;
    for (let i = 0; i < 300; i++) {
      pool.step(FRAME, world);
      highest = Math.max(highest, pool.positions[1]!);
    }
    // 先往上抛起来，再落下来
    expect(highest).toBeGreaterThan(12.6);
    // 底边贴在地面上
    const y = pool.positions[1]!;
    const size = pool.sizes[0]!;
    expect(y - size / 2).toBeCloseTo(10, 6);
    // 停住之后不再滑动
    const x = pool.positions[0]!;
    for (let i = 0; i < 60; i++) pool.step(FRAME, world);
    expect(pool.positions[0]).toBe(x);
    expect(pool.positions[1]).toBe(y);
  });

  it('一帧 0.1 秒（低帧率）从高处落下：不穿过只有一层的平台，底边贴在它的顶面上', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ x: 0.5, y: 7.125, z: 0.5, vy: -0.5, size: 0.15 }));
    // 只有 y = 0 那一层是实心的
    const world: ParticleWorldView = { ...groundAt(0), getBlock: (_x, y) => (y === 0 ? BlockType.Stone : BlockType.Air) };
    for (let i = 0; i < 30; i++) pool.step(0.1, world);
    expect(pool.positions[1]! - pool.sizes[0]! / 2).toBeCloseTo(1, 6);
  });

  it('往上抛的碎屑碰到头顶的方块就停住，不钻进去', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ x: 0.5, y: 9.5, z: 0.5, vy: 6 }));
    // y = 10 那一层是天花板
    const world: ParticleWorldView = { ...groundAt(0), getBlock: (_x, y) => (y === 10 ? BlockType.Stone : BlockType.Air) };
    for (let i = 0; i < 30; i++) {
      pool.step(FRAME, world);
      expect(pool.positions[1]! + pool.sizes[0]! / 2).toBeLessThan(10);
    }
  });

  it('横着飞向一堵墙：停在墙前，之后沿墙落到地上', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ x: 0.5, y: 11.5, z: 0.5, vx: 6 }));
    // x ≥ 2 是一堵墙，y < 10 是地面
    const world: ParticleWorldView = {
      ...groundAt(10),
      getBlock: (x, y) => (x >= 2 || y < 10 ? BlockType.Stone : BlockType.Air),
    };
    for (let i = 0; i < 300; i++) {
      pool.step(FRAME, world);
      expect(isSolid(world.getBlock(Math.floor(pool.positions[0]!), Math.floor(pool.positions[1]!), 0))).toBe(false);
    }
    expect(pool.positions[0]).toBeLessThan(2);
    expect(pool.positions[0]).toBeGreaterThan(1.5);
    expect(pool.positions[1]).toBeLessThan(10.2);
  });

  it('存活时间到了消失', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ life: 0.5 }));
    for (let t = 0; t < 0.6; t += FRAME) pool.step(FRAME, groundAt(0));
    expect(pool.count).toBe(0);
  });

  it('按所在格亮度画：洞里的碎屑是暗的', () => {
    const pool = new ParticlePool(1);
    pool.spawn(debris({ x: 0.5, y: 20.5, z: 0.5 }));
    pool.step(FRAME, groundAt(10, 0));
    expect([...pool.lights.subarray(0, 2)]).toEqual([0, 0]);
  });
});

describe('挖掘溅出碎屑、碎掉爆一团（#60）', () => {
  const eye = { x: 0.5, y: 72.5, z: 0.5 };
  /** 脚下那块草方块，对着它的顶面挖。 */
  const grass = { x: 0, y: 70, z: 0 };
  const world: ParticleWorldView = {
    ...OPEN_AIR,
    getBlock: (x, y, z) => (x === grass.x && y === grass.y && z === grass.z ? BlockType.Grass : BlockType.Air),
  };
  const digging = (progress: number): DiggingView => ({
    target: { ...grass, normal: { x: 0, y: 1, z: 0 }, distance: 1.5 },
    digging: true,
    progress,
  });

  it('挖掘中从被瞄准的那一面溅出，贴图是那一面贴图里的一小块', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(11));
    for (let i = 0; i < 30; i++) system.update(FRAME, eye, [], world, digging(0.5));
    const { pool } = system;
    expect(pool.counts().debris).toBeGreaterThan(0);
    for (let i = 0; i < pool.count; i++) {
      // 在草方块顶面之上，没有掉进方块里
      expect(pool.positions[i * 3 + 1]).toBeGreaterThan(71);
      expectInside(uvOf(pool, i), TILE.grassTop);
    }
  });

  it('挖方块的底面：碎屑往下溅，不钻进被挖的方块', () => {
    const stoneAbove: ParticleWorldView = {
      ...OPEN_AIR,
      getBlock: (x, y, z) => (x === 0 && y === 75 && z === 0 ? BlockType.Stone : BlockType.Air),
    };
    const mining: DiggingView = {
      target: { x: 0, y: 75, z: 0, normal: { x: 0, y: -1, z: 0 }, distance: 1.5 },
      digging: true,
      progress: 0.5,
    };
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(16));
    let highest = -Infinity;
    for (let i = 0; i < 60; i++) {
      system.update(FRAME, eye, [], stoneAbove, mining);
      for (let k = 0; k < system.pool.count; k++) {
        highest = Math.max(highest, system.pool.positions[k * 3 + 1]! + system.pool.sizes[k]! / 2);
      }
    }
    expect(system.pool.counts().debris).toBeGreaterThan(0);
    expect(highest).toBeLessThan(75);
  });

  it('进度为 0、或没在挖掘时不溅', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(12));
    for (let i = 0; i < 120; i++) system.update(FRAME, eye, [], world, digging(0));
    for (let i = 0; i < 120; i++) system.update(FRAME, eye, [], world, { ...digging(0.5), digging: false });
    expect(system.pool.count).toBe(0);
  });

  it('碎掉的方块那一格爆出一团，贴图取自那种方块', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(13));
    system.burst(debrisOf(BlockType.Stone, 3, 70, 3));
    system.update(FRAME, eye, [], groundAt(70), NOT_DIGGING);
    const burst = system.pool.counts().debris;
    expect(burst).toBeGreaterThanOrEqual(32);
    for (let i = 0; i < system.pool.count; i++) {
      const [x, y, z] = system.pool.positions.subarray(i * 3, i * 3 + 3);
      expect(Math.floor(x!)).toBe(3);
      expect(Math.floor(y!)).toBe(70);
      expect(Math.floor(z!)).toBe(3);
      expectInside(uvOf(system.pool, i), TILE.stone);
    }
  });

  it('碎掉的是火把：碎屑取细杆那一竖条里的小块，比整格方块少', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(14));
    system.burst(debrisOf(BlockType.Torch, 3, 70, 3));
    const { pool } = system;
    expect(pool.count).toBeGreaterThan(0);
    expect(pool.count).toBeLessThan(32);
    for (let i = 0; i < pool.count; i++) expectInside(uvOf(pool, i), TILE.torch, TORCH_STICK_UV);
  });

  it('池子快满时爆一团只补到上限', () => {
    const system = new ParticleSystem(10, seeded(15));
    system.burst(debrisOf(BlockType.Stone, 3, 70, 3));
    expect(system.pool.count).toBe(10);
  });
});
