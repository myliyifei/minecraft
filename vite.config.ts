import { defineConfig, type Plugin } from 'vite';
import { STRINGS } from './src/ui/strings.ts';

/**
 * 把 index.html 里的 `{{key}}` 换成字符串表里的文案。
 * 静态 HTML 因此也带中文（JS 还没跑起来时就能看到标题与加载提示），
 * 而界面文字的唯一来源仍然是 src/ui/strings.ts。
 */
function htmlStrings(): Plugin {
  return {
    name: 'html-strings',
    enforce: 'pre',
    transformIndexHtml(html) {
      return html.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const value = (STRINGS as Record<string, string>)[key];
        if (value === undefined) {
          throw new Error(`index.html 用到了字符串表里没有的文案：${key}`);
        }
        return value;
      });
    },
  };
}

export default defineConfig({
  plugins: [htmlStrings()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    // 产物的大头是 three.js 本身，拆包对首屏没有实质帮助；把阈值抬到它之上，
    // 免得真正的体积回归被这条固定噪音盖住。
    chunkSizeWarningLimit: 600,
  },
});
