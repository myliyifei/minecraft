import { describe, expect, it, vi } from 'vitest';
import { BlockType } from '../../src/core/block';
import { CHUNK_BLOCK_COUNT } from '../../src/core/chunk';
import { WORLD_MAX_Y } from '../../src/core/constants';
import { MAX_HEALTH } from '../../src/core/health';
import { INVENTORY_SIZE } from '../../src/core/inventory';
import { ItemType } from '../../src/core/item';
import { SNAPSHOT_FORMAT_VERSION, TERRAIN_VERSION } from '../../src/core/snapshot';
import { CHUNK_COORD_LIMIT } from '../../src/core/world';
import { gzipChunk } from '../../src/storage/chunk-codec';
import {
  decodeWorldBlob,
  decodeWorldFile,
  encodeWorldFile,
  WORLD_FILE_MAX_BYTES,
  WORLD_FILE_MAX_CHUNKS,
  WORLD_FILE_MAX_GZIP_BYTES,
  WORLD_FILE_MAX_JSON_BYTES,
  type WorldFile,
} from '../../src/storage/world-file';
import { editedSnapshot, worldFileOf } from '../helpers/world-file';

/** 文件开头的魔数（issue #70）。 */
const MAGIC = 'VOXWORLD';

/** 一个区块段：坐标与 gzip 字节。 */
interface RawChunk {
  readonly cx: number;
  readonly cz: number;
  readonly data: Uint8Array;
}

/**
 * 不经过编码器，按 issue #70 的布局手拼一个文件：魔数、版本、JSON 段长与 JSON 段、区块数、逐个区块段，整数小端序。
 * 各个长度字段可以单独改，用来造段长与实际内容对不上的文件。
 */
function rawFile({
  magic = MAGIC,
  version = SNAPSHOT_FORMAT_VERSION,
  json,
  jsonLength = json.byteLength,
  chunks = [],
  chunkCount = chunks.length,
  gzipLengths = [],
}: {
  magic?: string;
  version?: number;
  json: Uint8Array;
  jsonLength?: number;
  chunks?: readonly RawChunk[];
  chunkCount?: number;
  gzipLengths?: readonly number[];
}): ArrayBuffer {
  const parts: Uint8Array[] = [new TextEncoder().encode(magic), u32(version), u32(jsonLength), json, u32(chunkCount)];
  chunks.forEach(({ cx, cz, data }, i) => parts.push(i32(cx), i32(cz), u32(gzipLengths[i] ?? data.byteLength), data));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes.buffer;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function i32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

/** 一份文件的 JSON 段按编码器的写法：元数据、`states` 的记录、方块状态表。 */
function jsonOf(file: WorldFile): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ meta: file.meta, state: file.state, blockStates: file.blockStates }));
}

/** 文件解码失败。失败时只看 `ok`，原因是给控制台看的。 */
async function rejected(buffer: ArrayBuffer): Promise<boolean> {
  const result = await decodeWorldFile(buffer);
  return !result.ok;
}

/** 解码成功时取出记录，失败时抛出。 */
async function decoded(buffer: ArrayBuffer): Promise<WorldFile> {
  const result = await decodeWorldFile(buffer);
  if (!result.ok) throw new Error(`解码失败：${result.reason}`);
  return result.file;
}

/** 编码一份文件。超过上限时抛出：这里的文件都应当编得出来。 */
function encoded(file: WorldFile): ArrayBuffer {
  const result = encodeWorldFile(file);
  if (!result.ok) throw new Error(`编码失败：${result.reason}`);
  return result.buffer;
}

/** 一个全是 block 的区块，gzip 过。 */
function chunkOf(block: number): Promise<Uint8Array<ArrayBuffer>> {
  return gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT).fill(block));
}

