import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { hitboxAt } from '../../src/core/physics';
import { raycastBlocks, raycastBox } from '../../src/core/raycast';
import type { Vec3 } from '../../src/core/vec3';
import type { World } from '../../src/core/world';
import {
  AIM_EYE as EYE,
  AIM_LAYER_Y as LAYER_Y,
  unit,
  worldWithBlocks,
  type BlockCoord,
} from '../helpers/aiming';
import { flatTestWorld } from '../helpers/flat-terrain';

/** 够远，不会碍着「命中哪一格」这类断言。 */
const FAR = 100;

/** 摆好几块石头的平地世界。射线检测只看「是不是空气」，摆哪种方块都一样。 */
function worldWith(...blocks: BlockCoord[]): World {
  return worldWithBlocks(...blocks.map((at) => [at, BlockType.Stone] as [BlockCoord, BlockType]));
}

describe('体素射线检测的命中', () => {
  it('命中视线上第一个非空气方块，报出方块坐标与进入面', () => {
    const world = worldWith([4, LAYER_Y, 0], [6, LAYER_Y, 0]);
    const hit = raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, FAR);
    expect(hit).toEqual({
      x: 4,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
      // 起点在格中心，进入面在 x = 4 上
      distance: 3.5,
    });
  });

  it('六个方向各报出对应的进入面', () => {
    const faces: Array<[Vec3, Vec3]> = [
      [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
      ],
      [
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ],
      [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: -1, z: 0 },
      ],
      [
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      [
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: -1 },
      ],
      [
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 0, z: 1 },
      ],
    ];
    for (const [direction, normal] of faces) {
      const target: BlockCoord = [
        Math.floor(EYE.x) + direction.x * 3,
        LAYER_Y + direction.y * 3,
        Math.floor(EYE.z) + direction.z * 3,
      ];
      const hit = raycastBlocks(worldWith(target), EYE, direction, FAR);
      expect(hit, `朝 ${JSON.stringify(direction)} 看`).toMatchObject({
        x: target[0],
        y: target[1],
        z: target[2],
        normal,
      });
    }
  });

  it('树叶挡得住视线：非空气就是目标，不看是不是不透明', () => {
    const world = flatTestWorld();
    world.setBlock(3, LAYER_Y, 0, BlockType.OakLeaves);
    world.setBlock(5, LAYER_Y, 0, BlockType.Stone);
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, FAR)).toMatchObject({ x: 3 });
  });

  it('斜着看不会从两格的公共角漏过去', () => {
    // 起点在 (0, 0) 格中心，方块摆在 (1, 0)：45° 的射线正好压在两条格边界上。
    // 按固定小步长采样会从 (0, 0) 一步跨到 (1, 1)，把这一格整个跳过。
    const world = worldWith([1, LAYER_Y, 0]);
    const hit = raycastBlocks(world, EYE, unit({ x: 1, y: 0, z: 1 }), FAR);
    expect(hit).toMatchObject({ x: 1, y: LAYER_Y, z: 0 });
  });

  it('一路是空气时没有目标', () => {
    expect(raycastBlocks(flatTestWorld(), EYE, { x: 1, y: 0, z: 0 }, FAR)).toBeUndefined();
  });

  it('零方向向量没有目标', () => {
    const world = worldWith([4, LAYER_Y, 0]);
    expect(raycastBlocks(world, EYE, { x: 0, y: 0, z: 0 }, FAR)).toBeUndefined();
  });

  it('起点已经埋在方块里时没有目标', () => {
    const world = worldWith([0, LAYER_Y, 0], [4, LAYER_Y, 0]);
    // 起点那一格实心，视线没有进入面可报；不能穿过去报墙后面那块
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, FAR)).toBeUndefined();
  });
});

describe('体素射线检测的最远距离', () => {
  it('进入面正好落在最远距离上算命中', () => {
    const world = worldWith([4, LAYER_Y, 0]);
    // 进入面在 x = 4，起点 x = 0.5，距离 3.5
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, 3.5)).toMatchObject({ x: 4 });
  });

  it('进入面差一点点超出最远距离就不是目标', () => {
    const world = worldWith([4, LAYER_Y, 0]);
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, 3.5 - 1e-6)).toBeUndefined();
  });

  it('近处那块在范围内、远处那块超出范围时，命中近的', () => {
    const world = worldWith([2, LAYER_Y, 0], [9, LAYER_Y, 0]);
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, 4.5)).toMatchObject({ x: 2 });
  });

  it('只有远处那块时超出范围就没有目标', () => {
    const world = worldWith([9, LAYER_Y, 0]);
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, 4.5)).toBeUndefined();
  });
});

