import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHAIN_MINING_LIMIT, chainConnectedBlocks } from '../../src/core/chain-mining';
import { CHUNK_SIZE } from '../../src/core/constants';
import type { Vec3 } from '../../src/core/vec3';
import { chunkOf, World } from '../../src/core/world';
import {
  AIM_LAYER_Y as LAYER_Y,
  worldWithBlocks as worldWith,
  type BlockCoord,
} from '../helpers/aiming';

/** 树干最下面那一格：平地上方那一层里的一格，四周都是空气。 */
const ROOT: Vec3 = { x: 3, y: LAYER_Y, z: 0 };

/** 一格坐标写成摆方块要的三元组。 */
function placement(cell: Vec3, block: BlockType): [BlockCoord, BlockType] {
  return [[cell.x, cell.y, cell.z], block];
}

/** 从 `ROOT` 往上第 i 格。 */
function above(i: number): Vec3 {
  return { x: ROOT.x, y: ROOT.y + i, z: ROOT.z };
}

/** 竖直摆一根 height 格高的树干，返回世界与自下而上的那些格。 */
function trunkWorld(height: number, block = BlockType.OakLog): { world: World; cells: Vec3[] } {
  const cells = Array.from({ length: height }, (_, i) => above(i));
  return { world: worldWith(...cells.map((cell) => placement(cell, block))), cells };
}

describe('连锁集合按 26 向连通展开', () => {
  it('一根 5 格树干整根连上，起点排在最前', () => {
    const { world, cells } = trunkWorld(5);
    const found = chainConnectedBlocks(world, ROOT);
    expect(found[0]).toEqual(ROOT);
    expect(found).toEqual(cells);
  });

  it('只有一块时集合就是它自己', () => {
    const { world } = trunkWorld(1);
    expect(chainConnectedBlocks(world, ROOT)).toEqual([ROOT]);
  });

  it('仅对角相邻的同种方块也连上', () => {
    // 一串沿 (+1, +1, +1) 的对角线：三格两两只在角上碰着
    const diagonal = [ROOT, { x: 4, y: LAYER_Y + 1, z: 1 }, { x: 5, y: LAYER_Y + 2, z: 2 }];
    const world = worldWith(...diagonal.map((cell) => placement(cell, BlockType.OakLog)));
    expect(chainConnectedBlocks(world, ROOT)).toEqual(diagonal);
  });

  it('紧挨着的异种方块不连上', () => {
    const world = worldWith(
      placement(ROOT, BlockType.OakLog),
      placement(above(1), BlockType.OakLog),
      // 面对面挨着的泥土、角上碰着的树叶，都是另一种方块
      placement({ x: 4, y: LAYER_Y, z: 0 }, BlockType.Dirt),
      placement({ x: 4, y: LAYER_Y + 1, z: 1 }, BlockType.OakLeaves),
    );
    expect(chainConnectedBlocks(world, ROOT)).toEqual([ROOT, above(1)]);
  });

  it('隔着一格的同种方块不连上', () => {
    const world = worldWith(
      placement(ROOT, BlockType.OakLog),
      // 差两格，26 邻域之外
      placement({ x: 5, y: LAYER_Y, z: 0 }, BlockType.OakLog),
    );
    expect(chainConnectedBlocks(world, ROOT)).toEqual([ROOT]);
  });

  it('空气与基岩不参与，起点是它们时集合是空的', () => {
    const world = worldWith(placement(above(1), BlockType.Bedrock));
    // ROOT 那一格什么都没摆，是空气
    expect(chainConnectedBlocks(world, ROOT)).toEqual([]);
    expect(chainConnectedBlocks(world, above(1))).toEqual([]);
  });

  it('未加载的区块是边界，连锁走到那里就停', () => {
    // 平地世界加载的是原点周围 3×3 个区块，x 到 2 * CHUNK_SIZE − 1 为止
    const lastLoadedX = 2 * CHUNK_SIZE - 1;
    const row = [-2, -1, 0, 1, 2].map((dx) => ({ x: lastLoadedX + dx, y: LAYER_Y, z: 0 }));
    const world = worldWith(...row.map((cell) => placement(cell, BlockType.OakLog)));
    // 越界那两格根本写不进世界
    expect(world.getBlock(lastLoadedX + 1, LAYER_Y, 0)).toBe(BlockType.Air);

    expect(chainConnectedBlocks(world, row[0]!)).toEqual(row.slice(0, 3));
  });

  it('跨区块边界照样连上', () => {
    // 一条横跨 x = CHUNK_SIZE 的原木：起点在 cx = 0 那个区块里，末端在 cx = 1 里
    const row = [-2, -1, 0, 1, 2].map((dx) => ({ x: CHUNK_SIZE + dx, y: LAYER_Y, z: 0 }));
    const world = worldWith(...row.map((cell) => placement(cell, BlockType.OakLog)));
    // 两端真的落在不同的区块里，否则这条测试测的还是同一个区块之内
    expect(chunkOf(row[0]!.x)).not.toBe(chunkOf(row.at(-1)!.x));

    expect(chainConnectedBlocks(world, row[0]!)).toEqual(row);
  });

  it('同一个世界连两次得到同样的顺序', () => {
    const { world } = trunkWorld(20);
    expect(chainConnectedBlocks(world, ROOT)).toEqual(chainConnectedBlocks(world, ROOT));
  });
});

