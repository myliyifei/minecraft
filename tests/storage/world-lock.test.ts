import { describe, expect, it } from 'vitest';
import { withWorldLock } from '../../src/storage/world-lock';

/*
 * Node 24 自带 Web Locks（`navigator.locks`），与浏览器同一套语义：同一进程里两次请求同名的锁，
 * 就是两个标签页争同一个世界。
 */

/** 一个由测试决定何时结束的 Promise。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('世界锁（ADR-0018：同一个世界只能在一个标签页里进入、删除、导出）', () => {
  it('持有期间同一个 id 再取锁返回失败、不执行；释放后能取到', async () => {
    const held = deferred();
    const first = withWorldLock('w1', () => held.promise);
    let ran = false;
    expect(await withWorldLock('w1', () => (ran = true))).toEqual({ ok: false });
    expect(ran).toBe(false);

    held.resolve();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await withWorldLock('w1', () => 7)).toEqual({ ok: true, value: 7 });
  });

  it('不同世界的锁互不影响', async () => {
    const held = deferred();
    const first = withWorldLock('w2', () => held.promise);
    expect(await withWorldLock('w3', () => 'other')).toEqual({ ok: true, value: 'other' });
    held.resolve();
    await first;
  });

  it('fn 抛出时锁照样释放，错误交给调用方', async () => {
    await expect(
      withWorldLock('w4', () => {
        throw new Error('读档失败');
      }),
    ).rejects.toThrow('读档失败');
    expect(await withWorldLock('w4', () => 1)).toEqual({ ok: true, value: 1 });
  });
});
