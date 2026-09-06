import type { ExperienceView } from '../core/experience';
import type { InventoryView } from '../core/inventory';
import { installHotbar } from './hotbar';
import { installLevelBar } from './level-bar';

/**
 * 屏幕上那一整套 HUD：等级条在上，快捷栏在下。
 *
 * 合成一个句柄，接线层与调试句柄因此不必知道 HUD 由几个部件组成——加一块显示（生命值、
 * 饥饿值）只改这个文件。两者装在同一个 `#hud` 容器里，等级条的宽度因此自动跟快捷栏
 * 一样宽，不必把 9 格的宽度算式在 CSS 里写第二遍。
 */
export interface Hud {
  /** 让画面跟上核心。每帧调一次。 */
  update(): void;
  /** 卸下整套 HUD。 */
  remove(): void;
}

/** HUD 要读核心的哪几样。写成窄接口，接线接错了编译期就报。 */
export interface HudSource {
  readonly inventory: InventoryView;
  readonly experience: ExperienceView;
}

/** 把 HUD 挂到页面上。返回的句柄要每帧 `update()`。 */
export function installHud(parent: HTMLElement, source: HudSource): Hud {
  const root = document.createElement('div');
  root.id = 'hud';
  root.className = 'hud';
  parent.append(root);

  // 顺序就是自上而下的堆叠顺序：等级条压在快捷栏上方，与原版一致。
  const levelBar = installLevelBar(root, source.experience);
  const hotbar = installHotbar(root, source.inventory);

  return {
    update(): void {
      levelBar.update();
      hotbar.update();
    },
    remove(): void {
      root.remove();
    },
  };
}