describe('连锁集合的上限', () => {
  it('默认上限是 64 块，含起点', () => {
    expect(CHAIN_MINING_LIMIT).toBe(64);
  });

  it('70 块连通的方块只取前 64 块，取的是 BFS 距离最近的那些', () => {
    const { world, cells } = trunkWorld(70);
    const found = chainConnectedBlocks(world, ROOT);
    expect(found).toHaveLength(CHAIN_MINING_LIMIT);
    // 一根树干上 BFS 距离就是往上数了几格，最近的 64 块是最下面那 64 格
    expect(found).toEqual(cells.slice(0, CHAIN_MINING_LIMIT));
  });

  it('上限可以调小，截取的仍是最近的那些', () => {
    const { world, cells } = trunkWorld(10);
    expect(chainConnectedBlocks(world, ROOT, 3)).toEqual(cells.slice(0, 3));
  });

  it('一团实心方块被截断时，取的是最近的 64 块，而不是深度优先先走到底的那一条', () => {
    // 一根树干上「发现顺序」与「到起点的距离」恰好一致，分不出实现是不是真按层走。
    // 7×7×7 的实心块分得出来：从正中出发，距离 1 那一层 26 块（累计 27），距离 2 那一层
    // 98 块，上限 64 落在第二层中间——所以 64 块里不该出现距离 3 的方块。深度优先会：
    // 展开正中得到 27 块，接着沿一条路径一直朝角上展开，第三次展开就到距离 3 了。
    const half = 3;
    const center: Vec3 = { x: ROOT.x, y: ROOT.y + half, z: ROOT.z };
    const cube: Vec3[] = [];
    for (let dx = -half; dx <= half; dx++) {
      for (let dy = -half; dy <= half; dy++) {
        for (let dz = -half; dz <= half; dz++) {
          cube.push({ x: center.x + dx, y: center.y + dy, z: center.z + dz });
        }
      }
    }
    const world = worldWith(...cube.map((cell) => placement(cell, BlockType.OakLog)));

    const found = chainConnectedBlocks(world, center);
    /** 到正中的切比雪夫距离，也就是 BFS 走到第几层才发现它。 */
    const layer = ({ x, y, z }: Vec3): number =>
      Math.max(Math.abs(x - center.x), Math.abs(y - center.y), Math.abs(z - center.z));

    expect(found).toHaveLength(CHAIN_MINING_LIMIT);
    // 前 27 块正好是正中加上距离 1 的那一整层，一块不多一块不少
    expect(found.slice(0, 27).map(layer).sort()).toEqual([0, ...Array<number>(26).fill(1)]);
    // 64 块全在距离 2 之内：第二层还没取完就不该有距离 3 的方块挤进来
    expect(Math.max(...found.map(layer))).toBe(2);
  });
});
