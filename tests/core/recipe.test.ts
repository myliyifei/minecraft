import { describe, expect, it } from 'vitest';
import { ItemType } from '../../src/core/item';
import {
  RECIPES,
  ingredientCounts,
  layoutRecipe,
  recipesFor,
  matchRecipe,
  recipeFits,
  type GridContents,
  type GridSize,
  type Recipe,
} from '../../src/core/recipe';

const TWO_BY_TWO: GridSize = { width: 2, height: 2 };
const THREE_BY_THREE: GridSize = { width: 3, height: 3 };

/** 一块空网格。 */
function empty(size: GridSize): Array<ItemType | undefined> {
  return Array<ItemType | undefined>(size.width * size.height).fill(undefined);
}

/** 把几样东西摆进网格：`[格号, 物品]`，其余格子留空。 */
function grid(size: GridSize, ...cells: Array<[number, ItemType]>): GridContents {
  const contents = empty(size);
  for (const [index, item] of cells) contents[index] = item;
  return contents;
}

/** 四块木板。 */
const PLANKS_X4 = { item: ItemType.OakPlanks, count: 4 };

/**
 * 测试里构造的有序配方，只用来验匹配规则，不进配方表。
 *
 * 图案 1x2 竖排：上泥土下原木。上下不对称，所以能分辨出「上下翻转不识别」。
 */
const TALL: Recipe = {
  kind: 'shaped',
  result: PLANKS_X4,
  pattern: [[ItemType.Dirt], [ItemType.OakLog]],
  mirrored: false,
};

/**
 * 图案 2x2、左右不对称：左上泥土、右上原木、左下原木。右下留空。
 * 一份允许镜像，一份不允许，用来验镜像那条规则。
 */
const ASYMMETRIC: Recipe = {
  kind: 'shaped',
  result: PLANKS_X4,
  pattern: [
    [ItemType.Dirt, ItemType.OakLog],
    [ItemType.OakLog, undefined],
  ],
  mirrored: false,
};
const ASYMMETRIC_MIRRORED: Recipe = { ...ASYMMETRIC, mirrored: true };

/** 图案 1x3 横排。摆不进 2x2。 */
const WIDE: Recipe = {
  kind: 'shaped',
  result: PLANKS_X4,
  pattern: [[ItemType.Dirt, ItemType.Dirt, ItemType.Dirt]],
  mirrored: false,
};

describe('配方表里的原木出木板', () => {
  it('原木摆在 2x2 的任意一格都出 4 块木板', () => {
    for (let index = 0; index < 4; index++) {
      expect(
        matchRecipe(grid(TWO_BY_TWO, [index, ItemType.OakLog]), TWO_BY_TWO),
        `第 ${index} 格`,
      ).toEqual(PLANKS_X4);
    }
  });

  it('原木摆在 3x3 的正中也出 4 块木板', () => {
    expect(matchRecipe(grid(THREE_BY_THREE, [4, ItemType.OakLog]), THREE_BY_THREE)).toEqual(
      PLANKS_X4,
    );
  });

  it('多摆一格无关材料就不匹配', () => {
    expect(
      matchRecipe(grid(TWO_BY_TWO, [0, ItemType.OakLog], [3, ItemType.Dirt]), TWO_BY_TWO),
    ).toBeUndefined();
  });

  it('两个原木不匹配：无序配方的材料要正好那么多', () => {
    expect(
      matchRecipe(grid(TWO_BY_TWO, [0, ItemType.OakLog], [1, ItemType.OakLog]), TWO_BY_TWO),
    ).toBeUndefined();
  });

  it('空网格与只摆泥土都不匹配', () => {
    expect(matchRecipe(empty(TWO_BY_TWO), TWO_BY_TWO)).toBeUndefined();
    expect(matchRecipe(grid(TWO_BY_TWO, [0, ItemType.Dirt]), TWO_BY_TWO)).toBeUndefined();
  });

  it('配方表的每一条都摆得进 2x2', () => {
    // 目前只有原木出木板、木板出木棍两条；工具那几条（#21）要 3x3，进表之后这条断言要改
    for (const recipe of RECIPES) expect(recipeFits(recipe, TWO_BY_TWO)).toBe(true);
  });
});

