import type { Page } from '@playwright/test';

declare global {
  interface Window {
    /** 画布正中那一像素的 RGB。由 `installPixelProbe` 装上。 */
    __CENTER_RGB__?: () => [number, number, number];
    /**
     * 画布上某一点的 RGB。点用归一化设备坐标给（x 右为正、y 上为正，正中是原点），
     * 与 three.js 把世界坐标投影出来的那套坐标一致——所以「场景里那个东西在画面上的
     * 位置」可以直接拿来当探针的输入。由 `installPixelProbe` 装上。
     */
    __PIXEL_RGB__?: (ndcX: number, ndcY: number) => [number, number, number];
  }
}

/**
 * 往页面里装两个「读画布某一像素」的函数。
 *
 * 必须是页面里的函数，不能是 Node 这一侧的：读像素得和被测的那几个 tick 挤在同一个
 * evaluate 里——分成两次的话游戏循环会插进来接着 tick，画面就不是刚才断言的那一帧了。
 *
 * 要在 `page.goto` 之前调。
 */
export async function installPixelProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const readPixel = (ndcX: number, ndcY: number): [number, number, number] => {
      const source = document.querySelector('canvas');
      if (!(source instanceof HTMLCanvasElement)) throw new Error('页面上没有画布');
      const scratch = document.createElement('canvas');
      scratch.width = source.width;
      scratch.height = source.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('拿不到 2D 上下文');
      context.drawImage(source, 0, 0);
      // 归一化设备坐标换成像素：y 轴要翻过来，画布的 y 向下。
      const clamp = (value: number, max: number): number =>
        Math.min(max - 1, Math.max(0, Math.round(value)));
      const x = clamp(((ndcX + 1) / 2) * source.width, source.width);
      const y = clamp(((1 - ndcY) / 2) * source.height, source.height);
      const { data } = context.getImageData(x, y, 1, 1);
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    };

    window.__PIXEL_RGB__ = readPixel;
    window.__CENTER_RGB__ = () => readPixel(0, 0);
  });
}

/**
 * 数一数画布上出现了多少种不同颜色。
 *
 * 直接把 WebGL 画布 drawImage 到 2D 画布上读像素——比截图再解码 PNG 更直接，
 * 也能顺带发现「画出来了但全是同一个颜色」这种接线错误。
 *
 * 只在开发与测试构建里可用：读回画布内容要求 preserveDrawingBuffer，
 * 而那个选项跟着 DEBUG_BUILD 走（见 src/build-flags.ts）。
 */
export async function countCanvasColors(page: Page): Promise<number> {
  return page.evaluate(() => {
    const source = document.querySelector('canvas');
    if (!(source instanceof HTMLCanvasElement)) throw new Error('页面上没有画布');
    const scratch = document.createElement('canvas');
    scratch.width = source.width;
    scratch.height = source.height;
    const context = scratch.getContext('2d');
    if (!context) throw new Error('拿不到 2D 上下文');
    context.drawImage(source, 0, 0);
    const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
    const colors = new Set<number>();
    // 隔像素采样，够判断是否单色，又不必遍历几百万个像素。
    for (let i = 0; i < data.length; i += 4 * 17) {
      colors.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
    }
    return colors.size;
  });
}

/** 等首帧画完：加载遮罩被移除即表示核心与渲染都就绪。 */
export async function waitForFirstFrame(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('#loading') === null, null, {
    timeout: 20_000,
  });
}
