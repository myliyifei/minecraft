import type { GameCore } from '../core/game';
import { IDLE_INTENT, type MoveIntent } from '../core/player';
import {
  ACTION_BY_CODE,
  HOTBAR_SLOT_BY_CODE,
  INVENTORY_CLOSE_KEY,
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

/**
 * 输入适配器要用到的核心指令，加一样查询：界面模式开着没有。
 * 写成窄接口，接线接错了编译期就报。
 */
export type PlayerInputTarget = Pick<
  GameCore,
  | 'setMoveIntent'
  | 'turn'
  | 'setMining'
  | 'setChainMining'
  | 'use'
  | 'selectHotbarSlot'
  | 'scrollHotbar'
  | 'toggleInventory'
  | 'uiMode'
>;

/**
 * 输入适配器：把键鼠事件翻译成移动意图、挖掘与使用、快捷栏切换与视角增量交给核心。
 *
 * 这里没有任何游戏逻辑——走多快、跳多高、撞不撞墙、一块方块挖多久、一块方块放得下放不下、
 * 右键这一下是开界面还是放方块，全在 `src/core/`。未锁定时按键与鼠标按钮都不生效，
 * 因此 Esc 之后玩家不会继续走、也不会继续挖。
 *
 * 背包键是唯一在未锁定时也认的键，条件是界面正开着（界面模式，见 CONTEXT.md）：那时
 * 鼠标已经交还给页面，玩家得有办法把界面关掉。界面开着时其余按键一概不算数——「哪些
 * 输入在界面模式下作废」这条规则本身在核心里（`GameCore.step`），这里只是不再把它们
 * 递过去。
 *
 * **Esc 不在可自定义的键位表里**：指针锁定期间它由浏览器消费（规范要求 UA 退出锁定，
 * 页面既拦不住也收不到）；界面模式下锁定已经交还，它才轮得到页面处理。两种情形下它都
 * 换不掉，所以它是 `INVENTORY_CLOSE_KEY` 这个单独的常量，不在 `KEY_BINDINGS` 里——
 * 设置界面（后续切片）改不到它。
 *
 * 返回的句柄要每帧 `sync()`：界面可能不是由这里的按键打开的——右键对着工作台，界面在
 * 下一个 tick 由核心打开——那时鼠标还锁着，得释放给页面。
 */
export interface PlayerControls {
  /** 让指针锁定跟上核心：有界面开着而鼠标还锁着，就释放。每帧调一次。 */
  sync(): void;
  /** 卸下全部监听器。 */
  remove(): void;
}

export function installPlayerControls(
  canvas: HTMLCanvasElement,
  target: PlayerInputTarget,
): PlayerControls {
  const pressed = new Set<MoveAction>();
  const locked = (): boolean => document.pointerLockElement === canvas;
  // 界面模式（见 CONTEXT.md）：背包界面或工作台界面开着。这时鼠标已经交还给页面，
  // 键盘只认关掉界面那两颗键。
  const uiOpen = (): boolean => target.uiMode;
  const sendIntent = (): void => target.setMoveIntent(intentOf(pressed));

  // 锁定生效后浏览器会补投一发 mousemove，带的是光标从点击位置归位到画面中心的位移
  // ——那不是玩家转头。不丢掉它，一进第一人称视角就会被甩向一边。
  let dropWarpMove = false;

  // 上一发 mousemove 的时刻，用来算这一发的隐含指针速度。丢掉的那些也要记，
  // 否则下一发会拿一个过时的时刻算出偏小的速度。
  let lastMoveAt = 0;

  /**
   * 抓回指针锁定：进第一人称，网页鼠标随即消失。
   *
   * 两处入口都走这里——点画布，以及关掉背包界面。合成一个函数是因为锁定生效后浏览器会
   * 补投一发光标归位的 mousemove（见 `dropWarpMove`），漏掉那一发视角就会被甩一下。
   *
   * 请求可能被浏览器拒：它只在用户手势里放行。拒了就退回「玩家点一下画面」，但那个
   * rejection 必须接住，否则会变成控制台里一条未处理的错误。
   */
  const grabPointer = (): void => {
    // 标记要在这里而不是在 pointerlockchange 里立：那发归位事件比锁定变更事件先到。
    dropWarpMove = true;
    // 老浏览器这个方法返回 void，新的返回 Promise，所以先收成 unknown 再认。
    const request: unknown = canvas.requestPointerLock();
    if (request instanceof Promise) {
      request.catch(() => {
        // 没锁上，那发归位事件也就不会来。
        dropWarpMove = false;
      });
    }
  };

  const onClick = (): void => {
    // 指针锁定只能由用户手势触发，所以挂在 click 上。
    if (locked()) return;
    // 界面开着时鼠标是用来点格子的，不能把它抓回第一人称。
    if (uiOpen()) return;
    grabPointer();
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
    // 挖掘是持续状态（按住不放一直挖），使用是一次动作（按一次放一块或开一次界面）。
    if (event.button === MOUSE_BINDINGS.mine) target.setMining(true);
    else if (event.button === MOUSE_BINDINGS.use) target.use();
  };

  const onMouseUp = (event: MouseEvent): void => {
    // 松开一律处理，哪怕这期间锁定丢了，否则会一直挖下去。
    if (event.button !== MOUSE_BINDINGS.mine) return;
    target.setMining(false);
  };

  // 锁定期间右键是使用，不该弹出浏览器菜单——菜单一弹就抢走了后面的按键。
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
    // 背包键两头都要认：锁定着的时候按它开背包界面，有界面开着（背包或工作台）的时候
    // 按它关那个界面。开哪个、关哪个由核心定，这里只认「现在有没有界面开着」。
    if (event.code === KEY_BINDINGS.inventory && (locked() || uiOpen())) {
      event.preventDefault();
      // 按住不放时浏览器每几十毫秒补发一次 keydown。开合是切换型动作，连发会让界面
      // 每个 tick 开一次关一次；移动、连锁键那些「按下就设成同一个值」的动作幂等，
      // 所以只有切换型的这两处要挡。
      if (event.repeat) return;
      // 现在有界面开着就说明这一下是关它。开合下一个 tick 才生效，方向得在这里判。
      const closing = uiOpen();
      target.toggleInventory();
      // 打开就把鼠标交还给页面，玩家拿它点格子；关上就抓回来，玩家不必再点一下画面。
      // 释放锁定顺带清掉按住的键与挖掘状态（见 onLockChange），所以这里不必再清一遍。
      if (closing) grabPointer();
      else document.exitPointerLock();
      return;
    }

    // 界面开着时 Esc 关掉它。指针锁定期间这颗键收不到——那时浏览器自己用它退出锁定。
    if (uiOpen() && event.code === INVENTORY_CLOSE_KEY) {
      // 同样要挡连发，理由见上。
      if (event.repeat) return;
      target.toggleInventory();
      // 与按背包键关界面一样把鼠标抓回来。浏览器可能拒——Esc 是它自己的「逃脱手势」，
      // 刚用它退出过锁定的话会有一段冷却。拒了就退回「玩家点一下画面」。
      grabPointer();
      return;
    }

    // 未锁定时其余按键一概不算数。界面开着的时候锁定已经交还，所以摆物品期间按 W
    // 不会移动——不过让它作废的是这一条，而「界面模式下哪些输入作废」那条规则在核心里
    // （`GameCore.step`）：即便这里漏过去了，核心那一侧也不会照着走。
    if (!locked()) return;

    // 数字键选快捷栏的一格。按住不放没有额外含义，所以不记入 pressed 的按下/松开状态。
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

  // 上一帧看到的是有界面开着还是没有。只在「从没有到有」那一帧释放锁定。
  let shownUiOpen = false;

  return {
    sync(): void {
      // 右键对着工作台打开的界面：开合在核心那一侧的 tick 里发生，这里在下一帧看到它开了
      // 才把鼠标交还给页面。按背包键开的界面在 onKeyDown 里当场就释放了，这一帧看到的是
      // 已经释放的状态，再释放一次没有效果。释放不需要用户手势，所以可以放在每帧的同步里；
      // 抓回来（关界面）需要，所以仍留在按键处理里。
      //
      // 只在打开那一帧判，不能每帧判「开着且锁着就释放」：按背包键关界面时锁定请求当场
      // 发出，而界面要到下一个 tick 才关——锁定先到位的话，每帧判会把刚抓回来的锁定又
      // 放掉，之后就没有手势再抓它了。
      const open = uiOpen();
      if (open && !shownUiOpen && locked()) document.exitPointerLock();
      shownUiOpen = open;
    },
    remove(): void {
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
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
