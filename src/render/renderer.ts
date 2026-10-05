import * as THREE from 'three';
import { DEBUG_BUILD } from '../build-flags';
import type { GameCore } from '../core/game';
import type { Hitbox } from '../core/physics';
import { DROP_SIZE } from '../core/drop';
import type { ItemType } from '../core/item';
import { PLAYER_EYE_HEIGHT } from '../core/player';
import type { Vec3 } from '../core/vec3';
import { XP_ORB_SIZE } from '../core/xp-orb';
import { ZOMBIE_HEIGHT } from '../core/zombie';
import {
  CRACK_STAGES,
  HeldItemShape,
  TILE,
  crackStage,
  heldItemShape,
  itemCubeUvs,
  itemIconUvs,
  tileQuadUvs,
} from './atlas';
import {
  CELESTIAL_DISTANCE,
  CELESTIAL_SIZE,
  celestialAngle,
  celestialVisible,
  daylightAt,
  frameTimeOfDay,
  moonDirection,
  sunDirection,
  type Rgb,
  type SkyEnds,
} from './daylight';
import { dropBob, dropSpin } from './drop-motion';
import { fogAt } from './fog';
import { heldSwingPhase, heldSwingPose } from './held-swing';
import {
  entityMaterial,
  frameLighting,
  particleMaterial,
  setEntityLight,
  terrainMaterial,
  translucentTerrainMaterial,
  type FrameLighting,
} from './light-material';
import { ChunkMeshes } from './chunk-meshes';
import { buildChunkMesh, warmUpChunkMeshes } from './mesh';
import { MESH_BUDGET_PER_FRAME, planChunkMeshes } from './mesh-plan';
import { ParticleSystem, type ParticleCounts } from './particles';
import { selectionBounds } from './selection';
import { frameFlicker, heldLightLevel } from './torch-light';
import {
  ZombiePart,
  createZombieModel,
  poseZombieModel,
  tintZombieModel,
  zombieGeometries,
  zombieMaterial,
  zombieTint,
  type ZombieGeometries,
} from './zombie-model';
import type { ChunkCoord } from '../core/world';
import type { DisplayToggle } from '../settings';

/** 竖直视场角（度）。 */
const FIELD_OF_VIEW = 70;

/**
 * 手持方块画在画面的哪儿（归一化设备坐标：x 右为正、y 上为正）。
 *
 * 写成屏幕上的位置而不是相机坐标里的一个固定偏移：窗口变宽变窄时「右下角」这件事得保持
 * 不变，而相机坐标里的同一个 x 在不同宽高比下落在画面的不同位置（见 `placeHeldItem`）。
 * 方块比这个中心点大，所以下半截会被画面底边切掉——与原版一样，手是「伸进」画面的。
 */
const HELD_ITEM_SCREEN = { x: 0.52, y: -0.75 } as const;

/** 手持方块到相机的距离（方块）。远大于近裁剪面，又近得让它明显压在世界前面。 */
const HELD_ITEM_DISTANCE = 0.72;

/** 手持方块的边长（方块）。 */
const HELD_ITEM_SIZE = 0.36;

/**
 * 手持平面图标（木棍、工具）的边长（方块）。
 *
 * 比方块的边长大：立方体转过角度之后在画面上占的是它的对角线，同边长的一张平面看上去
 * 就更小，而且图标四周还留着透明边。
 */
const HELD_ICON_SIZE = 0.52;

/**
 * 手持方块的姿态（弧度）。
 * 转一点，玩家看到的是三个面而不是正对的一面——正对的一面读起来是一张平贴图。
 */
const HELD_ITEM_TILT = { x: 0.32, y: -0.72, z: 0.12 } as const;

/**
 * 裂纹的外壳比方块本身大一点（方块），选框按同样的量放大（`SELECTION_PAD`）。
 *
 * 正好等于 1 会与方块表面共面，深度测试分不出前后，画面上就是一片闪烁的斑点。
 * 放大这么一点，两者就都稳稳地浮在表面外侧，而这个量在屏幕上看不出来。
 */
const BLOCK_SHELL = 1.004;

/** 选框每条边比它套住的范围长出多少：与整格的外壳同一个量，套火把细杆时也不与杆面共面。 */
const SELECTION_PAD = BLOCK_SHELL - 1;

/**
 * 连锁预览轮廓的外壳（方块）：比选框那一层再往外一点。
 *
 * 连锁集合含目标本身，所以目标那一格上两个线框都在。差开这一点，它们就不共面，
 * 既不互相闪烁，画面上也看得出是套了两层——外面那圈亮线说的是「这一下会碎掉哪些」。
 */
const CHAIN_PREVIEW_SHELL = 1.03;

/** 选框线的颜色：黑。它回答的是「这一下挖的是哪一块」。 */
const SELECTION_COLOR = 0x000000;

/**
 * 连锁预览轮廓线的颜色：亮黄。
 * 与选框的黑线分得开——两者回答的是两件事，长得一样玩家就分不出这一下会碎掉多少。
 */
const CHAIN_PREVIEW_COLOR = 0xffd83b;

/**
 * 加载像素风贴图。必须用 Nearest 过滤且不生成 mipmap，否则贴图会被糊掉、
 * 相邻格之间还会互相渗色。
 */
export async function loadPixelTexture(path: string): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(path);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 从世界色板取色。色板定义在 src/ui/style.css 的 `:root` 里，
 * 界面与 3D 场景因此共用同一份颜色，天空不会和加载屏对不上。
 */
function paletteColor(name: string, fallback: string): THREE.Color {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return new THREE.Color(value || fallback);
}

/** 一个 three 颜色的三个分量（three 的工作色彩空间，线性）。 */
function rgbOf(color: THREE.Color): Rgb {
  return [color.r, color.g, color.b];
}

export interface WorldRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly core: GameCore;
  /** 方块图集。 */
  readonly texture: THREE.Texture;
  /** 裂纹条（见 `CRACK_PATH`）。渲染层会改它的 uv 偏移来切换裂纹阶。 */
  readonly crackTexture: THREE.Texture;
  /** 设置里的三个画面开关（ADR-0020）。每帧读当前值，改了下一帧生效。 */
  readonly settings: RenderSettings;
}

/** 渲染层读的那几项设置。 */
export type RenderSettings = Readonly<Record<DisplayToggle, boolean>>;

/**
 * 场景里那套选框与裂纹现在是什么样。
 *
 * 直接从场景里那两个对象读出来，不另存一份：端到端测试拿它下断言时，验的是真的摆在
 * 场景里的东西，而不是渲染层另存的一份副本。
 */
export interface SelectionView {
  /** 选框套在哪个方块上（方块坐标），没有目标时 undefined。 */
  readonly target?: Vec3;
  /**
   * 选框套住的范围（世界坐标，不含浮在表面外的那一点余量），没有目标时 undefined。整格方块是那一格，
   * 火把是细杆（`selectionBounds`）。
   */
  readonly bounds?: Hitbox;
  /** 裂纹阶（0 到 CRACK_STAGES−1），没画裂纹时 undefined。 */
  readonly crackStage?: number;
  /** 选框线的颜色。端到端测试拿它与连锁预览的颜色比，验两者在画面上分得开。 */
  readonly color: number;
}

