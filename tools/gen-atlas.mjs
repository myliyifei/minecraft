/**
 * 生成方块贴图：图集 public/textures/atlas.png 与裂纹条 public/textures/crack.png。
 *
 * 贴图是本项目自己画的 16×16 像素风，按 CC0 释出（见 public/textures/LICENSE.md），
 * 不含任何《我的世界》原版资源。随机噪点由固定种子驱动，因此重复运行输出完全一致。
 *
 * 格号与 src/render/atlas.ts 的 TILE 表必须一致，裂纹阶数与那里的 CRACK_STAGES 一致。
 *
 * 用法：npm run gen:atlas
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const TILE_PX = 16;
const COLS = 8;
const ROWS = 8;
const WIDTH = COLS * TILE_PX;
const HEIGHT = ROWS * TILE_PX;

/** 裂纹分几阶，横排成一条。 */
const CRACK_STAGES = 10;

const OUT = fileURLToPath(new URL('../public/textures/atlas.png', import.meta.url));
const CRACK_OUT = fileURLToPath(new URL('../public/textures/crack.png', import.meta.url));

/** 固定种子的伪随机数，保证图集可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在基色上叠加亮度扰动。 */
function shade([r, g, b], amount) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r + amount), clamp(g + amount), clamp(b + amount), 255];
}

const GRASS = [96, 148, 62];
const GRASS_DARK = [74, 118, 47];
const DIRT = [134, 96, 67];
const STONE = [127, 127, 127];
const COBBLE_GAP = [78, 78, 78];
const BEDROCK = [85, 85, 85];
const LOG_BARK = [104, 78, 46];
const LOG_CORE = [166, 133, 86];
const LEAVES = [63, 110, 45];
const PLANKS = [162, 130, 78];
const PLANKS_SEAM = [110, 84, 48];
const STICK = [140, 104, 58];
const STICK_SHADOW = [96, 70, 38];
const TABLE_TOP = [176, 142, 86];
const TABLE_GRID = [92, 68, 40];
const TABLE_CLOTH = [178, 60, 52];
const TABLE_IRON = [200, 200, 205];
/** 熔炉的炉体比圆石暗一档，炉口熄火时近黑，燃烧时是火的橙与黄。 */
const FURNACE_BODY = [108, 108, 108];
const FURNACE_MOUTH = [28, 28, 28];
const FIRE = [232, 118, 22];
const FIRE_BRIGHT = [252, 208, 64];

/**
 * 熔炉正面炉口的范围：横向居中 6 格宽，竖向从第 4 行到第 12 行。
 * 玩家平视时视线落在方块的第 6 行上（眼高 1.62，取小数部分），端到端测试读画面正中的颜色时
 * 读到的就是炉口，上下各留两行余量。
 */
const MOUTH_LEFT = 5;
const MOUTH_RIGHT = 10;
const MOUTH_TOP = 4;
const MOUTH_BOTTOM = 12;

/** 木棍图标的两端离格子边各留几像素，免得贴到边上。 */
const STICK_MARGIN = 2;

/**
 * 工具图标的柄：与木棍同一根斜杆（从左下到右上，沿反对角线 x + y = 15），但只画到
 * 第 `TOOL_HANDLE_END` 列，右上那一段让给工具头。返回 null 表示这一像素不在柄上。
 */
const TOOL_HANDLE_END = 11;
function toolHandle(x, y, rand) {
  const offset = x + y - (TILE_PX - 1);
  if (offset < -1 || offset > 1) return null;
  if (x < STICK_MARGIN || x >= TOOL_HANDLE_END) return null;
  return shade(offset === 1 ? STICK_SHADOW : STICK, Math.floor(rand() * 16) - 8);
}

/**
 * 一档材质的工具头用哪两种颜色：亮面与暗面。暗的那一条边让头看着有厚度、与柄分得开。
 *
 * 木制那两色沿用木板与工作台面的色号，石制沿用石头与圆石缝的色号——那几个常量是按方块
 * 取的名字，工具头借用它们的色值，所以在这里另起一对名字，用的时候读到的是「亮面/暗面」。
 */
