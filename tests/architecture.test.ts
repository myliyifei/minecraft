import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function tsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesIn(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去掉注释的源码。
 * 按名字禁用某个 API 时必须只看真代码——注释里写「不用 Math.random」不该算违规。
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** import 与 export ... from 的模块说明符。 */
function importedModules(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    out.push(match[1]!);
  }
  return out;
}

describe('无头游戏核心的隔离（ADR-0001：世界状态与渲染层分离）', () => {
  const coreFiles = tsFilesIn(join(SRC, 'core'));

  it('core 目录下有文件可检查', () => {
    expect(coreFiles.length).toBeGreaterThan(0);
  });

  it('核心不依赖 three', () => {
    for (const file of coreFiles) {
      expect(importedModules(readFileSync(file, 'utf8'))).not.toContain('three');
    }
  });

  it('核心只从 core 内部引入模块', () => {
    for (const file of coreFiles) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        expect(specifier.startsWith('.')).toBe(true);
        expect(specifier).not.toContain('..');
      }
    }
  });

  it('核心不触碰 DOM 与浏览器全局', () => {
    const forbidden = /\b(window|document|navigator|requestAnimationFrame|HTMLElement|localStorage)\b/;
    for (const file of coreFiles) {
      expect(codeOf(file)).not.toMatch(forbidden);
    }
  });
});

describe('地形生成的纯性（ADR-0003：地形生成是纯函数）', () => {
  const coreFiles = tsFilesIn(join(SRC, 'core'));

  it('核心不用非确定性的来源', () => {
    // 同一个种子必须每次长出同一个世界。真随机与真实时钟一旦进入核心，
    // 「先加载 A 再 B 与反过来一致」这类断言就守不住了。
    const forbidden = /\b(Math\.random|Date\.now|performance\.now)\b/;
    for (const file of coreFiles) {
      expect(codeOf(file)).not.toMatch(forbidden);
    }
  });

  it('核心没有模块级的可变状态', () => {
    // 顶层 let / var 会让生成结果依赖调用顺序。常量用 const，逐区块的状态留在函数里。
    const forbidden = /^(?:export\s+)?(?:let|var)\s/m;
    for (const file of coreFiles) {
      expect(codeOf(file)).not.toMatch(forbidden);
    }
  });
});

describe('区块 Worker 的隔离（ADR-0003：Worker 只是适配器）', () => {
  const worker = join(SRC, 'worker/chunk-worker.ts');

  it('Worker 只从核心与协议里引入模块', () => {
    // Worker 里没有 DOM 也没有 three。把渲染层的东西牵进来，页面一打开就报错，
    // 而且是在一个不太好查的地方报。
    for (const specifier of importedModules(readFileSync(worker, 'utf8'))) {
      expect(specifier).toMatch(/^\.\.\/core\/|^\.\//);
    }
  });

  it('Worker 不碰 DOM', () => {
    const forbidden = /\b(window|document|navigator|requestAnimationFrame|localStorage)\b/;
    expect(codeOf(worker)).not.toMatch(forbidden);
  });
});

describe('键位表是单一数据源', () => {
  const table = join(SRC, 'input/keybindings.ts');

  it('按键名只写在键位表里', () => {
    // 键位要能在设置界面里改，前提是别处没有第二份硬编码的按键名。
    const keyNames = /'(?:Key[A-Z]|Digit\d|Space|Escape|Arrow[A-Z]\w+|(?:Shift|Alt|Control)(?:Left|Right))'/;
    for (const file of tsFilesIn(SRC)) {
      if (file === table) continue;
      expect(codeOf(file)).not.toMatch(keyNames);
    }
  });

  it('核心不知道任何按键', () => {
    // 移动意图是核心与输入之间的边界：核心收到的是「向前」，不是「W 被按下」。
    for (const file of tsFilesIn(join(SRC, 'core'))) {
      expect(codeOf(file)).not.toMatch(/\b(?:KeyboardEvent|MouseEvent)\b/);
    }
  });
});

describe('网格生成的可测性', () => {
  // buildChunkMesh 与图集映射必须是纯数据变换，否则核心层测试无法覆盖面剔除。
  const pureRenderFiles = ['render/mesh.ts', 'render/atlas.ts'].map((f) => join(SRC, f));

  it('mesh 与 atlas 不依赖 three', () => {
    for (const file of pureRenderFiles) {
      expect(importedModules(readFileSync(file, 'utf8'))).not.toContain('three');
    }
  });
});
