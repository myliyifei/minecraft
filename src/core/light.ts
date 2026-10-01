import { BLOCKS, LightPassage, type BlockType } from './block';
import { BLOCK_LIGHT_MASK, SKY_LIGHT_SHIFT, type Chunk } from './chunk';
import { CHUNK_AREA, CHUNK_SIZE, MAX_LIGHT_LEVEL, WORLD_HEIGHT, WORLD_MIN_Y } from './constants';

/**
 * 天光的计算（见 CONTEXT.md 的「天光」、ADR-0017）：区块加载时算初值，`setBlock` 之后增量更新，
 * 区块卸载时撤掉它传给邻居的光。
 *
 * 每一格的天光是下面这个唯一解：竖直部分（从天空往下，穿过树叶每格减 1，遇不透明方块归 0）与
 * 六个邻格减 1 中的最大值，不透明方块恒为 0。这个值只由已加载区块里的方块决定，与计算顺序无关
 * （ADR-0014），所以三条路径各自只需保证收敛到它：
 *
 * - 加载：先竖直填充，再从「旁边那一列可能更暗」的格子出发做一次减 1 传播，跨进已加载的邻居、
 *   也从邻居的边界格子传进来。
 * - 改方块：按「撤光再补光」——先把可能依赖被改那一格的光撤成 0，记下撤光边界上仍有光的格子，
 *   再从它们与撤掉的格子各自的竖直部分重新传播。
 * - 卸载：把邻居里可能来自这个区块的光撤掉，再补光。
 *
 * 补光按等级分桶，从 15 往下处理：每一格第一次被取出时就是最终值，不会反复改写。
 * 传播在区块数据上直接做下标算术，不走 `World.getBlock`，理由同 `ChunkView`。
 */
export interface LightChunks {
  /** 已加载的区块，未加载则 undefined。传播只走已加载的区块。 */
  chunkAt(cx: number, cz: number): Chunk | undefined;
  /** (cx, cz) 那个区块里有格子的光照变了，或者它读得到的边界格子变了（见 `World.stale`）。 */
  markStale(cx: number, cz: number): void;
}

/** 方块编号 → 透光方式，查表比每格读 `BLOCKS[...]` 再比字符串快。 */
const CLEAR = 0;
const LEAVES = 1;
const OPAQUE = 2;
const PASSAGE = new Uint8Array(256);
for (const [id, def] of Object.entries(BLOCKS)) {
  PASSAGE[Number(id)] =
    def.lightPassage === LightPassage.Opaque ? OPAQUE : def.lightPassage === LightPassage.Leaves ? LEAVES : CLEAR;
}

/** 区块数据里最顶上一层的起始下标。 */
const TOP_LAYER = (WORLD_HEIGHT - 1) * CHUNK_AREA;

/** 六个方向的编号：上、下、+X、−X、+Z、−Z，见 `Lighting.step`。 */
const DIRECTIONS = 6;

/**
 * 区块的四条侧边：往哪边是邻居，以及第 k 对相邻的两列——这一侧的列 `own(k)` 与邻居那一侧的列
 * `other(k)`（都是区块内的列下标 `lz * CHUNK_SIZE + lx`）。
 */
interface Side {
  readonly dx: number;
  readonly dz: number;
  own(k: number): number;
  other(k: number): number;
}

const LAST = CHUNK_SIZE - 1;

const SIDES: readonly Side[] = [
  { dx: 1, dz: 0, own: (k) => k * CHUNK_SIZE + LAST, other: (k) => k * CHUNK_SIZE },
  { dx: -1, dz: 0, own: (k) => k * CHUNK_SIZE, other: (k) => k * CHUNK_SIZE + LAST },
  { dx: 0, dz: 1, own: (k) => LAST * CHUNK_SIZE + k, other: (k) => k },
  { dx: 0, dz: -1, own: (k) => k, other: (k) => LAST * CHUNK_SIZE + k },
];

/** 天光往下经过一格之后还剩多少。 */
function passDown(level: number, passage: number): number {
  if (passage === OPAQUE) return 0;
  if (passage === LEAVES) return level > 0 ? level - 1 : 0;
  return level;
}

function skyAt(chunk: Chunk, i: number): number {
  return chunk.light![i] >> SKY_LIGHT_SHIFT;
}

