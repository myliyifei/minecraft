import { HOTBAR_SIZE } from '../core/inventory';
import { IDLE_INTENT, type MoveIntent } from '../core/player';

/**
 * 一个可以绑键的移动动作。
 * 名字直接取自核心的移动意图，因此意图里加一个字段，下面那张表不补就编译不过。
 */
export type MoveAction = keyof MoveIntent;

/** 不属于移动意图、但同样按住才生效的动作。目前只有连锁挖掘。 */
export type HoldAction = 'chainMining';

/** 按一下切换一次的动作。目前只有开合背包界面。 */
export type ToggleAction = 'inventory';

/**
 * 键位表：动作到 `KeyboardEvent.code` 的唯一来源。别处不许再写按键名。
 *
 * 用 `code` 而不是 `key`：`code` 是键的物理位置，与键盘布局无关——AZERTY 上左手那颗
 * 键仍然是 `KeyW`，不会变成 Z。设置界面里的自定义键位（后续切片）改的就是这张表：
 * 移动与连锁挖掘都在这里列出，「有哪些动作可以绑键」这份清单就是这张表的键。
 * 下面的 `MOVE_ACTIONS` 不是那份清单，它窄一些，只有归入移动意图的那几个。
 *
 * 用 `satisfies` 而不是类型标注：既保证每个移动动作都绑了键（漏一个编译不过），又保住
 * 各个值的字面量类型——`KEY_BINDINGS.chainMining` 因此是 `'AltLeft'` 而不是 `string`。
 */
export const KEY_BINDINGS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  // 连锁挖掘（见 CONTEXT.md 的「连锁键」）：按住它再开始挖掘才连锁。
  chainMining: 'AltLeft',
  // 背包界面（见 CONTEXT.md）：按一下开，再按一下关。
  inventory: 'KeyE',
} as const satisfies Readonly<Record<MoveAction | HoldAction | ToggleAction, string>>;

/**
 * 关掉界面的那颗键：Esc。
 *
 * 与 `KEY_BINDINGS` 分开列，因为它改不动——「Esc 关掉当前界面」是浏览器与操作系统一路
 * 沿用下来的约定，把它摆进设置界面里只会让人以为换得掉。指针锁定期间它由浏览器消费
 * （规范要求 UA 退出锁定，页面既拦不住也收不到），所以它只在界面开着、锁定已经交还的
 * 时候才轮得到我们处理。
 */
export const INVENTORY_CLOSE_KEY = 'Escape';

/**
 * 所有可绑键的移动动作。
 *
 * 取自移动意图的字段而不是键位表的键：键位表里还有连锁挖掘这类不属于移动的动作，
 * 照着它遍历会把连锁键也当成一个移动方向。
 */
export const MOVE_ACTIONS = Object.keys(IDLE_INTENT) as MoveAction[];

/**
 * 鼠标按钮绑定：`MouseEvent.button` 的编号。别处不许再写按钮编号。
 *
 * 与 `KEY_BINDINGS` 分成两张表，因为它们查的是不同的事件字段。挖掘是左键，使用是右键——
 * 「使用」而不是「放置」：对着工作台是打开界面，对着别的方块才是放置（ADR-0009），
 * 哪一种由核心决定。
 */
export const MOUSE_BINDINGS = {
  mine: 0,
  use: 2,
} as const;

/**
 * 快捷栏选格的按键：第 n 格绑数字键 n + 1。
 *
 * 写成算式而不是九行字面量：格数的唯一来源是 `HOTBAR_SIZE`，两边不会对不上。
 * 与 `KEY_BINDINGS` 分成两张表，因为这一组绑的不是动作而是格号。
 */
export const HOTBAR_KEY_CODES: readonly string[] = Array.from(
  { length: HOTBAR_SIZE },
  (_, slot) => `Digit${slot + 1}`,
);

/** 反查：按下的 `code` 对应哪个动作。没绑过的键查不到。 */
export const ACTION_BY_CODE: ReadonlyMap<string, MoveAction> = new Map(
  MOVE_ACTIONS.map((action) => [KEY_BINDINGS[action], action]),
);

/** 反查：按下的 `code` 对应快捷栏的哪一格。没绑过的键查不到。 */
export const HOTBAR_SLOT_BY_CODE: ReadonlyMap<string, number> = new Map(
  HOTBAR_KEY_CODES.map((code, slot) => [code, slot]),
);
