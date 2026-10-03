import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPlayerControls, type PlayerControls, type PlayerInputTarget } from '../../src/input/controls';
import { KEY_BINDINGS } from '../../src/input/keybindings';

/**
 * 暂停（ADR-0019）：不是输入层自己释放的指针锁定一旦丢失就暂停，锁定重新生效才解除。
 *
 * 与 controls-warp.test.ts 一样在 Node 里换上最小的 document、window 与画布。锁定请求的结果由测试决定：
 * `grant` 让上一次请求生效，`deny` 让它被拒。界面模式由测试直接改 `target.uiMode`，模拟核心在下一 tick 开合。
 */

interface FakeDocument extends EventTarget {
  pointerLockElement: unknown;
  visibilityState: 'visible' | 'hidden';
  exitPointerLock(): void;
}

let doc: FakeDocument;
let canvas: EventTarget & { requestPointerLock(): Promise<void> };
let target: {
  -readonly [K in 'uiMode']: boolean;
} & { health: { dead: boolean }; closed: number; toggles: number; mining: boolean[] };
let controls: PlayerControls;
let pauses: number;
/** 最近一次进入暂停时界面开没开着。 */
let uiOpenAtPause: boolean | undefined;
/** 最近一次锁定请求：兑现前由测试调 `grant` 或 `deny`。 */
let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
const saved = { document: globalThis.document, window: globalThis.window };

/** 浏览器让锁定生效：先改 pointerLockElement，再派发锁定变更事件。 */
function grant(): void {
  doc.pointerLockElement = canvas;
  doc.dispatchEvent(new Event('pointerlockchange'));
  pending?.resolve();
  pending = undefined;
}

/** 浏览器拒绝上一次锁定请求（刚用 Esc 退出锁定后的冷却）。 */
async function deny(): Promise<void> {
  pending?.reject(new Error('denied'));
  pending = undefined;
  // 拒绝是经 Promise 送到的，等它的回调跑完。
  await Promise.resolve();
  await Promise.resolve();
}

/** 浏览器自己退出锁定：玩家按 Esc 或切走窗口。 */
function browserExits(): void {
  doc.pointerLockElement = null;
  doc.dispatchEvent(new Event('pointerlockchange'));
}

function press(code: string): void {
  const event = new Event('keydown');
  Object.assign(event, { code, repeat: false });
  (globalThis.window as unknown as EventTarget).dispatchEvent(event);
}

function hide(): void {
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
}

/** 加载画面结束之后玩家点「回到游戏」，锁定生效：开始在世界里玩。 */
function enterGame(): void {
  controls.grabPointer();
  grant();
}

beforeEach(() => {
  doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    visibilityState: 'visible' as const,
    // 与浏览器一样：退出锁定之后异步派发锁定变更事件。测试里同步派发，事件因此比下一 tick 先到。
    exitPointerLock(): void {
      if (doc.pointerLockElement === null) return;
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  canvas = Object.assign(new EventTarget(), {
    requestPointerLock: () =>
      new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      }),
  });
  Object.assign(globalThis, { document: doc, window: new EventTarget() });
  pauses = 0;
  uiOpenAtPause = undefined;
  pending = undefined;
  target = {
    uiMode: false,
    health: { dead: false },
    closed: 0,
    toggles: 0,
    mining: [],
  };
  const input = {
    setMoveIntent: () => {},
    turn: () => {},
    setMining: (on: boolean) => target.mining.push(on),
    setChainMining: () => {},
    use: () => {},
    selectHotbarSlot: () => {},
    scrollHotbar: () => {},
    // 开合在下一 tick 才生效：这里只记次数，uiMode 由测试在「下一 tick」时改。
    toggleInventory: () => target.toggles++,
    // 与核心一样：死亡画面不是能关掉的界面，关掉全部界面之后死了的话仍是界面模式。
    closeAllScreens: () => {
      target.closed++;
      target.uiMode = target.health.dead;
    },
    get uiMode() {
      return target.uiMode;
    },
    get health() {
      return target.health;
    },
  } as unknown as PlayerInputTarget;
  controls = installPlayerControls(canvas as unknown as HTMLCanvasElement, input, {
    onPause: () => {
      pauses++;
      uiOpenAtPause = target.uiMode;
    },
  });
});

afterEach(() => {
  controls.remove();
  Object.assign(globalThis, saved);
});

describe('暂停', () => {
  it('加载画面结束之后处于暂停；点回到游戏、锁定生效才解除', () => {
    expect(controls.paused).toBe(true);
    controls.grabPointer();
    expect(controls.paused).toBe(true);
    grant();
    expect(controls.paused).toBe(false);
  });

  it('锁定丢失且不是输入层自己释放的（按 Esc、切走窗口），暂停一次', () => {
    enterGame();
    browserExits();
    expect(controls.paused).toBe(true);
    expect(pauses).toBe(1);
  });
});

