import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { newFurnaceState } from '../../src/core/block-state';
import { ItemType } from '../../src/core/item';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { createTerrain } from '../../src/core/terrain';
import { World, type ChunkCoord, type ChunkSource } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/** 一个区块的全部方块。用它比较两次得到的区块是否逐格一致。 */
function sampleChunk(world: World, cx: number, cz: number): string {
  const parts: string[] = [];
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const x = cx * CHUNK_SIZE + lx;
      const z = cz * CHUNK_SIZE + lz;
      for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
        parts.push(String(world.getBlock(x, y, z)));
      }
    }
  }
  return parts.join(',');
}

describe('World 的区块加载', () => {
  it('新建的世界没有已加载区块，任何坐标都是空气', () => {
    const world = new World(flatTestTerrain);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
  });

  it('加载区块后该区块范围内可读到地形', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(true);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Grass);
    // 相邻区块仍未加载
    expect(world.getBlock(16, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });

  it('重复加载同一区块不会重新生成，已有修改保留', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);
    world.loadChunk(0, 0);
    expect(world.getBlock(1, FLAT_GROUND_Y, 1)).toBe(BlockType.Air);
    expect(world.loadedChunkCount).toBe(1);
  });

  it('卸载区块后坐标回到空气', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.unloadChunk(0, 0);
    expect(world.isChunkLoaded(0, 0)).toBe(false);
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });

  it('负坐标归属正确的区块', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(-1, -1);
    expect(world.getBlock(-1, FLAT_GROUND_Y, -1)).toBe(BlockType.Grass);
    expect(world.getBlock(-16, FLAT_GROUND_Y, -16)).toBe(BlockType.Grass);
    expect(world.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Air);
  });
});

describe('World 的写入结果', () => {
  it('写入已加载区块返回 true', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air)).toBe(true);
  });

  it('写入未加载区块返回 false', () => {
    const world = new World(flatTestTerrain);
    expect(world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air)).toBe(false);
  });

  it('世界高度之外的写入返回 false 且不改变世界', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.setBlock(0, WORLD_MAX_Y + 1, 0, BlockType.Stone)).toBe(false);
    expect(world.setBlock(0, WORLD_MIN_Y - 1, 0, BlockType.Stone)).toBe(false);
    expect(world.getBlock(0, WORLD_MAX_Y + 1, 0)).toBe(BlockType.Air);
    expect(world.getBlock(0, WORLD_MIN_Y - 1, 0)).toBe(BlockType.Air);
    // 边界上仍然可写
    expect(world.setBlock(0, WORLD_MAX_Y, 0, BlockType.Stone)).toBe(true);
    expect(world.getBlock(0, WORLD_MAX_Y, 0)).toBe(BlockType.Stone);
  });
});

