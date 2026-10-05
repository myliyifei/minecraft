import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_AREA, CHUNK_SIZE, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y } from '../../src/core/constants';
import { GameCore } from '../../src/core/game';
import { IDLE_INTENT } from '../../src/core/player';
import { World } from '../../src/core/world';
import { FLAT_GROUND_Y, flatTestTerrain, flatTestWorld } from '../helpers/flat-terrain';
import { firstSkyLightMismatch } from '../helpers/light-reference';
import {
  box,
  BUILDS,
  firstDifference,
  lightSnapshot,
  seededRandom,
  worldWith,
  type Edit,
} from '../helpers/light-scenes';
import { allStale } from '../helpers/stale-chunks';

const G = FLAT_GROUND_Y;

/**
 * 石头盖的屋子：地面上 x、z 从 2 到 12 的范围，四面墙高 4 格，屋顶是 y = G + 5 那一层石板。
 * 里面是 3..11 × G+1..G+4 的空间。
 */
const HOUSE: Edit[] = [
  ...box([2, G + 1, 2], [12, G + 5, 12], BlockType.Stone),
  ...box([3, G + 1, 3], [11, G + 4, 11], BlockType.Air),
];

describe('天光初值（ADR-0017）', () => {
  it('平地上地表之上每格 15（世界最高一层之上也是 15），地表方块及以下 0', () => {
    const world = flatTestWorld();
    for (const [x, z] of [[3, 4], [0, 0], [-1, 15], [-16, -16]] as const) {
      expect(world.skyLightAt(x, WORLD_MAX_Y + 1, z)).toBe(15);
      expect(world.skyLightAt(x, WORLD_MAX_Y, z)).toBe(15);
      expect(world.skyLightAt(x, FLAT_GROUND_Y + 1, z)).toBe(15);
      expect(world.skyLightAt(x, FLAT_GROUND_Y, z)).toBe(0);
      expect(world.skyLightAt(x, FLAT_GROUND_Y - 10, z)).toBe(0);
      expect(world.skyLightAt(x, WORLD_MIN_Y, z)).toBe(0);
    }
  });

  it('没加载的格子读作 0', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    expect(world.skyLightAt(16, FLAT_GROUND_Y + 5, 0)).toBe(0);
    expect(world.blockLightAt(16, FLAT_GROUND_Y + 5, 0)).toBe(0);
  });

  it('没有发光方块时方块光位保持 0', () => {
    const world = flatTestWorld();
    world.setBlock(3, FLAT_GROUND_Y + 3, 4, BlockType.Stone);
    expect(world.blockLightAt(3, FLAT_GROUND_Y + 1, 4)).toBe(0);
    expect(world.blockLightAt(3, FLAT_GROUND_Y + 5, 4)).toBe(0);
  });
});