const WOOD_HEAD = { light: TABLE_TOP, dark: PLANKS_SEAM };
const STONE_HEAD = { light: STONE, dark: COBBLE_GAP };

/**
 * 镐头：横着一条与柄垂直的头（沿主对角线 x − y = 7 方向），两端略垂。
 *
 * 三个形状函数返回这一像素落在头的亮面还是暗面，不在头上返回 undefined。形状按工具类别、
 * 颜色按材质档，`toolIcon` 把形状与颜色组合起来：石镐与木镐是同一个形状的两种颜色，
 * 形状因此只写一遍。
 */
function pickaxeHead(x, y) {
  const along = x - y - 7;
  if (along < -1 || along > 1 || x < 6 || x > 14 || y < 0 || y > 8) return undefined;
  return along === 1 ? 'dark' : 'light';
}

/** 斧头：斜柄顶端一块楔形的刃挂在柄的左上那一侧，柄的另一侧露出一小截斧背。 */
function axeHead(x, y) {
  const offset = x + y - (TILE_PX - 1);
  const blade = offset <= -1 && offset >= -7 && x >= 7 && x <= 11 && y >= 1 && y <= 6;
  if (blade) return x === 7 || y === 1 ? 'dark' : 'light';
  const poll = offset >= 1 && offset <= 2 && x >= 10 && x <= 12 && y >= 3;
  return poll ? 'dark' : undefined;
}

/** 铲面：一块圆角的方板，右下两边是暗面。 */
function shovelHead(x, y) {
  const inBox = x >= 9 && x <= 14 && y >= 0 && y <= 5;
  const corner = (x === 9 || x === 14) && (y === 0 || y === 5);
  if (!inBox || corner) return undefined;
  return x === 14 || y === 5 ? 'dark' : 'light';
}

/**
 * 一件工具的图标：先画头，头没盖到的地方画柄，其余透明。`head(x, y)` 给出这一像素落在头的
 * 哪一面，`colors` 是这一档材质头的亮暗两色。
 */
function toolIcon(head, colors) {
  return (x, y, rand) => {
    const face = head(x, y);
    if (face) return shade(colors[face], Math.floor(rand() * 16) - 8);
    return toolHandle(x, y, rand) ?? [0, 0, 0, 0];
  };
}

