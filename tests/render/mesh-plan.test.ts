import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { DEFAULT_VIEW_RADIUS } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import { IDLE_INTENT } from '../../src/core/player';
import { chunkKey, chunksAround, type ChunkCoord } from '../../src/core/world';
import { MESH_BUDGET_PER_FRAME, planChunkMeshes } from '../../src/render/mesh-plan';

/** 已加载区块由一组 "cx,cz" 决定的世界。 */
function worldWith(loaded: Iterable<ChunkCoord>) {
  const keys = new Set([...loaded].map(({ cx, cz }) => `${cx},${cz}`));
  return { isChunkLoaded: (cx: number, cz: number) => keys.has(`${cx},${cz}`) };
}

function keysOf(coords: readonly ChunkCoord[]): string[] {
  return coords.map(({ cx, cz }) => `${cx},${cz}`);
}

const CENTER: ChunkCoord = { cx: 0, cz: 0 };

/** 以 CENTER 为中心、半径 radius 的方形内的全部区块。 */
function square(radius: number, center: ChunkCoord = CENTER): ChunkCoord[] {
  return chunksAround(center, radius);
}

describe('该给哪些区块建网格', () => {
  it('只给 8 个邻居都已加载的区块建：最外一圈等邻居到位', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [],
      center: CENTER,
      radius: 2,
      budget: Infinity,
    });

    // 半径 2 已加载 5×5，其中 8 个邻居齐全的只有中间的 3×3
    expect(plan.build).toHaveLength(9);
    expect(keysOf(plan.build)).toContain('0,0');
    expect(keysOf(plan.build)).toContain('1,-1');
    expect(keysOf(plan.build)).not.toContain('2,0');
  });

  it('已经有网格的区块不再建一遍', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [{ cx: 0, cz: 0 }],
      center: CENTER,
      radius: 2,
      budget: Infinity,
    });
    expect(keysOf(plan.build)).not.toContain('0,0');
    expect(plan.build).toHaveLength(8);
  });

  it('8 个邻居（含对角）缺任何一个都不建', () => {
    const neighbors = square(1).filter(({ cx, cz }) => !(cx === 0 && cz === 0));
    expect(neighbors).toHaveLength(8);
    for (const missing of neighbors) {
      const plan = planChunkMeshes({
        world: worldWith(square(1).filter(({ cx, cz }) => cx !== missing.cx || cz !== missing.cz)),
        meshed: [],
        center: CENTER,
        radius: 1,
        budget: Infinity,
      });
      expect(plan.build, `缺 ${missing.cx},${missing.cz}`).toEqual([]);
    }
  });

  it('自己与 8 个邻居都在才建', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(1)),
      meshed: [],
      center: CENTER,
      radius: 1,
      budget: Infinity,
    });
    expect(keysOf(plan.build)).toEqual(['0,0']);
  });

  it('邻居都在但自己没加载时不建', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(1).filter(({ cx, cz }) => !(cx === 0 && cz === 0))),
      meshed: [],
      center: CENTER,
      radius: 1,
      budget: Infinity,
    });
    expect(plan.build).toEqual([]);
  });
});

