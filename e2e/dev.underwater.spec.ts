import { expect, test } from '@playwright/test';
import { BlockType } from '../src/core/block';
import { PLAYER_EYE_HEIGHT } from '../src/core/player';
import { fogAt } from '../src/render/fog';
import { installPixelProbe } from './canvas';
import { enterDefaultWorld } from './world-list';

/**
 * #77 水下雾：眼睛所在那一格是水时 `sky` 读回报告在水下，雾开启、背景色换成雾色；拆掉水后回到原样。
 * 画面上远处全是雾色。
 *
 * 场景都用调试句柄自己搭，不依赖出生点附近的地形（第七切片的地形还在变）。每条用例整段跑在一次同步的 evaluate 里，
 * 这期间游戏循环不会执行，读到的就是刚画的那一帧；不推进 tick，玩家不会在水里下沉。不锁定指针，世界不理会暂停
 * （`enterDefaultWorld`）。Windows 浏览器实机截图（水下是蓝色的雾、远处看不清）不在这里，留给实机验收。
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

/** sRGB 十六进制拆成三个 0–255 的通道。 */
function hexRgb(hex: number): Rgb {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** 三个 [0, 1] 的 sRGB 分量拼成十六进制，与 three 的 `getHex` 一样逐通道四舍五入。 */
function rgbHex([r, g, b]: Rgb): number {
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

test('在眼睛那一格与周围放水，sky 读回报告在水下、雾开启、背景换成雾色；拆掉水后报告不在（#77）', async ({ page }) => {
  // 眼睛那一格周围 3×3×3 全放成水，画一帧读 `sky`；再全拆成空气，画一帧再读。中午：背景色在不在水下时就是白天的天空色。
  const seen = await page.evaluate(
    ({ water, air, eyeHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      core.setTimeOfDay(6000);
      const { x, y, z } = core.player.position;
      const eye = { x: Math.floor(x), y: Math.floor(y + eyeHeight), z: Math.floor(z) };
      const fillAround = (block: BlockType): void => {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) core.setBlock(eye.x + dx, eye.y + dy, eye.z + dz, block);
          }
        }
      };
      renderer.render(1);
      const before = renderer.sky;
      fillAround(water);
      renderer.render(1);
      const wet = { sky: renderer.sky, eyeBlock: core.getBlock(eye.x, eye.y, eye.z) };
      fillAround(air);
      renderer.render(1);
      const dry = { sky: renderer.sky, eyeBlock: core.getBlock(eye.x, eye.y, eye.z) };
      return { before, wet, dry };
    },
    { water: BlockType.Water, air: BlockType.Air, eyeHeight: PLAYER_EYE_HEIGHT },
  );

  // 场景搭对了：眼睛那一格先是水、后是空气
  expect(seen.wet.eyeBlock).toBe(BlockType.Water);
  expect(seen.dry.eyeBlock).toBe(BlockType.Air);

  expect(seen.before.underwater).toBe(false);
  expect(seen.before.fogEnabled).toBe(false);

  expect(seen.wet.sky.underwater).toBe(true);
  expect(seen.wet.sky.fogEnabled).toBe(true);
  // 背景色换成雾色，与白天的天空色不同
  expect(seen.wet.sky.background).toBe(seen.wet.sky.fogColor);
  expect(seen.wet.sky.background).not.toBe(seen.before.background);
  // 雾是蓝色的
  const [r, g, b] = hexRgb(seen.wet.sky.fogColor);
  expect(b).toBeGreaterThan(r);
  expect(b).toBeGreaterThan(g);
  // 送进着色器的就是 `fogAt` 给的 sRGB 雾色：按 sRGB 换成线性写进 uniform，读回时换回来是同一个颜色
  expect(seen.wet.sky.fogColor).toBe(rgbHex(fogAt(true).color));
  // 中午太阳在天上，水下不画，出水后又画
  expect(seen.before.sunVisible).toBe(true);
  expect(seen.wet.sky.sunVisible).toBe(false);
  expect(seen.wet.sky.moonVisible).toBe(false);
  expect(seen.dry.sky.sunVisible).toBe(true);

  expect(seen.dry.sky.underwater).toBe(false);
  expect(seen.dry.sky.fogEnabled).toBe(false);
  expect(seen.dry.sky.background).toBe(seen.before.background);
  expect(errors).toEqual([]);
});

/** 水下远于 far 的地方读到的颜色与雾色之差的上限：三个通道差之和。只剩 sRGB 取整、贴图纹理与抗锯齿的误差。 */
const FOGGED_TOLERANCE = 30;

/** 没有水时同一处与雾色之差的下限：看到的是石墙本色，与蓝色的雾差得远。证明上一条不是巧合（石墙本来就是雾色）。 */
const CLEAR_DIFFERENCE = 60;

