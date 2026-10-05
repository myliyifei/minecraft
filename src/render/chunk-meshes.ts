import * as THREE from 'three';
import { CHUNK_SIZE } from '../core/constants';
import { chunkKey, type ChunkCoord } from '../core/world';
import { meshTiles, type ChunkMeshData, type GlowingBlock, type MeshData } from './mesh';

/** 区块网格两部分各自的材质，所有区块共用。 */
export interface ChunkMaterials {
  readonly opaque: THREE.Material;
  readonly translucent: THREE.Material;
}

/** 一个建过网格的区块：两部分各一个场景对象，一个面都没有的那一部分不建对象。 */
interface ChunkEntry extends ChunkCoord {
  readonly opaque?: THREE.Mesh;
  readonly translucent?: THREE.Mesh;
  /** 网格构建时顺带记下的发光方块，粒子从这里冒（`ChunkMeshData.glowingBlocks`）。 */
  readonly glowingBlocks: readonly GlowingBlock[];
}

/**
 * 场景里的区块网格（#83）：每个区块两份几何，不透明部分与半透明部分（水与冰），分别建、拆、释放，
 * 调试读回（顶点数、贴图格）两部分合计。渲染器（`WorldRenderer`）把区块网格进出场景的事都交给它；
 * 它只依赖 three，不依赖 WebGL，所以能在 Node 里测。
 *
 * 一个面都没有的区块（整块空气）也记为建过，只是不往场景里放东西：不记的话 `planChunkMeshes` 每帧都会重新提议它，
 * 这一帧的建网格预算就一直被它占着。只有水的区块不算空：它有半透明部分。
 */
export class ChunkMeshes {
  // 值里带上区块坐标：排网格计划要遍历已有网格是哪些区块，键是打包过的数字，反解麻烦。
  private readonly entries = new Map<number, ChunkEntry>();

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly materials: ChunkMaterials,
  ) {}

  /** 建或换掉这个区块的网格：旧的两份几何从场景移除并释放，新的两部分里有面的才往场景里放。 */
  set(cx: number, cz: number, data: ChunkMeshData): void {
    this.drop(cx, cz);
    this.entries.set(chunkKey(cx, cz), {
      cx,
      cz,
      opaque: this.place(cx, cz, data.opaque, this.materials.opaque),
      translucent: this.place(cx, cz, data.translucent, this.materials.translucent),
      glowingBlocks: data.glowingBlocks,
    });
  }

  /** 拆掉这个区块的网格：两份几何都从场景移除并释放。没建过时什么都不做。 */
  drop(cx: number, cz: number): void {
    for (const mesh of this.partsOf(cx, cz)) {
      this.parent.remove(mesh);
      mesh.geometry.dispose();
    }
    this.entries.delete(chunkKey(cx, cz));
  }

  /** 这个区块的网格建过没有（含一个面都没有的那些）。 */
  has(cx: number, cz: number): boolean {
    return this.entries.has(chunkKey(cx, cz));
  }

  /** 建过网格的区块数（含一个面都没有的那些）。 */
  get size(): number {
    return this.entries.size;
  }

  /** 建过网格的区块，按建的先后。 */
  coords(): IterableIterator<ChunkCoord> {
    return this.entries.values();
  }

  /** 所有建过网格的区块里的发光方块。 */
  *glowingBlocks(): Generator<GlowingBlock> {
    for (const { glowingBlocks } of this.entries.values()) yield* glowingBlocks;
  }

  /** 这个区块两部分合计的顶点数。没建过、或者一个面都没有时是 0。 */
  vertexCount(cx: number, cz: number): number {
    let count = 0;
    for (const mesh of this.partsOf(cx, cz)) count += mesh.geometry.getAttribute('position').count;
    return count;
  }

  /** 这个区块两部分合计用到了哪些贴图格号，升序。没建过、或者一个面都没有时是空数组。 */
  tiles(cx: number, cz: number): number[] {
    const tiles = new Set<number>();
    for (const mesh of this.partsOf(cx, cz)) {
      for (const tile of meshTiles(mesh.geometry.getAttribute('uv').array)) tiles.add(tile);
    }
    return [...tiles].sort((a, b) => a - b);
  }

  private partsOf(cx: number, cz: number): THREE.Mesh[] {
    const entry = this.entries.get(chunkKey(cx, cz));
    if (!entry) return [];
    return [entry.opaque, entry.translucent].filter((mesh): mesh is THREE.Mesh => mesh !== undefined);
  }

  /** 一部分几何放进场景，摆到区块的位置上。一个面都没有时不建对象。 */
  private place(cx: number, cz: number, data: MeshData, material: THREE.Material): THREE.Mesh | undefined {
    if (data.indices.length === 0) return undefined;
    const mesh = new THREE.Mesh(toGeometry(data), material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.parent.add(mesh);
    return mesh;
  }
}

function toGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute('light', new THREE.BufferAttribute(data.light, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
