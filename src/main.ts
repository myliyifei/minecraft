import './ui/style.css';
import { GameCore } from './core/game';
import { installDebugHandle } from './debug';
import { buildDemoScene } from './demo-scene';
import { startGameLoop } from './loop';
import { loadAtlasTexture, WorldRenderer } from './render/renderer';
import { STRINGS } from './ui/strings';

/**
 * 接线层：造核心、造渲染适配器、起循环。逻辑一律在核心里，这里只负责组装。
 */
async function main(): Promise<void> {
  document.title = STRINGS.gameTitle;

  const loading = document.querySelector('#loading');
  if (!(loading instanceof HTMLElement)) throw new Error('页面缺少 #loading 元素');
  loading.textContent = STRINGS.loadingWorld;

  const canvas = document.querySelector('#game');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('页面缺少 #game 画布');

  const core = new GameCore();
  buildDemoScene(core);

  const texture = await loadAtlasTexture();
  const renderer = new WorldRenderer({ canvas, core, texture });
  renderer.buildAllChunks();
  renderer.render();

  // 首帧画完才撤掉加载遮罩，页面不会闪一下空画布。
  loading.remove();
  installDebugHandle({ core, renderer });
  startGameLoop(core, () => renderer.render());
}

void main();
