import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import type { FurnaceState } from '../../src/core/block-state';
import { BLOCK_LIGHT_MASK } from '../../src/core/chunk';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { stepFurnaces } from '../../src/core/furnace';
import { ItemType } from '../../src/core/item';
import { World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain, flatTestWorld } from '../helpers/flat-terrain';
import { firstBlockLightMismatch, firstLightMismatch } from '../helpers/light-reference';
import {
  box,
  BUILDS,
  firstDifference,
  lightSnapshot,
  seededRandom,
  worldWith,
  type Cell,
} from '../helpers/light-scenes';

const G = FLAT_GROUND_Y;

/** 燃烧中的熔炉的发光等级。数值写死：断言的是「13 − 距离」，表里的数是输入的一部分。 */
const LIT = 13;

function manhattan([ax, ay, az]: Cell, [bx, by, bz]: Cell): number {
  return Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz);
}

/** 以 center 为中心、曼哈顿距离不超过 radius 的所有格子。 */
function diamond(center: Cell, radius: number): Cell[] {
  const [cx, cy, cz] = center;
  const cells: Cell[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= radius) cells.push([cx + dx, cy + dy, cz + dz]);
      }
    }
  }
  return cells;
}

/** 世界里所有已加载区块的方块光之和。全 0 说明一格方块光都没有。 */
function totalBlockLight(world: World): number {
  let total = 0;
  for (const { cx, cz } of world.loadedChunks()) {
    for (const byte of world.chunkAt(cx, cz)!.light!) total += byte & BLOCK_LIGHT_MASK;
  }
  return total;
}

/**
 * 悬在半空的光源：离地面 20 格、离 3×3 个区块的外沿都在 14 格以上，13 格半径的菱形整个落在
 * 空气里，没有遮挡。
 */
const P: Cell = [8, G + 20, 8];

