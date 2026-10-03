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
import { isPointerWarp } from './pointer-warp';

/**
 * 鼠标灵敏度：鼠标每移动一像素，视角转多少弧度。
 * 0.0022 rad/px ≈ 0.13°/px。设置界面（后续切片）会让玩家调它。
 */
export const MOUSE_SENSITIVITY = 0.0022;

/**
 * 输入适配器要用到的核心指令，加两样查询：界面模式开着没有，与死了没有。
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
  | 'closeAllScreens'
  | 'uiMode'
  | 'health'
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
 * 死亡画面也是界面模式，但键盘一概不认，背包键与 Esc 也不例外：它们关不掉死亡画面，
 * 照常处理的话还会把指针锁定抓回来。离开死亡画面只有重生按钮一条路，按钮在界面层，
 * 按下之后由接线层调这里的 `grabPointer`。
 *
 * 返回的句柄要每帧 `sync()`：界面可能不是由这里的按键打开的——右键对着工作台，界面在
 * 下一个 tick 由核心打开；生命归零，死亡画面在那一 tick 出现——那时鼠标还锁着，得释放给页面。
 */
export interface PlayerControls {
  /** 让指针锁定跟上核心：有界面开着而鼠标还锁着，就释放。每帧调一次。 */
  sync(): void;
  /**
   * 抓回指针锁定，进第一人称。必须在用户手势（点击、按键）的处理函数里同步调，否则浏览器会拒。
   * 死亡画面的重生按钮走这里，与关掉背包界面时抓回锁定是同一条路。
   */
  grabPointer(): void;
  /**
   * 暂停菜单的「回到游戏」，在按钮的 click 里同步调。平时就是 `grabPointer`，暂停在锁定生效时才解除。死亡画面
   * 开着时例外：那时鼠标本来就该交还给页面，当场解除暂停，不请求锁定（请求了也会在同一帧被每帧同步放掉）。
   * 暂停时开着的界面只可能是死亡画面，别的在进入暂停时已经关掉。
   */
  resume(): void;
  /**
   * 此刻是否处于暂停（见 CONTEXT.md「暂停」）。装上时就是暂停：加载画面结束之后玩家点「回到游戏」才进入
   * 第一人称。锁定真正生效时解除。游戏循环按它决定推不推进 tick。
   */
  readonly paused: boolean;
  /** 暂停时点「回到游戏」请求的锁定被浏览器拒了（刚用 Esc 退出锁定后的冷却）。锁定生效时变回假。 */
  readonly resumeRejected: boolean;
  /** 卸下全部监听器。 */
  remove(): void;
}

/** 暂停状态变化时交给接线层的事。 */
export interface PauseHooks {
  /** 进入暂停的那一刻调一次：接线层在这里写盘。装上时的那一次暂停不调，进入世界时接线层自己写。 */
  readonly onPause: () => void;
}

