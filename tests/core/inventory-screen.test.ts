import { describe, expect, it } from 'vitest';
import { CraftingGrid } from '../../src/core/crafting-grid';
import { INVENTORY_SIZE, Inventory } from '../../src/core/inventory';
import { InventoryScreen } from '../../src/core/inventory-screen';
import { ItemType, type ItemStack } from '../../src/core/item';
import { RECIPES } from '../../src/core/recipe';

/** 一堆泥土。 */
function dirt(count: number): ItemStack {
  return { item: ItemType.Dirt, count };
}

/** 一堆原木。 */
function logs(count: number): ItemStack {
  return { item: ItemType.OakLog, count };
}

/** 四块木板：原木出木板那条配方的成品。 */
const PLANKS_X4: ItemStack = { item: ItemType.OakPlanks, count: 4 };

/** 一堆木板。 */
function planks(count: number): ItemStack {
  return { item: ItemType.OakPlanks, count };
}

/** 背包界面那块 2x2 的合成网格。附加格子那几组测试拿它当一批普通格子用。 */
function grid(): CraftingGrid {
  return new CraftingGrid({ width: 2, height: 2 });
}

/** 合成网格的第一格在界面里的格号：背包 36 格之后接着编号。 */
const FIRST_EXTRA = INVENTORY_SIZE;

/**
 * 一个背包加一个开着的背包界面。背包里的东西由 `fill` 摆，`extra` 是附加的那块合成网格。
 */
function opened(
  fill: (inventory: Inventory) => void = () => {},
  extra?: CraftingGrid,
): {
  inventory: Inventory;
  screen: InventoryScreen;
} {
  const inventory = new Inventory();
  fill(inventory);
  const screen = new InventoryScreen(inventory, extra);
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
    const { inventory, screen } = opened((inv) => inv.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    expect(inventory.slot(20)).toBeUndefined();

    expect(screen.toggle()).toEqual([]);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(20)).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('原格在这期间被同种物品占了一半，就并进去', () => {
    const { inventory, screen } = opened((inv) => inv.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    // 界面开着时掉落物照样往背包里进，原格因此可能又有了东西
    inventory.setSlot(20, dirt(5));

    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(20)).toEqual(dirt(15));
  });

  it('原格被别的东西占了就落到第一个空格', () => {
    const { inventory, screen } = opened((inv) => inv.setSlot(20, dirt(10)));
    screen.clickSlot(20);
    inventory.setSlot(20, logs(64));

    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(0)).toEqual(dirt(10));
    expect(inventory.slot(20)).toEqual(logs(64));
  });

  it('36 格全满时把没放下的那一堆交出去', () => {
    const { inventory, screen } = opened((inv) => inv.add(dirt(36 * 64)));
    screen.clickSlot(0);
    // 拿起之后原格又被塞满了：36 格一格不剩，光标上那 64 个无处可去
    inventory.setSlot(0, logs(64));

    expect(screen.toggle()).toEqual([dirt(64)]);
    // 交出去了就不再留在光标上——调用方（GameCore）把它扔到玩家脚下
    expect(screen.cursor).toBeUndefined();
  });

  it('光标空着时关闭界面什么都不用交出去', () => {
    const { screen } = opened((inv) => inv.add(dirt(10)));
    expect(screen.toggle()).toEqual([]);
  });
});

describe('背包界面的光标物品', () => {
  it('点有物品的格拿起整堆，那一格空了', () => {
    const { inventory, screen } = opened((inv) => inv.add(dirt(10)));
    screen.clickSlot(0);
    expect(screen.cursor).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('拿起之后点空格放下整堆，光标空了', () => {
    const { inventory, screen } = opened((inv) => inv.add(dirt(10)));
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
    const { inventory, screen } = opened((inv) => inv.add(dirt(10)));
    screen.toggle();
    screen.clickSlot(0);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });

  it('点同种的格合并成一堆，光标空了', () => {
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, dirt(10));
      inv.setSlot(1, dirt(20));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(30));
    expect(inventory.slot(0)).toBeUndefined();
    expect(screen.cursor).toBeUndefined();
  });

  it('合并超过堆叠上限时装满那一格，余量留在光标上', () => {
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, dirt(60));
      inv.setSlot(1, dirt(30));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    // 上限是 64：那一格从 30 收到 64，光标上还剩 26
    expect(inventory.slot(1)).toEqual(dirt(64));
    expect(screen.cursor).toEqual(dirt(26));
  });

  it('点满了的同种格什么都不发生，整堆还在光标上', () => {
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, dirt(5));
      inv.setSlot(1, dirt(64));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(64));
    expect(screen.cursor).toEqual(dirt(5));
  });

  it('点异种的格与光标交换', () => {
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, dirt(10));
      inv.setSlot(1, logs(5));
    });
    screen.clickSlot(0);
    screen.clickSlot(1);
    expect(inventory.slot(1)).toEqual(dirt(10));
    expect(screen.cursor).toEqual(logs(5));
  });

  it('越界的下标什么都不发生', () => {
    const { inventory, screen } = opened((inv) => inv.add(logs(3)));
    screen.clickSlot(-1);
    screen.clickSlot(inventory.size);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(logs(3));
  });

  it('下标不是整数时什么都不发生，光标上的东西还在', () => {
    // 界面层是把 data 属性读成数字交过来的，读出 NaN 时不能把光标上那一堆放进
    // 一个不存在的格子里
    const { inventory, screen } = opened((inv) => inv.setSlot(0, dirt(10)));
    screen.clickSlot(0);
    screen.clickSlot(Number.NaN);
    screen.clickSlot(2.5);
    expect(screen.cursor).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();

    // 光标上那一堆仍然回得了原格：上面那两下一个格子都没动过
    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(0)).toEqual(dirt(10));
  });
});

