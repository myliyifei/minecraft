import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { TICK_RATE } from '../../src/core/constants';
import {
  GRAVITY,
  IDLE_INTENT,
  MAX_PITCH,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  Player,
  WALK_SPEED,
  type MoveIntent,
} from '../../src/core/player';
import type { World } from '../../src/core/world';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTestWorld } from '../helpers/flat-terrain';

/** 只按空格。 */
const JUMP_INTENT: MoveIntent = { ...IDLE_INTENT, jump: true };

/** 只按 W。 */
const FORWARD_INTENT: MoveIntent = { ...IDLE_INTENT, forward: true };

/** 面朝 +X 的偏航角。初始朝向是 −Z，往右转 90° 就朝 +X。 */
const FACING_PLUS_X = -Math.PI / 2;

/**
 * spec 写的跳跃高度是「约 1.25 格」。这里放宽成一个区间：
 * 下界要够跳上一格台阶，上界要够不上两格。
 */
const JUMP_HEIGHT_MIN = 1.2;
const JUMP_HEIGHT_MAX = 1.3;

/** 站在原点那一格地面上的玩家。`world` 省略时用一片干净的平地。 */
function standingAt(height = FLAT_STAND_Y, world: World = flatTestWorld()): Player {
  return new Player(world, { x: 0.5, y: height, z: 0.5 });
}

describe('玩家的重力与落地', () => {
  it('站在草方块上，tick 任意多次都不下落', () => {
    const player = standingAt();
    for (let i = 0; i < 200; i++) player.step(IDLE_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y);
    expect(player.onGround).toBe(true);
  });

  it('从 3 格高处开始，若干 tick 后停在地面而不是穿过去', () => {
    const player = standingAt(FLAT_STAND_Y + 3);
    const heights: number[] = [];
    for (let i = 0; i < 40; i++) {
      player.step(IDLE_INTENT);
      heights.push(player.position.y);
    }
    expect(player.position.y).toBe(FLAT_STAND_Y);
    // 中途也不许低于地面：穿过去再被拉回来同样是穿模
    expect(Math.min(...heights)).toBe(FLAT_STAND_Y);
    expect(player.onGround).toBe(true);
  });

  it('从两百格高处落下也不会穿过地面', () => {
    // 下落速度会收敛到接近 4 格/tick，逐点检测这时就漏格了，扫掠不会。
    const player = standingAt(FLAT_STAND_Y + 200);
    const heights: number[] = [];
    for (let i = 0; i < 200; i++) {
      player.step(IDLE_INTENT);
      heights.push(player.position.y);
    }
    expect(player.position.y).toBe(FLAT_STAND_Y);
    expect(Math.min(...heights)).toBe(FLAT_STAND_Y);
  });

  it('落地后速度归零，不带着攒下来的下落速度继续掉', () => {
    // 从十格高落到地面站定，再挖空脚下那一格：玩家应当从静止重新开始掉。
    // 落地时不清零速度的实现在这里会一步冲下去。
    const world = flatTestWorld();
    const player = standingAt(FLAT_STAND_Y + 10, world);
    for (let i = 0; i < 60; i++) player.step(IDLE_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y);

    world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air);
    player.step(IDLE_INTENT);
    expect(FLAT_STAND_Y - player.position.y).toBeLessThan(GRAVITY * 2);
  });
});

describe('玩家的跳跃', () => {
  it('从地面起跳的最高点约 1.25 格', () => {
    const player = standingAt();
    let apex = player.position.y;
    for (let i = 0; i < 20; i++) {
      player.step(JUMP_INTENT);
      apex = Math.max(apex, player.position.y);
    }
    expect(apex - FLAT_STAND_Y).toBeGreaterThan(JUMP_HEIGHT_MIN);
    expect(apex - FLAT_STAND_Y).toBeLessThan(JUMP_HEIGHT_MAX);
  });

  it('一直按住空格只是原地反复起跳，不会越跳越高', () => {
    const player = standingAt();
    let apex = player.position.y;
    for (let i = 0; i < 200; i++) {
      player.step(JUMP_INTENT);
      apex = Math.max(apex, player.position.y);
    }
    expect(apex - FLAT_STAND_Y).toBeLessThan(JUMP_HEIGHT_MAX);
  });

  it('离地之后按空格不再起跳', () => {
    const player = standingAt(FLAT_STAND_Y + 5);
    const heights: number[] = [];
    for (let i = 0; i < 5; i++) {
      player.step(JUMP_INTENT);
      heights.push(player.position.y);
    }
    // 下落途中每一 tick 都在往下走，没有被二段跳顶回去
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!).toBeLessThan(heights[i - 1]!);
    }
  });
});