describe.each(BUILDS)('天光的形状（%s）', (_name, build) => {
  it('盖一层石板的屋子里 0', () => {
    const world = build(HOUSE);
    for (const [x, y, z] of [[7, G + 1, 7], [3, G + 4, 3], [11, G + 2, 9]] as const) {
      expect(world.skyLightAt(x, y, z)).toBe(0);
    }
    // 屋顶上面仍是露天
    expect(world.skyLightAt(7, G + 6, 7)).toBe(15);
  });

  it('屋顶开一格洞：洞下 15，旁 14，再旁 13，绕下去的每格再减 1', () => {
    const world = build([
      ...HOUSE,
      [7, G + 5, 7, BlockType.Air],
      // 洞旁一格的地面往下挖一个三格深的竖井
      ...box([8, G - 2, 7], [8, G, 7], BlockType.Air),
    ]);
    for (let y = G + 1; y <= G + 5; y++) expect(world.skyLightAt(7, y, 7), `洞下 y=${y}`).toBe(15);
    for (const y of [G + 1, G + 3]) {
      expect(world.skyLightAt(6, y, 7)).toBe(14);
      expect(world.skyLightAt(7, y, 8)).toBe(14);
      expect(world.skyLightAt(5, y, 7)).toBe(13);
      expect(world.skyLightAt(6, y, 8)).toBe(13);
    }
    // 竖井：口上那格 14，往下每格减 1
    expect(world.skyLightAt(8, G + 1, 7)).toBe(14);
    expect(world.skyLightAt(8, G, 7)).toBe(13);
    expect(world.skyLightAt(8, G - 1, 7)).toBe(12);
    expect(world.skyLightAt(8, G - 2, 7)).toBe(11);
    // 屋角离洞最远：曼哈顿距离 8
    expect(world.skyLightAt(3, G + 1, 3)).toBe(7);
  });

  it('树叶一层之下 14，两层之下 13', () => {
    // 25×25 的树叶，中央离边缘足够远，旁边露天的光绕进来不会比竖直穿过的更亮
    const oneLayer = build(box([-12, G + 5, -12], [12, G + 5, 12], BlockType.OakLeaves));
    expect(oneLayer.skyLightAt(0, G + 5, 0)).toBe(14);
    expect(oneLayer.skyLightAt(0, G + 4, 0)).toBe(14);
    expect(oneLayer.skyLightAt(0, G + 1, 0)).toBe(14);

    const twoLayers = build(box([-12, G + 5, -12], [12, G + 6, 12], BlockType.OakLeaves));
    expect(twoLayers.skyLightAt(0, G + 6, 0)).toBe(14);
    expect(twoLayers.skyLightAt(0, G + 5, 0)).toBe(13);
    expect(twoLayers.skyLightAt(0, G + 1, 0)).toBe(13);
    // 边缘一格：旁边露天那格横着传进来是 14
    expect(twoLayers.skyLightAt(-12, G + 1, 0)).toBe(14);
  });

  it('水面下第 n 格的天光是 15 − n（#74）', () => {
    // 25×25、6 格深的一池水，放在平地之上；中央离边缘 12 格，从池边横着传进来的光比竖直穿过的暗
    const depth = 6;
    const world = build(box([-12, G + 1, -12], [12, G + depth, 12], BlockType.Water));
    expect(world.skyLightAt(0, G + depth + 1, 0), '水面之上').toBe(15);
    for (let n = 1; n <= depth; n++) {
      expect(world.skyLightAt(0, G + depth + 1 - n, 0), `水面下第 ${n} 格`).toBe(15 - n);
    }
    // 池底那块草方块是不透明方块
    expect(world.skyLightAt(0, G, 0)).toBe(0);
  });

  it('冰同理：冰层本身 14、冰下的水每格再减 1；两层冰之下 13（#74）', () => {
    // 结冰的水面：最上面一层是冰，下面 5 格水
    const depth = 6;
    const frozen = build([
      ...box([-12, G + 1, -12], [12, G + depth - 1, 12], BlockType.Water),
      ...box([-12, G + depth, -12], [12, G + depth, 12], BlockType.Ice),
    ]);
    expect(frozen.skyLightAt(0, G + depth + 1, 0), '冰面之上').toBe(15);
    for (let n = 1; n <= depth; n++) {
      expect(frozen.skyLightAt(0, G + depth + 1 - n, 0), `冰面下第 ${n} 格`).toBe(15 - n);
    }

    const twoLayers = build(box([-12, G + 5, -12], [12, G + 6, 12], BlockType.Ice));
    expect(twoLayers.skyLightAt(0, G + 6, 0)).toBe(14);
    expect(twoLayers.skyLightAt(0, G + 5, 0)).toBe(13);
    expect(twoLayers.skyLightAt(0, G + 1, 0)).toBe(13);
  });
});