/** 每个格号对应的画法：painter(x, y, rand) → [r, g, b, a]。 */
const TILES = {
  // grass_top
  0: (x, y, rand) => shade(GRASS, Math.floor(rand() * 34) - 17 + (((x + y) % 3) - 1) * 4),
  // grass_side：上沿是草，下面是泥土，交界高度不规则
  1: (x, y, rand) => {
    const edge = 3 + Math.floor(rand() * 2) + (x % 4 === 0 ? 1 : 0);
    if (y < edge) return shade(GRASS, Math.floor(rand() * 30) - 15);
    if (y === edge) return shade(GRASS_DARK, Math.floor(rand() * 24) - 12);
    return shade(DIRT, Math.floor(rand() * 28) - 14);
  },
  // dirt
  2: (_x, _y, rand) => shade(DIRT, Math.floor(rand() * 40) - 20),
  // stone
  3: (_x, _y, rand) => shade(STONE, Math.floor(rand() * 36) - 18),
  // bedrock：深灰底 + 大块黑斑
  4: (x, y, rand) => {
    const blotch = (Math.floor(x / 2) + Math.floor(y / 2) * 3) % 5 === 0;
    return shade(BEDROCK, (blotch ? -40 : 10) + Math.floor(rand() * 30) - 15);
  },
  // oak_log_top：年轮
  5: (x, y, rand) => {
    const dx = x - 7.5;
    const dy = y - 7.5;
    const ring = Math.round(Math.sqrt(dx * dx + dy * dy)) % 2 === 0;
    return shade(ring ? LOG_CORE : LOG_BARK, Math.floor(rand() * 20) - 10);
  },
  // oak_log_side：竖向树皮纹理
  6: (x, _y, rand) => {
    const stripe = x % 4 < 2 ? 12 : -12;
    return shade(LOG_BARK, stripe + Math.floor(rand() * 18) - 9);
  },
  // oak_leaves：深绿噪点，带镂空（渲染用 alphaTest 剔掉）
  7: (_x, _y, rand) => {
    if (rand() < 0.18) return [0, 0, 0, 0];
    return shade(LEAVES, Math.floor(rand() * 46) - 23);
  },
  // oak_planks：四条横板，板与板之间一条深色接缝，每条板上错开一处竖向的短接缝
  8: (x, y, rand) => {
    const seam = y % 4 === 3 || (x === (Math.floor(y / 4) * 5) % TILE_PX && y % 4 !== 3);
    if (seam) return shade(PLANKS_SEAM, Math.floor(rand() * 16) - 8);
    return shade(PLANKS, Math.floor(rand() * 22) - 11 + (y % 4 === 0 ? 8 : 0));
  },
  // stick：透明底上一根从左下到右上的斜木棍，三像素宽，右下那一条是暗面
  9: (x, y, rand) => {
    // 到反对角线（x + y = 15）的偏移：0 在线上，正数在右下
    const offset = x + y - (TILE_PX - 1);
    if (offset < -1 || offset > 1) return [0, 0, 0, 0];
    if (x < STICK_MARGIN || x >= TILE_PX - STICK_MARGIN) return [0, 0, 0, 0];
    return shade(offset === 1 ? STICK_SHADOW : STICK, Math.floor(rand() * 16) - 8);
  },
  // crafting_table_top：浅色台面，四周一圈深边，中间两横两竖的深线划出 3x3 的格子
  10: (x, y, rand) => {
    const border = x === 0 || y === 0 || x === TILE_PX - 1 || y === TILE_PX - 1;
    const line = x === 5 || x === 10 || y === 5 || y === 10;
    if (border || line) return shade(TABLE_GRID, Math.floor(rand() * 14) - 7);
    return shade(TABLE_TOP, Math.floor(rand() * 20) - 10);
  },
  // crafting_table_side：上沿一条台面色，下面是木板，木板上搭一块红布
  11: (x, y, rand) => {
    if (y < 2) return shade(TABLE_TOP, Math.floor(rand() * 16) - 8);
    if (y >= 3 && y <= 8 && x >= 2 && x <= 13) {
      return shade(TABLE_CLOTH, (y % 2 === 0 ? 10 : -10) + Math.floor(rand() * 12) - 6);
    }
    return TILES[8](x, y, rand);
  },
  // crafting_table_front：与侧面同一块底，红布换成挂着的锤与锯——竖着的木柄，顶上一块铁头
  12: (x, y, rand) => {
    if (y < 2) return shade(TABLE_TOP, Math.floor(rand() * 16) - 8);
    const hammerHandle = x === 4 && y >= 5 && y <= 12;
    const hammerHead = y >= 3 && y <= 5 && x >= 2 && x <= 6;
    const sawHandle = x >= 9 && x <= 12 && y >= 3 && y <= 5;
    const sawBlade = x >= 10 && x <= 11 && y >= 6 && y <= 13;
    if (hammerHead || sawBlade) return shade(TABLE_IRON, Math.floor(rand() * 20) - 10);
    if (hammerHandle || sawHandle) return shade(STICK_SHADOW, Math.floor(rand() * 12) - 6);
    return TILES[8](x, y, rand);
  },
  // wooden_pickaxe、wooden_axe、wooden_shovel：木色的头装在同一根斜木柄上
  13: toolIcon(pickaxeHead, WOOD_HEAD),
  14: toolIcon(axeHead, WOOD_HEAD),
  15: toolIcon(shovelHead, WOOD_HEAD),
  // cobblestone：石头色的碎块，块与块之间一条深色的缝；每行的竖缝错开半块
  16: (x, y, rand) => {
    const row = Math.floor(y / 4);
    const shift = row % 2 === 0 ? 0 : 2;
    const gap = y % 4 === 3 || (x + shift) % 4 === 3;
    if (gap) return shade(COBBLE_GAP, Math.floor(rand() * 16) - 8);
    // 每块自己深浅不一：块的编号决定一个基调，再叠噪点
    const block = ((row * 7 + Math.floor((x + shift) / 4) * 3) % 5) * 8 - 16;
    return shade(STONE, block + Math.floor(rand() * 20) - 10);
  },
  // stone_pickaxe、stone_axe、stone_shovel：与木制三件同形状，头换成石头的灰
  17: toolIcon(pickaxeHead, STONE_HEAD),
  18: toolIcon(axeHead, STONE_HEAD),
  19: toolIcon(shovelHead, STONE_HEAD),
  // furnace_top：暗灰的石板，四周一圈更暗的边，中间一块略亮的方板
  20: (x, y, rand) => {
    const border = x === 0 || y === 0 || x === TILE_PX - 1 || y === TILE_PX - 1;
    const inner = x >= 3 && x <= 12 && y >= 3 && y <= 12;
    if (border) return shade(COBBLE_GAP, Math.floor(rand() * 14) - 7);
    return shade(FURNACE_BODY, (inner ? 10 : -4) + Math.floor(rand() * 18) - 9);
  },
  // furnace_side：圆石那样的碎块与缝，整体比圆石暗一档
  21: (x, y, rand) => furnaceBody(x, y, rand),
  // furnace_front：侧面的炉体，中间挖出一个近黑的炉口，炉口上沿一条更亮的石边
  22: (x, y, rand) => {
    if (inMouth(x, y)) return shade(FURNACE_MOUTH, Math.floor(rand() * 10) - 5);
    if (y === MOUTH_TOP - 1 && x >= MOUTH_LEFT && x <= MOUTH_RIGHT) {
      return shade(FURNACE_BODY, 24 + Math.floor(rand() * 10) - 5);
    }
    return furnaceBody(x, y, rand);
  },
  // lit_furnace_front：与熄火的正面同一块炉体，炉口里满是火——底部亮黄、往上转橙
  23: (x, y, rand) => {
    if (inMouth(x, y)) {
      const bright = y >= MOUTH_BOTTOM - 1 || (y >= MOUTH_BOTTOM - 3 && (x + y) % 3 === 0);
      return shade(bright ? FIRE_BRIGHT : FIRE, Math.floor(rand() * 20) - 10);
    }
    return TILES[22](x, y, rand);
  },
};

