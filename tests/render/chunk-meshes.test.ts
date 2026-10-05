import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockType } from '../../src/core/block';
import { Chunk } from '../../src/core/chunk';
import { CHUNK_SIZE } from '../../src/core/constants';
import { TILE } from '../../src/render/atlas';
import { ChunkMeshes } from '../../src/render/chunk-meshes';
import { buildChunkMesh, type ChunkMeshData, type MeshView } from '../../src/render/mesh';
import { FLAT_GROUND_Y } from '../helpers/flat-terrain';

/**
 * #83：每个区块的网格分成不透明与半透明两份几何，分别建立、移除、释放；判断空网格与调试读回（顶点数、贴图格）都覆盖两部分。
 * 渲染器本身要 WebGL 上下文，Node 里建不出来；区块网格进出场景的那一段在 `ChunkMeshes` 里，渲染器委托给它。
 */

const air: MeshView = {
  getBlock: () => BlockType.Air,
  skyLightAt: () => 0,
  blockLightAt: () => 0,
  chunkAt: () => undefined,
};

const Y = FLAT_GROUND_Y + 4;

/** 区块 (cx, cz) 里只有给出的这些格（局部坐标）的网格。 */
function meshWith(cells: Array<[number, number, number, BlockType]>, cx = 0, cz = 0): ChunkMeshData {
  const chunk = new Chunk(cx, cz);
  for (const [x, y, z, block] of cells) chunk.set(x, y, z, block);
  return buildChunkMesh(chunk, air);
}

const opaqueMaterial = new THREE.MeshBasicMaterial();
const translucentMaterial = new THREE.MeshBasicMaterial({ transparent: true });

function setup(): { scene: THREE.Scene; meshes: ChunkMeshes } {
  const scene = new THREE.Scene();
  const meshes = new ChunkMeshes(scene, { opaque: opaqueMaterial, translucent: translucentMaterial });
  return { scene, meshes };
}

function sceneMeshes(scene: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) found.push(object);
  });
  return found;
}

/** 记下这些几何体各自有没有被释放。 */
function watchDisposal(meshes: readonly THREE.Mesh[]): () => boolean[] {
  const disposed = meshes.map(() => false);
  meshes.forEach((mesh, i) => mesh.geometry.addEventListener('dispose', () => (disposed[i] = true)));
  return () => [...disposed];
}

describe('区块网格进出场景：两份几何（#83）', () => {
  it('有石头也有水的区块：场景里一份用不透明材质、一份用半透明材质，都放在区块的位置上', () => {
    const { scene, meshes } = setup();
    meshes.set(2, -3, meshWith([[8, Y, 8, BlockType.Stone], [3, Y, 3, BlockType.Water]], 2, -3));
    const placed = sceneMeshes(scene);
    expect(placed).toHaveLength(2);
    expect(new Set(placed.map((mesh) => mesh.material))).toEqual(new Set([opaqueMaterial, translucentMaterial]));
    for (const mesh of placed) {
      expect(mesh.position.toArray()).toEqual([2 * CHUNK_SIZE, 0, -3 * CHUNK_SIZE]);
    }
  });

  it('只有水的区块不当成空网格：建过，场景里有一份半透明的几何，顶点数与贴图格都读得到', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Water]]));
    expect(meshes.has(0, 0)).toBe(true);
    const placed = sceneMeshes(scene);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.material).toBe(translucentMaterial);
    // 悬空一格水：六个面加顶面的背面
    expect(meshes.vertexCount(0, 0)).toBe(7 * 4);
    expect(meshes.tiles(0, 0)).toEqual([TILE.water]);
  });

  it('只有石头的区块：场景里只有一份不透明的几何', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Stone]]));
    const placed = sceneMeshes(scene);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.material).toBe(opaqueMaterial);
    expect(meshes.vertexCount(0, 0)).toBe(6 * 4);
  });

  it('整块空气：记为建过，场景里不放东西，顶点数 0、贴图格为空', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([]));
    expect(meshes.has(0, 0)).toBe(true);
    expect(sceneMeshes(scene)).toEqual([]);
    expect(meshes.vertexCount(0, 0)).toBe(0);
    expect(meshes.tiles(0, 0)).toEqual([]);
  });

  it('调试读回覆盖两部分：顶点数是两部分之和，贴图格是两部分的并集、升序', () => {
    const { meshes } = setup();
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Stone], [3, Y, 3, BlockType.Water], [12, Y, 12, BlockType.Ice]]));
    // 石头 6 面，水与冰各 7 面（顶面正反两面）
    expect(meshes.vertexCount(0, 0)).toBe((6 + 7 + 7) * 4);
    expect(meshes.tiles(0, 0)).toEqual([TILE.stone, TILE.water, TILE.ice].sort((a, b) => a - b));
  });

  it('没建过的区块：没有、顶点数 0、贴图格为空', () => {
    const { meshes } = setup();
    expect(meshes.has(5, 5)).toBe(false);
    expect(meshes.vertexCount(5, 5)).toBe(0);
    expect(meshes.tiles(5, 5)).toEqual([]);
  });

  it('区块卸载时两份几何都从场景移除并释放', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Stone], [3, Y, 3, BlockType.Water]]));
    const placed = sceneMeshes(scene);
    expect(placed).toHaveLength(2);
    const disposed = watchDisposal(placed);

    meshes.drop(0, 0);
    expect(disposed()).toEqual([true, true]);
    expect(sceneMeshes(scene)).toEqual([]);
    expect(meshes.has(0, 0)).toBe(false);
    expect(meshes.vertexCount(0, 0)).toBe(0);
  });

  it('重建换掉旧网格：旧的两份几何都释放，场景里只剩新的', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Stone], [3, Y, 3, BlockType.Water]]));
    const old = sceneMeshes(scene);
    const disposed = watchDisposal(old);

    // 水挖掉了：新网格只有不透明部分
    meshes.set(0, 0, meshWith([[8, Y, 8, BlockType.Stone]]));
    expect(disposed()).toEqual([true, true]);
    const now = sceneMeshes(scene);
    expect(now).toHaveLength(1);
    expect(old).not.toContain(now[0]);
    expect(meshes.tiles(0, 0)).toEqual([TILE.stone]);
  });

  it('移除一个区块的网格不影响别的区块', () => {
    const { scene, meshes } = setup();
    meshes.set(0, 0, meshWith([[3, Y, 3, BlockType.Water]]));
    meshes.set(1, 0, meshWith([[3, Y, 3, BlockType.Water]], 1, 0));
    meshes.drop(0, 0);
    expect(meshes.has(1, 0)).toBe(true);
    expect(sceneMeshes(scene)).toHaveLength(1);
    expect(meshes.vertexCount(1, 0)).toBe(7 * 4);
  });

  it('移除没建过的区块的网格什么都不做', () => {
    const { scene, meshes } = setup();
    expect(() => meshes.drop(9, 9)).not.toThrow();
    expect(sceneMeshes(scene)).toEqual([]);
  });
});
