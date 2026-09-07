import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/core/inventory';
import { InventoryScreen } from '../../src/core/inventory-screen';
import { ItemType, type ItemStack } from '../../src/core/item';

/** 一堆泥土。 */
function dirt(count: number): ItemStack {
  return { item: ItemType.Dirt, count };
}

/** 一堆原木。 */
function logs(count: number): ItemStack {
  return { item: ItemType.OakLog, count };
}

/** 一个背包加一个开着的背包界面。背包里的东西由 `fill` 摆。 */
function opened(fill: (inventory: Inventory) => void = () => {}): {
  inventory: Inventory;
  screen: InventoryScreen;
} {
  const inventory = new Inventory();
  fill(inventory);
  const screen = new InventoryScreen(inventory);
  screen.toggle();
  return { inventory, screen };
}

describe('背包界面的开合', () => {
  it('新建时是关着的，光标上什么都没有', () => {
    const screen = new InventoryScreen(new Inventory());
    expect(screen.open).toBe(false);
    expect(screen.cursor).toBeUndefined();
  });

  it('切换一次打开，再切换一次关闭', () => {
    const { screen } = opened();
    expect(screen.open).toBe(true);
    screen.toggle();
    expect(screen.open).toBe(false);
  });
});

describe('关闭界面时光标上的东西不丢', () => {
  it('回到拿起它的那一格，哪怕前面还有空格', () => {
    // 拿起的是第 20 格：光标物品回原格，不是回下标最小的那个空格
    const { inventory, screen } = opened((it) => it.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    expect(inventory.slot(20)).toBeUndefined();

    expect(screen.toggle()).toBeUndefined();
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(20)).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('原格在这期间被同种物品占了一半，就并进去', () => {
    const { inventory, screen } = opened((it) => it.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    // 界面开着时掉落物照样往背包里进，原格因此可能又有了东西
    inventory.setSlot(20, dirt(5));

    expect(screen.toggle()).toBeUndefined();
    expect(inventory.slot(20)).toEqual(dirt(15));
  });

  it('原格被别的东西占了就落到第一个空格', () => {
    const { inventory, screen } = opened((it) => it.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    inventory.setSlot(20, logs(64));

    expect(screen.toggle()).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
    expect(inventory.slot(20)).toEqual(logs(64));
  });

  it('36 格全满时把没放下的那一堆交出去', () => {
    const { inventory, screen } = opened((it) => it.add(dirt(36 * 64)));
    screen.clickSlot(0);
    // 拿起之后原格又被塞满了：36 格一格不剩，光标上那 64 个无处可去
    inventory.setSlot(0, logs(64));

    expect(screen.toggle()).toEqual(dirt(64));
    // 交出去了就不再留在光标上——调用方（GameCore）把它扔到玩家脚下
    expect(screen.cursor).toBeUndefined();
  });

  it('光标空着时关闭界面什么都不用交出去', () => {
    const { screen } = opened((it) => it.add(dirt(10)));
    expect(screen.toggle()).toBeUndefined();
  });
});

describe('背包界面的光标物品', () => {
  it('点有物品的格拿起整堆，那一格空了', () => {
    const { inventory, screen } = opened((it) => it.add(dirt(10)));
    screen.clickSlot(0);
    expect(screen.cursor).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('拿起之后点空格放下整堆，光标空了', () => {
    const { inventory, screen } = opened((it) => it.add(dirt(10)));
    screen.clickSlot(0);
    screen.clickSlot(20);
    expect(inventory.slot(20)).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
    expect(screen.cursor).toBeUndefined();
  });

  it('空手点空格什么都不发生', () => {
    const { inventory, screen } = opened();
    screen.clickSlot(0);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('界面关着时点格子不动任何东西', () => {
    const { inventory, screen } = opened((it) => it.add(dirt(10)));
    screen.toggle();
    screen.clickSlot(0);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });

  it('点同种的格合并成一堆，光标空了', () => {
    const { inventory, screen } = opened((it) => {
      it.setSlot(0, dirt(10));
      it.setSlot(1, dirt(20));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(30));
    expect(inventory.slot(0)).toBeUndefined();
    expect(screen.cursor).toBeUndefined();
  });

  it('合并超过堆叠上限时装满那一格，余量留在光标上', () => {
    const { inventory, screen } = opened((it) => {
      it.setSlot(0, dirt(60));
      it.setSlot(1, dirt(30));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    // 上限是 64：那一格从 30 收到 64，光标上还剩 26
    expect(inventory.slot(1)).toEqual(dirt(64));
    expect(screen.cursor).toEqual(dirt(26));
  });

  it('点满了的同种格什么都不发生，整堆还在光标上', () => {
    const { inventory, screen } = opened((it) => {
      it.setSlot(0, dirt(5));
      it.setSlot(1, dirt(64));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(64));
    expect(screen.cursor).toEqual(dirt(5));
  });

  it('点异种的格与光标交换', () => {
    const { inventory, screen } = opened((it) => {
      it.setSlot(0, dirt(10));
      it.setSlot(1, logs(5));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(10));
    expect(screen.cursor).toEqual(logs(5));
  });

  it('越界的下标什么都不发生', () => {
    const { inventory, screen } = opened((it) => it.add(logs(3)));
    screen.clickSlot(-1);
    screen.clickSlot(inventory.size);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(logs(3));
  });

  it('下标不是整数时什么都不发生，光标上的东西还在', () => {
    // 界面层是把 data 属性读成数字交过来的，读出 NaN 时不能把光标上那一堆放进
    // 一个不存在的格子里
    const { inventory, screen } = opened((it) => it.setSlot(0, dirt(10)));
    screen.clickSlot(0);
    screen.clickSlot(Number.NaN);
    screen.clickSlot(2.5);
    expect(screen.cursor).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();

    // 光标上那一堆仍然回得了原格：上面那两下一个格子都没动过
    expect(screen.toggle()).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });
});