describe('输入层为界面模式释放的锁定不算暂停', () => {
  it('按背包键打开界面：锁定当场释放，事件比下一 tick 先到，界面标志还是假，也不暂停', () => {
    enterGame();
    press(KEY_BINDINGS.inventory);
    expect(target.toggles).toBe(1);
    expect(doc.pointerLockElement).toBe(null);
    expect(target.uiMode).toBe(false);
    expect(controls.paused).toBe(false);
    expect(pauses).toBe(0);
  });

  it('自己释放的记号只管那一次：关掉界面抓回锁定之后再按 Esc，照常暂停', () => {
    enterGame();
    press(KEY_BINDINGS.inventory);
    target.uiMode = true;
    press(KEY_BINDINGS.inventory);
    grant();
    target.uiMode = false;
    browserExits();
    expect(controls.paused).toBe(true);
    expect(pauses).toBe(1);
  });
});

describe('每帧同步释放的锁定不算暂停', () => {
  it('右键对着工作台：界面在下一 tick 打开，这一帧同步时释放，不暂停', () => {
    enterGame();
    target.uiMode = true;
    controls.sync();
    expect(doc.pointerLockElement).toBe(null);
    expect(controls.paused).toBe(false);
    expect(pauses).toBe(0);
  });

  it('死亡：死亡画面在那一 tick 出现，这一帧同步时释放，不暂停', () => {
    enterGame();
    target.health.dead = true;
    target.uiMode = true;
    controls.sync();
    expect(doc.pointerLockElement).toBe(null);
    expect(controls.paused).toBe(false);
  });
});

describe('页面隐藏', () => {
  it('界面开着时切走：界面当场关掉，再暂停', () => {
    enterGame();
    press(KEY_BINDINGS.inventory);
    target.uiMode = true;
    hide();
    expect(target.closed).toBe(1);
    expect(uiOpenAtPause).toBe(false);
    expect(controls.paused).toBe(true);
    expect(pauses).toBe(1);
  });
});

describe('页面隐藏时锁着', () => {
  it('暂停一次，锁定随之交还；浏览器自己再退一次锁定也不暂停第二次', () => {
    enterGame();
    hide();
    expect(controls.paused).toBe(true);
    expect(doc.pointerLockElement).toBe(null);
    browserExits();
    expect(pauses).toBe(1);
  });
});

describe('回到游戏', () => {
  it('锁定请求被拒（Esc 之后的冷却）：仍暂停，并报一次被拒；再点一次、锁定生效，解除暂停、被拒的提示清掉', async () => {
    enterGame();
    browserExits();
    controls.grabPointer();
    await deny();
    expect(controls.paused).toBe(true);
    expect(controls.resumeRejected).toBe(true);
    expect(pauses).toBe(1);
    controls.grabPointer();
    grant();
    expect(controls.paused).toBe(false);
    expect(controls.resumeRejected).toBe(false);
  });

  it('锁定生效时再清一次挖掘：暂停期间收到的按下不带进第一人称', () => {
    enterGame();
    browserExits();
    target.mining.length = 0;
    controls.grabPointer();
    grant();
    expect(target.mining).toEqual([false]);
  });

  it('不在暂停时抓回锁定被拒（关掉背包界面时）：进入暂停', async () => {
    enterGame();
    press(KEY_BINDINGS.inventory);
    target.uiMode = true;
    press(KEY_BINDINGS.inventory);
    await deny();
    expect(controls.paused).toBe(true);
    expect(pauses).toBe(1);
    expect(controls.resumeRejected).toBe(false);
  });
});

describe('死亡画面上暂停', () => {
  it('死后切走再回来：点回到游戏直接解除暂停，不请求锁定，死亡画面上鼠标本来就该交还给页面', () => {
    enterGame();
    target.health.dead = true;
    target.uiMode = true;
    controls.sync();
    hide();
    expect(controls.paused).toBe(true);
    controls.resume();
    expect(pending).toBeUndefined();
    expect(controls.paused).toBe(false);
  });
});

describe('锁定失败经 pointerlockerror 报来', () => {
  it('与 Promise 被拒一样处理，两样都来时只算一次', async () => {
    enterGame();
    browserExits();
    controls.resume();
    doc.dispatchEvent(new Event('pointerlockerror'));
    expect(controls.resumeRejected).toBe(true);
    await deny();
    expect(controls.resumeRejected).toBe(true);
    expect(pauses).toBe(1);
  });

  it('关掉背包界面时抓回被拒、只来了事件：进入暂停一次', async () => {
    enterGame();
    press(KEY_BINDINGS.inventory);
    target.uiMode = true;
    press(KEY_BINDINGS.inventory);
    doc.dispatchEvent(new Event('pointerlockerror'));
    await deny();
    expect(controls.paused).toBe(true);
    expect(pauses).toBe(1);
  });
});