describe('方块变了的区块', () => {
  it('有网格、8 个邻居都在的当帧重建，不论预算', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: square(1),
      staleBlocks: [{ cx: 0, cz: 0 }, { cx: 1, cz: 1 }],
      center: CENTER,
      radius: 2,
      budget: 0,
    });
    expect(keysOf(plan.rebuild)).toEqual(['0,0', '1,1']);
    expect(plan.drop).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('缺了邻居：丢掉旧网格，不重建——缺的邻居会被当成空气，边界上多出整片面', () => {
    // 视距最外一圈的网格因为卸载留了滞后还在，它外侧的邻居已经卸载
    const loaded = square(2).filter(({ cx }) => cx !== 2);
    const plan = planChunkMeshes({
      world: worldWith(loaded),
      meshed: square(1),
      staleBlocks: [{ cx: 1, cz: 0 }],
      center: CENTER,
      radius: 2,
      budget: Infinity,
    });
    expect(plan.rebuild).toEqual([]);
    expect(keysOf(plan.drop)).toEqual(['1,0']);
    expect(keysOf(plan.build)).not.toContain('1,0');
  });

  it('丢掉之后邻居回来了，按普通的建网格规则重新建', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: square(1).filter(({ cx, cz }) => !(cx === 1 && cz === 0)),
      center: CENTER,
      radius: 2,
      budget: Infinity,
    });
    expect(keysOf(plan.build)).toEqual(['1,0']);
  });

  it('没有网格的什么都不做：它等 8 个邻居齐全后按普通规则建', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [],
      staleBlocks: [{ cx: 0, cz: 0 }, { cx: 9, cz: 9 }],
      center: CENTER,
      radius: 2,
      budget: 0,
    });
    expect(plan.rebuild).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('已经卸载的只丢一次', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(1)),
      meshed: [{ cx: 5, cz: 5 }],
      staleBlocks: [{ cx: 5, cz: 5 }],
      center: CENTER,
      radius: 1,
      budget: 0,
    });
    expect(keysOf(plan.drop)).toEqual(['5,5']);
    expect(plan.rebuild).toEqual([]);
  });
});

describe('只有光照变了的区块', () => {
  /** 已加载 7×7、中间 5×5 都有网格的世界：光照过期的区块都有网格、邻居齐全，没有新区块要建。 */
  const meshedWorld = { world: worldWith(square(3)), meshed: square(2), center: CENTER, radius: 2 };

  it('按预算重建，先重建离玩家近的，其余推迟', () => {
    const plan = planChunkMeshes({
      ...meshedWorld,
      staleLight: [{ cx: 2, cz: 2 }, { cx: 1, cz: 0 }, { cx: -2, cz: 0 }, { cx: 0, cz: 0 }, { cx: 0, cz: -1 }],
      budget: 2,
    });
    expect(keysOf(plan.rebuild)).toEqual(['0,0', '1,0']);
    expect(keysOf(plan.deferred)).toEqual(['0,-1', '-2,0', '2,2']);
    expect(plan.build).toEqual([]);
  });

  it('方块变了的先用掉这一帧的预算，剩下的才轮到光照', () => {
    const plan = planChunkMeshes({
      ...meshedWorld,
      staleBlocks: [{ cx: 2, cz: 2 }],
      staleLight: [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }, { cx: 0, cz: 1 }],
      budget: 2,
    });
    expect(keysOf(plan.rebuild)).toEqual(['2,2', '0,0']);
    expect(keysOf(plan.deferred)).toEqual(['1,0', '0,1']);
  });

  it('方块变了的超出预算时照样全部重建，光照的一个都不重建', () => {
    const plan = planChunkMeshes({
      ...meshedWorld,
      staleBlocks: [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }, { cx: 0, cz: 1 }],
      staleLight: [{ cx: -1, cz: 0 }],
      budget: 2,
    });
    expect(keysOf(plan.rebuild)).toEqual(['0,0', '1,0', '0,1']);
    expect(keysOf(plan.deferred)).toEqual(['-1,0']);
  });

  it('同一个区块方块与光照都变了，只重建一次，不再推迟', () => {
    const plan = planChunkMeshes({
      ...meshedWorld,
      staleBlocks: [{ cx: 1, cz: 0 }],
      staleLight: [{ cx: 1, cz: 0 }],
      budget: 0,
    });
    expect(keysOf(plan.rebuild)).toEqual(['1,0']);
    expect(plan.deferred).toEqual([]);
  });

  it('推迟下来的与这一帧新报的有重复时只算一次', () => {
    const plan = planChunkMeshes({
      ...meshedWorld,
      staleLight: [{ cx: 1, cz: 0 }, { cx: 0, cz: 1 }, { cx: 1, cz: 0 }],
      budget: 1,
    });
    expect(keysOf(plan.rebuild)).toEqual(['1,0']);
    expect(keysOf(plan.deferred)).toEqual(['0,1']);
  });

  it('与新区块按离玩家的远近排在一起分预算', () => {
    // 中间 3×3 有网格，外面一圈没有：光照过期的 (1, 1) 比没有网格的 (2, 0) 近，先轮到它
    const plan = planChunkMeshes({
      world: worldWith(square(3)),
      meshed: square(1),
      staleLight: [{ cx: 1, cz: 1 }, { cx: -1, cz: 0 }],
      center: CENTER,
      radius: 2,
      budget: 3,
    });
    expect(keysOf(plan.rebuild)).toEqual(['-1,0', '1,1']);
    expect(plan.build).toHaveLength(1);
    expect(plan.deferred).toEqual([]);
  });

  it('预算是 Infinity 时全部重建，一个都不推迟', () => {
    const plan = planChunkMeshes({ ...meshedWorld, staleLight: square(2), budget: Infinity });
    expect(plan.rebuild).toHaveLength(25);
    expect(plan.deferred).toEqual([]);
  });

  it('缺了邻居：同样丢掉旧网格，不推迟', () => {
    const loaded = square(2).filter(({ cx }) => cx !== 2);
    const plan = planChunkMeshes({
      world: worldWith(loaded),
      meshed: square(1),
      staleLight: [{ cx: 1, cz: 0 }],
      center: CENTER,
      radius: 2,
      budget: 0,
    });
    expect(keysOf(plan.drop)).toEqual(['1,0']);
    expect(plan.rebuild).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('没有网格的、已经卸载的不推迟：前者按普通规则建，后者的网格只丢一次', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [{ cx: 5, cz: 5 }],
      staleLight: [{ cx: 0, cz: 0 }, { cx: 5, cz: 5 }],
      center: CENTER,
      radius: 1,
      budget: 0,
    });
    expect(keysOf(plan.drop)).toEqual(['5,5']);
    expect(plan.rebuild).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });
});