/** 这一像素落在熔炉正面的炉口里吗。 */
function inMouth(x, y) {
  return x >= MOUTH_LEFT && x <= MOUTH_RIGHT && y >= MOUTH_TOP && y <= MOUTH_BOTTOM;
}

/** 熔炉的炉体：与圆石同样的碎块与缝，基色暗一档。侧面整面是它，正面挖掉炉口的部分也是它。 */
function furnaceBody(x, y, rand) {
  const row = Math.floor(y / 4);
  const shift = row % 2 === 0 ? 0 : 2;
  const gap = y % 4 === 3 || (x + shift) % 4 === 3;
  if (gap) return shade(COBBLE_GAP, -12 + Math.floor(rand() * 16) - 8);
  const block = ((row * 7 + Math.floor((x + shift) / 4) * 3) % 5) * 8 - 16;
  return shade(FURNACE_BODY, block + Math.floor(rand() * 20) - 10);
}

/**
 * 裂纹的颜色与不透明度。
 * 暗色半透明：盖在任何贴图上都像凹进去的缝，而不是刷上去的一块黑漆。
 */
const CRACK_RGBA = [0, 0, 0, 150];

/** 裂缝从方块中心长出几条。够铺满整个面，又不至于把面糊住。 */
const CRACK_BRANCHES = 9;

