import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ZOMBIE_STEP, type ZombieView } from '../../src/core/zombie';
import { TILE, tileAtUv } from '../../src/render/atlas';
import {
  ZOMBIE_HURT_TINT_TICKS,
  ZOMBIE_LIMBS,
  ZOMBIE_SWING_TICKS,
  ZombiePart,
  createZombieModel,
  poseZombieModel,
  tintZombieModel,
  zombieGeometries,
  zombieHurtTinted,
  zombieTint,
} from '../../src/render/zombie-model';
import { entityMaterial, frameLighting } from '../../src/render/light-material';

/** 一只僵尸的视图：默认在原点站着不动。 */
function zombie(overrides: Partial<ZombieView> = {}): ZombieView {
  return {
    id: 1,
    position: { x: 0, y: 0, z: 0 },
    previousPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    age: 0,
    health: 20,
    lastHurtTick: undefined,
    burning: false,
    ...overrides,
  };
}

/** 这一 tick 朝 −Z 走了一步的僵尸。 */
function walking(age: number): ZombieView {
  return zombie({ age, previousPosition: { x: 0, y: 0, z: ZOMBIE_STEP } });
}

function model(): THREE.Group {
  return createZombieModel(zombieGeometries(), entityMaterial(new THREE.Texture(), frameLighting()));
}

function part(group: THREE.Group, name: ZombiePart): THREE.Object3D {
  const found = group.getObjectByName(name);
  if (!found) throw new Error(`模型里没有 ${name}`);
  return found;
}

/** 四肢此刻绕 x 轴摆了多少（弧度）。 */
function limbAngles(group: THREE.Group): number[] {
  return ZOMBIE_LIMBS.map((name) => part(group, name).rotation.x);
}

/** 四肢都没摆：角度都是 0。用 === 比，−0 也算 0（反着摆的那两条是 0 取负）。 */
function atRest(group: THREE.Group): boolean {
  return limbAngles(group).every((angle) => angle === 0);
}

describe('僵尸的六部件人形', () => {
  it('一个组，六个部件：头、身体、两条手臂、两条腿', () => {
    const group = model();
    expect(group.children).toHaveLength(6);
    expect(group.children.map((child) => child.name).sort()).toEqual(
      Object.values(ZombiePart).sort(),
    );
  });

  it('按像素量的尺寸拼起来：总高 2 格，两臂张开 1 格宽，头 0.5 格深', () => {
    const size = new THREE.Box3().setFromObject(model()).getSize(new THREE.Vector3());
    // 腿 12 + 身体 12 + 头 8 = 32 像素；臂 4 + 身 8 + 臂 4 = 16 像素；头 8 像素深
    expect(size.y).toBeCloseTo(2, 9);
    expect(size.x).toBeCloseTo(1, 9);
    expect(size.z).toBeCloseTo(0.5, 9);
  });

  it('组的原点在脚底中心：与核心报的位置是同一个点', () => {
    const box = new THREE.Box3().setFromObject(model());
    expect(box.min.y).toBeCloseTo(0, 9);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 9);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 9);
  });

  it('头只有 −Z 那一面是脸，其余五面是皮肤；偏航 0 时脸朝 −Z，与核心的前方一致', () => {
    const geometry = zombieGeometries()[ZombiePart.Head];
    const uv = geometry.getAttribute('uv');
    // BoxGeometry 的面序是 +X、−X、+Y、−Y、+Z、−Z，每面 4 个顶点。取每面左上与右下两个角的中点反查格号
    const tiles = Array.from({ length: 6 }, (_, face) => {
      const i = face * 4;
      return tileAtUv((uv.getX(i) + uv.getX(i + 3)) / 2, (uv.getY(i) + uv.getY(i + 3)) / 2);
    });
    expect(tiles).toEqual([
      TILE.zombieSkin,
      TILE.zombieSkin,
      TILE.zombieSkin,
      TILE.zombieSkin,
      TILE.zombieSkin,
      TILE.zombieFace,
    ]);
  });
});

