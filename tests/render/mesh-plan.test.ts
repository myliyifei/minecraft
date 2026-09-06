import { describe, expect, it } from 'vitest';
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

/** 以 CENTER 为心、半径 radius 的方形内的全部区块。 */
function square(radius: number, center: ChunkCoord = CENTER): ChunkCoord[] {
  return chunksAround(center, radius);
}

describe('该给哪些区块建网格', () => {
  it('只给四邻都已加载的区块建：最外一圈等邻居到位', () => {
    const plan = planChunkMeshes({
      world: worldWith(square(2)),
      meshed: [],
      center: CENTER,
      radius: 2,
      budget: Infinity,
    });

    // 半径 2 已加载 5×5，其中四邻齐全的只有中间的 3×3
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

  it('缺一个邻居就不建，邻居到位后才建', () => {
    const missingNeighbor = square(1).filter(({ cx, cz }) => !(cx === 1 && cz === 0));
    expect(
      planChunkMeshes({
        world: worldWith(missingNeighbor),
        meshed: [],
        center: CENTER,
        radius: 1,
        budget: Infinity,
      }).build,
    ).toEqual([]);

    expect(
      keysOf(
        planChunkMeshes({
          world: worldWith(square(1)),
          meshed: [],
          center: CENTER,
          radius: 1,
          budget: Infinity,
        }).build,
      ),
    ).toEqual(['0,0']);
  });

  it('对角线上的邻居不影响：网格只看四个侧面的邻居', () => {
    const withoutCorner = square(1).filter(({ cx, cz }) => !(cx === 1 && cz === 1));
    const plan = planChunkMeshes({
      world: worldWith(withoutCorner),
      meshed: [],
      center: CENTER,
      radius: 1,
      budget: Infinity,
    });
    expect(keysOf(plan.build)).toEqual(['0,0']);
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

describe('每帧的预算追不追得上走路', () => {
  /**
   * 按 60fps、20tick/s 跑一遍「一直往前走」，返回每帧结束时还欠多少个区块的网格。
   *
   * 网格积压是「走动过程中不出现明显卡顿」这条验收的可测部分：一帧只建两个，只要积压
   * 不一路增长，网格补齐的速度就跟得上玩家走路的速度。真正建网格的动作在这里换成
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
    // 走一格区块要 3.7 秒、两百多帧，尖峰几帧就消掉，绝大多数帧一个都不欠
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
