import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../../src/core/constants';
import { fogAt } from '../../src/render/fog';
import { VIEW_RADIUS_RANGE } from '../../src/settings';

/*
 * 水下雾（#77）：这一帧的雾怎么定。`fogAt` 是纯数学，不 import three，与 daylight.ts 同类，所以在 Node 里测。
 * 雾的 uniform 怎么接到四种材质上在 tests/render/fog-uniforms.test.ts；着色器真的按距离混入了雾、背景色真的换成雾色，
 * 由端到端的 `sky` 读回与像素探针证明（e2e/dev.underwater.spec.ts）。雾的颜色与距离由实现按原版观感定，这里只断言相对关系。
 */

describe('这一帧的雾（#77）', () => {
  it('眼睛不在水下时雾关闭', () => {
    expect(fogAt(false).enabled).toBe(false);
  });

  it('眼睛在水下时雾开启，颜色是蓝色：蓝色分量大于红、绿', () => {
    const fog = fogAt(true);
    expect(fog.enabled).toBe(true);
    const [r, g, b] = fog.color;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    for (const channel of fog.color) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('水下只看得清近处：雾从 near 开始混入、到 far 全是雾色，far 在最小视距的加载边缘之内', () => {
    const { near, far } = fogAt(true);
    expect(near).toBeGreaterThanOrEqual(0);
    expect(far).toBeGreaterThan(near);
    // 雾要在最近可能出现的区块边缘之前把地形盖满，否则水下看得到地形的断边
    expect(far).toBeLessThan(VIEW_RADIUS_RANGE.min * CHUNK_SIZE);
  });
});