describe('僵尸模型跟着核心摆', () => {
  it('位置在上一 tick 与这一 tick 之间插值，整体按偏航转', () => {
    const group = model();
    poseZombieModel(
      group,
      zombie({ position: { x: 4, y: 71, z: 2 }, previousPosition: { x: 3, y: 71, z: 2 }, yaw: 1.2 }),
      0.25,
    );
    expect(group.position.toArray()).toEqual([3.25, 71, 2]);
    expect(group.rotation.y).toBe(1.2);
  });

  it('站着不动时四肢不摆，角度都是 0', () => {
    const group = model();
    for (const age of [0, 3, 7.5, 13]) {
      poseZombieModel(group, zombie({ age }), 0.5);
      expect(atRest(group), `age ${age}`).toBe(true);
    }
  });

  it('走动时臂与腿的角度随 age 变化', () => {
    const group = model();
    const seen = new Set<number>();
    for (let age = 0; age < ZOMBIE_SWING_TICKS; age++) {
      poseZombieModel(group, walking(age), 0);
      seen.add(part(group, ZombiePart.RightArm).rotation.x);
    }
    expect(seen.size).toBeGreaterThan(ZOMBIE_SWING_TICKS / 2);
    expect(Math.max(...seen)).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeLessThan(0);
  });

  it('相位是 age + alpha：两 tick 之间连续，不按 20Hz 跳', () => {
    const group = model();
    const at = (age: number, alpha: number) => {
      poseZombieModel(group, walking(age), alpha);
      return part(group, ZombiePart.RightArm).rotation.x;
    };
    expect(at(2, 0.5)).toBeCloseTo(at(3, -0.5), 12);
    expect(at(2, 0.5)).not.toBeCloseTo(at(2, 0), 6);
  });

  it('一条手臂往前时同侧的腿往后，两条手臂、两条腿各自反着摆', () => {
    const group = model();
    poseZombieModel(group, walking(ZOMBIE_SWING_TICKS / 4), 0);
    const [rightArm, leftArm, rightLeg, leftLeg] = limbAngles(group);
    expect(rightArm).not.toBe(0);
    expect(leftArm).toBeCloseTo(-rightArm!, 12);
    expect(rightLeg).toBeCloseTo(-rightArm!, 12);
    expect(leftLeg).toBeCloseTo(rightArm!, 12);
  });

  it('停下来之后四肢回到 0', () => {
    const group = model();
    poseZombieModel(group, walking(5), 0);
    expect(atRest(group)).toBe(false);
    poseZombieModel(group, zombie({ age: 6 }), 0);
    expect(atRest(group)).toBe(true);
  });
});

describe('叠色：受击叠红（#42）、燃烧叠橙（#44），是材质上的一个 uniform', () => {
  /** 与渲染层同一种做法：每只僵尸一份光照材质，六个部件共用。 */
  function tintable(): THREE.Group {
    return createZombieModel(zombieGeometries(), entityMaterial(new THREE.Texture(), frameLighting()));
  }

  const channels = (hex: number) => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff] as const;

  it('受伤那一 tick 起 10 tick 内叠红，第 10 tick 起恢复；没受过伤不叠', () => {
    expect(ZOMBIE_HURT_TINT_TICKS).toBe(10);
    expect(zombieHurtTinted(undefined, 50)).toBe(false);
    for (let now = 100; now < 110; now++) {
      expect(zombieHurtTinted(100, now), `第 ${now} tick`).toBe(true);
    }
    expect(zombieHurtTinted(100, 110)).toBe(false);
    expect(zombieHurtTinted(100, 400)).toBe(false);
  });

  it('六个部件共用一份材质，叠色是它的 uniform；平时是白色，贴图本色', () => {
    const group = tintable();
    const materials = new Set(group.children.map((child) => (child as THREE.Mesh).material));
    expect(materials.size).toBe(1);
    const [material] = materials as Set<THREE.ShaderMaterial>;
    expect(material!.uniforms.tint).toBeDefined();
    tintZombieModel(group, zombie(), 100);
    expect(zombieTint(group)).toBe(0xffffff);
  });

  it('受击后 10 tick 内报告红色：红分量满、绿与蓝压低；之后回到白色', () => {
    const group = tintable();
    const hurt = zombie({ lastHurtTick: 200 });
    for (const now of [200, 209]) {
      tintZombieModel(group, hurt, now);
      const [r, g, b] = channels(zombieTint(group));
      expect(r, `第 ${now} tick`).toBe(0xff);
      expect(g).toBeLessThan(0xc0);
      expect(b).toBeLessThan(0xc0);
    }
    tintZombieModel(group, hurt, 210);
    expect(zombieTint(group)).toBe(0xffffff);
  });

  it('燃烧中报告橙红：红分量满，绿居中，蓝最低；不烧了回到白色', () => {
    const group = tintable();
    tintZombieModel(group, zombie({ burning: true }), 100);
    const [r, g, b] = channels(zombieTint(group));
    expect(r).toBe(0xff);
    expect(g).toBeLessThan(r);
    expect(g).toBeGreaterThan(b);
    tintZombieModel(group, zombie({ burning: false }), 101);
    expect(zombieTint(group)).toBe(0xffffff);
  });

  it('燃烧中又刚受伤：叠红，受伤那一下看得出来；10 tick 后回到叠橙', () => {
    const group = tintable();
    const hurtWhileBurning = zombie({ burning: true, lastHurtTick: 200 });
    tintZombieModel(group, zombie({ burning: true }), 199);
    const burning = zombieTint(group);
    tintZombieModel(group, hurtWhileBurning, 205);
    const hurt = zombieTint(group);
    expect(hurt).not.toBe(burning);
    expect(channels(hurt)[1]).toBeLessThan(channels(burning)[1]);
    tintZombieModel(group, hurtWhileBurning, 210);
    expect(zombieTint(group)).toBe(burning);
  });

  it('每只僵尸的叠色各管各的：一只受伤，另一只仍是白色', () => {
    const first = tintable();
    const second = tintable();
    tintZombieModel(first, zombie({ lastHurtTick: 100 }), 100);
    tintZombieModel(second, zombie(), 100);
    expect(zombieTint(first)).not.toBe(0xffffff);
    expect(zombieTint(second)).toBe(0xffffff);
  });
});
