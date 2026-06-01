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

1. **Custom Anthropic-compatible API** — 自定义 Base URL，可选 API Key，从 `/v1/models` 选模型
2. **Custom OpenAI-compatible API** — 自定义 Base URL，可选 API Key，从 `/v1/models` 选模型，兼容 OpenAI、Ollama、vLLM、LM Studio 等
3. **DeepSeek** — 填写 API Token，自动拉取模型列表
4. **Kimi Code** — 填写 API Token，自动拉取模型列表
5. **OpenRouter Anthropic-compatible API** — 填写 API Key，统一访问多种模型

连接成功后，凭证会写入全局配置，供会话使用。

### `/disconnect`

断开已连接的提供方：从列表中选择要移除的一项。若断开的是当前**活跃**提供方，会自动切换到剩余连接中的第一个（若有）；若移除后没有任何连接，会进入重新登录流程。需先通过 `/connect` 建立过连接才有可断开项。

### `/telegram`

配置 **Telegram Bot 桥接**：设置 Bot Token、允许的 Telegram user id 等，用于在 Telegram 侧与 CLI 会话联动。未正确配置 Token 或授权用户时，相关功能会报错提示先在 `/telegram` 中完成配置。

### `/goal`

设置或管理一个**长跑式自主目标**。设定后，agent 会在每一轮自动朝目标推进，直到：达成、判定不可达、被暂停、达到预算/时间上限，或触达自动续跑次数上限。

用法：

```text
/goal set <objective>                     # 设定目标并开始
/goal <objective>                         # 同上（简写）
/goal --budget=$5 --time=30m <objective>  # 带预算/时长上限
/goal pause | resume | clear | edit       # 暂停 / 恢复 / 清除 / 编辑
```

> 需要 **2.1.92** 及以上版本（旧版本如 2.1.91 不含此命令）。

### `/debug-mode`

运行时调试模式，用于排查 bug：引导 agent 按证据驱动的流程插入临时探针、收集运行时日志、定位根因、修复并验证，最后清理所有探针代码。

用法：

```text
/debug-mode <bug 描述>                        # 进入调试模式，描述问题现象
/debug-mode 点击保存按钮后页面无响应，没有报错   # 示例
```

调试流程为 **7 个检查点**：

0. **Triage** — 收集缺失的复现信息
1. **Plan Probes** — 读代码、提假设、规划探针位置
2. **Init Session** — 初始化 `.openclaude-debug/` 目录与 `debug.log`
3. **Insert Probes** — 在源文件中插入 `DEBUG PROBE [N]` 探针块
4. **Reproduce & Collect** — 复现问题，收集日志
5. **Analyze** — 基于日志证据定位根因
6. **Fix & Verify** — 最小修复，保留探针验证
7. **Cleanup** — 移除所有探针，清理调试目录

探针支持 **TypeScript / Python / Java / Kotlin / Swift / SwiftUI / Objective-C / C / C++ / Go / Rust / Shell** 及前端浏览器 `console.log`，并支持 **Android (adb logcat)** 与 **iOS (idevicesyslog / xcrun)** 物理设备调试。

---

从源码本地构建请参考仓库内 `AGENTS.md` / `CLAUDE.md`（需 **Bun** 与 **pnpm**）。
