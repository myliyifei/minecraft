import { describe, expect, it } from 'vitest';
import { CraftingGrid } from '../../src/core/crafting-grid';
import { Inventory } from '../../src/core/inventory';
import { InventoryScreen } from '../../src/core/inventory-screen';
import { ItemType, type ItemStack } from '../../src/core/item';
import { matchRecipe, type GridContents, type GridSize } from '../../src/core/recipe';
import {
  ALL_PLANKS,
  ALL_SPECIES,
  BIRCH,
  NEW_SPECIES,
  OAK,
  SPRUCE,
  expectAllDefined,
  expectDefined,
  named,
} from '../helpers/wood-species';

/**
 * 木板组配方与配方书（#85）。
 *
 * 只经配方表的匹配（`matchRecipe` 用默认配方表）与背包界面（`InventoryScreen`）观察：配方格子里「一组物品」
 * 怎么表示是实现的事，这里只看摆什么出什么、配方书亮不亮、点了填进去什么。
 */

const TWO_BY_TWO: GridSize = { width: 2, height: 2 };
const THREE_BY_THREE: GridSize = { width: 3, height: 3 };
const S = ItemType.Stick;

/** 一块网格按行摆满：`rows` 里每格是物品或空着。 */
function laid(size: GridSize, rows: ReadonlyArray<ReadonlyArray<ItemType | undefined>>): GridContents {
  const contents = Array<ItemType | undefined>(size.width * size.height).fill(undefined);
  rows.forEach((row, r) => row.forEach((item, c) => (contents[r * size.width + c] = item)));
  return contents;
}

function stack(item: ItemType, count: number): ItemStack {
  return { item, count };
}

function one(item: ItemType): ItemStack {
  return { item, count: 1 };
}

/** 橡木板、白桦木板、云杉木板，写成一个字母，使图案对齐。 */
const [O, B, P] = ALL_PLANKS as [ItemType, ItemType, ItemType];

describe('三种原木各自合成自己的 4 块木板', () => {
  it.each(named(ALL_SPECIES))('%s原木摆在 2x2 的任意一格都出 4 块自己那种木板', (_name, species) => {
    expectDefined(species);
    for (let index = 0; index < 4; index++) {
      const contents = Array<ItemType | undefined>(4).fill(undefined);
      contents[index] = species.logItem;
      expect(matchRecipe(contents, TWO_BY_TWO), `第 ${index} 格`).toEqual(stack(species.planksItem, 4));
    }
  });

  it.each(named(NEW_SPECIES))('%s原木摆在 3x3 正中也出 4 块自己那种木板', (_name, species) => {
    expectDefined(species);
    expect(matchRecipe(laid(THREE_BY_THREE, [[], [undefined, species.logItem]]), THREE_BY_THREE)).toEqual(
      stack(species.planksItem, 4),
    );
  });

  it('两种原木摆在一起什么都不出：原木不是一组，无序配方的材料要正好一个', () => {
    expectAllDefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[BIRCH.logItem, SPRUCE.logItem]]), TWO_BY_TWO)).toBeUndefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[OAK.logItem, BIRCH.logItem]]), TWO_BY_TWO)).toBeUndefined();
  });

  it('四块原木摆成方形不出工作台：木板组只有木板', () => {
    expectAllDefined();
    for (const species of ALL_SPECIES) {
      const log = species.logItem;
      expect(matchRecipe(laid(TWO_BY_TWO, [[log, log], [log, log]]), TWO_BY_TWO), species.name).toBeUndefined();
    }
  });
});

describe('工作台用木板组', () => {
  it.each(named(ALL_SPECIES))('4 块%s木板摆满 2x2 出 1 个工作台', (_name, species) => {
    expectDefined(species);
    const p = species.planksItem;
    expect(matchRecipe(laid(TWO_BY_TWO, [[p, p], [p, p]]), TWO_BY_TWO)).toEqual(one(ItemType.CraftingTable));
  });

  it('三种木板混用摆满 2x2 出 1 个工作台', () => {
    expectAllDefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[O, B], [P, O]]), TWO_BY_TWO)).toEqual(one(ItemType.CraftingTable));
    expect(matchRecipe(laid(TWO_BY_TWO, [[P, P], [B, B]]), TWO_BY_TWO)).toEqual(one(ItemType.CraftingTable));
  });

  it('混用的方形摆在 3x3 的右下角也出：图案摆在网格里任意位置都算', () => {
    expectAllDefined();
    expect(
      matchRecipe(laid(THREE_BY_THREE, [[], [undefined, B, P], [undefined, O, B]]), THREE_BY_THREE),
    ).toEqual(one(ItemType.CraftingTable));
  });

  it('3 块混用木板不出：少一角就不是那个方形', () => {
    expectAllDefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[O, B], [P, undefined]]), TWO_BY_TWO)).toBeUndefined();
  });

  it('木板组的格子里摆了别的东西不出：三块木板加一块泥土', () => {
    expectAllDefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[B, P], [O, ItemType.Dirt]]), TWO_BY_TWO)).toBeUndefined();
  });
});

