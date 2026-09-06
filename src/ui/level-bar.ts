import type { ExperienceView } from '../core/experience';
import { STRINGS } from './strings';

/**
 * 等级条 HUD（见 CONTEXT.md）：快捷栏上方那一条，等级数字在上、到下一级的进度在下。
 *
 * 只读核心的 `ExperienceView`：等级怎么算、每级要多少都在 `src/core/experience.ts` 里，
 * 这里只把三个数摆成像素。进度条有多宽不写在这个文件里——它撑满 `#hud` 那一栏，宽度
 * 因此跟快捷栏一样，不必把 9 格的宽度算式抄第二遍。
 */
export interface LevelBarHud {
  /** 让画面跟上经验。每帧调一次；等级与进度都没变就一个 DOM 属性都不碰。 */
  update(): void;
  /** 卸下等级条。 */
  remove(): void;
}

/** 把等级条挂到页面上。返回的句柄要每帧 `update()`。 */
export function installLevelBar(parent: HTMLElement, experience: ExperienceView): LevelBarHud {
  const root = document.createElement('div');
  root.id = 'level-bar';
  root.className = 'levelbar';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', STRINGS.levelBar);

  const level = document.createElement('span');
  level.className = 'levelbar__level';

  const track = document.createElement('span');
  track.className = 'levelbar__track';
  // 进度条的标准语义：读屏软件因此报的是「到下一级 3/7」，而不是一个没名字的方块。
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', STRINGS.levelProgress);
  track.setAttribute('aria-valuemin', '0');

  const fill = document.createElement('span');
  fill.className = 'levelbar__fill';
  track.append(fill);

  root.append(level, track);
  parent.append(root);

  /** 上一次画上去的等级与进度。与当前相同就整条跳过。 */
  let shownLevel: number | undefined;
  let shownProgress: number | undefined;

  return {
    update(): void {
      const { level: now, intoLevel, levelSpan, progress } = experience;
      if (now === shownLevel && progress === shownProgress) return;
      shownLevel = now;
      shownProgress = progress;

      level.textContent = String(now);
      // 等级进 data 属性：端到端测试据此读等级，不必去解文本节点。
      root.dataset.level = String(now);
      track.setAttribute('aria-valuenow', String(intoLevel));
      track.setAttribute('aria-valuemax', String(levelSpan));
      // 宽度的算式留在 CSS 里，这里只给比例，与快捷栏图标那边同一套分工。
      fill.style.setProperty('--progress', String(progress));
    },
    remove(): void {
      root.remove();
    },
  };
}
