import { describe, expect, it } from 'vitest';
import { Chunk } from '../../src/core/chunk';
import { DEFAULT_VIEW_RADIUS, UNLOAD_MARGIN } from '../../src/core/constants';
import { streamChunks } from '../../src/core/streaming';
import { World, type ChunkCoord, type ChunkSource } from '../../src/core/world';
import { flatTestTerrain } from '../helpers/flat-terrain';

/** 半径 r 的方形范围内的区块数。 */
function chunksInSquare(radius: number): number {
  return (2 * radius + 1) ** 2;
}

/** 切比雪夫距离：方形加载范围用的就是它。 */
function distance(a: ChunkCoord, b: ChunkCoord): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cz - b.cz));
}

/** 记录每次被问到哪个区块的来源。 */
function recordingSource(inner: ChunkSource): {
  source: ChunkSource;
  asked: ChunkCoord[];
} {
  const asked: ChunkCoord[] = [];
  return {
    asked,
    source: (cx, cz) => {
      asked.push({ cx, cz });
      return inner(cx, cz);
    },
  };
}

describe('区块随中心流式加载', () => {
  it('半径内的区块全部加载，半径之外一个都不加载', () => {
    const world = new World(flatTestTerrain);
    streamChunks(world, { cx: 0, cz: 0 }, DEFAULT_VIEW_RADIUS);

    expect(world.loadedChunkCount).toBe(chunksInSquare(DEFAULT_VIEW_RADIUS));
    for (const { cx, cz } of world.loadedChunks()) {
      expect(distance({ cx, cz }, { cx: 0, cz: 0 })).toBeLessThanOrEqual(DEFAULT_VIEW_RADIUS);
    }
    // 边界内外各查一处：半径 8 内已加载，半径 9 外未加载
    expect(world.isChunkLoaded(8, 8)).toBe(true);
    expect(world.isChunkLoaded(9, 0)).toBe(false);
    expect(world.isChunkLoaded(0, -9)).toBe(false);
  });

  it('视距可配置：半径 4 时加载的区块数相应变小', () => {
    const world = new World(flatTestTerrain);
    streamChunks(world, { cx: 0, cz: 0 }, 4);
    expect(world.loadedChunkCount).toBe(chunksInSquare(4));
    expect(world.isChunkLoaded(4, 4)).toBe(true);
    expect(world.isChunkLoaded(5, 0)).toBe(false);
  });

  it('中心移动 20 个区块后，原点附近已卸载、新位置周围已加载', () => {
    const world = new World(flatTestTerrain);
    streamChunks(world, { cx: 0, cz: 0 }, DEFAULT_VIEW_RADIUS);
    expect(world.isChunkLoaded(0, 0)).toBe(true);

    streamChunks(world, { cx: 20, cz: 0 }, DEFAULT_VIEW_RADIUS);

    expect(world.isChunkLoaded(0, 0)).toBe(false);
    expect(world.isChunkLoaded(20, 0)).toBe(true);
    expect(world.isChunkLoaded(20 + DEFAULT_VIEW_RADIUS, DEFAULT_VIEW_RADIUS)).toBe(true);
    expect(world.loadedChunkCount).toBe(chunksInSquare(DEFAULT_VIEW_RADIUS));
  });

  it('卸载留一圈滞后：视距 + 1 那一圈还在，再远一圈才卸载', () => {
    expect(UNLOAD_MARGIN).toBe(1);
    const world = new World(flatTestTerrain);
    const radius = 2;
    streamChunks(world, { cx: 0, cz: 0 }, radius);

    // 往 +x 迈一格区块：原来 −2 那一列到了距离 3 = 视距 + 滞后，还留着
    streamChunks(world, { cx: 1, cz: 0 }, radius);
    expect(world.isChunkLoaded(-2, 0)).toBe(true);
    expect(world.isChunkLoaded(3, 0)).toBe(true);

    // 再迈一格，那一列到了距离 4，超出滞后范围
    streamChunks(world, { cx: 2, cz: 0 }, radius);
    expect(world.isChunkLoaded(-2, 0)).toBe(false);
  });

  it('来回跨越同一条区块边界不会反复卸载又重新生成', () => {
    let generated = 0;
    const world = new World((cx, cz) => {
      generated++;
      return flatTestTerrain(cx, cz);
    });
    const radius = 2;
    streamChunks(world, { cx: 0, cz: 0 }, radius);
    const afterFirst = generated;

    for (let i = 0; i < 5; i++) {
      streamChunks(world, { cx: 1, cz: 0 }, radius);
      streamChunks(world, { cx: 0, cz: 0 }, radius);
    }

    // 每次往 +x 迈一格只需要新的一列（2·radius+1 个），回头那一列因为滞后还在
    expect(generated).toBe(afterFirst + (2 * radius + 1));
  });
});

describe('还没准备好的区块来源', () => {
  it('来源说「还没好」时不加载，也不影响别的区块', () => {
    const ready = new Set(['0,0']);
    const world = new World((cx, cz) =>
      ready.has(`${cx},${cz}`) ? flatTestTerrain(cx, cz) : undefined,
    );

    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(world.loadedChunkCount).toBe(1);
    expect(world.isChunkLoaded(0, 0)).toBe(true);

    // 区块就绪之后再来一次，缺的补上
    ready.add('1,0');
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(world.loadedChunkCount).toBe(2);
    expect(world.isChunkLoaded(1, 0)).toBe(true);
  });

  it('缺的区块每次都会被重新问一遍', () => {
    const { source, asked } = recordingSource(() => undefined);
    const world = new World(source);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(asked).toHaveLength(9);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(asked).toHaveLength(18);
  });

  it('已加载的区块不会再被问一遍', () => {
    const { source, asked } = recordingSource(flatTestTerrain);
    const world = new World(source);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(asked).toHaveLength(9);
  });

  it('按到中心的距离由近到远问：脚下的地形先到', () => {
    const { source, asked } = recordingSource(() => undefined);
    const world = new World(source);
    streamChunks(world, { cx: 10, cz: -10 }, 3);

    expect(asked[0]).toEqual({ cx: 10, cz: -10 });
    const distances = asked.map((c) => Math.hypot(c.cx - 10, c.cz + 10));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]!);
    }
  });
});

describe('流式加载与地形确定性', () => {
  it('走远再走回来，同一个区块的地形不变', () => {
    const world = new World(flatTestTerrain);
    const sample = (): number =>
      world.highestBlockY(0, 0);

    streamChunks(world, { cx: 0, cz: 0 }, 1);
    const before = sample();
    streamChunks(world, { cx: 40, cz: 0 }, 1);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(sample()).toBe(before);
  });

  it('空区块也算加载好了，不会每 tick 重新生成', () => {
    let generated = 0;
    const world = new World((cx, cz) => {
      generated++;
      return new Chunk(cx, cz);
    });
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    streamChunks(world, { cx: 0, cz: 0 }, 1);
    expect(generated).toBe(9);
  });
});
