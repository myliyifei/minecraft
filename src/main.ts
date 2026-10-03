import './ui/style.css';
import { installListDebugHandle, removeListDebugHandle, type EnterOutcome } from './debug';
import { loadSettings } from './settings';
import { decodeWorldBlob, encodeWorldFile, WORLD_FILE_EXTENSION } from './storage/world-file';
import { withWorldLock } from './storage/world-lock';
import { openWorldStorage } from './storage/world-storage';
import { installSettingsScreen } from './ui/settings-screen';
import { STRINGS } from './ui/strings';
import { installWorldList, type NewWorld } from './ui/world-list';
import { startWorldSession, type WorldStart } from './world-session';

/** 进入世界之前要备好的：名称与起点。备不出来时是没进去的原因。 */
type Prepared = { readonly name: string; readonly start: WorldStart } | Exclude<EnterOutcome, 'entered' | 'locked'>;

/**
 * 接线层：打开存储模块，显示世界列表，按列表上的点击进入、新建、删除、导出、导入世界。逻辑一律在核心里，世界里的组装在
 * src/world-session.ts，这里只管页面在列表与世界之间怎么切换、什么时候取锁。
 * 标题与加载提示由构建期从 src/ui/strings.ts 注入 index.html，不在这里设置。
 *
 * 页面上同一时刻只做一件事：进入（直到退出世界）、删除、导出、导入各自从开始到结束都占着 `busy`，要刷新列表的
 * 等到列表刷新完，期间列表上的点击不处理。不同世界的锁互不排斥，没有这一条的话删除完成后的刷新会把列表重新显示在正在进入的世界上，
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

  /** 列表上的一次删除、导出或导入：页面空闲时才做，做完之前占着 `busy`。出的错交给控制台，label 说是哪一件。 */
  const exclusive = (label: string, task: () => Promise<void>): void => {
    if (busy) return;
    busy = true;
    void task()
      .catch((error: unknown) => console.error(label, error))
      .finally(() => {
        busy = false;
      });
  };

  /** 删除一个世界：先取锁，取不到就提示、不删。 */
  const deleteWorld = async (id: string): Promise<void> => {
    const lock = await withWorldLock(id, () => storage.deleteWorld(id));
    await showList(lock.ok ? undefined : STRINGS.worldInUse);
  };

  /**
   * 导出一个世界：先取锁，取不到就提示、不导出；取到后把四张表里的记录原样拼成文件下载。版本不兼容的世界照样
   * 导出，文件头上是它自己的版本。超过导入上限的不导出：那样的文件导不回来。世界已经被另一个标签页删掉时刷新列表。
   */
  const exportWorld = async (id: string): Promise<void> => {
    const lock = await withWorldLock(id, async () => {
      const records = await storage.readRecords(id);
      if (!records) return 'missing';
      const encoded = encodeWorldFile(records);
      if (!encoded.ok) {
        console.warn('世界超过导出文件的上限', encoded.reason);
        return 'tooLarge';
      }
      download(new Blob([encoded.buffer]), `${records.meta.name}${WORLD_FILE_EXTENSION}`);
      return 'exported';
    });
    if (!lock.ok) list.notify(STRINGS.worldInUse);
    else if (lock.value === 'missing') await showList();
    else if (lock.value === 'tooLarge') list.notify(STRINGS.exportTooLarge);
  };

  /**
   * 导入一个文件：逐项校验，任一不符整份拒绝、提示，列表不变；通过时以新的 id 写成一个新世界，刷新列表。
   * 新 id 没有别的标签页知道，不取锁。
   */
  const importWorld = async (file: File): Promise<void> => {
    const decoded = await decodeWorldBlob(file);
    if (!decoded.ok) {
      console.warn('导入的文件无效', decoded.reason);
      list.notify(STRINGS.importInvalid);
      return;
    }
    try {
      await storage.importWorld(crypto.randomUUID(), decoded.file);
    } catch (error) {
      console.error('导入写盘失败', error);
      list.notify(STRINGS.importFailed);
      return;
    }
    await showList();
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
    delete: (id) => exclusive('删除世界失败', () => deleteWorld(id)),
    export: (id) => exclusive('导出世界失败', () => exportWorld(id)),
    import: (file) => exclusive('导入世界失败', () => importWorld(file)),
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

/** 让浏览器把 blob 存成名为 name 的文件。 */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // 下载在点击之后异步开始，过一会儿再释放。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

void main();
