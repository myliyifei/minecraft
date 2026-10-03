import type { Difficulty } from './core/difficulty';
import { GameCore } from './core/game';
import type { Snapshot } from './core/snapshot';
import { chunkKey, chunkOf, chunksAround, ORIGIN_CHUNK, type ChunkCoord, type ChunkSource } from './core/world';
import { installDebugHandle, removeDebugHandle } from './debug';
import { installPlayerControls } from './input/controls';
import { startGameLoop } from './loop';
import { ATLAS_PATH, CRACK_PATH } from './render/atlas';
import { loadPixelTexture, WorldRenderer } from './render/renderer';
import type { WorldStorage } from './storage/world-storage';
import { installHud } from './ui/hud';
import { createChunkStream, SPAWN_READY_RADIUS } from './worker/chunk-stream';

/** 进入世界的两种起点：新建（种子与难度），或读档（快照）。 */
export type WorldStart =
  | { readonly seed: number; readonly difficulty: Difficulty }
  | { readonly restore: Snapshot };

export interface WorldSessionOptions {
  readonly storage: WorldStorage;
  /** 世界 id。调用方已经持有这个世界的锁。 */
  readonly id: string;
  /** 世界的名称。元数据每次写盘整体重写，名称由这里给。 */
  readonly name: string;
  readonly start: WorldStart;
}

/** 进入了的一个世界。 */
export interface WorldSession {
  /**
   * 关闭全部界面、写盘、销毁这个世界。写盘提交、销毁之后兑现；写盘失败时拒绝，世界不销毁。进行中重复调用拿到的是
   * 同一个 Promise。
   */
  exit(): Promise<void>;
  /** 退出或删除世界之后兑现。调用方等它兑现再释放锁。 */
  readonly ended: Promise<void>;
}

/**
 * 进入一个世界（见 CONTEXT.md「加载画面」）：造 Worker 与核心，等以玩家所在区块为中心的 3×3 个区块加载完、
 * 网格建好，画完首帧之后兑现。调用方在兑现时撤掉加载画面。新建与读档走同一条路。
 *
 * 兑现之后世界仍不推进，玩家第一次锁定指针才开始。进入之后马上写一次盘：新建的世界从此出现在世界列表里，
 * 读档的世界更新上次游玩时间。
 */
