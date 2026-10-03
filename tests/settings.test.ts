import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_RADIUS } from '../src/core/constants';
import { DEFAULT_KEY_BINDINGS, INVENTORY_CLOSE_KEY, KEY_ACTIONS } from '../src/input/keybindings';
import {
  DEFAULT_SETTINGS,
  SENSITIVITY_RANGE,
  Settings,
  SETTINGS_KEY,
  VIEW_RADIUS_RANGE,
  type SettingsStorage,
} from '../src/settings';

/** 内存里的 localStorage：只有设置用到的两个方法，另外记下写了几次。 */
function memoryStorage(initial?: string): SettingsStorage & { writes: number; text(): string | null } {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(SETTINGS_KEY, initial);
  return {
    writes: 0,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      this.writes++;
      items.set(key, value);
    },
    text: () => items.get(SETTINGS_KEY) ?? null,
  };
}

/** 设置里除键位之外的几项，读成普通对象好比较。 */
function valuesOf(settings: Settings) {
  const { viewRadius, sensitivity, smoothLighting, flicker, particles } = settings;
  return { viewRadius, sensitivity, smoothLighting, flicker, particles };
}

describe('缺省值', () => {
  it('localStorage 里没有设置：全取默认，默认视距与核心的一致', () => {
    const settings = new Settings(memoryStorage());
    expect(valuesOf(settings)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.viewRadius).toBe(DEFAULT_VIEW_RADIUS);
    for (const action of KEY_ACTIONS) expect(settings.keys.codeOf(action)).toBe(DEFAULT_KEY_BINDINGS[action]);
  });

  it('只读不写：打开页面不写 localStorage', () => {
    const storage = memoryStorage();
    new Settings(storage);
    expect(storage.writes).toBe(0);
  });

  it('存的不是 JSON 或不是对象：全取默认', () => {
    for (const text of ['{', '42', 'null', '[]']) {
      expect(valuesOf(new Settings(memoryStorage(text)))).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('逐项判断：错的那一项取默认，别的照读', () => {
    const settings = new Settings(
      memoryStorage(
        JSON.stringify({
          viewRadius: 99,
          sensitivity: 150,
          smoothLighting: 'no',
          flicker: false,
          particles: 0,
          keys: { jump: 'KeyJ', forward: 7, inventory: INVENTORY_CLOSE_KEY, back: '', left: 'x y' },
        }),
      ),
    );
    expect(valuesOf(settings)).toEqual({ ...DEFAULT_SETTINGS, sensitivity: 150, flicker: false });
    expect(settings.keys.codeOf('jump')).toBe('KeyJ');
    // 数不是键名、Esc 固定不能绑、空串与「x y」不像 KeyboardEvent.code：四项都取默认
    expect(settings.keys.codeOf('forward')).toBe(DEFAULT_KEY_BINDINGS.forward);
    expect(settings.keys.codeOf('left')).toBe(DEFAULT_KEY_BINDINGS.left);
    expect(settings.keys.codeOf('inventory')).toBe(DEFAULT_KEY_BINDINGS.inventory);
    expect(settings.keys.codeOf('back')).toBe(DEFAULT_KEY_BINDINGS.back);
  });

  it('视距与灵敏度要是范围内的整数', () => {
    const read = (viewRadius: unknown, sensitivity: unknown) =>
      valuesOf(new Settings(memoryStorage(JSON.stringify({ viewRadius, sensitivity }))));
    expect(read(VIEW_RADIUS_RANGE.min, SENSITIVITY_RANGE.max)).toMatchObject({
      viewRadius: VIEW_RADIUS_RANGE.min,
      sensitivity: SENSITIVITY_RANGE.max,
    });
    expect(read(VIEW_RADIUS_RANGE.min - 1, SENSITIVITY_RANGE.max + 1)).toMatchObject({
      viewRadius: DEFAULT_SETTINGS.viewRadius,
      sensitivity: DEFAULT_SETTINGS.sensitivity,
    });
    expect(read(6.5, '100')).toMatchObject({
      viewRadius: DEFAULT_SETTINGS.viewRadius,
      sensitivity: DEFAULT_SETTINGS.sensitivity,
    });
  });
});

describe('读写往返', () => {
  it('改动即写；用同一份 localStorage 再打开，读回来的与改过的一样', () => {
    const storage = memoryStorage();
    const settings = new Settings(storage);
    settings.set({ viewRadius: 4, sensitivity: 55, smoothLighting: false });
    settings.set({ flicker: false, particles: false });
    settings.bindKey('jump', 'KeyJ');
    expect(storage.writes).toBe(3);

    const reopened = new Settings(storage);
    expect(valuesOf(reopened)).toEqual({
      viewRadius: 4,
      sensitivity: 55,
      smoothLighting: false,
      flicker: false,
      particles: false,
    });
    expect(reopened.keys.codeOf('jump')).toBe('KeyJ');
  });

  it('改成范围外的值时拒绝，什么都不写', () => {
    const storage = memoryStorage();
    const settings = new Settings(storage);
    expect(() => settings.set({ viewRadius: VIEW_RADIUS_RANGE.max + 1 })).toThrow(RangeError);
    expect(() => settings.bindKey('jump', INVENTORY_CLOSE_KEY)).toThrow(RangeError);
    expect(storage.writes).toBe(0);
    expect(settings.viewRadius).toBe(DEFAULT_SETTINGS.viewRadius);
  });

  it('写不进去（存储空间满、被浏览器禁用）：改动照样生效，只是下次打开页面不在', () => {
    const settings = new Settings({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    settings.set({ viewRadius: 5 });
    expect(settings.viewRadius).toBe(5);
  });

  it('没有 localStorage 可用（读就抛错）：全取默认', () => {
    const settings = new Settings({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {},
    });
    expect(valuesOf(settings)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('改动的通知', () => {
  it('每次改动之后通知订阅者；退订之后不再通知', () => {
    const settings = new Settings(memoryStorage());
    let calls = 0;
    const off = settings.subscribe(() => calls++);
    settings.set({ viewRadius: 6 });
    settings.bindKey('jump', 'KeyJ');
    off();
    settings.set({ viewRadius: 7 });
    expect(calls).toBe(2);
  });
});
