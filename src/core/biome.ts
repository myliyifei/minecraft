/**
 * 群系（见 GLOSSARY.md「群系」）。值是字符串，不进存档：存档里只有方块，群系随时由种子与列坐标查得。
 * 由大陆度、起伏、温度三层群系参数分出（见 `terrain.ts` 的 `biomeOf`），一种群系连成的一片约 300 到 600 格宽。
 *
 * 单独放一个模块：放树（`tree.ts`）要按群系判断，而 `terrain.ts` 引入了 `tree.ts`，常量放在这里两边都引入它，
 * 不绕循环 import。`terrain.ts` 原样转出，调用方仍从那里取。
 */
export const Biome = {
  Plains: 'plains',
  Mountains: 'mountains',
  Snowy: 'snowy',
  Ocean: 'ocean',
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];
