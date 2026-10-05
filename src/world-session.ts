import type { Difficulty } from './core/difficulty';
import { GameCore } from './core/game';
import type { Snapshot } from './core/snapshot';
import { createTerrain } from './core/terrain';
import { chunkKey, chunkOf, chunksAround, ORIGIN_CHUNK, type ChunkCoord } from './core/world';
import { installDebugHandle, removeDebugHandle } from './debug';
import { installPlayerControls } from './input/controls';
import { startGameLoop } from './loop';
import { ATLAS_PATH, CRACK_PATH } from './render/atlas';
import { loadPixelTexture, WorldRenderer } from './render/renderer';
import type { Settings } from './settings';
import type { WorldStorage } from './storage/world-storage';
import { installHud } from './ui/hud';
import type { SettingsScreen } from './ui/settings-screen';
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
  /** 设置（ADR-0020）：视距、灵敏度、键位与三个画面开关。改动当场生效。 */
  readonly settings: Settings;
  /** 设置界面。暂停菜单上的「设置」打开它，关掉回到暂停菜单。 */
  readonly settingsScreen: SettingsScreen;
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
 * 兑现时处于暂停，显示暂停菜单（ADR-0019）：玩家点回到游戏、锁定生效才开始推进。进入之后马上写一次盘：
 * 新建的世界从此出现在世界列表里，读档的世界更新上次游玩时间。
 */
