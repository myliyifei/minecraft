import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MoveIntent } from '../../src/core/player';
import {
  BASE_MOUSE_SENSITIVITY,
  installPlayerControls,
  type InputSettings,
  type PlayerControls,
  type PlayerInputTarget,
} from '../../src/input/controls';
import { DEFAULT_KEY_BINDINGS, hotbarAction, KeyBindings } from '../../src/input/keybindings';

/**
 * 键位在运行时可变（ADR-0020）：输入层每次按键查键位表的当前值，改键之后不必重装监听。灵敏度同理，每次鼠标移动
 * 读当前值。与 controls-warp.test.ts 一样在 Node 里换上最小的 document、window 与画布，锁定由测试直接给。
 */

interface FakeDocument extends EventTarget {
  pointerLockElement: unknown;
  exitPointerLock(): void;
}

let doc: FakeDocument;
let canvas: EventTarget & { requestPointerLock(): Promise<void> };
let win: EventTarget;
let controls: PlayerControls;
let keys: KeyBindings;
let settings: { keys: KeyBindings; sensitivity: number };
/** 交给核心的指令，按顺序记下。 */
let intents: MoveIntent[];
let slots: number[];
let chain: boolean[];
let toggles: number;
let uiMode: boolean;
let turns: Array<[number, number]>;
const saved = { document: globalThis.document, window: globalThis.window };

function key(type: 'keydown' | 'keyup', code: string): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, repeat: false });
  win.dispatchEvent(event);
}

const press = (code: string) => key('keydown', code);
const release = (code: string) => key('keyup', code);

function move(movementX: number, at: number): void {
  const event = new Event('mousemove');
  Object.defineProperty(event, 'timeStamp', { value: at });
  Object.assign(event, { movementX, movementY: 0 });
  doc.dispatchEvent(event);
}

/** 最近一次交给核心的移动意图。 */
const intent = (): MoveIntent | undefined => intents.at(-1);

beforeEach(() => {
  doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock(): void {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  canvas = Object.assign(new EventTarget(), { requestPointerLock: () => Promise.resolve() });
  win = new EventTarget();
  Object.assign(globalThis, { document: doc, window: win });
  intents = [];
  slots = [];
  chain = [];
  toggles = 0;
  uiMode = false;
  turns = [];
  const target = {
    setMoveIntent: (next: MoveIntent) => intents.push(next),
    turn: (yaw: number, pitch: number) => turns.push([yaw, pitch]),
    setMining: () => {},
    setChainMining: (on: boolean) => chain.push(on),
    use: () => {},
    selectHotbarSlot: (slot: number) => slots.push(slot),
    scrollHotbar: () => {},
    toggleInventory: () => toggles++,
    closeAllScreens: () => {},
    get uiMode() {
      return uiMode;
    },
    health: { dead: false },
  } as unknown as PlayerInputTarget;
  keys = new KeyBindings();
  settings = { keys, sensitivity: 100 };
  controls = installPlayerControls(
    canvas as unknown as HTMLCanvasElement,
    target,
    { onPause: () => {} },
    settings satisfies InputSettings,
  );
  // 锁定生效：进入第一人称。锁定的时刻定为 0，之后的鼠标移动都不在归位事件的时间窗里。
  controls.grabPointer();
  doc.pointerLockElement = canvas;
  const locked = new Event('pointerlockchange');
  Object.defineProperty(locked, 'timeStamp', { value: 0 });
  doc.dispatchEvent(locked);
  // 锁定生效时输入层放掉一遍按键与连锁键，这几次调用不计入下面的断言。
  intents = [];
  chain = [];
});

afterEach(() => {
  controls.remove();
  Object.assign(globalThis, saved);
});

describe('重绑之后按新键触发、旧键不触发', () => {
  it('跳跃改到 J：按 J 跳，松开 J 停；按空格不跳', () => {
    keys.bind('jump', 'KeyJ');
    press(DEFAULT_KEY_BINDINGS.jump);
    expect(intents).toEqual([]);
    press('KeyJ');
    expect(intent()?.jump).toBe(true);
    release('KeyJ');
    expect(intent()?.jump).toBe(false);
  });

  it('背包改到 I：按 I 开背包界面，按 E 不开', () => {
    keys.bind('inventory', 'KeyI');
    press(DEFAULT_KEY_BINDINGS.inventory);
    expect(toggles).toBe(0);
    press('KeyI');
    expect(toggles).toBe(1);
  });

  it('快捷栏第 1 格改到 Q：按 Q 选第 0 格，按 1 不选', () => {
    keys.bind(hotbarAction(0), 'KeyQ');
    press(DEFAULT_KEY_BINDINGS[hotbarAction(0)]);
    press('KeyQ');
    expect(slots).toEqual([0]);
  });

  it('连锁挖掘改到 C：按住 C 开、松开关；按左 Alt 没反应', () => {
    keys.bind('chainMining', 'KeyC');
    press(DEFAULT_KEY_BINDINGS.chainMining);
    release(DEFAULT_KEY_BINDINGS.chainMining);
    expect(chain).toEqual([]);
    press('KeyC');
    release('KeyC');
    expect(chain).toEqual([true, false]);
  });

  it('两个动作同键：按那个键两个都触发', () => {
    keys.bind('jump', DEFAULT_KEY_BINDINGS.forward);
    press(DEFAULT_KEY_BINDINGS.forward);
    expect(intent()).toMatchObject({ forward: true, jump: true });
    release(DEFAULT_KEY_BINDINGS.forward);
    expect(intent()).toMatchObject({ forward: false, jump: false });
  });

  it('同键的两个动作一个是快捷栏格：选格与移动都生效', () => {
    keys.bind(hotbarAction(4), DEFAULT_KEY_BINDINGS.forward);
    press(DEFAULT_KEY_BINDINGS.forward);
    expect(slots).toEqual([4]);
    expect(intent()?.forward).toBe(true);
  });
});

describe('背包键与别的动作同键', () => {
  /** 按下一颗键，可以是浏览器补发的连发。 */
  function pressRepeat(code: string): void {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { code, repeat: true });
    win.dispatchEvent(event);
  }

  it('锁定着按它：开背包界面，同键的选格也生效', () => {
    keys.bind(hotbarAction(8), DEFAULT_KEY_BINDINGS.inventory);
    press(DEFAULT_KEY_BINDINGS.inventory);
    expect(toggles).toBe(1);
    expect(slots).toEqual([8]);
  });

  it('界面开着、锁定交还之后按它：关界面，同键的选格也生效；按住连发不再开合，选格照常', () => {
    keys.bind(hotbarAction(8), DEFAULT_KEY_BINDINGS.inventory);
    // 右键对着工作台：界面在下一 tick 打开，每帧同步时交还锁定
    uiMode = true;
    controls.sync();
    expect(doc.pointerLockElement).toBe(null);
    // 抓回锁定的请求发出了，但还没生效
    press(DEFAULT_KEY_BINDINGS.inventory);
    pressRepeat(DEFAULT_KEY_BINDINGS.inventory);
    expect(toggles).toBe(1);
    expect(slots).toEqual([8, 8]);
  });
});

describe('灵敏度', () => {
  it('100% 时每像素转 BASE_MOUSE_SENSITIVITY；改成 200% 之后下一发就转两倍，不必重装', () => {
    move(-10, 1000);
    settings.sensitivity = 200;
    move(-10, 1100);
    expect(turns.map(([yaw]) => yaw)).toEqual([10 * BASE_MOUSE_SENSITIVITY, 20 * BASE_MOUSE_SENSITIVITY]);
  });
});
