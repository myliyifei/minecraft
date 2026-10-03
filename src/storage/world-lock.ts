/*
 * 世界锁（ADR-0018）：以世界 id 为名的 Web Lock。进入、删除、导出都先取锁，取不到时提示「已在另一个标签页打开」，
 * 不执行；否则另一个标签页的增量写会在被删的世界里重新写出一份不完整的存档。标签页关闭时浏览器自动释放。
 * `navigator.locks` 只在安全上下文（localhost 或 https）可用，不做降级。
 */

/** 取锁的结果。取到时带 fn 的返回值；取不到说明另一个标签页持有这个世界的锁。 */
export type LockResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * 取这个世界的锁并执行 fn，fn 返回的 Promise 兑现或拒绝时释放。锁已被持有时不等待，直接返回失败。
 * 进入世界时，fn 返回的 Promise 要到退出世界时才兑现，这样整个游玩期间都持有锁。
 */
export function withWorldLock<T>(id: string, fn: () => T | Promise<T>): Promise<LockResult<T>> {
  return navigator.locks.request(id, { ifAvailable: true }, async (lock): Promise<LockResult<T>> =>
    lock ? { ok: true, value: await fn() } : { ok: false },
  );
}