describe('配方表里的木板出木棍', () => {
  /** 四根木棍。 */
  const STICKS_X4 = { item: ItemType.Stick, count: 4 };

  it('两块木板竖排在 2x2 的左列或右列都出 4 根木棍', () => {
    const left = grid(TWO_BY_TWO, [0, ItemType.OakPlanks], [2, ItemType.OakPlanks]);
    const right = grid(TWO_BY_TWO, [1, ItemType.OakPlanks], [3, ItemType.OakPlanks]);
    expect(matchRecipe(left, TWO_BY_TWO)).toEqual(STICKS_X4);
    expect(matchRecipe(right, TWO_BY_TWO)).toEqual(STICKS_X4);
  });

  it('横排不出：有序配方看形状', () => {
    const across = grid(TWO_BY_TWO, [0, ItemType.OakPlanks], [1, ItemType.OakPlanks]);
    expect(matchRecipe(across, TWO_BY_TWO)).toBeUndefined();
  });

  it('3 块竖排在 3x3 里不出：材料要正好两块', () => {
    const three = grid(
      THREE_BY_THREE,
      [1, ItemType.OakPlanks],
      [4, ItemType.OakPlanks],
      [7, ItemType.OakPlanks],
    );
    expect(matchRecipe(three, THREE_BY_THREE)).toBeUndefined();
  });

  it('两块竖排摆在 3x3 的中列下半也出：图案摆在网格里任意位置都算', () => {
    const lower = grid(THREE_BY_THREE, [4, ItemType.OakPlanks], [7, ItemType.OakPlanks]);
    expect(matchRecipe(lower, THREE_BY_THREE)).toEqual(STICKS_X4);
  });

  it('一块木板不出：那不是任何配方', () => {
    expect(matchRecipe(grid(TWO_BY_TWO, [0, ItemType.OakPlanks]), TWO_BY_TWO)).toBeUndefined();
  });
});

describe('配方表里的木板出工作台', () => {
  /** 一个工作台。 */
  const TABLE_X1 = { item: ItemType.CraftingTable, count: 1 };

  it('4 块木板摆满 2x2 出 1 个工作台', () => {
    const full = grid(
      TWO_BY_TWO,
      [0, ItemType.OakPlanks],
      [1, ItemType.OakPlanks],
      [2, ItemType.OakPlanks],
      [3, ItemType.OakPlanks],
    );
    expect(matchRecipe(full, TWO_BY_TWO)).toEqual(TABLE_X1);
  });

  it('3 块不出：少一角就不是那个方形', () => {
    const three = grid(
      TWO_BY_TWO,
      [0, ItemType.OakPlanks],
      [1, ItemType.OakPlanks],
      [2, ItemType.OakPlanks],
    );
    expect(matchRecipe(three, TWO_BY_TWO)).toBeUndefined();
  });

  it('2x2 方形摆在 3x3 的右下角也出：图案摆在网格里任意位置都算', () => {
    const corner = grid(
      THREE_BY_THREE,
      [4, ItemType.OakPlanks],
      [5, ItemType.OakPlanks],
      [7, ItemType.OakPlanks],
      [8, ItemType.OakPlanks],
    );
    expect(matchRecipe(corner, THREE_BY_THREE)).toEqual(TABLE_X1);
  });
});

