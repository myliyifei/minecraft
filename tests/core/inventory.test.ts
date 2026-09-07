import { describe, expect, it } from 'vitest';
import {
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  Inventory,
  wrapHotbarSlot,
  type InventoryView,
} from '../../src/core/inventory';
import { ItemType, stackLimit } from '../../src/core/item';

/** 一堆泥土。 */
function dirt(count: number): { item: ItemType; count: number } {
  return { item: ItemType.Dirt, count };
}

/** 一堆原木。 */
function logs(count: number): { item: ItemType; count: number } {
  return { item: ItemType.OakLog, count };
}

/** 非空格子的下标与内容，好写成一条断言。 */
function filledSlots(inventory: InventoryView): Array<[number, ItemType, number]> {
  const out: Array<[number, ItemType, number]> = [];
  for (let i = 0; i < inventory.size; i++) {
    const stack = inventory.slot(i);
    if (stack) out.push([i, stack.item, stack.count]);
  }
  return out;
}

describe('背包的格局', () => {
  it('36 格，前 9 格是快捷栏', () => {
    // 数字来自 issue #8：0–8 快捷栏、9–35 背包
    expect(INVENTORY_SIZE).toBe(36);
    expect(HOTBAR_SIZE).toBe(9);

    const inventory = new Inventory();
    expect(inventory.size).toBe(36);
    expect(inventory.hotbar()).toHaveLength(9);
  });

  it('新背包每一格都是空的', () => {
    const inventory = new Inventory();
    expect(filledSlots(inventory)).toEqual([]);
    expect(inventory.hotbar().every((slot) => slot === undefined)).toBe(true);
  });

  it('越界的下标是空格，不抛异常', () => {
    const inventory = new Inventory();
    expect(inventory.slot(-1)).toBeUndefined();
    expect(inventory.slot(INVENTORY_SIZE)).toBeUndefined();
  });
});

describe('背包的单格写入', () => {
  it('写进一格能读回，写 undefined 清空那一格', () => {
    const inventory = new Inventory();
    inventory.setSlot(20, dirt(10));
    expect(inventory.slot(20)).toEqual(dirt(10));

    inventory.setSlot(20, undefined);
    expect(inventory.slot(20)).toBeUndefined();
    expect(filledSlots(inventory)).toEqual([]);
  });

  it('越界的下标不写入，格数不变', () => {
    const inventory = new Inventory();
    inventory.setSlot(-1, dirt(1));
    inventory.setSlot(INVENTORY_SIZE, dirt(1));
    expect(filledSlots(inventory)).toEqual([]);
    expect(inventory.size).toBe(INVENTORY_SIZE);
  });

  it('下标不是整数时不写入', () => {
    // 界面层是把 data 属性读成数字交过来的，读出 NaN 或小数时不能让物品掉进
    // 一个不存在的格子里——那样 36 格里找不到它，物品就凭空消失了
    const inventory = new Inventory();
    inventory.setSlot(Number.NaN, dirt(1));
    inventory.setSlot(1.5, dirt(1));
    expect(filledSlots(inventory)).toEqual([]);
    expect(inventory.size).toBe(INVENTORY_SIZE);
    // 36 格之外确实没多出一格来：读回那两个下标什么都没有
    expect(inventory.slot(Number.NaN)).toBeUndefined();
    expect(inventory.slot(1.5)).toBeUndefined();
  });
});

