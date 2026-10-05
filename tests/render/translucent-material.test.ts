import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  frameLighting,
  terrainMaterial,
  translucentTerrainMaterial,
} from '../../src/render/light-material';

/**
 * #83：网格半透明那一部分（水与冰）用同一套光照着色器的变体（ADR-0016 补记）：输出贴图的 alpha、不做透明裁剪、
 * 开启混合、不写深度，在不透明部分之后画，区块之间按到相机的远近排序。
 *
 * 这里只断言材质上的开关；着色器真的输出了贴图的 alpha、混合真的生效，由端到端的像素测试（e2e/dev.translucent.spec.ts）
 * 证明，区块之间排序的视觉结果靠 Windows 浏览器实机截图。three 对 `transparent` 为真的材质单独成一个列表，
 * 排在不透明列表之后画，并按到相机的距离由远到近排序，所以「之后画」与「排序」落在 `transparent` 这一个开关上。
 */

describe('半透明部分的材质（#83）', () => {
  const texture = new THREE.Texture();

  it('开启混合、不写深度、不做透明裁剪：three 把它放进透明列表，在不透明部分之后按远近排序画', () => {
    const material = translucentTerrainMaterial(texture, frameLighting());
    expect(material.transparent).toBe(true);
    expect(material.blending).toBe(THREE.NormalBlending);
    expect(material.depthWrite).toBe(false);
    // 深度照样测：被不透明方块挡住的水不画
    expect(material.depthTest).toBe(true);
    expect(material.alphaTest).toBe(0);
  });

  it('单面材质：水顶面的背面由网格多出的那一份面画，侧面不会从里面透出来', () => {
    expect(translucentTerrainMaterial(texture, frameLighting()).side).toBe(THREE.FrontSide);
  });

  it('与地形材质是同一套光照着色器的变体：顶点与片元着色器源码相同，共用每帧的光照输入', () => {
    const frame = frameLighting();
    const opaque = terrainMaterial(texture, frame);
    const translucent = translucentTerrainMaterial(texture, frame);
    expect(translucent.vertexShader).toBe(opaque.vertexShader);
    expect(translucent.fragmentShader).toBe(opaque.fragmentShader);
    expect(translucent.uniforms.skyDarkening).toBe(frame.skyDarkening);
    expect(translucent.uniforms.flicker).toBe(frame.flicker);
    expect(translucent.uniforms.heldLight).toBe(frame.heldLight);
    expect(translucent.uniforms.map!.value).toBe(texture);
  });

  it('不透明部分的材质不变：不混合、写深度、透明裁剪照旧', () => {
    const material = terrainMaterial(texture, frameLighting());
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.alphaTest).toBe(0.5);
  });
});
