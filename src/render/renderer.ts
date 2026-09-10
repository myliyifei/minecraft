import * as THREE from 'three';
import { DEBUG_BUILD } from '../build-flags';
import type { GameCore } from '../core/game';
import { CHUNK_SIZE } from '../core/constants';
import { DROP_SIZE } from '../core/drop';
import type { ItemType } from '../core/item';
import { PLAYER_EYE_HEIGHT } from '../core/player';
import type { Vec3 } from '../core/vec3';
import { XP_ORB_SIZE } from '../core/xp-orb';
import { CRACK_STAGES, crackStage, itemCubeUvs } from './atlas';
import { dropBob, dropSpin } from './drop-motion';
import { buildChunkMesh, type MeshData } from './mesh';
import { MESH_BUDGET_PER_FRAME, planChunkMeshes, staleChunksFor } from './mesh-plan';
import { chunkKey, type ChunkCoord } from '../core/world';

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
 * 手持方块的姿态（弧度）。
 * 转一点，玩家看到的是三个面而不是正对的一面——正对的一面读起来是一张平贴图。
 */
const HELD_ITEM_TILT = { x: 0.32, y: -0.72, z: 0.12 } as const;

/**
 * 固定光照：环境光打底，方向光让方块的六个面有明暗区分（本切片不做天光）。
 * 两者的比例决定体积感——环境光太强，六个面的明暗差别就没了，方块看上去是平的。
 *
 * 世界与手持各挂一份（两遍渲染，见 `render`）。手持那一份让它的明暗不随玩家转头变化，
 * 与原版一致：手上那块方块不该因为背对太阳就黑下去。
 */
function addFixedLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0xffffff, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.45);
  sun.position.set(0.5, 1, 0.28);
  scene.add(sun);
}

/**
 * 选框与裂纹这两个方块外壳比方块本身大一点（方块）。
 *
 * 正好等于 1 会与方块表面共面，深度测试分不出前后，画面上就是一片闪烁的斑点。
 * 放大这么一点，两者就都稳稳地浮在表面外侧，而这个量在屏幕上看不出来。
 */
const BLOCK_SHELL = 1.004;

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

export interface WorldRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly core: GameCore;
  /** 方块图集。 */
  readonly texture: THREE.Texture;
  /** 裂纹条（见 `CRACK_PATH`）。渲染层会改它的 uv 偏移来切换裂纹阶。 */
  readonly crackTexture: THREE.Texture;
}

/**
 * 场景里那套选框与裂纹现在是什么样。
 *
 * 直接从场景里那两个对象读出来，不另存一份：端到端测试拿它下断言时，验的是真的摆在
 * 场景里的东西，而不是渲染层另存的一份副本。
 */
export interface SelectionView {
  /** 选框套在哪个方块上（方块坐标），没有目标时 undefined。 */
  readonly target?: Vec3;
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
 * 手持方块现在的样子。与上面几个一样直接从场景对象上读。
 * 空手时没有这个视图（`WorldRenderer.heldItem` 返回 undefined）。
 */
export interface HeldItemRenderView {
  /** 手上那种物品。 */
  readonly item: ItemType;
  /** 小方块中心投在画布上的位置（归一化设备坐标，x 右为正、y 上为正）。 */
  readonly screen: { readonly x: number; readonly y: number };
}

/**
 * 渲染适配器：把核心的方块数据画成 Three.js 场景。
 *
 * 相机是第一人称的：跟着核心里的玩家走，位置在两次 tick 之间插值（ADR-0002）。
 * 游戏状态一概只读——唯一往核心里写的是 `takeChangedBlocks()`，它取走的是「哪些方块变过」
 * 这份待处理记录，不是世界本身。
 */
export class WorldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly material: THREE.Material;
  private readonly core: GameCore;
  // 值里带上区块坐标：排网格计划要遍历已有网格是哪些区块，键是打包过的数字，反解麻烦。
  private readonly meshes = new Map<number, ChunkMesh>();
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
  /** 手上那块方块。空手时还在场景里，只是 `visible` 为 false。 */
  private heldItemMesh: THREE.Mesh | undefined;
  /** 现在画的是哪种物品。与核心的手持不同就换几何体。 */
  private heldItemType: ItemType | undefined;
  /** 场景里的经验球小方块，按核心给的编号索引。与掉落物同一套做法，见 ADR-0007。 */
  private readonly xpOrbMeshes = new Map<number, THREE.Mesh>();
  /** 经验球的几何体与材质：所有经验球长得一样，各建一份共用就够。 */
  private readonly xpOrbGeometry = new THREE.BoxGeometry(XP_ORB_SIZE, XP_ORB_SIZE, XP_ORB_SIZE);
  private readonly xpOrbMaterial: THREE.Material;