/** 下标 i 那一格的 y（世界坐标）。 */
function yOf(i: number): number {
  return WORLD_MIN_Y + (i >> 8);
}

/** 第 column 列在 y 那一层的下标。 */
function indexOf(column: number, y: number): number {
  return (y - WORLD_MIN_Y) * CHUNK_AREA + column;
}

export class Lighting {
  /**
   * 传播访问过的格子数，只增不减。工作量测试用它确认平地区块只做竖直填充与一次边界传播
   * （计访问格数，不计时）。
   */
  visits = 0;

  private readonly world: LightChunks;
  /** `step` 走到的那一格的下标，与它返回的区块一起用。省掉每步分配一个结果对象。 */
  private stepIndex = 0;
  /*
   * 下面几组队列都是并行数组（区块、下标、等级各一个），而不是每格一个对象：放一块方块、加载一个
   * 区块要进出成千上万格，每格分配一个对象会让垃圾回收跟着忙。
   */
  /** 补光的桶：下标是等级，每个桶里是待从这个等级往外传的格子。 */
  private readonly bucketChunks: Chunk[][] = [];
  private readonly bucketIndices: number[][] = [];
  /** 撤光的队列：格子与它撤掉之前的等级。 */
  private readonly darkChunks: Chunk[] = [];
  private readonly darkIndices: number[] = [];
  private readonly darkLevels: number[] = [];
  /**
   * 撤掉之后要按竖直部分重新点亮的格子。等级已知（改方块那一列）就记下，否则记 −1，
   * 撤光结束后再按方块算（`verticalAt`）。
   */
  private readonly reseedChunks: Chunk[] = [];
  private readonly reseedIndices: number[] = [];
  private readonly reseedLevels: number[] = [];
  /**
   * 撤光再补光期间写过的格子与它们原来的天光。撤光先写 0、补光又可能写回原值，所以这期间不当场
   * 记过期，结束后只记值真正变了的（`relight`）。不在撤光再补光期间时是 undefined，写一格当场记。
   */
  private touched: Map<Chunk, Map<number, number>> | undefined;

  constructor(world: LightChunks) {
    this.world = world;
    for (let level = 0; level <= MAX_LIGHT_LEVEL; level++) {
      this.bucketChunks.push([]);
      this.bucketIndices.push([]);
    }
  }

  /**
   * 区块刚放进已加载的集合：建光照数组、竖直填充，再与已加载的邻居互相传。
   * 已改区块重新加载也走这里，按方块重算（ADR-0017）。
   *
   * 竖直填充之后，一格只有在旁边那一列可能比它暗 2 级以上时才需要往外传。旁边那一列在它天光
   * 开始变弱的高度（`skyTops`）以上全是 15，所以每一列只从四个邻列里最高的那个高度往下找光源；
   * 平地上这个范围是空的，加载因此只做竖直填充与边界上的一次检查。
   */
  chunkLoaded(chunk: Chunk): void {
    chunk.resetLight();
    const light = chunk.light!;
    const tops = chunk.skyTops!;
    const blocks = chunk.blocks;
    for (let column = 0; column < CHUNK_AREA; column++) {
      let level = MAX_LIGHT_LEVEL;
      let top = WORLD_MIN_Y - 1;
      for (let i = TOP_LAYER + column; i >= 0; i -= CHUNK_AREA) {
        const passage = PASSAGE[blocks[i]];
        if (passage !== CLEAR && top < WORLD_MIN_Y) top = yOf(i);
        level = passDown(level, passage);
        this.visits++;
        // 数组建出来就是 0，往下不必再写。
        if (level === 0) break;
        light[i] = level << SKY_LIGHT_SHIFT;
      }
      tops[column] = top;
    }

    // 本区块里的光源：竖直部分往下只减不增，所以从起点往下找到第一格不够亮的就停。
    for (let column = 0; column < CHUNK_AREA; column++) {
      const lx = column & LAST;
      const lz = column >> 4;
      const start = Math.max(
        this.topAt(chunk, lx + 1, lz),
        this.topAt(chunk, lx - 1, lz),
        this.topAt(chunk, lx, lz + 1),
        this.topAt(chunk, lx, lz - 1),
      );
      for (let y = start; y >= WORLD_MIN_Y; y--) {
        this.visits++;
        const i = indexOf(column, y);
        const level = light[i] >> SKY_LIGHT_SHIFT;
        if (level <= 1) break;
        this.push(chunk, i, level);
      }
    }

    // 邻居边界上的光源：它们那一列可以是任意形状（洞里被照亮的格子），所以一直找到底。
    for (const side of SIDES) {
      const neighbor = this.world.chunkAt(chunk.cx + side.dx, chunk.cz + side.dz);
      if (!neighbor) continue;
      for (let k = 0; k < CHUNK_SIZE; k++) {
        const other = side.other(k);
        for (let y = tops[side.own(k)]; y >= WORLD_MIN_Y; y--) {
          this.visits++;
          const i = indexOf(other, y);
          const level = skyAt(neighbor, i);
          if (level > 1) this.push(neighbor, i, level);
        }
      }
    }
    this.spread();
  }