describe('附加格子：格号接在背包之后，操作与背包格一致', () => {
  it('点附加格子里有东西的那一格，拿起整堆', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    const { screen } = opened(() => {}, extra);
    screen.clickSlot(FIRST_EXTRA);
    expect(screen.cursor).toEqual(dirt(10));
    expect(extra.slot(0)).toBeUndefined();
  });

  it('从背包拿起，放进附加格子的空格', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => inv.setSlot(0, dirt(10)), extra);
    screen.clickSlot(0);
    screen.clickSlot(FIRST_EXTRA + 3);
    expect(extra.slot(3)).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
    expect(screen.cursor).toBeUndefined();
  });

  it('点附加格子里的同种物品并成一堆，超过上限的余量留在光标上', () => {
    const extra = grid();
    extra.setSlot(1, dirt(30));
    const { screen } = opened((inv) => inv.setSlot(0, dirt(60)), extra);
    screen.clickSlot(0);
    screen.clickSlot(FIRST_EXTRA + 1);
    expect(extra.slot(1)).toEqual(dirt(64));
    expect(screen.cursor).toEqual(dirt(26));
  });

  it('点附加格子里的异种物品与光标交换', () => {
    const extra = grid();
    extra.setSlot(0, logs(5));
    const { screen } = opened((inv) => inv.setSlot(0, dirt(10)), extra);
    screen.clickSlot(0);
    screen.clickSlot(FIRST_EXTRA);
    expect(extra.slot(0)).toEqual(dirt(10));
    expect(screen.cursor).toEqual(logs(5));
  });

  it('附加格子之外的格号仍然什么都不发生', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => inv.setSlot(0, dirt(10)), extra);
    screen.clickSlot(FIRST_EXTRA + 4);
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });

  it('不附加格子时第 36 格什么都不发生', () => {
    const { inventory, screen } = opened((inv) => inv.setSlot(0, dirt(10)));
    screen.clickSlot(0);
    screen.clickSlot(FIRST_EXTRA);
    // 那一下什么都没动，光标上那一堆还在
    expect(screen.cursor).toEqual(dirt(10));
    expect(inventory.slot(0)).toBeUndefined();
  });
});

describe('关闭界面时附加格子里的东西回背包', () => {
  it('按入包规则落到第一个空格，附加格子清空', () => {
    const extra = grid();
    extra.setSlot(2, dirt(10));
    const { inventory, screen } = opened(() => {}, extra);

    expect(screen.toggle()).toEqual([]);
    expect(extra.slot(2)).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });

  it('背包里有同种的未满堆就先并进去', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    const { inventory, screen } = opened((inv) => inv.setSlot(5, dirt(50)), extra);

    expect(screen.toggle()).toEqual([]);
    expect(inventory.slot(5)).toEqual(dirt(60));
  });

  it('背包 36 格全满时把附加格子里的每一堆都交出去', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    extra.setSlot(1, logs(3));
    const { screen } = opened((inv) => inv.add(dirt(36 * 64)), extra);

    // 两种物品各成一堆交出去：一格都放不下，调用方把它们扔到玩家脚下
    expect(screen.toggle()).toEqual([dirt(10), logs(3)]);
    expect(extra.slot(0)).toBeUndefined();
    expect(extra.slot(1)).toBeUndefined();
  });

  it('放得下一部分时只交出剩下的那些', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    // 35 格塞满泥土，最后一格塞满原木：泥土那一堆只并得进第 35 格之前的空位
    const { screen } = opened((inv) => {
      inv.add(dirt(35 * 64 - 4));
      inv.setSlot(35, logs(64));
    }, extra);

    expect(screen.toggle()).toEqual([dirt(6)]);
  });

  it('光标上的东西先回原格，再轮到附加格子', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    const { inventory, screen } = opened(() => {}, extra);
    // 从附加格子里拿起来：原格是附加格子的第 0 格，光标先回那里，随后它跟着入包
    screen.clickSlot(FIRST_EXTRA);
    expect(screen.cursor).toEqual(dirt(10));

    expect(screen.toggle()).toEqual([]);
    expect(extra.slot(0)).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(10));
  });

  it('重新打开时附加格子仍是空的：上一次已经清干净了', () => {
    const extra = grid();
    extra.setSlot(0, dirt(10));
    const { screen } = opened(() => {}, extra);
    screen.toggle();
    screen.toggle();
    expect(extra.slot(0)).toBeUndefined();
  });
});

