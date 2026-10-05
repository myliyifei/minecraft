import { expect, test } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { CHUNK_SIZE, WORLD_MAX_Y } from '../src/core/constants';
import { TILE } from '../src/render/atlas';
import { installPixelProbe } from './canvas';
import { enterDefaultWorld } from './world-list';

/**
 * #83 水与冰的半透明渲染：画面上透过水面看得到水底，调试读回的顶点数与贴图格覆盖网格的两部分。
 *
 * 场景都用调试句柄自己搭，不依赖出生点附近的地形（第七切片的地形还在变）。每条用例整段跑在一次同步的 evaluate 里，
 * 游戏循环插不进来，读到的就是刚画的那一帧；不锁定指针，世界不理会暂停（`enterDefaultWorld`）。
 */

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await installPixelProbe(page);
  await page.goto('/');
  await enterDefaultWorld(page);
});

type Rgb = readonly [number, number, number];

/** 两个颜色三个通道差的绝对值之和。 */
function colorDistance(a: Rgb, b: Rgb): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** 画面上的明度（Rec. 601 的加权）。 */
function luma([r, g, b]: Rgb): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 蓝色在三个通道里的占比。 */
function blueShare([r, g, b]: Rgb): number {
  return b / Math.max(1, r + g + b);
}

/**
 * 两次读数「看得出不同」的下限：三个通道差之和。贴图上的纹理在 5×5 的小块里平均掉之后，同一块方块两帧之间的差
 * 远小于它；透过三格水看过去，白桦木板与基岩之间按水贴图的 alpha（176）估还剩三十到五十。
 */
const VISIBLE_DIFFERENCE = 24;

test('调试句柄在玩家前方放一片水：透过水面看得到水底，画面与没有水时不同，水底换成别的方块画面跟着变（#83）', async ({
  page,
}) => {
  // 玩家朝 −Z、往下看 45°。正前方挖一个 5 格宽、7 格长、3 格深的水池，四壁与池底外侧砌石头，池底铺一层要看的方块；
  // 池子上方清空。画面正中那条视线先穿过水面、再穿过三格水，落在池底上，离眼睛约 6.5 格，在触及距离之外，没有选框。
  // 池底先后换成白桦木板（亮）与基岩（暗），有水、没水各读一次画面正中的 5×5 小块平均色。
  const seen = await page.evaluate(
    ({ water, air, stone, floors, look }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;
      core.setTimeOfDay(6000);
      core.turn(-core.player.yaw, look - core.player.pitch);

      const px = Math.floor(core.player.position.x);
      const pz = Math.floor(core.player.position.z);
      const ground = Math.floor(core.player.position.y) - 1;
      const floorY = ground - 3;

      const build = (floor: BlockType, fill: BlockType): void => {
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -8; dz <= 1; dz++) {
            const x = px + dx;
            const z = pz + dz;
            const inPool = Math.abs(dx) <= 2 && dz <= -1 && dz >= -7;
            core.setBlock(x, floorY - 1, z, stone);
            core.setBlock(x, floorY, z, inPool ? floor : stone);
            for (let y = floorY + 1; y <= ground; y++) core.setBlock(x, y, z, inPool ? fill : stone);
            for (let y = ground + 1; y <= ground + 6; y++) core.setBlock(x, y, z, air);
          }
        }
      };
      const read = (): [number, number, number] => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            const rgb = pixel(i * 0.012, j * 0.012);
            for (let c = 0; c < 3; c++) sum[c]! += rgb[c]!;
            n++;
          }
        }
        return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
      };
      const show = (floor: BlockType, fill: BlockType) => {
        build(floor, fill);
        // 推进一 tick：目标方块按这一 tick 的视线重算（ADR-0006），池底在触及距离之外，不会有选框压在画面正中
        core.tick();
        renderer.syncChunkMeshes(Infinity);
        renderer.render(1);
        return {
          rgb: read(),
          floor: core.getBlock(px, floorY, pz - 4),
          fill: core.getBlock(px, floorY + 1, pz - 4),
          target: core.mining.target ?? null,
        };
      };
      return {
        dry: { light: show(floors.light, air), dark: show(floors.dark, air) },
        wet: { light: show(floors.light, water), dark: show(floors.dark, water) },
      };
    },
    {
      water: BlockType.Water,
      air: BlockType.Air,
      stone: BlockType.Stone,
      floors: { light: BlockType.BirchPlanks, dark: BlockType.Bedrock },
      look: -Math.PI / 4,
    },
  );

  // 场景搭对了：池底是要看的方块，池子里是水或空气
  expect(seen.dry.light.floor).toBe(BlockType.BirchPlanks);
  expect(seen.dry.dark.floor).toBe(BlockType.Bedrock);
  expect(seen.dry.light.fill).toBe(BlockType.Air);
  expect(seen.wet.light.fill).toBe(BlockType.Water);
  expect(seen.wet.dark.fill).toBe(BlockType.Water);
  for (const reading of [seen.dry.light, seen.dry.dark, seen.wet.light, seen.wet.dark]) {
    expect(reading.target).toBeNull();
  }
  // 没水时两种池底本来就分得开
  expect(luma(seen.dry.light.rgb)).toBeGreaterThan(luma(seen.dry.dark.rgb));

  // 有水与没有水时不同：水面盖上了一层水的颜色，蓝色占比变高
  expect(colorDistance(seen.wet.light.rgb, seen.dry.light.rgb)).toBeGreaterThan(VISIBLE_DIFFERENCE);
  expect(blueShare(seen.wet.light.rgb)).toBeGreaterThan(blueShare(seen.dry.light.rgb));

  // 仍看得出是水底的方块：同一片水下换了池底，画面跟着变，而且亮暗顺序与没水时一致。
  // 水画成不透明时，两种池底上方读到的都是同一个水面，这两条都不成立。
  expect(colorDistance(seen.wet.light.rgb, seen.wet.dark.rgb)).toBeGreaterThan(VISIBLE_DIFFERENCE);
  expect(luma(seen.wet.light.rgb)).toBeGreaterThan(luma(seen.wet.dark.rgb));
  expect(errors).toEqual([]);
});

