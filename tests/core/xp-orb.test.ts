import { describe, expect, it } from 'vitest';
import type { ExperienceSink } from '../../src/core/experience';
import { boxCenter, hitboxAt, type Hitbox } from '../../src/core/physics';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/core/player';
import type { Vec3 } from '../../src/core/vec3';
import {
  XP_ORB_LIFETIME_TICKS,
  XP_ORB_MAX_SPEED,
  XP_ORB_SIZE,
  XpOrbs,
} from '../../src/core/xp-orb';

/** 经验球生成在哪一格：随便挑一格，坐标含负数好一并验负坐标。 */
const BLOCK = { x: -3, y: 70, z: 2 } as const;

/** 那一格的中心，也就是经验球的初始中心。 */
const ORB_CENTER: Vec3 = { x: BLOCK.x + 0.5, y: BLOCK.y + 0.5, z: BLOCK.z + 0.5 };

/**
 * 碰撞箱中心正好落在某个点上的玩家。
 * 经验球朝玩家碰撞箱的中心飞，所以测试里按中心摆玩家最省事。
 */
function playerCenteredAt({ x, y, z }: Vec3): Hitbox {
  return hitboxAt({ x, y: y - PLAYER_HEIGHT / 2, z }, PLAYER_WIDTH, PLAYER_HEIGHT);
}

/** 沿 +X 离经验球这么多格的玩家：距离就是这个数。 */
function playerXAway(distance: number): Hitbox {
  return playerCenteredAt({ ...ORB_CENTER, x: ORB_CENTER.x + distance });
}

/** 远到吸不着也吸引不动的玩家。 */
const FAR_AWAY = playerXAway(60);

/** 记下收到过哪些经验值。 */
function recorder(): ExperienceSink & { readonly gained: number[] } {
  const gained: number[] = [];
  return { gained, gain: (amount) => void gained.push(amount) };
}

/** 一个装了经验球的集合。 */
function orbsWith(amount = 3, block = BLOCK): XpOrbs {
  const orbs = new XpOrbs();
  orbs.spawnInBlock(amount, block.x, block.y, block.z);
  return orbs;
}

/** 推进 n 个 tick。 */
function advance(orbs: XpOrbs, player: Hitbox, ticks: number, into = recorder()): void {
  for (let i = 0; i < ticks; i++) orbs.step(player, into);
}

/** 经验球中心的世界坐标。存的位置是碰撞箱底面中心。 */
function centerOf(orbs: XpOrbs): Vec3 {
  const orb = orbs.all()[0];
  if (!orb) throw new Error('集合里应该有一个经验球');
  return { x: orb.position.x, y: orb.position.y + XP_ORB_SIZE / 2, z: orb.position.z };
}

/** 经验球中心到玩家碰撞箱中心的距离。 */
function distanceTo(orbs: XpOrbs, player: Hitbox): number {
  const orb = centerOf(orbs);
  const target = boxCenter(player);
  return Math.hypot(target.x - orb.x, target.y - orb.y, target.z - orb.z);
}

