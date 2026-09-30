import { describe, expect, it } from 'vitest';
import { BlockStateKind, BlockType, miningTicks } from '../../src/core/block';
import { CHUNK_SIZE, UNLOAD_MARGIN } from '../../src/core/constants';
import type { Chunk } from '../../src/core/chunk';
import { PICKUP_DELAY_TICKS } from '../../src/core/drop';
import { GameCore } from '../../src/core/game';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../../src/core/inventory';
import { BARE_HAND, ItemType, miningToolOf, type ItemStack } from '../../src/core/item';
import { IDLE_INTENT, MAX_PITCH, PLAYER_EYE_HEIGHT, WALK_STEP } from '../../src/core/player';
import { SMELT_TICKS } from '../../src/core/smelting';
import { FLAT_GROUND_Y, FLAT_STAND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/** 视距 1 的平地核心：死亡与重生的断言要推进几百 tick，区块少一点跑得快。 */
function core(): GameCore {
  return new GameCore({ viewRadius: 1, chunkSource: () => flatTestTerrain });
}

/** 落差这么多格摔 21 点，满血也扣到 0。 */
const LETHAL_DEPTH = 24;

const PICKAXE = { item: ItemType.WoodenPickaxe, count: 1 };

/** 朝 +X 看的偏航。 */
const EAST_YAW = -Math.PI / 2;

/** 把 (x, z) 那一列从最高的方块往下挖空 depth 格。 */
function digShaft(game: GameCore, x: number, z: number, depth: number): void {
  const top = game.highestBlockY(x, z);
  for (let y = top; y > top - depth; y--) game.setBlock(x, y, z, BlockType.Air);
}

/** 挖空玩家脚下那一列，推进到摔死为止。返回死在哪里。 */
function fallToDeath(game: GameCore): { x: number; y: number; z: number } {
  const { x, z } = game.player.position;
  digShaft(game, Math.floor(x), Math.floor(z), LETHAL_DEPTH);
  for (let n = 0; n < 100 && !game.health.dead; n++) game.tick();
  if (!game.health.dead) throw new Error('100 tick 还没摔死');
  return game.player.position;
}

/** 转向 +X、走 ticks 个 tick 再站定。俯仰不动。 */
function walkEast(game: GameCore, ticks: number): void {
  game.turn(EAST_YAW - game.player.yaw, 0);
  game.setMoveIntent({ ...IDLE_INTENT, forward: true });
  game.tick(ticks);
  game.setMoveIntent(IDLE_INTENT);
}

/** 背包 36 格，按下标顺序，空格是 undefined。 */
function allSlots(game: GameCore): Array<ItemStack | undefined> {
  return Array.from({ length: INVENTORY_SIZE }, (_, i) => game.inventory.slot(i));
}

/** 背包 36 格里有东西的那些格。 */
function filledSlots(game: GameCore): ItemStack[] {
  return allSlots(game).filter((stack): stack is ItemStack => stack !== undefined);
}

/**
 * 背包里有一把挖过一块草的木镐（损耗 1）、那块草掉的 1 个泥土、74 个圆石（两堆）与 5 个煤炭，
 * 经验 30 点（挖草给的），站在出生点那一坑里的核心。
 */
function withBelongings(): GameCore {
  const game = core();
  game.giveItem(ItemType.WoodenPickaxe, 1);
  game.turn(0, -MAX_PITCH);
  game.tick();
  game.setMining(true);
  game.tick(miningTicks(BlockType.Grass, miningToolOf(PICKAXE)));
  game.setMining(false);
  game.tick(PICKUP_DELAY_TICKS + 2);
  game.giveItem(ItemType.Cobblestone, 74);
  game.giveItem(ItemType.Coal, 5);
  expect(game.inventory.slot(0)).toEqual({ ...PICKAXE, damage: 1 });
  expect(game.experience.total).toBe(30);
  return game;
}

/** 12 种工具：一格一件，给几件占几格。 */
const TOOLS = [
  ItemType.WoodenPickaxe,
  ItemType.WoodenAxe,
  ItemType.WoodenShovel,
  ItemType.WoodenSword,
  ItemType.StonePickaxe,
  ItemType.StoneAxe,
  ItemType.StoneShovel,
  ItemType.StoneSword,
  ItemType.IronPickaxe,
  ItemType.IronAxe,
  ItemType.IronShovel,
  ItemType.IronSword,
];

/** 12 种可堆叠的物品：每种给 64 加一个零头，占两格。 */
const STACKABLES = [
  ItemType.Dirt,
  ItemType.OakLog,
  ItemType.OakPlanks,
  ItemType.Stick,
  ItemType.CraftingTable,
  ItemType.Cobblestone,
  ItemType.Furnace,
  ItemType.Coal,
  ItemType.RawIron,
  ItemType.IronIngot,
  ItemType.Charcoal,
  ItemType.RottenFlesh,
];

/** 拿着选中格那件工具，把正前方眼高那一格的树叶挖掉 blocks 次。树叶什么都不掉，背包不多东西。 */
function wearOnLeaves(game: GameCore, blocks: number): void {
  const at: [number, number, number] = [0, Math.floor(FLAT_STAND_Y + PLAYER_EYE_HEIGHT), -1];
  for (let i = 0; i < blocks; i++) {
    game.setBlock(...at, BlockType.OakLeaves);
    game.setMining(true);
    for (let n = 0; n < 100 && game.getBlock(...at) !== BlockType.Air; n++) game.tick();
    if (game.getBlock(...at) !== BlockType.Air) throw new Error('100 tick 还没挖掉树叶');
    game.setMining(false);
    game.tick();
  }
}

/**
 * 36 格全部放满、每格都不一样的核心：前 12 格是 12 种工具，快捷栏里那 9 件第 i 格挖掉 i + 1 块树叶，
 * 损耗各不相同；之后 24 格是 12 种可堆叠物品，每种一堆 64、一堆零头（零头各不相同）。
 * 储物格里也要有带损耗的工具：打开背包，把快捷栏第 0 格那件与储物格倒数第二格那一堆 64 对调。
 * 对调的是整 64 那一堆而不是零头：零头排在同种的整堆前面的话，拾回时零头先占一格，整堆随后拾取、
 * 并入那一格，排列就与死前不同了。
 */
function withFullInventory(): GameCore {
  const game = core();
  for (const tool of TOOLS) game.giveItem(tool, 1);
  for (let slot = 0; slot < HOTBAR_SIZE; slot++) {
    game.selectHotbarSlot(slot);
    game.tick();
    wearOnLeaves(game, slot + 1);
  }
  STACKABLES.forEach((item, i) => game.giveItem(item, 64 + i + 1));
  game.toggleInventory();
  game.tick();
  game.clickSlot(0);
  game.clickSlot(INVENTORY_SIZE - 2);
  game.clickSlot(0);
  game.tick();
  game.toggleInventory();
  game.tick();
  return game;
}

describe('GameCore 的死亡', () => {
  it('生命归零时背包每堆各掉一个掉落物在死亡处，累计经验装进一个经验球；背包空、经验 0、等级 0', () => {
    const game = withBelongings();
    const at = fallToDeath(game);

    expect(game.drops.all().map(({ item, count }) => ({ item, count }))).toEqual([
      PICKAXE,
      { item: ItemType.Dirt, count: 1 },
      { item: ItemType.Cobblestone, count: 64 },
      { item: ItemType.Cobblestone, count: 10 },
      { item: ItemType.Coal, count: 5 },
    ]);
    for (const drop of game.drops.all()) {
      expect(Math.floor(drop.position.x)).toBe(Math.floor(at.x));
      expect(Math.floor(drop.position.z)).toBe(Math.floor(at.z));
    }
    expect(game.xpOrbs.all().map((orb) => orb.amount)).toEqual([30]);
    expect(filledSlots(game)).toEqual([]);
    expect(game.experience.total).toBe(0);
    expect(game.experience.level).toBe(0);
  });

  it('36 格全部放满：死亡时恰好 36 个掉落物，逐堆对应；重生后拾回，工具的损耗随堆保留', () => {
    const game = withFullInventory();
    const before = allSlots(game);
    expect(before.every((stack) => stack !== undefined)).toBe(true);
    // 每格都不一样：掉落物与原来那一堆对应错了时，下面的逐堆比较能检测到
    expect(new Set(before.map((stack) => JSON.stringify(stack))).size).toBe(INVENTORY_SIZE);
    // 快捷栏与储物格里都有带损耗的工具
    const worn = before.flatMap((stack, i) => (stack?.damage ? [i] : []));
    expect(worn.some((i) => i < HOTBAR_SIZE)).toBe(true);
    expect(worn.some((i) => i >= HOTBAR_SIZE)).toBe(true);

    const at = fallToDeath(game);
    expect(game.drops.count).toBe(INVENTORY_SIZE);
    expect(game.drops.all().map(({ item, count }) => ({ item, count }))).toEqual(
      before.map((stack) => ({ item: stack!.item, count: stack!.count })),
    );
    for (const drop of game.drops.all()) {
      expect(Math.floor(drop.position.x)).toBe(Math.floor(at.x));
      expect(Math.floor(drop.position.z)).toBe(Math.floor(at.z));
    }
    expect(filledSlots(game)).toEqual([]);

    // 死在出生点那一列：重生的落点就是坑底，36 个掉落物都在脚边
    game.tick(PICKUP_DELAY_TICKS + 2);
    game.respawn();
    game.tick(20);
    expect(game.drops.count).toBe(0);
    expect(allSlots(game)).toEqual(before);
  });

  it('没有经验时不生成经验球', () => {
    const game = core();
    game.giveItem(ItemType.Coal, 1);
    fallToDeath(game);
    expect(game.drops.count).toBe(1);
    expect(game.xpOrbs.count).toBe(0);
  });

  it('死亡是界面模式，开着的界面随之关掉，光标上那一堆也掉在死亡处', () => {
    const game = core();
    game.giveItem(ItemType.Dirt, 5);
    game.toggleInventory();
    game.tick();
    game.clickSlot(0);
    game.tick();
    expect(game.inventoryScreen.cursor).toEqual({ item: ItemType.Dirt, count: 5 });

    // 界面开着照样受重力，摔死
    fallToDeath(game);
    expect(game.inventoryScreen.open).toBe(false);
    expect(game.inventoryScreen.cursor).toBeUndefined();
    expect(game.uiMode).toBe(true);
    expect(game.drops.all().map(({ item, count }) => ({ item, count }))).toEqual([
      { item: ItemType.Dirt, count: 5 },
    ]);
  });

  it('死亡期间位置不变，掉落物与经验球不被拾取', () => {
    const game = withBelongings();
    const at = fallToDeath(game);
    game.tick(100);
    expect(game.player.position).toEqual(at);
    expect(game.player.previousPosition).toEqual(at);
    expect(game.drops.count).toBe(5);
    expect(game.xpOrbs.count).toBe(1);
    expect(filledSlots(game)).toEqual([]);
    expect(game.experience.total).toBe(0);
  });

  it('死亡期间移动、挖掘、使用、背包键、转视角都无效', () => {
    const game = core();
    game.turn(0, -MAX_PITCH);
    // 坑底换成工作台：使用键对着它会开工作台界面，挖掘键按住会把它挖掉
    game.setBlock(0, FLAT_GROUND_Y - LETHAL_DEPTH, 0, BlockType.CraftingTable);
    const at = fallToDeath(game);
    const { yaw, pitch } = game.player;

    game.setMoveIntent({ ...IDLE_INTENT, forward: true, jump: true });
    game.setMining(true);
    game.use();
    game.toggleInventory();
    game.turn(1, 1);
    game.tick(miningTicks(BlockType.CraftingTable, BARE_HAND) + 1);

    expect(game.player.position).toEqual(at);
    expect(game.player.yaw).toBe(yaw);
    expect(game.player.pitch).toBe(pitch);
    expect(game.getBlock(0, FLAT_GROUND_Y - LETHAL_DEPTH, 0)).toBe(BlockType.CraftingTable);
    expect(game.mining.progress).toBe(0);
    expect(game.craftingTableScreen.open).toBe(false);
    expect(game.inventoryScreen.open).toBe(false);
  });

  describe('摔死的那一 tick', () => {
    /** 抬头看坑壁的俯仰：视线落在头顶上方那一格的坑壁侧面上。 */
    const LOOK_UP = Math.PI / 3;

    /** 手上 1 个泥土、抬头朝 −Z 看、脚下挖空 depth 格的核心。 */
    function aboutToFall(depth: number): GameCore {
      const game = core();
      game.giveItem(ItemType.Dirt, 1);
      game.turn(0, LOOK_UP);
      digShaft(game, 0, 0, depth);
      return game;
    }

    /** 从 depth 格高处落地要几 tick。 */
    function ticksToLand(depth: number): number {
      const game = aboutToFall(depth);
      for (let n = 1; n <= 100; n++) {
        game.tick();
        if (game.player.onGround) return n;
      }
      throw new Error('100 tick 还没落地');
    }

    /**
     * 落地那一 tick 按下使用键。视线从眼睛斜向上穿过半格，落在坑壁上头顶之上那一格的侧面，
     * 放下的那一格在坑里、头顶上方，不与玩家相交。返回核心与那一格的坐标。
     */
    function useOnLandingTick(depth: number): { game: GameCore; above: [number, number, number] } {
      const game = aboutToFall(depth);
      game.tick(ticksToLand(depth) - 1);
      game.use();
      game.tick();
      const eyeY = FLAT_STAND_Y - depth + PLAYER_EYE_HEIGHT;
      return { game, above: [0, Math.floor(eyeY + 0.5 * Math.tan(LOOK_UP)), 0] };
    }

    it('没摔死时落地那一 tick 的使用键照常放下方块', () => {
      const { game, above } = useOnLandingTick(4);
      expect(game.health.dead).toBe(false);
      expect(game.getBlock(...above)).toBe(BlockType.Dirt);
    });

    it('摔死时落地那一 tick 的使用键不生效，手上那个泥土掉在死亡处', () => {
      const { game, above } = useOnLandingTick(LETHAL_DEPTH);
      expect(game.health.dead).toBe(true);
      expect(game.getBlock(...above)).toBe(BlockType.Air);
      expect(game.drops.all().map(({ item, count }) => ({ item, count }))).toEqual([
        { item: ItemType.Dirt, count: 1 },
      ]);
    });
  });

  it('死亡期间不受重力：脚下挖空也不下落，不再受伤', () => {
    const game = core();
    const at = fallToDeath(game);
    const diedAt = game.health.lastHurtTick;
    digShaft(game, 0, 0, 8);
    game.tick(40);
    expect(game.player.position).toEqual(at);
    expect(game.health.lastHurtTick).toBe(diedAt);
  });

  it('死亡期间熔炉照常熔炼，掉落物照常落到坑底', () => {
    const game = withBelongings();
    const furnaceAt: [number, number, number] = [3, FLAT_STAND_Y, 3];
    game.setBlock(...furnaceAt, BlockType.Furnace);
    const furnace = game.blockStateAt(...furnaceAt)!;
    if (furnace.kind !== BlockStateKind.Furnace) throw new Error('熔炉应有熔炉状态');
    furnace.input = { item: ItemType.RawIron, count: 1 };
    furnace.fuel = { item: ItemType.Coal, count: 1 };

    const at = fallToDeath(game);
    // 掉落物生成在那一格正中，比坑底高
    expect(game.drops.all().every((drop) => drop.position.y > at.y)).toBe(true);
    game.tick(SMELT_TICKS);
    expect(furnace.output).toEqual({ item: ItemType.IronIngot, count: 1 });
    for (const drop of game.drops.all()) expect(drop.position.y).toBeCloseTo(at.y, 10);
  });
});

describe('GameCore 的重生', () => {
  it('重生回到出生点，生命 20，「已死亡」为假，不在界面模式，可以移动', () => {
    const game = core();
    const spawn = game.spawnPoint;
    walkEast(game, 14);
    expect(Math.floor(game.player.position.x)).toBe(3);
    fallToDeath(game);

    game.respawn();
    expect(game.player.position).toEqual(spawn);
    // 上一 tick 的位置一并移过去：渲染层不会在死亡处与出生点之间插值一帧
    expect(game.player.previousPosition).toEqual(spawn);
    expect(game.health.points).toBe(20);
    expect(game.health.dead).toBe(false);
    expect(game.health.lastHurtTick).toBeUndefined();
    expect(game.uiMode).toBe(false);

    game.tick(5);
    expect(game.player.position).toEqual(spawn);
    game.setMoveIntent({ ...IDLE_INTENT, forward: true });
    game.tick(5);
    expect(game.player.position.x).toBeGreaterThan(spawn.x);
  });

  it('死亡期间的移动、挖掘、使用、背包键在重生后不生效', () => {
    const game = core();
    const spawn = game.spawnPoint;
    walkEast(game, 14);
    game.turn(0, -MAX_PITCH);
    fallToDeath(game);
    game.setMoveIntent({ ...IDLE_INTENT, forward: true });
    game.setMining(true);
    // 这两下还没到 tick 边界就重生了
    game.use();
    game.toggleInventory();

    game.respawn();
    game.tick(miningTicks(BlockType.Grass, BARE_HAND) + 1);
    expect(game.player.position).toEqual(spawn);
    expect(game.getBlock(0, FLAT_GROUND_Y, 0)).toBe(BlockType.Grass);
    expect(game.inventoryScreen.open).toBe(false);
    expect(game.uiMode).toBe(false);
  });

  it('重生后站到死亡处拾回全部东西：工具的损耗还在，经验也回来', () => {
    // 死在出生点那一列：重生的落点就是坑底，掉落物与经验球都在脚边
    const game = withBelongings();
    fallToDeath(game);
    game.tick(PICKUP_DELAY_TICKS + 2);
    game.respawn();
    game.tick(20);

    expect(game.drops.count).toBe(0);
    expect(game.xpOrbs.count).toBe(0);
    expect(filledSlots(game)).toEqual([
      { ...PICKAXE, damage: 1 },
      { item: ItemType.Dirt, count: 1 },
      { item: ItemType.Cobblestone, count: 64 },
      { item: ItemType.Cobblestone, count: 10 },
      { item: ItemType.Coal, count: 5 },
    ]);
    expect(game.experience.total).toBe(30);
  });

  it('没死时重生什么都不做', () => {
    const game = core();
    walkEast(game, 14);
    const at = game.player.position;
    game.respawn();
    expect(game.player.position).toEqual(at);
    expect(game.health.points).toBe(20);
  });

  describe('死在远处、出生点那个区块已经卸载', () => {
    /** 走到离原点这么多个区块之外，原点区块就卸载了（视距 1 加卸载余量）。 */
    const FAR_CHUNKS = 1 + UNLOAD_MARGIN + 1;
    /** 走到那里要几 tick：多走几格，越过区块边界。 */
    const FAR_TICKS = Math.ceil((FAR_CHUNKS * CHUNK_SIZE + 4) / WALK_STEP);

    /** 原点区块只在 originReady 为真时给得出来，其余照常。 */
    function coreWithGatedOrigin(): { game: GameCore; setOriginReady(ready: boolean): void } {
      let originReady = true;
      const game = new GameCore({
        viewRadius: 1,
        chunkSource: () => (cx: number, cz: number): Chunk | undefined =>
          cx === 0 && cz === 0 && !originReady ? undefined : flatTestTerrain(cx, cz),
      });
      return { game, setOriginReady: (ready) => (originReady = ready) };
    }

    it('原点区块没改过、还没送到：重生在进入世界时的出生点，等区块送到后站在地面上', () => {
      const { game, setOriginReady } = coreWithGatedOrigin();
      const spawn = game.spawnPoint;
      walkEast(game, FAR_TICKS);
      setOriginReady(false);
      fallToDeath(game);
      expect(game.isChunkLoaded(0, 0)).toBe(false);

      game.respawn();
      expect(game.player.position).toEqual(spawn);
      // 区块没到，玩家原地等待，不掉进「未加载即空气」里
      game.tick(20);
      expect(game.player.position).toEqual(spawn);

      setOriginReady(true);
      game.tick(20);
      expect(game.player.position).toEqual(spawn);
      expect(game.player.onGround).toBe(true);
      expect(game.health.points).toBe(20);
    });

    it('原点区块改过：重生按改过之后的方块算，站在出生点那一列新垒的柱子上', () => {
      const { game, setOriginReady } = coreWithGatedOrigin();
      walkEast(game, 10);
      game.setBlock(0, FLAT_STAND_Y, 0, BlockType.Cobblestone);
      game.setBlock(0, FLAT_STAND_Y + 1, 0, BlockType.Cobblestone);
      walkEast(game, FAR_TICKS);
      setOriginReady(false);
      fallToDeath(game);
      expect(game.isChunkLoaded(0, 0)).toBe(false);

      game.respawn();
      expect(game.player.position).toEqual({ x: 0.5, y: FLAT_STAND_Y + 2, z: 0.5 });
      game.tick(20);
      expect(game.player.position.y).toBe(FLAT_STAND_Y + 2);
      expect(game.player.onGround).toBe(true);
    });
  });
});

describe('GameCore 的 giveItem', () => {
  it('按进背包的规则放入：并进已有的未满堆，再占空格，装不下的返回余量', () => {
    const game = core();
    expect(game.giveItem(ItemType.Coal, 10)).toBe(0);
    expect(game.giveItem(ItemType.Coal, 60)).toBe(0);
    expect(game.inventory.slot(0)).toEqual({ item: ItemType.Coal, count: 64 });
    expect(game.inventory.slot(1)).toEqual({ item: ItemType.Coal, count: 6 });
    expect(game.giveItem(ItemType.Cobblestone, 64 * 34 + 7)).toBe(7);
  });

  it('剑一格一把、满耐久：给 2 把铁剑占两格，背包满了再给一把原样返回（#45）', () => {
    const game = core();
    expect(game.giveItem(ItemType.IronSword, 2)).toBe(0);
    expect(game.inventory.slot(0)).toEqual({ item: ItemType.IronSword, count: 1 });
    expect(game.inventory.slot(1)).toEqual({ item: ItemType.IronSword, count: 1 });
    expect(game.giveItem(ItemType.Dirt, 64 * 34)).toBe(0);
    expect(game.giveItem(ItemType.IronSword, 1)).toBe(1);
  });
});