test('调试句柄在高空放一格水与一格冰：区块网格的顶点数多出水的 7 个面与冰的 6 个面，贴图格里有水与冰；拆掉后回到原来的顶点数（#83）', async ({
  page,
}) => {
  // 两格都悬在玩家所在区块的高空，四周全是空气：水六个面加上顶面的背面，冰六个面。两格不相邻，互不剔除。
  // 读的是送上显卡的网格（`chunkMeshVertexCount`、`chunkMeshTiles`），两部分都要算进去。
  const seen = await page.evaluate(
    ({ water, ice, air, chunkSize, y }) => {
      const { core, renderer } = window.__VOXEL__!;
      const cx = Math.floor(Math.floor(core.player.position.x) / chunkSize);
      const cz = Math.floor(Math.floor(core.player.position.z) / chunkSize);
      const waterAt = { x: cx * chunkSize + 4, z: cz * chunkSize + 4 };
      const iceAt = { x: cx * chunkSize + 10, z: cz * chunkSize + 10 };
      const sync = (): void => {
        renderer.syncChunkMeshes(Infinity);
        renderer.render(1);
      };

      sync();
      const before = renderer.chunkMeshVertexCount(cx, cz);
      core.setBlock(waterAt.x, y, waterAt.z, water);
      core.setBlock(iceAt.x, y, iceAt.z, ice);
      sync();
      const placed = {
        blocks: [core.getBlock(waterAt.x, y, waterAt.z), core.getBlock(iceAt.x, y, iceAt.z)],
        vertices: renderer.chunkMeshVertexCount(cx, cz),
        tiles: renderer.chunkMeshTiles(cx, cz),
      };
      core.setBlock(waterAt.x, y, waterAt.z, air);
      core.setBlock(iceAt.x, y, iceAt.z, air);
      sync();
      return { before, placed, after: renderer.chunkMeshVertexCount(cx, cz) };
    },
    { water: BlockType.Water, ice: BlockType.Ice, air: BlockType.Air, chunkSize: CHUNK_SIZE, y: WORLD_MAX_Y - 3 },
  );

  expect(seen.placed.blocks).toEqual([BlockType.Water, BlockType.Ice]);
  expect(seen.before).toBeGreaterThan(0);
  expect(seen.placed.vertices - seen.before).toBe((7 + 6) * 4);
  expect(seen.placed.tiles).toContain(TILE.water);
  expect(seen.placed.tiles).toContain(TILE.ice);
  expect(seen.after).toBe(seen.before);
  expect(errors).toEqual([]);
});