describe('增量更新等于从头算', () => {
  it('随机放与挖 200 次（石头、树叶、水、冰、空气混合，#74 加入水与冰）之后所有已加载区块逐格相同，中途每 5 次也相同', () => {
    // 原点周围 2×2 个区块：随机的范围跨过它们共用的那个角，跨区块的传播与撤光都会走到
    const world = new World(flatTestTerrain);
    for (const [cx, cz] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) world.loadChunk(cx, cz);
    const random = seededRandom(52);
    const blocks = [BlockType.Air, BlockType.Stone, BlockType.OakLeaves, BlockType.Water, BlockType.Ice];
    for (let n = 0; n < 200; n++) {
      // 范围跨过原点那个区块角，地面以下挖坑、地面以上盖顶都会出现
      const x = Math.floor(random() * 12) - 6;
      const z = Math.floor(random() * 12) - 6;
      const y = G - 3 + Math.floor(random() * 10);
      const block = blocks[Math.floor(random() * blocks.length)];
      world.setBlock(x, y, z, block);
      // 从头算一遍要十几毫秒，每次都比整个测试就要好几秒；隔几次比一次，出错时范围也不大
      if ((n + 1) % 5 === 0) {
        expect(firstSkyLightMismatch(world), `第 ${n + 1} 次之后`).toBeUndefined();
      }
    }
  });
});

/**
 * 横跨 x = 15 | 16 那条区块边界的屋子：x 从 8 到 22、z 从 2 到 12，屋顶在 y = G + 5。
 * hole 是屋顶上开洞的 x。
 */
function houseAcrossBorder(hole: number): Edit[] {
  return [
    ...box([8, G + 1, 2], [22, G + 5, 12], BlockType.Stone),
    ...box([9, G + 1, 3], [21, G + 4, 11], BlockType.Air),
    [hole, G + 5, 7, BlockType.Air],
  ];
}

describe('跨区块', () => {
  it.each(BUILDS)('洞在区块边界一格内时，隔壁区块的格子有对应的光（%s）', (_name, build) => {
    // 洞在 x = 15，是区块 (0, 0) 最靠 +X 的那一列
    const world = build(houseAcrossBorder(CHUNK_SIZE - 1));
    expect(world.skyLightAt(15, G + 2, 7)).toBe(15);
    expect(world.skyLightAt(16, G + 2, 7)).toBe(14);
    expect(world.skyLightAt(17, G + 2, 7)).toBe(13);
    expect(world.skyLightAt(16, G + 2, 9)).toBe(12);
    expect(firstSkyLightMismatch(world)).toBeUndefined();
  });

  it('邻居后加载时光传过去：两个加载顺序得到一样的光照，都等于从头算', () => {
    for (const hole of [15, 16]) {
      const ab = worldWith(houseAcrossBorder(hole));
      ab.loadChunk(0, 0);
      ab.loadChunk(1, 0);
      const ba = worldWith(houseAcrossBorder(hole));
      ba.loadChunk(1, 0);
      ba.loadChunk(0, 0);
      // 洞在哪一边，另一边紧挨着边界的那格都是 14
      const across = hole === 15 ? 16 : 15;
      expect(ab.skyLightAt(across, G + 2, 7), `洞在 ${hole}`).toBe(14);
      expect(ba.skyLightAt(across, G + 2, 7), `洞在 ${hole}`).toBe(14);
      expect(firstDifference(lightSnapshot(ab), lightSnapshot(ba))).toBeUndefined();
      expect(firstSkyLightMismatch(ab)).toBeUndefined();
    }
  });

  it('邻居卸载时它传过来的光撤掉，再加载回来值相同', () => {
    const world = worldWith(houseAcrossBorder(16));
    for (let cx = -1; cx <= 2; cx++) {
      for (let cz = -1; cz <= 1; cz++) world.loadChunk(cx, cz);
    }
    const before = lightSnapshot(world);
    expect(world.skyLightAt(15, G + 2, 7)).toBe(14);

    world.unloadChunk(1, 0);
    // 洞在已卸载的区块里：屋子在 (0, 0) 的部分三面有墙、头上有顶，另一面是没加载的格子
    expect(world.skyLightAt(15, G + 2, 7)).toBe(0);
    expect(world.skyLightAt(16, G + 2, 7)).toBe(0);
    expect(firstSkyLightMismatch(world)).toBeUndefined();

    world.loadChunk(1, 0);
    expect(firstDifference(lightSnapshot(world), before)).toBeUndefined();
  });

  it('已改区块卸载再加载后光照相同', () => {
    const world = flatTestWorld();
    for (const [x, y, z, block] of houseAcrossBorder(15)) world.setBlock(x, y, z, block);
    const before = lightSnapshot(world);

    world.unloadChunk(0, 0);
    expect(world.chunkAt(0, 0)).toBeUndefined();
    expect(firstSkyLightMismatch(world)).toBeUndefined();
    world.loadChunk(0, 0);
    expect(world.getBlock(15, G + 5, 7)).toBe(BlockType.Air);
    expect(firstDifference(lightSnapshot(world), before)).toBeUndefined();
  });
});