describe('已改区块在卸载后保留', () => {
  /** 数一数向来源要过几次区块的地形。 */
  function countingTerrain(): { source: ChunkSource; generated: () => number } {
    let generated = 0;
    return {
      generated: () => generated,
      source: (cx, cz) => {
        generated++;
        return flatTestTerrain(cx, cz);
      },
    };
  }

  it('挖掉一块的区块卸载后重新加载，那一格仍是空气', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(world.getBlock(1, FLAT_GROUND_Y, 1)).toBe(BlockType.Air);
  });

  it('放下一块的区块卸载后重新加载，那一格仍是放下的方块', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y + 1, 1, BlockType.Dirt);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(world.getBlock(1, FLAT_GROUND_Y + 1, 1)).toBe(BlockType.Dirt);
  });

  it('放下的是木板方块也一样留着：新方块编号进得了区块数据', () => {
    // 区块里存的是 Uint8Array 的编号，追加的编号照样存得下、读得回
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y + 1, 1, BlockType.OakPlanks);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(world.getBlock(1, FLAT_GROUND_Y + 1, 1)).toBe(BlockType.OakPlanks);
  });

  it('放下的是工作台也一样留着：它是普通方块，进已改区块的数据', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y + 1, 1, BlockType.CraftingTable);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(world.getBlock(1, FLAT_GROUND_Y + 1, 1)).toBe(BlockType.CraftingTable);
  });

  it('已改区块重新加载时复用留着的那一份，不向来源要新的', () => {
    const { source, generated } = countingTerrain();
    const world = new World(source);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(generated()).toBe(1);
  });

  it('没改过的区块卸载即丢弃，重新生成的那一份与首次一模一样', () => {
    const { source, generated } = countingTerrain();
    const world = new World(source);
    world.loadChunk(0, 0);
    const before = sampleChunk(world, 0, 0);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    // 又向来源要了一份，而不是复用——没改过的区块不必留着
    expect(generated()).toBe(2);
    expect(sampleChunk(world, 0, 0)).toBe(before);
  });

  it('写成原本就是的方块不算改过，那个区块照旧丢弃', () => {
    const { source, generated } = countingTerrain();
    const world = new World(source);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Grass);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(generated()).toBe(2);
  });

  it('改了一格的区块卸载再加载，别的格子不变', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);
    const before = sampleChunk(world, 0, 0);

    world.unloadChunk(0, 0);
    world.loadChunk(0, 0);

    expect(sampleChunk(world, 0, 0)).toBe(before);
  });

  it('一个区块改过不影响相邻区块，它照旧丢弃后重新生成', () => {
    const { source, generated } = countingTerrain();
    const world = new World(source);
    world.loadChunk(0, 0);
    world.loadChunk(1, 0);
    world.setBlock(1, FLAT_GROUND_Y, 1, BlockType.Air);

    world.unloadChunk(0, 0);
    world.unloadChunk(1, 0);
    world.loadChunk(0, 0);
    world.loadChunk(1, 0);

    // 改过的那个复用，没改的那个重新生成：两次加载一共问了 3 次
    expect(generated()).toBe(3);
    expect(world.getBlock(1, FLAT_GROUND_Y, 1)).toBe(BlockType.Air);
    expect(world.getBlock(17, FLAT_GROUND_Y, 1)).toBe(BlockType.Grass);
  });
});