  constructor({ canvas, core, texture, crackTexture }: WorldRendererOptions) {
    this.core = core;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      // 只在开发与测试构建里保留绘制缓冲，好让端到端测试把画布内容读回来判断
      // 是否真画出了东西。生产构建不带这个负担。
      preserveDrawingBuffer: DEBUG_BUILD,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = paletteColor('--sky', '#7fb2e8');
    this.material = new THREE.MeshLambertMaterial({
      map: texture,
      // 树叶贴图有镂空，用 alphaTest 剔掉透明像素，避免半透明排序问题。
      alphaTest: 0.5,
    });

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
    addFixedLights(this.scene);
    addFixedLights(this.handScene);
    // 两遍渲染各自决定清什么，所以关掉自动清屏，见 render()。
    this.renderer.autoClear = false;

    const shell = new THREE.BoxGeometry(BLOCK_SHELL, BLOCK_SHELL, BLOCK_SHELL);
    this.selectionMaterial = new THREE.LineBasicMaterial({
      color: SELECTION_COLOR,
      transparent: true,
      opacity: 0.55,
    });
    this.selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(shell),
      this.selectionMaterial,
    );
    this.selectionBox.visible = false;
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
    this.scene.add(this.crackBox);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** 已经建过网格的区块数（含一个面都没有的那些）。 */
  get chunkMeshCount(): number {
    return this.meshes.size;
  }

  /** 这个区块的网格建过没有。 */
  hasChunkMesh(cx: number, cz: number): boolean {
    return this.meshes.has(chunkKey(cx, cz));
  }

  /** 相机当前的位置。端到端测试用它确认相机真的跟在玩家眼睛上。 */
  get cameraPosition(): Vec3 {
    const { x, y, z } = this.camera.position;
    return { x, y, z };
  }

  /** 上一帧画出来的选框与裂纹。 */
  get selection(): SelectionView {
    const color = this.selectionMaterial.color.getHex();
    if (!this.selectionBox.visible) return { color };
    return {
      target: blockOf(this.selectionBox.position),
      crackStage: this.crackBox.visible
        ? Math.round(this.crackTexture.offset.x * CRACK_STAGES)
        : undefined,
      color,
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
    return { item, screen: { x, y } };
  }

  /** 这个区块的网格有多少个顶点。没建过网格、或者一个面都没有时是 0。 */
  chunkMeshVertexCount(cx: number, cz: number): number {
    const mesh = this.meshes.get(chunkKey(cx, cz))?.mesh;
    return mesh ? mesh.geometry.getAttribute('position').count : 0;
  }

  /**
   * 让场景里的网格跟上核心的已加载区块：卸载掉的区块移除网格，新到位的区块建网格。
   *
   * 每帧调一次。一帧最多建 `budget` 个区块的网格，剩下的留到下一帧——哪些该建、
   * 先建哪个由 `planChunkMeshes` 决定。`budget` 给 Infinity 表示「现在全部建完」，
   * 首帧之前用它把出生点那一带一次铺好。
   */
  syncChunkMeshes(budget = MESH_BUDGET_PER_FRAME): void {
    // 挖掉的方块必须当帧就从画面上消失，所以重建不占这一帧的建网格预算——一次改动最多
    // 牵动三个区块（自己加两个侧向邻居），远小于铺开视距时的积压。还没建过网格的区块跳过：
    // 它得等四邻齐全（见 planChunkMeshes），在这里建会绕过那条规则。
    for (const { cx, cz } of staleChunksFor(this.core.takeChangedBlocks())) {
      if (this.hasChunkMesh(cx, cz)) this.rebuildChunk(cx, cz);
    }

    const plan = planChunkMeshes({
      world: this.core,
      meshed: this.meshes.values(),
      center: this.core.playerChunk,
      radius: this.core.viewRadius,
      budget,
    });
    for (const { cx, cz } of plan.drop) this.dropChunkMesh(cx, cz);
    for (const { cx, cz } of plan.build) this.buildChunk(cx, cz);
  }

  /** 重建一个区块的网格。方块被挖掉或放下之后由 `syncChunkMeshes` 调。 */
  rebuildChunk(cx: number, cz: number): void {
    this.dropChunkMesh(cx, cz);
    this.buildChunk(cx, cz);
  }

  /**
   * 建一个区块的网格。
   *
   * 一个面都没有的区块（整块空气）仍然要记进已建网格的表里，只是不往场景里放东西：不记的话
   * `planChunkMeshes` 每帧都会重新提议它，这一帧的建网格预算就一直被它占着。
   */
  private buildChunk(cx: number, cz: number): void {
    const chunk = this.core.chunkAt(cx, cz);
    if (!chunk) return;

    const data = buildChunkMesh(chunk, this.core);
    if (data.indices.length === 0) {
      this.meshes.set(chunkKey(cx, cz), { cx, cz });
      return;
    }

    const mesh = new THREE.Mesh(toGeometry(data), this.material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.scene.add(mesh);
    this.meshes.set(chunkKey(cx, cz), { cx, cz, mesh });
  }

  private dropChunkMesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const existing = this.meshes.get(key);
    if (!existing) return;
    if (existing.mesh) {
      this.scene.remove(existing.mesh);
      existing.mesh.geometry.dispose();
    }
    this.meshes.delete(key);
  }

  /**
   * 画一帧。
   * `alpha` 是当前帧落在上一个 tick 与下一个 tick 之间的比例（0..1），相机位置按它插值。
   */
  render(alpha = 1): void {
    this.updateCamera(alpha);
    this.updateSelection();
    this.updateChainPreview();
    this.updateDrops(alpha);
    this.updateXpOrbs(alpha);
    this.updateHeldItem();

    // 两遍：先画世界，再把深度清掉画手上那块方块。深度一清，手持就永远在世界前面，
    // 贴着墙站着也不会被墙切穿（`handScene` 的注释里记了为什么不能挂在主相机下）。
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.handScene, this.handCamera);
  }

