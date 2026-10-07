/** 32 位有符号整数的范围：种子取这个范围里的整数（见 GLOSSARY.md「世界列表」）。 */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/** 只由十进制数字组成、前面可以带一个正负号的文本。带小数点、指数、十六进制前缀的都不算。 */
const INTEGER_TEXT = /^[+-]?\d+$/;

/** FNV-1a 32 位的初值与乘数。 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 新建世界表单里填的种子文本换成种子（见 GLOSSARY.md「世界列表」）。首尾空白先去掉：
 *
 * - 去掉之后是空的，取 `randomSeed()`。随机数由调用方给，核心里不用非确定性的来源。
 * - 32 位有符号整数范围内的整数原样使用。
 * - 其余文本（超出范围的整数、带小数点的数、任意文字）按确定性哈希换成这个范围内的整数：同一段文本
 *   每次得到同一个种子。
 *
 * 世界里用的与世界列表显示的都是返回的这个数，原来的文本不保存。
 */
export function seedFromText(text: string, randomSeed: () => number): number {
  const trimmed = text.trim();
  if (trimmed === '') return randomSeed();
  if (INTEGER_TEXT.test(trimmed)) {
    const value = Number(trimmed);
    // `| 0` 把 "-0" 读出来的 -0 变成 0。
    if (value >= INT32_MIN && value <= INT32_MAX) return value | 0;
  }
  return hashText(trimmed);
}

/** FNV-1a 逐个 UTF-16 码元哈希，结果是 32 位有符号整数。 */
function hashText(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME);
  }
  return hash | 0;
}