  /**
   * 区块刚从已加载的集合里拿掉、光照数组还在：撤掉邻居里可能来自它的光，再补光。
   *
   * 邻居边界上比隔壁那格暗的格子都可能是从这个区块传过去的，先当作撤光的起点；更远处依赖它们的
   * 格子由撤光一路撤掉，再由补光恢复。两列都在天光开始变弱的高度以上时都是 15，不必看。
   */
  chunkUnloaded(chunk: Chunk): void {
    const tops = chunk.skyTops!;
    this.touched = new Map();
    for (const side of SIDES) {
      const neighbor = this.world.chunkAt(chunk.cx + side.dx, chunk.cz + side.dz);
      if (!neighbor) continue;
      for (let k = 0; k < CHUNK_SIZE; k++) {
        const own = side.own(k);
        const other = side.other(k);
        const start = Math.max(tops[own], neighbor.skyTops![other]);
        for (let y = start; y >= WORLD_MIN_Y; y--) {
          this.visits++;
          const i = indexOf(other, y);
          const level = skyAt(neighbor, i);
          if (level > 0 && level < skyAt(chunk, indexOf(own, y))) this.darken(neighbor, i, -1);
        }
      }
    }
    this.relight();
  }

  /**
   * (lx, y, lz) 从 previous 换成 block 之后更新天光。由 `World.setBlock` 在写入方块之后调用。
   *
   * 透光方式没变（石头换泥土、熔炉点火）就什么都不做。变了：这一格与它下面竖直部分变了的那一段
   * 是撤光的起点，撤完按新的方块补光。
   */
  blockChanged(chunk: Chunk, lx: number, y: number, lz: number, previous: BlockType, block: BlockType): void {
    const before = PASSAGE[previous];
    const after = PASSAGE[block];
    if (before === after) return;
    const column = lz * CHUNK_SIZE + lx;
    const tops = chunk.skyTops!;
    const changed = indexOf(column, y);
    if (after !== CLEAR) {
      if (y > tops[column]) tops[column] = y;
    } else if (y === tops[column]) {
      tops[column] = this.topBelow(chunk, column, y - 1);
    }

    this.touched = new Map();
    // 上面那一格的竖直部分不受这次改动影响，从它往下按改之前与改之后各算一遍，直到两者重合。
    let oldLevel = this.verticalAt(chunk, column, y + 1);
    let newLevel = oldLevel;
    for (let i = changed; i >= 0; i -= CHUNK_AREA) {
      this.visits++;
      const passage = PASSAGE[chunk.blocks[i]];
      oldLevel = passDown(oldLevel, i === changed ? before : passage);
      newLevel = passDown(newLevel, passage);
      if (i !== changed && oldLevel === newLevel) break;
      this.darken(chunk, i, newLevel);
    }
    this.relight();
  }

  /** 把 (chunk, i) 撤成 0，作为撤光的起点；level 是它的竖直部分，−1 表示撤光后再算。 */
  private darken(chunk: Chunk, i: number, level: number): void {
    const old = skyAt(chunk, i);
    if (old > 0) this.setSky(chunk, i, 0);
    this.darkChunks.push(chunk);
    this.darkIndices.push(i);
    this.darkLevels.push(old);
    this.reseedChunks.push(chunk);
    this.reseedIndices.push(i);
    this.reseedLevels.push(level);
  }