describe('World 的方块状态表（issue #30、ADR-0011）', () => {
  const AT: [number, number, number] = [3, FLAT_GROUND_Y + 1, 5];

  function worldWithOrigin(): World {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    return world;
  }

  it('新建的世界状态表是空的，任何坐标都没有状态', () => {
    const world = worldWithOrigin();
    expect(world.blockStateCount).toBe(0);
    expect(world.blockStateAt(...AT)).toBeUndefined();
  });

  it('放下熔炉，该坐标有一条空的熔炉状态', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    expect(world.blockStateAt(...AT)).toEqual(newFurnaceState());
    expect(world.blockStateCount).toBe(1);
  });

  it('放下泥土、石头这类没有状态的方块，状态表不动', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Dirt);
    world.setBlock(...AT, BlockType.CraftingTable);
    expect(world.blockStateCount).toBe(0);
  });

  it('熔炉换成空气，那条状态删掉', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    world.setBlock(...AT, BlockType.Air);
    expect(world.blockStateAt(...AT)).toBeUndefined();
    expect(world.blockStateCount).toBe(0);
  });

  it('熔炉换成别的方块（泥土），那条状态同样删掉', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    world.setBlock(...AT, BlockType.Dirt);
    expect(world.blockStateAt(...AT)).toBeUndefined();
  });

  it('熄火的熔炉改成燃烧中的编号，状态是同一条、内容不丢；再改回来也一样', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    const state = world.blockStateAt(...AT)!;
    state.input = { item: ItemType.Cobblestone, count: 3 };

    world.setBlock(...AT, BlockType.LitFurnace);
    expect(world.blockStateAt(...AT)).toBe(state);
    world.setBlock(...AT, BlockType.Furnace);
    expect(world.blockStateAt(...AT)).toBe(state);
    expect(world.blockStateAt(...AT)!.input).toEqual({ item: ItemType.Cobblestone, count: 3 });
    expect(world.blockStateCount).toBe(1);
  });

  it('直接放下燃烧中的编号也建一条状态，挖掉同样删掉', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.LitFurnace);
    expect(world.blockStateAt(...AT)).toEqual(newFurnaceState());
    world.setBlock(...AT, BlockType.Air);
    expect(world.blockStateAt(...AT)).toBeUndefined();
  });

  it('熔炉原地再写一次熔炉，状态还是原来那一条', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    const state = world.blockStateAt(...AT)!;
    world.setBlock(...AT, BlockType.Furnace);
    expect(world.blockStateAt(...AT)).toBe(state);
  });

  it('没落到世界里的写入不建状态：未加载的区块与世界高度之外', () => {
    const world = worldWithOrigin();
    expect(world.setBlock(100, FLAT_GROUND_Y + 1, 100, BlockType.Furnace)).toBe(false);
    expect(world.setBlock(3, WORLD_MAX_Y + 1, 5, BlockType.Furnace)).toBe(false);
    expect(world.blockStateCount).toBe(0);
  });

  it('两个坐标各一条，互不混淆；坐标按 floor 取整', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    world.setBlock(AT[0] + 1, AT[1], AT[2], BlockType.Furnace);
    expect(world.blockStateCount).toBe(2);
    expect(world.blockStateAt(AT[0] + 0.5, AT[1] + 0.9, AT[2] + 0.1)).toBe(world.blockStateAt(...AT));
    expect(world.blockStateAt(...AT)).not.toBe(world.blockStateAt(AT[0] + 1, AT[1], AT[2]));
  });

  it('整张表能遍历：每一条带着自己的坐标与状态，负坐标也解得回来', () => {
    const world = worldWithOrigin();
    world.loadChunk(-1, -1);
    world.setBlock(...AT, BlockType.Furnace);
    world.setBlock(-3, FLAT_GROUND_Y + 1, -7, BlockType.LitFurnace);
    const entries = world.allBlockStates();
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ x: AT[0], y: AT[1], z: AT[2], state: world.blockStateAt(...AT) });
    expect(entries).toContainEqual({
      x: -3,
      y: FLAT_GROUND_Y + 1,
      z: -7,
      state: world.blockStateAt(-3, FLAT_GROUND_Y + 1, -7),
    });
    expect(new World(flatTestTerrain).allBlockStates()).toEqual([]);
  });

  it('熔炉所在区块卸载再加载，方块与状态都还在，状态是同一条', () => {
    const world = worldWithOrigin();
    world.setBlock(...AT, BlockType.Furnace);
    const state = world.blockStateAt(...AT)!;
    state.fuel = { item: ItemType.OakLog, count: 2 };

    world.unloadChunk(0, 0);
    // 卸载期间条目不删：读方块是空气（未加载即空气），状态却还在表里
    expect(world.getBlock(...AT)).toBe(BlockType.Air);
    expect(world.blockStateCount).toBe(1);
    world.loadChunk(0, 0);

    expect(world.getBlock(...AT)).toBe(BlockType.Furnace);
    expect(world.blockStateAt(...AT)).toBe(state);
    expect(world.blockStateAt(...AT)!.fuel).toEqual({ item: ItemType.OakLog, count: 2 });
  });
});

