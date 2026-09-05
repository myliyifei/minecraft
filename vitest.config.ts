import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 核心层必须能在 Node 中无浏览器依赖运行，这是主测试接缝。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