describe('玩家的水平移动', () => {
  it('初始视角朝 −Z，按 W 就往 −Z 走', () => {
    const player = standingAt();
    player.step(FORWARD_INTENT);
    expect(player.position.z).toBeLessThan(0.5);
    expect(player.position.x).toBeCloseTo(0.5, 10);
  });

  it('按 S 往视角的反方向走', () => {
    const player = standingAt();
    player.step({ ...IDLE_INTENT, back: true });
    expect(player.position.z).toBeGreaterThan(0.5);
  });

  it('按 D 往视角的右手边走', () => {
    const player = standingAt();
    player.step({ ...IDLE_INTENT, right: true });
    // yaw = 0 时看向 −Z，右手边是 +X
    expect(player.position.x).toBeGreaterThan(0.5);
    expect(player.position.z).toBeCloseTo(0.5, 10);
  });

  it('转过视角后 W 的方向跟着转', () => {
    const player = standingAt();
    player.turn(FACING_PLUS_X, 0);
    player.step(FORWARD_INTENT);
    expect(player.position.x).toBeGreaterThan(0.5);
    expect(player.position.z).toBeCloseTo(0.5, 10);
  });

  it('走一秒的距离就是步行速度', () => {
    const player = standingAt();
    for (let i = 0; i < TICK_RATE; i++) player.step(FORWARD_INTENT);
    expect(0.5 - player.position.z).toBeCloseTo(WALK_SPEED, 6);
  });

  it('斜着走不比直着走快', () => {
    const straight = standingAt();
    const diagonal = standingAt();
    for (let i = 0; i < TICK_RATE; i++) {
      straight.step(FORWARD_INTENT);
      diagonal.step({ ...IDLE_INTENT, forward: true, left: true });
    }
    const walked = (player: Player): number =>
      Math.hypot(player.position.x - 0.5, player.position.z - 0.5);
    expect(walked(diagonal)).toBeCloseTo(walked(straight), 6);
  });

  it('前后同时按住原地不动', () => {
    const player = standingAt();
    for (let i = 0; i < 10; i++) player.step({ ...IDLE_INTENT, forward: true, back: true });
    expect(player.position.x).toBe(0.5);
    expect(player.position.z).toBe(0.5);
  });
});