describe('World 记下网格过期的区块', () => {
  /** 一个已加载区块的平地世界。 */
  function loadedWorld(): World {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    return world;
  }

  function keysOf(coords: readonly ChunkCoord[]): string[] {
    return coords.map(({ cx, cz }) => `${cx},${cz}`);
  }

  /** 取走记录，两组各自的区块键。 */
  function take(world: World): { blocks: string[]; light: string[] } {
    const { blocks, light } = world.takeStaleChunks();
    return { blocks: keysOf(blocks), light: keysOf(light) };
  }

  /** 区块内部、四条边都不挨着的一格。 */
  const INSIDE = [5, FLAT_GROUND_Y, 7] as const;

  it('新建的世界没有过期的区块', () => {
    expect(take(loadedWorld())).toEqual({ blocks: [], light: [] });
  });

  it('区块内部的一格只让自己那个区块过期', () => {
    const world = loadedWorld();
    world.setBlock(...INSIDE, BlockType.Air);
    expect(take(world)).toEqual({ blocks: ['0,0'], light: [] });
  });

  it('区块边界上的一格从不透明换成空气：那一侧的邻居露出了面，也算方块变了', () => {
    const cases: Array<[string, number, number, string[]]> = [
      ['−X 边', 0, 7, ['0,0', '-1,0']],
      ['+X 边', CHUNK_SIZE - 1, 7, ['0,0', '1,0']],
      ['−Z 边', 5, 0, ['0,0', '0,-1']],
      ['+Z 边', 5, CHUNK_SIZE - 1, ['0,0', '0,1']],
    ];
    for (const [name, x, z, expected] of cases) {
      const world = loadedWorld();
      world.setBlock(x, FLAT_GROUND_Y, z, BlockType.Air);
      expect(take(world).blocks, name).toEqual(expected);
    }
  });

  it('区块边上的一格从空气换成不透明方块：邻居的面被挡住，也算方块变了', () => {
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y + 1, 7, BlockType.Stone);
    expect(take(world).blocks).toEqual(['0,0', '-1,0']);
  });

  it('区块边上的一格从一种不透明方块换成另一种：邻居的面不变，邻居不过期', () => {
    // 地下的石头换成泥土，两者都不透明，天光不变。隔壁的面只看这一格挡不挡
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y - 5, 0, BlockType.Dirt);
    expect(take(world)).toEqual({ blocks: ['0,0'], light: [] });
  });

  it('区块边上放一支火把：只有自己那个区块的方块变了，邻居只有光照变了', () => {
    // 火把与空气一样不挡隔壁的面，隔壁的网格只差在光照上
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y + 1, 7, BlockType.Torch);
    const stale = take(world);
    expect(stale.blocks).toEqual(['0,0']);
    // 方块光 14 照出 13 格，从 z = 7 照得到前后两条边，所以不止 −X 那一侧的邻居
    expect(stale.light).toContain('-1,0');
  });

  it('区块边上挖掉一支火把：同样只有自己那个区块的方块变了', () => {
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y + 1, 7, BlockType.Torch);
    world.takeStaleChunks();
    world.setBlock(0, FLAT_GROUND_Y + 1, 7, BlockType.Air);
    const stale = take(world);
    expect(stale.blocks).toEqual(['0,0']);
    // 同上，光照得到前后两条边
    expect(stale.light).toContain('-1,0');
  });

  it('区块边上放一块树叶：隔壁的树叶与它是同一种方块，贴着的那两个面不画了，邻居也算方块变了', () => {
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y + 1, 7, BlockType.OakLeaves);
    expect(take(world).blocks).toEqual(['0,0', '-1,0']);
  });

  it('光照变了的区块里方块也变了：只报在方块那一组里', () => {
    // 角上挖开地面：自己与两个侧向邻居的方块变了，斜对角那个只有光照变了
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y, 0, BlockType.Air);
    expect(take(world)).toEqual({ blocks: ['0,0', '-1,0', '0,-1'], light: ['-1,-1'] });
  });

  it('负坐标归到正确的区块', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(-1, -2);
    world.setBlock(-1, FLAT_GROUND_Y, -17, BlockType.Air);
    expect(take(world).blocks).toEqual(['-1,-2', '0,-2', '-1,-1']);
  });

  it('小数坐标按 floor 归格', () => {
    const world = loadedWorld();
    world.setBlock(15.9, FLAT_GROUND_Y, 7.2, BlockType.Air);
    expect(take(world).blocks).toEqual(['0,0', '1,0']);
  });

  it('同一个区块里改了几格、同一格改了几次，都只报一次', () => {
    const world = loadedWorld();
    world.setBlock(...INSIDE, BlockType.Air);
    world.setBlock(...INSIDE, BlockType.Stone);
    world.setBlock(6, FLAT_GROUND_Y + 1, 7, BlockType.Stone);
    world.setBlock(5, FLAT_GROUND_Y + 2, 8, BlockType.Stone);
    expect(take(world).blocks).toEqual(['0,0']);
  });

  it('两格的邻居重叠时去重：两格都在 −X 边上，邻居只报一次', () => {
    const world = loadedWorld();
    world.setBlock(0, FLAT_GROUND_Y, 5, BlockType.Air);
    world.setBlock(0, FLAT_GROUND_Y, 9, BlockType.Air);
    expect(take(world).blocks).toEqual(['0,0', '-1,0']);
  });

  it('取走之后清空，同一次改动不会报两遍', () => {
    const world = loadedWorld();
    world.setBlock(...INSIDE, BlockType.Air);
    expect(take(world).blocks).toHaveLength(1);
    expect(take(world)).toEqual({ blocks: [], light: [] });
  });

  it('写成原本就是的方块不让网格过期', () => {
    const world = loadedWorld();
    expect(world.setBlock(...INSIDE, BlockType.Grass)).toBe(true);
    expect(take(world)).toEqual({ blocks: [], light: [] });
  });

  it('没落到世界里的写入不让网格过期', () => {
    const world = loadedWorld();
    // 区块未加载
    world.setBlock(1000, FLAT_GROUND_Y, 0, BlockType.Air);
    // y 越界
    world.setBlock(3, WORLD_MAX_Y + 1, 4, BlockType.Stone);
    expect(take(world)).toEqual({ blocks: [], light: [] });
  });
});

