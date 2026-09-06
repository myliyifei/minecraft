# CLAUDE.md

浏览器体素生存沙盒游戏。领域术语见 `CONTEXT.md`，架构决策见 `docs/adr/`。

## Agent skills

### Issue tracker

Issue 存放在本仓库的 GitHub Issues，通过 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用五个默认标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
