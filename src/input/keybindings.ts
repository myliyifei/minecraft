import { HOTBAR_SIZE } from '../core/inventory';
import { IDLE_INTENT, type MoveIntent } from '../core/player';
import { keyOnSide, STRINGS } from '../ui/strings';

/**
 * 一个可以绑键的移动动作。
 * 名字直接取自核心的移动意图，因此意图里加一个字段，下面那张表不补就编译不过。
 */
export type MoveAction = keyof MoveIntent;

/** 不属于移动意图、但同样按住才生效的动作。目前只有连锁挖掘。 */
export type HoldAction = 'chainMining';

/** 按一下切换一次的动作。目前只有开合背包界面。 */
export type ToggleAction = 'inventory';

/** 选快捷栏的一格：`hotbar1` 是第 0 格，与数字键的写法一致。格数的唯一来源是 `HOTBAR_SIZE`。 */
export type HotbarAction = `hotbar${number}`;

/** 设置界面里可以改键的全部动作（ADR-0020）。挖掘、使用在鼠标上，Esc 固定，都不在这里。 */
export type KeyAction = MoveAction | HoldAction | ToggleAction | HotbarAction;

/** 快捷栏第 `slot` 格（从 0 数）的动作名。 */
export function hotbarAction(slot: number): HotbarAction {
  return `hotbar${slot + 1}`;
}

/**
 * 所有可绑键的移动动作。
 *
 * 取自移动意图的字段而不是键位表的键：键位表里还有连锁挖掘这类不属于移动的动作，
 * 照着它遍历会把连锁键也当成一个移动方向。
 */
export const MOVE_ACTIONS = Object.keys(IDLE_INTENT) as MoveAction[];

/** 快捷栏的九个动作，按格号排。 */
export const HOTBAR_ACTIONS: readonly HotbarAction[] = Array.from({ length: HOTBAR_SIZE }, (_, slot) =>
  hotbarAction(slot),
);

/** 全部可绑键的动作，按设置界面里列出的顺序：移动、背包、连锁挖掘、快捷栏。 */
export const KEY_ACTIONS: readonly KeyAction[] = [...MOVE_ACTIONS, 'inventory', 'chainMining', ...HOTBAR_ACTIONS];

/**
 * 默认键位：动作到 `KeyboardEvent.code`。按键名只写在本文件里，别处要么查这张表，要么查运行时的 `KeyBindings`。
 *
 * 用 `code` 而不是 `key`：`code` 是键的物理位置，与键盘布局无关——AZERTY 上左手那颗
 * 键仍然是 `KeyW`，不会变成 Z。快捷栏第 n 格绑数字键 n + 1，写成算式，格数只来自 `HOTBAR_SIZE`。
 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<KeyAction, string>> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  // 连锁挖掘（见 CONTEXT.md 的「连锁键」）：按住它再开始挖掘才连锁。
  chainMining: 'AltLeft',
  // 背包界面（见 CONTEXT.md）：按一下开，再按一下关。
  inventory: 'KeyE',
  ...Object.fromEntries(HOTBAR_ACTIONS.map((action, slot) => [action, `Digit${slot + 1}`])),
};

/**
 * 关掉界面的那颗键：Esc。
 *
 * 不在 `KEY_ACTIONS` 里，因为它改不动——「Esc 关掉当前界面」是浏览器与操作系统一路
 * 沿用下来的约定，把它摆进设置界面里只会让人以为换得掉。指针锁定期间它由浏览器消费
 * （规范要求 UA 退出锁定，页面既拦不住也收不到），所以它只在界面开着、锁定已经交还的
 * 时候才轮得到我们处理。设置界面等着按键时按它是取消，不绑。
 */
export const INVENTORY_CLOSE_KEY = 'Escape';

/** 输入层与设置界面读键位表的那一面。 */
export interface KeyBindingsView {
  /** 这个动作现在绑的键。 */
  codeOf(action: KeyAction): string;
  /** 绑在这个键上的全部动作，按 `KEY_ACTIONS` 的顺序。两个动作同键时两个都在，按下那个键两个都触发。 */
  actionsOf(code: string): readonly KeyAction[];
  /** 这个动作的键还绑着别的动作。设置界面把这两项都标红，不阻止。 */
  conflicts(action: KeyAction): boolean;
}

