import type { GameCore } from '../core/game';
import { IDLE_INTENT, type MoveIntent } from '../core/player';
import {
  ACTION_BY_CODE,
  HOTBAR_SLOT_BY_CODE,
  KEY_BINDINGS,
  MOUSE_BINDINGS,
  MOVE_ACTIONS,
  type MoveAction,
} from './keybindings';
import { isPointerSpike } from './pointer-spike';

/**
 * 鼠标灵敏度：鼠标每移动一像素，视角转多少弧度。
 * 0.0022 rad/px ≈ 0.13°/px。设置界面（后续切片）会让玩家调它。
 */
export const MOUSE_SENSITIVITY = 0.0022;

/** 输入适配器要用到的核心指令。写成窄接口，接线接错了编译期就报。 */
export type PlayerInputTarget = Pick<
  GameCore,
  | 'setMoveIntent'
  | 'turn'
  | 'setMining'
  | 'setChainMining'
  | 'place'
  | 'selectHotbarSlot'
  | 'scrollHotbar'
>;

/**
 * 输入适配器：把键鼠事件翻译成移动意图、挖掘与放置、快捷栏切换与视角增量交给核心。
 *
 * 这里没有任何游戏逻辑——走多快、跳多高、撞不撞墙、一块方块挖多久、一块方块放得下放不下
 * 全在 `src/core/`。未锁定时按键与鼠标按钮都不生效，因此 Esc 之后玩家不会继续走、
 * 也不会继续挖。
 *
 * **Esc 不在键位表里**：退出指针锁定是浏览器按规范必须做的事，页面既拦不住也换不掉，
 * 所以把 `Escape` 写进可自定义的键位表只会让人误以为它改得动。设置界面（后续切片）
 * 改不到它。
 *
 * 返回卸载函数。
 */
export function installPlayerControls(
  canvas: HTMLCanvasElement,
  target: PlayerInputTarget,
): () => void {
  const pressed = new Set<MoveAction>();
  const locked = (): boolean => document.pointerLockElement === canvas;
  const sendIntent = (): void => target.setMoveIntent(intentOf(pressed));

  // 锁定生效后浏览器会补投一发 mousemove，带的是光标从点击位置归位到画面中心的位移
  // ——那不是玩家转头。不丢掉它，一进第一人称视角就会被甩向一边。
  let dropWarpMove = false;

  // 上一发 mousemove 的时刻，用来算这一发的隐含指针速度。丢掉的那些也要记，
  // 否则下一发会拿一个过时的时刻算出偏小的速度。
  let lastMoveAt = 0;

  const onClick = (): void => {
    // 指针锁定只能由用户手势触发，所以挂在 click 上。
    if (locked()) return;
    // 标记要在这里而不是在 pointerlockchange 里立：那发归位事件比锁定变更事件先到。
    dropWarpMove = true;
    void canvas.requestPointerLock();
  };

  const onLockChange = (): void => {
    if (locked()) return;
    // 释放锁定时清掉按键状态：Esc 之后玩家不该还朝原方向走下去，也不该还在挖。
    pressed.clear();
    sendIntent();
    target.setMining(false);
    // 连锁键也要放掉：Esc 之后它的 keyup 未必还投得到页面上，卡住的话下一次开始挖掘
    // 会莫名其妙地连锁。
    target.setChainMining(false);
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (!locked()) return;
    // 挖掘是持续状态（按住不放一直挖），放置是一次动作（按一次放一块）。
    if (event.button === MOUSE_BINDINGS.mine) target.setMining(true);
    else if (event.button === MOUSE_BINDINGS.place) target.place();
  };

  const onMouseUp = (event: MouseEvent): void => {
    // 松开一律处理，哪怕这期间锁定丢了，否则会一直挖下去。
    if (event.button !== MOUSE_BINDINGS.mine) return;
    target.setMining(false);
  };

  // 锁定期间右键是放置，不该弹出浏览器菜单——菜单一弹就抢走了后面的按键。
  const onContextMenu = (event: MouseEvent): void => {
    if (locked()) event.preventDefault();
  };

  const onWheel = (event: WheelEvent): void => {
    if (!locked()) return;
    // 默认行为是缩放页面，绑过的输入一律拦下。
    event.preventDefault();
    // 滚了多少像素是输入的事，一格一格地走是游戏规则：只把方向交给核心。
    // 往下滚（deltaY 为正）选下一格，与原版一致。
    const delta = Math.sign(event.deltaY);
    if (delta !== 0) target.scrollHotbar(delta);
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (!locked()) return;
    const elapsedMs = event.timeStamp - lastMoveAt;
    lastMoveAt = event.timeStamp;
    if (dropWarpMove) {
      dropWarpMove = false;
      return;
    }
    // 浏览器偶尔会投来手做不到的巨型增量，采了视角就会跳到别处——见 pointer-spike.ts。
    if (isPointerSpike(Math.hypot(event.movementX, event.movementY), elapsedMs)) return;
    // 两个方向都取负：偏航 0 朝 −Z（右手边是 +X，往右转是减），俯仰正为抬头。
    target.turn(-event.movementX * MOUSE_SENSITIVITY, -event.movementY * MOUSE_SENSITIVITY);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!locked()) return;

    // 数字键选快捷栏的一格。按住不放没有额外含义，所以不进 pressed 那套按下/松开的账。
    const slot = HOTBAR_SLOT_BY_CODE.get(event.code);
    if (slot !== undefined) {
      event.preventDefault();
      target.selectHotbarSlot(slot);
      return;
    }

    // 连锁键不进 pressed 那套账：它不是移动意图的一部分，核心那边是独立的一个开关。
    // 按住不放连发的 keydown 反复设同一个值，没有副作用。
    if (event.code === KEY_BINDINGS.chainMining) {
      // Alt 默认会点亮浏览器的菜单栏并抢走后面的按键，绑过的键一律拦下。
      event.preventDefault();
      target.setChainMining(true);
      return;
    }

    const action = ACTION_BY_CODE.get(event.code);
    if (action === undefined) return;
    // 空格默认滚动页面，绑过的键一律拦下。
    event.preventDefault();
    // 按住不放会连发 keydown，意图没变就不必再交给核心。
    if (pressed.has(action)) return;
    pressed.add(action);
    sendIntent();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    // 松键一律处理，哪怕这期间锁定丢了，否则按键会卡住。
    if (event.code === KEY_BINDINGS.chainMining) {
      target.setChainMining(false);
      return;
    }
    const action = ACTION_BY_CODE.get(event.code);
    if (action === undefined || !pressed.delete(action)) return;
    sendIntent();
  };

  canvas.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('mousemove', onMouseMove);
  // 鼠标按钮挂在 document 而不是画布上：锁定期间事件本来就投给锁定的元素，而松开有可能
  // 发生在画布之外，漏掉它按钮就卡住了。
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('contextmenu', onContextMenu);
  // passive: false 才拦得住滚轮的默认行为（浏览器对 wheel 默认是 passive）。
  document.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    canvas.removeEventListener('click', onClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}

/**
 * 按下的动作集合翻译成一份移动意图。
 * 从 `IDLE_INTENT` 展开起手：这样初值就是一份完整的意图，逐个动作覆盖时不需要类型断言，
 * 键位表里加一个动作也不会漏掉字段。
 */
function intentOf(pressed: ReadonlySet<MoveAction>): MoveIntent {
  const intent: Record<MoveAction, boolean> = { ...IDLE_INTENT };
  for (const action of MOVE_ACTIONS) {
    intent[action] = pressed.has(action);
  }
  return intent;
}