describe('放挖火把之后几帧内重建完', () => {
  /**
   * 世界铺满网格之后在 (x, y, z) 放一支火把再挖掉，按每帧的预算排网格计划（推迟的交给下一帧），返回两次各自
   * 每帧重建了几个区块，直到没有推迟的为止。
   */
  function placeAndBreak(x: number, z: number): { place: number[]; dig: number[] } {
    const core = new GameCore();
    const meshed = new Map<number, ChunkCoord>();
    const request = { world: core, center: core.playerChunk, radius: core.viewRadius };
    const initial = planChunkMeshes({ ...request, meshed: [], budget: Infinity });
    for (const coord of initial.build) meshed.set(chunkKey(coord.cx, coord.cz), coord);
    core.takeStaleChunks();

    const framesAfter = (): number[] => {
      const frames: number[] = [];
      let deferred: readonly ChunkCoord[] = [];
      do {
        const stale = core.takeStaleChunks();
        const plan = planChunkMeshes({
          ...request,
          meshed: meshed.values(),
          staleBlocks: stale.blocks,
          staleLight: [...deferred, ...stale.light],
          budget: MESH_BUDGET_PER_FRAME,
        });
        expect(plan.build).toEqual([]);
        frames.push(plan.rebuild.length);
        deferred = plan.deferred;
      } while (deferred.length > 0);
      return frames;
    };

    const y = core.highestBlockY(x, z) + 1;
    core.setBlock(x, y, z, BlockType.Torch);
    const place = framesAfter();
    core.setBlock(x, y, z, BlockType.Air);
    return { place, dig: framesAfter() };
  }

  it('区块中间：光照变了的 4 个邻居两帧多一点重建完，每帧不超过预算', () => {
    const { place, dig } = placeAndBreak(8, 8);
    for (const frames of [place, dig]) {
      // 第一帧是火把所在的区块加一个邻居，之后每帧两个
      expect(frames).toEqual([2, 2, 1]);
    }
  });

  it('区块角上：含对角在内 3×3 个区块，不超过 5 帧重建完，每帧不超过预算', () => {
    const { place, dig } = placeAndBreak(0, 0);
    for (const frames of [place, dig]) {
      expect(frames.length).toBeLessThanOrEqual(5);
      expect(Math.max(...frames)).toBeLessThanOrEqual(MESH_BUDGET_PER_FRAME);
      expect(frames.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9);
    }
  });
});