describe('有序配方的匹配规则（测试内构造的配方）', () => {
  it('图案贴在 2x2 的左列或右列都识别', () => {
    const left = grid(TWO_BY_TWO, [0, ItemType.Dirt], [2, ItemType.OakLog]);
    const right = grid(TWO_BY_TWO, [1, ItemType.Dirt], [3, ItemType.OakLog]);
    expect(matchRecipe(left, TWO_BY_TWO, [TALL])).toEqual(PLANKS_X4);
    expect(matchRecipe(right, TWO_BY_TWO, [TALL])).toEqual(PLANKS_X4);
  });

  it('图案在 3x3 里贴左上角与贴右下角都识别', () => {
    const topLeft = grid(THREE_BY_THREE, [0, ItemType.Dirt], [3, ItemType.OakLog]);
    const bottomRight = grid(THREE_BY_THREE, [5, ItemType.Dirt], [8, ItemType.OakLog]);
    expect(matchRecipe(topLeft, THREE_BY_THREE, [TALL])).toEqual(PLANKS_X4);
    expect(matchRecipe(bottomRight, THREE_BY_THREE, [TALL])).toEqual(PLANKS_X4);
  });

  it('横着摆不识别：有序配方看形状', () => {
    const across = grid(TWO_BY_TWO, [0, ItemType.Dirt], [1, ItemType.OakLog]);
    expect(matchRecipe(across, TWO_BY_TWO, [TALL])).toBeUndefined();
  });

  it('上下翻转不识别', () => {
    const flipped = grid(TWO_BY_TWO, [0, ItemType.OakLog], [2, ItemType.Dirt]);
    expect(matchRecipe(flipped, TWO_BY_TWO, [TALL])).toBeUndefined();
  });

  it('材料对、格数对、位置错了不识别', () => {
    // 对角摆：包围矩形是 2x2，与 1x2 的图案尺寸不同
    const diagonal = grid(TWO_BY_TWO, [0, ItemType.Dirt], [3, ItemType.OakLog]);
    expect(matchRecipe(diagonal, TWO_BY_TWO, [TALL])).toBeUndefined();
  });

  it('多摆一格无关材料就不识别', () => {
    const extra = grid(TWO_BY_TWO, [0, ItemType.Dirt], [2, ItemType.OakLog], [1, ItemType.Dirt]);
    expect(matchRecipe(extra, TWO_BY_TWO, [TALL])).toBeUndefined();
  });

  it('允许镜像的配方，原图案与左右镜像都识别', () => {
    const original = grid(TWO_BY_TWO, [0, ItemType.Dirt], [1, ItemType.OakLog], [2, ItemType.OakLog]);
    const mirrored = grid(TWO_BY_TWO, [1, ItemType.Dirt], [0, ItemType.OakLog], [3, ItemType.OakLog]);
    expect(matchRecipe(original, TWO_BY_TWO, [ASYMMETRIC_MIRRORED])).toEqual(PLANKS_X4);
    expect(matchRecipe(mirrored, TWO_BY_TWO, [ASYMMETRIC_MIRRORED])).toEqual(PLANKS_X4);
  });

  it('不允许镜像的配方，左右镜像不识别', () => {
    const mirrored = grid(TWO_BY_TWO, [1, ItemType.Dirt], [0, ItemType.OakLog], [3, ItemType.OakLog]);
    expect(matchRecipe(mirrored, TWO_BY_TWO, [ASYMMETRIC])).toBeUndefined();
  });

  it('允许镜像也不等于允许上下翻转', () => {
    const flipped = grid(TWO_BY_TWO, [2, ItemType.Dirt], [3, ItemType.OakLog], [0, ItemType.OakLog]);
    expect(matchRecipe(flipped, TWO_BY_TWO, [ASYMMETRIC_MIRRORED])).toBeUndefined();
  });

  it('图案里的空格必须真的空着', () => {
    const filled = grid(
      TWO_BY_TWO,
      [0, ItemType.Dirt],
      [1, ItemType.OakLog],
      [2, ItemType.OakLog],
      [3, ItemType.Dirt],
    );
    expect(matchRecipe(filled, TWO_BY_TWO, [ASYMMETRIC_MIRRORED])).toBeUndefined();
  });

  it('几条配方同在表里时，命中哪条就出哪条的成品', () => {
    const tall = grid(TWO_BY_TWO, [0, ItemType.Dirt], [2, ItemType.OakLog]);
    const table: Recipe[] = [ASYMMETRIC, TALL, ...RECIPES];
    expect(matchRecipe(tall, TWO_BY_TWO, table)).toEqual(PLANKS_X4);
    expect(matchRecipe(grid(TWO_BY_TWO, [3, ItemType.OakLog]), TWO_BY_TWO, table)).toEqual(
      PLANKS_X4,
    );
  });
});

describe('无序配方的匹配规则（测试内构造的配方）', () => {
  /** 一泥土加一原木，摆哪儿都行。 */
  const PAIR: Recipe = {
    kind: 'shapeless',
    result: PLANKS_X4,
    ingredients: [ItemType.Dirt, ItemType.OakLog],
  };

  it('两样材料对角摆、横摆都识别', () => {
    const diagonal = grid(TWO_BY_TWO, [0, ItemType.Dirt], [3, ItemType.OakLog]);
    const across = grid(TWO_BY_TWO, [1, ItemType.OakLog], [0, ItemType.Dirt]);
    expect(matchRecipe(diagonal, TWO_BY_TWO, [PAIR])).toEqual(PLANKS_X4);
    expect(matchRecipe(across, TWO_BY_TWO, [PAIR])).toEqual(PLANKS_X4);
  });

  it('少摆一样不识别：材料要正好那么多', () => {
    expect(matchRecipe(grid(TWO_BY_TWO, [0, ItemType.Dirt]), TWO_BY_TWO, [PAIR])).toBeUndefined();
  });

  it('份数不对不识别：两个泥土不等于一泥土一原木', () => {
    const twoDirt = grid(TWO_BY_TWO, [0, ItemType.Dirt], [1, ItemType.Dirt]);
    expect(matchRecipe(twoDirt, TWO_BY_TWO, [PAIR])).toBeUndefined();
  });
});

