import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { GameCore } from '../../src/core/game';
import { ItemType, maxDurability, stackLimit, type ItemStack } from '../../src/core/item';
import { MAX_PITCH, PLAYER_EYE_HEIGHT } from '../../src/core/player';
import { ATTACK_COOLDOWN_TICKS, ATTACK_RANGE } from '../../src/core/attack';
import { ZOMBIE_XP, type ZombieView } from '../../src/core/zombie';
import { FLAT_STAND_Y, flatTestTerrain } from '../helpers/flat-terrain';

/*
 * 玩家攻击僵尸（#42）。玩家站在原点那一格中心，平视 −Z：眼睛在 (0.5, 72.62, 0.5)，视线沿 −Z 平着走。
 * 僵尸都生成在这条视线上，眼高落在它的碰撞箱（高 1.95）里。
 *
 * 僵尸会走过来打玩家（#43），玩家被打得上抛，视线就从它头顶过去了。要推进十几 tick 的测试用
 * `pennedZombieAhead` 把它关在够不着玩家的地方。
 */

const SEED = 1234;

/** 视线那一层的 y：眼睛所在的那一格。方块摆在这一层就挡在视线上。 */
const EYE_LAYER = Math.floor(FLAT_STAND_Y + PLAYER_EYE_HEIGHT);

function core(seed = SEED): GameCore {
  return new GameCore({ seed, viewRadius: 1, chunkSource: () => flatTestTerrain });
}

/** 在视线正前方生成一只僵尸：碰撞箱中心离玩家 distance 格（沿 −Z）。 */
function zombieAhead(game: GameCore, distance: number): void {
  game.spawnZombieAt(0.5, FLAT_STAND_Y, 0.5 - distance);
}

/**
 * 在视线正前方 2 格生成一只，走不过来：它与玩家之间那一格摆一格高的矮墙，它头顶那一层（y = 73）
 * 封住，跳不起来。它最近停在离玩家 1.8 格处，打不到玩家；视线从矮墙上方过去，照样落在它身上。
 * 头顶那一层也挡住了太阳：白天露天的僵尸会燃烧（#44），不挡的话掉的血就不全是打出来的。
 */
function pennedZombieAhead(game: GameCore): void {
  game.setBlock(0, FLAT_STAND_Y, -1, BlockType.Stone);
  for (let z = -3; z <= -2; z++) game.setBlock(0, FLAT_STAND_Y + 2, z, BlockType.Stone);
  zombieAhead(game, 2);
}

function onlyZombie(game: GameCore): ZombieView {
  const [zombie] = game.zombies.all();
  if (!zombie || game.zombies.count !== 1) throw new Error(`应当正好一只僵尸，现在 ${game.zombies.count} 只`);
  return zombie;
}

/** 按下左键，推进一 tick：按下那一 tick 就是分派的那一 tick。 */
function press(game: GameCore): void {
  game.setMining(true);
  game.tick();
}

/**
 * 松开左键，推进到第 at − 1 个 tick，再按下：第 at 个 tick 是按下的那一 tick。
 * 松开至少要占一个 tick，核心才看得到一次「没按着」。
 */
function pressAt(game: GameCore, at: number): void {
  const idle = at - 1 - game.tickCount;
  if (idle < 1) throw new Error(`第 ${at} tick 来不及先松开再按`);
  game.setMining(false);
  game.tick(idle);
  press(game);
}

/** 手上那一把工具损耗了几点。 */
function wear(game: GameCore): number {
  const held: ItemStack | undefined = game.inventory.held;
  return held?.damage ?? 0;
}

function horizontalDistance(zombie: ZombieView, game: GameCore): number {
  const { x, z } = game.player.position;
  return Math.hypot(zombie.position.x - x, zombie.position.z - z);
}

