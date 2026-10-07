/**
 * 手持物品的挥动（见 GLOSSARY.md 的「挥动」）：左键按下时右下角那件东西挥一下，按住挖掘时一直挥。
 *
 * 纯表现：核心只记上次按下左键的 tick（`GameCore.lastSwingTick`）与挖掘中没有（`MiningView.digging`），
 * 挥到哪一步由这里按 tick 差加 `alpha` 算，两 tick 之间连续。不碰 Three.js 与 DOM，能在 Node 里断言。
 */

/** 挥一下要多少 tick。与原版一致：0.3 秒。 */
export const HELD_SWING_TICKS = 6;

/**
 * 这一帧挥到了哪一步：0 是原位，往 1 走是一次挥动从头到尾。
 *
 * 按下那一 tick 起 `HELD_SWING_TICKS` 内挥一次，之后停在 0；挖掘中按同一个节拍一轮接一轮地挥，
 * 相位接着按下那一 tick 算，所以从单挥转成持续挥动时不会跳。now 是核心的 tick 计数，alpha 是这一帧
 * 落在两个 tick 之间的比例。
 */
export function heldSwingPhase(
  lastSwingTick: number | undefined,
  digging: boolean,
  now: number,
  alpha: number,
): number {
  if (lastSwingTick === undefined) return 0;
  const elapsed = now - lastSwingTick + alpha;
  if (digging) return (elapsed % HELD_SWING_TICKS) / HELD_SWING_TICKS;
  return elapsed < HELD_SWING_TICKS ? elapsed / HELD_SWING_TICKS : 0;
}

/**
 * 挥到某一步时手持物品相对原位的偏移（手持相机坐标里的方块）与绕 x 轴多转的角度（弧度）。
 * 负的 pitch 是往前、往下砍。
 */
export interface HeldSwingPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pitch: number;
}

/** 原位：不挪不转。 */
const AT_REST: HeldSwingPose = Object.freeze({ x: 0, y: 0, z: 0, pitch: 0 });

/** 挥到最深时往左、往下、往前各挪多少（方块），与往前转多少（弧度）。 */
const SWING_REACH = { x: -0.12, y: -0.14, z: -0.08, pitch: -0.9 } as const;

/**
 * 相位对应的姿态：沿半个正弦走，挥到一半最深，头尾都回到原位。
 */
export function heldSwingPose(phase: number): HeldSwingPose {
  if (phase === 0) return AT_REST;
  const depth = Math.sin(phase * Math.PI);
  return {
    x: SWING_REACH.x * depth,
    y: SWING_REACH.y * depth,
    z: SWING_REACH.z * depth,
    pitch: SWING_REACH.pitch * depth,
  };
}
