# 体素世界

浏览器体素生存沙盒游戏。领域术语见 [`CONTEXT.md`](CONTEXT.md)，架构决策见 [`docs/adr/`](docs/adr/)。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
```

## 命令

| 命令                   | 作用                                          |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | 开发服务器                                    |
| `npm run build`        | 类型检查 + 生产构建到 `dist/`                 |
| `npm run preview`      | 预览生产构建（http://localhost:4173）         |
| `npm run typecheck`    | 只做类型检查                                  |
| `npm test`             | Vitest 核心层测试（Node 环境）                |
| `npm run test:e2e`     | Playwright 浏览器冒烟测试（Chromium）         |
| `npm run gen:atlas`    | 重新生成方块贴图图集                          |

首次跑端到端测试前需要 `npx playwright install chromium`。

调试句柄（`window.__VOXEL__`）在开发服务器上默认挂着，生产构建不挂。要得到一个带句柄的
**测试构建**（生产模式 + 句柄，用于在真实产物上跑端到端测试）：

```bash
VITE_DEBUG_HANDLE=true npm run build
```

## 分层

```
src/
├── core/          无头游戏核心：纯 TypeScript，不依赖 three.js 与 DOM
├── render/        渲染适配器：mesh.ts / atlas.ts 是纯数据变换，renderer.ts 用 three.js
├── input/         输入适配器：键鼠事件翻译成移动意图，keybindings.ts 是键位的唯一来源
├── ui/            界面文字与样式
├── loop.ts        固定 20 tick/s 的游戏循环
├── debug.ts       调试句柄，只在开发与测试构建中挂到 window
├── demo-scene.ts  临时：摆几块方块把 6 种贴图显示出来，issue #6 / #7 落地后删除
└── main.ts        接线层
```

规则：

- 游戏逻辑一律写在 `src/core/`，它必须能在 Node 里无依赖实例化——这是主测试接缝，`tests/architecture.test.ts` 会守住这条线。
- 面剔除与贴图映射（`src/render/mesh.ts`、`src/render/atlas.ts`）不许 import three.js，这样它们能在 Node 里测。
- 输入适配器只把事件翻译成意图（`MoveIntent`）与视角增量，走多快、跳多高、撞不撞墙都在核心里。核心不认识任何按键。
- 玩家可见的文字只写在 `src/ui/strings.ts`。
- 硬度、掉落表、经验表、贴图映射、键位表都是数据，加内容只加数据行。按键名只写在 `src/input/keybindings.ts`。

## 贴图

`public/textures/atlas.png` 由 `tools/gen-atlas.mjs` 程序化生成，是本项目的原创 CC0 素材，
不含任何《我的世界》原版资源。详见 [`public/textures/LICENSE.md`](public/textures/LICENSE.md)。