describe('区块索引', () => {
  it('相邻与远处的区块互不混淆', () => {
    const world = new World(flatTestTerrain);
    const spots: Array<[number, number]> = [
      [0, 0],
      [-1, 0],
      [0, -1],
      [1, 1],
      [1000, -1000],
      [-33_000, 33_000],
    ];
    for (const [cx, cz] of spots) world.loadChunk(cx, cz);
    expect(world.loadedChunkCount).toBe(spots.length);

    // 每个区块挖掉自己的一格，不应影响别的区块
    for (const [cx, cz] of spots) {
      world.setBlock(cx * 16, FLAT_GROUND_Y, cz * 16, BlockType.Air);
    }
    for (const [cx, cz] of spots) {
      expect(world.getBlock(cx * 16, FLAT_GROUND_Y, cz * 16)).toBe(BlockType.Air);
      expect(world.getBlock(cx * 16 + 1, FLAT_GROUND_Y, cz * 16 + 1)).toBe(BlockType.Grass);
    }
  });
});

describe('地形生成的确定性', () => {
  const SEED = 8_675_309;

  it('加载顺序不影响结果：先 A 后 B 与先 B 后 A 得到相同的两个区块', () => {
    const a = new World(createTerrain(SEED).generateChunk);
    a.loadChunk(0, 0);
    a.loadChunk(1, 0);

    const b = new World(createTerrain(SEED).generateChunk);
    b.loadChunk(1, 0);
    b.loadChunk(0, 0);

    expect(sampleChunk(b, 0, 0)).toBe(sampleChunk(a, 0, 0));
    expect(sampleChunk(b, 1, 0)).toBe(sampleChunk(a, 1, 0));
  });

  it('卸载后重新加载得到相同地形', () => {
    const world = new World(createTerrain(SEED).generateChunk);
    world.loadChunk(2, 3);
    const before = sampleChunk(world, 2, 3);
    world.unloadChunk(2, 3);
    world.loadChunk(2, 3);
    expect(sampleChunk(world, 2, 3)).toBe(before);
  });

  it('只加载单个区块时，区块内的地表与高度场一致', () => {
    const world = new World(createTerrain(SEED).generateChunk);
    world.loadChunk(-2, 7);
    for (const [lx, lz] of [
      [0, 0],
      [7, 9],
      [15, 15],
    ] as Array<[number, number]>) {
      const x = -2 * CHUNK_SIZE + lx;
      const z = 7 * CHUNK_SIZE + lz;
      expect(world.highestBlockY(x, z)).toBe(createTerrain(SEED).surfaceHeightAt(x, z));
    }
  });
});
