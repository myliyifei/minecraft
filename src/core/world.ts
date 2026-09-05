import { BlockType, type BlockView } from './block';
import { Chunk } from './chunk';
import { CHUNK_SIZE, WORLD_MAX_Y, WORLD_MIN_Y } from './constants';
import type { TerrainGenerator } from './terrain';

export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
}

/**
 * 已加载区块的集合，按世界坐标读写方块。
 *
 * 未加载的区块视为边界：读到空气，写入被丢弃。这与连锁挖掘「未加载区块视为边界」
 * 的规则一致，也让区块流式加载（issue #5）不必给读写路径加特例。
 */
export class World implements BlockView {
  private readonly chunks = new Map<string, Chunk>();
  private readonly generate: TerrainGenerator;

  constructor(generate: TerrainGenerator) {
    this.generate = generate;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  loadedChunks(): ChunkCoord[] {
    return [...this.chunks.values()].map(({ cx, cz }) => ({ cx, cz }));
  }

  isChunkLoaded(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** 加载区块；已加载则原样返回，不重新生成，玩家的修改因此不会被覆盖。 */
  loadChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    const loaded = this.chunks.get(key);
    if (loaded) return loaded;
    const chunk = this.generate(cx, cz);
    this.chunks.set(key, chunk);
    return chunk;
  }

  /**
   * 卸载区块。
   * 本切片直接丢弃区块数据；把修改过的区块留在内存里以便走远再回来仍是改过的样子，
   * 是 issue #13 的事。
   */
  unloadChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  getBlock(x: number, y: number, z: number): BlockType {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return BlockType.Air;
    return chunk.get(localOf(bx), by, localOf(bz));
  }

  /**
   * 某一列最高的非空气方块的 y。整列都是空气（或区块未加载）时返回 WORLD_MIN_Y − 1。
   */
  highestBlockY(x: number, z: number): number {
    for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
      if (this.getBlock(x, y, z) !== BlockType.Air) return y;
    }
    return WORLD_MIN_Y - 1;
  }

  /** 写入方块；坐标所在区块未加载时不做任何事并返回 false。 */
  setBlock(x: number, y: number, z: number, block: BlockType): boolean {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const chunk = this.chunks.get(chunkKey(chunkOf(bx), chunkOf(bz)));
    if (!chunk) return false;
    chunk.set(localOf(bx), by, localOf(bz), block);
    return true;
  }
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** 世界坐标所属的区块坐标。 */
export function chunkOf(worldCoord: number): number {
  return Math.floor(worldCoord / CHUNK_SIZE);
}

/** 世界坐标在区块内的局部坐标，负坐标也落在 [0, 16)。 */
export function localOf(worldCoord: number): number {
  return worldCoord - chunkOf(worldCoord) * CHUNK_SIZE;
}
