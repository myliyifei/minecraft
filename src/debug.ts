import { DEBUG_BUILD } from './build-flags';
import type { GameCore } from './core/game';
import type { WorldRenderer } from './render/renderer';
import type { ChunkStream } from './worker/chunk-stream';

/**
 * 浏览器端到端测试用的调试句柄。
 * 只在开发与测试构建中挂到 window 上，生产构建里 window 上没有这个属性。
 */
export interface DebugHandle {
  readonly core: GameCore;
  readonly renderer: WorldRenderer;
  /** Worker 供货的区块来源。端到端测试用它确认地形生成真的发生在 Worker 里。 */
  readonly chunks: ChunkStream;
}

declare global {
  interface Window {
    __VOXEL__?: DebugHandle;
  }
}

export const DEBUG_HANDLE_KEY = '__VOXEL__';

export function installDebugHandle(handle: DebugHandle): void {
  if (!DEBUG_BUILD) return;
  window[DEBUG_HANDLE_KEY] = handle;
}
