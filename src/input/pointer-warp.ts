/**
 * 锁定生效之后多少毫秒之内到达的那一发 mousemove 还算光标归位事件。
 *
 * 实测：WSL2 上有窗口的 Chrome 里归位事件比 `pointerlockchange` 先到；无头 Chromium 里它晚到 0.4 到 1 毫秒。
 * 留出的余量是给主线程忙的那几帧：两个事件排在同一段队列里，时间戳差不了多少。
 */
export const WARP_WINDOW_MS = 30;

/**
 * 抓回指针锁定之后锁定期间的第一发 mousemove 是不是光标归位事件（见 `installPlayerControls` 的 `grabPointer`）。
 *
 * 为什么要认：WSL2 上的 Chrome 在锁定生效时会补投一发 mousemove，带的是光标从点击位置归位到画面中心的位移，那不是
 * 玩家转头，采了视角就会一进第一人称被甩向一边。Windows 上的 Edge 不补投这一发（#62）：那里锁定之后的第一发就是
 * 真实的移动，一律丢掉的话每次点画布、关掉界面之后的第一下转头都转不动。
 *
 * 判据是时间：归位事件紧跟着锁定生效到达，在 `pointerlockchange` 之前或之后不到 1 毫秒；真实的第一发移动要等玩家
 * 移动鼠标，通常晚得多。`lockedAt` 是 `pointerlockchange` 的时间戳，还没收到它时是 undefined——那时到达的一发只可能是
 * 归位事件。玩家恰好在锁定生效的那一刻已经在快速移动鼠标时，窗口内的那一发真实移动会被当成归位事件丢掉，代价是一发
 * 增量（几毫秒的手位移）。
 */
export function isPointerWarp(lockedAt: number | undefined, movedAt: number): boolean {
  return lockedAt === undefined || movedAt - lockedAt <= WARP_WINDOW_MS;
}