  /**
   * 撤光再补光的后两步。
   *
   * 撤光：从起点往外，比撤掉的那格暗的邻格可能是从它传过去的，一并撤成 0；不比它暗的邻格
   * 有别的来源，记作补光的起点。补光：撤掉的格子先恢复各自的竖直部分，再连同那些起点一起传播。
   */
  private relight(): void {
    for (let head = 0; head < this.darkChunks.length; head++) {
      const chunk = this.darkChunks[head];
      const i = this.darkIndices[head];
      const level = this.darkLevels[head];
      this.visits++;
      for (let direction = 0; direction < DIRECTIONS; direction++) {
        const next = this.step(chunk, i, direction);
        if (!next) continue;
        const j = this.stepIndex;
        const nextLevel = skyAt(next, j);
        if (nextLevel === 0) continue;
        if (nextLevel < level) this.darken(next, j, -1);
        else this.push(next, j, nextLevel);
      }
    }
    this.darkChunks.length = 0;
    this.darkIndices.length = 0;
    this.darkLevels.length = 0;

    for (let k = 0; k < this.reseedChunks.length; k++) {
      const chunk = this.reseedChunks[k];
      const i = this.reseedIndices[k];
      const known = this.reseedLevels[k];
      const level = known >= 0 ? known : this.verticalAt(chunk, i & (CHUNK_AREA - 1), yOf(i));
      if (level > skyAt(chunk, i)) {
        this.setSky(chunk, i, level);
        this.push(chunk, i, level);
      }
    }
    this.reseedChunks.length = 0;
    this.reseedIndices.length = 0;
    this.reseedLevels.length = 0;
    this.spread();

    const touched = this.touched!;
    this.touched = undefined;
    for (const [chunk, cells] of touched) {
      for (const [i, original] of cells) {
        if (skyAt(chunk, i) !== original) this.changed(chunk, i);
      }
    }
  }

  /** 补光：从等级 15 的桶往下，每一格往六个邻格传「自己减 1」，不透明方块不收。 */
  private spread(): void {
    for (let level = MAX_LIGHT_LEVEL; level > 1; level--) {
      const chunks = this.bucketChunks[level];
      const indices = this.bucketIndices[level];
      const nextLevel = level - 1;
      while (chunks.length > 0) {
        const chunk = chunks.pop()!;
        const i = indices.pop()!;
        // 放进桶之后又被撤掉或改亮过的，这一条作废。
        if (skyAt(chunk, i) !== level) continue;
        this.visits++;
        for (let direction = 0; direction < DIRECTIONS; direction++) {
          const next = this.step(chunk, i, direction);
          if (!next) continue;
          const j = this.stepIndex;
          if (PASSAGE[next.blocks[j]] === OPAQUE || skyAt(next, j) >= nextLevel) continue;
          this.setSky(next, j, nextLevel);
          this.push(next, j, nextLevel);
        }
      }
    }
    // 等级 1 及以下传不出去，放进来的也不必留着。
    for (let level = 0; level <= 1; level++) {
      this.bucketChunks[level].length = 0;
      this.bucketIndices[level].length = 0;
    }
  }

  /** 把 (chunk, i) 放进等级 level 的桶，等 `spread` 往外传。 */
  private push(chunk: Chunk, i: number, level: number): void {
    this.bucketChunks[level].push(chunk);
    this.bucketIndices[level].push(i);
  }

  /**
   * 写一格的天光，方块光那几位不动，并记下哪些区块因此过期（`changed`）；撤光再补光期间先记下
   * 原值，结束后再比（见 `touched`）。
   */
  private setSky(chunk: Chunk, i: number, level: number): void {
    const light = chunk.light!;
    if (this.touched) {
      let cells = this.touched.get(chunk);
      if (!cells) this.touched.set(chunk, (cells = new Map()));
      if (!cells.has(i)) cells.set(i, light[i] >> SKY_LIGHT_SHIFT);
    } else {
      this.changed(chunk, i);
    }
    light[i] = (level << SKY_LIGHT_SHIFT) | (light[i] & BLOCK_LIGHT_MASK);
  }