describe('方块光的形状（issue #54）', () => {
  it('setBlock 一个燃烧中的熔炉：那格 13，相邻 12，距离 d 处 13 − d，14 格外 0；换回熔炉后全部 0', () => {
    const world = flatTestWorld();
    world.setBlock(...P, BlockType.LitFurnace);
    expect(world.blockLightAt(...P)).toBe(LIT);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      expect(world.blockLightAt(P[0] + dx, P[1] + dy, P[2] + dz)).toBe(LIT - 1);
    }
    for (const cell of diamond(P, 14)) {
      expect(world.blockLightAt(...cell), `(${cell.join(', ')})`).toBe(Math.max(0, LIT - manhattan(P, cell)));
    }
    expect(world.blockLightAt(P[0] + 14, P[1], P[2])).toBe(0);
    expect(world.blockLightAt(P[0], P[1] - 7, P[2] + 7)).toBe(0);
    // 天光不受影响：熔炉本来就是不透明的那一格天光 0，旁边仍是露天
    expect(world.skyLightAt(P[0] + 1, P[1], P[2])).toBe(15);

    world.setBlock(...P, BlockType.Furnace);
    expect(totalBlockLight(world)).toBe(0);
  });

  it('挖掉燃烧中的熔炉同样全部 0', () => {
    const world = flatTestWorld();
    world.setBlock(...P, BlockType.LitFurnace);
    world.setBlock(...P, BlockType.Air);
    expect(totalBlockLight(world)).toBe(0);
  });

  it.each(BUILDS)('两个光源之间每格取较大者，不相加（%s）', (_name, build) => {
    const Q: Cell = [P[0] + 6, P[1], P[2] + 1];
    const world = build([
      [...P, BlockType.LitFurnace],
      [...Q, BlockType.LitFurnace],
    ]);
    for (const cell of diamond([P[0] + 3, P[1], P[2]], 5)) {
      const expected = Math.max(0, LIT - manhattan(P, cell), LIT - manhattan(Q, cell));
      // 两个熔炉自己那格是不透明的发光方块，只有它的发光等级
      const own = cell.join() === P.join() || cell.join() === Q.join() ? LIT : expected;
      expect(world.blockLightAt(...cell), `(${cell.join(', ')})`).toBe(own);
    }
    expect(firstLightMismatch(world)).toBeUndefined();
  });

  it.each(BUILDS)('光源前立一堵 7×7 的墙：墙后一格等于绕过墙的最短路径衰减值（%s）', (_name, build) => {
    const [x, y, z] = P;
    const world = build([
      [...P, BlockType.LitFurnace],
      ...box([x + 1, y - 3, z - 3], [x + 1, y + 3, z + 3], BlockType.Stone),
    ]);
    // 墙后紧挨着那一格：绕到墙边要横走 4 格、过去 2 格、再回来 4 格，共 10 格
    expect(world.blockLightAt(x + 2, y, z)).toBe(LIT - 10);
    // 墙边外侧那一格：横走 4、过去 1，共 5
    expect(world.blockLightAt(x + 1, y, z + 4)).toBe(LIT - 5);
    // 墙本身是不透明方块，没有方块光
    expect(world.blockLightAt(x + 1, y, z)).toBe(0);
    // 墙前面不受影响
    expect(world.blockLightAt(x - 2, y, z)).toBe(LIT - 2);
    expect(firstLightMismatch(world)).toBeUndefined();
  });

  it.each(BUILDS)('树叶不挡方块光：裹在 5×5×5 的树叶里，距离 d 处仍是 13 − d（%s）', (_name, build) => {
    const [x, y, z] = P;
    const world = build([
      ...box([x - 2, y - 2, z - 2], [x + 2, y + 2, z + 2], BlockType.OakLeaves),
      [...P, BlockType.LitFurnace],
    ]);
    expect(world.blockLightAt(x + 1, y, z)).toBe(LIT - 1);
    expect(world.blockLightAt(x + 2, y, z)).toBe(LIT - 2);
    expect(world.blockLightAt(x + 2, y + 2, z + 2)).toBe(LIT - 6);
    expect(world.blockLightAt(x + 4, y, z)).toBe(LIT - 4);
    expect(firstLightMismatch(world)).toBeUndefined();
  });

  it('光源放在已经有光的地方：取发光等级与原值中较大者，旁边更亮的光源不受影响', () => {
    const world = flatTestWorld();
    world.setBlock(...P, BlockType.LitFurnace);
    // 隔一格再放一个：那格原来是 11，放下之后是 13
    const next: Cell = [P[0] + 2, P[1], P[2]];
    expect(world.blockLightAt(...next)).toBe(LIT - 2);
    world.setBlock(...next, BlockType.LitFurnace);
    expect(world.blockLightAt(...next)).toBe(LIT);
    expect(world.blockLightAt(P[0] + 1, P[1], P[2])).toBe(LIT - 1);
    expect(firstLightMismatch(world)).toBeUndefined();
    // 拿掉其中一个，另一个照样亮
    world.setBlock(...P, BlockType.Air);
    expect(world.blockLightAt(...P)).toBe(LIT - 2);
    expect(firstLightMismatch(world)).toBeUndefined();
  });

  it('不透明方块挡住已有的光：放下之后那格 0，背后变暗；挖掉之后恢复', () => {
    const world = flatTestWorld();
    // 熔炉放在地面上，光只往上半空间走；在它旁边一格放石头
    const source: Cell = [8, G + 1, 8];
    world.setBlock(...source, BlockType.LitFurnace);
    const before = world.blockLightAt(10, G + 1, 8);
    expect(before).toBe(LIT - 2);
    world.setBlock(9, G + 1, 8, BlockType.Stone);
    expect(world.blockLightAt(9, G + 1, 8)).toBe(0);
    // 绕过石头：往上一格、过去两格、下来一格
    expect(world.blockLightAt(10, G + 1, 8)).toBe(LIT - 4);
    expect(firstLightMismatch(world)).toBeUndefined();
    world.setBlock(9, G + 1, 8, BlockType.Air);
    expect(world.blockLightAt(10, G + 1, 8)).toBe(before);
    expect(firstLightMismatch(world)).toBeUndefined();
  });
});

describe('方块光的增量更新等于从头算', () => {
  it('随机放与挖 200 次（石头、树叶、燃烧中的熔炉、空气混合）之后两种光逐格相同，中途每 5 次也相同', () => {
    // 原点周围 2×2 个区块：随机的范围跨过它们共用的那个角，跨区块的传播与撤光都会走到
    const world = new World(flatTestTerrain);
    for (const [cx, cz] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) world.loadChunk(cx, cz);
    const random = seededRandom(54);
    const blocks = [BlockType.Air, BlockType.Stone, BlockType.OakLeaves, BlockType.LitFurnace];
    for (let n = 0; n < 200; n++) {
      const x = Math.floor(random() * 12) - 6;
      const z = Math.floor(random() * 12) - 6;
      const y = G - 3 + Math.floor(random() * 10);
      world.setBlock(x, y, z, blocks[Math.floor(random() * blocks.length)]);
      if ((n + 1) % 5 === 0) {
        expect(firstLightMismatch(world), `第 ${n + 1} 次之后`).toBeUndefined();
      }
    }
    // 随机序列里确实留下了亮着的熔炉，比较的不是一片全 0
    expect(totalBlockLight(world)).toBeGreaterThan(0);
  });
});

