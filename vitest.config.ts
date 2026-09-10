import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 核心层必须能在 Node 中无浏览器依赖运行，核心层的测试都依赖这一点。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