  /**
   * (chunk, i) 的光照变了：它的区块过期；它在区块边缘 1 格内时，含对角在内挨着它的区块也过期——
   * 平滑光照读对角格（见 `World.stale`）。
   */
  private changed(chunk: Chunk, i: number): void {
    const lx = i & LAST;
    const lz = (i >> 4) & LAST;
    const x0 = lx === 0 ? -1 : 0;
    const x1 = lx === LAST ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0;
    const z1 = lz === LAST ? 1 : 0;
    for (let dx = x0; dx <= x1; dx++) {
      for (let dz = z0; dz <= z1; dz++) this.world.markStale(chunk.cx + dx, chunk.cz + dz);
    }
  }

  /**
   * 第 column 列在 y 那一格的竖直部分：从天空往下照到那里还剩多少。世界最高一层之上是 15。
   */
  private verticalAt(chunk: Chunk, column: number, y: number): number {
    const top = chunk.skyTops![column];
    if (y > top) return MAX_LIGHT_LEVEL;
    let level = MAX_LIGHT_LEVEL;
    for (let i = indexOf(column, top); ; i -= CHUNK_AREA) {
      this.visits++;
      level = passDown(level, PASSAGE[chunk.blocks[i]]);
      if (level === 0 || yOf(i) === y) return level;
    }
  }

  /** 第 column 列从 y 往下第一个不是「不衰减」的方块的 y，没有就是 WORLD_MIN_Y − 1。 */
  private topBelow(chunk: Chunk, column: number, y: number): number {
    for (let i = indexOf(column, y); i >= 0; i -= CHUNK_AREA) {
      this.visits++;
      if (PASSAGE[chunk.blocks[i]] !== CLEAR) return yOf(i);
    }
    return WORLD_MIN_Y - 1;
  }

  /**
   * chunk 里 (lx, lz) 那一列天光开始变弱的高度；lx、lz 可以越出一格，读的是邻居区块的那一列。
   * 邻居没加载时它不贡献光，按整列不衰减之外的最低值算。
   */
  private topAt(chunk: Chunk, lx: number, lz: number): number {
    if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      return chunk.skyTops![lz * CHUNK_SIZE + lx];
    }
    const neighbor = this.world.chunkAt(
      chunk.cx + (lx < 0 ? -1 : lx >= CHUNK_SIZE ? 1 : 0),
      chunk.cz + (lz < 0 ? -1 : lz >= CHUNK_SIZE ? 1 : 0),
    );
    if (!neighbor) return WORLD_MIN_Y - 1;
    return neighbor.skyTops![(lz & LAST) * CHUNK_SIZE + (lx & LAST)];
  }

  /**
   * 从 (chunk, i) 往 direction 走一格：返回那一格所在的区块（未加载或出了世界高度时 undefined），
   * 下标写在 `stepIndex`。
   */
  private step(chunk: Chunk, i: number, direction: number): Chunk | undefined {
    const lx = i & LAST;
    const lz = (i >> 4) & LAST;
    switch (direction) {
      case 0:
        if (i >= TOP_LAYER) return undefined;
        this.stepIndex = i + CHUNK_AREA;
        return chunk;
      case 1:
        if (i < CHUNK_AREA) return undefined;
        this.stepIndex = i - CHUNK_AREA;
        return chunk;
      case 2:
        if (lx < LAST) {
          this.stepIndex = i + 1;
          return chunk;
        }
        this.stepIndex = i - LAST;
        return this.world.chunkAt(chunk.cx + 1, chunk.cz);
      case 3:
        if (lx > 0) {
          this.stepIndex = i - 1;
          return chunk;
        }
        this.stepIndex = i + LAST;
        return this.world.chunkAt(chunk.cx - 1, chunk.cz);
      case 4:
        if (lz < LAST) {
          this.stepIndex = i + CHUNK_SIZE;
          return chunk;
        }
        this.stepIndex = i - LAST * CHUNK_SIZE;
        return this.world.chunkAt(chunk.cx, chunk.cz + 1);
      default:
        if (lz > 0) {
          this.stepIndex = i - CHUNK_SIZE;
          return chunk;
        }
        this.stepIndex = i + LAST * CHUNK_SIZE;
        return this.world.chunkAt(chunk.cx, chunk.cz - 1);
    }
  }
}