export function installPlayerControls(
  canvas: HTMLCanvasElement,
  target: PlayerInputTarget,
  hooks: PauseHooks,
): PlayerControls {
  const pressed = new Set<MoveAction>();
  const locked = (): boolean => document.pointerLockElement === canvas;
  // 界面模式（见 CONTEXT.md）：背包界面、工作台界面或熔炉界面开着，或者在死亡画面上。这时鼠标
  // 已经交还给页面，键盘只认关掉界面那两颗键（死亡画面上连这两颗也不认）。
  const uiOpen = (): boolean => target.uiMode;
  const sendIntent = (): void => target.setMoveIntent(intentOf(pressed));

  // 有的浏览器在锁定生效后会补投一发 mousemove，带的是光标从点击位置归位到画面中心的位移
  // ——那不是玩家转头。不丢掉它，一进第一人称视角就会被甩向一边。抓回锁定之后锁定期间的第一发
  // 由 isPointerWarp 认是不是它；`lockedAt` 是这次锁定的 pointerlockchange 的时间戳，还没收到时是 undefined。
  let dropWarpMove = false;
  let lockedAt: number | undefined;

  // 上一发 mousemove 的时刻，用来算这一发的隐含指针速度。丢掉的那些也要记，
  // 否则下一发会拿一个过时的时刻算出偏小的速度。
  let lastMoveAt = 0;

  // 暂停（ADR-0019）。装上时就是暂停，理由见 `PlayerControls.paused`。
  let paused = true;
  // 「这次锁定是自己释放的」：输入层为界面模式调 exitPointerLock 之前立起，锁定变更事件到达时清除。判据不读
  // 核心的界面标志：按背包键时开合下一 tick 才生效，锁定当即释放，事件到达时界面标志多半还是假。
  let releasing = false;
  // 暂停菜单上「回到游戏」的锁定请求被浏览器拒了，菜单提示再点一次。锁定生效时清掉。
  let resumeRejected = false;
  // 有一次锁定请求还没有结果。失败可能经 Promise 被拒与 pointerlockerror 两条路各报一次，只处理第一次。
  let grabPending = false;

  /**
   * 抓回指针锁定：进第一人称，网页鼠标随即消失。
   *
   * 四处入口都走这里——暂停菜单的回到游戏、点画布、关掉背包界面、按死亡画面的重生按钮。合成一个函数是因为
   * 锁定生效后有的浏览器会补投一发光标归位的 mousemove（见 `dropWarpMove`），漏认那一发视角就会被甩一下。
   *
   * 请求可能被浏览器拒：它只在用户手势里放行，刚用 Esc 退出锁定后还有一段冷却。拒了就停在暂停菜单上，
   * 那个 rejection 也必须接住，否则会变成控制台里一条未处理的错误。
   */
  const grabPointer = (): void => {
    // 标记要在这里而不是在 pointerlockchange 里立：那发归位事件可能比锁定变更事件先到。
    dropWarpMove = true;
    lockedAt = undefined;
    grabPending = true;
    // 老浏览器这个方法返回 void、失败只发 pointerlockerror，新的返回 Promise，所以先收成 unknown 再认。
    const request: unknown = canvas.requestPointerLock();
    if (request instanceof Promise) request.catch(onLockFailed);
  };

  /** 锁定请求失败。 */
  const onLockFailed = (): void => {
    if (!grabPending) return;
    grabPending = false;
    // 没锁上，那发归位事件也就不会来。
    dropWarpMove = false;
    // 暂停菜单上点的：留在菜单，提示再点一次。关掉界面、重生时抓的：鼠标没锁着、界面也关了，世界不该在
    // 玩家操作不了的时候接着推进，算作暂停（ADR-0019 补记）。
    if (paused) resumeRejected = true;
    else if (!locked()) pause();
  };

  const onClick = (): void => {
    // 指针锁定只能由用户手势触发，所以挂在 click 上。
    if (locked()) return;
    // 界面开着时鼠标是用来点格子的，不能把它抓回第一人称。
    if (uiOpen()) return;
    grabPointer();
  };

  /** 为界面模式交还鼠标。没锁着时不立记号：不会有锁定变更事件来清除它，留着会把下一次 Esc 认成自己释放的。 */
  const releasePointer = (): void => {
    if (!locked()) return;
    releasing = true;
    document.exitPointerLock();
  };

  /**
   * 进入暂停。已经暂停时什么都不做，接线层因此不会为同一次暂停写两次盘。
   *
   * 开着的界面当场关掉（`closeAllScreens` 立即生效）：暂停之后不再有 tick，走背包键那条排队的路关不掉它，
   * 光标物品与合成网格里的东西也进不了快照。
   */
  const pause = (): void => {
    if (paused) return;
    paused = true;
    target.closeAllScreens();
    hooks.onPause();
  };

  /** 放掉按住的键、挖掘与连锁键。 */
  const releaseKeys = (): void => {
    pressed.clear();
    sendIntent();
    target.setMining(false);
    // 连锁键也要放掉：Esc 之后它的 keyup 未必还投得到页面上，卡住的话下一次开始挖掘
    // 会莫名其妙地连锁。
    target.setChainMining(false);
  };

  const onLockChange = (event: Event): void => {
    if (locked()) {
      lockedAt = event.timeStamp;
      grabPending = false;
      // 暂停在锁定真正生效时才解除，不在点按钮的那一刻：请求可能被拒。暂停期间按下的键（点按钮那一下的
      // 左键）再清一次，不带进第一人称。
      if (paused) {
        paused = false;
        resumeRejected = false;
        releaseKeys();
      }
      return;
    }
    if (releasing) releasing = false;
    else pause();
    // 释放锁定时清掉按键状态：Esc 之后玩家不该还朝原方向走下去，也不该还在挖。
    releaseKeys();
  };

  // 切走标签页、最小化窗口：页面隐藏时暂停。浏览器这时也会退出锁定，但事件的先后不定，这里不等它；还锁着就
  // 自己释放，之后到的锁定变更事件清除记号，不再暂停第二次。
  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'hidden') return;
    pause();
    releasePointer();
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
  //
  // 界面开着时也拦：Windows 上的浏览器在松开右键时才发 contextmenu，而对着工作台按下
  // 右键之后，界面在下一个 tick 打开、锁定随即被释放，松开那一刻已经不锁着了——只看锁定
  // 的话，打开工作台界面的那一下右键会把浏览器菜单一起弹出来。界面里的右键是拆堆
  // （由界面层递给核心），同样不该弹菜单。
  const onContextMenu = (event: MouseEvent): void => {
    if (locked() || uiOpen()) event.preventDefault();
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
      // 只认锁定期间的第一发：不是归位事件的话这个浏览器不补投，后面的都是真实移动。
      dropWarpMove = false;
      if (isPointerWarp(lockedAt, event.timeStamp)) return;
    }
    // 浏览器偶尔会投来手做不到的巨型增量，采了视角就会跳到别处——见 pointer-spike.ts。
    if (isPointerSpike(Math.hypot(event.movementX, event.movementY), elapsedMs)) return;
    // 两个方向都取负：偏航 0 朝 −Z（右手边是 +X，往右转是减），俯仰正为抬头。
    target.turn(-event.movementX * MOUSE_SENSITIVITY, -event.movementY * MOUSE_SENSITIVITY);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // 死亡画面上键盘一概不认，理由见 `PlayerControls`。
    if (target.health.dead) return;

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
      else releasePointer();
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
  document.addEventListener('pointerlockerror', onLockFailed);
  document.addEventListener('visibilitychange', onVisibilityChange);
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
      //
      // 死亡画面是例外，每帧都判：死了而鼠标还锁着就释放。只看「从没有到有」会漏掉一种情形——
      // 按背包键关界面、当场抓回锁定，而同一 tick 里玩家摔死，这一帧看到的界面模式从开着直接到开着
      // （背包关了、死亡画面开了），鼠标于是一直锁着，点不到重生按钮。死亡画面上只有重生按钮会抓回
      // 锁定，它先让核心重生再抓（`GameCore.respawn` 立即生效），所以每帧判不会放掉那一下。
      const open = uiOpen();
      if (locked() && ((open && !shownUiOpen) || target.health.dead)) releasePointer();
      shownUiOpen = open;
    },
    grabPointer,
    resume(): void {
      if (!uiOpen()) {
        grabPointer();
        return;
      }
      paused = false;
      resumeRejected = false;
    },
    get paused(): boolean {
      return paused;
    },
    get resumeRejected(): boolean {
      return resumeRejected;
    },
    remove(): void {
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('pointerlockerror', onLockFailed);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
