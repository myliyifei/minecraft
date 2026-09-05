import * as THREE from 'three';
import { DEBUG_BUILD } from '../build-flags';
import type { GameCore } from '../core/game';
import { CHUNK_SIZE } from '../core/constants';
import { ATLAS_PATH } from './atlas';
import { buildChunkMesh, type MeshData } from './mesh';
import { chunkKey } from '../core/world';

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
 * 相机在本切片是固定的——第一人称移动见 issue #4。
 */
export class WorldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly material: THREE.Material;
  private readonly core: GameCore;
  private readonly meshes = new Map<number, THREE.Mesh>();

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

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
    const spawn = core.spawnPoint;
    this.camera.position.set(spawn.x + 9, spawn.y + 6, spawn.z + 15);
    this.camera.lookAt(spawn.x, spawn.y, spawn.z);

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

  /** 为所有已加载区块建网格。空网格（全空气的区块）不进场景。 */
  buildAllChunks(): void {
    for (const { cx, cz } of this.core.loadedChunks()) {
      this.rebuildChunk(cx, cz);
    }
  }

  rebuildChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const existing = this.meshes.get(key);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      this.meshes.delete(key);
    }

    const data = buildChunkMesh(this.core, cx, cz);
    if (data.indices.length === 0) return;

    const mesh = new THREE.Mesh(toGeometry(data), this.material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
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

function toGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