describe('木棍用木板组', () => {
  it.each(named(ALL_SPECIES))('两块%s木板竖排出 4 根木棍', (_name, species) => {
    expectDefined(species);
    const p = species.planksItem;
    expect(matchRecipe(laid(TWO_BY_TWO, [[p], [p]]), TWO_BY_TWO)).toEqual(stack(ItemType.Stick, 4));
    expect(matchRecipe(laid(TWO_BY_TWO, [[undefined, p], [undefined, p]]), TWO_BY_TWO)).toEqual(
      stack(ItemType.Stick, 4),
    );
  });

  it('上下两块不同的木板也出 4 根木棍', () => {
    expectAllDefined();
    for (const [top, bottom] of [[O, B], [B, P], [P, O]] as const) {
      expect(matchRecipe(laid(TWO_BY_TWO, [[top], [bottom]]), TWO_BY_TWO), `${top} / ${bottom}`).toEqual(
        stack(ItemType.Stick, 4),
      );
    }
  });

  it('横排两块混用木板不出：有序配方看形状', () => {
    expectAllDefined();
    expect(matchRecipe(laid(TWO_BY_TWO, [[B, P]]), TWO_BY_TWO)).toBeUndefined();
  });
});

describe('四种木制工具用木板组', () => {
  /** 四种木制工具的图案，`h` 是头部那几格各放什么（按图案里头部格出现的顺序）。 */
  const TOOLS: ReadonlyArray<{
    name: string;
    result: ItemType;
    rows: (h: readonly ItemType[]) => ReadonlyArray<ReadonlyArray<ItemType | undefined>>;
    heads: number;
  }> = [
    {
      name: '木镐',
      result: ItemType.WoodenPickaxe,
      rows: (h) => [[h[0], h[1], h[2]], [undefined, S], [undefined, S]],
      heads: 3,
    },
    {
      name: '木斧',
      result: ItemType.WoodenAxe,
      rows: (h) => [[h[0], h[1]], [h[2], S], [undefined, S]],
      heads: 3,
    },
    { name: '木铲', result: ItemType.WoodenShovel, rows: (h) => [[h[0]], [S], [S]], heads: 1 },
    { name: '木剑', result: ItemType.WoodenSword, rows: (h) => [[h[0]], [h[1]], [S]], heads: 2 },
  ];

  for (const { name, result, rows, heads } of TOOLS) {
    it.each(named(ALL_SPECIES))(`头部全是%s木板出 1 把${name}`, (_name, species) => {
      expectDefined(species);
      const h = Array<ItemType>(heads).fill(species.planksItem);
      expect(matchRecipe(laid(THREE_BY_THREE, rows(h)), THREE_BY_THREE)).toEqual(one(result));
    });

    it(`头部按白桦、云杉、橡木的顺序混用也出 1 把${name}`, () => {
      expectAllDefined();
      // 铲只有一格头部，取到的是白桦木板
      const h = [B, P, O].slice(0, heads);
      expect(matchRecipe(laid(THREE_BY_THREE, rows(h)), THREE_BY_THREE)).toEqual(one(result));
    });
  }

  it('斧的左右镜像用混用木板也出木斧', () => {
    expectAllDefined();
    expect(
      matchRecipe(laid(THREE_BY_THREE, [[undefined, B, P], [undefined, S, O], [undefined, S]]), THREE_BY_THREE),
    ).toEqual(one(ItemType.WoodenAxe));
  });

  it('木板与圆石仍不能混用：镐的头部两块新木板一块圆石，什么都不出', () => {
    expectAllDefined();
    expect(
      matchRecipe(laid(THREE_BY_THREE, [[B, ItemType.Cobblestone, P], [undefined, S], [undefined, S]]), THREE_BY_THREE),
    ).toBeUndefined();
  });

  it('柄仍必须是木棍：把木棍换成白桦木板摆镐的图案，什么都不出', () => {
    expectAllDefined();
    expect(matchRecipe(laid(THREE_BY_THREE, [[O, O, O], [undefined, B], [undefined, B]]), THREE_BY_THREE)).toBeUndefined();
  });
});