describe('左键按下那一 tick 视线先碰到僵尸：攻击', () => {
  it('空手打 2 格外的僵尸：生命 19、被推离、往上抛，按着不放下一 tick 也不挖', () => {
    const game = core();
    // 僵尸后面 4 格处摆一块石头：按着不放要是转成挖掘，它会有进度
    game.setBlock(0, EYE_LAYER, -4, BlockType.Stone);
    zombieAhead(game, 2);
    press(game);

    const zombie = onlyZombie(game);
    expect(zombie.health).toBe(19);
    expect(horizontalDistance(zombie, game)).toBeGreaterThan(2);
    expect(zombie.position.y).toBeGreaterThan(FLAT_STAND_Y);
    expect(game.mining.progress).toBe(0);

    game.tick();
    expect(game.mining.progress).toBe(0);
  });

  it('这一次按住分给了攻击：僵尸被抬起、露出身后的地面，按着不放也不挖', () => {
    const game = core();
    // 低头到视线斜率 0.8：碰撞箱正面（水平 1.7 格）处视线还在脚面之上，打得到腿；击退把它往后推、
    // 往上抬 0.4 格之后，视线从它身下穿过去，落到后面的地面上
    game.turn(0, -Math.atan(0.8));
    zombieAhead(game, 2);
    press(game);
    expect(onlyZombie(game).health).toBe(19);

    let sawGround = false;
    for (let i = 0; i < 5; i++) {
      game.tick();
      if (game.mining.target) sawGround = true;
      expect(game.mining.progress).toBe(0);
    }
    // 确认这几 tick 里视线确实落到过方块上：否则这条测试什么都没测到
    expect(sawGround).toBe(true);
  });

  it('持铁斧 11、耐久损 2；持木镐 18、耐久损 2', () => {
    for (const [item, health] of [
      [ItemType.IronAxe, 11],
      [ItemType.WoodenPickaxe, 18],
    ] as const) {
      const game = core();
      game.giveItem(item, 1);
      zombieAhead(game, 2);
      press(game);
      expect(onlyZombie(game).health, `物品 ${item}`).toBe(health);
      expect(wear(game), `物品 ${item}`).toBe(2);
    }
  });

  it('攻击距离 3 格，与触及距离分开：4 格外按左键没有任何反应', () => {
    expect(ATTACK_RANGE).toBe(3);
    const game = core();
    game.giveItem(ItemType.WoodenPickaxe, 1);
    // 碰撞箱前面离眼睛 4 格
    zombieAhead(game, 4.3);
    press(game);
    expect(onlyZombie(game).health).toBe(20);
    expect(wear(game)).toBe(0);
  });

  it('僵尸站在方块后面、方块更近：这一下是挖掘，僵尸不掉血', () => {
    const game = core();
    game.setBlock(0, EYE_LAYER, -1, BlockType.Stone);
    zombieAhead(game, 3);
    press(game);
    expect(game.mining.target).toMatchObject({ x: 0, y: EYE_LAYER, z: -1 });
    expect(game.mining.progress).toBeGreaterThan(0);
    expect(onlyZombie(game).health).toBe(20);
  });

  it('僵尸在方块前面、僵尸更近：这一下是攻击，方块没有进度', () => {
    const game = core();
    game.setBlock(0, EYE_LAYER, -3, BlockType.Stone);
    zombieAhead(game, 1.5);
    press(game);
    expect(onlyZombie(game).health).toBe(19);
    expect(game.mining.progress).toBe(0);
  });
});

describe('不自动连击，出手冷却 10 tick，僵尸受击后无敌 10 tick', () => {
  it('按住左键 30 tick，僵尸只掉一次血', () => {
    const game = core();
    pennedZombieAhead(game);
    game.setMining(true);
    game.tick(30);
    expect(onlyZombie(game).health).toBe(19);
  });

  it('松开再按，距上次出手不足 10 tick 不出手：不掉血，也不损耗耐久', () => {
    expect(ATTACK_COOLDOWN_TICKS).toBe(10);
    const game = core();
    game.giveItem(ItemType.WoodenPickaxe, 1);
    zombieAhead(game, 2);
    press(game);
    const first = game.tickCount;
    expect(onlyZombie(game).health).toBe(18);

    pressAt(game, first + 9);
    expect(onlyZombie(game).health).toBe(18);
    expect(wear(game)).toBe(2);
  });

  it('满 10 tick 出手，损耗耐久；但僵尸还在受击后的 10 tick 里，不掉血', () => {
    const game = core();
    game.giveItem(ItemType.WoodenPickaxe, 1);
    zombieAhead(game, 2);
    press(game);
    const first = game.tickCount;

    pressAt(game, first + 10);
    expect(wear(game)).toBe(4);
    expect(onlyZombie(game).health).toBe(18);
  });

  it('隔 11 tick 再打，僵尸掉血', () => {
    const game = core();
    game.giveItem(ItemType.WoodenPickaxe, 1);
    pennedZombieAhead(game);
    press(game);
    const first = game.tickCount;

    pressAt(game, first + 11);
    expect(onlyZombie(game).health).toBe(16);
    expect(wear(game)).toBe(4);
  });
});