describe('方块光跨区块', () => {
  /** 区块 (0, 0) 最靠 +X 的那一列上、地面上一格的熔炉。 */
  const BORDER: Cell = [CHUNK_SIZE - 1, G + 1, 7];

  it.each(BUILDS)('光源在区块边界一格内，隔壁区块有对应的光（%s）', (_name, build) => {
    const world = build([[...BORDER, BlockType.LitFurnace]]);
    expect(world.blockLightAt(16, G + 1, 7)).toBe(LIT - 1);
    expect(world.blockLightAt(20, G + 1, 7)).toBe(LIT - 5);
    expect(world.blockLightAt(17, G + 3, 9)).toBe(LIT - 6);
    expect(firstBlockLightMismatch(world)).toBeUndefined();
  });

  it('邻居后加载时光传过去：两个加载顺序得到一样的光照，都等于从头算', () => {
    for (const source of [BORDER, [CHUNK_SIZE, G + 1, 7] as Cell]) {
      const ab = worldWith([[...source, BlockType.LitFurnace]]);
      ab.loadChunk(0, 0);
      ab.loadChunk(1, 0);
      const ba = worldWith([[...source, BlockType.LitFurnace]]);
      ba.loadChunk(1, 0);
      ba.loadChunk(0, 0);
      const across = source[0] === CHUNK_SIZE - 1 ? CHUNK_SIZE : CHUNK_SIZE - 1;
      expect(ab.blockLightAt(across, G + 1, 7), `光源在 x = ${source[0]}`).toBe(LIT - 1);
      expect(ba.blockLightAt(across, G + 1, 7), `光源在 x = ${source[0]}`).toBe(LIT - 1);
      expect(firstDifference(lightSnapshot(ab), lightSnapshot(ba))).toBeUndefined();
      expect(firstBlockLightMismatch(ab)).toBeUndefined();
    }
  });

  it('光源所在区块卸载时它传过去的光撤掉，再加载回来值相同', () => {
    const world = worldWith([[...BORDER, BlockType.LitFurnace]]);
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) world.loadChunk(cx, cz);
    }
    const before = lightSnapshot(world);
    world.unloadChunk(0, 0);
    expect(world.blockLightAt(16, G + 1, 7)).toBe(0);
    expect(totalBlockLight(world)).toBe(0);
    world.loadChunk(0, 0);
    expect(firstDifference(lightSnapshot(world), before)).toBeUndefined();
  });

  it('卸载一个光源所在的区块，别的区块里光源的光留着，两束光重叠的地方回到只剩留下的那一束', () => {
    // 两个熔炉隔着 x = 15 | 16 那条边界，各在一边
    const kept: Cell = [CHUNK_SIZE + 3, G + 1, 7];
    const world = worldWith([
      [...BORDER, BlockType.LitFurnace],
      [...kept, BlockType.LitFurnace],
    ]);
    for (let cx = -1; cx <= 2; cx++) {
      for (let cz = -1; cz <= 1; cz++) world.loadChunk(cx, cz);
    }
    // 两束光之间那一格：离边界上的熔炉 1 格、离留下的熔炉 3 格
    expect(world.blockLightAt(CHUNK_SIZE, G + 1, 7)).toBe(LIT - 1);
    world.unloadChunk(0, 0);
    expect(world.blockLightAt(CHUNK_SIZE, G + 1, 7)).toBe(LIT - 3);
    expect(world.blockLightAt(...kept)).toBe(LIT);
    expect(world.blockLightAt(CHUNK_SIZE + 9, G + 2, 9)).toBe(LIT - 9);
    expect(firstBlockLightMismatch(world)).toBeUndefined();
  });

  it('已改区块卸载再加载后光照相同', () => {
    const world = flatTestWorld();
    world.setBlock(...BORDER, BlockType.LitFurnace);
    world.setBlock(3, G + 1, 7, BlockType.LitFurnace);
    world.setBlock(14, G + 1, 7, BlockType.Stone);
    const before = lightSnapshot(world);
    world.unloadChunk(0, 0);
    expect(world.chunkAt(0, 0)).toBeUndefined();
    expect(firstLightMismatch(world)).toBeUndefined();
    world.loadChunk(0, 0);
    expect(world.getBlock(...BORDER)).toBe(BlockType.LitFurnace);
    expect(firstDifference(lightSnapshot(world), before)).toBeUndefined();
  });

  it('光变到隔壁区块里，隔壁也进过期列表', () => {
    const world = flatTestWorld();
    world.takeStaleChunks();
    world.setBlock(CHUNK_SIZE - 4, G + 1, 7, BlockType.LitFurnace);
    const keys = world.takeStaleChunks().map(({ cx, cz }) => `${cx},${cz}`);
    expect(keys).toContain('0,0');
    expect(keys).toContain('1,0');
  });
});

