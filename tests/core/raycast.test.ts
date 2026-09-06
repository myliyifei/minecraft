import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { raycastBlocks } from '../../src/core/raycast';
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

  it('树叶挡得住视线：非空气就是目标，不看透不透光', () => {
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