describe('经验球的生成', () => {
  it('在一格里生成的经验球落在那一格的中心', () => {
    const orbs = orbsWith(6);

    expect(orbs.count).toBe(1);
    const [orb] = orbs.all();
    expect(orb).toBeDefined();
    expect(orb!.amount).toBe(6);
    expect(orb!.age).toBe(0);
    // 碰撞箱的中心对准格心，底面因此比格底高半个箱高
    expect(orb!.position).toEqual({
      x: BLOCK.x + 0.5,
      y: BLOCK.y + 0.5 - XP_ORB_SIZE / 2,
      z: BLOCK.z + 0.5,
    });
  });

  it('每个经验球有自己的编号，渲染层据此认得出哪个是哪个', () => {
    const orbs = new XpOrbs();
    orbs.spawnInBlock(3, 0, 70, 0);
    orbs.spawnInBlock(3, 1, 70, 0);

    const ids = orbs.all().map((orb) => orb.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('新生成的经验球上一个 tick 的位置就是当前位置', () => {
    const orb = orbsWith().all()[0]!;
    expect(orb.previousPosition).toEqual(orb.position);
  });
});

describe('经验球朝玩家飞', () => {
  /**
   * 吸引范围 8 格来自 issue #9，所以写死字面值：
   * 从常量算出玩家位置的话，把范围改成 4 或 16 这两条也照样通过。
   */
  it('正好 8 格远时开始飞', () => {
    const orbs = orbsWith();
    const player = playerXAway(8);
    advance(orbs, player, 1);

    expect(distanceTo(orbs, player)).toBeLessThan(8);
  });

  it('超出 8 格一点点就停在原地', () => {
    const orbs = orbsWith();
    const before = centerOf(orbs);
    advance(orbs, playerXAway(8.01), 20);

    expect(centerOf(orbs)).toEqual(before);
  });

  it('远处的玩家吸引不动它', () => {
    const orbs = orbsWith();
    const before = centerOf(orbs);
    advance(orbs, FAR_AWAY, 100);

    expect(centerOf(orbs)).toEqual(before);
  });

  it('逐 tick 越飞越近，一次也不会冲过玩家', () => {
    const orbs = orbsWith();
    const player = playerXAway(6);

    let previous = distanceTo(orbs, player);
    for (let tick = 1; tick <= 12; tick++) {
      advance(orbs, player, 1);
      const now = distanceTo(orbs, player);
      expect(now, `第 ${tick} tick`).toBeLessThan(previous);
      previous = now;
    }
  });

  it('是加速飞行：前几 tick 每 tick 挪得比上一 tick 多', () => {
    const orbs = orbsWith();
    const player = playerXAway(8);

    let at = centerOf(orbs);
    let previousStep = 0;
    for (let tick = 1; tick <= 5; tick++) {
      advance(orbs, player, 1);
      const now = centerOf(orbs);
      const step = Math.abs(now.x - at.x);
      expect(step, `第 ${tick} tick`).toBeGreaterThan(previousStep);
      at = now;
      previousStep = step;
    }
  });

  it('速度有上限，不会越飞越快到穿过玩家', () => {
    const orbs = orbsWith();
    const player = playerXAway(8);
    const steps: number[] = [];
    // 一路飞到被吸收，把每 tick 的位移都记下来
    for (let tick = 0; tick < 200; tick++) {
      if (orbs.all().length === 0) break;
      const at = centerOf(orbs);
      orbs.step(player, recorder());
      if (orbs.all().length === 0) break;
      steps.push(Math.abs(centerOf(orbs).x - at.x));
    }

    // 速率本身是精确钳住的，位移是它乘一个单位向量算出来的，末位有几个 eps 的噪声
    expect(Math.max(...steps)).toBeLessThanOrEqual(XP_ORB_MAX_SPEED + 1e-12);
    // 上限真的顶到了，否则上面那条断言什么都没验
    expect(Math.max(...steps)).toBeCloseTo(XP_ORB_MAX_SPEED, 10);
  });

  it('一步不超过剩下的距离，因此不会冲过头在玩家身边打转', () => {
    // 玩家那个 0.6 × 1.8 的碰撞箱太大，冲过头也照样被它裹住，这条性质在它身上看不出来。
    // 所以把收经验的一方缩成一个点：只有正好落到它上面才吸得着。带惯性或者不钳位的
    // 实现会以最高速度在这个点两侧来回跳，永远吸不到。
    const orbs = orbsWith();
    const target: Vec3 = { ...ORB_CENTER, x: ORB_CENTER.x + 6 };
    const point = hitboxAt(target, 0, 0);
    const into = recorder();
    advance(orbs, point, 100, into);

    expect(into.gained).toEqual([3]);
    expect(orbs.count).toBe(0);
  });

  it('上一个 tick 的位置留给渲染层插值', () => {
    const orbs = orbsWith();
    const player = playerXAway(6);
    advance(orbs, player, 3);

    const before = orbs.all()[0]!.position;
    advance(orbs, player, 1);
    const orb = orbs.all()[0]!;
    expect(orb.previousPosition).toEqual(before);
    expect(orb.position).not.toEqual(before);
  });
});

describe('经验球被吸收', () => {
  it('碰到玩家就被吸收，经验值交给玩家', () => {
    const orbs = orbsWith(6);
    const into = recorder();
    orbs.step(playerCenteredAt(ORB_CENTER), into);

    expect(into.gained).toEqual([6]);
    expect(orbs.count).toBe(0);
  });

  it('没有拾取延迟：生成的下一个 tick 贴着玩家就被吸收', () => {
    // 掉落物有 10 tick 的延迟（见 PICKUP_DELAY_TICKS），经验球没有——issue #9 说的是
    // 「接触即吸收」
    const orbs = orbsWith();
    const into = recorder();
    orbs.step(playerCenteredAt(ORB_CENTER), into);

    expect(into.gained).toHaveLength(1);
  });

  it('隔着几格飞过来，若干 tick 后被吸收', () => {
    const orbs = orbsWith(3);
    const player = playerXAway(6);
    const into = recorder();
    advance(orbs, player, 40, into);

    expect(into.gained).toEqual([3]);
    expect(orbs.count).toBe(0);
  });

  it('几个经验球各自被吸收，经验一个不漏', () => {
    const orbs = new XpOrbs();
    orbs.spawnInBlock(3, BLOCK.x, BLOCK.y, BLOCK.z);
    orbs.spawnInBlock(6, BLOCK.x + 1, BLOCK.y, BLOCK.z);
    const into = recorder();
    advance(orbs, playerCenteredAt(ORB_CENTER), 40, into);

    expect([...into.gained].sort((a, b) => a - b)).toEqual([3, 6]);
    expect(orbs.count).toBe(0);
  });

  it('吸走一个不影响还在飞的另一个', () => {
    const orbs = new XpOrbs();
    // 一个贴着玩家，一个远在吸引范围之外
    orbs.spawnInBlock(3, BLOCK.x, BLOCK.y, BLOCK.z);
    orbs.spawnInBlock(6, BLOCK.x + 40, BLOCK.y, BLOCK.z);
    const into = recorder();
    orbs.step(playerCenteredAt(ORB_CENTER), into);

    expect(into.gained).toEqual([3]);
    expect(orbs.count).toBe(1);
    expect(orbs.all()[0]!.amount).toBe(6);
  });
});

describe('经验球的存活时间', () => {
  it('存活 tick 数逐 tick 累加', () => {
    const orbs = orbsWith();
    advance(orbs, FAR_AWAY, 5);
    expect(orbs.all()[0]!.age).toBe(5);
  });

  it('没人来收时最后会消失', () => {
    const orbs = orbsWith();
    advance(orbs, FAR_AWAY, XP_ORB_LIFETIME_TICKS - 1);
    expect(orbs.count).toBe(1);

    advance(orbs, FAR_AWAY, 1);
    expect(orbs.count).toBe(0);
  });
});
