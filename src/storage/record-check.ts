import { CHUNK_SIZE, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y } from '../core/constants';
import { deletesWorldOnDeath, Difficulty } from '../core/difficulty';
import { MAX_HEALTH } from '../core/health';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../core/inventory';
import { ItemType, maxDurability, stackLimit } from '../core/item';
import { GRAVITY, KNOCKBACK_SPEED, VERTICAL_DRAG } from '../core/physics';
import { MAX_PITCH } from '../core/player';
import { DAY_LENGTH_TICKS } from '../core/time-of-day';
import { CHUNK_COORD_LIMIT } from '../core/world';
import { XP_ORB_MAX_SPEED } from '../core/xp-orb';
import type { WorldFile, WorldFileMeta } from './world-file';
import { worldNameValid, type StorageVersions, type WorldState } from './world-storage';

/*
 * 导出文件 JSON 段的逐项校验（ADR-0018）。导入的文件是不可信输入：元数据、`states` 的记录与方块状态表按快照的
 * 形状逐个字段查类型与取值范围，每个对象的键也要正好是那几个。校验通过的对象原样写进 IndexedDB，不另外复制，
 * 所以多出来的字段也要拒绝，否则会跟着进存档。
 *
 * 取值范围按核心能接受的量级定，不只是「是个有限数」：竖直速度 -1e100 时碰撞扫掠的坐标加 1 不变，第一个 tick
 * 就停不下来；经验值按等级逐级换算，几十个巨大的经验球一个 tick 要算十几秒。
 */

/** JSON 段解析出来的三部分。 */
export type FileRecords = Omit<WorldFile, 'chunks'>;

/** 实体与出生点水平坐标的绝对值上限：区块坐标范围乘区块边长。 */
const COORD_LIMIT = CHUNK_COORD_LIMIT * CHUNK_SIZE;

/** 实体与出生点竖直坐标的范围：世界高度上下各再留一个世界高度，跳起与击飞都到不了。 */
const MIN_Y = WORLD_MIN_Y - WORLD_HEIGHT;
const MAX_Y = WORLD_MAX_Y + WORLD_HEIGHT;

/**
 * 每个轴每 tick 速度的绝对值上限：下落的极限速度，重力与竖直阻尼的不动点。玩家与掉落物的速度都到不了它，
 * 碰撞扫掠一个 tick 只走几格。
 */
const MAX_SPEED = (GRAVITY * VERTICAL_DRAG) / (1 - VERTICAL_DRAG);

/**
 * tick 计数、三个自增编号与存活 tick 数的上限。这些数每 tick 或每生成一个实体加 1，到安全整数上界之前还能
 * 加 2⁵³ − 2⁴⁸ 次，按每秒 20 tick 算是一千多万年。
 */
const COUNTER_LIMIT = 2 ** 48;

/**
 * 经验值的上限：玩家累计的、一个经验球的、熔炉里待结算的都不超过它。等级按 `levelBreakdown` 逐级换算，
 * 这个量级是两万多级，换算一次也只循环两万多次。
 */
const EXPERIENCE_LIMIT = 2 ** 31 - 1;

/** 掉落物与经验球各自的条数上限。掉落物 6000 tick 后消失，正常游玩时同时在的远少于此。 */
const MAX_ENTITIES = 10_000;

const DIFFICULTIES: readonly unknown[] = Object.values(Difficulty);
const ITEM_TYPES: readonly unknown[] = Object.values(ItemType);

/** 检查 JSON 段的内容，不符时抛出，消息说的是哪个字段、哪一条不符。版本号与当前的比对也在这里。 */
export function checkFileRecords(value: unknown, versions: StorageVersions): FileRecords {
  const file = object(value, '文件', ['meta', 'state', 'blockStates']);
  const meta = checkMeta(file.meta, versions);
  const state = checkState(file.state);
  if (meta.seed !== state.seed) fail('meta.seed', '与 state.seed 不同');
  if (meta.difficulty !== state.difficulty) fail('meta.difficulty', '与 state.difficulty 不同');
  if (meta.hardcoreDead !== state.hardcoreDead) fail('meta.hardcoreDead', '与 state.hardcoreDead 不同');
  if (state.hardcoreDead && !deletesWorldOnDeath(state.difficulty)) fail('state.hardcoreDead', '不是极限难度却标了已死亡');
  checkBlockStates(file.blockStates);
  return file as unknown as FileRecords;
}

