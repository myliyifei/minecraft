import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Biome, createTerrain } from '../../src/core/terrain';
import type { ChunkRequest, ChunkResponse } from '../../src/worker/protocol';
import { chunkOfColumn, gridColumns, isInterior, SURVEY_SEEDS } from '../helpers/terrain-survey';
import type { ChunkCoord } from '../../src/core/world';

/**
 * 区块 Worker 的消息协议：收到 `ChunkRequest`，回一条 `ChunkResponse`（ADR-0003：Worker 只是换了个地方执行同一个纯函数）。
 *
 * 在 Node 里直接加载 Worker 模块：它把 `onmessage` 设在全局作用域上、用全局的 `postMessage` 回复，测试替换
 * `postMessage` 收下回复，再按消息协议发请求。断言回复的方块与同步调用地形对象逐字节相同。
 */

interface WorkerGlobal {
  onmessage: ((event: { data: ChunkRequest }) => void) | null;
}

const replies: ChunkResponse[] = [];

beforeAll(async () => {
  vi.stubGlobal('postMessage', (message: ChunkResponse) => {
    replies.push(message);
  });
  await import('../../src/worker/chunk-worker');
});

afterAll(() => {
  vi.unstubAllGlobals();
  (globalThis as unknown as WorkerGlobal).onmessage = null;
});

/** 发一条请求，取回 Worker 的回复。 */
function ask(request: ChunkRequest): ChunkResponse {
  const handler = (globalThis as unknown as WorkerGlobal).onmessage;
  if (!handler) throw new Error('Worker 模块没有设置 onmessage');
  const before = replies.length;
  handler({ data: request });
  expect(replies.length, '一条请求一条回复').toBe(before + 1);
  return replies[replies.length - 1]!;
}

function sameAsSync(seed: number, { cx, cz }: ChunkCoord): boolean {
  const reply = ask({ seed, cx, cz });
  expect({ cx: reply.cx, cz: reply.cz }).toEqual({ cx, cz });
  return Buffer.from(reply.blocks).equals(Buffer.from(createTerrain(seed).generateChunk(cx, cz).blocks));
}

/** ±2560 格内第一列四周 32 格外也是这个群系的列所在的区块。 */
function interiorChunk(seed: number, biome: Biome): ChunkCoord | undefined {
  const terrain = createTerrain(seed);
  for (const column of gridColumns(2560, 64)) {
    if (terrain.biomeAt(column.x, column.z) === biome && isInterior(terrain, column, 32)) {
      return chunkOfColumn(column);
    }
  }
  return undefined;
}

describe('区块 Worker 与同步调用生成的区块相同', () => {
  it('原点附近与负坐标的区块', () => {
    for (const coord of [
      { cx: 0, cz: 0 },
      { cx: -3, cz: 5 },
    ]) {
      expect(sameAsSync(SURVEY_SEEDS[0]!, coord), `区块 (${coord.cx}, ${coord.cz})`).toBe(true);
    }
  });

  it.each(SURVEY_SEEDS)('种子 %i：大海与高山里各一个区块', (seed) => {
    for (const biome of [Biome.Ocean, Biome.Mountains]) {
      const coord = interiorChunk(seed, biome);
      expect(coord, `种子 ${seed} 找不到 ${biome} 内部的列`).toBeDefined();
      expect(sameAsSync(seed, coord!), `${biome} 区块 (${coord!.cx}, ${coord!.cz})`).toBe(true);
    }
  });

  it('同一种子连续几条请求、中间夹着别的种子，每一条都与同步调用相同', () => {
    const [a, b] = SURVEY_SEEDS as [number, number];
    for (const [seed, cx, cz] of [
      [a, 1, 1],
      [a, 2, 1],
      [b, 1, 1],
      [a, 1, 1],
    ] as const) {
      expect(sameAsSync(seed, { cx, cz }), `种子 ${seed} 区块 (${cx}, ${cz})`).toBe(true);
    }
  });
});