describe('玩家与墙、台阶的碰撞', () => {
  /**
   * 在平地上、x ≥ 1 的那一侧垒一道 `height` 格高的台阶（够长，走不出去）。
   * 玩家从 (0.5, 0.5) 面朝 +X 走过来撞它。
   */
  function worldWithStep(height: number, block: BlockType = BlockType.Stone): World {
    const world = flatTestWorld();
    for (let x = 1; x <= 12; x++) {
      for (let z = -3; z <= 4; z++) {
        for (let i = 0; i < height; i++) {
          world.setBlock(x, FLAT_GROUND_Y + 1 + i, z, block);
        }
      }
    }
    return world;
  }

  /** 面朝 +X 的玩家，站在台阶前的平地上。 */
  function walkerFacingStep(world: World): Player {
    const player = standingAt(FLAT_STAND_Y, world);
    player.turn(FACING_PLUS_X, 0);
    return player;
  }

  it('朝墙走会被挡住，不穿过方块', () => {
    const player = walkerFacingStep(worldWithStep(3));
    for (let i = 0; i < 40; i++) player.step(FORWARD_INTENT);
    // 碰撞箱的 +X 侧面正好贴在 x = 1 的墙面上
    expect(player.position.x).toBeCloseTo(1 - PLAYER_WIDTH / 2, 10);
  });

  it('贴着墙沿墙走时另一个轴照常前进', () => {
    const player = walkerFacingStep(worldWithStep(3));
    // 同时按 W（朝 +X 撞墙）和 A（朝 −Z）：撞墙的那一轴停下，另一轴继续
    for (let i = 0; i < 20; i++) player.step({ ...IDLE_INTENT, forward: true, left: true });
    expect(player.position.x).toBeCloseTo(1 - PLAYER_WIDTH / 2, 10);
    expect(player.position.z).toBeLessThan(0.5 - 2);
  });

  it('跳跃能登上 1 格台阶', () => {
    const player = walkerFacingStep(worldWithStep(1));
    for (let i = 0; i < 30; i++) player.step({ ...FORWARD_INTENT, jump: true });
    // 松开空格再走几步落稳，免得断言撞在某一次跳的半空中
    for (let i = 0; i < 10; i++) player.step(FORWARD_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y + 1);
    expect(player.position.x).toBeGreaterThan(1);
  });

  it('跳跃登不上 2 格台阶', () => {
    const player = walkerFacingStep(worldWithStep(2));
    let apex = player.position.y;
    for (let i = 0; i < 60; i++) {
      player.step({ ...FORWARD_INTENT, jump: true });
      apex = Math.max(apex, player.position.y);
    }
    for (let i = 0; i < 10; i++) player.step(FORWARD_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y);
    expect(player.position.x).toBeCloseTo(1 - PLAYER_WIDTH / 2, 10);
    // 跳到最高点也没够上第二格的顶面
    expect(apex).toBeLessThan(FLAT_STAND_Y + 2);
  });

  it('走出边缘会掉下去，落在下面的方块上', () => {
    // 在 x ≥ 1 的那一侧挖掉三层，玩家走过去应当掉进坑里落到坑底
    const world = flatTestWorld();
    const pitFloor = FLAT_GROUND_Y - 3;
    for (let x = 1; x <= 12; x++) {
      for (let z = -3; z <= 4; z++) {
        for (let y = FLAT_GROUND_Y; y > pitFloor; y--) world.setBlock(x, y, z, BlockType.Air);
      }
    }
    const player = walkerFacingStep(world);
    for (let i = 0; i < 40; i++) player.step(FORWARD_INTENT);

    expect(player.position.y).toBe(pitFloor + 1);
    // 碰撞箱还搭在边上时不会掉，整个箱子越过边界之后才掉——和原版一致
    expect(player.position.x).toBeGreaterThan(1 + PLAYER_WIDTH / 2);
  });

  it('树叶和别的方块一样挡人：树下不会卡进树冠里', () => {
    // 树叶不遮挡视线（opaque 为假），但它是实心的，碰撞规则对所有方块一致
    const player = walkerFacingStep(worldWithStep(3, BlockType.OakLeaves));
    for (let i = 0; i < 40; i++) player.step(FORWARD_INTENT);
    expect(player.position.x).toBeCloseTo(1 - PLAYER_WIDTH / 2, 10);
  });

  it('头顶有方块时跳不起来，也不会顶进去', () => {
    const world = flatTestWorld();
    // 在脚底 +2 格铺一层顶板：1.8 高的碰撞箱抬到 0.2 格就顶到它
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) world.setBlock(x, FLAT_STAND_Y + 2, z, BlockType.Stone);
    }
    const player = standingAt(FLAT_STAND_Y, world);
    let apex = player.position.y;
    for (let i = 0; i < 40; i++) {
      player.step(JUMP_INTENT);
      apex = Math.max(apex, player.position.y);
    }
    // 头顶顶住了，最高点就是碰撞箱顶面贴着顶板的那个高度，而不是 1.25 格
    expect(apex).toBe(FLAT_STAND_Y + 2 - PLAYER_HEIGHT);
    // 松开空格落回地面，没有卡在顶板下面
    for (let i = 0; i < 10; i++) player.step(IDLE_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y);
  });
});