export async function startWorldSession({
  storage,
  id,
  name,
  start,
  settings,
  settingsScreen,
}: WorldSessionOptions): Promise<WorldSession> {
  // 每个世界一块新画布：退出时连同上面的监听器一起丢掉，下一个世界的渲染器拿到的是全新的 WebGL 上下文。
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  document.body.prepend(canvas);
  // 地形生成放在 Worker 里：铺满视距要生成几百个区块，放在主线程上会连续掉帧。
  const worker = new Worker(new URL('./worker/chunk-worker.ts', import.meta.url), { type: 'module' });
  // 进入的半路出错时也要退订，否则这个没进去的世界还挂在设置上。
  let unsubscribe = (): void => {};

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

    // 种子只有一个出处：Worker 与核心都用区块来源记着的那个，两边不可能对不上。地形对象的查询在主线程上
    // 按同一个种子算，只把生成器换成 Worker 那一侧的区块来源。
    const terrain = (worldSeed: number) => ({ ...createTerrain(worldSeed), generateChunk: chunks.source });
    const { viewRadius } = settings;
    const core =
      'restore' in start
        ? new GameCore({ restore: start.restore, terrain, viewRadius })
        : new GameCore({ seed: chunks.seed, difficulty: start.difficulty, terrain, viewRadius });
    // 设置界面上拖视距滑条：改小时超出范围的区块当场卸载，改大时缺的从下一 tick 起按平时的节奏加载。
    unsubscribe = settings.subscribe(() => {
      if (core.viewRadius !== settings.viewRadius) core.setViewRadius(settings.viewRadius);
    });

    const [texture, crackTexture] = await Promise.all([loadPixelTexture(ATLAS_PATH), loadPixelTexture(CRACK_PATH)]);
    const renderer = new WorldRenderer({ canvas, core, texture, crackTexture, settings });
    // 首帧之前把已经到位的区块一次铺完；之后每帧只补几个，见 MESH_BUDGET_PER_FRAME。
    renderer.syncChunkMeshes(Infinity);
    renderer.render();

    // 上次写盘成功时快照里的 tick 计数，与上次写盘失败了没有（暂停菜单上提示）。
    let savedTicks = core.tickCount;
    let saveFailed = false;
    /** 自上次写盘以来推进过 tick，或有改过的区块：这时离开页面会丢进度。 */
    const unsaved = (): boolean => core.tickCount !== savedTicks || core.unsavedChunkCount > 0;

    // 世界已经销毁（退出写完盘、开始删除）：之后不再写盘。排着的那一次也作废，不然删除之后它会把世界写回来。
    let closed = false;

    /**
     * 当场取快照写一次盘，返回成没成。失败时把这次取走的已改区块放回核心，下次写盘再写。
     *
     * 取快照之前先关掉全部界面：光标物品与合成网格不进快照（ADR-0018）。排着的那一次到写的时候玩家可能已经回到
     * 游戏、又打开了背包，所以关界面与取快照放在同一步，不靠进入暂停时关的那一次。
     */
    const writeNow = async (): Promise<boolean> => {
      if (closed) return false;
      core.closeAllScreens();
      const ticks = core.tickCount;
      const result = await storage.saveWorld(id, name, core.snapshot());
      if (result.ok) {
        savedTicks = ticks;
        saveFailed = false;
        return true;
      }
      core.returnUnsavedChunks(result.chunks);
      saveFailed = true;
      console.error('写盘失败', result.error);
      return false;
    };
    /** 正在写的那一次，与排在它后面的那一次。 */
    let writing: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    /**
     * 写一次盘。正在写时排到它后面，等它写完再取快照；已经排着一次就并进那一次，拿到的是同一个 Promise：
     * 连按几次 Esc 只多写一次，而排着的那一次写的是最新的世界。
     */
    const save = (): Promise<boolean> => {
      if (queued) return queued;
      if (!writing) {
        writing = writeNow().finally(() => (writing = undefined));
        return writing;
      }
      const next = (): Promise<boolean> => {
        queued = undefined;
        return save();
      };
      queued = writing.then(next, next);
      return queued;
    };

    let endSession = (): void => {};
    const ended = new Promise<void>((resolve) => (endSession = resolve));
    /** 正在进行的退出或删除。退出写盘失败时清掉，可以再退一次。 */
    let ending: Promise<void> | undefined;
    // 退出写盘期间不推进 tick，暂停也不另写：退出那一次写的就是最后的世界。
    let exiting = false;

    // 端到端冒烟测试经调试句柄打开它：暂停时照样推进、不显示暂停菜单，见 `DebugHandle.setIgnorePause`。
    let ignorePause = false;
    /** 世界此刻算不算暂停：循环推不推进、暂停菜单显不显示都看它。 */
    const paused = (): boolean => controls.paused && !ignorePause;
    // 进入暂停的那一刻写盘（ADR-0019）。
    const controls = installPlayerControls(
      canvas,
      core,
      {
        onPause: () => {
          if (!exiting) void save();
        },
      },
      settings,
    );
    const hud = installHud(
      document.body,
      core,
      {
        // 重生按钮按下那一刻抓回指针锁定：锁定只在用户手势里放行，所以由按钮的 click 直接调，不等下一帧。
        afterRespawn: () => controls.grabPointer(),
        deleteWorld: () => void deleteWorld(),
        // 回到游戏同理，暂停在锁定生效时由输入层解除。退出写盘期间不理会：世界写完就销毁。
        resume: () => {
          if (!exiting) controls.resume();
        },
        // 设置界面开着时仍处于暂停：它不请求锁定。关掉回到暂停菜单。
        openSettings: () => settingsScreen.open(),
        // 写盘失败时世界不退出，暂停菜单上提示写盘失败，可以再点一次。
        saveAndExit: () => void exit().catch(() => {}),
      },
      {
        get paused() {
          return paused();
        },
        get resumeRejected() {
          return controls.resumeRejected;
        },
        get saveFailed() {
          return saveFailed;
        },
      },
    );
    hud.update();

    // 极限下死亡那一 tick 核心置已死亡标记，这里在那一帧写一次盘：之后关掉页面，世界列表里也只剩删除。每帧而不是
    // 每 tick 查，调试句柄在循环之外推进的 tick 也查得到。
    let deathSaved = core.hardcoreDead;
    // 加载画面之后处于暂停，玩家点回到游戏、锁定生效才开始推进（输入层的 `paused`）。
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
      () => !paused() && !exiting,
    );

    // 只在暂停与退出时写盘，回到游戏之后的改动不在盘上：这时关掉页面先弹浏览器的离开确认。
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!unsaved()) return;
      event.preventDefault();
      // 老一些的浏览器只认 returnValue。
      event.returnValue = '';
    };
    // 确认离开之后尽力再写一次。页面隐藏时已经暂停写过一次，那一次还没提交的话这一次排在它后面（存储模块
    // 按调用顺序提交），不走 `save` 的排队：排队要等前一次写完才取快照，页面等不到那时候。
    const onPageHide = (): void => {
      if (exiting || !unsaved()) return;
      void writeNow();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);

    /** 卸下这一个世界挂的全部东西。存档不在这里处理。 */
    const teardown = (): void => {
      closed = true;
      stopLoop();
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
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
     * 写进去的就是退出那一刻的世界：正在写的那一次是暂停时取的快照，退出这一次排在它后面。
     */
    const exit = (): Promise<void> =>
      (ending ??= (async () => {
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

    installDebugHandle({
      core,
      renderer,
      hud,
      chunks,
      exitToList: exit,
      setIgnorePause: (on) => (ignorePause = on),
    });
    // 进入时这一次写盘失败不影响进入：改过的区块已经放回，下次写盘再写。
    void save();
    return { exit, ended };
  } catch (error) {
    unsubscribe();
    worker.terminate();
    canvas.remove();
    throw error;
  }
}

/** 一个位置所在的区块。 */
function chunkAt({ x, z }: { readonly x: number; readonly z: number }): ChunkCoord {
  return { cx: chunkOf(Math.floor(x)), cz: chunkOf(Math.floor(z)) };
}
