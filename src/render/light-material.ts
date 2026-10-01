import * as THREE from 'three';
import { MAX_LIGHT_LEVEL } from '../core/constants';
import { BRIGHTNESS_CURVE, FACE_SHADE } from './shading';

/**
 * 按光照等级画的着色器材质（ADR-0016）：地形、僵尸、掉落物与手持物品共用一份着色器，场景里没有灯。
 *
 * 一处的亮度 = max(折算天光, 方块光 + 闪烁, 手持光 + 闪烁) 经 `BRIGHTNESS_CURVE` 映射，再乘上这一面的
 * 系数（`FACE_SHADE`）。天光与方块光的来源有两种：
 *
 * - 地形：每个顶点带两个等级（网格的 `light` 属性，见 `MeshData.light`），按平滑光照取过平均。
 * - 实体：每个对象一份材质，每帧把它所在那一格的两个等级写进 `entityLight`（`setEntityLight`）。
 *
 * 两种只差一个宏，着色器源码相同，three 会复用编译好的程序；每个实体一份材质的代价只是 uniform 上传。
 */

/**
 * 每帧所有光照材质共用的输入。每份材质的 uniform 表直接引用这几个 `{ value }` 对象，渲染层每帧改一次，
 * 所有材质都拿到新值：three 每次 `render` 都会给每份材质重新上传一遍 uniform。
 */
export interface FrameLighting {
  /** 天光减量（浮点，见 `daylightAt`）。 */
  readonly skyDarkening: { value: number };
  /** 闪烁量（见 CONTEXT.md 的「闪烁」），加在方块光与手持光上，天光不加。#58 之前恒为 0。 */
  readonly flicker: { value: number };
  /** 手持光等级：选中格是火把时 14，否则 0。每一处再按离眼睛的距离减。#58 之前恒为 0。 */
  readonly heldLight: { value: number };
}

export function frameLighting(): FrameLighting {
  return { skyDarkening: { value: 0 }, flicker: { value: 0 }, heldLight: { value: 0 } };
}

/** 一个数写成 GLSL 的浮点字面量：整数也要带小数点。 */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const VERTEX_SHADER = /* glsl */ `
#ifdef VERTEX_LIGHT
attribute vec2 light;
#else
uniform vec2 entityLight;
#endif

varying vec2 vUv;
varying vec2 vLight;
varying float vShade;
varying vec3 vWorldPosition;

void main() {
  vUv = uv;
#ifdef VERTEX_LIGHT
  vLight = light;
#else
  vLight = entityLight;
#endif
  // 各面系数按世界坐标里的法线取：转着的掉落物、摆着的四肢，朝上的那一面始终最亮。
  // 斜着的面按法线分量的平方混合，轴向的面正好落在三个系数之一。
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vShade = (n.x * n.x + n.z * n.z) * SIDE_SHADE + n.y * n.y * (n.y > 0.0 ? TOP_SHADE : BOTTOM_SHADE);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform float alphaTest;
uniform float skyDarkening;
uniform float flicker;
uniform float heldLight;
uniform float brightnessCurve[LIGHT_LEVELS];
uniform vec3 tint;

varying vec2 vUv;
varying vec2 vLight;
varying float vShade;
varying vec3 vWorldPosition;

// 与 shading.ts 的 brightnessAt 同一个算法：在表的相邻两项之间线性插值。
float brightness(float level) {
  float clamped = clamp(level, 0.0, float(LIGHT_LEVELS - 1));
  int below = int(floor(clamped));
  int above = min(below + 1, LIGHT_LEVELS - 1);
  return mix(brightnessCurve[below], brightnessCurve[above], clamped - float(below));
}

void main() {
  vec4 texel = texture2D(map, vUv);
#ifdef USE_ALPHATEST
  if (texel.a < alphaTest) discard;
#endif
  float held = max(0.0, heldLight - distance(vWorldPosition, cameraPosition));
  float level = max(max(vLight.x - skyDarkening, 0.0), max(vLight.y, held) + flicker);
  // 曲线与系数给的是画面上的亮度（乘在 sRGB 颜色上），贴图采样出来却是线性的：按 sRGB 的传递函数换回
  // 画面上的值，乘完再换回线性。不能用 2.2 次方近似成线性空间里的一个乘数：sRGB 在接近黑的那一段是线性的，
  // 近似会把暗处的贴图再压暗一截，0 级看不出轮廓。
  vec3 display = sRGBTransferOETF(vec4(texel.rgb, 1.0)).rgb * (brightness(level) * vShade);
  gl_FragColor = vec4(sRGBTransferEOTF(vec4(display, 1.0)).rgb * tint, 1.0);
  #include <colorspace_fragment>
}
`;

/** 树叶、平面图标的镂空：透明度低于它的像素丢掉，不做半透明排序。 */
const ALPHA_TEST = 0.5;

function lightMaterial(
  texture: THREE.Texture,
  frame: FrameLighting,
  vertexLight: boolean,
  side: THREE.Side,
): THREE.ShaderMaterial {
  const defines: Record<string, string> = {
    LIGHT_LEVELS: String(MAX_LIGHT_LEVEL + 1),
    TOP_SHADE: glslFloat(FACE_SHADE.top),
    SIDE_SHADE: glslFloat(FACE_SHADE.side),
    BOTTOM_SHADE: glslFloat(FACE_SHADE.bottom),
  };
  if (vertexLight) defines.VERTEX_LIGHT = '';
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    defines,
    uniforms: {
      map: { value: texture },
      // three 只按 `alphaTest` 属性加 USE_ALPHATEST 这个宏，ShaderMaterial 的值得自己放进 uniform。
      alphaTest: { value: ALPHA_TEST },
      skyDarkening: frame.skyDarkening,
      flicker: frame.flicker,
      heldLight: frame.heldLight,
      brightnessCurve: { value: BRIGHTNESS_CURVE },
      tint: { value: new THREE.Color(0xffffff) },
      entityLight: { value: new THREE.Vector2(MAX_LIGHT_LEVEL, 0) },
    },
    alphaTest: ALPHA_TEST,
    side,
  });
}

/** 地形的材质：两个等级从顶点属性 `light` 来。所有区块共用一份。 */
export function terrainMaterial(texture: THREE.Texture, frame: FrameLighting): THREE.ShaderMaterial {
  return lightMaterial(texture, frame, true, THREE.FrontSide);
}

/**
 * 实体的材质：两个等级来自 uniform（`setEntityLight`），每个对象一份。`side` 给 `DoubleSide` 的是平面图标：
 * 一张面转过角度之后背面朝着相机，单面材质就整张不见了。
 */
export function entityMaterial(
  texture: THREE.Texture,
  frame: FrameLighting,
  side: THREE.Side = THREE.FrontSide,
): THREE.ShaderMaterial {
  return lightMaterial(texture, frame, false, side);
}

/** 实体这一帧所在那一格的两个等级。 */
export function setEntityLight(material: THREE.ShaderMaterial, sky: number, block: number): void {
  (material.uniforms.entityLight!.value as THREE.Vector2).set(sky, block);
}

/** 乘在贴图上的叠色（sRGB 十六进制），白色是贴图本色。僵尸受击叠红、燃烧叠橙用它。 */
export function setTint(material: THREE.ShaderMaterial, hex: number): void {
  (material.uniforms.tint!.value as THREE.Color).setHex(hex);
}

/** 材质此刻的叠色（sRGB 十六进制）。 */
export function tintOf(material: THREE.ShaderMaterial): number {
  return (material.uniforms.tint!.value as THREE.Color).getHex();
}
