import * as THREE from 'three';
import { MAX_LIGHT_LEVEL } from '../core/constants';
import { BRIGHTNESS_CURVE, FACE_SHADE, SELF_LIT_BLOCK_LIGHT } from './shading';
import { FLICKER_AMPLITUDE, SELF_LIT_FLICKER_DIM } from './torch-light';

/**
 * 按光照等级画的着色器材质（ADR-0016）：地形、僵尸、掉落物与手持物品共用一份着色器，场景里没有灯。
 *
 * 一处的亮度 = 一处的等级（`shadedLevel`：折算天光与「方块光、手持光中较大者 + 闪烁」取较大者）经
 * `BRIGHTNESS_CURVE` 映射，再乘上这一面的系数（`FACE_SHADE`）。火把自己的顶点例外，按贴图本色画
 * （`SELF_LIT_BLOCK_LIGHT`），只随闪烁起伏（`selfLitBrightness`）。天光与方块光的来源有两种：
 *
 * - 地形：每个顶点带两个等级（网格的 `light` 属性，见 `MeshData.light`），按平滑光照取过平均。
 * - 实体：每个对象一份材质，每帧把它所在那一格的两个等级写进 `entityLight`（`setEntityLight`）。
 * - 粒子（#59）：一个实例化的四边形，每个粒子的两个等级是一个实例属性（`ParticlePool.lights`）。
 *
 * 地形与实体只差一个宏，着色器源码相同，three 会复用编译好的程序；每个实体一份材质的代价只是 uniform 上传。
 * 粒子另有一份顶点着色器（面朝相机），片元着色器与它们相同，只多乘一个不透明度。
 *
 * 片元着色器的最后一步是雾（#77）：开启时按这一处到相机的距离混入雾色，四种材质因此同一帧一起混入雾色。
 */

/**
 * 每帧所有光照材质共用的输入。每份材质的 uniform 表直接引用这几个 `{ value }` 对象，渲染层每帧改一次，
 * 所有材质都拿到新值：three 每次 `render` 都会给每份材质重新上传一遍 uniform。
 */
export interface FrameLighting {
  /** 天光减量（浮点，见 `daylightAt`）。 */
  readonly skyDarkening: { value: number };
  /** 闪烁量（`flickerAt`），加在方块光与手持光中较大的那个上，天光不加（`shadedLevel`）。 */
  readonly flicker: { value: number };
  /** 手持光等级（`heldLightLevel`）：选中格是火把时 14，否则 0。每一处再按离眼睛的距离减。 */
  readonly heldLight: { value: number };
  /**
   * 雾开没开（`fogAt`，#77）：眼睛在水下时开启。开启时每一处按到相机的距离混入 `fogColor`：`fogNear` 以内不混，
   * 到 `fogFar` 全是雾色，中间按 smoothstep 过渡。地形、实体与粒子都按这组 uniform 混入雾色，半透明的水与冰也一样。
   */
  readonly fogEnabled: { value: boolean };
  /** 雾色。three 的工作色彩空间（线性），与着色器里混合的颜色是同一个空间；读回时 `getHex` 给 sRGB。 */
  readonly fogColor: { value: THREE.Color };
  /** 雾从这个距离（方块）开始混入。 */
  readonly fogNear: { value: number };
  /** 到这个距离（方块）全是雾色。 */
  readonly fogFar: { value: number };
}

