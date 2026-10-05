import { expect, test, type Page } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { CHUNK_SIZE, DEFAULT_SEED } from '../src/core/constants';
import { ItemType } from '../src/core/item';
import { createTerrain } from '../src/core/terrain';
import { chunkOf } from '../src/core/world';
import { GROUND_ARGS, enterDefaultWorld } from './world-list';

/**
 * #80 地表植物的端到端核对：经调试句柄在出生点附近放置矮草与花、挖掉与放置之后读回方块、掉落物与经验球；
 * 再用 Node 里同一份地形对象算出视距内长着植物的一列，确认页面里那一格是同一种植物。
 *
 * 出生列周围 7 格不长植物，放在那里的植物只有测试自己放的。新编号按名称取：编号未定义时类型检查与生产构建仍然通过，
 * 用例按断言失败。Windows 浏览器实机截图（交叉面片、透明裁剪、手持图标）不在这里，留给实机验收。
 */

const named = (name: string): BlockType | undefined => (BlockType as Readonly<Record<string, BlockType>>)[name];
const itemNamed = (name: string): ItemType | undefined => (ItemType as Readonly<Record<string, ItemType>>)[name];
const SHORT_GRASS = named('ShortGrass');
const FERN = named('Fern');
const DANDELION = named('Dandelion');
const POPPY = named('Poppy');
const DANDELION_ITEM = itemNamed('Dandelion');

