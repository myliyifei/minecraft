import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPlayerControls, MOUSE_SENSITIVITY, type PlayerInputTarget } from '../../src/input/controls';
import { WARP_WINDOW_MS } from '../../src/input/pointer-warp';

/**
 * 输入适配器抓回锁定之后的第一发鼠标移动（#62）。
 *
 * 浏览器里的端到端测试测不到这一条：无头 Chromium 锁定之后不停地补投位移为 0 的 mousemove，第一发总是它。
 * 这里在 Node 里换上最小的 document、window 与画布，事件的时刻由测试给定，按两种浏览器的顺序投递：
 * WSL2 上的 Chrome 在锁定变更事件之前补投一发归位事件，Windows 上的 Edge 不补投。
 */

interface FakeDocument extends EventTarget {
  pointerLockElement: unknown;
  exitPointerLock(): void;
}

let doc: FakeDocument;
let canvas: EventTarget & { requestPointerLock(): Promise<void> };
let turns: Array<[number, number]>;
let controls: ReturnType<typeof installPlayerControls>;
const saved = { document: globalThis.document, window: globalThis.window };

/** 一个时刻为 `at` 的事件，带上给定的字段。 */
function eventAt<T extends object>(type: string, at: number, fields: T = {} as T): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'timeStamp', { value: at });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
  return event;
}

function lockAt(at: number): void {
  doc.pointerLockElement = canvas;
  doc.dispatchEvent(eventAt('pointerlockchange', at));
}

function moveAt(at: number, movementX: number): void {
  doc.dispatchEvent(eventAt('mousemove', at, { movementX, movementY: 0 }));
}

beforeEach(() => {
  doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock(): void {
      doc.pointerLockElement = null;
    },
  });
  canvas = Object.assign(new EventTarget(), { requestPointerLock: () => Promise.resolve() });
  Object.assign(globalThis, { document: doc, window: new EventTarget() });
  turns = [];
  const target = {
    setMoveIntent: () => {},
    turn: (yaw: number, pitch: number) => turns.push([yaw, pitch]),
    setMining: () => {},
    setChainMining: () => {},
    use: () => {},
    selectHotbarSlot: () => {},
    scrollHotbar: () => {},
    toggleInventory: () => {},
    closeAllScreens: () => {},
    uiMode: false,
    health: { dead: false },
  } as unknown as PlayerInputTarget;
  controls = installPlayerControls(canvas as unknown as HTMLCanvasElement, target, { onPause: () => {} });
});

afterEach(() => {
  controls.remove();
  Object.assign(globalThis, saved);
});

describe('抓回锁定之后的第一发鼠标移动', () => {
  it('Windows Edge 的顺序：锁定之后没有归位事件，过一阵玩家往左移 20 像素，视角照常转', () => {
    controls.grabPointer();
    lockAt(1000);
    moveAt(1300, -20);
    expect(turns).toEqual([[20 * MOUSE_SENSITIVITY, -0]]);
  });

  it('WSL2 Chrome 的顺序：归位事件比锁定变更事件先到，丢掉它，之后的照常转', () => {
    controls.grabPointer();
    doc.pointerLockElement = canvas;
    moveAt(999, 400);
    doc.dispatchEvent(eventAt('pointerlockchange', 1000));
    moveAt(1300, -20);
    expect(turns).toEqual([[20 * MOUSE_SENSITIVITY, -0]]);
  });

  it('无头 Chromium 的顺序：锁定变更之后 1 毫秒内到的归位事件丢掉', () => {
    controls.grabPointer();
    lockAt(1000);
    moveAt(1000.4, -640);
    moveAt(1300, -20);
    expect(turns).toEqual([[20 * MOUSE_SENSITIVITY, -0]]);
  });

  it('只丢一发：窗口内连着到的第二发照常转', () => {
    controls.grabPointer();
    lockAt(1000);
    moveAt(1000 + WARP_WINDOW_MS / 2, -5);
    moveAt(1000 + WARP_WINDOW_MS / 2 + 1, -5);
    expect(turns).toHaveLength(1);
  });

  it('关掉界面重新抓回锁定也一样：第二次锁定之后的第一发真实移动照常转', () => {
    controls.grabPointer();
    lockAt(1000);
    moveAt(1300, -20);
    doc.exitPointerLock();
    doc.dispatchEvent(eventAt('pointerlockchange', 2000));
    controls.grabPointer();
    lockAt(3000);
    moveAt(3300, 10);
    expect(turns.map(([yaw]) => yaw)).toEqual([20 * MOUSE_SENSITIVITY, -10 * MOUSE_SENSITIVITY]);
  });
});
