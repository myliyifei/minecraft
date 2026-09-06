import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import {
  DROP_LIFETIME_TICKS,
  DROP_SIZE,
  Drops,
  PICKUP_DELAY_TICKS,
  PICKUP_MARGIN,
} from '../../src/core/drop';
import { INVENTORY_SIZE, Inventory } from '../../src/core/inventory';
import { DEFAULT_STACK_SIZE, ItemType, type ItemSink, type ItemStack } from '../../src/core/item';
import { hitboxAt, type Hitbox } from '../../src/core/physics';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/core/player';
import type { World } from '../../src/core/world';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTestWorld } from '../helpers/flat-terrain';

/** 一堆泥土。 */
const ONE_DIRT: ItemStack = { item: ItemType.Dirt, count: 1 };

/** 掉落物落在平地上时的落点：地表方块的顶面。 */
const RESTING_Y = FLAT_STAND_Y;

/** 玩家站在 (x, z) 那一格中心时的碰撞箱。 */
function playerAt(x: number, z: number): Hitbox {
  return hitboxAt({ x, y: FLAT_STAND_Y, z }, PLAYER_WIDTH, PLAYER_HEIGHT);
}

/** 远得吸不到任何掉落物的玩家。 */
const FAR_AWAY = playerAt(40, 40);

/** 什么都收不下的背包：拾取那条路因此走不通。 */
const FULL_SINK: ItemSink = { add: (stack) => stack.count };

/** 掉落物集合加它脚下的世界。种子固定，初速度因此每次都一样。 */
function dropsOnFlatGround(seed = 1234): { world: World; drops: Drops } {
  const world = flatTestWorld();
  return { world, drops: new Drops(world, seed) };
}

/** 推进 n 个 tick，不带玩家。 */
function idle(drops: Drops, ticks: number, into: ItemSink = FULL_SINK): void {
  for (let i = 0; i < ticks; i++) drops.step(FAR_AWAY, into);
}

/** 推进 n 个 tick，玩家站在给定的碰撞箱里。 */
function nearby(drops: Drops, collector: Hitbox, ticks: number, into: ItemSink): void {
  for (let i = 0; i < ticks; i++) drops.step(collector, into);
}

describe('掉落物的生成', () => {
  it('在一格里生成的掉落物落在那一格的中心附近', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 3, FLAT_STAND_Y, -2);

    expect(drops.count).toBe(1);
    const [drop] = drops.all();
    expect(drop).toBeDefined();
    expect(drop!.item).toBe(ItemType.Dirt);
    expect(drop!.count).toBe(1);
    // 碰撞箱的中心落在那一格的中心：底面因此比格底高半个箱高
    expect(drop!.position.x).toBeCloseTo(3.5, 10);
    expect(drop!.position.z).toBeCloseTo(-1.5, 10);
    expect(drop!.position.y).toBeCloseTo(FLAT_STAND_Y + 0.5 - DROP_SIZE / 2, 10);
  });

  it('每个掉落物有自己的编号，渲染层据此认得出哪个是哪个', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);
    const ids = drops.all().map((drop) => drop.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('同一格同时掉出两个，水平初速度把它们分开', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);

    idle(drops, 20);
    const [a, b] = drops.all();
    expect(a!.position).not.toEqual(b!.position);
  });

  it('同一个种子与同一格给出同一条轨迹', () => {
    const walk = (): number[] => {
      const { drops } = dropsOnFlatGround(777);
      drops.spawnInBlock(ONE_DIRT, 5, FLAT_STAND_Y + 6, 5);
      idle(drops, 30);
      const [drop] = drops.all();
      return [drop!.position.x, drop!.position.y, drop!.position.z];
    };
    expect(walk()).toEqual(walk());
  });
});

describe('掉落物的物理', () => {
  it('从空中生成的掉落物落到地面后停住', () => {
    const { drops } = dropsOnFlatGround();
    const spawnY = FLAT_STAND_Y + 12;
    drops.spawnInBlock(ONE_DIRT, 0, spawnY, 0);

    idle(drops, 60);
    const [drop] = drops.all();
    // 停在地表方块的顶面上，不是嵌进去也不是浮在半空
    expect(drop!.position.y).toBe(RESTING_Y);

    // 「停住」是真的不动了，不是慢慢挪：再走 20 tick 位置一个数都不变
    const settled = drop!.position;
    idle(drops, 20);
    expect(drops.all()[0]!.position).toEqual(settled);
    expect(drop!.previousPosition).toEqual(settled);
  });

  it('落下来的过程中位置逐 tick 变化，且不穿过地面', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y + 12, 0);

    const heights: number[] = [];
    for (let i = 0; i < 40; i++) {
      idle(drops, 1);
      heights.push(drops.all()[0]!.position.y);
    }
    // 一路往下，最低不过地表顶面
    expect(heights[0]!).toBeGreaterThan(heights[5]!);
    expect(Math.min(...heights)).toBe(RESTING_Y);
  });

  it('落进一格宽的竖井里，被井壁挡住而不是穿墙出去', () => {
    const { world, drops } = dropsOnFlatGround();
    // 在平地上凿一口一格宽、十格深的竖井。掉这么长一段，水平初速度攒下的位移
    // （空中阻力只有 0.98）远超半格，掉落物一定会顶到井壁上。
    const bottom = FLAT_GROUND_Y - 10;
    for (let y = FLAT_GROUND_Y; y > bottom; y--) world.setBlock(0, y, 0, BlockType.Air);
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_GROUND_Y, 0);

    idle(drops, 80);
    const { position } = drops.all()[0]!;
    // 落到井底
    expect(position.y).toBe(bottom + 1);
    // 整个碰撞箱都还在那一格之内：没有一个角穿进井壁
    const half = DROP_SIZE / 2;
    expect(position.x - half).toBeGreaterThanOrEqual(0);
    expect(position.x + half).toBeLessThanOrEqual(1);
    expect(position.z - half).toBeGreaterThanOrEqual(0);
    expect(position.z + half).toBeLessThanOrEqual(1);
  });

  it('previousPosition 是上一个 tick 的位置，渲染层据此插值', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y + 12, 0);
    idle(drops, 3);

    const before = drops.all()[0]!.position;
    idle(drops, 1);
    const drop = drops.all()[0]!;
    expect(drop.previousPosition).toEqual(before);
    expect(drop.position).not.toEqual(before);
  });
});