  /**
   * 让右下角那块手持方块跟上核心里的手持物品（`InventoryView.held`）。
   *
   * 手持是核心的状态，第一人称里的那块方块纯粹是它的表现——摆在哪儿、转多少度都在
   * 这个文件里，核心不知道画面上有这么一块东西（与掉落物同一套分工，见 ADR-0007）。
   * 只在物品换了的时候动几何体，其余帧一个属性都不碰。
   */
  private updateHeldItem(): void {
    const item = this.core.inventory.held?.item;
    if (item === this.heldItemType) return;
    this.heldItemType = item;

    if (item === undefined) {
      if (this.heldItemMesh) this.heldItemMesh.visible = false;
      return;
    }

    if (!this.heldItemMesh) {
      const mesh = this.itemMesh(item, HELD_ITEM_SIZE);
      mesh.rotation.set(HELD_ITEM_TILT.x, HELD_ITEM_TILT.y, HELD_ITEM_TILT.z);
      this.handAnchor.add(mesh);
      this.heldItemMesh = mesh;
    }
    this.heldItemMesh.geometry = this.itemGeometry(item);
    this.heldItemMesh.visible = true;
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
   */
  private updateDrops(alpha: number): void {
    this.syncEntityMeshes(
      this.core.drops.all(),
      this.dropMeshes,
      (drop) => this.itemMesh(drop.item, DROP_SIZE),
      (mesh, drop) => {
        const phase = drop.age + alpha;
        mesh.position.copy(entityCenter(drop, alpha, DROP_SIZE));
        mesh.position.y += dropBob(phase);
        mesh.rotation.y = dropSpin(phase);
      },
    );
  }

  /**
   * 让场景里的小方块跟上核心里的经验球。
   *
   * 与掉落物同一套做法（ADR-0007），只是经验球不转也不漂：它一生成就朝玩家飞过来，
   * 几 tick 就没了，转与漂根本看不出来，加上只会让「它在往我这边来」这件事更难看清。
   */
  private updateXpOrbs(alpha: number): void {
    this.syncEntityMeshes(
      this.core.xpOrbs.all(),
      this.xpOrbMeshes,
      () => new THREE.Mesh(this.xpOrbGeometry, this.xpOrbMaterial),
      (mesh, orb) => mesh.position.copy(entityCenter(orb, alpha, XP_ORB_SIZE)),
    );
  }

  /**
   * 让一批场景对象跟上核心里的一批实体：新出现的建好加进场景，消失的移出去，留着的
   * 交给 `place` 摆位。
   *
   * 掉落物与经验球共用这一份：ADR-0007 定的实体同步就是「每帧全量遍历 + 按编号认对象」
   * 这一套，各写一遍迟早有一边忘了从场景里移除。将来的生物也走这里。
   */
  private syncEntityMeshes<T extends { readonly id: number }>(
    entities: readonly T[],
    meshes: Map<number, THREE.Mesh>,
    create: (entity: T) => THREE.Mesh,
    place: (mesh: THREE.Mesh, entity: T) => void,
  ): void {
    const alive = new Set<number>();
    for (const entity of entities) {
      alive.add(entity.id);
      let mesh = meshes.get(entity.id);
      if (!mesh) {
        mesh = create(entity);
        this.scene.add(mesh);
        meshes.set(entity.id, mesh);
      }
      place(mesh, entity);
    }

    for (const [id, mesh] of meshes) {
      if (alive.has(id)) continue;
      this.scene.remove(mesh);
      meshes.delete(id);
    }
  }

  /** 一块某种物品的小方块，边长 `size`。 */
  private itemMesh(item: ItemType, size: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.itemGeometry(item), this.material);
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

    // 方块坐标是它的最小角，两个外壳都以自己的中心为原点。
    this.selectionBox.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    const stage = crackStage(progress);
    if (stage === undefined) return;

    this.crackTexture.offset.x = stage / CRACK_STAGES;
    this.crackBox.position.copy(this.selectionBox.position);
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

/**
 * 一个已经建过网格的区块。
 * `mesh` 缺省表示这个区块一个面都没有（整块空气），场景里没有对应的对象。
 */
interface ChunkMesh extends ChunkCoord {
  readonly mesh?: THREE.Mesh;
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/**
 * 一个方块外壳摆在哪一格：外壳以方块中心为原点，而方块坐标是它的最小角。
 * 选框与连锁预览共用这一步换算，两边不会各减一次 0.5。
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

function toGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
