import { defineConfig, devices } from '@playwright/test';

const DEV_URL = 'http://localhost:5173';
const PREVIEW_URL = 'http://localhost:4173';

/**
 * 浏览器冒烟测试：只抓适配器接线错误，逻辑覆盖在 Vitest 的核心层测试里。
 *
 * dev 项目跑开发服务器（有调试句柄），prod 项目跑生产构建的预览（不应有调试句柄）。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // headless Chromium 用 SwiftShader 软件渲染 WebGL，需要显式放行。
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  projects: [
    {
      name: 'dev',
      testMatch: /dev\..*\.spec\.ts$/,
      use: { baseURL: DEV_URL },
    },
    {
      name: 'prod',
      testMatch: /prod\..*\.spec\.ts$/,
      use: { baseURL: PREVIEW_URL },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: DEV_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run build && npm run preview',
      url: PREVIEW_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