describe('射线与碰撞箱求交', () => {
  /** 原点前方 −Z 上一个 0.6 × 1.95 的碰撞箱，正面在 z = −1.7，背面在 z = −2.3。 */
  const BOX = hitboxAt({ x: 0, y: -1, z: -2 }, 0.6, 1.95);
  const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
  const AHEAD: Vec3 = { x: 0, y: 0, z: -1 };

  it('正对着：距离是到正面的距离', () => {
    expect(raycastBox(ORIGIN, AHEAD, BOX, 3)).toBeCloseTo(1.7, 12);
  });

  it('最远距离含端点：正好够到算碰到，差一点不算', () => {
    expect(raycastBox(ORIGIN, AHEAD, BOX, 1.7)).toBeCloseTo(1.7, 12);
    expect(raycastBox(ORIGIN, AHEAD, BOX, 1.69)).toBeUndefined();
  });

  it('背对着、从旁边擦过：碰不到', () => {
    expect(raycastBox(ORIGIN, { x: 0, y: 0, z: 1 }, BOX, 10)).toBeUndefined();
    expect(raycastBox({ x: 0.31, y: 0, z: 0 }, AHEAD, BOX, 10)).toBeUndefined();
    expect(raycastBox({ x: 0, y: 1, z: 0 }, AHEAD, BOX, 10)).toBeUndefined();
  });

  it('斜着看：进入面换成侧面', () => {
    // 从 (1, 0, −2) 沿 −X 看，先碰到 x = 0.3 那一面
    expect(raycastBox({ x: 1, y: 0, z: -2 }, { x: -1, y: 0, z: 0 }, BOX, 3)).toBeCloseTo(0.7, 12);
    const diagonal = { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 };
    // 从 (−2, 0, 0) 斜着朝 +X −Z 走，在 x = −0.3、z = −1.7 那条棱附近进入
    const distance = raycastBox({ x: -2, y: 0, z: 0 }, diagonal, BOX, 5);
    expect(distance).toBeDefined();
    expect(distance!).toBeCloseTo(1.7 * Math.SQRT2, 12);
  });

  it('起点在碰撞箱里面：距离 0', () => {
    expect(raycastBox({ x: 0, y: 0, z: -2 }, AHEAD, BOX, 3)).toBe(0);
  });
});