describe('玩家的视角', () => {
  it('初始朝向的偏航与俯仰都是 0', () => {
    const player = standingAt();
    expect(player.yaw).toBe(0);
    expect(player.pitch).toBe(0);
  });

  it('转动视角按增量累加', () => {
    const player = standingAt();
    player.turn(0.3, 0.2);
    player.turn(0.1, -0.5);
    expect(player.yaw).toBeCloseTo(0.4, 10);
    expect(player.pitch).toBeCloseTo(-0.3, 10);
  });

  it('俯仰夹在接近垂直的范围内，抬头低头都不会翻过去', () => {
    const player = standingAt();
    player.turn(0, 100);
    expect(player.pitch).toBe(MAX_PITCH);
    expect(MAX_PITCH).toBeLessThan(Math.PI / 2);
    // 「接近垂直」：差不到一度
    expect(MAX_PITCH).toBeGreaterThan(Math.PI / 2 - 0.02);

    player.turn(0, -100);
    expect(player.pitch).toBe(-MAX_PITCH);
  });

  it('偏航不受限制，转多少圈都折回 (−π, π]', () => {
    const player = standingAt();
    player.turn(Math.PI * 8.5, 0);
    expect(player.yaw).toBeCloseTo(Math.PI * 0.5, 10);
  });

  it('俯仰不影响移动方向：抬头按 W 仍然平着走', () => {
    const player = standingAt();
    player.turn(0, MAX_PITCH);
    for (let i = 0; i < TICK_RATE; i++) player.step(FORWARD_INTENT);
    expect(player.position.y).toBe(FLAT_STAND_Y);
    expect(0.5 - player.position.z).toBeCloseTo(WALK_SPEED, 6);
  });
});

describe('玩家不会被卡死', () => {
  /** 固定的伪随机序列，跑多少次结果都一样。 */
  function makeRandom(seed: number): () => number {
    let state = seed | 0;
    return () => {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      return ((state >>> 8) & 0xff_ffff) / 0x100_0000;
    };
  }

  /** 一动不动多少 tick 才算可疑。 */
  const MOTIONLESS_TICKS = 60;

  /** 走出这么远才算「还能走」。0.6 宽的玩家在一格缝里能晃 0.2 格，那不算。 */
  const ESCAPE_DISTANCE = 1.5;

  /** 从某处朝某个方向按住 W + 空格若干 tick，返回水平净位移。 */
  function tryEscape(world: World, from: Player, yaw: number): number {
    const at = from.position;
    const probe = new Player(world, at);
    probe.turn(yaw, 0);
    for (let i = 0; i < 40; i++) probe.step({ ...FORWARD_INTENT, jump: true });
    const after = probe.position;
    return Math.hypot(after.x - at.x, after.z - at.z);
  }

  /** 用户的原话：任何方向都动不了，空格也跳不起来。 */
  function isStuck(world: World, player: Player): boolean {
    for (let i = 0; i < 8; i++) {
      if (tryEscape(world, player, (i / 8) * Math.PI * 2) > ESCAPE_DISTANCE) return false;
    }
    return true;
  }

  /**
   * 摆一片一格高的障碍——台阶、单块方块、矮墙。全都跳得过去，所以走这片地形
   * 永远不该走不动。
   */
  function worldWithLowObstacles(): World {
    const world = flatTestWorld();
    const random = makeRandom(4321);
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(random() * 24) - 12;
      const z = Math.floor(random() * 24) - 12;
      world.setBlock(x, FLAT_STAND_Y, z, BlockType.Stone);
    }
    return world;
  }

  it('在一格高的障碍之间乱走，不会走到动不了', () => {
    // 撞墙或顶到天花板时，钳位算出的落点带着浮点误差，可能落到阻挡面的另一侧。
    // 一旦碰撞箱被判成嵌进方块，各个方向的扫掠都返回零位移——玩家永久卡死。
    const world = worldWithLowObstacles();
    const random = makeRandom(20_260_906);
    const stuck: string[] = [];

    for (let run = 0; run < 200 && stuck.length === 0; run++) {
      const player = new Player(world, { x: 0.5, y: FLAT_STAND_Y, z: 0.5 });
      player.turn(random() * Math.PI * 2, 0);
      let motionless = 0;
      let last = player.position;

      for (let t = 0; t < 400; t++) {
        if (random() < 0.05) player.turn((random() - 0.5) * Math.PI, 0);
        player.step({ ...FORWARD_INTENT, jump: random() < 0.3 });
        const now = player.position;
        const moved =
          Math.abs(now.x - last.x) + Math.abs(now.y - last.y) + Math.abs(now.z - last.z);
        motionless = moved < 1e-12 ? motionless + 1 : 0;
        last = now;

        if (motionless >= MOTIONLESS_TICKS && isStuck(world, player)) {
          stuck.push(`第 ${run} 次游走的第 ${t} tick：(${now.x}, ${now.y}, ${now.z})`);
          break;
        }
      }
    }
    expect(stuck).toEqual([]);
  });

});
