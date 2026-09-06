import './ui/style.css';
import { DEFAULT_SEED } from './core/constants';
import { GameCore } from './core/game';
import { chunksAround, ORIGIN_CHUNK } from './core/world';
import { installDebugHandle } from './debug';
import { installPlayerControls } from './input/controls';
import { startGameLoop } from './loop';
import { ATLAS_PATH, CRACK_PATH } from './render/atlas';
import { loadPixelTexture, WorldRenderer } from './render/renderer';
import { createChunkStream, SPAWN_READY_RADIUS } from './worker/chunk-stream';

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
  await chunks.awaitChunks(chunksAround(ORIGIN_CHUNK, SPAWN_READY_RADIUS));

  // 种子只有一个出处：Worker 与核心都用区块来源记着的那个，两边不可能对不上。
  const core = new GameCore({ seed: chunks.seed, chunkSource: () => chunks.source });

  const [texture, crackTexture] = await Promise.all([
    loadPixelTexture(ATLAS_PATH),
    loadPixelTexture(CRACK_PATH),
  ]);
  const renderer = new WorldRenderer({ canvas, core, texture, crackTexture });
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

void main();