const NO_ACTIONS: readonly KeyAction[] = [];

/**
 * 运行时的键位表（ADR-0020）：默认值加当前值。设置界面改它，输入层每次按键查它，改完不必重装监听。
 */
export class KeyBindings implements KeyBindingsView {
  private readonly codes: Record<KeyAction, string>;
  /** 反查：键到绑在它上面的动作。每次改键整张重算，一共十几项。 */
  private byCode = new Map<string, KeyAction[]>();

  /** `current` 是保存过的当前值，缺的取默认。 */
  constructor(current: Readonly<Partial<Record<KeyAction, string>>> = {}) {
    this.codes = { ...DEFAULT_KEY_BINDINGS };
    for (const action of KEY_ACTIONS) {
      const code = current[action];
      if (code !== undefined) this.codes[action] = code;
    }
    this.reindex();
  }

  codeOf(action: KeyAction): string {
    return this.codes[action];
  }

  actionsOf(code: string): readonly KeyAction[] {
    return this.byCode.get(code) ?? NO_ACTIONS;
  }

  conflicts(action: KeyAction): boolean {
    return this.actionsOf(this.codes[action]).length > 1;
  }

  /** 把这个动作改绑到 `code`。同键不阻止，见 `conflicts`。 */
  bind(action: KeyAction, code: string): void {
    this.codes[action] = code;
    this.reindex();
  }

  /** 当前值的一份副本，存进设置用。 */
  toRecord(): Record<KeyAction, string> {
    return { ...this.codes };
  }

  private reindex(): void {
    this.byCode = new Map();
    for (const action of KEY_ACTIONS) {
      const code = this.codes[action];
      const list = this.byCode.get(code);
      if (list) list.push(action);
      else this.byCode.set(code, [action]);
    }
  }
}

/** 字符本身就是显示名的那些键：标点。字母与数字按规则取，不在表里。 */
const PUNCTUATION_LABELS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** 分左右两颗的修饰键在显示名里的写法。 */
const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Shift: 'Shift',
  Control: 'Ctrl',
  Alt: 'Alt',
  Meta: 'Meta',
};

/**
 * 一颗键在设置界面上的显示名（ADR-0020：显示名从键位文件取，设置界面不自己写按键名）。
 * 字母键、数字键只显示那个字符，修饰键标出左右，认不出的键原样显示 `code`。
 */
export function keyLabel(code: string): string {
  if (code === 'Space') return STRINGS.keySpace;
  if (code === INVENTORY_CLOSE_KEY) return 'Esc';
  const letter = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code);
  if (letter) return letter[1]!;
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `${STRINGS.keyNumpad} ${numpad[1]}`;
  const sided = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (sided) return keyOnSide(sided[2] === 'Left' ? 'left' : 'right', MODIFIER_LABELS[sided[1]!]!);
  return PUNCTUATION_LABELS[code] ?? code;
}

/**
 * 鼠标按钮绑定：`MouseEvent.button` 的编号。别处不许再写按钮编号。
 *
 * 与键位表分成两张，因为它们查的是不同的事件字段，而且这一张不能改（ADR-0020）。挖掘是左键，使用是右键——
 * 「使用」而不是「放置」：对着工作台是打开界面，对着别的方块才是放置（ADR-0009），
 * 哪一种由核心决定。
 *
 * 拆堆（背包界面里右键对格子：光标空着拿起半堆，光标有物品放下 1 个）与使用共用同一个
 * 物理按钮，靠界面模式区分：界面关着、指针锁定着时右键是使用，界面开着时落在格子上的右键
 * 是拆堆。两项分开列而不是共用一项，因为它们是两条不同的核心指令。
 */
export const MOUSE_BINDINGS = {
  mine: 0,
  use: 2,
  split: 2,
} as const;

/** 鼠标按钮在设置界面上的显示名。只有左右键有名字，挖掘与使用只用到这两颗。 */
export function mouseButtonLabel(button: number): string {
  if (button === MOUSE_BINDINGS.mine) return STRINGS.mouseLeft;
  if (button === MOUSE_BINDINGS.use) return STRINGS.mouseRight;
  return String(button);
}
