import {
  INVENTORY_CLOSE_KEY,
  KEY_ACTIONS,
  keyLabel,
  MOUSE_BINDINGS,
  mouseButtonLabel,
  type KeyAction,
} from '../input/keybindings';
import { bindableCode, SENSITIVITY_RANGE, VIEW_RADIUS_RANGE, type DisplayToggle, type Settings } from '../settings';
import { FIXED_ACTION_NAMES, keyActionName, sensitivityValue, STRINGS, viewRadiusValue } from './strings';

/**
 * 设置界面（见 GLOSSARY.md「设置」、ADR-0020）：铺满画面的一层，上半是键位，下半是视距、灵敏度、三个画面开关与自动跳跃开关。
 * 世界列表与暂停菜单打开的是同一个。它叠在打开它的那一层之上，那一层一直留着，关掉就回到那里。改动当场写进设置，
 * 设置再写 localStorage。页面打开时装一个，之后一直在。
 *
 * 改键：点一项，那颗按钮变成「按下一个键」，按下的下一个键就绑上；按 Esc 或点到别处取消。两个动作同键时两行
 * 都标红，不阻止。挖掘、使用与关闭界面三项固定，列出来但不能点。
 *
 * 开着的时候页面上其余的元素一律 `inert`：世界列表、暂停菜单的按钮点不到，也不能用 Tab 走过去。
 */
export interface SettingsScreen {
  /** 打开设置界面。已经开着时不做任何事。 */
  open(): void;
}

/** 一行键位：名字在左，按键在右。 */
function bindingRow(name: string, control: HTMLElement): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'settings__key';
  const caption = document.createElement('span');
  caption.className = 'settings__key-name';
  caption.textContent = name;
  row.append(caption, control);
  return row;
}

/** 一行滑条：名字、滑条、读数。 */
function sliderRow(
  name: string,
  range: { readonly min: number; readonly max: number; readonly step?: number },
): { row: HTMLLabelElement; input: HTMLInputElement; value: HTMLOutputElement } {
  const row = document.createElement('label');
  row.className = 'settings__row';
  const caption = document.createElement('span');
  caption.textContent = name;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step ?? 1);
  const value = document.createElement('output');
  value.className = 'settings__value';
  row.append(caption, input, value);
  return { row, input, value };
}

/** 一行开关：复选框在前，名字在后。 */
function toggleRow(name: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'settings__row settings__row--toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const caption = document.createElement('span');
  caption.textContent = name;
  row.append(input, caption);
  return { row, input };
}

/**
 * 一行一个复选框的那几项在设置里的名字与界面上的文字：三个画面开关，之后是自动跳跃。自动跳跃不是画面开关
 * （它是核心的属性，ADR-0020），只是界面上与它们并列。
 */
const TOGGLES: ReadonlyArray<readonly [DisplayToggle | 'autoJump', string]> = [
  ['smoothLighting', STRINGS.smoothLighting],
  ['flicker', STRINGS.flicker],
  ['particles', STRINGS.particles],
  ['autoJump', STRINGS.autoJump],
];

