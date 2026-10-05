import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChunkRequest } from '../../src/worker/protocol';

/**
 * 区块 Worker 按种子缓存地形对象（#75、ADR-0021）：同一种子的请求不再每条重建一次地形对象。
 *
 * 构造次数就是这条规则本身，没有别的可观察结果（缓存与否回复的方块都一样，见 chunk-worker.test.ts），
 * 所以这里把地形模块的 `createTerrain` 换成记次数的包装，其余照旧走真实实现。
 */

const created = vi.hoisted(() => ({ seeds: [] as number[] }));

vi.mock('../../src/core/terrain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/terrain')>();
  return {
    ...actual,
    createTerrain: (seed: number) => {
      created.seeds.push(seed);
      return actual.createTerrain(seed);
    },
  };
});

interface WorkerGlobal {
  onmessage: ((event: { data: ChunkRequest }) => void) | null;
}

beforeAll(async () => {
  vi.stubGlobal('postMessage', () => {});
  await import('../../src/worker/chunk-worker');
});

afterAll(() => {
  vi.unstubAllGlobals();
  (globalThis as unknown as WorkerGlobal).onmessage = null;
});

function ask(seed: number, cx: number, cz: number): void {
  (globalThis as unknown as WorkerGlobal).onmessage!({ data: { seed, cx, cz } });
}

describe('区块 Worker 按种子缓存地形对象', () => {
  it('同一种子连续几条请求只构造一次地形对象，换了种子才重建', () => {
    created.seeds.length = 0;
    ask(11, 0, 0);
    ask(11, 1, 0);
    ask(11, -2, 3);
    expect(created.seeds).toEqual([11]);

    ask(22, 0, 0);
    ask(22, 0, 1);
    expect(created.seeds).toEqual([11, 22]);
  });
});