describe('配方摆得进哪种网格', () => {
  it('1x3 横排的图案摆不进 2x2，摆得进 3x3', () => {
    expect(recipeFits(WIDE, TWO_BY_TWO)).toBe(false);
    expect(recipeFits(WIDE, THREE_BY_THREE)).toBe(true);
  });

  it('图案大于网格的配方在那个网格里永远匹配不到', () => {
    // 2x2 里摆满泥土：形状与 1x3 无关，而这条配方在 2x2 里根本不该被拿来比
    const full = grid(TWO_BY_TWO, [0, ItemType.Dirt], [1, ItemType.Dirt], [2, ItemType.Dirt], [3, ItemType.Dirt]);
    expect(matchRecipe(full, TWO_BY_TWO, [WIDE])).toBeUndefined();
    // 同一图案在 3x3 里横着摆就识别
    const across = grid(THREE_BY_THREE, [3, ItemType.Dirt], [4, ItemType.Dirt], [5, ItemType.Dirt]);
    expect(matchRecipe(across, THREE_BY_THREE, [WIDE])).toEqual(PLANKS_X4);
  });

  it('无序配方看材料数：五样材料摆不进 2x2', () => {
    const five: Recipe = {
      kind: 'shapeless',
      result: PLANKS_X4,
      ingredients: [ItemType.Dirt, ItemType.Dirt, ItemType.Dirt, ItemType.Dirt, ItemType.Dirt],
    };
    expect(recipeFits(five, TWO_BY_TWO)).toBe(false);
    expect(recipeFits(five, THREE_BY_THREE)).toBe(true);
  });
});

describe('配方书列出哪些配方', () => {
  it('2x2 的配方书不列出需要 3x3 的配方，3x3 的列出，顺序照配方表', () => {
    const table: Recipe[] = [WIDE, ...RECIPES];
    expect(recipesFor(TWO_BY_TWO, table)).toEqual(RECIPES);
    expect(recipesFor(THREE_BY_THREE, table)).toEqual(table);
  });

  it('默认列的是配方表', () => {
    expect(recipesFor(TWO_BY_TWO)).toEqual(RECIPES);
  });
});

describe('配方书自动摆料的图案', () => {
  it('有序配方贴左上角、不镜像', () => {
    // 右上泥土、左上原木、左下原木的镜像图案摆出来还是原图案：左上泥土
    expect(layoutRecipe(ASYMMETRIC_MIRRORED, THREE_BY_THREE)).toEqual([
      ItemType.Dirt, ItemType.OakLog, undefined,
      ItemType.OakLog, undefined, undefined,
      undefined, undefined, undefined,
    ]);
  });

  it('无序配方的材料从左上角起按行排开', () => {
    const pair: Recipe = {
      kind: 'shapeless',
      result: PLANKS_X4,
      ingredients: [ItemType.Dirt, ItemType.OakLog, ItemType.Dirt],
    };
    expect(layoutRecipe(pair, TWO_BY_TWO)).toEqual([
      ItemType.Dirt, ItemType.OakLog,
      ItemType.Dirt, undefined,
    ]);
  });

  it('摆出来的图案正好匹配这条配方本身', () => {
    for (const recipe of RECIPES) {
      expect(matchRecipe(layoutRecipe(recipe, TWO_BY_TWO), TWO_BY_TWO)).toEqual(recipe.result);
    }
  });
});

describe('配方要哪些材料', () => {
  it('有序配方数图案里的非空格，同种的合计', () => {
    expect(ingredientCounts(ASYMMETRIC)).toEqual(
      new Map([[ItemType.Dirt, 1], [ItemType.OakLog, 2]]),
    );
  });

  it('无序配方数材料表', () => {
    const pair: Recipe = {
      kind: 'shapeless',
      result: PLANKS_X4,
      ingredients: [ItemType.Dirt, ItemType.Dirt],
    };
    expect(ingredientCounts(pair)).toEqual(new Map([[ItemType.Dirt, 2]]));
  });
});
