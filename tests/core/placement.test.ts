import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { WORLD_MAX_Y } from '../../src/core/constants';
import { Inventory } from '../../src/core/inventory';
import { ItemType, type Hand, type ItemStack } from '../../src/core/item';
import { hitboxAt, type Hitbox } from '../../src/core/physics';
import { placeBlock } from '../../src/core/placement';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/core/player';
import type { BlockHit } from '../../src/core/raycast';
import type { Vec3 } from '../../src/core/vec3';
import type { World } from '../../src/core/world';
import {
  AIM_LAYER_Y as LAYER_Y,
  worldWithBlocks as worldWith,
  type BlockCoord,
} from '../helpers/aiming';
import { FLAT_STAND_Y } from '../helpers/flat-terrain';

/** 目标方块：瞄准层里的一格。 */
const TARGET: BlockCoord = [3, LAYER_Y, 0];

/** 六个面的外法线，加上一个好读的名字。 */
const NORMALS: Array<[string, Vec3]> = [
  ['+X', { x: 1, y: 0, z: 0 }],
  ['−X', { x: -1, y: 0, z: 0 }],
  ['+Y', { x: 0, y: 1, z: 0 }],
  ['−Y', { x: 0, y: -1, z: 0 }],
  ['+Z', { x: 0, y: 0, z: 1 }],
  ['−Z', { x: 0, y: 0, z: -1 }],
];

/**
 * 玩家站在平地上的碰撞箱。瞄准层在它头顶好几格，除了专门测碰撞的用例，
 * 谁都不会跟新方块撞上。
 */
const STANDING: Hitbox = hitboxAt({ x: 0.5, y: FLAT_STAND_Y, z: 0.5 }, PLAYER_WIDTH, PLAYER_HEIGHT);

/**
 * 命中某一格的某个面。
 *
 * `distance` 随便给一个：放置不看它——触及距离由投射线那一步管（ADR-0006），
 * 射线本身只到 `PLAYER_REACH`，所以有目标就说明在触及距离内。
 */
function hitOn(at: BlockCoord, normal: Vec3): BlockHit {
  return { x: at[0], y: at[1], z: at[2], normal, distance: 1 };
}

/**
 * 命中面外侧那一格，也就是新方块该落在哪里。
 *
 * 这里自己算一遍，不调 `blockOutsideFace`：那正是被测的那一步，用它算期望值的话
 * 法向搞错了符号这条测试也照样绿。
 */
function outsideOf(at: BlockCoord, normal: Vec3): BlockCoord {
  return [at[0] + normal.x, at[1] + normal.y, at[2] + normal.z];
}

function dirt(count: number): ItemStack {
  return { item: ItemType.Dirt, count };
}

interface Setup {
  readonly world: World;
  readonly inventory: Inventory;
  /** 按一次右键：试着放一块，返回放下了没有。 */
  place(): boolean;
  /** 换成瞄着别处，或者什么都没瞄（undefined）。 */
  aimAt(hit: BlockHit | undefined): void;
}

/**
 * 一套放置的现场：目标方块摆好、手上拿着东西、玩家站在远处。
 * 手上那一堆走真的 `Inventory`（进背包与扣数量因此是真的那一份逻辑），
 * 只有「手上不是方块物品」那条用假的手。
 */
function setup(
  options: {
    readonly held?: ItemStack;
    readonly hand?: Hand;
    readonly body?: Hitbox;
    readonly blocks?: Array<[BlockCoord, BlockType]>;
  } = {},
): Setup {
  const world = worldWith(...(options.blocks ?? [[TARGET, BlockType.Stone]]));
  const inventory = new Inventory();
  if (options.held) inventory.add(options.held);

  let target: BlockHit | undefined = hitOn(TARGET, { x: -1, y: 0, z: 0 });
  const aim = {
    get target(): BlockHit | undefined {
      return target;
    },
  };
  const body = { hitbox: options.body ?? STANDING };
  const hand = options.hand ?? inventory;

  return {
    world,
    inventory,
    place: () => placeBlock(world, aim, body, hand),
    aimAt: (hit) => {
      target = hit;
    },
  };
}

describe('放置的落点', () => {
  for (const [name, normal] of NORMALS) {
    it(`对着目标的 ${name} 面放置，新方块落在那一面外侧那一格`, () => {
      const { world, place, aimAt } = setup({ held: dirt(1) });
      aimAt(hitOn(TARGET, normal));

      expect(place()).toBe(true);
      expect(world.getBlock(...outsideOf(TARGET, normal))).toBe(BlockType.Dirt);
      // 目标那一格自己不动——放置不是替换
      expect(world.getBlock(...TARGET)).toBe(BlockType.Stone);
    });
  }

  it('放下的是手上那种物品对应的方块', () => {
    const { world, place } = setup({ held: { item: ItemType.OakLog, count: 1 } });
    expect(place()).toBe(true);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.OakLog);
  });
});

