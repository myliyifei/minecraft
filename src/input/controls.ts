import type { GameCore } from '../core/game';
import { IDLE_INTENT, type MoveIntent } from '../core/player';
import { ACTION_BY_CODE, MOVE_ACTIONS, type MoveAction } from './keybindings';
import { isPointerSpike } from './pointer-spike';

/**
 * 鼠标灵敏度：鼠标每移动一像素，视角转多少弧度。
 * 0.0022 rad/px ≈ 0.13°/px。设置界面（后续切片）会让玩家调它。
 */
export const MOUSE_SENSITIVITY = 0.0022;

/** 输入适配器要用到的核心指令。写成窄接口，接线接错了编译期就报。 */
export type PlayerInputTarget = Pick<GameCore, 'setMoveIntent' | 'turn'>;

/**
 * 输入适配器：把键鼠事件翻译成移动意图与视角增量交给核心。
 *
 * 这里没有任何游戏逻辑——走多快、跳多高、撞不撞墙全在 `src/core/player.ts`。
 * 未锁定时按键不生效，因此 Esc 之后玩家不会继续走。
 *
 * **Esc 不在键位表里**：退出指针锁定是浏览器按规范必须做的事，页面既拦不住也换不掉，
 * 所以把 `Escape` 写进可自定义的键位表反而是撒谎。设置界面（后续切片）改不到它。
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
    // 释放锁定时清掉按键状态：Esc 之后玩家不该还朝原方向走下去。
    pressed.clear();
    sendIntent();
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
    const action = ACTION_BY_CODE.get(event.code);
    if (action === undefined || !locked()) return;
    // 空格默认滚动页面，绑过的键一律吃掉。
    event.preventDefault();
    // 按住不放会连发 keydown，意图没变就不必再交给核心。
    if (pressed.has(action)) return;
    pressed.add(action);
    sendIntent();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    const action = ACTION_BY_CODE.get(event.code);
    // 松键一律处理，哪怕这期间锁定丢了，否则按键会卡住。
    if (action === undefined || !pressed.delete(action)) return;
    sendIntent();
  };

  canvas.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    canvas.removeEventListener('click', onClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('mousemove', onMouseMove);
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
