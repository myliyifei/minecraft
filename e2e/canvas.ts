import type { Page } from '@playwright/test';

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