describe('每帧的建网格预算', () => {
  it('一次最多建 budget 个，其余留到下次', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(3)),
      meshed: [],
      center: CENTER,
      radius: 3,
      budget: 2,
    });
    expect(plan.build).toHaveLength(2);
  });

  it('先建离玩家近的：近处的地面先补齐', () => {
    const center = { cx: 10, cz: -4 };
    const plan = planChunkMeshes({
      world: worldWith(square(3, center)),
      meshed: [],
      center,
      radius: 3,
      budget: 3,
    });
    expect(keysOf(plan.build)[0]).toBe('10,-4');
    const distances = plan.build.map((c) => Math.hypot(c.cx - center.cx, c.cz - center.cz));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]!);
    }
  });

  it('预算为 0 时一个都不建，但仍然报告要丢的网格', () => {
    const plan = planChunkMeshes({
      world: worldWith([]),
      meshed: [{ cx: 5, cz: 5 }],
      center: CENTER,
      radius: 2,
      budget: 0,
    });
    expect(plan.build).toEqual([]);
    expect(keysOf(plan.drop)).toEqual(['5,5']);
  });
});

describe('每帧的预算追不追得上移动', () => {
  /**
   * 按 60fps、20tick/s 跑一遍「一直往前走」，返回每帧结束时还积压多少个区块的网格。
   *
   * 网格积压是「走动过程中不出现明显卡顿」这条验收的可测部分：一帧只建两个，只要积压
   * 不一路增长，网格补齐的速度就跟得上玩家移动的速度。真正建网格的动作在这里换成
   * 「记进已建集合」，因此不需要 three.js，也不受机器快慢影响。
   */
  function backlogWhileWalking(seconds: number): number[] {
    const core = new GameCore();
    const meshed = new Map<number, ChunkCoord>();
    const backlog: number[] = [];
    // 边走边跳：真实地形上相邻两列可能差一格，光走会被那一格挡住。
    core.setMoveIntent({ ...IDLE_INTENT, forward: true, jump: true });

    for (let frame = 0; frame < seconds * 60; frame++) {
      if (frame % 3 === 0) core.tick();
      const request = {
        world: core,
        meshed: meshed.values(),
        center: core.playerChunk,
        radius: core.viewRadius,
      };
      const plan = planChunkMeshes({ ...request, budget: MESH_BUDGET_PER_FRAME });
      for (const { cx, cz } of plan.drop) meshed.delete(chunkKey(cx, cz));
      for (const coord of plan.build) meshed.set(chunkKey(coord.cx, coord.cz), coord);
      backlog.push(
        planChunkMeshes({ ...request, meshed: meshed.values(), budget: Infinity }).build.length,
      );
    }
    return backlog;
  }

  it('开局的积压几秒内清完，之后一路走下去只剩过区块边界时的小尖峰', () => {
    const backlog = backlogWhileWalking(30);
    const walking = backlog.slice(5 * 60);
    const idleFrames = walking.filter((pending) => pending === 0).length;

    // 开局要把整片视距铺出来，积压就是那一片
    expect(backlog[0]).toBeGreaterThan(200);
    // 五秒内清完
    expect(backlog[5 * 60]).toBe(0);
    // 之后每跨一条区块边界要补一列，积压跟着跳一下，但从不超过一列，也从不累积
    expect(Math.max(...walking)).toBeLessThanOrEqual(2 * DEFAULT_VIEW_RADIUS + 1);
    expect(walking.at(-1)).toBe(0);
    // 走一格区块要 3.7 秒、两百多帧，尖峰几帧就消掉，绝大多数帧没有积压
    expect(idleFrames / walking.length).toBeGreaterThan(0.8);
  });
});

describe('该丢掉哪些网格', () => {
  it('区块被卸载了，它的网格也丢掉', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(1)),
      meshed: [
        { cx: 0, cz: 0 },
        { cx: 40, cz: 40 },
      ],
      center: CENTER,
      radius: 1,
      budget: Infinity,
    });
    expect(keysOf(plan.drop)).toEqual(['40,40']);
  });

  it('区块还加载着就留着网格，哪怕已经在视距之外（卸载滞后那一圈）', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [{ cx: 2, cz: 2 }],
      center: CENTER,
      radius: 1,
      budget: Infinity,
    });
    expect(plan.drop).toEqual([]);
  });
});