describe('光照变过的区块记进过期列表', () => {
  function keysOf(world: World): string[] {
    return allStale(world.takeStaleChunks()).map(({ cx, cz }) => `${cx},${cz}`).sort();
  }

  it('区块内部挡住天光：只有自己那个区块', () => {
    const world = flatTestWorld();
    world.takeStaleChunks();
    world.setBlock(5, G + 10, 7, BlockType.Stone);
    expect(world.skyLightAt(5, G + 1, 7)).toBe(14);
    expect(keysOf(world)).toEqual(['0,0']);
  });

  it('光变到隔壁区块里，隔壁也进列表，哪怕改的那一格不在边上', () => {
    // 屋顶上已有一个洞在 x = 9，加载之后先确认光照正确，后面的断言才只反映这次开洞
    const world = worldWith(houseAcrossBorder(9));
    world.loadChunk(0, 0);
    world.loadChunk(1, 0);
    expect(world.skyLightAt(16, G + 2, 7)).toBe(8);
    expect(firstSkyLightMismatch(world)).toBeUndefined();
    world.takeStaleChunks();
    // 屋顶上 x = 13 开洞：离边界 3 格，光传到 x = 16 还剩 12
    world.setBlock(13, G + 5, 7, BlockType.Air);
    expect(world.skyLightAt(16, G + 2, 7)).toBe(12);
    expect(keysOf(world)).toEqual(['0,0', '1,0']);
  });

  it('区块角上那一格的光变了：含对角在内挨着它的四个区块都进列表', () => {
    const world = flatTestWorld();
    world.takeStaleChunks();
    world.setBlock(0, G, 0, BlockType.Air);
    expect(world.skyLightAt(0, G, 0)).toBe(15);
    expect(keysOf(world)).toEqual(['-1,-1', '-1,0', '0,-1', '0,0']);
  });

  it('新区块加载时传出的光改变了邻居的格子，邻居进列表', () => {
    const world = worldWith(houseAcrossBorder(15));
    world.loadChunk(1, 0);
    world.takeStaleChunks();
    // 洞在 (0, 0) 里，它加载之前屋子在 (1, 0) 的部分天光为 0
    expect(world.skyLightAt(16, G + 2, 7)).toBe(0);
    world.loadChunk(0, 0);
    expect(world.skyLightAt(16, G + 2, 7)).toBe(14);
    expect(keysOf(world)).toContain('1,0');
  });

  it('撤光之后又补回原值的格子不算变过：卸载邻居时这一侧的光照没变，这一侧不进列表', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.loadChunk(1, 0);
    // 边界上一格树叶：竖直穿过是 14，隔壁露天横着传进来也是 14
    world.setBlock(15, G + 1, 7, BlockType.OakLeaves);
    expect(world.skyLightAt(15, G + 1, 7)).toBe(14);
    world.takeStaleChunks();
    // 卸载时它比隔壁那格暗，先当作可能来自隔壁的光撤掉，再按竖直部分补回 14
    world.unloadChunk(1, 0);
    expect(world.skyLightAt(15, G + 1, 7)).toBe(14);
    expect(keysOf(world)).not.toContain('0,0');
  });

  it('新区块加载时邻居的光一格都没变，邻居不进列表', () => {
    const world = new World(flatTestTerrain);
    world.loadChunk(0, 0);
    world.takeStaleChunks();
    world.loadChunk(1, 0);
    expect(keysOf(world)).not.toContain('0,0');
  });
});

