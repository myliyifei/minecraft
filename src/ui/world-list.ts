import { DEFAULT_DIFFICULTY, Difficulty } from '../core/difficulty';
import { seedFromText } from '../core/world-seed';
import { WORLD_FILE_EXTENSION } from '../storage/world-file';
import { WORLD_NAME_MAX_LENGTH, worldNameValid, type WorldEntry } from '../storage/world-storage';
import { DIFFICULTY_NAMES, formatLastPlayed, STRINGS, worldDetails } from './strings';

/** 世界列表里一条显示哪几颗按钮。进入那一颗可能显示但禁用（版本不兼容），也可能不显示（极限已死亡）。 */
export interface EntryButtons {
  readonly enter: 'enabled' | 'disabled' | 'hidden';
  readonly export: boolean;
  readonly delete: boolean;
}

/**
 * 一条世界的按钮：极限已死亡的只剩删除（见 CONTEXT.md「死亡画面」）；版本不兼容的不能进入，仍能导出与删除
 * （ADR-0018）；其余三颗都有。
 */
export function entryButtons({ meta, compatible }: WorldEntry): EntryButtons {
  if (meta.hardcoreDead) return { enter: 'hidden', export: false, delete: true };
  return { enter: compatible ? 'enabled' : 'disabled', export: true, delete: true };
}

/** 新建世界表单交出来的东西。种子已经按 `seedFromText` 换成了数。 */
export interface NewWorld {
  readonly name: string;
  readonly seed: number;
  readonly difficulty: Difficulty;
}

/** 世界列表上的点击交给接线层的事。取锁、读写存档都在接线层。 */
export interface WorldListActions {
  readonly enter: (id: string) => void;
  readonly create: (world: NewWorld) => void;
  /** 删除按钮点第二次时调。 */
  readonly delete: (id: string) => void;
  /** 一条的「导出」。 */
  readonly export: (id: string) => void;
  /** 点「导入」、在文件对话框里选了一个文件之后调。没选就关掉对话框时不调。 */
  readonly import: (file: File) => void;
  /** 打开设置界面。 */
  readonly settings: () => void;
}

/**
 * 世界列表（见 CONTEXT.md）：铺满屏幕，上方是新建世界、导入、设置三颗按钮，下面每个世界一条。
 *
 * 纯表现：列表的内容由接线层从存储读出来交给 `show`，点击原样交回接线层。
 */
export interface WorldListScreen {
  /** 按这些条目重画列表并显示。条目已按上次游玩时间倒序。 */
  show(entries: readonly WorldEntry[]): void;
  hide(): void;
  /** 在列表上方显示一行提示（取不到锁、导入的文件无效时）。下一次点击列表上的按钮时清掉。 */
  notify(message: string): void;
}

/** 表单里种子框留空时取的随机种子：32 位有符号整数。 */
function randomSeed(): number {
  return crypto.getRandomValues(new Int32Array(1))[0]!;
}

/** 难度下拉框里的顺序：由易到难。 */
const DIFFICULTY_ORDER: readonly Difficulty[] = [
  Difficulty.Peaceful,
  Difficulty.Easy,
  Difficulty.Normal,
  Difficulty.Hard,
  Difficulty.Hardcore,
];

function button(text: string, className: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `world-list__button ${className}`;
  element.textContent = text;
  return element;
}

/** 表单里一行：标签在上，输入框在下。 */
function field(label: string, control: HTMLElement): HTMLLabelElement {
  const element = document.createElement('label');
  element.className = 'world-list__field';
  const caption = document.createElement('span');
  caption.textContent = label;
  element.append(caption, control);
  return element;
}