export async function startWorldSession({ storage, id, name, start }: WorldSessionOptions): Promise<WorldSession> {
  // 每个世界一块新画布：退出时连同上面的监听器一起丢掉，下一个世界的渲染器拿到的是干净的 WebGL 上下文。
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  document.body.prepend(canvas);
  // 地形生成搬进 Worker：铺满视距要生成几百个区块，放在主线程上会连续掉帧。
  const worker = new Worker(new URL('./worker/chunk-worker.ts', import.meta.url), { type: 'module' });

  try {
    // 新建时出生点由原点那一列算出来，等原点周围；读档时出生点取快照里的，等玩家周围。存档里的已改区块
    // 核心直接复用，不向 Worker 要。
    const { seed, center, ready } =
      'restore' in start
        ? { seed: start.restore.seed, center: chunkAt(start.restore.player.position), ready: start.restore.editedChunks }
        : { seed: start.seed, center: ORIGIN_CHUNK, ready: [] };
    const chunks = createChunkStream({ seed, port: worker });
    const edited = new Set(ready.map(({ cx, cz }) => chunkKey(cx, cz)));
    await chunks.awaitChunks(
      chunksAround(center, SPAWN_READY_RADIUS).filter(({ cx, cz }) => !edited.has(chunkKey(cx, cz))),
    );

    // 种子只有一个出处：Worker 与核心都用区块来源记着的那个，两边不可能对不上。
    const chunkSource = (): ChunkSource => chunks.source;
    const core =
      'restore' in start
        ? new GameCore({ restore: start.restore, chunkSource })
        : new GameCore({ seed: chunks.seed, difficulty: start.difficulty, chunkSource });

    const [texture, crackTexture] = await Promise.all([loadPixelTexture(ATLAS_PATH), loadPixelTexture(CRACK_PATH)]);
    const renderer = new WorldRenderer({ canvas, core, texture, crackTexture });
    // 首帧之前把已经到位的区块一次铺完；之后每帧只补几个，见 MESH_BUDGET_PER_FRAME。
    renderer.syncChunkMeshes(Infinity);
    renderer.render();

    /** 写一次盘，返回成没成。失败时把这次取走的已改区块放回核心，下次写盘再写。 */
    const save = async (): Promise<boolean> => {
      const result = await storage.saveWorld(id, name, core.snapshot());
      if (result.ok) return true;
      core.returnUnsavedChunks(result.chunks);
      console.error('写盘失败', result.error);
      return false;
    };

    let endSession = (): void => {};
    const ended = new Promise<void>((resolve) => (endSession = resolve));
    /** 正在进行的退出或删除。退出写盘失败时清掉，可以再退一次。 */
    let ending: Promise<void> | undefined;

    const controls = installPlayerControls(canvas, core);
    const hud = installHud(
      document.body,
      core,
      {
        // 重生按钮按下那一刻抓回指针锁定：锁定只在用户手势里放行，所以由按钮的 click 直接调，不等下一帧。
        afterRespawn: () => controls.grabPointer(),
        deleteWorld: () => void deleteWorld(),
      },
      () => controls.locked,
    );
    hud.update();

    // 加载画面之后世界不推进，玩家第一次锁定指针才开始。暂停（#68）会在这一状态下显示暂停菜单。退出写盘期间
    // 也不推进。
    let started = false;
    let exiting = false;
    // 极限下死亡那一 tick 核心置已死亡标记，这里在那一帧写一次盘：之后关掉页面，世界列表里也只剩删除。每帧而不是
    // 每 tick 查，调试句柄在循环之外推进的 tick 也查得到。
    let deathSaved = core.hardcoreDead;
    const stopLoop = startGameLoop(
      core,
      (alpha) => {
        if (!deathSaved && core.hardcoreDead) {
          deathSaved = true;
          void save();
        }
        renderer.syncChunkMeshes();
        renderer.render(alpha);
        hud.update();
        controls.sync();
      },
      () => renderer.afterTick(),
      () => {
        if (controls.locked) started = true;
        return started && !exiting;
      },
    );

    /** 卸下这一个世界挂的全部东西。存档不在这里处理。 */
    const teardown = (): void => {
      stopLoop();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      controls.remove();
      hud.remove();
      renderer.dispose();
      worker.terminate();
      canvas.remove();
      removeDebugHandle();
    };
    /**
     * 写盘成功之后才销毁、释放锁：写盘失败时世界留着，改动还在核心里，可以再退一次。写盘期间不推进 tick，
     * 写进去的就是退出那一刻的世界。
     */
    const exit = (): Promise<void> =>
      (ending ??= (async () => {
        // 光标物品与合成网格不进快照，先按背包键关闭的规则把东西退回去。
        core.closeAllScreens();
        exiting = true;
        if (!(await save())) {
          exiting = false;
          ending = undefined;
          throw new Error('写盘失败，世界没有退出');
        }
        teardown();
        endSession();
      })());
    /**
     * 极限死亡画面上的删除世界：不写盘，销毁之后删掉存档。锁一直持有到删完；删除失败时也结束，锁照样释放，
     * 世界留在列表里，只剩删除。
     */
    const deleteWorld = (): Promise<void> =>
      (ending ??= (async () => {
        teardown();
        try {
          await storage.deleteWorld(id);
        } catch (error) {
          console.error('删除世界失败', error);
        } finally {
          endSession();
        }
      })());

    installDebugHandle({ core, renderer, hud, chunks, exitToList: exit });
    // 进入时这一次写盘失败不影响进入：改过的区块已经放回，下次写盘再写。
    void save();
    return { exit, ended };
  } catch (error) {
    worker.terminate();
    canvas.remove();
    throw error;
  }
}

/** 一个位置所在的区块。 */
function chunkAt({ x, z }: { readonly x: number; readonly z: number }): ChunkCoord {
  return { cx: chunkOf(Math.floor(x)), cz: chunkOf(Math.floor(z)) };
}
