/**
 * 生成方块贴图图集 public/textures/atlas.png。
 *
 * 贴图是本项目自己画的 16×16 像素风，按 CC0 释出（见 public/textures/LICENSE.md），
 * 不含任何《我的世界》原版资源。随机噪点由固定种子驱动，因此重复运行输出完全一致。
 *
 * 格号与 src/render/atlas.ts 的 TILE 表必须一致。
 *
 * 用法：npm run gen:atlas
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const TILE_PX = 16;
const COLS = 4;
const ROWS = 4;
const WIDTH = COLS * TILE_PX;
const HEIGHT = ROWS * TILE_PX;

const OUT = fileURLToPath(new URL('../public/textures/atlas.png', import.meta.url));

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
const BEDROCK = [85, 85, 85];
const LOG_BARK = [104, 78, 46];
const LOG_CORE = [166, 133, 86];
const LEAVES = [63, 110, 45];

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
};

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
