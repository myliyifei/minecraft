import { describe, expect, it } from 'vitest';
import type { ChunkCoord } from '../../src/core/world';
import { planChunkMeshes } from '../../src/render/mesh-plan';

/** 已加载区块由一组 "cx,cz" 决定的世界。 */
function worldWith(loaded: Iterable<ChunkCoord>) {
  const keys = new Set([...loaded].map(({ cx, cz }) => `${cx},${cz}`));
  return { isChunkLoaded: (cx: number, cz: number) => keys.has(`${cx},${cz}`) };
}

/** 以 (0,0) 为心、半径 radius 的方形内的全部区块。 */
function square(radius: number, center: ChunkCoord = { cx: 0, cz: 0 }): ChunkCoord[] {
  const out: ChunkCoord[] = [];
  for (let cx = center.cx - radius; cx <= center.cx + radius; cx++) {
    for (let cz = center.cz - radius; cz <= center.cz + radius; cz++) {
      out.push({ cx, cz });
    }
  }
  return out;
}

function keysOf(coords: readonly ChunkCoord[]): string[] {
  return coords.map(({ cx, cz }) => `${cx},${cz}`);
}

const CENTER: ChunkCoord = { cx: 0, cz: 0 };

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

  it('先建离玩家近的：世界从脚下往外长', () => {
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
