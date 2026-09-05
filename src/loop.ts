import { TICK_MS } from './core/constants';
import type { GameCore } from './core/game';

/** 一帧内最多补几个 tick。标签页切回前台时不至于一次性追赶几千个 tick。 */
const MAX_CATCHUP_TICKS = 5;

/**
 * 固定步长的游戏循环：核心按 20 tick/s 推进，渲染每帧一次。
 * 返回停止循环的函数。
 */
export function startGameLoop(core: GameCore, render: () => void): () => void {
  let last = performance.now();
  let accumulator = 0;
  let handle = 0;
  let running = true;

  const frame = (now: number): void => {
    if (!running) return;
    accumulator += now - last;
    last = now;

    let steps = 0;
    while (accumulator >= TICK_MS && steps < MAX_CATCHUP_TICKS) {
      core.tick();
      accumulator -= TICK_MS;
      steps++;
    }
    // 落后太多就直接丢弃欠账，宁可跳过时间也不要卡住渲染。
    if (accumulator > TICK_MS * MAX_CATCHUP_TICKS) accumulator = 0;

    render();
    handle = requestAnimationFrame(frame);
  };

  handle = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(handle);
  };
}