/**
 * 裂纹图案：每个像素记它从第几阶起出现（0 到 CRACK_STAGES−1），没有裂纹的记 −1。
 *
 * 先从格子中心随机游走出几条裂缝，再按到中心的距离排序、均分到各阶——裂纹因此是从
 * 中间往四周长开的，而且每一阶新增的像素数大致相等。直接拿距离折算阶数不行：裂缝多半
 * 在走到角上之前就出了格子，最后几阶会一个新像素都不加，看上去像卡住了。
 */
function crackStages() {
  const cracked = new Map();
  const rand = mulberry32(0xc7ac4);
  const center = TILE_PX / 2 - 0.5;

  const mark = (x, y) => {
    if (x < 0 || x >= TILE_PX || y < 0 || y >= TILE_PX) return;
    const index = y * TILE_PX + x;
    if (!cracked.has(index)) cracked.set(index, Math.hypot(x - center, y - center));
  };

  for (let b = 0; b < CRACK_BRANCHES; b++) {
    let x = center;
    let y = center;
    // 每条裂缝朝一个大致固定的方向长，中途左右抖动
    let angle = (b / CRACK_BRANCHES) * Math.PI * 2 + rand() * 0.8;
    for (let step = 0; step < TILE_PX * 2; step++) {
      angle += (rand() - 0.5) * 0.9;
      x += Math.cos(angle);
      y += Math.sin(angle);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || px >= TILE_PX || py < 0 || py >= TILE_PX) break;
      mark(px, py);
      // 偶尔加个毛刺，裂纹才不是一条干净的细线；概率压得低，免得连成一片黑
      if (rand() < 0.16) mark(px + (rand() < 0.5 ? 1 : -1), py);
      if (rand() < 0.12) mark(px, py + (rand() < 0.5 ? 1 : -1));
    }
  }

  const stages = new Int8Array(TILE_PX * TILE_PX).fill(-1);
  const byRadius = [...cracked.entries()].sort(([, a], [, b]) => a - b);
  byRadius.forEach(([index], rank) => {
    stages[index] = Math.floor((rank * CRACK_STAGES) / byRadius.length);
  });
  return stages;
}

/** 裂纹条：CRACK_STAGES 张横排，第 n 张画出所有第 n 阶及更早出现的像素。 */
function crackStrip() {
  const width = CRACK_STAGES * TILE_PX;
  const strip = new Uint8Array(width * TILE_PX * 4);
  const stages = crackStages();
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const appearsAt = stages[y * TILE_PX + x];
        if (appearsAt < 0 || appearsAt > stage) continue;
        strip.set(CRACK_RGBA, (y * width + stage * TILE_PX + x) * 4);
      }
    }
  }
  return { strip, width };
}

const pixels = new Uint8Array(WIDTH * HEIGHT * 4);

for (const [key, painter] of Object.entries(TILES)) {
  const tile = Number(key);
  const ox = (tile % COLS) * TILE_PX;
  const oy = Math.floor(tile / COLS) * TILE_PX;
  // 每格一条独立的随机序列，改动一格不会影响其它格。
  const rand = mulberry32(0x5eed + tile * 7919);
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const [r, g, b, a] = painter(x, y, rand);
      const i = ((oy + y) * WIDTH + (ox + x)) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
}

// ---------------------------------------------------------------------------
// 最小 PNG 编码器：RGBA8、无滤波、单个 IDAT。避免为一张 4 KB 的图引入依赖。
// ---------------------------------------------------------------------------

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type 0（None）
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// CRC_TABLE 是顶层 const，有 TDZ，写文件必须排在它的声明之后。
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, encodePng(pixels, WIDTH, HEIGHT));
console.log(`已生成 ${OUT}（${WIDTH}×${HEIGHT}，${Object.keys(TILES).length} 张贴图）`);

const { strip, width: crackWidth } = crackStrip();
writeFileSync(CRACK_OUT, encodePng(strip, crackWidth, TILE_PX));
console.log(`已生成 ${CRACK_OUT}（${crackWidth}×${TILE_PX}，${CRACK_STAGES} 阶裂纹）`);