describe('确定性', () => {
  /** 已加载区块的全部光照，按区块坐标排好，每格天光在高 4 位、方块光在低 4 位，与光照数组同样排布。 */
  function lightBytes(core: GameCore): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    const coords = core.loadedChunks().sort((a, b) => a.cx - b.cx || a.cz - b.cz);
    for (const { cx, cz } of coords) {
      const bytes = new Uint8Array(CHUNK_AREA * WORLD_HEIGHT);
      let i = 0;
      for (let y = WORLD_MIN_Y; y <= WORLD_MAX_Y; y++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const x = cx * CHUNK_SIZE + lx;
            const z = cz * CHUNK_SIZE + lz;
            bytes[i++] = (core.skyLightAt(x, y, z) << 4) | core.blockLightAt(x, y, z);
          }
        }
      }
      result.set(`${cx},${cz}`, bytes);
    }
    return result;
  }

  /** 同一串指令：在真实地形上随机放与挖，再往前走过几个区块边界（加载与卸载都会发生），再改一轮。 */
  function run(): GameCore {
    const core = new GameCore({ viewRadius: 1 });
    const random = seededRandom(7);
    const blocks = [BlockType.Air, BlockType.Stone, BlockType.OakLeaves];
    const edit = (): void => {
      for (let n = 0; n < 60; n++) {
        const { x, z } = core.player.position;
        const bx = Math.floor(x) + Math.floor(random() * 24) - 12;
        const bz = Math.floor(z) + Math.floor(random() * 24) - 12;
        const by = core.highestBlockY(bx, bz) - 2 + Math.floor(random() * 8);
        core.setBlock(bx, by, bz, blocks[Math.floor(random() * blocks.length)]);
      }
    };
    edit();
    core.setMoveIntent({ ...IDLE_INTENT, forward: true });
    core.tick(300);
    core.setMoveIntent(IDLE_INTENT);
    edit();
    core.tick(20);
    return core;
  }

  it('同一种子、同一指令序列两次运行，所有已加载区块的光照逐字节相同', () => {
    const first = run();
    const second = run();
    // 走出过原点区块，说明这串指令确实经过了卸载与重新加载
    expect(first.playerChunk).not.toEqual({ cx: 0, cz: 0 });
    expect(firstDifference(lightBytes(second), lightBytes(first))).toBeUndefined();
  });
});

describe('工作量（计访问格数，不计时）', () => {
  it('平地区块的初值只做竖直填充与一次边界传播', () => {
    const world = new World(flatTestTerrain);
    // 先把 8 个邻居都加载好：中间那个区块加载时四条边都要与邻居互传
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) if (cx !== 0 || cz !== 0) world.loadChunk(cx, cz);
    }
    const before = world.lightVisits;
    world.loadChunk(0, 0);
    const visits = world.lightVisits - before;

    // 竖直填充：每一列从世界顶上往下走到地表那一格
    const vertical = CHUNK_AREA * (WORLD_MAX_Y - G + 1);
    // 一次边界传播：每一列检查一次要不要往外传，加上四条边上邻居那一侧的列从地表往下各走一遍
    const boundary = CHUNK_AREA + 4 * CHUNK_SIZE * (G - WORLD_MIN_Y + 1);
    expect(visits).toBeGreaterThanOrEqual(vertical);
    expect(visits).toBeLessThanOrEqual(vertical + boundary);
    // 结果仍然正确
    expect(world.skyLightAt(5, G + 1, 5)).toBe(15);
    expect(world.skyLightAt(5, G, 5)).toBe(0);
  });
});