describe('僵尸挡在方块前面：没有目标方块', () => {
  it('选框消失，使用键也没有目标：隔着僵尸放不了方块', () => {
    const game = core();
    game.setBlock(0, EYE_LAYER, -3, BlockType.Stone);
    game.giveItem(ItemType.Dirt, 5);
    game.tick();
    expect(game.mining.target).toMatchObject({ x: 0, y: EYE_LAYER, z: -3 });

    zombieAhead(game, 1.5);
    game.use();
    game.tick();
    expect(game.mining.target).toBeUndefined();
    expect(game.getBlock(0, EYE_LAYER, -2)).toBe(BlockType.Air);
    expect(game.inventory.held).toEqual({ item: ItemType.Dirt, count: 5 });
  });
});

describe('按下左键是一次性输入，排队到下一个 tick 边界（ADR-0004）', () => {
  it('两个 tick 之间按下又松开：这一下仍算出手，挥动也记下', () => {
    const game = core();
    zombieAhead(game, 2);
    game.setMining(true);
    game.setMining(false);
    game.tick();
    expect(onlyZombie(game).health).toBe(19);
    expect(game.lastSwingTick).toBe(game.tickCount);
  });

  it('两个 tick 之间松开又按下：算一次新的按下', () => {
    const game = core();
    game.giveItem(ItemType.WoodenPickaxe, 1);
    pennedZombieAhead(game);
    game.setMining(true);
    game.tick();
    game.tick(10);
    // 一直按着，但在第 11 tick 之前松开又按下了一次
    game.setMining(false);
    game.setMining(true);
    game.tick();
    expect(onlyZombie(game).health).toBe(16);
  });

  it('界面开着时按下左键不出手；关掉界面时左键还按着也不算按下，松开再按才出手', () => {
    const game = core();
    pennedZombieAhead(game);
    game.toggleInventory();
    game.tick();
    expect(game.uiMode).toBe(true);
    game.setMining(true);
    game.tick();
    game.toggleInventory();
    game.tick(3);
    expect(game.uiMode).toBe(false);
    expect(onlyZombie(game).health).toBe(20);
    expect(game.lastSwingTick).toBeUndefined();

    game.setMining(false);
    game.tick();
    press(game);
    expect(onlyZombie(game).health).toBe(19);
  });

  it('打过僵尸、松开之后，在界面里按住左键再关掉界面：按挖掘处理，不沿用上一次的攻击分派', () => {
    const game = core();
    zombieAhead(game, 2);
    press(game);
    expect(onlyZombie(game).health).toBe(19);
    game.setMining(false);
    game.tick();

    // 转向左手边那块石头（−X 方向），僵尸不在这条视线上
    game.setBlock(-2, EYE_LAYER, 0, BlockType.Stone);
    game.turn(Math.PI / 2, 0);
    game.toggleInventory();
    game.tick();
    game.setMining(true);
    game.tick();
    game.toggleInventory();
    game.tick(3);
    expect(game.mining.target).toMatchObject({ x: -2, y: EYE_LAYER, z: 0 });
    expect(game.mining.progress).toBeGreaterThan(0);
  });

  it('按住左键用使用键开工作台，下一 tick 关掉：之前那次按住的分派不留下，松开再按照常分派', () => {
    const game = core();
    game.setBlock(0, EYE_LAYER, -2, BlockType.CraftingTable);
    game.setMining(true);
    game.tick();
    game.use();
    game.tick();
    expect(game.craftingTableScreen.open).toBe(true);
    game.toggleInventory();
    game.tick();
    expect(game.uiMode).toBe(false);
    // 工作台拆掉，僵尸走进视线
    game.setBlock(0, EYE_LAYER, -2, BlockType.Air);
    zombieAhead(game, 2);
    game.setMining(false);
    game.tick();
    press(game);
    expect(onlyZombie(game).health).toBe(19);
  });
});