describe('输出格：网格里凑成配方就显示成品，点它拿走', () => {
  /** 开着的界面，网格里已经摆了几个原木。 */
  function withLogsInGrid(count: number, fill: (inventory: Inventory) => void = () => {}) {
    const extra = grid();
    extra.setSlot(0, logs(count));
    const { inventory, screen } = opened(fill, extra);
    return { inventory, screen, extra };
  }

  it('没附加网格的界面没有合成视图，点输出格什么都不发生', () => {
    const { inventory, screen } = opened((inv) => inv.setSlot(0, dirt(1)));
    expect(screen.crafting).toBeUndefined();
    screen.clickOutput();
    expect(screen.cursor).toBeUndefined();
    expect(inventory.slot(0)).toEqual(dirt(1));
  });

  it('合成视图报网格尺寸、第一格的格号与各格内容', () => {
    const { screen, extra } = withLogsInGrid(2);
    const crafting = screen.crafting!;
    expect(crafting.width).toBe(2);
    expect(crafting.height).toBe(2);
    expect(crafting.firstSlot).toBe(FIRST_EXTRA);
    expect(crafting.slot(0)).toEqual(logs(2));
    expect(crafting.slot(1)).toBeUndefined();
    extra.setSlot(1, dirt(1));
    expect(crafting.slot(1)).toEqual(dirt(1));
  });

  it('摆好材料后输出格显示成品，不匹配时是空的', () => {
    const { screen, extra } = withLogsInGrid(1);
    expect(screen.crafting!.output).toEqual(PLANKS_X4);
    extra.setSlot(1, dirt(1));
    expect(screen.crafting!.output).toBeUndefined();
  });

  it('从背包把原木放进网格，输出格随即显示木板', () => {
    const { screen } = opened((inv) => inv.setSlot(0, logs(1)), grid());
    expect(screen.crafting!.output).toBeUndefined();
    screen.clickSlot(0);
    screen.clickSlot(FIRST_EXTRA + 3);
    expect(screen.crafting!.output).toEqual(PLANKS_X4);
  });

  it('光标空着时点输出格，成品到光标上，网格那一格减 1，输出格按剩下的重算', () => {
    const { screen, extra } = withLogsInGrid(2);
    screen.clickOutput();
    expect(screen.cursor).toEqual(PLANKS_X4);
    expect(extra.slot(0)).toEqual(logs(1));
    expect(screen.crafting!.output).toEqual(PLANKS_X4);
  });

  it('最后一个原木用掉之后输出格变空', () => {
    const { screen, extra } = withLogsInGrid(1);
    screen.clickOutput();
    expect(extra.slot(0)).toBeUndefined();
    expect(screen.crafting!.output).toBeUndefined();
  });

  it('输出格空着时点它什么都不发生', () => {
    const extra = grid();
    extra.setSlot(0, dirt(3));
    const { screen } = opened(() => {}, extra);
    screen.clickOutput();
    expect(screen.cursor).toBeUndefined();
    expect(extra.slot(0)).toEqual(dirt(3));
  });

  it('光标上拿着同种物品时点输出格，成品并上去，材料照样消耗', () => {
    const { screen, extra } = withLogsInGrid(3, (inv) => inv.setSlot(0, planks(4)));
    screen.clickSlot(0);
    screen.clickOutput();
    screen.clickOutput();
    expect(screen.cursor).toEqual(planks(12));
    expect(extra.slot(0)).toEqual(logs(1));
  });

  it('光标上的同种物品装不下整份成品时不合成：材料一个都不动', () => {
    // 木板上限 64，光标上 61 个只剩 3 格空位，一份 4 块并不进去
    const { screen, extra } = withLogsInGrid(1, (inv) => inv.setSlot(0, planks(61)));
    screen.clickSlot(0);
    screen.clickOutput();
    expect(screen.cursor).toEqual(planks(61));
    expect(extra.slot(0)).toEqual(logs(1));
  });

  it('光标上正好还容得下一份时并到堆叠上限', () => {
    const { screen, extra } = withLogsInGrid(1, (inv) => inv.setSlot(0, planks(60)));
    screen.clickSlot(0);
    screen.clickOutput();
    expect(screen.cursor).toEqual(planks(64));
    expect(extra.slot(0)).toBeUndefined();
  });

  it('光标上拿着别的东西时点输出格不动：成品不覆盖光标上的东西', () => {
    const { screen, extra } = withLogsInGrid(1, (inv) => inv.setSlot(0, dirt(5)));
    screen.clickSlot(0);
    screen.clickOutput();
    expect(screen.cursor).toEqual(dirt(5));
    expect(extra.slot(0)).toEqual(logs(1));
  });

  it('界面关着时点输出格什么都不发生', () => {
    const { screen, extra } = withLogsInGrid(1);
    screen.toggle();
    // 关界面把原木还回了背包，再往网格里摆一个模拟「关着时网格里有东西」
    extra.setSlot(0, logs(1));
    screen.clickOutput();
    expect(screen.cursor).toBeUndefined();
    expect(extra.slot(0)).toEqual(logs(1));
  });

  it('从输出格拿到光标上的成品，关闭界面时按入包规则进背包', () => {
    const { inventory, screen } = withLogsInGrid(1, (inv) => inv.setSlot(5, planks(10)));
    screen.clickOutput();
    expect(screen.toggle()).toEqual([]);
    // 先并进同种未满堆：成品不是从哪一格拿起来的，没有「原格」可回
    expect(inventory.slot(5)).toEqual(planks(14));
    expect(inventory.slot(0)).toBeUndefined();
  });

  it('背包全满时从输出格拿的成品关闭界面时交出去', () => {
    const { screen } = withLogsInGrid(1, (inv) => inv.add(dirt(36 * 64)));
    screen.clickOutput();
    expect(screen.toggle()).toEqual([PLANKS_X4]);
  });

  it('关闭界面时网格里剩下的材料回背包，网格清空', () => {
    const { inventory, screen, extra } = withLogsInGrid(3);
    screen.clickOutput();
    expect(screen.toggle()).toEqual([]);
    expect(extra.slot(0)).toBeUndefined();
    // 先光标物品再网格：木板先落第 0 格，原木随后落第 1 格
    expect(inventory.slot(0)).toEqual(PLANKS_X4);
    expect(inventory.slot(1)).toEqual(logs(2));
  });
});