describe('熔炉走熔炼状态机点火熄火（issue #54）', () => {
  it('放进煤炭与粗铁：点火那一 tick 亮起，煤炭烧完熄火的那一 tick 暗下去', () => {
    const world = flatTestWorld();
    const spot: Cell = [3, G + 1, 5];
    world.setBlock(...spot, BlockType.Furnace);
    const state = world.blockStateAt(...spot) as FurnaceState;
    state.input = { item: ItemType.RawIron, count: 1 };
    state.fuel = { item: ItemType.Coal, count: 1 };
    expect(totalBlockLight(world)).toBe(0);

    stepFurnaces(world);
    expect(world.getBlock(...spot)).toBe(BlockType.LitFurnace);
    expect(world.blockLightAt(...spot)).toBe(LIT);
    expect(world.blockLightAt(3, G + 2, 5)).toBe(LIT - 1);
    expect(world.blockLightAt(5, G + 1, 6)).toBe(LIT - 3);

    // 一件煤炭 1600 tick，第 1 tick 点的火
    for (let tick = 1; tick < 1599; tick++) stepFurnaces(world);
    expect(world.blockLightAt(...spot)).toBe(LIT);
    stepFurnaces(world);
    expect(world.getBlock(...spot)).toBe(BlockType.Furnace);
    expect(totalBlockLight(world)).toBe(0);
  });
});

describe('方块光的工作量（计访问格数，不计时）', () => {
  it('点着一个熔炉，访问的格子数不超过 13 格半径的菱形体积', () => {
    const world = flatTestWorld();
    world.setBlock(...P, BlockType.Furnace);
    const before = world.lightVisits;
    world.setBlock(...P, BlockType.LitFurnace);
    const visits = world.lightVisits - before;
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(diamond(P, LIT).length);
  });

  it('从空气直接放下一个点着的熔炉，两种光加起来访问的格子数也不超过这个体积', () => {
    // 放在空气里会挡住它下面那一段天光，天光那边也要撤光再补光
    const world = flatTestWorld();
    const before = world.lightVisits;
    world.setBlock(...P, BlockType.LitFurnace);
    expect(world.lightVisits - before).toBeLessThanOrEqual(diamond(P, LIT).length);
    expect(firstLightMismatch(world)).toBeUndefined();
  });

  it('熄掉它也一样', () => {
    const world = flatTestWorld();
    world.setBlock(...P, BlockType.LitFurnace);
    const before = world.lightVisits;
    world.setBlock(...P, BlockType.Furnace);
    expect(world.lightVisits - before).toBeLessThanOrEqual(diamond(P, LIT).length);
  });

  it('世界最高与最低一层的光源不越界', () => {
    const world = flatTestWorld();
    world.setBlock(3, WORLD_MAX_Y, 3, BlockType.LitFurnace);
    expect(world.blockLightAt(3, WORLD_MAX_Y - 1, 3)).toBe(LIT - 1);
    world.setBlock(3, WORLD_MIN_Y, 3, BlockType.Air);
    world.setBlock(3, WORLD_MIN_Y + 1, 3, BlockType.Air);
    world.setBlock(3, WORLD_MIN_Y, 3, BlockType.LitFurnace);
    expect(world.blockLightAt(3, WORLD_MIN_Y + 1, 3)).toBe(LIT - 1);
    expect(firstLightMismatch(world)).toBeUndefined();
  });
});
