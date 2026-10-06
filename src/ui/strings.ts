// 后缀要写全：vite.config.ts 会 import 本文件去填 index.html 的占位符，而 Vite 的原生
// 配置加载器解析不了省略后缀的路径。这条约束是传递的——本文件与它 import 到的模块
// （现在是 core/item.ts 与 core/difficulty.ts，那两边一个 import 都没有）都在配置加载器的模块图里，往那条链上
// 加省略后缀的 import 会让 `npm run dev` 发出警告。input/keybindings.ts 只以 `import type` 引入，编译时整行删掉，
// 不进模块图；它省略了后缀，所以不能改成引入值。其余源文件不经过配置加载器，照旧不写后缀。
import { Difficulty } from '../core/difficulty.ts';
import { ItemType } from '../core/item.ts';
import type { HotbarAction, KeyAction } from '../input/keybindings.ts';

/**
 * 界面文字的唯一来源。所有玩家可见的文案都从这里取，不在别处写字面量。
 */
export const STRINGS = {
  gameTitle: '李星瀚的世界',
  // 加载画面上那一行。新建与读档都经过它。省略号交给一明一灭的方块光标，文案本身不带标点。
  loadingWorld: '正在加载世界',
  crosshair: '十字准星',
  hotbar: '快捷栏',
  // 等级条上方那一排心。读屏软件报它时缀上当前点数。
  health: '生命值',
  levelBar: '等级',
  levelProgress: '到下一级的经验',
  inventory: '背包',
  // 背包界面里除快捷栏之外的那 27 格。读屏软件靠它把两片格子分开报。
  inventoryStorage: '储物格',
  cursorItem: '光标物品',
  // 两个界面里的合成网格（背包界面 2x2、工作台界面 3x3），以及旁边显示成品的输出格。
  craftingGrid: '合成网格',
  craftingOutput: '输出格',
  // 工作台界面的标题：使用键对着工作台打开的那一层。
  craftingTable: '工作台',
  // 熔炉界面的标题：使用键对着熔炉打开的那一层。
  furnace: '熔炉',
  // 熔炉界面里的三格。读屏软件据此分清点的是哪一格。
  furnaceInput: '原料格',
  furnaceFuel: '燃料格',
  furnaceResult: '成品格',
  // 熔炉界面里的两条进度条：当前这件燃料还能烧多久、当前这件原料炼到几分之几。
  fuelLeft: '燃料剩余',
  smeltProgress: '熔炼进度',
  // 背包界面与工作台界面右侧那块面板：列出这块网格能做的配方，点击一条自动填入材料。
  recipeBook: '配方书',
  // 读屏软件报一条配方时缀在成品名后面的状态：材料够不够。
  recipeCraftable: '可合成',
  recipeUncraftable: '材料不足',
  // 工具格上那条耐久条的名字，读屏软件报它时缀上还剩几点。
  durability: '耐久',
  // 死亡画面的标题与那颗按钮：生命归零时铺满屏幕，点按钮回到出生点。极限难度下那颗按钮换成删除世界。
  youDied: '你死了',
  respawn: '重生',
  deleteWorld: '删除世界',
  // 暂停菜单：暂停时铺满画面，标题下面三个按钮。设置按钮与世界列表上的同一个文案。
  paused: '游戏暂停',
  backToGame: '回到游戏',
  saveAndExit: '保存并退出到世界列表',
  // 回到游戏的锁定请求被浏览器拒了：刚用 Esc 退出锁定后有一段冷却。
  resumeRejected: '鼠标没能锁定，请再点一次「回到游戏」',
  // 写盘失败（含存储空间不足）：改动还在内存里，下次暂停或退出时再写。
  saveFailed: '保存失败，下次暂停或退出时再保存',
  // 世界列表：打开页面看到的第一个画面。上方三颗按钮，下面每个世界一条。
  worldList: '世界列表',
  newWorld: '新建世界',
  importWorld: '导入',
  settings: '设置',
  // 一个世界都没有时列表里那一行。
  noWorlds: '还没有世界',
  enterWorld: '进入',
  exportWorld: '导出',
  deleteEntry: '删除',
  // 删除按钮点过一次之后换成这几个字，再点一次才删。
  confirmDelete: '确认删除',
  // 存档的格式版本或地形算法版本与当前不同：不能进入，只能删除或导出。
  incompatible: '版本不兼容',
  // 进入、删除或导出时取不到这个世界的锁。
  worldInUse: '已在另一个标签页打开',
  // 导出时已改区块超过导入的上限：导出的文件导不回来，所以不导出。
  exportTooLarge: '世界太大，导出的文件无法再导入，未导出',
  // 导入的文件没通过校验：不是导出文件、被改过或截断，或者是别的版本导出的。
  importInvalid: '文件无效或版本不兼容',
  // 导入的文件通过了校验，写进存档时出错（比如存储空间不足）。
  importFailed: '导入失败，写入存档时出错',
  // 新建世界表单。种子框留空就随机取一个。
  worldName: '名称',
  defaultWorldName: '新的世界',
  worldSeed: '种子',
  seedPlaceholder: '留空则随机',
  difficulty: '难度',
  createWorld: '创建',
  cancel: '取消',
  // 设置界面（ADR-0020）：从世界列表与暂停菜单进的是同一个。上半是键位，下半是视距、灵敏度、三个画面开关与自动跳跃开关。
  keyBindings: '键位',
  // 点了一项键位、等着按下一个键时那颗按钮上的字。按 Esc 取消。
  pressAKey: '按下一个键',
  // 两个动作绑到同一个键：两项都标红，读屏软件报这一句。
  keyConflict: '与其他动作同键',
  // 挖掘、使用与关闭界面三项固定，列出来但不能点。
  fixedBinding: '固定',
  viewRadius: '视距',
  sensitivity: '灵敏度',
  smoothLighting: '平滑光照',
  flicker: '闪烁',
  particles: '粒子',
  autoJump: '自动跳跃',
  done: '完成',
  // 按键与鼠标按钮的显示名里要用到的字。字母、数字、标点的显示名就是那个字符，在 src/input/keybindings.ts 里按规则取。
  keySpace: '空格',
  keyNumpad: '小键盘',
  mouseLeft: '鼠标左键',
  mouseRight: '鼠标右键',
} as const;