/**
 * 场景里那圈连锁预览轮廓现在是什么样（见 CONTEXT.md 的「连锁预览」）。
 * 与 `SelectionView` 一样直接从场景对象上读，端到端测试验的是真摆进场景的东西。
 */
export interface ChainPreviewView {
  /** 轮廓套在哪些方块上（方块坐标），顺序与核心报的连锁集合一致。不在连锁时是空数组。 */
  readonly blocks: Vec3[];
  /** 轮廓线的颜色。端到端测试拿它与选框的颜色比，验两者在画面上分得开。 */
  readonly color: number;
}

/**
 * 场景里一个掉落物小方块现在的样子。
 * 与 `SelectionView` 一样直接从场景对象上读，端到端测试验的是真摆进场景的东西。
 */
export interface DropRenderView {
  /** 对应核心里那个掉落物的编号。 */
  readonly id: number;
  /** 小方块中心的世界坐标。漂浮的偏移已经算在里面。 */
  readonly position: Vec3;
  /** 绕竖直轴转过的角度（弧度）。 */
  readonly spin: number;
}

/**
 * 场景里一个经验球小方块现在的样子。
 * 与 `DropRenderView` 一样直接从场景对象上读，端到端测试验的是真摆进场景的东西。
 */
export interface XpOrbRenderView {
  /** 对应核心里那个经验球的编号。 */
  readonly id: number;
  /** 小方块中心的世界坐标。 */
  readonly position: Vec3;
}

/**
 * 场景里一只僵尸的模型现在的样子。
 * 与 `DropRenderView` 一样直接从场景对象上读，端到端测试验的是真摆进场景的东西。
 */
export interface ZombieRenderView {
  /** 对应核心里那只僵尸的编号。 */
  readonly id: number;
  /** 组的世界坐标：脚底中心。 */
  readonly position: Vec3;
  /** 组里有几个部件。 */
  readonly parts: number;
  /** 右臂此刻摆了多少（弧度）。站着不动时是 0。 */
  readonly armSwing: number;
  /** 部件材质乘的颜色（sRGB 十六进制）。平时是白色（贴图本色），受击后叠红时偏红，燃烧中叠橙时偏橙。 */
  readonly tint: number;
}

/**
 * 手持方块现在的样子。与上面几个一样直接从场景对象上读。
 * 空手时没有这个视图（`WorldRenderer.heldItem` 返回 undefined）。
 */
export interface HeldItemRenderView {
  /** 手上那种物品。 */
  readonly item: ItemType;
  /** 画的是立方体还是平面图标（`heldItemShape`）。端到端测试据此断言工具没被画成方块。 */
  readonly shape: HeldItemShape;
  /** 小方块（或图标）中心投在画布上的位置（归一化设备坐标，x 右为正、y 上为正）。 */
  readonly screen: { readonly x: number; readonly y: number };
  /** 挥动到了哪一步（`heldSwingPhase`）：0 是原位。 */
  readonly swing: number;
}

/**
 * 场景里的天空现在是什么样：背景色、这一帧传入着色器的光照输入与雾（ADR-0016）、太阳与月亮画不画。
 * 与 `SelectionView` 一样直接从场景对象上读，端到端测试验的是真摆进场景的东西。
 */
export interface SkyView {
  /** 场景背景色（sRGB 十六进制）。 */
  readonly background: number;
  /** 天光减量（浮点，见 `daylightAt`）：白天 0，夜晚 11。 */
  readonly skyDarkening: number;
  /** 闪烁量（见 CONTEXT.md 的「闪烁」）：在 0 到 `FLICKER_AMPLITUDE` 之间，按真实时间每帧变。 */
  readonly flicker: number;
  /** 手持光等级（见 CONTEXT.md 的「手持光」）：选中格是火把时 14，否则 0。 */
  readonly heldLight: number;
  /** 上一帧画的时候眼睛在水下（`PlayerView.eyeInWater`）。在水下时背景色是雾色，太阳与月亮不画。 */
  readonly underwater: boolean;
  /** 传入着色器的雾开没开（`FrameLighting.fogEnabled`）。 */
  readonly fogEnabled: boolean;
  /** 传入着色器的雾色（sRGB 十六进制）。 */
  readonly fogColor: number;
  /** 传入着色器的雾从多远（方块）开始混入。 */
  readonly fogNear: number;
  /** 传入着色器的雾到多远（方块）全是雾色。 */
  readonly fogFar: number;
  readonly sunVisible: boolean;
  readonly moonVisible: boolean;
}

/**
 * 场景里的粒子现在有多少（见 CONTEXT.md 的「粒子」）：按种类的数量与总数，加上总数的上限。
 * 总数读的是实例化几何体这一帧画了几个实例；按种类的数量读粒子池，池子里的数组就是那几个实例属性。
 */
export interface ParticleView extends ParticleCounts {
  readonly limit: number;
}

/**
 * 渲染适配器：把核心的方块数据画成 Three.js 场景。
 *
 * 相机是第一人称的：跟着核心里的玩家走，位置在两次 tick 之间插值（ADR-0002）。
 * 游戏状态一概只读——唯一往核心里写的是 `takeStaleChunks()`，它取走的是「哪些区块的网格
 * 过期了」这份待处理记录，不是世界本身。
 */