export function frameLighting(): FrameLighting {
  return {
    skyDarkening: { value: 0 },
    flicker: { value: 0 },
    heldLight: { value: 0 },
    fogEnabled: { value: false },
    fogColor: { value: new THREE.Color() },
    fogNear: { value: 0 },
    fogFar: { value: 1 },
  };
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

/**
 * 粒子的顶点着色器：每个实例是一个面朝相机的正方形。中心与边长、贴图的 uv 矩形、两个光照等级、
 * 不透明度都是实例属性，排布与 `ParticlePool` 的那几条数组相同。
 *
 * 在相机坐标里把正方形的四个角摆开，所以总是正对着屏幕；不乘面系数（`vShade` 为 1），正对相机的一张
 * 方片没有「哪一面朝上」。手持光按粒子中心离眼睛的距离算。
 */
const PARTICLE_VERTEX_SHADER = /* glsl */ `
attribute vec3 instanceOffset;
attribute float instanceSize;
attribute vec4 instanceUv;
attribute vec2 instanceLight;
attribute float instanceAlpha;

varying vec2 vUv;
varying vec2 vLight;
varying float vShade;
varying vec3 vWorldPosition;
varying float vAlpha;

void main() {
  vUv = mix(instanceUv.xy, instanceUv.zw, uv);
  vLight = instanceLight;
  vShade = 1.0;
  vAlpha = instanceAlpha;
  vWorldPosition = instanceOffset;
  vec4 view = viewMatrix * vec4(instanceOffset, 1.0);
  view.xy += position.xy * instanceSize;
  gl_Position = projectionMatrix * view;
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
uniform bool fogEnabled;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;

varying vec2 vUv;
varying vec2 vLight;
varying float vShade;
varying vec3 vWorldPosition;
#ifdef PARTICLE
varying float vAlpha;
#endif

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
  // 火把自己的顶点（方块光是 SELF_LIT_BLOCK_LIGHT）不吃光照：按贴图本色画，不乘曲线也不乘面系数，
  // 只随闪烁起伏（与 torch-light.ts 的 selfLitBrightness 同一个算法）。
  // 一个面四个顶点同为这个值，插值后不变；留半级余量防插值的舍入。
  bool selfLit = vLight.y > SELF_LIT_BLOCK_LIGHT - 0.5;
  float selfLitShade = 1.0 - SELF_LIT_FLICKER_DIM * (1.0 - flicker / FLICKER_AMPLITUDE);
  // 与 shading.ts 的 shadedLevel 同一个算法：闪烁只加在照到的光上，照到的不足 1 级时按比例减小。
  float held = max(0.0, heldLight - distance(vWorldPosition, cameraPosition));
  float lit = max(vLight.y, held);
  float level = max(max(vLight.x - skyDarkening, 0.0), lit + flicker * min(lit, 1.0));
  // 曲线与系数给的是画面上的亮度（乘在 sRGB 颜色上），贴图采样出来却是线性的：按 sRGB 的传递函数换回
  // 画面上的值，乘完再换回线性。不能用 2.2 次方近似成线性空间里的一个乘数：sRGB 在接近黑的那一段是线性的，
  // 近似会把暗处的贴图再压暗一截，0 级看不出轮廓。
  vec3 display = sRGBTransferOETF(vec4(texel.rgb, 1.0)).rgb * (selfLit ? selfLitShade : brightness(level) * vShade);
#if defined(PARTICLE)
  float alpha = vAlpha;
#elif defined(TRANSLUCENT)
  // 水与冰（#83）：贴图的 alpha 就是这一处的不透明度，混合时透出背后已画好的不透明部分。
  float alpha = texel.a;
#else
  float alpha = 1.0;
#endif
  vec3 color = sRGBTransferEOTF(vec4(display, 1.0)).rgb * tint;
  // 雾（#77）：在线性空间里按到相机的距离混入雾色。粒子的 vWorldPosition 是它的中心，整片方片同一个雾量。
  if (fogEnabled) {
    color = mix(color, fogColor, smoothstep(fogNear, fogFar, distance(vWorldPosition, cameraPosition)));
  }
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

/** 树叶、平面图标的镂空：透明度低于它的像素丢掉，不做半透明排序。 */
const ALPHA_TEST = 0.5;

/** 三种画法：地形（顶点带光照）、实体（光照是 uniform）、粒子（光照与样子都是实例属性）。 */
type LightSource = 'vertex' | 'entity' | 'particle';

/**
 * `translucent` 为真的是半透明的变体（#83）：输出贴图的 alpha、不做透明裁剪、开启混合、不写深度。
 * 粒子另有自己的混合规则（按每个粒子的不透明度），不走这个开关。
 */
function lightMaterial(
  texture: THREE.Texture,
  frame: FrameLighting,
  source: LightSource,
  side: THREE.Side,
  translucent = false,
): THREE.ShaderMaterial {
  const defines: Record<string, string> = {
    LIGHT_LEVELS: String(MAX_LIGHT_LEVEL + 1),
    TOP_SHADE: glslFloat(FACE_SHADE.top),
    SIDE_SHADE: glslFloat(FACE_SHADE.side),
    BOTTOM_SHADE: glslFloat(FACE_SHADE.bottom),
    SELF_LIT_BLOCK_LIGHT: glslFloat(SELF_LIT_BLOCK_LIGHT),
    SELF_LIT_FLICKER_DIM: glslFloat(SELF_LIT_FLICKER_DIM),
    FLICKER_AMPLITUDE: glslFloat(FLICKER_AMPLITUDE),
  };
  if (source === 'vertex') defines.VERTEX_LIGHT = '';
  if (source === 'particle') defines.PARTICLE = '';
  if (translucent) defines.TRANSLUCENT = '';
  const blended = translucent || source === 'particle';
  // 半透明的变体不做透明裁剪：水与冰贴图的 alpha 都高于阈值，保留裁剪也不会丢弃像素，但以后更淡的半透明贴图会全部被透明裁剪丢弃。
  const alphaTest = translucent ? 0 : ALPHA_TEST;
  return new THREE.ShaderMaterial({
    vertexShader: source === 'particle' ? PARTICLE_VERTEX_SHADER : VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    defines,
    uniforms: {
      map: { value: texture },
      // three 只按 `alphaTest` 属性加 USE_ALPHATEST 这个宏，ShaderMaterial 的值得自己放进 uniform。
      alphaTest: { value: alphaTest },
      skyDarkening: frame.skyDarkening,
      flicker: frame.flicker,
      heldLight: frame.heldLight,
      fogEnabled: frame.fogEnabled,
      fogColor: frame.fogColor,
      fogNear: frame.fogNear,
      fogFar: frame.fogFar,
      brightnessCurve: { value: BRIGHTNESS_CURVE },
      tint: { value: new THREE.Color(0xffffff) },
      entityLight: { value: new THREE.Vector2(MAX_LIGHT_LEVEL, 0) },
    },
    alphaTest,
    side,
    // 粒子按不透明度混合（烟会变淡），半透明的地形按贴图的 alpha 混合，都排在不透明的东西之后画。不写深度：
    // 变淡的烟写了深度，之后画的东西落在它后面的部分整片被挡掉；粒子之间的前后靠绘制顺序
    // （`ParticlePool.sortBackToFront`），半透明区块之间的前后靠 three 按到相机的远近排序。深度照样测：
    // 被不透明方块挡住的部分不画。
    transparent: blended,
    depthWrite: !blended,
  });
}

/** 地形的材质：两个等级从顶点属性 `light` 来。所有区块共用一份。 */
export function terrainMaterial(texture: THREE.Texture, frame: FrameLighting): THREE.ShaderMaterial {
  return lightMaterial(texture, frame, 'vertex', THREE.FrontSide);
}

/**
 * 网格半透明部分（水与冰）的材质（#83，ADR-0016 补记）：与 `terrainMaterial` 同一套着色器的变体，输出贴图的 alpha、
 * 不做透明裁剪、开启混合（`NormalBlending`）、不写深度。`transparent` 为真，three 因此把用它的网格放进透明列表，
 * 在所有不透明的网格之后画，并按到相机的距离由远到近排序，区块之间的前后就是这样排的。单面：水与冰的顶面从下面看的那一面
 * 由网格多出的一份反向的面画（`buildChunkMesh`），不靠双面材质，否则水的侧面也会从里面透出来。所有区块共用一份。
 */
export function translucentTerrainMaterial(texture: THREE.Texture, frame: FrameLighting): THREE.ShaderMaterial {
  return lightMaterial(texture, frame, 'vertex', THREE.FrontSide, true);
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
  return lightMaterial(texture, frame, 'entity', side);
}

/**
 * 粒子的材质（#59）：所有粒子共用一份，画在一个实例化的四边形上。贴图透明的像素照样按 alphaTest 丢掉，
 * 留下的部分再乘每个粒子的不透明度。
 */
export function particleMaterial(texture: THREE.Texture, frame: FrameLighting): THREE.ShaderMaterial {
  return lightMaterial(texture, frame, 'particle', THREE.FrontSide);
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