describe('配方书：列出这块网格能做的配方，材料充足的高亮', () => {
  /** 配方书里成品是这种物品的那一条。 */
  function entryFor(screen: InventoryScreen, item: ItemType) {
    const entry = screen.crafting!.recipes.find((e) => e.recipe.result.item === item);
    if (!entry) throw new Error(`配方书里没有成品为 ${item} 的配方`);
    return entry;
  }

  it('背包里有 1 原木时，木板配方可合成、木棍配方不可合成', () => {
    const { screen } = opened((inv) => inv.setSlot(0, logs(1)), grid());
    expect(entryFor(screen, ItemType.OakPlanks).craftable).toBe(true);
    expect(entryFor(screen, ItemType.Stick).craftable).toBe(false);
  });

  it('配方书列的就是摆得进 2x2 的那几条，工作台的 3x3 也一样', () => {
    const { screen } = opened(() => {}, grid());
    expect(screen.crafting!.recipes.map((e) => e.recipe)).toEqual(RECIPES);
    const table = opened(() => {}, new CraftingGrid({ width: 3, height: 3 }));
    expect(table.screen.crafting!.recipes.map((e) => e.recipe)).toEqual(RECIPES);
  });

  it('材料合计背包与网格：木板分在两处凑够 4 块，工作台配方就亮', () => {
    const extra = grid();
    extra.setSlot(3, planks(2));
    const { screen } = opened((inv) => inv.setSlot(7, planks(2)), extra);
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(true);
  });

  it('光标上的东西不算材料', () => {
    const { screen } = opened((inv) => inv.setSlot(0, logs(1)), grid());
    screen.clickSlot(0);
    expect(screen.cursor).toEqual(logs(1));
    expect(entryFor(screen, ItemType.OakPlanks).craftable).toBe(false);
  });

  /** 配方书里成品是这种物品的那一条排第几。 */
  function indexOf(screen: InventoryScreen, item: ItemType): number {
    return screen.crafting!.recipes.findIndex((e) => e.recipe.result.item === item);
  }

  it('点木板配方：网格里出现原木、背包少 1 原木、输出格显示 4 木板', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => inv.setSlot(0, logs(3)), extra);
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    expect(extra.slot(0)).toEqual(logs(1));
    expect(inventory.slot(0)).toEqual(logs(2));
    expect(screen.crafting!.output).toEqual(PLANKS_X4);
  });

  it('有序配方靠左上角对齐，按格号从小到大从背包取出材料', () => {
    const extra = grid();
    // 木棍要 2 块木板竖排：第 0 格只有 1 块，再从第 5 格拿 1 块
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, planks(1));
      inv.setSlot(5, planks(3));
    }, extra);
    screen.clickRecipe(indexOf(screen, ItemType.Stick));
    expect(extra.slot(0)).toEqual(planks(1));
    expect(extra.slot(2)).toEqual(planks(1));
    expect(extra.slot(1)).toBeUndefined();
    expect(inventory.slot(0)).toBeUndefined();
    expect(inventory.slot(5)).toEqual(planks(2));
    expect(screen.crafting!.output).toEqual({ item: ItemType.Stick, count: 4 });
  });

  it('点击时网格里原有的材料先退回背包，再取出材料', () => {
    const extra = grid();
    extra.setSlot(3, dirt(5));
    const { inventory, screen } = opened((inv) => inv.setSlot(2, logs(1)), extra);
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    // 泥土退回背包落到第 0 格，原木从第 2 格取走填入网格第 0 格
    expect(inventory.slot(0)).toEqual(dirt(5));
    expect(inventory.slot(2)).toBeUndefined();
    expect(extra.slot(0)).toEqual(logs(1));
    expect(extra.slot(3)).toBeUndefined();
  });

  it('网格里原有的材料也算材料：原木在网格里，点木板配方照样填', () => {
    const extra = grid();
    extra.setSlot(3, logs(1));
    const { screen } = opened(() => {}, extra);
    expect(entryFor(screen, ItemType.OakPlanks).craftable).toBe(true);
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    expect(extra.slot(0)).toEqual(logs(1));
    expect(extra.slot(3)).toBeUndefined();
  });

  it('点不可合成的配方没有任何反应', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => inv.setSlot(0, logs(1)), extra);
    screen.clickRecipe(indexOf(screen, ItemType.Stick));
    expect(inventory.slot(0)).toEqual(logs(1));
    for (let i = 0; i < extra.size; i++) expect(extra.slot(i)).toBeUndefined();
  });

  it('取材料时不会拿光标上的物品', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => {
      inv.setSlot(0, logs(1));
      inv.setSlot(1, logs(1));
    }, extra);
    screen.clickSlot(0);
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    expect(screen.cursor).toEqual(logs(1));
    expect(inventory.slot(1)).toBeUndefined();
    expect(extra.slot(0)).toEqual(logs(1));
  });

  it('界面关着、下标指不到配方时什么都不发生', () => {
    const extra = grid();
    const { inventory, screen } = opened((inv) => inv.setSlot(0, logs(1)), extra);
    screen.clickRecipe(-1);
    screen.clickRecipe(RECIPES.length);
    screen.clickRecipe(Number.NaN);
    expect(inventory.slot(0)).toEqual(logs(1));
    screen.toggle();
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    expect(inventory.slot(0)).toEqual(logs(1));
    expect(extra.slot(0)).toBeUndefined();
  });

  it('背包全满、网格里的物品退不回去时不填入材料，物品留在原格', () => {
    const extra = grid();
    extra.setSlot(3, dirt(5));
    const { inventory, screen } = opened((inv) => {
      inv.add(dirt(35 * 64));
      inv.setSlot(35, logs(1));
    }, extra);
    screen.clickRecipe(indexOf(screen, ItemType.OakPlanks));
    expect(extra.slot(3)).toEqual(dirt(5));
    expect(extra.slot(0)).toBeUndefined();
    expect(inventory.slot(35)).toEqual(logs(1));
  });

  it('没附加网格的界面点配方什么都不发生', () => {
    const { inventory, screen } = opened((inv) => inv.setSlot(0, logs(1)));
    screen.clickRecipe(0);
    expect(inventory.slot(0)).toEqual(logs(1));
  });
});
