import * as THREE from 'three';
import { DEBUG_BUILD } from '../build-flags';
import type { GameCore } from '../core/game';
import { CHUNK_SIZE } from '../core/constants';
import { PLAYER_EYE_HEIGHT } from '../core/player';
import type { Vec3 } from '../core/vec3';
import { CRACK_STAGES, crackStage } from './atlas';
import { buildChunkMesh, type MeshData } from './mesh';
import { MESH_BUDGET_PER_FRAME, planChunkMeshes, staleChunksFor } from './mesh-plan';
import { chunkKey, type ChunkCoord } from '../core/world';

/** 竖直视场角（度）。 */
const FIELD_OF_VIEW = 70;

/**
 * 选框与裂纹这两个方块外壳比方块本身大一点（方块）。
 *
 * 正好等于 1 会与方块表面共面，深度测试分不出前后，画面上就是一片闪烁的斑点。
 * 撑出这么一丝，两者都稳稳地浮在表面外侧，而这个量在屏幕上看不出来。
 */
const BLOCK_SHELL = 1.004;

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
 * 场景里的东西，而不是渲染层自己记的一笔账。
 */
export interface SelectionView {
  /** 选框套在哪个方块上（方块坐标），没有目标时 undefined。 */
  readonly target?: Vec3;
  /** 裂纹阶（0 到 CRACK_STAGES−1），没画裂纹时 undefined。 */
  readonly crackStage?: number;
}

/**
 * 渲染适配器：把核心的方块数据画成 Three.js 场景。
 *
 * 相机是第一人称的：跟着核心里的玩家走，位置在两次 tick 之间插值（ADR-0002）。
 * 游戏状态一概只读——唯一往核心里写的是 `takeChangedBlocks()`，取走的是「哪些方块变过」
 * 这本待办账，不是世界本身。
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
  /** 贴在目标方块表面的裂纹。 */
  private readonly crackBox: THREE.Mesh;
  private readonly crackTexture: THREE.Texture;

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

    this.camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 1000);
    // YXZ：先偏航再俯仰，第一人称相机因此永远不会侧倾。
    this.camera.rotation.order = 'YXZ';
    this.updateCamera(1);

    // 固定光照：环境光打底，方向光让方块的六个面有明暗区分（本切片不做天光）。
    // 两者的比例决定体积感——环境光太强，六个面的明暗差别就没了，方块看上去是平的。
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.05));
    const sun = new THREE.DirectionalLight(0xffffff, 1.45);
    sun.position.set(0.5, 1, 0.28);
    this.scene.add(sun);

    const shell = new THREE.BoxGeometry(BLOCK_SHELL, BLOCK_SHELL, BLOCK_SHELL);
    this.selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(shell),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }),
    );
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

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
    if (!this.selectionBox.visible) return {};
    const { x, y, z } = this.selectionBox.position;
    return {
      // 两个外壳都摆在方块中心，方块坐标是它的最小角。
      target: { x: x - 0.5, y: y - 0.5, z: z - 0.5 },
      crackStage: this.crackBox.visible
        ? Math.round(this.crackTexture.offset.x * CRACK_STAGES)
        : undefined,
    };
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
    // 它得等四邻齐全（见 planChunkMeshes），这里插一手会绕过那条规则。
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
   * 一个面都没有的区块（整块空气）仍然要记进账里，只是不往场景里放东西：不记账的话
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
    this.renderer.render(this.scene, this.camera);
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

function toGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