describe('导出文件的编码与解码（ADR-0018）', () => {
  it('编码后再解码，记录相同；再编码一次逐字节相同', async () => {
    const file = await worldFileOf(editedSnapshot());
    expect(file.chunks).toHaveLength(3);
    const bytes = encoded(file);

    const back = await decoded(bytes);
    expect(back).toEqual(file);
    expect(new Uint8Array(encoded(back))).toEqual(new Uint8Array(bytes));
  });

  it('布局：魔数、格式版本、JSON 段长与 JSON 段、区块数、逐个区块段，整数小端序；与手拼的文件逐字节相同', async () => {
    const file = await worldFileOf(editedSnapshot());
    const bytes = new Uint8Array(encoded(file));
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe(MAGIC);
    expect(bytes.subarray(8, 12)).toEqual(u32(SNAPSHOT_FORMAT_VERSION));
    expect(bytes).toEqual(new Uint8Array(rawFile({ json: jsonOf(file), chunks: file.chunks })));
  });

  it('JSON 段里的元数据不带 id', async () => {
    const file = await worldFileOf(editedSnapshot());
    const withId = { ...file, meta: { ...file.meta, id: 'local-id' } };
    expect(new TextDecoder().decode(encoded(withId))).not.toContain('local-id');
  });

  it('0 个区块与 1000 个区块都能往返', async () => {
    // 换掉区块时方块状态表一起清空：熔炉所在的区块不在了
    const file = { ...(await worldFileOf(editedSnapshot())), blockStates: [] };
    const empty = { ...file, chunks: [] };
    expect(await decoded(encoded(empty))).toEqual(empty);

    const data = await chunkOf(BlockType.Stone);
    const chunks = Array.from({ length: 1000 }, (_, i) => ({ cx: (i % 40) - 20, cz: Math.floor(i / 40) - 12, data }));
    const many = { ...file, chunks };
    const back = await decoded(encoded(many));
    expect(back.chunks).toHaveLength(1000);
    expect(back).toEqual(many);
  });

  it('解码出的每段区块数据各自占一个 ArrayBuffer：写进 IndexedDB 时不会把整个文件复制进每条记录', async () => {
    const back = await decoded(encoded(await worldFileOf(editedSnapshot())));
    for (const { data } of back.chunks) expect(data.buffer.byteLength).toBe(data.byteLength);
  });
});

describe('导出时按导入的上限查', () => {
  it('区块数超过上限时不编码：那样的文件导不回来', async () => {
    const file = await worldFileOf(editedSnapshot());
    const data = await chunkOf(BlockType.Stone);
    const at = (count: number) => Array.from({ length: count }, (_, i) => ({ cx: i, cz: 0, data }));
    expect(encodeWorldFile({ ...file, chunks: at(WORLD_FILE_MAX_CHUNKS + 1) })).toMatchObject({ ok: false });
    expect(encodeWorldFile({ ...file, chunks: at(WORLD_FILE_MAX_CHUNKS) })).toMatchObject({ ok: true });
  });

  it('JSON 段超过上限时不编码', async () => {
    const file = await worldFileOf(editedSnapshot());
    const name = 'x'.repeat(WORLD_FILE_MAX_JSON_BYTES);
    expect(encodeWorldFile({ ...file, meta: { ...file.meta, name } })).toMatchObject({ ok: false });
  });
});

