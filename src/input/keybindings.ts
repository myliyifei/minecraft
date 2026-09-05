import type { MoveIntent } from '../core/player';

/**
 * 一个可以绑键的移动动作。
 * 名字直接取自核心的移动意图，因此意图里加一个字段，下面那张表不补就编译不过。
 */
export type MoveAction = keyof MoveIntent;

/**
 * 键位表：动作到 `KeyboardEvent.code` 的唯一来源。别处不许再写按键名。
 *
 * 用 `code` 而不是 `key`：`code` 是键的物理位置，与键盘布局无关——AZERTY 上左手那颗
 * 键仍然是 `KeyW`，不会变成 Z。设置界面里的自定义键位（后续切片）改的就是这张表。
 */
export const KEY_BINDINGS: Readonly<Record<MoveAction, string>> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
};

/** 所有可绑键的动作。 */
export const MOVE_ACTIONS = Object.keys(KEY_BINDINGS) as MoveAction[];

/** 反查：按下的 `code` 对应哪个动作。没绑过的键查不到。 */
export const ACTION_BY_CODE: ReadonlyMap<string, MoveAction> = new Map(
  MOVE_ACTIONS.map((action) => [KEY_BINDINGS[action], action]),
);