test('像素探针：眼睛在水下时，正前方远于雾的 far 处的石墙画成雾色；拆掉水后看到的是石墙本色（#77）', async ({ page }) => {
  // 中午、平视 −Z。眼睛那一格周围 3×3×3 放水；正前方清出一条 3×3 的空气通道，通道尽头在 ceil(far) + 4 格处砌一面 13×11 的石墙，
  // 画面正中那条视线穿过水与通道落在墙上。从水里看出去，水贴着空气的侧面是背面、不画（ADR-0016 补记），所以视线上只有墙。
  // far 取 `sky` 读回里水下那一帧的值；读不到时（雾还没实现）直接返回，由下面的断言报出来。
  const seen = await page.evaluate(
    ({ water, air, stone, eyeHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;
      core.setTimeOfDay(6000);
      core.turn(-core.player.yaw, -core.player.pitch);
      const { x, y, z } = core.player.position;
      const eye = { x: Math.floor(x), y: Math.floor(y + eyeHeight), z: Math.floor(z) };
      const fillAround = (block: BlockType): void => {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) core.setBlock(eye.x + dx, eye.y + dy, eye.z + dz, block);
          }
        }
      };
      const read = (): [number, number, number] => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            const rgb = pixel(i * 0.01, j * 0.01);
            for (let c = 0; c < 3; c++) sum[c]! += rgb[c]!;
            n++;
          }
        }
        return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
      };
      const draw = (): void => {
        renderer.syncChunkMeshes(Infinity);
        renderer.render(1);
      };

      fillAround(water);
      draw();
      const { fogFar, fogColor } = renderer.sky;
      if (typeof fogFar !== 'number' || !Number.isFinite(fogFar)) return { fogFar: fogFar ?? null, fogColor: null };

      const wallDistance = Math.ceil(fogFar) + 4;
      for (let dz = 2; dz < wallDistance; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) core.setBlock(eye.x + dx, eye.y + dy, eye.z - dz, air);
        }
      }
      for (let dx = -6; dx <= 6; dx++) {
        for (let dy = -5; dy <= 5; dy++) core.setBlock(eye.x + dx, eye.y + dy, eye.z - wallDistance, stone);
      }

      draw();
      const wet = { rgb: read(), sky: renderer.sky };
      fillAround(air);
      draw();
      const dry = { rgb: read(), sky: renderer.sky };
      return {
        fogFar,
        fogColor,
        wallDistance,
        wallBlock: core.getBlock(eye.x, eye.y, eye.z - wallDistance),
        wet,
        dry,
      };
    },
    { water: BlockType.Water, air: BlockType.Air, stone: BlockType.Stone, eyeHeight: PLAYER_EYE_HEIGHT },
  );

  expect(typeof seen.fogFar).toBe('number');
  expect(typeof seen.fogColor).toBe('number');
  if (!('wet' in seen) || seen.fogColor === null) return;
  // 场景搭对了：墙在 far 之外，水下那一帧雾开着，拆水之后关了
  expect(seen.wallBlock).toBe(BlockType.Stone);
  expect(seen.wallDistance).toBeGreaterThan(seen.fogFar as number);
  expect(seen.wet.sky.underwater).toBe(true);
  expect(seen.dry.sky.underwater).toBe(false);

  const fog = hexRgb(seen.fogColor);
  expect(colorDistance(seen.wet.rgb, fog)).toBeLessThanOrEqual(FOGGED_TOLERANCE);
  expect(colorDistance(seen.dry.rgb, fog)).toBeGreaterThan(CLEAR_DIFFERENCE);
  expect(errors).toEqual([]);
});

test('像素探针：眼睛在水下时近处看得清，正前方 1.5 格处的石墙不是雾色（#77）', async ({ page }) => {
  // 中午、平视 −Z。眼睛那一格周围 3×3×3 放水，紧挨着水的前方（眼睛那一格往 −Z 两格）砌一面 5×5 的石墙。
  // 眼睛到墙面约 1.5 格，雾还几乎没有混入：画面正中与雾色差得远。雾按到相机的距离算，算错成到别处的距离时这里会画成雾色。
  const seen = await page.evaluate(
    ({ water, stone, eyeHeight }) => {
      const { core, renderer } = window.__VOXEL__!;
      const pixel = window.__PIXEL_RGB__!;
      core.setTimeOfDay(6000);
      core.turn(-core.player.yaw, -core.player.pitch);
      const { x, y, z } = core.player.position;
      const eye = { x: Math.floor(x), y: Math.floor(y + eyeHeight), z: Math.floor(z) };
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) core.setBlock(eye.x + dx, eye.y + dy, eye.z + dz, water);
        }
      }
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) core.setBlock(eye.x + dx, eye.y + dy, eye.z - 2, stone);
      }
      renderer.syncChunkMeshes(Infinity);
      renderer.render(1);
      const sum = [0, 0, 0];
      let n = 0;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const rgb = pixel(i * 0.01, j * 0.01);
          for (let c = 0; c < 3; c++) sum[c]! += rgb[c]!;
          n++;
        }
      }
      return { rgb: [sum[0]! / n, sum[1]! / n, sum[2]! / n] as const, sky: renderer.sky };
    },
    { water: BlockType.Water, stone: BlockType.Stone, eyeHeight: PLAYER_EYE_HEIGHT },
  );

  expect(seen.sky.underwater).toBe(true);
  expect(colorDistance(seen.rgb, hexRgb(seen.sky.fogColor))).toBeGreaterThan(CLEAR_DIFFERENCE);
  expect(errors).toEqual([]);
});