describe('放不下去的情形', () => {
  it('什么都没瞄准时放不下', () => {
    const { world, inventory, place, aimAt } = setup({ held: dirt(1) });
    aimAt(undefined);

    expect(place()).toBe(false);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    expect(inventory.held).toEqual(dirt(1));
  });

  it('那一格已经有方块时放不下', () => {
    const filled: BlockCoord = [2, LAYER_Y, 0];
    const { world, inventory, place } = setup({
      held: dirt(1),
      blocks: [
        [TARGET, BlockType.Stone],
        [filled, BlockType.Stone],
      ],
    });

    expect(place()).toBe(false);
    expect(world.getBlock(...filled)).toBe(BlockType.Stone);
    expect(inventory.held).toEqual(dirt(1));
  });

  it('新方块会与玩家碰撞箱交叠时放不下', () => {
    // 新方块落在 [2, LAYER_Y, 0]，玩家就站在那一格里
    const { world, inventory, place } = setup({
      held: dirt(1),
      body: hitboxAt({ x: 2.5, y: LAYER_Y, z: 0.5 }, PLAYER_WIDTH, PLAYER_HEIGHT),
    });

    expect(place()).toBe(false);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    expect(inventory.held).toEqual(dirt(1));
  });

  it('紧贴玩家侧面的那一格放得下', () => {
    // 碰撞箱的 +X 面正好落在 x = 2，也就是新方块那一格的 −X 面上。相切不算交叠，
    // 否则贴着墙站着就放不了脚边那一块——原版放得了。
    const { world, place } = setup({
      held: dirt(1),
      body: hitboxAt({ x: 2 - PLAYER_WIDTH / 2, y: LAYER_Y, z: 0.5 }, PLAYER_WIDTH, PLAYER_HEIGHT),
    });

    expect(place()).toBe(true);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Dirt);
  });

  it('选中格是空的时候放不下', () => {
    const { world, place } = setup();
    expect(place()).toBe(false);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
  });

  it('手上不是方块物品时放不下', () => {
    // 本切片的两种物品都放得下去，所以这条规则只能拿一个还不存在的物品编号来钉。
    // 等镐子那类物品落地，把这里换成真的工具。
    const notABlock = 99 as ItemType;
    let taken = 0;
    const { world, place } = setup({
      hand: {
        held: { item: notABlock, count: 1 },
        takeOne: () => {
          taken++;
        },
      },
    });

    expect(place()).toBe(false);
    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Air);
    expect(taken).toBe(0);
  });

  it('世界高度之外放不下，手持的那一堆也不会少', () => {
    const top: BlockCoord = [3, WORLD_MAX_Y, 0];
    const { world, inventory, place, aimAt } = setup({
      held: dirt(1),
      blocks: [[top, BlockType.Stone]],
    });
    aimAt(hitOn(top, { x: 0, y: 1, z: 0 }));

    expect(place()).toBe(false);
    expect(world.getBlock(3, WORLD_MAX_Y + 1, 0)).toBe(BlockType.Air);
    expect(inventory.held).toEqual(dirt(1));
  });
});

describe('放置消耗手上的方块', () => {
  it('放一块，手上那一堆少一个', () => {
    const { inventory, place } = setup({ held: dirt(3) });
    expect(place()).toBe(true);
    expect(inventory.held).toEqual(dirt(2));
  });

  it('最后一个放出去之后那一格清空', () => {
    const { inventory, place, aimAt } = setup({ held: dirt(1) });
    expect(place()).toBe(true);
    expect(inventory.held).toBeUndefined();
    expect(inventory.slot(0)).toBeUndefined();

    // 手上没东西了，再按也放不出第二块
    aimAt(hitOn(TARGET, { x: 0, y: 1, z: 0 }));
    expect(place()).toBe(false);
  });

  it('连着放两块，数量减两个', () => {
    const { world, inventory, place, aimAt } = setup({ held: dirt(5) });
    place();
    aimAt(hitOn(TARGET, { x: 0, y: 1, z: 0 }));
    place();

    expect(world.getBlock(2, LAYER_Y, 0)).toBe(BlockType.Dirt);
    expect(world.getBlock(3, LAYER_Y + 1, 0)).toBe(BlockType.Dirt);
    expect(inventory.held).toEqual(dirt(3));
  });
});
