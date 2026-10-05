import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  entityMaterial,
  frameLighting,
  particleMaterial,
  terrainMaterial,
  translucentTerrainMaterial,
} from '../../src/render/light-material';

/*
 * 水下雾的 uniform（#77）：雾的开关、颜色与两个距离是每帧光照输入（`FrameLighting`）的一部分，四种材质的 uniform 表直接
 * 引用它们，片元着色器只有一份、按 `vWorldPosition` 到 `cameraPosition` 的距离混入雾色（ADR-0016 与 #83 的补记）。
 *
 * 与 tests/render/translucent-material.test.ts 同一种断言：只看材质上的接线。雾落在实体与粒子上的样子靠 Windows 浏览器实机截图，
 * 这里只证到它们与地形共用同一份片元着色器与同一组 uniform。
 */

describe('雾的 uniform（#77）', () => {
  const texture = new THREE.Texture();

  it('每帧的光照输入多了雾的开关、颜色与两个距离，初值是关闭', () => {
    const frame = frameLighting();
    for (const name of ['fogEnabled', 'fogColor', 'fogNear', 'fogFar'] as const) {
      expect(frame[name], name).toBeDefined();
    }
    expect(frame.fogEnabled.value).toBeFalsy();
  });

  it('地形的两部分、实体与粒子四种材质都直接引用每帧那一份雾的 uniform：改一处，四种材质同一帧都拿到新值', () => {
    const frame = frameLighting();
    const materials = {
      terrain: terrainMaterial(texture, frame),
      translucent: translucentTerrainMaterial(texture, frame),
      entity: entityMaterial(texture, frame),
      particle: particleMaterial(texture, frame),
    };
    // 先确认每帧那一份真的有：两边都是 undefined 时下面的 toBe 也成立
    expect(frame.fogEnabled).toBeDefined();
    for (const [name, material] of Object.entries(materials)) {
      expect(material.uniforms.fogEnabled, name).toBeDefined();
      expect(material.uniforms.fogEnabled, name).toBe(frame.fogEnabled);
      expect(material.uniforms.fogColor, name).toBe(frame.fogColor);
      expect(material.uniforms.fogNear, name).toBe(frame.fogNear);
      expect(material.uniforms.fogFar, name).toBe(frame.fogFar);
    }
  });

  it('片元着色器只有一份，里面按到相机的距离混入雾色', () => {
    const frame = frameLighting();
    const shared = terrainMaterial(texture, frame).fragmentShader;
    expect(particleMaterial(texture, frame).fragmentShader).toBe(shared);
    expect(entityMaterial(texture, frame).fragmentShader).toBe(shared);
    for (const name of ['fogEnabled', 'fogColor', 'fogNear', 'fogFar', 'cameraPosition']) {
      expect(shared, name).toContain(name);
    }
  });
});
