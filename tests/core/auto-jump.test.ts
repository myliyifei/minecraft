import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore, type GameCoreOptions } from '../../src/core/game';
import { IDLE_INTENT, JUMP_VELOCITY, PLAYER_WIDTH, type MoveIntent } from '../../src/core/player';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTerrain } from '../helpers/flat-terrain';

/*
 * 自动跳跃（#78，见 CONTEXT.md「自动跳跃」）：在地面上、有水平移动输入、水平移动被一格高的台阶挡住、台阶上方站得下
 * 玩家碰撞箱时自动起跳，起跳速度在下一 tick 生效；在水里不触发。核心多一个运行时可改的开关：初值从构造参数
 * `autoJump` 传入（省略时开），之后由 `setAutoJump` 改，`autoJump` 读当前值，与视距（`viewRadius`、`setViewRadius`）
 * 同一种写法（ADR-0020 补记）。
 *
 * 全部在平地上用 `setBlock` 摆台阶、墙与水，从核心的公共接口驱动：`turn`、`setMoveIntent`、`tick`，只读玩家的位置。
 * 玩家出生在原点那一格中心（0.5, G + 1, 0.5），朝 −Z。
 */

const G = FLAT_GROUND_Y;

const FORWARD: MoveIntent = { ...IDLE_INTENT, forward: true };

/** 面朝 +X 的偏航角增量：初始朝 −Z，往右转 90°。 */
const FACING_PLUS_X = -Math.PI / 2;

/** 朝台阶走多少 tick：撞上台阶约 1 tick，起跳到越过台阶顶面约 4 tick，再走过台阶边缘，留足余量。 */
const WALK_TICKS = 30;

/** 碰撞箱正面贴在 z = 0 那个面上时玩家的 z：被 z ≤ −1 那一侧的东西挡住停下的位置。 */
const BLOCKED_Z = 0 + PLAYER_WIDTH / 2;

/** 视距 1 的平地核心。 */
function core(options: GameCoreOptions = {}): GameCore {
  return new GameCore({ viewRadius: 1, terrain: flatTerrain, ...options });
}

/** 把 [x0, x1] × [y0, y1] × [z0, z1]（含两端）填成 block。 */
function fill(
  game: GameCore,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  [z0, z1]: [number, number],
  block: BlockType,
): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) game.setBlock(x, y, z, block);
    }
  }
}

/** 玩家前方（z ≤ −1 那一侧）垒 height 格高的台阶，横向够宽、纵深够长，走不出去也绕不过去。 */
function stepAhead(game: GameCore, height: number): void {
  fill(game, [-4, 4], [G + 1, G + height], [-12, -1], BlockType.Stone);
}

/** 按住 intent 推进 ticks 个 tick，返回每一 tick 结束时脚底的 y。 */
function heights(game: GameCore, intent: MoveIntent, ticks: number): number[] {
  game.setMoveIntent(intent);
  const ys: number[] = [];
  for (let i = 0; i < ticks; i++) {
    game.tick();
    ys.push(game.player.position.y);
  }
  game.setMoveIntent(IDLE_INTENT);
  return ys;
}

describe('自动跳跃：开着时朝一格高的台阶走（#78）', () => {
  it('构造时不给 autoJump：开关是开的；朝一格高的台阶走，若干 tick 后站在台阶上、越过了台阶边缘', () => {
    const game = core();
    expect(game.autoJump).toBe(true);
    stepAhead(game, 1);
    heights(game, FORWARD, WALK_TICKS);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 1);
    expect(game.player.position.z).toBeLessThan(-1);
  });

  it('构造时给 autoJump: true：同样站上台阶', () => {
    const game = core({ autoJump: true });
    expect(game.autoJump).toBe(true);
    stepAhead(game, 1);
    heights(game, FORWARD, WALK_TICKS);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 1);
  });

  it('用的是普通的起跳速度：起跳那一 tick 上升 JUMP_VELOCITY，最高点与原地按跳一样不到台阶顶面之上 1.3 格', () => {
    const game = core();
    stepAhead(game, 1);
    const ys = [FLAT_STAND_Y, ...heights(game, FORWARD, WALK_TICKS)];
    const rise = ys.findIndex((y, i) => i > 0 && y > ys[i - 1]!);
    expect(rise).toBeGreaterThan(0);
    expect(ys[rise]! - ys[rise - 1]!).toBeCloseTo(JUMP_VELOCITY, 10);
    // 跳过台阶之后不再自动跳：平地上一直走，最高点只有起跳那一次
    expect(Math.max(...ys)).toBeLessThan(FLAT_STAND_Y + 1.3);
  });

  it('台阶在 +X 方向：转过身朝 +X 走，同样站上台阶', () => {
    const game = core();
    fill(game, [1, 12], [G + 1, G + 1], [-4, 4], BlockType.Stone);
    game.turn(FACING_PLUS_X, 0);
    heights(game, FORWARD, WALK_TICKS);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 1);
    expect(game.player.position.x).toBeGreaterThan(1);
  });

  it('朝一级一级的台阶走：一级一格，连着登上三级', () => {
    const game = core();
    // z = −1 起每往前两格高一级：z ∈ [−2, −1] 高 1 格，[−4, −3] 高 2 格，[−12, −5] 高 3 格
    fill(game, [-4, 4], [G + 1, G + 1], [-12, -1], BlockType.Stone);
    fill(game, [-4, 4], [G + 2, G + 2], [-12, -3], BlockType.Stone);
    fill(game, [-4, 4], [G + 3, G + 3], [-12, -5], BlockType.Stone);
    heights(game, FORWARD, 60);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 3);
    expect(game.player.position.z).toBeLessThan(-5);
  });
});