describe('火把只有细杆挡视线（#56）', () => {
  /** 细杆截面边长与高度：2/16 与 10/16；墙上火把底部抬高 3/16。 */
  const HALF = 1 / 16;
  const HEIGHT = 10 / 16;
  const LIFT = 3 / 16;
  /**
   * 墙上火把（#57）：细杆以底面中心为轴、往离开墙的方向斜 22.5°，盒子是斜杆的外包盒。底面中心离墙 1/16，
   * 所以盒子朝外那一面离墙 1/16 + 1/16·cos + 10/16·sin，底与顶各被斜过的截面带出 1/16·sin。
   */
  const TILT = Math.PI / 8;
  const WALL_OUT = HALF + HALF * Math.cos(TILT) + HEIGHT * Math.sin(TILT);
  const WALL_BOTTOM = LIFT - HALF * Math.sin(TILT);
  const WALL_TOP = LIFT + HEIGHT * Math.cos(TILT) + HALF * Math.sin(TILT);

  it('地面火把：正对细杆命中火把那一格，命中面是细杆那一面，距离到细杆表面', () => {
    const world = worldWithBlocks([[2, LAYER_Y, 0], BlockType.Torch], [[4, LAYER_Y, 0], BlockType.Stone]);
    const hit = raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, FAR);
    expect(hit).toMatchObject({ x: 2, y: LAYER_Y, z: 0, normal: { x: -1, y: 0, z: 0 } });
    // 细杆的 −X 面在 x = 2.5 − 1/16
    expect(hit!.distance).toBeCloseTo(2.5 - HALF - EYE.x, 12);
  });

  it('地面火把：从细杆上方穿过这一格，命中后面那块石头', () => {
    const world = worldWithBlocks([[2, LAYER_Y, 0], BlockType.Torch], [[4, LAYER_Y, 0], BlockType.Stone]);
    const above = { ...EYE, y: LAYER_Y + HEIGHT + 0.1 };
    expect(raycastBlocks(world, above, { x: 1, y: 0, z: 0 }, FAR)).toEqual({
      x: 4,
      y: LAYER_Y,
      z: 0,
      normal: { x: -1, y: 0, z: 0 },
      distance: 3.5,
    });
    // 从细杆旁边擦过（z 偏出截面）也一样
    const aside = { ...EYE, z: 0.5 + HALF + 0.05 };
    expect(raycastBlocks(world, aside, { x: 1, y: 0, z: 0 }, FAR)).toMatchObject({ x: 4 });
  });

  it('地面火把：从上往下看命中细杆顶面', () => {
    const world = worldWithBlocks([[2, LAYER_Y, 0], BlockType.Torch]);
    const hit = raycastBlocks(world, { x: 2.5, y: LAYER_Y + 3.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, FAR);
    expect(hit).toMatchObject({ x: 2, y: LAYER_Y, z: 0, normal: { x: 0, y: 1, z: 0 } });
    expect(hit!.distance).toBeCloseTo(3.5 - HEIGHT, 12);
  });

  it('墙上火把：细杆贴着墙那一侧、底部抬高，盒子包住整根斜杆，命中面是盒子朝外那一面', () => {
    // 贴在 −X 侧墙上：盒子 x 到 2 + WALL_OUT
    const world = worldWithBlocks([[2, LAYER_Y, 0], BlockType.WallTorchNegX]);
    const from = { x: 4.5, y: LAYER_Y + 0.5, z: 0.5 };
    const hit = raycastBlocks(world, from, { x: -1, y: 0, z: 0 }, FAR);
    expect(hit).toMatchObject({ x: 2, y: LAYER_Y, z: 0, normal: { x: 1, y: 0, z: 0 } });
    expect(hit!.distance).toBeCloseTo(4.5 - (2 + WALL_OUT), 12);
    // 低于盒底：穿过去，后面什么都没有
    const below = { ...from, y: LAYER_Y + WALL_BOTTOM - 0.05 };
    expect(raycastBlocks(world, below, { x: -1, y: 0, z: 0 }, FAR)).toBeUndefined();
    // 高于盒顶同样穿过
    const over = { ...from, y: LAYER_Y + WALL_TOP + 0.05 };
    expect(raycastBlocks(world, over, { x: -1, y: 0, z: 0 }, FAR)).toBeUndefined();
  });

  it('墙上火把：从侧面平视细杆上半段（离墙 4/16、高 10/16 处）也命中火把，不穿到后面的方块', () => {
    // 斜杆的上半段离墙超过 2/16：只按竖直细杆算盒子的话，这条视线会穿过去打到 z = 2 的石头
    const world = worldWithBlocks([[0, LAYER_Y, 0], BlockType.WallTorchNegX], [[0, LAYER_Y, 2], BlockType.Stone]);
    const hit = raycastBlocks(world, { x: 0.25, y: LAYER_Y + 0.65, z: -2 }, { x: 0, y: 0, z: 1 }, FAR);
    expect(hit).toMatchObject({ x: 0, y: LAYER_Y, z: 0, normal: { x: 0, y: 0, z: -1 } });
  });

  it('四面墙上火把的细杆各贴着自己那一侧的墙', () => {
    // 视线都从墙的对面、离火把格 1.5 格处平视过去：盒子贴墙，所以要走完这一格的 1 − WALL_OUT 才碰到它
    const cases: Array<[BlockType, Vec3, Vec3]> = [
      // [编号, 视线起点, 期望的命中面]
      [BlockType.WallTorchNegX, { x: 4.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }],
      [BlockType.WallTorchPosX, { x: 0.5, y: 0.5, z: 0.5 }, { x: -1, y: 0, z: 0 }],
      [BlockType.WallTorchNegZ, { x: 2.5, y: 0.5, z: 2.5 }, { x: 0, y: 0, z: 1 }],
      [BlockType.WallTorchPosZ, { x: 2.5, y: 0.5, z: -1.5 }, { x: 0, y: 0, z: -1 }],
    ];
    for (const [block, offset, normal] of cases) {
      const world = worldWithBlocks([[2, LAYER_Y, 0], block]);
      const from = { x: offset.x, y: LAYER_Y + offset.y, z: offset.z };
      const toward = { x: -normal.x, y: 0, z: -normal.z };
      const hit = raycastBlocks(world, from, toward, FAR);
      expect(hit, `编号 ${block}`).toMatchObject({ x: 2, y: LAYER_Y, z: 0, normal });
      expect(hit!.distance, `编号 ${block}`).toBeCloseTo(1.5 + 1 - WALL_OUT, 12);
    }
  });

  it('眼睛在火把那一格里：背对细杆接着往前走，转身看它命中这一格', () => {
    // 贴在 −X 侧墙上：盒子 x 到 WALL_OUT，眼睛在格中心
    const world = worldWithBlocks([[0, LAYER_Y, 0], BlockType.WallTorchNegX], [[4, LAYER_Y, 0], BlockType.Stone]);
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, FAR)).toMatchObject({ x: 4, distance: 3.5 });
    const hit = raycastBlocks(world, EYE, { x: -1, y: 0, z: 0 }, FAR);
    expect(hit).toMatchObject({ x: 0, y: LAYER_Y, z: 0, normal: { x: 1, y: 0, z: 0 } });
    expect(hit!.distance).toBeCloseTo(0.5 - WALL_OUT, 12);
  });

  it('眼睛就在细杆里面：报不出进入面，这一格不算目标', () => {
    const world = worldWithBlocks([[0, LAYER_Y, 0], BlockType.Torch], [[4, LAYER_Y, 0], BlockType.Stone]);
    expect(raycastBlocks(world, { ...EYE, y: LAYER_Y + 0.3 }, { x: 1, y: 0, z: 0 }, FAR)).toMatchObject({ x: 4 });
  });

  it('细杆在最远距离之外：没有目标', () => {
    const world = worldWithBlocks([[2, LAYER_Y, 0], BlockType.Torch]);
    // 进入这一格时距离 1.5，细杆表面在 1.9375
    expect(raycastBlocks(world, EYE, { x: 1, y: 0, z: 0 }, 1.9)).toBeUndefined();
  });
});
