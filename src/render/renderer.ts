import * as THREE from 'three';
import { DEBUG_BUILD } from '../build-flags';
import type { GameCore } from '../core/game';
import { CHUNK_SIZE } from '../core/constants';
import { PLAYER_EYE_HEIGHT } from '../core/player';
import type { Vec3 } from '../core/vec3';
import { ATLAS_PATH } from './atlas';
import { buildChunkMesh, type MeshData } from './mesh';
import { planChunkMeshes } from './mesh-plan';
import { chunkKey, type ChunkCoord } from '../core/world';

/** 竖直视场角（度）。 */
const FIELD_OF_VIEW = 70;

/**
 * 一帧最多建几个区块的网格。
 *
 * 建一个区块的网格实测 1.3–1.6ms（桌面 Chrome，Node 里 4ms），两个加上这一帧本身的
 * 绘制仍在 60fps 的 16ms 预算里。玩家跨过一条区块边界时要补一整列区块（视距 8 是
 * 17 个），全挤在一帧里就是一次看得见的卡顿；摊到几十帧里则完全看不出来——走一格
 * 区块要 3.7 秒，有两百多帧可用。
 */
export const MESH_BUDGET_PER_FRAME = 2;

/**
 * 加载方块图集。像素风必须用 Nearest 过滤且不生成 mipmap，否则贴图会被糊掉、
 * 相邻格之间还会互相渗色。
 */
export async function loadAtlasTexture(): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(ATLAS_PATH);
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
  readonly texture: THREE.Texture;
}

/**
 * 渲染适配器：把核心的方块数据画成 Three.js 场景。只读核心状态，不改核心状态。
 *
 * 相机是第一人称的：跟着核心里的玩家走，位置在两次 tick 之间插值（ADR-0002）。
 */
export class WorldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly material: THREE.Material;
  private readonly core: GameCore;
  // 值里带上区块坐标：排网格计划要遍历已有网格是哪些区块，键是打包过的数字，反解麻烦。
  private readonly meshes = new Map<number, ChunkMesh>();

  constructor({ canvas, core, texture }: WorldRendererOptions) {
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
    // 两者的比例决定体积感——环境光太强，方块就摊平成一张色卡。
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.05));
    const sun = new THREE.DirectionalLight(0xffffff, 1.45);
    sun.position.set(0.5, 1, 0.28);
    this.scene.add(sun);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** 已建成网格的区块数。 */
  get chunkMeshCount(): number {
    return this.meshes.size;
  }

  /** 这个区块在场景里有没有网格。 */
  hasChunkMesh(cx: number, cz: number): boolean {
    return this.meshes.has(chunkKey(cx, cz));
  }

  /** 相机当前的位置。端到端测试用它确认相机真的跟在玩家眼睛上。 */
  get cameraPosition(): Vec3 {
    const { x, y, z } = this.camera.position;
    return { x, y, z };
  }

  /**
   * 让场景里的网格跟上核心的已加载区块：卸载掉的区块移除网格，新到位的区块建网格。
   *
   * 每帧调一次。一帧最多建 `budget` 个区块的网格，剩下的留到下一帧——哪些该建、
   * 先建哪个由 `planChunkMeshes` 决定。`budget` 给 Infinity 表示「现在全部建完」，
   * 首帧之前用它把出生点那一带一次铺好。
   */
  syncChunkMeshes(budget = MESH_BUDGET_PER_FRAME): void {
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

  /** 重建一个区块的网格。方块被挖掉或放下之后用它（issue #7、#8）。 */
  rebuildChunk(cx: number, cz: number): void {
    this.dropChunkMesh(cx, cz);
    this.buildChunk(cx, cz);
  }

  /** 建一个区块的网格。空网格（全空气的区块）不进场景。 */
  private buildChunk(cx: number, cz: number): void {
    const chunk = this.core.chunkAt(cx, cz);
    if (!chunk) return;

    const data = buildChunkMesh(chunk, this.core);
    if (data.indices.length === 0) return;

    const mesh = new THREE.Mesh(toGeometry(data), this.material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.scene.add(mesh);
    this.meshes.set(chunkKey(cx, cz), { cx, cz, mesh });
  }

  private dropChunkMesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const existing = this.meshes.get(key);
    if (!existing) return;
    this.scene.remove(existing.mesh);
    existing.mesh.geometry.dispose();
    this.meshes.delete(key);
  }

  /**
   * 画一帧。
   * `alpha` 是当前帧落在上一个 tick 与下一个 tick 之间的比例（0..1），相机位置按它插值。
   */
  render(alpha = 1): void {
    this.updateCamera(alpha);
    this.renderer.render(this.scene, this.camera);
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

/** 场景里一个区块的网格，连同它是哪个区块。 */
interface ChunkMesh extends ChunkCoord {
  readonly mesh: THREE.Mesh;
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
