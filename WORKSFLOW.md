# Claude Code Dynamic Workflows 实现原理分析

> 基于 Anthropic 官方 Dynamic Workflows + 知乎分析文章整理

## 核心概念

Dynamic Workflows 把编排逻辑从 Claude 的"逐轮决策"搬进了**一段可执行的 JavaScript 脚本**。脚本自己持有循环、分支和中间结果，Claude 的上下文里只留下最终答案。

与 Subagent 的区别：
- **Subagent**：Claude 逐轮调度，每个 subagent 的结果都回到主上下文，注意力被过程信息稀释
- **Workflow**：编排写成代码，运行时是确定性 JS 引擎，只有 `agent()` 调用点才产生 LLM 请求

## 架构（四部件）

| 部件 | 职责 |
|------|------|
| **编排脚本** (Orchestration Script) | Claude 根据任务自动生成的 JS，定义控制流 |
| **隔离运行时** (Isolated Runtime) | 在独立于对话的 vm 环境里执行脚本，会话期间终端可交互 |
| **Subagents 池** | 脚本通过 `agent()` spawn 出来的工作者，负责实际读写和命令执行 |
| **脚本变量** (Script Variables) | 中间结果留在脚本里，不进 Claude 上下文窗口 |

**关键线**：subagent 的结果先流进脚本变量 → 运行时内部完成循环和校验 → 最后只有汇总答案回到 Claude。

## 原语

| 原语 | 作用 |
|------|------|
| `agent(prompt, opts?)` | spawn 一个 subagent。带 schema 返回已校验对象，否则返回字符串 |
| `parallel(thunks)` | 并发跑一批任务（屏障：等全部完成） |
| `pipeline(items, s1, s2, ...)` | 每个 item 独立走完所有 stage（无屏障，item 可在不同 stage 交错） |
| `phase(title)` | 进度分组，后续 agent 归入该组 |
| `log(msg)` | 显示一行进度 |
| `workflow(name, args)` | 内联调一个子 workflow（只能嵌一层） |
| `args` / `budget` | 外部参数 / token 预算（`budget.total`、`budget.remaining()`） |

## meta 必须是纯字面量

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
```

- 不能有变量、函数调用、模板插值
- 只允许负数字面量的 UnaryExpression（如 `-1`）
- `phases` 只是文档，实际分组由 `phase()` 驱动

## 执行模型与硬约束

| 约束 | 值 |
|------|------|
| 最大并发 subagent | `min(16, CPU核数-2)`，上限 16 |
| 单次最大 agent 数 | 1000（防死循环烧钱的保险丝） |
| 脚本权限 | 无文件系统/shell 访问，所有读写通过 subagent |
| 子 agent 权限 | `acceptEdits` 模式，不逐个弹窗 |
| 运行中途 | 不接受人工输入（除权限确认弹窗） |
| 恢复 | 同会话内可按 `resumeFromRunId` 恢复（按 runId 缓存，未改动的 agent 调用跳过） |
| 跨会话 | 不可恢复，退出后从头再跑 |

## 结构化输出 (Schema Validation)

- `agent(prompt, { schema: JSONSchema })` 注入一个 `structured_output` 工具到子 agent
- 子 agent 必须调用 `structured_output` 作为最终动作，返回值即为 `agent()` 的返回
- 带 `terminate: true` — 子 agent 在调用后立即结束，不需要额外的 assistant follow-up turn
- JSON Schema 转为运行时校验（官方用 TypeBox，OpenClaude 改用 Zod）

## 并发与管线的分界

- **parallel**：屏障模式，等全部完成后继续；适合需要全集去重/合并/条件判断的场景
- **pipeline**：无屏障，每个 item 各自独立流过所有 stage，互不等待；适合大部分场景

## 进度显示

运行中的 workflow 会显示：
1. 总体进度行（完成/总数 + 耗时）
2. Phases 面板（每个阶段的完成率、running/errors/skipped）
3. 当前活跃 phase 的 agent 详情表（label、model、tokens、tools、duration）
4. 最近日志行

## 三种触发方式

1. **Prompt 中出现 "workflow" 关键词** → Claude Code 高亮提示，Alt+W 忽略
2. **Ultracode 模式** (`/effort ultracode`) → Claude 自动判断是否启动 workflow
3. **已保存的 workflow** → 以 `/workflow-name` 斜杠命令形式运行

## 保存的 Workflow

| 位置 | 可见范围 |
|------|---------|
| `.claude/workflows/` | 项目级，团队共享 |
| `~/.claude/workflows/` | 个人级，跨项目可用 |

同名时项目级优先。

## 适用场景

- **批量排查**：全仓库 bug 扫描、安全审计、性能优化
- **大规模迁移**：框架替换、API 弃用迁移、跨语言移植（Bun Zig→Rust 案例：11天、75万行、99.8% 测试通过）
- **对抗式验证**：多角度各跑一遍 → 派对抗 agent 推翻 → 迭代到收敛
- **长尾清理**：overnight workflow，自动扫描 + 逐个开 PR

## 不适合的场景

- 一两步就能搞定的小修补
- 需要中途频繁拍板的探索性工作
- 碰安全和支付这类高风险代码的改动
