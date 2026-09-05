/**
 * 界面文字的唯一来源。所有玩家可见的文案都从这里取，不在别处写字面量。
 */
export const STRINGS = {
  gameTitle: '体素世界',
  // 省略号交给加载屏上那个闪动的方块光标，文案本身不带标点。
  loadingWorld: '正在生成世界',
} as const;