describe('挖掘途中僵尸挡到视线前面', () => {
  it('目标丢失、进度归零，不自动改打僵尸', () => {
    const game = core();
    game.setBlock(0, EYE_LAYER, -3, BlockType.Stone);
    game.setMining(true);
    game.tick(5);
    expect(game.mining.progress).toBeGreaterThan(0);

    // 石头的正面离眼睛 2.5 格，僵尸挡在两者中间
    zombieAhead(game, 1.3);
    game.tick();
    expect(game.mining.progress).toBe(0);
    expect(game.mining.target).toBeUndefined();
    expect(onlyZombie(game).health).toBe(20);
  });
});

/**
 * 把一只僵尸关在视线正前方：它与玩家之间立一道墙，脚下那一层与头顶之上那一层是方块，眼高那一层
 * 空着。视线从空着的那一格穿过去打得到它；它走不过来（身子被脚下那块挡住），也跳不上去（抬高一格
 * 会顶到上面那块）。不关住的话它追到玩家身上，掉的经验球同一 tick 就被吸走了。
 *
 * 墙在 z = −1 那一格，僵尸贴着墙站在 z = −1.3，碰撞箱正面离眼睛 1.5 格。它身后被击退到的那几格
 * 头顶也盖上，挡住太阳：白天露天的僵尸会燃烧（#44），不挡的话它掉的血就不全是打出来的。
 */
function pennedZombie(game: GameCore): void {
  game.setBlock(0, EYE_LAYER - 1, -1, BlockType.Stone);
  for (let z = -5; z <= -1; z++) game.setBlock(0, EYE_LAYER + 1, z, BlockType.Stone);
  zombieAhead(game, 2);
}

/**
 * 空手每隔 11 tick 打一下，直到僵尸消失。返回打了几下与最后一下按下之前它所在的位置。
 * 11 tick 而不是 10：隔 10 tick 那一下落在僵尸的无敌时间里，不掉血。
 */
function beatToDeath(game: GameCore) {
  let hits = 0;
  let last = onlyZombie(game).position;
  press(game);
  hits++;
  while (game.zombies.count > 0) {
    if (hits >= 40) throw new Error('打了 40 下还没死');
    game.setMining(false);
    game.tick(10);
    last = onlyZombie(game).position;
    press(game);
    hits++;
  }
  return { hits, last };
}

/** 世界里腐肉掉落物的总件数。 */
function fleshOnGround(game: GameCore): number {
  return game.drops
    .all()
    .filter((drop) => drop.item === ItemType.RottenFlesh)
    .reduce((sum, drop) => sum + drop.count, 0);
}