export class WorldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** 方块图集。地形、掉落物、僵尸与手持物品的材质都贴它。 */
  private readonly texture: THREE.Texture;
  /** 每帧传入所有光照材质的输入：天光减量、闪烁、手持光与雾（ADR-0016）。 */
  private readonly frame: FrameLighting = frameLighting();
  /** 上一帧画的时候眼睛在不在水下（`updateSky`）。 */
  private underwater = false;
  /**
   * 给不走光照材质的东西用的雾（经验球、选框、裂纹）：three 自带材质读取 `scene.fog`，颜色与两个距离每帧从
   * `frame` 复制，只在水下时设到 `scene.fog`。three 的雾按到相机平面的深度算，光照材质按到相机的距离算，
   * 视野边缘有少量出入，这几样东西都在近处，画面上没有可见差异。光照材质（`ShaderMaterial`）不读取 `scene.fog`，
   * 不会重复混入雾色。
   */
  private readonly sceneFog = new THREE.Fog(0x000000);
  private readonly core: GameCore;
  /** 场景里的区块网格，每个区块不透明与半透明两份几何（#83）。 */
  private readonly meshes: ChunkMeshes;
  /** 只有光照变了、上一帧没轮到重建的区块（`MeshPlan.deferred`），下一帧交回给 `planChunkMeshes`。 */
  private deferredRelights: readonly ChunkCoord[] = [];
  /** 套在目标方块外的线框。 */
  private readonly selectionBox: THREE.LineSegments;
  private readonly selectionMaterial: THREE.LineBasicMaterial;
  /** 贴在目标方块表面的裂纹。 */
  private readonly crackBox: THREE.Mesh;
  private readonly crackTexture: THREE.Texture;
  /**
   * 连锁预览的那些线框，一格一个。
   *
   * 一个池子，只增不减：上限是 `CHAIN_MINING_LIMIT`（64）个线框，全建出来也就那么多，
   * 用不上的置为不可见。每次进出连锁都新建又销毁的话，玩家一按一松就是一轮几何体分配。
   */
  private readonly chainPreviewBoxes: THREE.LineSegments[] = [];
  /** 连锁预览的轮廓共用的几何体与材质：64 圈长得一样，各建一份就够。 */
  private readonly chainPreviewGeometry: THREE.BufferGeometry;
  private readonly chainPreviewMaterial: THREE.LineBasicMaterial;
  /**
   * 场景里的掉落物小方块，按核心给的编号索引。
   *
   * 一个掉落物一个 `Mesh`，没有合并成 InstancedMesh：视距内同时存在的掉落物是几个到
   * 几十个的量级，而每个还要各自转、各自漂浮，为省下那点绘制调用去写按物品分组、
   * 逐实例更新矩阵那一套不值得。连锁挖掘一次最多挖 64 块（`CHAIN_MINING_LIMIT`），
   * 那也就是 64 个小方块，而且几十 tick 内就全被拾取。真到了几百个再改——这条与整套
   * 实体同步的取舍都记在 ADR-0007 里。
   */
  private readonly dropMeshes = new Map<number, THREE.Mesh>();
  /** 每种物品的小方块几何体：边长 1，用的人各自缩放。建一次就一直共用。 */
  private readonly itemGeometries = new Map<ItemType, THREE.BufferGeometry>();
  /** 每种物品的平面图标几何体：边长 1 的一张面。只有手持用它，同样建一次共用。 */
  private readonly iconGeometries = new Map<ItemType, THREE.BufferGeometry>();
  /**
   * 手持物品的两份材质：立方体一份，平面图标一份。图标那份与方块同一张图集、同样靠 alphaTest 抠掉
   * 图标四周的透明边，但两面都画——一张面转过角度之后背面朝着相机的话，单面材质就整张不见了。
   * 两份每帧都按玩家眼睛那一格的光照写（`updateHeldItem`）。
   */
  private readonly heldBlockMaterial: THREE.ShaderMaterial;
  private readonly heldIconMaterial: THREE.ShaderMaterial;
  /**
   * 手持方块单独一个场景、单独一个相机，在世界之后再画一遍（见 `render`）。
   *
   * 不把它挂到主相机下面：那样它就参与世界那一遍的深度测试，而它离眼睛只有 0.72 格，
   * 比玩家能贴到的墙（半宽 0.3 格）还远——贴着墙站着时手上那块方块会被墙切穿。
   * 单独一遍就不会。相机永远在原点朝 −Z，所以摆位置只按画面算，不必跟着玩家的视角转。
   */
  private readonly handScene = new THREE.Scene();
  private readonly handCamera: THREE.PerspectiveCamera;
  /** 手持方块这一层只管摆位置（`placeHeldItem`），方块本身是它的子节点。 */
  private readonly handAnchor = new THREE.Group();
  /** 手上那块方块或那张图标。空手时还在场景里，只是 `visible` 为 false。 */
  private heldItemMesh: THREE.Mesh | undefined;
  /** 现在画的是哪种物品。与核心的手持不同就换几何体（与材质、大小）。 */
  private heldItemType: ItemType | undefined;
  /** 上一帧挥动到了哪一步。 */
  private heldSwing = 0;
  /** 场景里的僵尸模型，按核心给的编号索引。与掉落物同一套做法，见 ADR-0007。 */
  private readonly zombieModels = new Map<number, THREE.Group>();
  /** 僵尸六个部件的几何体：所有僵尸长得一样，建一份共用，僵尸消失时不销毁。 */
  private readonly zombieGeometries: ZombieGeometries = zombieGeometries();
  /** 场景里的经验球小方块，按核心给的编号索引。与掉落物同一套做法，见 ADR-0007。 */
  private readonly xpOrbMeshes = new Map<number, THREE.Mesh>();
  /** 经验球的几何体与材质：所有经验球长得一样，各建一份共用就够。 */
  private readonly xpOrbGeometry = new THREE.BoxGeometry(XP_ORB_SIZE, XP_ORB_SIZE, XP_ORB_SIZE);
  private readonly xpOrbMaterial: THREE.Material;
  /** 场景背景色。每帧按世界时刻在两端之间插值后写回它（`updateSky`）。 */
  private readonly skyColor: THREE.Color;
  /** 天空色的两端：白天取世界色板的 `--sky`，夜晚取 `--night-sky`。 */
  private readonly skyEnds: SkyEnds;
  /**
   * 太阳与月亮挂在这一层下面：它的位置每帧设成相机的位置，绕 z 轴按时刻转，两张方片分别摆在
   * 它的 ±X 上。位置随相机，玩家走多远离它们都一样远；朝向不随相机，转头时它们停在天上原处。
   */
  private readonly celestialPivot = new THREE.Group();
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  /** 粒子池与发射规则（`particles.ts`）。池子里的几条数组直接是下面那份几何体的实例属性。 */
  private readonly particleSystem = new ParticleSystem();
  /** 所有粒子共用的一张四边形，按实例画：每帧只改实例属性与实例数。 */
  private readonly particleGeometry: THREE.InstancedBufferGeometry;
  /** 上一帧的真实时间（毫秒），粒子按两帧之间的间隔推进。 */
  private lastFrameMs: number | undefined;
  private readonly settings: RenderSettings;
  /** 已建的网格是按平滑光照开还是关建的。与设置不同时全部过期重建（`syncChunkMeshes`）。 */
  private meshedSmooth: boolean;

  constructor({ canvas, core, texture, crackTexture, settings }: WorldRendererOptions) {
    this.core = core;
    this.settings = settings;
    this.meshedSmooth = settings.smoothLighting;
    // 在建真正的区块之前让网格构建的每条分支都走一遍，理由见 warmUpChunkMeshes。
    warmUpChunkMeshes();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      // 只在开发与测试构建里保留绘制缓冲，好让端到端测试把画布内容读回来判断
      // 是否真画出了东西。生产构建不带这个负担。
      preserveDrawingBuffer: DEBUG_BUILD,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const daySky = paletteColor('--sky', '#7fb2e8');
    this.skyEnds = { day: rgbOf(daySky), night: rgbOf(paletteColor('--night-sky', '#0d1226')) };
    this.skyColor = daySky.clone();
    this.scene.background = this.skyColor;
    // 场景里没有灯：明暗全由光照材质按每一处的光照等级算（ADR-0016）。
    this.texture = texture;
    // 区块网格的两种材质，所有区块共用，两个光照等级从顶点来：水与冰的面用半透明的那一份（#83）。
    this.meshes = new ChunkMeshes(this.scene, {
      opaque: terrainMaterial(texture, this.frame),
      translucent: translucentTerrainMaterial(texture, this.frame),
    });
    this.heldBlockMaterial = entityMaterial(texture, this.frame);
    this.heldIconMaterial = entityMaterial(texture, this.frame, THREE.DoubleSide);

    // 经验球不吃光照：它是一团光，六个面明暗一致才像发着光，而不像一小块黄绿方块。
    this.xpOrbMaterial = new THREE.MeshBasicMaterial({
      color: paletteColor('--xp', '#7ee02a'),
    });

    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 1000);
    // YXZ：先偏航再俯仰，第一人称相机因此永远不会侧倾。
    this.camera.rotation.order = 'YXZ';
    this.updateCamera(1);

    // 手持那一遍：相机与主相机同一个视场，但不动——手持方块是按画面位置摆的。
    // 远裁剪面只要够装下它自己。
    this.handCamera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 10);
    this.handScene.add(this.handAnchor);

    // 太阳与月亮不参与光照，也不吃光照：方片本身就是发光的样子，夜里不该跟着地形一起变暗。
    const celestialMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      alphaTest: 0.5,
      depthTest: false,
      depthWrite: false,
    });
    this.sun = celestialQuad(TILE.sun, celestialMaterial, 1);
    this.moon = celestialQuad(TILE.moon, celestialMaterial, -1);
    this.celestialPivot.add(this.sun, this.moon);
    this.scene.add(this.celestialPivot);
    // 两遍渲染各自决定清什么，所以关掉自动清屏，见 render()。
    this.renderer.autoClear = false;

    const shell = new THREE.BoxGeometry(BLOCK_SHELL, BLOCK_SHELL, BLOCK_SHELL);
    this.selectionMaterial = new THREE.LineBasicMaterial({
      color: SELECTION_COLOR,
      transparent: true,
      opacity: 0.55,
    });
    // 选框是边长 1 的线框，每帧按套住的范围缩放：整格方块与火把细杆共用一个对象。
    this.selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      this.selectionMaterial,
    );
    this.selectionBox.visible = false;
    this.selectionBox.renderOrder = OVERLAY_RENDER_ORDER;
    this.scene.add(this.selectionBox);

    // 预览轮廓是不透明的亮黄线，选框是半透明的黑线：两圈套在同一格上时也分得出。
    this.chainPreviewGeometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(CHAIN_PREVIEW_SHELL, CHAIN_PREVIEW_SHELL, CHAIN_PREVIEW_SHELL),
    );
    this.chainPreviewMaterial = new THREE.LineBasicMaterial({ color: CHAIN_PREVIEW_COLOR });

    // 裂纹条横排了 CRACK_STAGES 张图，取哪一张靠 uv 偏移；这里先把采样窗口收成一格宽。
    this.crackTexture = crackTexture;
    this.crackTexture.repeat.set(1 / CRACK_STAGES, 1);
    this.crackBox = new THREE.Mesh(
      shell,
      new THREE.MeshBasicMaterial({
        map: crackTexture,
        transparent: true,
        // 裂纹只是贴在表面上的一层，不该写深度：否则它自己朝后的三个面会把朝前的挡掉。
        depthWrite: false,
      }),
    );
    this.crackBox.visible = false;
    this.crackBox.renderOrder = OVERLAY_RENDER_ORDER;
    this.scene.add(this.crackBox);

    this.particleGeometry = particleGeometry(this.particleSystem);
    const particleMesh = new THREE.Mesh(this.particleGeometry, particleMaterial(texture, this.frame));
    // 几何体只是一张原点上的四边形，粒子摆在哪由实例属性定，按它算的包围球不对，不做视锥剔除
    particleMesh.frustumCulled = false;
    particleMesh.renderOrder = OVERLAY_RENDER_ORDER;
    this.scene.add(particleMesh);

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  /** 窗口尺寸变化时重设画布与相机。存成字段，`dispose` 才能把它从窗口上移除。 */
  private readonly onResize = (): void => this.resize();

  /**
   * 退出世界时调：卸下窗口监听，释放 WebGL 上下文。上下文丢弃之后，GPU 上的网格、贴图与材质一并回收，
   * 不必逐个 dispose。之后这个渲染器不能再用，画布由接线层移除。
   */
  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** 已经建过网格的区块数（含一个面都没有的那些）。 */
  get chunkMeshCount(): number {
    return this.meshes.size;
  }

  /** 这个区块的网格建过没有。 */
  hasChunkMesh(cx: number, cz: number): boolean {
    return this.meshes.has(cx, cz);
  }

  /** 相机当前的位置。端到端测试用它确认相机真的跟在玩家眼睛上。 */
  get cameraPosition(): Vec3 {
    const { x, y, z } = this.camera.position;
    return { x, y, z };
  }

  /** 上一帧画出来的天空：背景色、送进着色器的三个数与太阳月亮。 */
  get sky(): SkyView {
    return {
      background: this.skyColor.getHex(),
      skyDarkening: this.frame.skyDarkening.value,
      flicker: this.frame.flicker.value,
      heldLight: this.frame.heldLight.value,
      underwater: this.underwater,
      fogEnabled: this.frame.fogEnabled.value,
      fogColor: this.frame.fogColor.value.getHex(),
      fogNear: this.frame.fogNear.value,
      fogFar: this.frame.fogFar.value,
      sunVisible: this.sun.visible,
      moonVisible: this.moon.visible,
    };
  }

  /**
   * 世界与手持两个场景里有几个灯光对象。端到端测试用它确认两盏场景灯真的删掉了：明暗全由光照材质算，
   * 场景里留着一盏灯也不会让画面出错，只有直接数才看得出。
   */
  get sceneLightCount(): number {
    let count = 0;
    for (const scene of [this.scene, this.handScene]) {
      scene.traverse((object) => {
        if ((object as THREE.Light).isLight) count++;
      });
    }
    return count;
  }

  /** 上一帧画出来的选框与裂纹。 */
  get selection(): SelectionView {
    const color = this.selectionMaterial.color.getHex();
    if (!this.selectionBox.visible) return { color };
    const { position, scale } = this.selectionBox;
    const half = scale.clone().subScalar(SELECTION_PAD).multiplyScalar(0.5);
    const min = position.clone().sub(half);
    const max = position.clone().add(half);
    return {
      // 套住的范围总在目标那一格里，它的中心取整就是那一格
      target: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      bounds: { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } },
      crackStage: this.crackBox.visible
        ? Math.round(this.crackTexture.offset.x * CRACK_STAGES)
        : undefined,
      color,
    };
  }

  /** 上一帧画出来的粒子。 */
  get particles(): ParticleView {
    return {
      ...this.particleSystem.pool.counts(),
      total: this.particleGeometry.instanceCount,
      limit: this.particleSystem.pool.capacity,
    };
  }

  /** 上一帧画出来的连锁预览轮廓。 */
  get chainPreview(): ChainPreviewView {
    return {
      blocks: this.chainPreviewBoxes
        .filter((box) => box.visible)
        .map((box) => blockOf(box.position)),
      color: this.chainPreviewMaterial.color.getHex(),
    };
  }

  /** 上一帧画出来的掉落物小方块。 */
  get drops(): DropRenderView[] {
    return [...this.dropMeshes].map(([id, mesh]) => ({
      id,
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      spin: mesh.rotation.y,
    }));
  }

  /** 上一帧画出来的经验球小方块。 */
  get xpOrbs(): XpOrbRenderView[] {
    return [...this.xpOrbMeshes].map(([id, mesh]) => ({
      id,
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    }));
  }

  /** 上一帧画出来的僵尸模型。 */
  get zombies(): ZombieRenderView[] {
    return [...this.zombieModels].map(([id, group]) => ({
      id,
      position: { x: group.position.x, y: group.position.y, z: group.position.z },
      parts: group.children.length,
      armSwing: group.getObjectByName(ZombiePart.RightArm)!.rotation.x,
      tint: zombieTint(group),
    }));
  }

  /**
   * 上一帧画出来的手持方块，空手时 undefined。
   *
   * 投影用的是相机自己的矩阵，所以报出来的位置就是它在画面上的位置——端到端测试据此
   * 断言它真在右下角，而不是相信一个写在别处的常量。
   */
  get heldItem(): HeldItemRenderView | undefined {
    const mesh = this.heldItemMesh;
    const item = this.heldItemType;
    if (!mesh?.visible || item === undefined) return undefined;
    const { x, y } = mesh.getWorldPosition(new THREE.Vector3()).project(this.handCamera);
    return { item, shape: heldItemShape(item), screen: { x, y }, swing: this.heldSwing };
  }

  /** 这个区块的网格有多少个顶点，不透明与半透明两部分合计。没建过网格、或者一个面都没有时是 0。 */
  chunkMeshVertexCount(cx: number, cz: number): number {
    return this.meshes.vertexCount(cx, cz);
  }

  /**
   * 这个区块的网格用到了哪些贴图格号，两部分合计，按格号排序。没建过网格、或者一个面都没有时是空数组。
   * 端到端测试用它确认一块熔炉画的是熄火还是燃烧的正面。
   */
  chunkMeshTiles(cx: number, cz: number): number[] {
    return this.meshes.tiles(cx, cz);
  }

  /**
   * 让场景里的网格与核心的已加载区块一致：卸载掉的区块移除网格，新到位的区块建网格，过期的重建。
   *
   * 每帧调一次。方块变了的区块不论预算都当帧重建；只有光照变了的重建与新区块的首次建网格一帧合起来最多
   * `budget` 个（方块变了的先占用），剩下的留到下一帧——哪些该建、先建哪个由 `planChunkMeshes` 决定。
   * `budget` 给 Infinity 表示「现在全部建完」，首帧之前用它把出生点那一带一次铺好。
   */
  syncChunkMeshes(budget = MESH_BUDGET_PER_FRAME): void {
    // 设置里切了平滑光照：已建的网格全部过期，与只有光照变了的一样按预算由近到远重建，几秒内换完。设置界面开在暂停
    // 菜单上，暂停时照样每帧画，所以关掉设置之前就能看到墙角的变化。
    if (this.settings.smoothLighting !== this.meshedSmooth) {
      this.meshedSmooth = this.settings.smoothLighting;
      this.deferredRelights = [...this.meshes.coords()].map(({ cx, cz }) => ({ cx, cz }));
    }
    // 方块变了的网格当帧重建，只有光照变了的与新区块一起按预算由近到远排，没轮到的留到下一帧；缺邻居的丢掉
    // 等邻居回来。都由 planChunkMeshes 定，首次建与重建因此走同一条「8 个邻居都在」的规则。
    const stale = this.core.takeStaleChunks();
    const plan = planChunkMeshes({
      world: this.core,
      meshed: this.meshes.coords(),
      staleBlocks: stale.blocks,
      staleLight: [...this.deferredRelights, ...stale.light],
      center: this.core.playerChunk,
      radius: this.core.viewRadius,
      budget,
    });
    this.deferredRelights = plan.deferred;
    for (const { cx, cz } of plan.drop) this.meshes.drop(cx, cz);
    for (const { cx, cz } of plan.rebuild) this.rebuildChunk(cx, cz);
    for (const { cx, cz } of plan.build) this.buildChunk(cx, cz);
  }

  /**
   * 只有光照变了、还没轮到重建的区块数（见 `syncChunkMeshes`）。放挖火把之后几帧内回到 0，端到端测试读它。
   */
  get deferredRelightCount(): number {
    return this.deferredRelights.length;
  }

  /** 重建一个区块的网格。方块被挖掉或放下之后由 `syncChunkMeshes` 调。 */
  rebuildChunk(cx: number, cz: number): void {
    this.meshes.drop(cx, cz);
    this.buildChunk(cx, cz);
  }

  /**
   * 建一个区块的网格，两部分进出场景由 `ChunkMeshes` 管：一个面都没有的区块（整块空气）也记为建过，只是不往场景里放东西。
   */
  private buildChunk(cx: number, cz: number): void {
    const chunk = this.core.chunkAt(cx, cz);
    if (!chunk) return;
    this.meshes.set(cx, cz, buildChunkMesh(chunk, this.core, this.meshedSmooth));
  }

  /**
   * 每推进一个 tick 之后调一次（游戏循环）：这一 tick 碎掉了方块（`MiningView.broken`）就在那一格爆一团碎屑（#60）。
   *
   * 不放进 `render`：碎掉的方块只在一 tick 里有值，一帧可能补几个 tick，等到画这一帧时可能已经清空了。
   * 端到端测试在一次 evaluate 里直接调 `core.tick()` 时不经过游戏循环，也就不爆碎屑。
   */
  afterTick(): void {
    const { broken } = this.core.mining;
    if (broken) this.particleSystem.burst(broken);
  }

  /**
   * 画一帧。
   * `alpha` 是当前帧落在上一个 tick 与下一个 tick 之间的比例（0..1），相机位置按它插值。
   */
  render(alpha = 1): void {
    this.updateCamera(alpha);
    this.updateSky(alpha);
    this.updateTorchLight();
    this.updateSelection();
    this.updateChainPreview();
    this.updateDrops(alpha);
    this.updateXpOrbs(alpha);
    this.updateZombies(alpha);
    this.updateHeldItem();
    this.updateHeldSwing(alpha);
    this.updateParticles();

    // 两遍：先画世界，再把深度清掉画手上那块方块。深度一清，手持就永远在世界前面，
    // 贴着墙站着也不会被墙切穿（`handScene` 的注释里记了为什么不能挂在主相机下）。
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.handScene, this.handCamera);
  }

  /**
   * 按世界时刻与眼睛在不在水下更新天空：背景色、传入着色器的天光减量与雾、太阳与月亮的位置。
   *
   * 时刻与相机位置一样在上一个 tick 与当前 tick 之间插值（ADR-0002），太阳因此平滑地走，
   * 黄昏也是连续变暗的——减量不取整，着色器拿到的是浮点值。算法都在 `daylight.ts` 与 `fog.ts` 里，这里只把结果
   * 写进场景对象。太阳月亮那一层的位置取相机的位置，所以排在 `updateCamera` 之后。
   *
   * 眼睛在水下时（#77）背景色换成雾色、太阳与月亮不画：它们远在雾的 `far` 之外，不藏起来就会透过雾露出来。
   * 经验球、选框与裂纹不走光照材质，改由场景上的雾（`sceneFog`）混入雾色。眼睛在不在水下读核心按 tick 算的值，
   * 不按插值后的相机位置另算，出入水面时最多差一个 tick。
   */
  private updateSky(alpha: number): void {
    const time = frameTimeOfDay(this.core.timeOfDay, alpha);
    const { sky, skyDarkening } = daylightAt(time, this.skyEnds);
    this.frame.skyDarkening.value = skyDarkening;

    this.underwater = this.core.player.eyeInWater;
    const fog = fogAt(this.underwater);
    this.frame.fogEnabled.value = fog.enabled;
    this.frame.fogColor.value.setRGB(...fog.color, THREE.SRGBColorSpace);
    this.frame.fogNear.value = fog.near;
    this.frame.fogFar.value = fog.far;
    if (fog.enabled) this.skyColor.copy(this.frame.fogColor.value);
    else this.skyColor.setRGB(...sky);
    this.sceneFog.color.copy(this.frame.fogColor.value);
    this.sceneFog.near = fog.near;
    this.sceneFog.far = fog.far;
    this.scene.fog = fog.enabled ? this.sceneFog : null;

    this.celestialPivot.position.copy(this.camera.position);
    this.celestialPivot.rotation.z = celestialAngle(time);
    this.sun.visible = !fog.enabled && celestialVisible(sunDirection(time));
    this.moon.visible = !fog.enabled && celestialVisible(moonDirection(time));
  }

  /**
   * 更新送进着色器的手持光与闪烁量（ADR-0016）：手持光看选中格里的物品，每帧都写，切到别的格子
   * 下一帧就灭；闪烁量按真实时间算，设置里关掉闪烁时是 0。两者都只在画面上，核心不知道它们。
   */
  private updateTorchLight(): void {
    this.frame.heldLight.value = heldLightLevel(this.core.inventory.held?.item);
    this.frame.flicker.value = frameFlicker(this.settings.flicker, performance.now() / 1000);
  }

  /**
   * 推进粒子一帧（#59）：已建网格的区块里、离眼睛 16 格内的发光方块按概率冒火焰光点与烟，池子推进、到期的回收、
   * 由远到近重排，再把存活的个数交给实例化几何体。挖掘中从目标方块被瞄准的那一面溅碎屑（#60）；碎掉时爆的那一团
   * 在 `afterTick` 里生成。
   *
   * 按真实时间推进，与闪烁一样：打开界面、世界不推进时火照样冒烟。发光方块的列表跟着网格走，
   * 熔炉熄火、火把挖掉之后区块重建，下一帧就不冒了；还没建网格的区块看不见，也不冒。
   */
  private updateParticles(): void {
    const now = performance.now();
    const seconds = this.lastFrameMs === undefined ? 0 : (now - this.lastFrameMs) / 1000;
    this.lastFrameMs = now;
    // 粒子开关每帧照设置写一次。设置只在暂停时改，那时不推进 tick，`afterTick` 里的碎掉爆一团也就读得到这一次写的。
    this.particleSystem.emitting = this.settings.particles;
    this.particleSystem.update(seconds, this.camera.position, this.meshes.glowingBlocks(), this.core, this.core.mining);

    const { count } = this.particleSystem.pool;
    const geometry = this.particleGeometry;
    geometry.instanceCount = count;
    // 一个都没有时不上传：长度 0 的上传范围在 WebGL2 里表示「一直到数组末尾」，反而会上传整条数组
    if (count === 0) return;
    for (const attribute of Object.values(geometry.attributes)) {
      if (!(attribute instanceof THREE.InstancedBufferAttribute)) continue;
      // 只上传存活的那一段
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  /**
   * 让右下角那块手持方块（或那张图标）跟上核心里的手持物品（`InventoryView.held`）。
   *
   * 手持是核心的状态，第一人称里的那块方块纯粹是它的表现——摆在哪儿、转多少度都在
   * 这个文件里，核心不知道画面上有这么一块东西（与掉落物同一套分工，见 ADR-0007）。
   * 只在物品换了的时候动几何体，其余帧一个属性都不碰。
   *
   * 方块物品画立方体，木棍与工具画一张竖着的平面图标（`heldItemShape`）：同一个 `Mesh`，
   * 换的是几何体、材质与大小，姿态两种共用——图标也斜着拿，与方块一样从右下伸进画面。
   *
   * 明暗按玩家眼睛那一格的光照（见 CONTEXT.md 的「亮度」），每帧都写：洞里手上的镐也是暗的。
   */
  private updateHeldItem(): void {
    for (const material of [this.heldBlockMaterial, this.heldIconMaterial]) {
      this.lightAt(material, this.camera.position, 0);
    }

    const item = this.core.inventory.held?.item;
    if (item === this.heldItemType) return;
    this.heldItemType = item;

    if (item === undefined) {
      if (this.heldItemMesh) this.heldItemMesh.visible = false;
      return;
    }

    if (!this.heldItemMesh) {
      const mesh = new THREE.Mesh();
      mesh.rotation.set(HELD_ITEM_TILT.x, HELD_ITEM_TILT.y, HELD_ITEM_TILT.z);
      this.handAnchor.add(mesh);
      this.heldItemMesh = mesh;
    }
    const mesh = this.heldItemMesh;
    if (heldItemShape(item) === HeldItemShape.Flat) {
      mesh.geometry = this.iconGeometry(item);
      mesh.material = this.heldIconMaterial;
      mesh.scale.setScalar(HELD_ICON_SIZE);
    } else {
      mesh.geometry = this.itemGeometry(item);
      mesh.material = this.heldBlockMaterial;
      mesh.scale.setScalar(HELD_ITEM_SIZE);
    }
    mesh.visible = true;
  }

  /**
   * 让手持物品按核心的挥动状态挥：左键按下挥一下，挖掘中一直挥（`heldSwingPhase`）。挪的是手上那块
   * 相对摆位那一层的位置与俯仰，摆位那一层本身不动——它管的是「右下角」，与挥不挥无关。
   */
  private updateHeldSwing(alpha: number): void {
    const mesh = this.heldItemMesh;
    if (!mesh) return;
    const { lastSwingTick, mining, tickCount } = this.core;
    this.heldSwing = heldSwingPhase(lastSwingTick, mining.digging, tickCount, alpha);
    const pose = heldSwingPose(this.heldSwing);
    mesh.position.set(pose.x, pose.y, pose.z);
    mesh.rotation.set(HELD_ITEM_TILT.x + pose.pitch, HELD_ITEM_TILT.y, HELD_ITEM_TILT.z);
  }

  /**
   * 把手持方块摆到画面右下角。
   *
   * 相机坐标里的横向偏移得按宽高比换算：同一个 x 在宽窗口里靠中间、在窄窗口里就出了画面。
   * 所以每次改变画布尺寸都要重算一次。
   */
  private placeHeldItem(): void {
    const halfHeight = Math.tan((FIELD_OF_VIEW / 2) * (Math.PI / 180)) * HELD_ITEM_DISTANCE;
    this.handAnchor.position.set(
      HELD_ITEM_SCREEN.x * halfHeight * this.handCamera.aspect,
      HELD_ITEM_SCREEN.y * halfHeight,
      -HELD_ITEM_DISTANCE,
    );
  }

  /**
   * 让场景里的小方块跟上核心里的掉落物：新掉出来的加进场景，被拾取或超时的移出去。
   *
   * 每帧全量遍历一遍，而不是等核心来告诉「哪个变了」：实体每 tick 都在动，脏集那套
   * 反而更贵，理由与三个被否的候选都在 ADR-0007 里。
   *
   * 漂浮与旋转纯粹是表现，核心里没有这两个量——它只报位置与存活 tick 数，相位由
   * `age + alpha` 算，因此在两次 tick 之间也是连续的，不会以 20Hz 一跳一跳地转。
   *
   * 每个小方块一份自己的光照材质，按碰撞箱中心那一格的光照画（见 CONTEXT.md 的「亮度」）。
   */
  private updateDrops(alpha: number): void {
    this.syncEntityObjects(
      this.core.drops.all(),
      this.dropMeshes,
      (drop) => this.itemMesh(drop.item, DROP_SIZE),
      (mesh, drop) => {
        const phase = drop.age + alpha;
        mesh.position.copy(entityCenter(drop, alpha, DROP_SIZE));
        mesh.position.y += dropBob(phase);
        mesh.rotation.y = dropSpin(phase);
        this.lightAt(mesh.material as THREE.ShaderMaterial, drop.position, DROP_SIZE);
      },
      (mesh) => (mesh.material as THREE.Material).dispose(),
    );
  }

  /**
   * 让场景里的小方块跟上核心里的经验球。
   *
   * 与掉落物同一套做法（ADR-0007），只是经验球不转也不漂：它一生成就朝玩家飞过来，
   * 几 tick 就没了，转与漂根本看不出来，加上只会让「它在往我这边来」这件事更难看清。
   */
  private updateXpOrbs(alpha: number): void {
    this.syncEntityObjects(
      this.core.xpOrbs.all(),
      this.xpOrbMeshes,
      () => new THREE.Mesh(this.xpOrbGeometry, this.xpOrbMaterial),
      (mesh, orb) => mesh.position.copy(entityCenter(orb, alpha, XP_ORB_SIZE)),
    );
  }

  /**
   * 让场景里的人形模型跟上核心里的僵尸：一只一个六部件的组（`createZombieModel`），摆位与
   * 摆臂摆腿在 `poseZombieModel` 里，相位按 `age + alpha` 算。
   *
   * 与掉落物同一套做法（ADR-0007）。每只一份自己的光照材质，贴图是方块那张图集：按碰撞箱中心那一格的
   * 光照画，洞里的僵尸是暗的。受击后 10 tick 内叠红，燃烧中叠橙，都是这份材质上的叠色（`tintZombieModel`）。
   */
  private updateZombies(alpha: number): void {
    const now = this.core.tickCount;
    this.syncEntityObjects(
      this.core.zombies.all(),
      this.zombieModels,
      () => createZombieModel(this.zombieGeometries, entityMaterial(this.texture, this.frame)),
      (group, zombie) => {
        poseZombieModel(group, zombie, alpha);
        tintZombieModel(group, zombie, now);
        this.lightAt(zombieMaterial(group), zombie.position, ZOMBIE_HEIGHT);
      },
      (group) => zombieMaterial(group).dispose(),
    );
  }

  /**
   * 一个实体这一帧按它碰撞箱中心那一格的天光与方块光画：`bottom` 是碰撞箱底面中心，`height` 是碰撞箱高。
   * 手持物品给的是眼睛的位置、高 0，取的就是眼睛那一格。
   */
  private lightAt(material: THREE.ShaderMaterial, bottom: Vec3, height: number): void {
    const { x, z } = bottom;
    const y = bottom.y + height / 2;
    setEntityLight(material, this.core.skyLightAt(x, y, z), this.core.blockLightAt(x, y, z));
  }

  /**
   * 让一批场景对象跟上核心里的一批实体：新出现的建好加进场景，消失的移出去，留着的
   * 交给 `place` 摆位。
   *
   * 掉落物、经验球与僵尸共用这一份：ADR-0007 定的实体同步就是「每帧全量遍历 + 按编号认对象」
   * 这一套，各写一遍迟早有一边忘了从场景里移除。场景对象可以是一个 `Mesh`，也可以是一整个组。
   * `dispose` 给的是对象自己独占、移出场景后要释放的东西（每个实体一份的材质）；共用的不在其中。
   */
  private syncEntityObjects<T extends { readonly id: number }, O extends THREE.Object3D>(
    entities: readonly T[],
    objects: Map<number, O>,
    create: (entity: T) => O,
    place: (object: O, entity: T) => void,
    dispose?: (object: O) => void,
  ): void {
    const alive = new Set<number>();
    for (const entity of entities) {
      alive.add(entity.id);
      let object = objects.get(entity.id);
      if (!object) {
        object = create(entity);
        this.scene.add(object);
        objects.set(entity.id, object);
      }
      place(object, entity);
    }

    for (const [id, object] of objects) {
      if (alive.has(id)) continue;
      this.scene.remove(object);
      dispose?.(object);
      objects.delete(id);
    }
  }

  /** 一块某种物品的小方块，边长 `size`，带一份自己的光照材质。 */
  private itemMesh(item: ItemType, size: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.itemGeometry(item), entityMaterial(this.texture, this.frame));
    mesh.scale.setScalar(size);
    return mesh;
  }

  /**
   * 某种物品的小方块几何体：边长 1，用的人各自缩放。
   * 掉落物与手持方块因此共用同一份——两者只差大小与姿态。几何体不随掉落物销毁。
   */
  private itemGeometry(item: ItemType): THREE.BufferGeometry {
    const cached = this.itemGeometries.get(item);
    if (cached) return cached;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // BoxGeometry 默认每个面都铺满整张贴图，得换成图集里那一格，见 itemCubeUvs。
    geometry.setAttribute('uv', new THREE.BufferAttribute(itemCubeUvs(item), 2));
    this.itemGeometries.set(item, geometry);
    return geometry;
  }

  /** 某种物品的平面图标几何体：边长 1 的一张面，贴的是图集里它那一格（`itemIconUvs`）。 */
  private iconGeometry(item: ItemType): THREE.BufferGeometry {
    const cached = this.iconGeometries.get(item);
    if (cached) return cached;
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute('uv', new THREE.BufferAttribute(itemIconUvs(item), 2));
    this.iconGeometries.set(item, geometry);
    return geometry;
  }

  /**
   * 把选框与裂纹摆到目标方块上。
   *
   * 目标由核心每 tick 算一次（ADR-0006），渲染层不自己投射视线：判定与画面因此指着
   * 同一块方块，绝不会出现「框在这块、挖的是那块」。
   */
  private updateSelection(): void {
    const { target, progress } = this.core.mining;
    this.selectionBox.visible = target !== undefined;
    this.crackBox.visible = false;
    if (!target) return;

    // 选框以自己的中心为原点，套住的范围由方块决定：火把只套细杆。
    const { min, max } = selectionBounds(
      this.core.getBlock(target.x, target.y, target.z),
      target.x,
      target.y,
      target.z,
    );
    this.selectionBox.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    this.selectionBox.scale.set(
      max.x - min.x + SELECTION_PAD,
      max.y - min.y + SELECTION_PAD,
      max.z - min.z + SELECTION_PAD,
    );
    const stage = crackStage(progress);
    if (stage === undefined) return;

    // 裂纹贴在整格外壳上，以那一格的中心为原点。火把按下即碎，出不了裂纹。
    this.crackTexture.offset.x = stage / CRACK_STAGES;
    this.crackBox.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    this.crackBox.visible = true;
  }

  /**
   * 把连锁预览的轮廓摆到那些会一起碎掉的方块上（见 CONTEXT.md 的「连锁预览」）。
   *
   * 哪些方块由核心每 tick 给出（`MiningView.chainPreview`），渲染层不自己走一遍连通
   * 搜索——与选框同一条理由（ADR-0006）：预览与真碎掉的那批必须是同一个答案。
   */
  private updateChainPreview(): void {
    const preview = this.core.mining.chainPreview;
    while (this.chainPreviewBoxes.length < preview.length) {
      const box = new THREE.LineSegments(this.chainPreviewGeometry, this.chainPreviewMaterial);
      this.scene.add(box);
      this.chainPreviewBoxes.push(box);
    }
    for (const [index, box] of this.chainPreviewBoxes.entries()) {
      const cell = preview[index];
      box.visible = cell !== undefined;
      // 方块坐标是它的最小角，轮廓以自己的中心为原点。
      if (cell) box.position.set(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
    }
  }

  /**
   * 把相机摆到玩家眼睛的位置。
   *
   * 核心按 20 tick/s 走，直接读当前位置画面就会以 20Hz 一格格地抖，所以位置在上一个
   * tick 与当前 tick 之间插值（ADR-0002）。视角不插值：它已经是即时值，再平滑一次
   * 反而给瞄准加延迟（ADR-0004）。
   */
  private updateCamera(alpha: number): void {
    const { position, previousPosition, yaw, pitch } = this.core.player;
    this.camera.position.set(
      lerp(previousPosition.x, position.x, alpha),
      lerp(previousPosition.y, position.y, alpha) + PLAYER_EYE_HEIGHT,
      lerp(previousPosition.z, position.z, alpha),
    );
    this.camera.rotation.set(pitch, yaw, 0);
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.handCamera.aspect = this.camera.aspect;
    this.handCamera.updateProjectionMatrix();
    // 手持方块的横向偏移跟着宽高比走，尺寸一变就得重算。
    this.placeHeldItem();
  }
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/**
 * 一个方块外壳摆在哪一格：外壳以方块中心为原点，而方块坐标是它的最小角。连锁预览的轮廓用它；
 * 选框套的可能是火把细杆，中心不在格中心，按中心取整（`selection`）。
 */
function blockOf(position: THREE.Vector3): Vec3 {
  return { x: position.x - 0.5, y: position.y - 0.5, z: position.z - 0.5 };
}

/**
 * 一个实体这一帧该画在哪：位置在上一个 tick 与当前 tick 之间插值（ADR-0002），
 * 再把碰撞箱底面抬到小方块的中心——核心报的是底面中心，场景对象以自己的中心为原点。
 */
function entityCenter(
  entity: { readonly position: Vec3; readonly previousPosition: Vec3 },
  alpha: number,
  size: number,
): THREE.Vector3 {
  const { position, previousPosition } = entity;
  return new THREE.Vector3(
    lerp(previousPosition.x, position.x, alpha),
    lerp(previousPosition.y, position.y, alpha) + size / 2,
    lerp(previousPosition.z, position.z, alpha),
  );
}

/**
 * 选框、裂纹与粒子的绘制顺序：在半透明的区块网格（水与冰，#83）之后画。它们与水、冰都在 three 的透明列表里，
 * 列表先按 `renderOrder` 排，再按到相机的远近。只按远近排的话，挖冰时裂纹可能先画、再叠上冰的颜色；
 * 粒子的几何是原点上的一张四边形，按它排出来的先后与粒子实际的位置无关。
 */
const OVERLAY_RENDER_ORDER = 1;

/**
 * 太阳或月亮那张方片：摆在绕转那一层的 +X（`side` 为 1）或 −X（`side` 为 −1）上，正面朝向
 * 那一层的原点，也就是相机。
 *
 * 它排在世界那一遍的最前面画（`renderOrder` 为负），且不参与深度：地形随后画上来，总是盖住它。
 * 靠距离排前后不可靠——从世界底部望向视距边缘的高处，那里的方块比 `CELESTIAL_DISTANCE` 还远。
 */
function celestialQuad(tile: number, material: THREE.Material, side: 1 | -1): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(CELESTIAL_SIZE, CELESTIAL_SIZE);
  geometry.setAttribute('uv', new THREE.BufferAttribute(tileQuadUvs(tile), 2));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.position.set(side * CELESTIAL_DISTANCE, 0, 0);
  // PlaneGeometry 的正面朝 +Z，绕 y 轴转 ∓90° 后朝向 ∓X，正对原点。
  mesh.rotation.y = (-side * Math.PI) / 2;
  return mesh;
}

/**
 * 粒子共用的那张四边形：边长 1、以原点为中心，每个粒子一个实例。五个实例属性直接用粒子池的数组
 * （`ParticlePool`）：池子改了数组，渲染层只需标记要上传的范围，不另复制一份。
 */
function particleGeometry({ pool }: ParticleSystem): THREE.InstancedBufferGeometry {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));
  const instanced = (array: Float32Array, itemSize: number) =>
    new THREE.InstancedBufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('instanceOffset', instanced(pool.positions, 3));
  geometry.setAttribute('instanceSize', instanced(pool.sizes, 1));
  geometry.setAttribute('instanceUv', instanced(pool.uvRects, 4));
  geometry.setAttribute('instanceLight', instanced(pool.lights, 2));
  geometry.setAttribute('instanceAlpha', instanced(pool.alphas, 1));
  geometry.instanceCount = 0;
  return geometry;
}