describe('物品进背包', () => {
  it('65 个泥土装成一堆 64 加一堆 1', () => {
    const inventory = new Inventory();
    expect(inventory.add(dirt(65))).toBe(0);
    expect(filledSlots(inventory)).toEqual([
      [0, ItemType.Dirt, 64],
      [1, ItemType.Dirt, 1],
    ]);
  });

  it('堆叠上限是 64', () => {
    // 上限写死在这里而不是从 stackLimit 反读：那样改坏数据表这条也照样通过
    expect(stackLimit(ItemType.Dirt)).toBe(64);
    expect(stackLimit(ItemType.OakLog)).toBe(64);
  });

  it('先填同种未满堆，再占空格', () => {
    const inventory = new Inventory();
    inventory.add(dirt(1));
    // 把快捷栏其余 8 格塞满原木，泥土的空格只剩背包那一侧
    inventory.add(logs(8 * 64));
    expect(inventory.slot(8)).toEqual({ item: ItemType.OakLog, count: 64 });

    inventory.add(dirt(70));
    // 已有的那一堆先被填满（1 + 63），剩下的 7 个才另起一堆
    expect(inventory.slot(0)).toEqual({ item: ItemType.Dirt, count: 64 });
    expect(inventory.slot(9)).toEqual({ item: ItemType.Dirt, count: 7 });
  });

  it('占空格时快捷栏先于背包', () => {
    const inventory = new Inventory();
    // 快捷栏 9 格填满，第 10 堆才落到背包的第一格
    inventory.add(dirt(9 * 64));
    expect(filledSlots(inventory).map(([index]) => index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    inventory.add(dirt(1));
    expect(inventory.slot(HOTBAR_SIZE)).toEqual({ item: ItemType.Dirt, count: 1 });
  });

  it('不同种的物品各占自己的堆', () => {
    const inventory = new Inventory();
    inventory.add(dirt(3));
    inventory.add(logs(5));
    expect(filledSlots(inventory)).toEqual([
      [0, ItemType.Dirt, 3],
      [1, ItemType.OakLog, 5],
    ]);
  });

  it('装满 36 格之后再来一个就放不下', () => {
    const inventory = new Inventory();
    expect(inventory.add(dirt(INVENTORY_SIZE * 64))).toBe(0);
    expect(filledSlots(inventory)).toHaveLength(INVENTORY_SIZE);

    expect(inventory.add(dirt(1))).toBe(1);
    expect(inventory.add(logs(10))).toBe(10);
  });

  it('装得下一部分时只收下那一部分', () => {
    const inventory = new Inventory();
    // 35 格满、最后一格留 1 个泥土的位置：这一格是同种未满堆，正好能收 1 个
    inventory.add(dirt(INVENTORY_SIZE * 64 - 1));
    expect(inventory.add(dirt(5))).toBe(4);
    expect(inventory.slot(INVENTORY_SIZE - 1)).toEqual({ item: ItemType.Dirt, count: 64 });
  });

  it('快捷栏读到的就是前 9 格', () => {
    const inventory = new Inventory();
    inventory.add(dirt(10 * 64));
    const hotbar = inventory.hotbar();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      expect(hotbar[i], `第 ${i} 格`).toEqual(inventory.slot(i));
    }
  });
});

describe('快捷栏的选中格', () => {
  it('新背包选中第一格，手上是空的', () => {
    const inventory = new Inventory();
    expect(inventory.selectedSlot).toBe(0);
    expect(inventory.held).toBeUndefined();
  });

  it('手持就是选中格里的那一堆', () => {
    const inventory = new Inventory();
    inventory.add(dirt(3));
    inventory.add(logs(5));
    expect(inventory.held).toEqual(dirt(3));

    inventory.select(1);
    expect(inventory.selectedSlot).toBe(1);
    expect(inventory.held).toEqual(logs(5));

    // 空格也能选中，手上就是空的
    inventory.select(2);
    expect(inventory.held).toBeUndefined();
  });

  it('下标折回快捷栏范围内，滚到头从另一端接着来', () => {
    expect(wrapHotbarSlot(0)).toBe(0);
    expect(wrapHotbarSlot(HOTBAR_SIZE - 1)).toBe(HOTBAR_SIZE - 1);
    expect(wrapHotbarSlot(HOTBAR_SIZE)).toBe(0);
    expect(wrapHotbarSlot(-1)).toBe(HOTBAR_SIZE - 1);
    expect(wrapHotbarSlot(-HOTBAR_SIZE - 1)).toBe(HOTBAR_SIZE - 1);

    const inventory = new Inventory();
    inventory.select(HOTBAR_SIZE);
    expect(inventory.selectedSlot).toBe(0);
    inventory.select(-1);
    expect(inventory.selectedSlot).toBe(HOTBAR_SIZE - 1);
  });

  it('选中格只在快捷栏里，选不到背包那一侧', () => {
    const inventory = new Inventory();
    inventory.add(dirt(10 * 64));
    // 第 9 格（背包的第一格）折回快捷栏的第一格
    inventory.select(HOTBAR_SIZE);
    expect(inventory.selectedSlot).toBe(0);
  });

  it('用掉手上的一个，数量减 1', () => {
    const inventory = new Inventory();
    inventory.add(dirt(3));
    inventory.takeOne();
    expect(inventory.held).toEqual(dirt(2));
    expect(inventory.slot(0)).toEqual(dirt(2));
  });

  it('用掉最后一个之后那一格清空', () => {
    const inventory = new Inventory();
    inventory.add(dirt(1));
    inventory.takeOne();
    expect(inventory.held).toBeUndefined();
    expect(inventory.slot(0)).toBeUndefined();
    expect(filledSlots(inventory)).toEqual([]);
  });

  it('空手时用掉一个什么都不发生', () => {
    const inventory = new Inventory();
    inventory.takeOne();
    expect(filledSlots(inventory)).toEqual([]);
  });

  it('用掉的是选中格里的，不是第一格里的', () => {
    const inventory = new Inventory();
    inventory.add(dirt(3));
    inventory.add(logs(5));
    inventory.select(1);
    inventory.takeOne();
    expect(inventory.slot(0)).toEqual(dirt(3));
    expect(inventory.slot(1)).toEqual(logs(4));
  });
});