const TERRAIN = createTerrain(DEFAULT_SEED);

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  for (const [name, id] of [
    ['矮草', SHORT_GRASS],
    ['蕨', FERN],
    ['蒲公英', DANDELION],
    ['虞美人', POPPY],
    ['蒲公英物品', DANDELION_ITEM],
  ] as const) {
    expect(typeof id, `${name}的编号未定义`).toBe('number');
  }
  await page.goto('/');
  await enterDefaultWorld(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function waitForSpawnChunks(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const core = window.__VOXEL__!.core;
          const { cx, cz } = core.playerChunk;
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!core.isChunkLoaded(cx + dx, cz + dz)) return false;
          return true;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('出生点旁放下矮草与蒲公英：挖矮草一 tick 碎、没有掉落物、经验球 5 点；挖花掉 1 个蒲公英；对着矮草放圆石替换它；种花在草方块上（#80）', async ({
  page,
}) => {
  await waitForSpawnChunks(page);
  const seen = await page.evaluate(
    ({ shortGrass, dandelion, dandelionItem, cobblestone, ground }) => {
      const core = window.__VOXEL__!.core;
      core.setTimeOfDay(6000);
      const px = Math.floor(core.player.position.x);
      const pz = Math.floor(core.player.position.z);
      /** 这一列最高的实心方块。 */
      const groundY = (x: number, z: number) => {
        let y = core.highestBlockY(x, z);
        while (y >= ground.minY && ground.nonSolid.includes(core.getBlock(x, y, z))) y--;
        return y;
      };
      /** 让视线对准 (x + 0.5, y, z + 0.5)，推进一 tick 让目标按新视线重算。 */
      const aim = (x: number, y: number, z: number) => {
        const eye = core.player.eyePosition;
        const dx = x + 0.5 - eye.x;
        const dy = y - eye.y;
        const dz = z + 0.5 - eye.z;
        core.turn(Math.atan2(-dx, -dz) - core.player.yaw, Math.atan2(dy, Math.hypot(dx, dz)) - core.player.pitch);
        core.tick();
        return core.mining.target ? { ...core.mining.target } : undefined;
      };
      const mineOnce = () => {
        core.setMining(true);
        core.tick();
        core.setMining(false);
      };

      // 挖矮草：玩家 −Z 方向 2 格
      const grassCell = { x: px, y: groundY(px, pz - 2) + 1, z: pz - 2 };
      core.setBlock(grassCell.x, grassCell.y, grassCell.z, shortGrass);
      const grassPlaced = core.getBlock(grassCell.x, grassCell.y, grassCell.z);
      const grassTarget = aim(grassCell.x, grassCell.y + 0.25, grassCell.z);
      const dropsBefore = core.drops.count;
      const orbsBefore = core.xpOrbs.all().map((orb) => orb.id);
      mineOnce();
      const grassAfter = core.getBlock(grassCell.x, grassCell.y, grassCell.z);
      const grassDrops = core.drops.count - dropsBefore;
      const grassOrbs = core.xpOrbs
        .all()
        .filter((orb) => !orbsBefore.includes(orb.id))
        .map((orb) => orb.amount);

      // 挖蒲公英：玩家 +Z 方向 2 格
      const flowerCell = { x: px, y: groundY(px, pz + 2) + 1, z: pz + 2 };
      core.setBlock(flowerCell.x, flowerCell.y, flowerCell.z, dandelion);
      aim(flowerCell.x, flowerCell.y + 0.25, flowerCell.z);
      const dropIds = core.drops.all().map((drop) => drop.id);
      mineOnce();
      const flowerAfter = core.getBlock(flowerCell.x, flowerCell.y, flowerCell.z);
      const flowerDrops = core.drops
        .all()
        .filter((drop) => !dropIds.includes(drop.id))
        .map((drop) => ({ item: drop.item, count: drop.count }));

      // 对着矮草放圆石：玩家 +X 方向 2 格
      core.giveItem(cobblestone, 2);
      const replaceCell = { x: px + 2, y: groundY(px + 2, pz) + 1, z: pz };
      core.setBlock(replaceCell.x, replaceCell.y, replaceCell.z, shortGrass);
      let slot = 0;
      for (; slot < 9; slot++) if (core.inventory.hotbar()[slot]?.item === cobblestone) break;
      core.selectHotbarSlot(slot);
      const replaceTarget = aim(replaceCell.x, replaceCell.y + 0.25, replaceCell.z);
      core.use();
      core.tick();
      const replaced = core.getBlock(replaceCell.x, replaceCell.y, replaceCell.z);

      // 种花：玩家 −X 方向 2 格那一列的草方块顶面
      core.giveItem(dandelionItem, 1);
      for (slot = 0; slot < 9; slot++) if (core.inventory.hotbar()[slot]?.item === dandelionItem) break;
      core.selectHotbarSlot(slot);
      const soil = { x: px - 2, y: groundY(px - 2, pz), z: pz };
      const soilBlock = core.getBlock(soil.x, soil.y, soil.z);
      const soilTarget = aim(soil.x, soil.y + 0.9, soil.z);
      core.use();
      core.tick();
      const planted = core.getBlock(soil.x, soil.y + 1, soil.z);

      return {
        grassCell,
        grassPlaced,
        grassTarget,
        grassAfter,
        grassDrops,
        grassOrbs,
        flowerAfter,
        flowerDrops,
        replaceCell,
        replaceTarget,
        replaced,
        soil,
        soilBlock,
        soilTarget,
        planted,
      };
    },
    {
      shortGrass: SHORT_GRASS!,
      dandelion: DANDELION!,
      dandelionItem: DANDELION_ITEM!,
      cobblestone: ItemType.Cobblestone,
      ground: GROUND_ARGS,
    },
  );

  expect(seen.grassPlaced).toBe(SHORT_GRASS);
  expect(seen.grassTarget).toMatchObject(seen.grassCell);
  expect(seen.grassAfter).toBe(BlockType.Air);
  expect(seen.grassDrops).toBe(0);
  expect(seen.grassOrbs).toEqual([5]);

  expect(seen.flowerAfter).toBe(BlockType.Air);
  expect(seen.flowerDrops).toEqual([{ item: DANDELION_ITEM, count: 1 }]);

  expect(seen.replaceTarget).toMatchObject(seen.replaceCell);
  expect(seen.replaced).toBe(BlockType.Cobblestone);

  expect(seen.soilBlock).toBe(BlockType.Grass);
  expect(seen.soilTarget).toMatchObject({ ...seen.soil, normal: { x: 0, y: 1, z: 0 } });
  expect(seen.planted).toBe(DANDELION);
});

test('Node 里算出的视距内一列地表植物，页面里那一格是同一种植物，下面是草方块或雪草方块（#80）', async ({ page }) => {
  await waitForSpawnChunks(page);
  const { cx, cz } = await page.evaluate(() => window.__VOXEL__!.core.playerChunk);
  const plants = new Set<number | undefined>([SHORT_GRASS, FERN, DANDELION, POPPY]);
  // 玩家所在区块与周围 8 个区块里，按区块、列的顺序找第一格植物
  let found: { x: number; y: number; z: number; block: BlockType } | undefined;
  for (let dz = -1; dz <= 1 && !found; dz++) {
    for (let dx = -1; dx <= 1 && !found; dx++) {
      const chunk = TERRAIN.generateChunk(cx + dx, cz + dz);
      for (let lz = 0; lz < CHUNK_SIZE && !found; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE && !found; lx++) {
          const x = (cx + dx) * CHUNK_SIZE + lx;
          const z = (cz + dz) * CHUNK_SIZE + lz;
          const y = TERRAIN.surfaceHeightAt(x, z) + 1;
          const block = chunk.get(lx, y, lz);
          if (plants.has(block)) found = { x, y, z, block };
        }
      }
    }
  }
  expect(found, `默认种子玩家区块 (${cx}, ${cz}) 周围 9 个区块里没有地表植物`).toBeDefined();
  expect([chunkOf(found!.x) - cx, chunkOf(found!.z) - cz].every((d) => Math.abs(d) <= 1)).toBe(true);
  const page_ = await page.evaluate(
    ({ x, y, z }) => {
      const core = window.__VOXEL__!.core;
      return { plant: core.getBlock(x, y, z), below: core.getBlock(x, y - 1, z) };
    },
    found!,
  );
  expect(page_.plant).toBe(found!.block);
  expect([BlockType.Grass, named('SnowyGrass')]).toContain(page_.below);
});