describe('掉落物的拾取', () => {
  it('生成后前 10 tick 内玩家靠近也不拾取', () => {
    expect(PICKUP_DELAY_TICKS).toBe(10);

    const { drops } = dropsOnFlatGround();
    const inventory = new Inventory();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);
    const player = playerAt(0.5, 0.5);

    nearby(drops, player, PICKUP_DELAY_TICKS, inventory);
    expect(drops.count).toBe(1);
    expect(inventory.slot(0)).toBeUndefined();

    // 延迟一过就被吸走
    nearby(drops, player, 1, inventory);
    expect(drops.count).toBe(0);
    expect(inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('吸入范围是碰撞箱外一格：隔半格吸得到，隔一格半吸不到', () => {
    // 「玩家碰撞箱扩大约 1 格内吸入」来自 issue #8
    expect(PICKUP_MARGIN).toBe(1);

    const { drops } = dropsOnFlatGround();
    const inventory = new Inventory();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);

    // 先让它落定，位置固定了下面的距离才是准的
    idle(drops, 40);
    const at = drops.all()[0]!.position;

    /**
     * 站在掉落物 +X 一侧、两个碰撞箱之间正好隔 `gap` 格时的玩家碰撞箱。
     *
     * 间距写成字面值而不是从 `PICKUP_MARGIN` 算：拿实现的常量摆位置的话，这个常量
     * 改成 0 或 2 测试也照样通过——要钉住的正是「约 1 格」这个数。
     */
    const playerWithGap = (gap: number): Hitbox =>
      playerAt(at.x + DROP_SIZE / 2 + gap + PLAYER_WIDTH / 2, at.z);

    // 隔一格半：超出吸入范围
    nearby(drops, playerWithGap(1.5), 20, inventory);
    expect(drops.count).toBe(1);
    expect(inventory.slot(0)).toBeUndefined();

    // 隔半格：吸得到
    nearby(drops, playerWithGap(0.5), 1, inventory);
    expect(drops.count).toBe(0);
    expect(inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('65 个泥土吸进背包变成一堆 64 加一堆 1', () => {
    const { drops } = dropsOnFlatGround();
    const inventory = new Inventory();
    drops.spawnInBlock({ item: ItemType.Dirt, count: 65 }, 0, FLAT_STAND_Y, 0);

    nearby(drops, playerAt(0.5, 0.5), PICKUP_DELAY_TICKS + 1, inventory);
    expect(drops.count).toBe(0);
    expect(inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: DEFAULT_STACK_SIZE });
    expect(inventory.slot(1)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('背包 36 格全满时掉落物留在世界里', () => {
    const { drops } = dropsOnFlatGround();
    const inventory = new Inventory();
    inventory.add({ item: ItemType.Dirt, count: INVENTORY_SIZE * DEFAULT_STACK_SIZE });
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);

    nearby(drops, playerAt(0.5, 0.5), 100, inventory);
    expect(drops.count).toBe(1);
    expect(drops.all()[0]!.count).toBe(1);
  });

  it('背包只装得下一部分时，掉落物留下剩的那些', () => {
    const { drops } = dropsOnFlatGround();
    const inventory = new Inventory();
    // 只剩最后一格的 2 个空位
    inventory.add({ item: ItemType.Dirt, count: INVENTORY_SIZE * DEFAULT_STACK_SIZE - 2 });
    drops.spawnInBlock({ item: ItemType.Dirt, count: 5 }, 0, FLAT_STAND_Y, 0);

    nearby(drops, playerAt(0.5, 0.5), PICKUP_DELAY_TICKS + 1, inventory);
    expect(drops.count).toBe(1);
    expect(drops.all()[0]!.count).toBe(3);
  });
});

describe('掉落物的存活时间', () => {
  it('6000 tick 后消失', () => {
    expect(DROP_LIFETIME_TICKS).toBe(6000);

    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);

    idle(drops, DROP_LIFETIME_TICKS - 1);
    expect(drops.count).toBe(1);

    idle(drops, 1);
    expect(drops.count).toBe(0);
  });

  it('存活 tick 数逐 tick 累加', () => {
    const { drops } = dropsOnFlatGround();
    drops.spawnInBlock(ONE_DIRT, 0, FLAT_STAND_Y, 0);
    expect(drops.all()[0]!.age).toBe(0);

    idle(drops, 7);
    expect(drops.all()[0]!.age).toBe(7);
  });
});
