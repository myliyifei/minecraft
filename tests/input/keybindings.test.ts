import { describe, expect, it } from 'vitest';
import { HOTBAR_SIZE } from '../../src/core/inventory';
import {
  DEFAULT_KEY_BINDINGS,
  hotbarAction,
  KEY_ACTIONS,
  KeyBindings,
  keyLabel,
} from '../../src/input/keybindings';

describe('键位表：默认值加当前值', () => {
  it('没改过时每个动作都是默认键', () => {
    const keys = new KeyBindings();
    for (const action of KEY_ACTIONS) expect(keys.codeOf(action)).toBe(DEFAULT_KEY_BINDINGS[action]);
  });

  it('可改的动作：前后左右、跳、背包、连锁挖掘、快捷栏 1 到 9', () => {
    expect(KEY_ACTIONS).toEqual([
      'forward',
      'back',
      'left',
      'right',
      'jump',
      'inventory',
      'chainMining',
      ...Array.from({ length: HOTBAR_SIZE }, (_, slot) => hotbarAction(slot)),
    ]);
  });

  it('重绑之后按新键查得到这个动作，旧键查不到', () => {
    const keys = new KeyBindings();
    const space = keys.codeOf('jump');
    keys.bind('jump', 'KeyJ');
    expect(keys.codeOf('jump')).toBe('KeyJ');
    expect(keys.actionsOf('KeyJ')).toEqual(['jump']);
    expect(keys.actionsOf(space)).toEqual([]);
  });

  it('从保存的当前值构造：给了的取它，没给的取默认', () => {
    const keys = new KeyBindings({ jump: 'KeyJ' });
    expect(keys.codeOf('jump')).toBe('KeyJ');
    expect(keys.codeOf('forward')).toBe(DEFAULT_KEY_BINDINGS.forward);
  });

  it('两个动作同键：两项都算冲突，按那个键两个动作都查得到；其余不算冲突', () => {
    const keys = new KeyBindings();
    keys.bind('jump', keys.codeOf('forward'));
    expect(keys.conflicts('jump')).toBe(true);
    expect(keys.conflicts('forward')).toBe(true);
    expect(keys.conflicts('back')).toBe(false);
    expect(keys.actionsOf(keys.codeOf('forward'))).toEqual(['forward', 'jump']);
  });

  it('冲突解开之后两项都不再算冲突', () => {
    const keys = new KeyBindings();
    const forward = keys.codeOf('forward');
    keys.bind('jump', forward);
    keys.bind('jump', 'KeyJ');
    expect(keys.conflicts('forward')).toBe(false);
    expect(keys.conflicts('jump')).toBe(false);
    expect(keys.actionsOf(forward)).toEqual(['forward']);
  });

  it('默认键位之间没有冲突', () => {
    const keys = new KeyBindings();
    expect(KEY_ACTIONS.filter((action) => keys.conflicts(action))).toEqual([]);
  });

  it('当前值导出成普通对象，改它不影响键位表', () => {
    const keys = new KeyBindings();
    keys.bind('inventory', 'KeyI');
    const record = keys.toRecord();
    expect(record.inventory).toBe('KeyI');
    record.inventory = 'KeyQ';
    expect(keys.codeOf('inventory')).toBe('KeyI');
  });
});

describe('按键显示名', () => {
  it('字母键与数字键只显示那个字符', () => {
    expect(keyLabel(DEFAULT_KEY_BINDINGS.forward)).toBe('W');
    expect(keyLabel(DEFAULT_KEY_BINDINGS[hotbarAction(0)])).toBe('1');
  });

  it('左右两颗的修饰键标出是哪一侧', () => {
    expect(keyLabel(DEFAULT_KEY_BINDINGS.chainMining)).toBe('左 Alt');
  });

  it('认不出的键原样显示它的 code', () => {
    expect(keyLabel('IntlRo')).toBe('IntlRo');
  });
});
