import { DEFAULT_VIEW_RADIUS } from './core/constants';
import {
  INVENTORY_CLOSE_KEY,
  KEY_ACTIONS,
  KeyBindings,
  type KeyAction,
  type KeyBindingsView,
} from './input/keybindings';

/** 视距滑条的范围（区块数，见 GLOSSARY.md「视距」）。 */
export const VIEW_RADIUS_RANGE = { min: 4, max: 16 } as const;

/**
 * 灵敏度滑条的范围：相对默认转速的百分比，100 就是 `BASE_MOUSE_SENSITIVITY`。存百分比而不是每像素的弧度：
 * 滑条与存进 localStorage 的都是整数，读数直接显示。范围 10% 到 300%。
 */
export const SENSITIVITY_RANGE = { min: 10, max: 300, step: 5 } as const;

/** 三个画面开关在设置里的名字。渲染层读它们，设置界面为每个放一个复选框。 */
export type DisplayToggle = 'smoothLighting' | 'flicker' | 'particles';

/** 设置里除键位之外的几项（见 GLOSSARY.md「设置」）。 */
export interface SettingValues extends Readonly<Record<DisplayToggle, boolean>> {
  /** 视距（区块数），`VIEW_RADIUS_RANGE` 之内。 */
  readonly viewRadius: number;
  /** 灵敏度（百分比），`SENSITIVITY_RANGE` 之内。 */
  readonly sensitivity: number;
  /** 平滑光照：关掉时方块表面的顶点直接取相邻格的光照，不取 4 格的平均。 */
  readonly smoothLighting: boolean;
  /** 闪烁：关掉时闪烁量为 0，火光不再起伏。 */
  readonly flicker: boolean;
  /** 粒子：关掉时不再生成新粒子，已有的照常消失。 */
  readonly particles: boolean;
  /**
   * 自动跳跃（见 GLOSSARY.md）。不是画面开关（不在 `DisplayToggle` 里）：它是核心的属性，接线层构造核心时传入、
   * 改动时经订阅调 `GameCore.setAutoJump`（ADR-0020）。设置界面上与三个画面开关并列。
   */
  readonly autoJump: boolean;
}

export const DEFAULT_SETTINGS: SettingValues = {
  viewRadius: DEFAULT_VIEW_RADIUS,
  sensitivity: 100,
  smoothLighting: true,
  flicker: true,
  particles: true,
  autoJump: true,
};

/** 设置在 localStorage 里的键：一条 JSON（ADR-0020）。 */
export const SETTINGS_KEY = 'voxel.settings';

/** 设置读写 localStorage 用到的两个方法。测试换成内存里的。 */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 存进 localStorage 的那条 JSON 的形状。 */
interface StoredSettings extends SettingValues {
  readonly keys: Record<KeyAction, string>;
}

/** 每一项的合法取值。读的时候不合法的那一项取默认，改的时候不合法就拒绝。 */
const VALID: { readonly [K in keyof SettingValues]: (value: unknown) => boolean } = {
  viewRadius: (value) => integerIn(value, VIEW_RADIUS_RANGE),
  sensitivity: (value) => integerIn(value, SENSITIVITY_RANGE),
  smoothLighting: (value) => typeof value === 'boolean',
  flicker: (value) => typeof value === 'boolean',
  particles: (value) => typeof value === 'boolean',
  autoJump: (value) => typeof value === 'boolean',
};

function integerIn(value: unknown, { min, max }: { readonly min: number; readonly max: number }): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/**
 * 能不能绑到一个动作上：形如 `KeyboardEvent.code` 的串（大写字母开头、只有字母与数字），Esc 除外（固定用于
 * 关闭界面）。localStorage 里被改坏的值因此不会取代默认键、让那个动作再也按不出来。
 */
export function bindableCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(value) && value !== INVENTORY_CLOSE_KEY;
}

/** 读出来的 JSON 里的一个对象，不是对象时是空对象。 */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 解析存着的那条 JSON：坏了就当没有，逐项判断，不合法的那一项取默认。 */
function parse(text: string | null): { values: SettingValues; keys: Partial<Record<KeyAction, string>> } {
  let raw: unknown;
  try {
    raw = text === null ? {} : JSON.parse(text);
  } catch {
    raw = {};
  }
  const stored = objectOf(raw);
  const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [name, valid] of Object.entries(VALID)) {
    if (valid(stored[name])) values[name] = stored[name];
  }
  const storedKeys = objectOf(stored.keys);
  const keys: Partial<Record<KeyAction, string>> = {};
  for (const action of KEY_ACTIONS) {
    const code = storedKeys[action];
    if (bindableCode(code)) keys[action] = code;
  }
  return { values: values as unknown as SettingValues, keys };
}

/**
 * 设置（ADR-0020）：全局一份，存 localStorage 的一条 JSON，不进存档。页面打开时读一次，之后每改一项就整条重写。
 *
 * 输入层、渲染层与接线层读这里的当前值；要在改动那一刻做事的（视距改小当场卸载区块）订阅 `subscribe`。
 * localStorage 读不了时全取默认，写不进时改动照样生效，只是下次打开页面不在。
 */
export class Settings implements SettingValues {
  private values: SettingValues;
  private readonly bindings: KeyBindings;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: SettingsStorage | undefined) {
    let text: string | null = null;
    try {
      text = storage?.getItem(SETTINGS_KEY) ?? null;
    } catch (error) {
      console.warn('读不了设置，全取默认', error);
    }
    const { values, keys } = parse(text);
    this.values = values;
    this.bindings = new KeyBindings(keys);
  }

  /** 键位表的当前值。改键走 `bindKey`，那里同时写 localStorage。 */
  get keys(): KeyBindingsView {
    return this.bindings;
  }

  get viewRadius(): number {
    return this.values.viewRadius;
  }

  get sensitivity(): number {
    return this.values.sensitivity;
  }

  get smoothLighting(): boolean {
    return this.values.smoothLighting;
  }

  get flicker(): boolean {
    return this.values.flicker;
  }

  get particles(): boolean {
    return this.values.particles;
  }

  get autoJump(): boolean {
    return this.values.autoJump;
  }

  /** 改几项。有一项不合法就整个拒绝、什么都不改（`RangeError`）：取值范围由设置界面的控件保证。 */
  set(patch: Partial<SettingValues>): void {
    for (const [name, value] of Object.entries(patch)) {
      if (!VALID[name as keyof SettingValues](value)) throw new RangeError(`设置 ${name} 不接受 ${String(value)}`);
    }
    this.values = { ...this.values, ...patch };
    this.changed();
  }

  /** 把一个动作改绑到 `code`。Esc 与不像 `KeyboardEvent.code` 的串不接受（`RangeError`）；与别的动作同键不阻止，见 `KeyBindingsView.conflicts`。 */
  bindKey(action: KeyAction, code: string): void {
    if (!bindableCode(code)) throw new RangeError(`不能绑到 ${code}`);
    this.bindings.bind(action, code);
    this.changed();
  }

  /** 每次改动之后调 `listener`。返回退订的函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const stored: StoredSettings = { ...this.values, keys: this.bindings.toRecord() };
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(stored));
    } catch (error) {
      console.warn('设置没能写进 localStorage', error);
    }
    for (const listener of this.listeners) listener();
  }
}

/** 页面打开时读设置。localStorage 这个属性本身就可能抛错（隐私模式下禁用存储），抛错时不存。 */
export function loadSettings(): Settings {
  let storage: SettingsStorage | undefined;
  try {
    storage = window.localStorage;
  } catch (error) {
    console.warn('localStorage 不可用，设置不会保存', error);
  }
  return new Settings(storage);
}