describe('自动跳跃：不该跳的时候不跳（#78）', () => {
  it('台阶上方只有一格空间（台阶顶面往上第二格是石头）：站不下碰撞箱，不跳，贴着台阶停下', () => {
    const game = core();
    // 场景搭对了：开关开着，不跳是因为规则，不是因为没开
    expect(game.autoJump).toBe(true);
    stepAhead(game, 1);
    // 台阶顶面上方第二格封顶：台阶上只剩 G + 2 那一格高的空间，1.8 格高的碰撞箱站不下。玩家头顶不封，原地起跳本来跳得起来。
    fill(game, [-4, 4], [G + 3, G + 3], [-12, -1], BlockType.Stone);
    const ys = heights(game, FORWARD, WALK_TICKS);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });

  it('两格高的墙：不跳，贴着墙停下', () => {
    const game = core();
    // 场景搭对了：开关开着，不跳是因为规则，不是因为没开
    expect(game.autoJump).toBe(true);
    stepAhead(game, 2);
    const ys = heights(game, FORWARD, WALK_TICKS);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });

  it('贴着一格高的台阶站着、没有移动输入：不跳', () => {
    const game = core({ autoJump: false });
    stepAhead(game, 1);
    // 先关着开关走到台阶跟前贴住它，再打开开关、松开所有键
    heights(game, FORWARD, 10);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
    game.setAutoJump(true);
    const ys = heights(game, IDLE_INTENT, 40);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });

  it('贴着一格高的台阶、朝反方向走开：水平没有被台阶挡住，不跳', () => {
    const game = core({ autoJump: false });
    stepAhead(game, 1);
    heights(game, FORWARD, 10);
    game.setAutoJump(true);
    const ys = heights(game, { ...IDLE_INTENT, back: true }, 10);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeGreaterThan(BLOCKED_Z + 1);
  });

  it('贴着一格高的台阶站着、没有移动输入、只被击退推着朝台阶：水平被挡住，但不跳', () => {
    const blocked = core({ autoJump: false });
    stepAhead(blocked, 1);
    heights(blocked, FORWARD, 10);
    expect(blocked.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
    // 击退的水平速度只能经快照放进去：朝 −Z（台阶那一侧）0.4 格/tick，与挨一下打时的大小相同，不带上抛
    const snapshot = blocked.snapshot();
    const game = core({ restore: { ...snapshot, player: { ...snapshot.player, knockback: { x: 0, z: -0.4 } } } });
    // 场景搭对了：开关开着，还在地上贴着台阶
    expect(game.autoJump).toBe(true);
    expect(game.player.onGround).toBe(true);
    const ys = heights(game, IDLE_INTENT, 20);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });

  it('不在地面上：脚下悬空、前方是一格高的石头，被它挡住时不起跳，一路落到竖井底', () => {
    const game = core();
    // 场景搭对了：开关开着，不跳是因为规则，不是因为没开
    expect(game.autoJump).toBe(true);
    // 玩家脚下那一列往下挖三格，井底的顶面在 G − 2；正前方 z = −1 那一格、与脚底同高处放一块石头，上方空着。
    // 第一 tick 竖直还没动（速度为 0），水平就被这块石头挡住：它只有一格高、上方站得下，只是玩家不在地面上。
    // 不看「在地面上」的实现在这里会半空起跳。
    fill(game, [0, 0], [G - 2, G], [0, 0], BlockType.Air);
    fill(game, [-1, 1], [G + 1, G + 1], [-1, -1], BlockType.Stone);
    const ys = [FLAT_STAND_Y, ...heights(game, FORWARD, 40)];
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
    expect(game.player.position.y).toBe(G - 2);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });
  it('斜着走、沿 +X 一侧两格高的墙滑过墙的尽头：不跳', () => {
    const game = core();
    // 场景搭对了：开关开着，不跳是因为规则，不是因为没开
    expect(game.autoJump).toBe(true);
    // 墙在 x = 1、z ∈ [−2, 0]、两格高。前进加右移：X 一直被墙挡住、沿墙往 −Z 滑，滑过 z = −2 那一端之后 X 不再被挡。
    // 滑过尽头那一 tick，按 Z 走之前的碰撞箱 X 被挡，Z 走完之后碰撞箱已越过墙的尽头，抬高 1 格不被挡；只看后者的实现在这里误跳一次。
    fill(game, [1, 1], [G + 1, G + 2], [-2, 0], BlockType.Stone);
    const ys = heights(game, { ...FORWARD, right: true }, WALK_TICKS);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    // 场景搭对了：确实滑过了墙的尽头，并且绕到了墙的 +X 一侧
    expect(game.player.position.z).toBeLessThan(-2 - PLAYER_WIDTH / 2);
    expect(game.player.position.x).toBeGreaterThan(1);
  });
});

describe('自动跳跃：在水里不触发（#78）', () => {
  it('站在铺在草方块上的一层水里、不按跳朝一格高的台阶走：在水里，不跳，贴着台阶停下', () => {
    const game = core();
    // 场景搭对了：开关开着，不跳是因为规则，不是因为没开
    expect(game.autoJump).toBe(true);
    stepAhead(game, 1);
    // 玩家所在那一片、台阶前面，G + 1 那一层铺成水：脚底在水里，碰撞箱与水格重叠
    fill(game, [-4, 4], [G + 1, G + 1], [0, 4], BlockType.Water);
    game.tick();
    // 场景搭对了：玩家在水里
    expect(game.player.inWater).toBe(true);
    const ys = heights(game, FORWARD, WALK_TICKS);
    expect(Math.max(...ys)).toBeLessThanOrEqual(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
    expect(game.player.inWater).toBe(true);
  });

  it('tick 开始时在水面上方、这一 tick 落进一格深的水踩到池底，同时被一格高的岸挡住：不跳，留在水里', () => {
    // 玩家所在那一片（x ∈ [−1, 1]、z ∈ [0, 1]）挖到 F，池底那一层是水：一格深的水，水面在 F + 1。
    // 前方 z = −1 那一列是岸：顶面在 F + 1，比池底高一格，上方一直空到地面。
    const F = G - 16;
    const setup = core();
    fill(setup, [-1, 1], [F, G], [-1, 1], BlockType.Air);
    fill(setup, [-1, 1], [F, F], [0, 1], BlockType.Water);
    fill(setup, [-1, 1], [F, F], [-1, -1], BlockType.Stone);
    // 从快照放到水面上方 0.09 格、以 1.41 格/tick 下落：与从地面掉下 16 格时落进水里那一 tick 开始时相同
    const above = F + 1.09;
    const snapshot = setup.snapshot();
    const game = core({
      restore: {
        ...snapshot,
        player: { ...snapshot.player, position: { x: 0.5, y: above, z: 0.5 }, velocityY: -1.41, fallHighest: above },
      },
    });
    // 场景搭对了：开关开着，这一 tick 开始时不在水里
    expect(game.autoJump).toBe(true);
    expect(game.player.inWater).toBe(false);
    // 落水那一 tick 按着前进：竖直这一步踩到池底，水平被岸挡住
    heights(game, FORWARD, 1);
    // 场景搭对了：踩在池底、在水里、贴着岸
    expect(game.player.position.y).toBe(F);
    expect(game.player.onGround).toBe(true);
    expect(game.player.inWater).toBe(true);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
    // 之后接着按前进、不按跳：在水里按爬岸规则，不按跳就不出水
    const ys = heights(game, FORWARD, 20);
    expect(Math.max(...ys)).toBe(F);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
    expect(game.player.inWater).toBe(true);
  });
});

describe('自动跳跃的开关（#78）', () => {
  it('构造时给 autoJump: false：朝一格高的台阶走被挡住、不上台阶，与没有自动跳跃时相同', () => {
    const game = core({ autoJump: false });
    expect(game.autoJump).toBe(false);
    stepAhead(game, 1);
    const ys = heights(game, FORWARD, WALK_TICKS);
    expect(Math.max(...ys)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);
  });

  it('关掉之后自己按跳仍能登上一格台阶', () => {
    const game = core({ autoJump: false });
    stepAhead(game, 1);
    heights(game, { ...FORWARD, jump: true }, WALK_TICKS);
    heights(game, FORWARD, 10);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 1);
  });

  it('运行时可改：开着时 setAutoJump(false) 之后被台阶挡住；再 setAutoJump(true) 之后站上台阶', () => {
    const game = core();
    stepAhead(game, 1);
    game.setAutoJump(false);
    expect(game.autoJump).toBe(false);
    const blocked = heights(game, FORWARD, WALK_TICKS);
    expect(Math.max(...blocked)).toBe(FLAT_STAND_Y);
    expect(game.player.position.z).toBeCloseTo(BLOCKED_Z, 10);

    game.setAutoJump(true);
    expect(game.autoJump).toBe(true);
    heights(game, FORWARD, WALK_TICKS);
    expect(game.player.position.y).toBe(FLAT_STAND_Y + 1);
  });

  it('不进快照：从快照构造时按这次的构造参数，省略时开', () => {
    const before = core({ autoJump: false });
    const snapshot = before.snapshot();
    expect(core({ restore: snapshot, autoJump: false }).autoJump).toBe(false);
    expect(core({ restore: snapshot }).autoJump).toBe(true);

    const restored = core({ restore: snapshot, autoJump: false });
    stepAhead(restored, 1);
    heights(restored, FORWARD, WALK_TICKS);
    expect(restored.player.position.y).toBe(FLAT_STAND_Y);
  });
});