/** 设置界面里列出的动作名。快捷栏九格按格号拼，见 `keyActionName`。 */
const KEY_ACTION_NAMES: Readonly<Record<Exclude<KeyAction, HotbarAction>, string>> = {
  forward: '前进',
  back: '后退',
  left: '向左',
  right: '向右',
  jump: '跳跃',
  inventory: '背包',
  chainMining: '连锁挖掘',
};

/** 设置界面里固定的三项的名字：挖掘、使用在鼠标上，Esc 关闭界面。 */
export const FIXED_ACTION_NAMES = {
  mine: '挖掘',
  use: '使用',
  close: '关闭界面',
} as const;

/** 一个可改键的动作在设置界面上的名字。 */
export function keyActionName(action: KeyAction): string {
  const hotbar = /^hotbar(\d+)$/.exec(action);
  if (hotbar) return `${STRINGS.hotbar} ${hotbar[1]}`;
  return KEY_ACTION_NAMES[action as Exclude<KeyAction, HotbarAction>];
}

/** 分左右两颗的修饰键的显示名，比如「左 Alt」。 */
export function keyOnSide(side: 'left' | 'right', key: string): string {
  return `${side === 'left' ? '左' : '右'} ${key}`;
}

/** 设置界面上视距滑条旁边的读数。 */
export function viewRadiusValue(chunks: number): string {
  return `${chunks} 个区块`;
}

/** 设置界面上灵敏度滑条旁边的读数：相对默认的百分比。 */
export function sensitivityValue(percent: number): string {
  return `${percent}%`;
}