describe('配方书：木板组按三种木板的合计判断，填入时从格号最小的一堆取', () => {
  function opened(
    fill: (inventory: Inventory) => void,
    size: GridSize = TWO_BY_TWO,
  ): { inventory: Inventory; grid: CraftingGrid; screen: InventoryScreen } {
    const inventory = new Inventory();
    fill(inventory);
    const grid = new CraftingGrid(size);
    const screen = new InventoryScreen(inventory, grid);
    screen.toggle();
    return { inventory, grid, screen };
  }

  /** 配方书里成品是这种物品的那几条。 */
  function entriesFor(screen: InventoryScreen, item: ItemType) {
    return screen.crafting!.recipes.filter((e) => e.recipe.result.item === item);
  }

  /** 配方书里成品是这种物品的那一条；不是正好一条时报错。 */
  function entryFor(screen: InventoryScreen, item: ItemType) {
    const entries = entriesFor(screen, item);
    if (entries.length !== 1) throw new Error(`配方书里成品为 ${item} 的配方有 ${entries.length} 条`);
    return entries[0]!;
  }

  /** 配方书里成品是这种物品的那一条排第几。每次读 `recipes` 都是新算的一份，所以按成品找而不是按对象找。 */
  function indexOf(screen: InventoryScreen, item: ItemType): number {
    entryFor(screen, item);
    return screen.crafting!.recipes.findIndex((e) => e.recipe.result.item === item);
  }

  function gridSlots(grid: CraftingGrid): Array<ItemStack | undefined> {
    return Array.from({ length: grid.size }, (_, i) => grid.slot(i));
  }

  it('工作台、木棍与四种木制工具在 3x3 的配方书里各只有一条，不按木板种类分成几条', () => {
    expectAllDefined();
    const { screen } = opened(() => {}, THREE_BY_THREE);
    for (const item of [
      ItemType.CraftingTable,
      ItemType.Stick,
      ItemType.WoodenPickaxe,
      ItemType.WoodenAxe,
      ItemType.WoodenShovel,
      ItemType.WoodenSword,
    ]) {
      expect(entriesFor(screen, item), `成品 ${item}`).toHaveLength(1);
    }
  });

  it('三种原木出木板在 2x2 的配方书里各一条', () => {
    expectAllDefined();
    const { screen } = opened(() => {});
    for (const species of ALL_SPECIES) {
      expect(entriesFor(screen, species.planksItem), species.name).toHaveLength(1);
    }
  });

  it('背包里只有 2 块橡木板加 2 块白桦木板：工作台那条高亮；点击后按格号从小到大取出填满 2x2，输出格显示工作台', () => {
    expectAllDefined();
    const { inventory, grid, screen } = opened((inv) => {
      inv.setSlot(0, stack(OAK.planksItem, 2));
      inv.setSlot(1, stack(BIRCH.planksItem, 2));
    });
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(true);

    screen.clickRecipe(indexOf(screen, ItemType.CraftingTable));
    expect(gridSlots(grid)).toEqual([
      one(OAK.planksItem),
      one(OAK.planksItem),
      one(BIRCH.planksItem),
      one(BIRCH.planksItem),
    ]);
    expect(screen.crafting!.output).toEqual(one(ItemType.CraftingTable));
    expect(inventory.slot(0)).toBeUndefined();
    expect(inventory.slot(1)).toBeUndefined();
  });

  it('背包里只有云杉木板：木棍那条高亮，点击后两块云杉木板竖排填入，输出格显示 4 根木棍', () => {
    expectDefined(SPRUCE);
    const { inventory, grid, screen } = opened((inv) => inv.setSlot(4, stack(SPRUCE.planksItem, 3)));
    expect(entryFor(screen, ItemType.Stick).craftable).toBe(true);

    screen.clickRecipe(indexOf(screen, ItemType.Stick));
    expect(gridSlots(grid)).toEqual([one(SPRUCE.planksItem), undefined, one(SPRUCE.planksItem), undefined]);
    expect(screen.crafting!.output).toEqual(stack(ItemType.Stick, 4));
    expect(inventory.slot(4)).toEqual(stack(SPRUCE.planksItem, 1));
  });

  it('三种木板各 1 块合计 3 块：工作台那条灰显，点了没有任何反应', () => {
    expectAllDefined();
    const { inventory, grid, screen } = opened((inv) => {
      inv.setSlot(0, stack(O, 1));
      inv.setSlot(1, stack(B, 1));
      inv.setSlot(2, stack(P, 1));
    });
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(false);
    // 合计 3 块够木棍
    expect(entryFor(screen, ItemType.Stick).craftable).toBe(true);

    screen.clickRecipe(indexOf(screen, ItemType.CraftingTable));
    expect(gridSlots(grid)).toEqual([undefined, undefined, undefined, undefined]);
    expect([0, 1, 2].map((i) => inventory.slot(i))).toEqual([stack(O, 1), stack(B, 1), stack(P, 1)]);
  });

  it('木板组每一格从背包格号最小的、属于该组的那一堆取：中间隔着别的物品也跳过去', () => {
    expectAllDefined();
    const { inventory, grid, screen } = opened((inv) => {
      inv.setSlot(0, stack(B, 1));
      inv.setSlot(1, stack(ItemType.Dirt, 8));
      inv.setSlot(2, stack(O, 5));
      inv.setSlot(3, stack(P, 3));
    });
    screen.clickRecipe(indexOf(screen, ItemType.CraftingTable));
    // 第 0 格取白桦（背包第 0 格），之后第 0 格空了，后三格都从背包第 2 格的橡木板取
    expect(gridSlots(grid)).toEqual([one(B), one(O), one(O), one(O)]);
    expect(inventory.slot(0)).toBeUndefined();
    expect(inventory.slot(1)).toEqual(stack(ItemType.Dirt, 8));
    expect(inventory.slot(2)).toEqual(stack(O, 2));
    expect(inventory.slot(3)).toEqual(stack(P, 3));
    expect(screen.crafting!.output).toEqual(one(ItemType.CraftingTable));
  });

  it('合计也算网格里的：网格里 2 块白桦、背包里 2 块云杉时工作台高亮；点击时白桦先退回背包，再按格号取', () => {
    expectAllDefined();
    const { inventory, grid, screen } = opened((inv) => inv.setSlot(0, stack(P, 2)));
    grid.setSlot(3, stack(B, 2));
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(true);

    screen.clickRecipe(indexOf(screen, ItemType.CraftingTable));
    // 白桦退回背包落到第一个空格（第 1 格）；填入时前两格取第 0 格的云杉，后两格取第 1 格的白桦
    expect(gridSlots(grid)).toEqual([one(P), one(P), one(B), one(B)]);
    expect(inventory.slot(0)).toBeUndefined();
    expect(inventory.slot(1)).toBeUndefined();
    expect(screen.crafting!.output).toEqual(one(ItemType.CraftingTable));
  });

  it('光标上的木板不算材料：拿起那 2 块白桦木板，工作台那条就灰显', () => {
    expectAllDefined();
    const { screen } = opened((inv) => {
      inv.setSlot(0, stack(O, 2));
      inv.setSlot(1, stack(B, 2));
    });
    screen.clickSlot(1);
    expect(screen.cursor).toEqual(stack(B, 2));
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(false);
  });

  it('工作台里三种木板各 1 块加 2 根木棍：木镐那条高亮，点击后头部三格依次取格号最小的木板', () => {
    expectAllDefined();
    const { inventory, grid, screen } = opened((inv) => {
      inv.setSlot(0, stack(P, 1));
      inv.setSlot(1, stack(ItemType.Stick, 2));
      inv.setSlot(2, stack(O, 1));
      inv.setSlot(3, stack(B, 1));
    }, THREE_BY_THREE);
    expect(entryFor(screen, ItemType.WoodenPickaxe).craftable).toBe(true);
    // 合计只有 3 块木板与 2 根木棍：镐够，木斧也够；工作台要 4 块不够
    expect(entryFor(screen, ItemType.WoodenAxe).craftable).toBe(true);
    expect(entryFor(screen, ItemType.CraftingTable).craftable).toBe(false);

    screen.clickRecipe(indexOf(screen, ItemType.WoodenPickaxe));
    expect(gridSlots(grid)).toEqual([
      one(P),
      one(O),
      one(B),
      undefined,
      one(ItemType.Stick),
      undefined,
      undefined,
      one(ItemType.Stick),
      undefined,
    ]);
    expect(screen.crafting!.output).toEqual(one(ItemType.WoodenPickaxe));
    expect([0, 1, 2, 3].map((i) => inventory.slot(i))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it.each(named(ALL_SPECIES))('工作台里只有%s木板与木棍时四种木制工具都高亮', (_name, species) => {
    expectDefined(species);
    const { screen } = opened((inv) => {
      inv.setSlot(0, stack(species.planksItem, 3));
      inv.setSlot(1, stack(ItemType.Stick, 2));
    }, THREE_BY_THREE);
    for (const item of [ItemType.WoodenPickaxe, ItemType.WoodenAxe, ItemType.WoodenShovel, ItemType.WoodenSword]) {
      expect(entryFor(screen, item).craftable, `成品 ${item}`).toBe(true);
    }
  });

  it('原木出木板不是一组：背包里只有白桦原木时，只有白桦木板那条高亮；点击后填入的是白桦原木', () => {
    expectAllDefined();
    const { grid, screen } = opened((inv) => inv.setSlot(0, stack(BIRCH.logItem, 2)));
    expect(entryFor(screen, BIRCH.planksItem).craftable).toBe(true);
    expect(entryFor(screen, OAK.planksItem).craftable).toBe(false);
    expect(entryFor(screen, SPRUCE.planksItem).craftable).toBe(false);

    screen.clickRecipe(indexOf(screen, BIRCH.planksItem));
    expect(grid.slot(0)).toEqual(one(BIRCH.logItem));
    expect(screen.crafting!.output).toEqual(stack(BIRCH.planksItem, 4));
  });
});
