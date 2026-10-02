import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
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
  type ParticleLightView,
  type ParticleSpawn,
} from '../../src/render/particles';
import { SELF_LIT_BLOCK_LIGHT } from '../../src/render/shading';
import { torchTip } from '../../src/render/torch-model';

/** 60 帧/秒的一帧（秒）。 */
const FRAME = 1 / 60;

/** 处处天光 15、方块光 0 的光照视图：露天的白天。 */
const OPEN_AIR: ParticleLightView = { skyLightAt: () => MAX_LIGHT_LEVEL, blockLightAt: () => 0 };

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
  return { kind, x: 0.5, y: 0.5, z: 0.5, vx: 0, vy: 0, vz: 0, life, size: 0.1 };
}

/** 推进 `frames` 帧，每帧之后记一次各种类的数量。 */
function run(system: ParticleSystem, frames: number, eye: Vec3, sources: readonly GlowingBlock[]) {
  const seen = { flame: 0, smoke: 0 };
  for (let i = 0; i < frames; i++) {
    system.update(FRAME, eye, sources, OPEN_AIR);
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
    expect(pool.counts()).toEqual({ flame: 0, smoke: 3, total: 3 });
  });

  it('到期的粒子回收，回收之后又能生成；没到期的照常留着', () => {
    const pool = new ParticlePool(2);
    pool.spawn(spawnOf(ParticleKind.Flame, 0.2));
    pool.spawn(spawnOf(ParticleKind.Smoke, 1));
    expect(pool.spawn(spawnOf(ParticleKind.Smoke))).toBe(false);

    for (let t = 0; t < 0.3; t += FRAME) pool.step(FRAME, OPEN_AIR);
    expect(pool.counts()).toEqual({ flame: 0, smoke: 1, total: 1 });
    expect(pool.spawn(spawnOf(ParticleKind.Flame))).toBe(true);
    expect(pool.counts()).toEqual({ flame: 1, smoke: 1, total: 2 });
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
    expect(pool.counts()).toEqual({ flame: 0, smoke: 2, total: 2 });
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
    const light: ParticleLightView = {
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
      for (let i = 0; i < 600 && system.pool.count === 0; i++) system.update(FRAME, eye, [source], OPEN_AIR);
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
    for (let i = 0; i < 1200; i++) system.update(FRAME, eye, [source], OPEN_AIR);
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
    for (let i = 0; i < 600; i++) system.update(FRAME, eye, [source], OPEN_AIR);
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
      system.update(FRAME, eye, sources, OPEN_AIR);
      most = Math.max(most, system.pool.count);
    }
    expect(most).toBe(50);
  });

  it('两帧之间隔了很久（切回标签页），这一帧也只按 0.1 秒冒粒子', () => {
    const system = new ParticleSystem(PARTICLE_LIMIT, seeded(7));
    system.update(30, eye, [at(BlockType.Torch, 2)], OPEN_AIR);
    expect(system.pool.count).toBeLessThanOrEqual(2);
  });
});