/** 难度的名字（见 CONTEXT.md「难度」）。按难度索引，加一档不补这张表就编译不过。 */
export const DIFFICULTY_NAMES: Readonly<Record<Difficulty, string>> = {
  [Difficulty.Peaceful]: '和平',
  [Difficulty.Easy]: '简单',
  [Difficulty.Normal]: '普通',
  [Difficulty.Hard]: '困难',
  [Difficulty.Hardcore]: '极限',
};

/** 上次游玩时间的显示格式：年月日加时分。日期的写法也是玩家可见的文字，地区设置只写在这里。 */
const LAST_PLAYED_FORMAT = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

/** 世界列表里显示的上次游玩时间。 */
export function formatLastPlayed(ms: number): string {
  return LAST_PLAYED_FORMAT.format(ms);
}

/** 世界列表里一条名称下面那一行：种子、难度、上次游玩时间。中间的分隔号也是玩家可见的文字，不在别处拼。 */
export function worldDetails(seed: number, difficulty: Difficulty, lastPlayed: string): string {
  return `${STRINGS.worldSeed} ${seed} · ${DIFFICULTY_NAMES[difficulty]} · ${lastPlayed}`;
}

/**
 * 损耗过的工具那一格的提示文字：物品名，加还剩几点耐久。满耐久的工具只报物品名，与耐久条
 * 「满耐久不显示」同一条规则。
 */
export function durabilityLabel(itemName: string, left: number, max: number): string {
  return `${itemName}，${STRINGS.durability} ${left}/${max}`;
}

/**
 * 读屏软件报配方书里的一条时的文字：成品名，加材料够不够。
 * 与 `STRINGS` 同在这个文件里：中间那个顿号也是玩家可见的文字，不在别处拼。
 */
export function recipeLabel(itemName: string, craftable: boolean): string {
  return `${itemName}，${craftable ? STRINGS.recipeCraftable : STRINGS.recipeUncraftable}`;
}

/**
 * 物品名。与 `STRINGS` 分开是因为它按物品种类索引，加一种物品不补这张表就编译不过。
 */
export const ITEM_NAMES: Readonly<Record<ItemType, string>> = {
  [ItemType.Dirt]: '泥土',
  [ItemType.OakLog]: '橡木原木',
  [ItemType.OakPlanks]: '橡木木板',
  [ItemType.Stick]: '木棍',
  [ItemType.CraftingTable]: '工作台',
  [ItemType.WoodenPickaxe]: '木镐',
  [ItemType.WoodenAxe]: '木斧',
  [ItemType.WoodenShovel]: '木铲',
  [ItemType.Cobblestone]: '圆石',
  [ItemType.StonePickaxe]: '石镐',
  [ItemType.StoneAxe]: '石斧',
  [ItemType.StoneShovel]: '石铲',
  [ItemType.Furnace]: '熔炉',
  [ItemType.Coal]: '煤炭',
  [ItemType.RawIron]: '粗铁',
  [ItemType.IronIngot]: '铁锭',
  [ItemType.IronPickaxe]: '铁镐',
  [ItemType.IronAxe]: '铁斧',
  [ItemType.IronShovel]: '铁铲',
  [ItemType.Charcoal]: '木炭',
  [ItemType.RottenFlesh]: '腐肉',
  [ItemType.WoodenSword]: '木剑',
  [ItemType.StoneSword]: '石剑',
  [ItemType.IronSword]: '铁剑',
  [ItemType.Torch]: '火把',
  [ItemType.BirchLog]: '白桦原木',
  [ItemType.BirchPlanks]: '白桦木板',
  [ItemType.SpruceLog]: '云杉原木',
  [ItemType.SprucePlanks]: '云杉木板',
  [ItemType.Sand]: '沙子',
  [ItemType.Gravel]: '沙砾',
  [ItemType.Dandelion]: '蒲公英',
  [ItemType.Poppy]: '虞美人',
};
