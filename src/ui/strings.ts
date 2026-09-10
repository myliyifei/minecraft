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
  levelBar: '等级',
  levelProgress: '到下一级的经验',
  inventory: '背包',
  // 背包界面里除快捷栏之外的那 27 格。读屏软件靠它把两片格子分开报。
  inventoryStorage: '储物格',
  cursorItem: '光标物品',
  // 背包界面里那块 2x2 合成网格，以及旁边显示成品的输出格。
  craftingGrid: '合成网格',
  craftingOutput: '输出格',
} as const;

/**
 * 物品名。与 `STRINGS` 分开是因为它按物品种类索引，加一种物品不补这张表就编译不过。
 */
export const ITEM_NAMES: Readonly<Record<ItemType, string>> = {
  [ItemType.Dirt]: '泥土',
  [ItemType.OakLog]: '橡木原木',
  [ItemType.OakPlanks]: '橡木木板',
  [ItemType.Stick]: '木棍',
};
