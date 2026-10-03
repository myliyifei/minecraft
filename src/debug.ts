import { DEBUG_BUILD } from './build-flags';
import type { GameCore } from './core/game';
import type { WorldRenderer } from './render/renderer';
import type { LoadResult, WorldEntry } from './storage/world-storage';
import type { Hud } from './ui/hud';
import type { ChunkStream } from './worker/chunk-stream';

/**
 * 浏览器端到端测试用的调试句柄。
 * 只在开发与测试构建中挂到 window 上，生产构建里 window 上没有这个属性。
 */
export interface DebugHandle {
  readonly core: GameCore;
  readonly renderer: WorldRenderer;
  /**
   * 整套 HUD（见 src/ui/hud.ts）。端到端测试要在一次同步的 evaluate 里推进 tick 再看界面，
   * 所以得自己调它的 `update()`——那一步平时是游戏循环发起的。
   */
  readonly hud: Hud;
  /** 由 Worker 生成区块的来源。端到端测试用它确认地形生成真的发生在 Worker 里。 */
  readonly chunks: ChunkStream;
  /**
   * 写盘并退出到世界列表，与暂停菜单那一项同一条路（`WorldSession.exit`）。兑现时这个世界已经销毁、锁已释放，
   * 世界列表随后刷新。
   */
  exitToList(): Promise<void>;
}

/**
 * 进入一个世界的结果（`ListDebugHandle.enterWorld`）：进去了，或没进去的原因——锁在另一个标签页、读档没读出来
 * （版本不兼容、没有这个世界），或是极限已死亡的世界。
 */
export type EnterOutcome = 'entered' | 'locked' | Exclude<LoadResult['status'], 'ok'> | 'hardcoreDead';

/**
 * 世界列表页的调试句柄。列表页没有核心与渲染器，所以它与 `DebugHandle` 分开，挂在另一个全局名上：
 * 显示世界列表时挂上，进入世界时撤掉。
 */
export interface ListDebugHandle {
  /** 存储里的全部世界，按上次游玩时间倒序。 */
  listWorlds(): Promise<WorldEntry[]>;
  /**
   * 不经点击直接进入这个世界，与点「进入」同一条路。加载画面消失时兑现；没进去时兑现成原因。页面正在进入或删除
   * 别的世界时拒绝。
   */
  enterWorld(id: string): Promise<EnterOutcome>;
}

declare global {
  interface Window {
    __VOXEL__?: DebugHandle;
    __VOXEL_LIST__?: ListDebugHandle;
  }
}

export const DEBUG_HANDLE_KEY = '__VOXEL__';
export const LIST_DEBUG_HANDLE_KEY = '__VOXEL_LIST__';

export function installDebugHandle(handle: DebugHandle): void {
  if (!DEBUG_BUILD) return;
  window[DEBUG_HANDLE_KEY] = handle;
}

export function removeDebugHandle(): void {
  delete window[DEBUG_HANDLE_KEY];
}

export function installListDebugHandle(handle: ListDebugHandle): void {
  if (!DEBUG_BUILD) return;
  window[LIST_DEBUG_HANDLE_KEY] = handle;
}

export function removeListDebugHandle(): void {
  delete window[LIST_DEBUG_HANDLE_KEY];
}