describe('导入校验：任一不符返回失败，不抛出', () => {
  it('魔数不对', async () => {
    const file = await worldFileOf(editedSnapshot());
    expect(await rejected(rawFile({ magic: 'VOXWORLX', json: jsonOf(file), chunks: file.chunks }))).toBe(true);
    expect(await rejected(new TextEncoder().encode('随意的文本文件，不是存档').buffer)).toBe(true);
    expect(await rejected(new ArrayBuffer(0))).toBe(true);
  });

  it('选的文件超过大小上限时不读进内存；读不出来也是失败', async () => {
    const arrayBuffer = vi.fn();
    expect(await decodeWorldBlob({ size: WORLD_FILE_MAX_BYTES + 1, arrayBuffer } as unknown as Blob)).toMatchObject({ ok: false });
    expect(arrayBuffer).not.toHaveBeenCalled();
    const gone = { size: 10, arrayBuffer: () => Promise.reject(new DOMException('文件不在了', 'NotFoundError')) };
    expect(await decodeWorldBlob(gone as unknown as Blob)).toMatchObject({ ok: false });

    const file = await worldFileOf(editedSnapshot());
    expect(await decodeWorldBlob(new Blob([encoded(file)]))).toEqual({ ok: true, file });
  });

  it('文件头的格式版本与当前不同', async () => {
    const file = await worldFileOf(editedSnapshot());
    const json = jsonOf(file);
    expect(await rejected(rawFile({ version: SNAPSHOT_FORMAT_VERSION + 1, json, chunks: file.chunks }))).toBe(true);
    expect(await rejected(rawFile({ version: 0, json, chunks: file.chunks }))).toBe(true);
  });

  it('元数据里的格式版本或地形算法版本与当前不同', async () => {
    const file = await worldFileOf(editedSnapshot());
    for (const meta of [
      { ...file.meta, formatVersion: SNAPSHOT_FORMAT_VERSION + 1 },
      { ...file.meta, terrainVersion: TERRAIN_VERSION + 1 },
    ]) {
      expect(await rejected(rawFile({ json: jsonOf({ ...file, meta }), chunks: file.chunks }))).toBe(true);
    }
  });

  it('在任意位置截断', async () => {
    const bytes = new Uint8Array(encoded(await worldFileOf(editedSnapshot())));
    const jsonEnd = 16 + new DataView(bytes.buffer).getUint32(12, true);
    for (const length of [4, 8, 12, 15, 16, jsonEnd - 1, jsonEnd, jsonEnd + 3, jsonEnd + 4, jsonEnd + 12, bytes.byteLength - 1]) {
      expect(await rejected(bytes.slice(0, length).buffer), `截断到 ${length} 字节`).toBe(true);
    }
  });

  it('最后一个区块段之后还有多余的字节', async () => {
    const bytes = new Uint8Array(encoded(await worldFileOf(editedSnapshot())));
    const longer = new Uint8Array(bytes.byteLength + 1);
    longer.set(bytes);
    expect(await rejected(longer.buffer)).toBe(true);
  });

  it('JSON 段长、区块数、gzip 段长超过上限', async () => {
    const file = await worldFileOf(editedSnapshot());
    const json = jsonOf(file);
    const [chunk] = file.chunks;
    expect(await rejected(rawFile({ json, jsonLength: WORLD_FILE_MAX_JSON_BYTES + 1 }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [chunk!], chunkCount: WORLD_FILE_MAX_CHUNKS + 1 }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [chunk!], gzipLengths: [WORLD_FILE_MAX_GZIP_BYTES + 1] }))).toBe(true);
  });

  it('段长没超上限但超出文件剩下的长度', async () => {
    const file = await worldFileOf(editedSnapshot());
    const json = jsonOf(file);
    const [chunk] = file.chunks;
    expect(await rejected(rawFile({ json, jsonLength: json.byteLength + 100 }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [chunk!], chunkCount: 2 }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [chunk!], gzipLengths: [chunk!.data.byteLength + 1] }))).toBe(true);
  });

  it('区块段解压后不是正好一个区块，或根本不是 gzip', async () => {
    const json = jsonOf(await worldFileOf(editedSnapshot()));
    const short = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT - 1) as Uint8Array<ArrayBuffer>);
    const long = await gzipChunk(new Uint8Array(CHUNK_BLOCK_COUNT + 1) as Uint8Array<ArrayBuffer>);
    for (const data of [short, long, new Uint8Array([1, 2, 3, 4])]) {
      expect(await rejected(rawFile({ json, chunks: [{ cx: 0, cz: 0, data }] }))).toBe(true);
    }
  });

  it('区块里有未知的方块编号', async () => {
    const json = jsonOf(await worldFileOf(editedSnapshot()));
    const unknown = Math.max(...Object.values(BlockType)) + 1;
    expect(await rejected(rawFile({ json, chunks: [{ cx: 0, cz: 0, data: await chunkOf(unknown) }] }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [{ cx: 0, cz: 0, data: await chunkOf(255) }] }))).toBe(true);
  });

  it('区块坐标重复或超出世界的区块坐标范围', async () => {
    const json = jsonOf(await worldFileOf(editedSnapshot()));
    const data = await chunkOf(BlockType.Stone);
    const twice = [
      { cx: 1, cz: 2, data },
      { cx: 1, cz: 2, data },
    ];
    expect(await rejected(rawFile({ json, chunks: twice }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [{ cx: CHUNK_COORD_LIMIT, cz: 0, data }] }))).toBe(true);
    expect(await rejected(rawFile({ json, chunks: [{ cx: 0, cz: -CHUNK_COORD_LIMIT, data }] }))).toBe(true);
  });

  it('方块状态表与区块对不上：状态落在文件里没有的区块、那一格不是熔炉、区块里的熔炉没有状态', async () => {
    const file = await worldFileOf(editedSnapshot());
    const [furnace] = file.blockStates;
    const withoutFurnaceChunk = file.chunks.filter(({ cx, cz }) => !(cx === -1 && cz === 2));
    expect(withoutFurnaceChunk).toHaveLength(2);
    // 状态那一格移到同一区块里的旁边一格：那里是草
    const moved = [{ ...furnace!, x: furnace!.x + 1 }];
    for (const variant of [
      { ...file, chunks: withoutFurnaceChunk },
      { ...file, blockStates: moved },
      { ...file, blockStates: [] },
    ]) {
      expect(await rejected(rawFile({ json: jsonOf(variant), chunks: variant.chunks }))).toBe(true);
    }
  });

  it('JSON 段不是 JSON，或不是 UTF-8', async () => {
    expect(await rejected(rawFile({ json: new TextEncoder().encode('{"meta":') }))).toBe(true);
    expect(await rejected(rawFile({ json: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }))).toBe(true);
    expect(await rejected(rawFile({ json: new TextEncoder().encode('null') }))).toBe(true);
  });

  /** 在一份合法的文件上改一处。 */
  type Mutation = (file: Mutable) => void;
  /** 测试里改记录要绕过只读与字段类型：把整份记录当成任意 JSON 改。 */
  type Mutable = any;

  const mutations: Record<string, Mutation> = {
    '元数据的名称是空的': (f) => (f.meta.name = ''),
    '元数据的名称超过 32 个字符': (f) => (f.meta.name = '字'.repeat(33)),
    '元数据的种子与状态里的不同': (f) => (f.meta.seed = f.state.seed + 1),
    '元数据的难度与状态里的不同': (f) => (f.meta.difficulty = f.state.difficulty === 'hard' ? 'easy' : 'hard'),
    '元数据的已死亡标记不是布尔值': (f) => (f.meta.hardcoreDead = 0),
    '元数据缺上次游玩时间': (f) => delete f.meta.lastPlayedAt,
    '不是极限难度却标了已死亡': (f) => {
      f.meta.hardcoreDead = true;
      f.state.hardcoreDead = true;
    },
    '种子不是 32 位整数': (f) => {
      f.meta.seed = 2 ** 31;
      f.state.seed = 2 ** 31;
    },
    '难度不是五档之一': (f) => {
      f.meta.difficulty = 'insane';
      f.state.difficulty = 'insane';
    },
    'tick 计数是字符串': (f) => (f.state.ticks = '5'),
    'tick 计数是负数': (f) => (f.state.ticks = -1),
    'tick 计数到了安全整数上界，再加 1 不变': (f) => (f.state.ticks = Number.MAX_SAFE_INTEGER),
    '下一个掉落物编号超过计数器上限': (f) => (f.state.nextDropId = 2 ** 48 + 1),
    '时刻偏移超出一天': (f) => (f.state.timeOffset = 24_000),
    '状态里有多余的字段': (f) => (f.state.zombies = []),
    '状态缺首次出生点': (f) => delete f.state.firstSpawn,
    '首次出生点的坐标是 null': (f) => (f.state.firstSpawn.y = null),
    '玩家坐标超出世界范围': (f) => (f.state.player.position.x = CHUNK_COORD_LIMIT * 16 + 1),
    '玩家在世界底下一个世界高度之外': (f) => (f.state.player.position.y = -1e6),
    '俯仰超过竖直': (f) => (f.state.player.pitch = Math.PI),
    '竖直速度超过下落的极限速度（碰撞扫掠停不下来）': (f) => (f.state.player.velocityY = -1e100),
    '击退超过被打那一下的速度': (f) => (f.state.player.knockback.x = 5),
    '生命值超过上限': (f) => (f.state.player.health = MAX_HEALTH + 1),
    '生命值是负数': (f) => (f.state.player.health = -1),
    '上次受伤 tick 在 tick 计数之后': (f) => (f.state.player.lastHurtTick = f.state.ticks + 1),
    '经验值是负数': (f) => (f.state.player.experience = -3),
    '经验值超过上限（等级换算要循环很久）': (f) => (f.state.player.experience = Number.MAX_SAFE_INTEGER),
    '背包不是 36 格': (f) => f.state.player.inventory.pop(),
    '背包里的物品编号未知': (f) => (f.state.player.inventory[0] = { item: 999, count: 1 }),
    '物品数量是 0': (f) => (f.state.player.inventory[0] = { item: ItemType.Dirt, count: 0 }),
    '物品数量超过堆叠上限': (f) => (f.state.player.inventory[0] = { item: ItemType.Dirt, count: 65 }),
    '物品数量是小数': (f) => (f.state.player.inventory[0] = { item: ItemType.Dirt, count: 1.5 }),
    '材料带损耗': (f) => (f.state.player.inventory[0] = { item: ItemType.Dirt, count: 1, damage: 1 }),
    '损耗达到满耐久': (f) => (f.state.player.inventory[0] = { item: ItemType.WoodenPickaxe, count: 1, damage: 59 }),
    '物品堆里有多余的字段': (f) => (f.state.player.inventory[0] = { item: ItemType.Dirt, count: 1, kind: 'x' }),
    '选中格超出快捷栏': (f) => (f.state.player.selectedSlot = 9),
    '掉落物编号不小于下一个编号': (f) => (f.state.drops[0].id = f.state.nextDropId),
    '两个掉落物编号相同': (f) => f.state.drops.push(structuredClone(f.state.drops[0])),
    '掉落物的速度是字符串': (f) => (f.state.drops[0].velocity.y = '0'),
    '掉落物的速度超过下落的极限速度': (f) => (f.state.drops[0].velocity.x = 1e9),
    '掉落物超过条数上限': (f) => {
      const [drop] = f.state.drops;
      f.state.drops = Array.from({ length: 10_001 }, (_, id) => ({ ...drop, id }));
      f.state.nextDropId = 10_001;
    },
    '经验球的经验量是 0': (f) => (f.state.xpOrbs[0].amount = 0),
    '经验球的经验量超过上限': (f) => (f.state.xpOrbs[0].amount = Number.MAX_SAFE_INTEGER),
    '经验球的速率超过上限': (f) => (f.state.xpOrbs[0].speed = 1),
    '经验球的存活 tick 数是负数': (f) => (f.state.xpOrbs[0].age = -1),
    '方块状态的 y 超出世界高度': (f) => (f.blockStates[0].y = WORLD_MAX_Y + 1),
    '方块状态的坐标是小数': (f) => (f.blockStates[0].x = 0.5),
    '两条方块状态在同一格': (f) => f.blockStates.push(structuredClone(f.blockStates[0])),
    '熔炉的炼制中物品编号未知': (f) => (f.blockStates[0].state.progressItem = 999),
    '熔炉剩余燃烧 tick 超过本次燃料的总数': (f) => {
      f.blockStates[0].state.burnTicksLeft = 10;
      f.blockStates[0].state.burnTicksTotal = 5;
    },
    '方块状态表不是数组': (f) => (f.blockStates = {}),
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    it(`JSON 字段：${name}`, async () => {
      const file: Mutable = structuredClone(await worldFileOf(editedSnapshot()));
      mutate(file);
      expect(await rejected(rawFile({ json: jsonOf(file), chunks: file.chunks }))).toBe(true);
    });
  }

  it('上面这些改动之前的文件本身是合法的，只差在改的那一处', async () => {
    const file = await worldFileOf(editedSnapshot());
    expect(file.state.player.inventory).toHaveLength(INVENTORY_SIZE);
    expect(file.blockStates).toHaveLength(1);
    expect(await rejected(rawFile({ json: jsonOf(file), chunks: file.chunks }))).toBe(false);
  });
});
