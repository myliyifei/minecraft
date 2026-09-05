/**
 * 构建标志。
 *
 * issue #2 要求「开发与测试构建」挂调试句柄、生产构建不挂。开发服务器天然算前者；
 * 「测试构建」是生产模式加上 `VITE_DEBUG_HANDLE=true`，用来在真实构建产物上跑端到端测试。
 *
 * 依赖这个标志的东西（调试句柄、画布回读）都只在这两种构建里存在。
 */
export const DEBUG_BUILD =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_HANDLE === 'true';
