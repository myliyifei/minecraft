import './ui/style.css';
import { installListDebugHandle, removeListDebugHandle, type EnterOutcome } from './debug';
import { loadSettings } from './settings';
import { withWorldLock } from './storage/world-lock';
import { openWorldStorage } from './storage/world-storage';
import { installSettingsScreen } from './ui/settings-screen';
import { STRINGS } from './ui/strings';
import { installWorldList, type NewWorld } from './ui/world-list';
import { startWorldSession, type WorldStart } from './world-session';

/** 进入世界之前要备好的：名称与起点。备不出来时是没进去的原因。 */
type Prepared = { readonly name: string; readonly start: WorldStart } | Exclude<EnterOutcome, 'entered' | 'locked'>;

/**
 * 接线层：打开存储模块，显示世界列表，按列表上的点击进入、新建、删除世界。逻辑一律在核心里，世界里的组装在
 * src/world-session.ts，这里只管页面在列表与世界之间怎么切换、什么时候取锁。
 * 标题与加载提示由构建期从 src/ui/strings.ts 注入 index.html，不在这里设置。
 *
 * 页面上同一时刻只做一件事：进入（直到退出世界）与删除各自从开始到列表刷新完都占着 `busy`，期间列表上的
 * 点击不处理。不同世界的锁互不排斥，没有这一条的话删除完成后的刷新会把列表重新显示在正在进入的世界上，
 * 再点一次就同时开了两个世界。
 */
async function main(): Promise<void> {
  const loading = document.querySelector('#loading');
  if (!(loading instanceof HTMLElement)) throw new Error('页面缺少 #loading 元素');

  // 页面打开时先读设置（ADR-0020），再显示世界列表。设置界面只有一个，世界列表与暂停菜单都打开它。
  const settings = loadSettings();
  const settingsScreen = installSettingsScreen(document.body, settings);
  const storage = await openWorldStorage();
  let busy = false;

  /**
   * 取这个世界的锁、备好起点、进入，一直持有锁玩到退出。加载画面消失时兑现成 'entered'，没进去时兑现成原因；
   * 退出之后释放锁，再刷新世界列表。取不到锁时在列表上提示。加载画面在取到锁之后才显示，取不到时列表不动。
   */
  const play = (id: string, prepare: () => Promise<Prepared>): Promise<EnterOutcome> =>
    new Promise<EnterOutcome>((settle, fail) => {
      busy = true;
      void withWorldLock(id, async () => {
        const prepared = await prepare();
        if (typeof prepared === 'string') {
          settle(prepared);
          return;
        }
        list.hide();
        removeListDebugHandle();
        loading.hidden = false;
        const session = await startWorldSession({ storage, id, ...prepared, settings, settingsScreen });
        loading.hidden = true;
        settle('entered');
        // 锁在这个 Promise 兑现时释放：要一直等到退出世界。
        await session.ended;
      })
        .then(
          (lock) => {
            if (lock.ok) return showList();
            settle('locked');
            return showList(STRINGS.worldInUse);
          },
          (error: unknown) => {
            fail(error);
            return showList();
          },
        )
        .finally(() => {
          loading.hidden = true;
          busy = false;
        });
    });

  /** 进入一个已有的世界。版本不兼容、极限已死亡的不进入：列表里本来就不给这两种进入按钮。 */
  const enterWorld = (id: string): Promise<EnterOutcome> =>
    play(id, async () => {
      const loaded = await storage.loadWorld(id);
      if (loaded.status !== 'ok') return loaded.status;
      if (loaded.snapshot.hardcoreDead) return 'hardcoreDead';
      return { name: loaded.meta.name, start: { restore: loaded.snapshot } };
    });

  /** 新建一个世界并进入。id 在这里生成，存储模块不另外提供。 */
  const createWorld = ({ name, seed, difficulty }: NewWorld): Promise<EnterOutcome> =>
    play(crypto.randomUUID(), async () => ({ name, start: { seed, difficulty } }));

  /** 删除一个世界：先取锁，取不到就提示、不删。 */
  const deleteWorld = async (id: string): Promise<void> => {
    busy = true;
    try {
      const lock = await withWorldLock(id, () => storage.deleteWorld(id));
      await showList(lock.ok ? undefined : STRINGS.worldInUse);
    } finally {
      busy = false;
    }
  };

  /** 进入世界时出的错：世界列表已经退回来了，错误交给控制台。 */
  const logEnterError = (error: unknown): void => console.error('进入世界失败', error);

  const list = installWorldList(document.body, {
    enter: (id) => {
      if (!busy) void enterWorld(id).catch(logEnterError);
    },
    create: (world) => {
      if (!busy) void createWorld(world).catch(logEnterError);
    },
    delete: (id) => {
      if (!busy) void deleteWorld(id).catch((error: unknown) => console.error('删除世界失败', error));
    },
    // 正在进入时不打开：世界的画布与暂停菜单随后挂上，会画在设置界面之上。
    settings: () => {
      if (!busy) settingsScreen.open();
    },
  });

  /** 从存储重新读一遍世界列表并显示，挂上列表页的调试句柄。 */
  async function showList(message?: string): Promise<void> {
    list.show(await storage.listWorlds());
    if (message) list.notify(message);
    installListDebugHandle({
      listWorlds: () => storage.listWorlds(),
      enterWorld: (id) => (busy ? Promise.reject(new Error('页面正在进入或删除世界')) : enterWorld(id)),
    });
  }

  await showList();
}

void main();