describe('击杀', () => {
  it('空手打 20 下僵尸消失，原位有 50 点经验球与 0 到 2 件腐肉；经验球飞到玩家后经验值 50', () => {
    const game = core();
    pennedZombie(game);
    const { hits, last } = beatToDeath(game);
    expect(hits).toBe(20);

    expect(ZOMBIE_XP).toBe(50);
    expect(game.xpOrbs.all().map((orb) => orb.amount)).toEqual([50]);
    const [orb] = game.xpOrbs.all();
    expect(Math.abs(orb!.position.x - last.x)).toBeLessThan(1);
    expect(Math.abs(orb!.position.z - last.z)).toBeLessThan(1);
    const flesh = fleshOnGround(game);
    expect(flesh).toBeGreaterThanOrEqual(0);
    expect(flesh).toBeLessThanOrEqual(2);
    for (const drop of game.drops.all()) {
      expect(Math.abs(drop.position.x - last.x)).toBeLessThan(1);
      expect(Math.abs(drop.position.z - last.z)).toBeLessThan(1);
    }

    game.tick(100);
    expect(game.experience.total).toBe(50);
  });

  it('同一种子、同一串操作，腐肉件数每次相同；这几个种子下 0、1、2 件都出现过', () => {
    const counts = new Set<number>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const runs = [0, 1].map(() => {
        const game = core(seed);
        pennedZombie(game);
        beatToDeath(game);
        return fleshOnGround(game);
      });
      expect(runs[0], `种子 ${seed}`).toBe(runs[1]);
      expect(runs[0]).toBeGreaterThanOrEqual(0);
      expect(runs[0]).toBeLessThanOrEqual(2);
      counts.add(runs[0]!);
    }
    expect([...counts].sort()).toEqual([0, 1, 2]);
  });

  it('掉的腐肉走过去就拾进背包', () => {
    const game = core();
    pennedZombie(game);
    beatToDeath(game);
    const flesh = fleshOnGround(game);
    // 默认种子下掉 2 件；是 0 的话这条测试什么都没测到
    expect(flesh).toBeGreaterThan(0);
    // 拆掉墙，往前走两格
    game.setBlock(0, EYE_LAYER - 1, -1, BlockType.Air);
    game.setBlock(0, EYE_LAYER + 1, -1, BlockType.Air);
    game.setMoveIntent({ forward: true, back: false, left: false, right: false, jump: false });
    game.tick(10);
    game.setMoveIntent({ forward: false, back: false, left: false, right: false, jump: false });
    game.tick(100);
    const inBag = Array.from({ length: game.inventory.size }, (_, i) => game.inventory.slot(i))
      .filter((stack) => stack?.item === ItemType.RottenFlesh)
      .reduce((sum, stack) => sum + stack!.count, 0);
    expect(inBag).toBe(flesh);
  });
});

describe('腐肉', () => {
  it('可堆叠到 64：64 件占一格，第 65 件另起一格', () => {
    expect(stackLimit(ItemType.RottenFlesh)).toBe(64);
    expect(maxDurability(ItemType.RottenFlesh)).toBeUndefined();
    const game = core();
    expect(game.giveItem(ItemType.RottenFlesh, 65)).toBe(0);
    expect(game.inventory.slot(0)).toEqual({ item: ItemType.RottenFlesh, count: 64 });
    expect(game.inventory.slot(1)).toEqual({ item: ItemType.RottenFlesh, count: 1 });
  });

  it('拿着腐肉对着地面按使用键：什么都不放，腐肉一件不少', () => {
    const game = core();
    game.giveItem(ItemType.RottenFlesh, 3);
    // 低头看脚下那一格地面，放置的话会落在它上面那一格
    game.turn(0, -MAX_PITCH);
    game.tick();
    const target = game.mining.target!;
    expect(target).toBeDefined();
    const above = { x: target.x, y: target.y + 1, z: target.z };

    game.use();
    game.tick();
    expect(game.getBlock(above.x, above.y, above.z)).toBe(BlockType.Air);
    expect(game.inventory.held).toEqual({ item: ItemType.RottenFlesh, count: 3 });
  });
});

describe('挥动（纯表现要读的核心状态）', () => {
  it('左键按下那一 tick 记为上次挥动，不论打到什么：对着空处按也算', () => {
    const game = core();
    expect(game.lastSwingTick).toBeUndefined();
    press(game);
    expect(game.lastSwingTick).toBe(game.tickCount);
    // 按着不放不重记
    game.tick(3);
    expect(game.lastSwingTick).toBe(game.tickCount - 3);
  });

  it('按着左键对着方块挖时 digging 为真，挖穿一块接着挖下一块也不断；打僵尸那一下不算挖', () => {
    const game = core();
    // 铁铲挖泥土 3 tick 一块：9 tick 挖穿前三块，第四块正挖着
    game.giveItem(ItemType.IronShovel, 1);
    for (const z of [-1, -2, -3, -4]) game.setBlock(0, EYE_LAYER, z, BlockType.Dirt);
    game.setMining(true);
    const digging: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      game.tick();
      digging.push(game.mining.digging);
    }
    expect(game.getBlock(0, EYE_LAYER, -3)).toBe(BlockType.Air);
    expect(digging.every(Boolean)).toBe(true);
    game.setMining(false);
    game.tick();
    expect(game.mining.digging).toBe(false);

    const fight = core();
    zombieAhead(fight, 2);
    press(fight);
    expect(fight.mining.digging).toBe(false);
  });
});
