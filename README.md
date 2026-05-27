# OpenClaude

基于 `@anthropic-ai/claude-code` 源码重建并独立分叉的终端版 OpenClaude CLI（Bun 构建）。本仓库提供安装脚本与预编译二进制发布。

## 安装

在 **macOS / Linux**（需 **x64** 或 **arm64**）下，使用安装脚本一键安装到 `~/.local/bin/openclaude`：

```bash
curl -fsSL https://raw.githubusercontent.com/andforce/Openclaude/openclaude/install.sh | bash
```

**指定版本**（格式 `x.x.x`）：

```bash
curl -fsSL https://raw.githubusercontent.com/andforce/Openclaude/openclaude/install.sh | bash -s -- 2.1.88
```

**依赖**：系统需有 `curl` 或 `wget`；安装脚本会优先使用 `jq` 解析 GitHub API，没有 `jq` 时会用纯 shell 回退解析。

若安装完成后提示 `~/.local/bin` 不在 `PATH` 中，请将下面一行加入 shell 配置（如 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装完成后可执行：

```bash
openclaude --help
```

## 数据目录

OpenClaude 默认将运行时配置、会话、插件、缓存等数据写入 `~/.openclaude`。如需自定义位置，可设置：

```bash
export OPENCLAUDE_CONFIG_DIR="$HOME/.config/openclaude"
```

## 调试 API 请求日志

排查模型提供方、Base URL 或 `/model` 切换是否生效时，可以打开 debug 日志并过滤 API 请求行。

安装版：

```bash
openclaude --debug-file /tmp/openclaude-debug.log
```

源码调试版：

```bash
./run-dev.sh -- --debug-file /tmp/openclaude-debug.log
```

另开一个终端查看请求：

```bash
tail -f /tmp/openclaude-debug.log | rg "API REQUEST|API:request|Anthropic SDK"
```

`API REQUEST` 日志会打印完整请求 URL，便于确认实际请求到了哪个提供方：

```text
[API REQUEST] https://example.com/anthropic/v1/messages x-client-request-id=... source=repl_main_thread
```

其中 `source=repl_main_thread` 是主对话请求；`generate_session_title` 等来源通常是后台标题生成或辅助请求。

## 斜杠命令（节选）

在 REPL 中可使用以下命令（完整列表以程序内 `/help` 为准）。

### `/connect`

配置并连接模型提供方，交互式选择其一：

1. **GitHub Copilot** — 设备码 OAuth，使用 Copilot 侧模型（如 GPT-4o、Claude 等）
2. **OpenRouter** — 填写 API Key，统一访问多种模型
3. **Custom OpenAI-compatible API** — 自定义 Base URL，可选 API Key，从 `/v1/models` 选模型
4. **Custom Anthropic-compatible API** — 同上，兼容 Anthropic 风格接口

连接成功后，凭证会写入全局配置，供会话使用。

### `/disconnect`

断开已连接的提供方：从列表中选择要移除的一项。若断开的是当前**活跃**提供方，会自动切换到剩余连接中的第一个（若有）；若移除后没有任何连接，会进入重新登录流程。需先通过 `/connect` 建立过连接才有可断开项。

### `/telegram`

配置 **Telegram Bot 桥接**：设置 Bot Token、允许的 Telegram user id 等，用于在 Telegram 侧与 CLI 会话联动。未正确配置 Token 或授权用户时，相关功能会报错提示先在 `/telegram` 中完成配置。

---

从源码本地构建请参考仓库内 `AGENTS.md` / `CLAUDE.md`（需 **Bun** 与 **pnpm**）。