/** 把世界列表挂到页面上，开局藏着。 */
export function installWorldList(parent: HTMLElement, actions: WorldListActions): WorldListScreen {
  const root = document.createElement('div');
  root.id = 'world-list';
  root.className = 'world-list';
  root.hidden = true;

  const panel = document.createElement('section');
  panel.className = 'world-list__panel';
  panel.setAttribute('aria-label', STRINGS.worldList);

  const title = document.createElement('h1');
  title.className = 'world-list__title';
  title.textContent = STRINGS.gameTitle;

  const toolbar = document.createElement('div');
  toolbar.className = 'world-list__toolbar';
  const newWorldButton = button(STRINGS.newWorld, 'world-list__new');
  // 导入：点按钮时调隐藏的文件输入框打开文件对话框。每次先清空，再选同一个文件也触发 change。
  const importButton = button(STRINGS.importWorld, 'world-list__import');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = WORLD_FILE_EXTENSION;
  fileInput.className = 'world-list__import-file';
  fileInput.hidden = true;
  importButton.addEventListener('click', () => {
    clearMessage();
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) actions.import(file);
  });
  const settingsButton = button(STRINGS.settings, 'world-list__settings');
  settingsButton.addEventListener('click', () => {
    clearMessage();
    actions.settings();
  });
  toolbar.append(newWorldButton, importButton, fileInput, settingsButton);

  const message = document.createElement('p');
  message.className = 'world-list__message';
  message.setAttribute('role', 'alert');
  message.hidden = true;

  // 新建世界表单：点「新建世界」才显示。
  const form = document.createElement('form');
  form.className = 'world-list__form';
  form.hidden = true;
  const nameInput = document.createElement('input');
  nameInput.name = 'name';
  nameInput.maxLength = WORLD_NAME_MAX_LENGTH;
  const seedInput = document.createElement('input');
  seedInput.name = 'seed';
  seedInput.placeholder = STRINGS.seedPlaceholder;
  const difficultySelect = document.createElement('select');
  difficultySelect.name = 'difficulty';
  for (const difficulty of DIFFICULTY_ORDER) {
    const option = document.createElement('option');
    option.value = difficulty;
    option.textContent = DIFFICULTY_NAMES[difficulty];
    difficultySelect.append(option);
  }
  const createButton = document.createElement('button');
  createButton.type = 'submit';
  createButton.className = 'world-list__button world-list__create';
  createButton.textContent = STRINGS.createWorld;
  const cancelButton = button(STRINGS.cancel, 'world-list__cancel');
  const formButtons = document.createElement('div');
  formButtons.className = 'world-list__toolbar';
  formButtons.append(createButton, cancelButton);
  form.append(
    field(STRINGS.worldName, nameInput),
    field(STRINGS.worldSeed, seedInput),
    field(STRINGS.difficulty, difficultySelect),
    formButtons,
  );

  const list = document.createElement('ul');
  list.className = 'world-list__entries';

  panel.append(title, toolbar, message, form, list);
  root.append(panel);
  parent.append(root);

  const clearMessage = (): void => {
    message.hidden = true;
    message.textContent = '';
  };

  const updateCreateButton = (): void => {
    createButton.disabled = !worldNameValid(nameInput.value);
  };

  newWorldButton.addEventListener('click', () => {
    clearMessage();
    nameInput.value = STRINGS.defaultWorldName;
    seedInput.value = '';
    difficultySelect.value = DEFAULT_DIFFICULTY;
    updateCreateButton();
    form.hidden = false;
    nameInput.focus();
    nameInput.select();
  });
  nameInput.addEventListener('input', updateCreateButton);
  cancelButton.addEventListener('click', () => {
    form.hidden = true;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!worldNameValid(nameInput.value)) return;
    clearMessage();
    form.hidden = true;
    actions.create({
      name: nameInput.value.trim(),
      seed: seedFromText(seedInput.value, randomSeed),
      difficulty: difficultySelect.value as Difficulty,
    });
  });

  const renderEntry = (entry: WorldEntry): HTMLLIElement => {
    const { meta } = entry;
    const item = document.createElement('li');
    item.className = 'world-list__entry';
    item.dataset.id = meta.id;

    const name = document.createElement('div');
    name.className = 'world-list__name';
    name.textContent = meta.name;
    const details = document.createElement('div');
    details.className = 'world-list__details';
    details.textContent = worldDetails(meta.seed, meta.difficulty, formatLastPlayed(meta.lastPlayedAt));
    item.append(name, details);
    if (!entry.compatible) {
      const badge = document.createElement('div');
      badge.className = 'world-list__incompatible';
      badge.textContent = STRINGS.incompatible;
      item.append(badge);
    }

    const buttons = entryButtons(entry);
    const row = document.createElement('div');
    row.className = 'world-list__toolbar';
    if (buttons.enter !== 'hidden') {
      const enter = button(STRINGS.enterWorld, 'world-list__enter');
      enter.disabled = buttons.enter === 'disabled';
      enter.addEventListener('click', () => {
        clearMessage();
        actions.enter(meta.id);
      });
      row.append(enter);
    }
    if (buttons.export) {
      const exportButton = button(STRINGS.exportWorld, 'world-list__export');
      exportButton.addEventListener('click', () => {
        clearMessage();
        actions.export(meta.id);
      });
      row.append(exportButton);
    }
    if (buttons.delete) {
      // 点一次换成「确认删除」，再点才删；焦点离开就退回去。
      const remove = button(STRINGS.deleteEntry, 'world-list__delete');
      let armed = false;
      const arm = (value: boolean): void => {
        armed = value;
        remove.textContent = value ? STRINGS.confirmDelete : STRINGS.deleteEntry;
        remove.classList.toggle('world-list__delete--armed', value);
      };
      remove.addEventListener('click', () => {
        clearMessage();
        if (!armed) {
          arm(true);
          return;
        }
        arm(false);
        actions.delete(meta.id);
      });
      remove.addEventListener('blur', () => arm(false));
      row.append(remove);
    }
    item.append(row);
    return item;
  };

  return {
    show(entries): void {
      if (entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'world-list__empty';
        empty.textContent = STRINGS.noWorlds;
        list.replaceChildren(empty);
      } else {
        list.replaceChildren(...entries.map(renderEntry));
      }
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
      form.hidden = true;
      clearMessage();
    },
    notify(text): void {
      message.textContent = text;
      message.hidden = false;
    },
  };
}
