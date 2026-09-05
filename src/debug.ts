import type { GameCore } from './core/game';
import type { WorldRenderer } from './render/renderer';

/**
 * 浏览器端到端测试用的调试句柄。
 * 只在开发与测试构建中挂到 window 上，生产构建里这段代码会被整段消掉。
 */
export interface DebugHandle {
  readonly core: GameCore;
  readonly renderer: WorldRenderer;
}

declare global {
  interface Window {
    __VOXEL__?: DebugHandle;
  }
}

export const DEBUG_HANDLE_KEY = '__VOXEL__';

export function installDebugHandle(handle: DebugHandle): void {
  if (!import.meta.env.DEV) return;
  window[DEBUG_HANDLE_KEY] = handle;
}
