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
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
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
