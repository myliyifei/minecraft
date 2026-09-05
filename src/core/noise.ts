/**
 * 种子化的确定性噪声。
 *
 * 这里的每个函数都是纯函数：只看种子与坐标，不留状态、不用 Math.random，
 * 因此地形生成可以按 ADR-0003 写成 `(种子, 区块坐标) → 区块数据`。
 * 哈希那一步全走 32 位整数运算（Math.imul），插值那一步是普通浮点加减乘——
 * 两者在各引擎上都给出同一个结果，同一个种子因此在任何浏览器里长出同一个世界。
 */

/**
 * 由种子与一对整数坐标算出一个 32 位无符号整数。
 *
 * 三个常数是 xxHash / murmur 用的那类奇质数：与坐标异或后相乘再高位右移，
 * 把输入的每一位都搅到输出的所有位上，相邻坐标因此得到毫不相关的结果。
 */
export function hashCoords(seed: number, x: number, z: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4_eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (z | 0), 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0x2545_f491);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 8 个单位长的 2D 梯度方向：四个轴向加四个对角。
 *
 * 用固定的一小组方向而不是每个格点算 cos/sin —— 生成一个区块要取几百次噪声，
 * 这条路径上省下三角函数是值得的，8 个方向对地形起伏已经足够均匀。
 */
const GRADIENTS: ReadonlyArray<readonly [number, number]> = (() => {
  const d = Math.SQRT1_2;
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [d, d],
    [-d, d],
    [d, -d],
    [-d, -d],
  ];
})();

/** 单个 perlin2 的理论上界是 √2/2；乘它把值域拉到 [−1, 1]。 */
const PERLIN_NORMALIZE = Math.SQRT2;

/** 夹到 [−1, 1]。归一化后的浮点误差会让极值略微越界，夹一下调用方就能放心当作单位区间。 */
function clampUnit(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Perlin 的五次缓和曲线 6t⁵ − 15t⁴ + 10t³：一阶与二阶导数在格点处都为 0，格线不会显形。 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 格点梯度与该格点指向采样点的向量的点积。 */
function gradientDot(seed: number, ix: number, iz: number, dx: number, dz: number): number {
  const [gx, gz] = GRADIENTS[hashCoords(seed, ix, iz) & 7]!;
  return gx * dx + gz * dz;
}

/**
 * 2D 梯度噪声（Perlin），值域 [−1, 1]，在整数格点上恒为 0。
 *
 * 坐标是连续的：地形用「世界坐标 / 特征跨度」当输入，跨度越大起伏越平缓。
 */
export function perlin2(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fz);

  const n00 = gradientDot(seed, x0, z0, fx, fz);
  const n10 = gradientDot(seed, x0 + 1, z0, fx - 1, fz);
  const n01 = gradientDot(seed, x0, z0 + 1, fx, fz - 1);
  const n11 = gradientDot(seed, x0 + 1, z0 + 1, fx - 1, fz - 1);

  const bottom = n00 + u * (n10 - n00);
  const top = n01 + u * (n11 - n01);
  return clampUnit((bottom + v * (top - bottom)) * PERLIN_NORMALIZE);
}

/** 每叠一层，频率乘这个数。2 是 fBm 的惯例：每层的格子边长减半。 */
const LACUNARITY = 2;

/** 每叠一层，振幅乘这个数。0.5 与频率翻倍配对，高频层只贡献细节。 */
const GAIN = 0.5;

/** 相邻八度的种子偏移量。错开种子，各层才用不同的格点梯度，否则细节会与主形状对齐。 */
const OCTAVE_SEED_STRIDE = 0x9e37_79b9;

/**
 * 分形叠加噪声（fBm）：把 `octaves` 层频率递增、振幅递减的 perlin2 加起来，
 * 得到大起伏上带小起伏的形状。除以振幅总和，值域仍是 [−1, 1]。
 *
 * 层数越多细节越碎。octaves ≤ 0 时没有任何一层，结果是 0。
 */
export function fbm2(seed: number, x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 1;
  let totalAmplitude = 0;
  let frequency = 1;

  for (let octave = 0; octave < octaves; octave++) {
    const octaveSeed = (seed + Math.imul(octave, OCTAVE_SEED_STRIDE)) | 0;
    sum += amplitude * perlin2(octaveSeed, x * frequency, z * frequency);
    totalAmplitude += amplitude;
    amplitude *= GAIN;
    frequency *= LACUNARITY;
  }

  if (totalAmplitude === 0) return 0;
  return clampUnit(sum / totalAmplitude);
}