function checkMeta(value: unknown, versions: StorageVersions): WorldFileMeta {
  const meta = object(value, 'meta', [
    'name',
    'seed',
    'difficulty',
    'formatVersion',
    'terrainVersion',
    'createdAt',
    'lastPlayedAt',
    'hardcoreDead',
  ]);
  if (typeof meta.name !== 'string' || !worldNameValid(meta.name)) fail('meta.name', '不是 1 到 32 个字符的名称');
  int32(meta.seed, 'meta.seed');
  oneOf(meta.difficulty, 'meta.difficulty', DIFFICULTIES);
  if (meta.formatVersion !== versions.format) fail('meta.formatVersion', '与当前的快照格式版本不同');
  if (meta.terrainVersion !== versions.terrain) fail('meta.terrainVersion', '与当前的地形算法版本不同');
  integer(meta.createdAt, 'meta.createdAt', 0, Number.MAX_SAFE_INTEGER);
  integer(meta.lastPlayedAt, 'meta.lastPlayedAt', 0, Number.MAX_SAFE_INTEGER);
  boolean(meta.hardcoreDead, 'meta.hardcoreDead');
  return meta as unknown as WorldFileMeta;
}

function checkState(value: unknown): WorldState {
  const state = object(value, 'state', [
    'seed',
    'difficulty',
    'hardcoreDead',
    'firstSpawn',
    'ticks',
    'timeOffset',
    'nextDropId',
    'nextZombieId',
    'nextXpOrbId',
    'player',
    'drops',
    'xpOrbs',
  ]);
  int32(state.seed, 'state.seed');
  oneOf(state.difficulty, 'state.difficulty', DIFFICULTIES);
  boolean(state.hardcoreDead, 'state.hardcoreDead');
  position(state.firstSpawn, 'state.firstSpawn');
  const ticks = counter(state.ticks, 'state.ticks');
  number(state.timeOffset, 'state.timeOffset', 0, DAY_LENGTH_TICKS);
  if (state.timeOffset === DAY_LENGTH_TICKS) fail('state.timeOffset', '不在一天之内');
  const nextDropId = counter(state.nextDropId, 'state.nextDropId');
  counter(state.nextZombieId, 'state.nextZombieId');
  const nextXpOrbId = counter(state.nextXpOrbId, 'state.nextXpOrbId');
  checkPlayer(state.player, ticks);

  const dropIds = new Set<number>();
  entities(state.drops, 'state.drops').forEach((entry, i) => {
    const path = `state.drops[${i}]`;
    const drop = object(entry, path, ['id', 'stack', 'position', 'velocity', 'age']);
    entityId(drop.id, `${path}.id`, nextDropId, dropIds);
    stack(drop.stack, `${path}.stack`);
    position(drop.position, `${path}.position`);
    velocity(drop.velocity, `${path}.velocity`);
    counter(drop.age, `${path}.age`);
  });
  const orbIds = new Set<number>();
  entities(state.xpOrbs, 'state.xpOrbs').forEach((entry, i) => {
    const path = `state.xpOrbs[${i}]`;
    const orb = object(entry, path, ['id', 'amount', 'position', 'speed', 'age']);
    entityId(orb.id, `${path}.id`, nextXpOrbId, orbIds);
    integer(orb.amount, `${path}.amount`, 1, EXPERIENCE_LIMIT);
    position(orb.position, `${path}.position`);
    number(orb.speed, `${path}.speed`, 0, XP_ORB_MAX_SPEED);
    counter(orb.age, `${path}.age`);
  });
  return state as unknown as WorldState;
}

function checkPlayer(value: unknown, ticks: number): void {
  const player = object(value, 'state.player', [
    'position',
    'yaw',
    'pitch',
    'velocityY',
    'fallHighest',
    'knockback',
    'health',
    'lastHurtTick',
    'experience',
    'inventory',
    'selectedSlot',
  ]);
  position(player.position, 'state.player.position');
  finite(player.yaw, 'state.player.yaw');
  number(player.pitch, 'state.player.pitch', -MAX_PITCH, MAX_PITCH);
  number(player.velocityY, 'state.player.velocityY', -MAX_SPEED, MAX_SPEED);
  number(player.fallHighest, 'state.player.fallHighest', MIN_Y, MAX_Y);
  // 击退的水平速度：被打那一下大小是 KNOCKBACK_SPEED，之后每 tick 衰减
  const knockback = object(player.knockback, 'state.player.knockback', ['x', 'z']);
  number(knockback.x, 'state.player.knockback.x', -KNOCKBACK_SPEED, KNOCKBACK_SPEED);
  number(knockback.z, 'state.player.knockback.z', -KNOCKBACK_SPEED, KNOCKBACK_SPEED);
  integer(player.health, 'state.player.health', 0, MAX_HEALTH);
  if (player.lastHurtTick !== null) integer(player.lastHurtTick, 'state.player.lastHurtTick', 0, ticks);
  integer(player.experience, 'state.player.experience', 0, EXPERIENCE_LIMIT);
  const inventory = array(player.inventory, 'state.player.inventory');
  if (inventory.length !== INVENTORY_SIZE) fail('state.player.inventory', `不是 ${INVENTORY_SIZE} 格`);
  inventory.forEach((slot, i) => nullableStack(slot, `state.player.inventory[${i}]`));
  integer(player.selectedSlot, 'state.player.selectedSlot', 0, HOTBAR_SIZE - 1);
}