/** 把设置界面挂到页面上，开局藏着。 */
export function installSettingsScreen(parent: HTMLElement, settings: Settings): SettingsScreen {
  const root = document.createElement('div');
  root.id = 'settings';
  root.className = 'settings';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', STRINGS.settings);
  root.hidden = true;

  const panel = document.createElement('section');
  panel.className = 'settings__panel';

  const title = document.createElement('h2');
  title.className = 'settings__title';
  title.textContent = STRINGS.settings;

  const keysTitle = document.createElement('h3');
  keysTitle.className = 'settings__heading';
  keysTitle.textContent = STRINGS.keyBindings;
  const keyList = document.createElement('ul');
  keyList.className = 'settings__keys';

  /** 正在等按键的那一项。 */
  let waiting: KeyAction | undefined;
  /** 刚绑上的那颗键：它的 keyup 也拦下，免得空格松开时按下了获得焦点的按钮，又进入等待。 */
  let swallowKeyUp: string | undefined;

  const bindingButtons = new Map<KeyAction, HTMLButtonElement>();
  for (const action of KEY_ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings__binding';
    button.dataset.action = action;
    button.addEventListener('click', () => {
      waiting = action;
      refresh();
    });
    // 点到别处：取消等待。
    button.addEventListener('blur', () => {
      if (waiting !== action) return;
      waiting = undefined;
      refresh();
    });
    bindingButtons.set(action, button);
    keyList.append(bindingRow(keyActionName(action), button));
  }
  for (const [name, label] of [
    [FIXED_ACTION_NAMES.mine, mouseButtonLabel(MOUSE_BINDINGS.mine)],
    [FIXED_ACTION_NAMES.use, mouseButtonLabel(MOUSE_BINDINGS.use)],
    [FIXED_ACTION_NAMES.close, keyLabel(INVENTORY_CLOSE_KEY)],
  ] as const) {
    const fixed = document.createElement('span');
    fixed.className = 'settings__fixed';
    fixed.textContent = label;
    fixed.title = STRINGS.fixedBinding;
    keyList.append(bindingRow(name, fixed));
  }

  const viewRadius = sliderRow(STRINGS.viewRadius, VIEW_RADIUS_RANGE);
  viewRadius.input.name = 'viewRadius';
  viewRadius.input.addEventListener('input', () => {
    settings.set({ viewRadius: viewRadius.input.valueAsNumber });
    refresh();
  });
  const sensitivity = sliderRow(STRINGS.sensitivity, SENSITIVITY_RANGE);
  sensitivity.input.name = 'sensitivity';
  sensitivity.input.addEventListener('input', () => {
    settings.set({ sensitivity: sensitivity.input.valueAsNumber });
    refresh();
  });
  const toggles = TOGGLES.map(([name, text]) => {
    const toggle = toggleRow(text);
    toggle.input.name = name;
    toggle.input.addEventListener('change', () => settings.set({ [name]: toggle.input.checked }));
    return { name, ...toggle };
  });

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'settings__done';
  done.textContent = STRINGS.done;

  panel.append(
    title,
    keysTitle,
    keyList,
    viewRadius.row,
    sensitivity.row,
    ...toggles.map(({ row }) => row),
    done,
  );
  root.append(panel);
  parent.append(root);

  /** 按设置的当前值重画全部控件。 */
  function refresh(): void {
    for (const [action, button] of bindingButtons) {
      const conflict = settings.keys.conflicts(action);
      button.textContent = waiting === action ? STRINGS.pressAKey : keyLabel(settings.keys.codeOf(action));
      button.classList.toggle('settings__binding--waiting', waiting === action);
      button.parentElement!.classList.toggle('settings__key--conflict', conflict);
      if (conflict) button.setAttribute('aria-invalid', 'true');
      else button.removeAttribute('aria-invalid');
      button.title = conflict ? STRINGS.keyConflict : '';
    }
    viewRadius.input.value = String(settings.viewRadius);
    viewRadius.value.textContent = viewRadiusValue(settings.viewRadius);
    sensitivity.input.value = String(settings.sensitivity);
    sensitivity.value.textContent = sensitivityValue(settings.sensitivity);
    for (const { name, input } of toggles) input.checked = settings[name];
  }

  /** 打开时设成 inert 的那些元素，关掉时还原。原本就 inert 的不动。 */
  let inerted: HTMLElement[] = [];

  const close = (): void => {
    if (root.hidden) return;
    waiting = undefined;
    // 刚绑上的键还按着就关掉了：之后它的 keyup 属于回到游戏之后的那一次按下，要交给输入层。
    swallowKeyUp = undefined;
    root.hidden = true;
    for (const element of inerted) element.inert = false;
    inerted = [];
  };
  done.addEventListener('click', close);

  // 挂在 window 的捕获阶段：等按键时这一下不该再交给页面上别的监听器当作别的用途。
  const onKeyDown = (event: KeyboardEvent): void => {
    if (root.hidden) return;
    if (waiting === undefined) {
      if (event.code === INVENTORY_CLOSE_KEY) {
        event.preventDefault();
        close();
      }
      return;
    }
    // 等按键时这一下不滚动页面、不按下按钮、不移动焦点。
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (bindableCode(event.code)) {
      settings.bindKey(waiting, event.code);
      swallowKeyUp = event.code;
    }
    waiting = undefined;
    refresh();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (root.hidden || event.code !== swallowKeyUp) return;
    swallowKeyUp = undefined;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });

  return {
    open(): void {
      if (!root.hidden) return;
      waiting = undefined;
      refresh();
      // 移到父元素的最后：同一层叠上下文里后挂的元素画在上面，世界里的画布、HUD 与暂停菜单都比它晚挂。
      parent.append(root);
      for (const child of parent.children) {
        if (child === root || !(child instanceof HTMLElement) || child.inert) continue;
        child.inert = true;
        inerted.push(child);
      }
      root.hidden = false;
    },
  };
}
