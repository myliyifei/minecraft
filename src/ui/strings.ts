// 后缀要写全：vite.config.ts 会 import 本文件去填 index.html 的占位符，而 Vite 的原生
// 配置加载器解析不了省略后缀的路径。这条约束是传递的——本文件与它 import 到的模块
// （现在是 core/item.ts，那边一个 import 都没有）都在配置加载器的模块图里，往那条链上
// 加省略后缀的 import 会让 `npm run dev` 发出警告。其余源文件不经过配置加载器，照旧不写后缀。
import { ItemType } from '../core/item.ts';

/**
 * 界面文字的唯一来源。所有玩家可见的文案都从这里取，不在别处写字面量。
 */
export const STRINGS = {
  gameTitle: '体素世界',
  // 省略号交给加载屏上那个闪动的方块光标，文案本身不带标点。
  loadingWorld: '正在生成世界',
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
  // 死亡画面的标题与那颗按钮：生命归零时铺满屏幕，点按钮回到出生点。
  youDied: '你死了',
  respawn: '重生',
} as const;

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
};
