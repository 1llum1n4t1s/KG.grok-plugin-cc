[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# 适用于 Claude Code 和 Codex 的 Grok 插件

在 Claude Code 或 Codex 中运行 Grok Build，用于代码审查、仓库审计、X 搜索和委派任务。本项目是 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的分支，详见 [NOTICE](NOTICE)。

## 要求与安装

安装 [Grok Build](https://x.ai/cli)，登录或配置其 API 密钥，并安装 Git 2.45 或更高版本（或已向后移植 `--no-lazy-fetch` 的 Git 构建）。在 Windows、macOS 和 Linux 上，请安装 Bun 1.4.4 或更高版本，或 Node.js 22 或更高版本；两者都可用时优先使用 Bun。Grok 的使用费用将计入所使用的账户或 API 密钥。Grok 必须支持 `grok agent stdio`；如有需要，请使用 `grok update` 更新。

在 Windows 上，插件内置了适用于 ia32、x64 和 arm64 运行时的原生辅助程序，无需安装 Rust 或 MSVC。

在 Claude Code 中：

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

对于 Codex，请运行：

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

请启动新的 Codex 任务以加载其 skill。如果两个宿主都使用，需要分别安装。

### 更新

对于 `kagayoi-grok` 等第三方 marketplace，Claude Code 默认关闭自动更新。要开启，请在 Claude Code 会话中运行 `/plugin`，打开 **Marketplaces** 标签页，选择 `kagayoi-grok`，然后选择 **Enable auto-update**。之后，Claude Code 会在会话启动后刷新 marketplace 并更新已安装的插件；运行 `/reload-plugins` 或启动新会话即可加载新版本。如需立即更新，请在 shell 中运行 `claude plugin update grok@kagayoi-grok`。

对于 Codex，请运行 `codex plugin marketplace upgrade kagayoi-grok` 刷新 marketplace，然后启动新的 Codex 任务。

## 命令

Claude Code 提供 `/grok:review`、`/grok:adversarial-review`、`/grok:audit`、`/grok:rescue`、`/grok:x` 和 `/grok:setup`。在 Codex 中，请选择对应的 `grok:source-command-<name>` skill。审查和审计为只读；rescue 可以请求编辑，而 X 搜索保持只读。Setup 用于检查 Grok 的认证状态。

在 Windows 上，请使用 `/grok:review --scope working-tree` 审查本地更改。`auto` 和 `working-tree` 范围需要完整且安全的 Windows 快照，若无法获取则会失败。在 macOS/Linux 上，请显式使用 `/grok:review --scope branch` 或 `--base <ref>` 审查已提交的更改；未提交的更改不包含在比较差异中，但周边文件仍可能从工作树中读取。在任何平台上，都可以使用 `/grok:audit authentication` 将整个仓库的审计聚焦于特定主题，或使用 `/grok:rescue <task>` 委派任务。审查、对抗式审查和审计还接受 `--language <BCP 47 tag>`。当安装或认证失败时，请运行 `/grok:setup`，并按照其报告的错误和 Grok 的登录指引操作。

每次调用都会在前台运行一个新的 Grok 会话，并直接返回其结果。如需继续对话，请使用 Grok 自身的界面。自动审查，以及此前的 status、result、cancel、state-lock 和 task-resume 命令，companion 已不再支持。

companion 会启动本地安装的 Grok CLI。它会在 ACP 文件请求时检查路径，并应用只读权限允许列表；明确请求的写入任务可以修改工作区。Grok Build 负责处理其内置的文件系统和 shell 操作、外部访问以及认证。companion 不会介入每一次 I/O 操作，也不提供操作系统沙箱，并且不保证完全的访问隔离（包括通过符号链接的访问）。在依赖 Grok 的输出和更改之前，请先进行审查。

## 显示语言

companion 自身的消息（setup 结果、审查标题、诊断信息和帮助）会以您所处环境的语言显示。它依次检查 `GROK_PLUGIN_LANGUAGE`，然后是 `LC_ALL`、`LC_MESSAGES` 和 `LANG`，再检查系统显示语言，最后回退到英语。支持的语言为 `ja`、`en`、`zh-CN`、`zh-TW`、`ko`、`es`、`fr`、`de` 和 `pt-BR`。这与用于设置 Grok 审查文本语言的 `--language` 是相互独立的。Grok 自身的输出，以及来自操作系统或 Grok 的错误详情不会被翻译。

## 故障排查

如果某次调用报告 HTTP 402 及 `usage balance exhausted`，说明 Grok Build 的用量余额已耗尽。请在余额恢复后重试。超时、权限被拒绝、审查不完整或未确认 agent 已停止，均视为调用失败；请勿将部分输出当作已完成的审查或任务。

在只读审查期间，即使脚本仅用于读取文件，Python、Node.js、Bun 和 shell 包装器也会被拒绝。Grok Build 可能在权限被拒绝后以 `cancelled` 结束该轮。请使用内置文件工具检查 JSON 和其他证据；无法获取的证据仍视为未验证。审查提示词会在检查开始前提供这些限制。

关于从源码构建、开发命令和验证，请参阅 [Development](CONTRIBUTING.md#english)。运行时结构与边界请参阅 [DESIGN.md](DESIGN.md)。