function checkBlockStates(value: unknown): void {
  const cells = new Set<string>();
  array(value, 'blockStates').forEach((entry, i) => {
    const path = `blockStates[${i}]`;
    const record = object(entry, path, ['x', 'y', 'z', 'state']);
    const x = integer(record.x, `${path}.x`, -COORD_LIMIT, COORD_LIMIT - 1);
    const y = integer(record.y, `${path}.y`, WORLD_MIN_Y, WORLD_MAX_Y);
    const z = integer(record.z, `${path}.z`, -COORD_LIMIT, COORD_LIMIT - 1);
    const cell = `${x},${y},${z}`;
    if (cells.has(cell)) fail(path, '与前面的一条在同一格');
    cells.add(cell);

    const furnace = object(record.state, `${path}.state`, [
      'input',
      'fuel',
      'output',
      'burnTicksLeft',
      'burnTicksTotal',
      'smeltProgress',
      'progressItem',
      'pendingExperience',
    ]);
    nullableStack(furnace.input, `${path}.state.input`);
    nullableStack(furnace.fuel, `${path}.state.fuel`);
    nullableStack(furnace.output, `${path}.state.output`);
    const total = counter(furnace.burnTicksTotal, `${path}.state.burnTicksTotal`);
    integer(furnace.burnTicksLeft, `${path}.state.burnTicksLeft`, 0, total);
    counter(furnace.smeltProgress, `${path}.state.smeltProgress`);
    if (furnace.progressItem !== null) oneOf(furnace.progressItem, `${path}.state.progressItem`, ITEM_TYPES);
    integer(furnace.pendingExperience, `${path}.state.pendingExperience`, 0, EXPERIENCE_LIMIT);
  });
}

/** 一堆物品：编号已知，数量 1 到堆叠上限；只有工具带损耗，损耗小于满耐久。 */
function stack(value: unknown, path: string): void {
  const fields = object(value, path, ['item', 'count'], ['damage']);
  const item = oneOf(fields.item, `${path}.item`, ITEM_TYPES) as ItemType;
  integer(fields.count, `${path}.count`, 1, stackLimit(item));
  if (!('damage' in fields)) return;
  const max = maxDurability(item);
  if (max === undefined) fail(`${path}.damage`, '不是工具却有损耗');
  integer(fields.damage, `${path}.damage`, 0, max - 1);
}

function nullableStack(value: unknown, path: string): void {
  if (value !== null) stack(value, path);
}

/** 掉落物或经验球的编号：小于下一个编号，同一张表里不重复。 */
function entityId(value: unknown, path: string, next: number, seen: Set<number>): void {
  const id = integer(value, path, 0, next - 1);
  if (seen.has(id)) fail(path, '与前面的一个重复');
  seen.add(id);
}

/** 世界里的一个点：水平在区块坐标范围之内，竖直在 `MIN_Y` 到 `MAX_Y` 之间。 */
function position(value: unknown, path: string): void {
  const point = object(value, path, ['x', 'y', 'z']);
  number(point.x, `${path}.x`, -COORD_LIMIT, COORD_LIMIT);
  number(point.y, `${path}.y`, MIN_Y, MAX_Y);
  number(point.z, `${path}.z`, -COORD_LIMIT, COORD_LIMIT);
}

/** 掉落物的速度：三个轴都不超过 `MAX_SPEED`。 */
function velocity(value: unknown, path: string): void {
  const v = object(value, path, ['x', 'y', 'z']);
  for (const axis of ['x', 'y', 'z']) number(v[axis], `${path}.${axis}`, -MAX_SPEED, MAX_SPEED);
}

/** 掉落物或经验球的表：数组，不超过 `MAX_ENTITIES` 条。 */
function entities(value: unknown, path: string): readonly unknown[] {
  const list = array(value, path);
  if (list.length > MAX_ENTITIES) fail(path, `超过 ${MAX_ENTITIES} 条`);
  return list;
}

/** 普通对象，键正好是 required 全部加上 optional 里的若干个。 */
function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '不是对象');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, '缺少这个字段');
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, '多余的字段');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, '不是数组');
  return value;
}

/** min 到 max 之间（含两端）的有限数。 */
function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `不是 ${min} 到 ${max} 之间的数`);
  return value;
}

/** 有限数，不限范围：偏航角，转多少圈都行。 */
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '不是有限数');
  return value;
}

/** min 到 max 之间（含两端）的整数。 */
function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(path, `不是 ${min} 到 ${max} 之间的整数`);
  return value as number;
}

/** 只往上加的计数：0 到 `COUNTER_LIMIT`。 */
function counter(value: unknown, path: string): number {
  return integer(value, path, 0, COUNTER_LIMIT);
}

function int32(value: unknown, path: string): number {
  return integer(value, path, -(2 ** 31), 2 ** 31 - 1);
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path, '不是布尔值');
}

function oneOf(value: unknown, path: string, values: readonly unknown[]): unknown {
  if (!values.includes(value)) fail(path, '不是已知的取值');
  return value;
}

function fail(path: string, rule: string): never {
  throw new Error(`${path}：${rule}`);
}
