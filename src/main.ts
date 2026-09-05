import './ui/style.css';
import { DEFAULT_SEED } from './core/constants';
import { GameCore } from './core/game';
import type { ChunkCoord } from './core/world';
import { installDebugHandle } from './debug';
import { buildDemoScene } from './demo-scene';
import { installPlayerControls } from './input/controls';
import { startGameLoop } from './loop';
import { loadAtlasTexture, WorldRenderer } from './render/renderer';
import { createChunkStream } from './worker/chunk-stream';

/**
 * 进世界之前先等好的区块半径（区块数）。
 *
 * 出生点要有地形才算得出来，否则玩家一进世界就掉进「未加载即空气」的虚空。多等一圈是
 * 为了首帧不是一片虚空：网格要四邻齐全才建（见 `planChunkMeshes`），所以等半径 3
 * 才能铺出半径 2 的一片地。视距内其余的区块由 tick 逐步补上，世界从脚下往外长开。
 */
const INITIAL_LOAD_RADIUS = 3;

/**
 * 接线层：造核心、造渲染适配器、起循环。逻辑一律在核心里，这里只负责组装。
 * 标题与加载提示由构建期从 src/ui/strings.ts 注入 index.html，不在这里设置。
 */
async function main(): Promise<void> {
  const loading = document.querySelector('#loading');
  if (!(loading instanceof HTMLElement)) throw new Error('页面缺少 #loading 元素');

  const canvas = document.querySelector('#game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('页面缺少 #game 画布');

  // 地形生成搬进 Worker：铺满视距要生成几百个区块，摊在主线程上就是一串掉帧。
  const seed = DEFAULT_SEED;
  const chunks = createChunkStream({
    seed,
    port: new Worker(new URL('./worker/chunk-worker.ts', import.meta.url), {
      type: 'module',
    }),
  });
  await chunks.awaitChunks(chunksInSquare(INITIAL_LOAD_RADIUS));

  const core = new GameCore({ seed, chunkSource: () => chunks.source });
  buildDemoScene(core);

  const texture = await loadAtlasTexture();
  const renderer = new WorldRenderer({ canvas, core, texture });
  // 首帧之前把已经到位的区块一次铺完；之后每帧只补几个，见 MESH_BUDGET_PER_FRAME。
  renderer.syncChunkMeshes(Infinity);
  renderer.render();

  // 首帧画完才撤掉加载遮罩，页面不会闪一下空画布。
  loading.remove();
  installPlayerControls(canvas, core);
  installDebugHandle({ core, renderer, chunks });
  startGameLoop(core, (alpha) => {
    renderer.syncChunkMeshes();
    renderer.render(alpha);
  });
}

/** 以原点区块为心、半径 radius 的方形内的全部区块。 */
function chunksInSquare(radius: number): ChunkCoord[] {
  const coords: ChunkCoord[] = [];
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      coords.push({ cx, cz });
    }
  }
  return coords;
}

void main();
