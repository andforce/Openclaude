# DeepSeek 缓存策略分析与落地计划

> 本文档记录对 DeepSeek KV 缓存机制的分析、参考项目 [DeepSeek-Reasonix](https://github.com/esengine/reasonix) 的设计拆解,以及 OpenClaude 当前状态对照与改进计划。
>
> 核心结论:**DeepSeek 的 prefix cache 虽然在服务端自动开启,但命中率几乎完全由 client 端的"请求字节序"决定。** CLI 必须把请求数据的格式和顺序设计成"前缀字节不变",才能达到最优缓存。

---

## 一、缓存机制的本质(为什么 client 是决定性的)

DeepSeek 的 prefix cache 命中条件极其苛刻:

> 当前请求的 `messages`(含 `system`、`tools`)序列化后的**字节前缀**,必须与上一次请求**逐字节相同**。一旦某个 byte 变了,从那个 byte 往后全部 miss。

- 计费:cache hit ≈ miss 的 **10%**
  - 响应里的 `prompt_cache_hit_tokens`(命中,便宜)
  - `prompt_cache_miss_tokens`(未命中,全价)
- 官方文档:<https://api-docs.deepseek.com/zh-cn/guides/kv_cache>

所以"最优缓存策略" = **让每一轮请求的前缀尽可能长地保持字节恒定**。

参考项目 Reasonix 的 README 原话:

> *Cache stability isn't a feature you turn on; it's an invariant the loop is designed around.*
> (缓存稳定性不是一个开关,而是整个 loop 围绕它设计的不变量。)

实测数据(Reasonix 案例,2026-05-01 单日单用户):435M 输入 token,**99.82% 缓存命中**,约 $12 而非无缓存的 ~$61。

---

## 二、Reasonix 的核心设计:三区分层(Pillar 1)

它把整个上下文严格切成三段(源码:`src/memory/runtime.ts`):

```
┌─ IMMUTABLE PREFIX ──────────────┐  整个 session 不变 → 缓存命中候选
│  system + tool_specs + few_shots │  ImmutablePrefix 类
├─ APPEND-ONLY LOG ───────────────┤  只在尾部追加,从不改写中间
│  [assistant][tool][assistant]…   │  AppendOnlyLog 类
├─ VOLATILE SCRATCH ──────────────┤  每轮重置,永不上传
│  R1 思考、临时 plan 状态          │  VolatileScratch 类
└─────────────────────────────────┘
```

落到代码上有 **5 个不那么显然、但关键的机制**:

### 1. 前缀被"钉死"并指纹校验(`ImmutablePrefix`)

- `system` + `toolSpecs` + `fewShots` 一次构建、整个 session 复用,`toMessages()` 永远按 `[system, ...fewShots]` 同序输出。
- 任何会改前缀的操作(`addTool` / `removeTool` / `replaceSystem`)都**显式标注"下一轮必然 miss 一次"**,并 invalidate 指纹缓存。
- `verifyFingerprint()` 在 dev/test 下会 **throw**:只要有任何绕过 `addTool` 的路径偷偷改了前缀,立刻报错——把"前缀漂移"当成 bug 来防:

  > `ImmutablePrefix fingerprint drift: ... A mutation path bypassed addTool's cache invalidation — DeepSeek will see prefix churn that the TUI / transcript log don't know about.`

- `tools()` 返回 `Object.freeze` 的快照,防止任何迭代里被意外 mutate 而改变字节。

### 2. 工具列表顺序即缓存键

源码注释原文:

> `Each addTool costs one cache-miss turn — DeepSeek's prefix cache is keyed by full tool list.`

工具的**顺序、schema、数量**任意一项变了,前缀就从 tools 段开始全 miss。所以 MCP 工具热插拔被明确标注为"会吃一次 miss"(`mcp-tool-hot-add`)。

### 3. 历史只追加、绝不改写(`AppendOnlyLog`)

- `append()` 是唯一正常路径;`compactInPlace()` 被注释为"唯一打破 append-only 的路径,**仅保留给 `/compact` 和恢复**"。
- 保证:第 N 轮请求前缀 = 第 N-1 轮请求 + 尾部新增,前缀天然字节对齐。

### 4. `reasoning_content` 的"按需保留"——最精妙的一条(`reasoning-retention.ts`)

`stripDroppableReasoningContent()` 只在 **最后一个 user 消息之前、且不带 tool_calls 的 assistant 文本回答** 上删除 `reasoning_content`,而 **tool-call 链上的 `reasoning_content` 全部保留**。原因:

- DeepSeek 思考模型要求 tool_call 回合把 `reasoning_content` 回传(否则 400 "must be passed back"——OpenClaude 已踩过并修复);
- 但已完成回合的纯文本答案的 reasoning 既不需要、又白白占 token。删掉它既省钱,又让 client 发送的字节与 DeepSeek 服务端对已完成回合的处理对齐。

### 5. 压缩/折叠也对齐缓存(`context-manager.ts`)

即使触发 `/compact` 折叠历史,fold 的 summary 调用**复用同一个 system + tools + fewShots 前缀**,注释:

> `Reuses the live prefix → fold summary call shares the cached bytes the main agent already paid for.`

连"省钱用的那次总结调用"都蹭主循环已经付费的缓存。

### 配套机制

- **缓存诊断**(`telemetry/cache-diagnostics.ts`):DeepSeek 只回 token 数、不回 miss 原因,Reasonix 用前缀 hash 自己反推 miss 原因:
  `no-miss` / `cold-start` / `system-prompt-changed` / `tool-list-changed` / `tool-schema-or-order-changed` / `mcp-tool-hot-add` / `memory-or-skill-changed` / `unknown`。顶栏实时显示命中率。每个 `CacheDiagnosticEntry` 携带 `inferred: true` 标记,声明 miss 原因是本地推断的,非 API 返回。诊断条目上限 50 条(`CACHE_DIAGNOSTICS_MAX_ENTRIES`),超过后最旧的静默丢弃。
  - 当所有前缀 hash 匹配但仍有 `miss_tokens` 时,归类为 `unknown`:说明 miss 发生在 append-only log 部分,原因可能是 provider 端 TTL、缓存状态或前缀之外的消息字节变化。
- **思考模式下的字段处理**(`client.ts buildPayload`):保留 `temperature` 等字段(服务端"静默忽略不报错"),但 `stampMissingReasoningForThinkingMode` 只对思考模型 stamp 空 reasoning,**非思考模型跳过**,避免给前缀引入额外字节 churn。

### 补充机制（初次分析遗漏）

以下机制在初次分析时被遗漏,但对缓存命中率和正确性同样关键:

#### 1. 双重折叠触发（turn-start fold + post-response fold）

除了 post-response 的 75% 触发外,还有第二个折叠触发点:

| 触发点 | 阈值 | 位置 | 特点 |
|---|---|---|---|
| Turn-start fold | 90% (`TURN_START_FOLD_THRESHOLD`) | `loop.ts:756-786`, API 调用之前 | `requireTailBoundary: true`, tail 里必须有 user 消息才折叠 |
| Post-response fold | 75-80% (normal/aggressive) | `loop.ts:1100-1149`, API 返回之后 | 允许 tail 为空 |

Turn-start fold 覆盖了 post-response 覆盖不了的场景:上一轮异常终止(无 tool_calls,无法触发 `decideAfterUsage`)、session 恢复、用户粘贴超大文本。一旦 turn-start fold 触发,`_foldedThisTurn = true` 阻止同轮再次折叠。

#### 2. 折叠时保留约束和 Skill-Pin

折叠不只是"总结历史"。以下关键块被**提取并原文追加**到折叠摘要之后:

- **约束保留**(`extractPinnedConstraints`, `context-manager.ts:14-21`):用 `matchAll` 从 system prompt 中提取所有 `# HIGH PRIORITY constraints` / `# User memory` / `# Project memory` 块,原文追加。用 `matchAll` 而非 `match` 是因为 system prompt 可能包含多组同类约束(如全局 + 项目级 User memory)。
- **Skill-Pin 保留**(`collectPinnedSkills`, `context-manager.ts:97-110`):扫描待压缩消息头中的 `<skill-pin name="...">...</skill-pin>` 块,按名称去重(最后一次调用生效),原文追加。
- **折叠指令**(`buildFoldSummaryInstruction`, `context-manager.ts:83-93`):明确要求 summarizer "绝不改述否定性约束(如'不要做 X')"和"保留用户的原始目标"。

折叠的 summary 消息通过 `buildAssistantMessage` 构建(`context-manager.ts:243-248`),确保携带 `reasoning_content` 字段,避免思考模式 session 下发起 API 调用时 400。

#### 3. 折叠 API 调用本身也蹭缓存

Fold summary 使用独立的 `deepseek-v4-flash` 调用(固定,不受用户模型影响),`thinking: "disabled"`。关键设计:
- 复用主循环的 system + tools + fewShots 前缀 → 已付费的缓存字节被 fold summary 调用共享
- 15 秒超时 + abort 信号监听 + `Promise.race` 三重保护
- 超时/abort/出错均返回 `noop`,不产生任何状态变更

#### 4. 愈合管线（Healing Pipeline）的版本缓存

`healActiveLogBeforeSend()`(`loop.ts:547-584`) 内部有 `_healedCache` / `_healedVersion` 缓存,log 版本未变则跳过完整 4-pass 管线:

```
healLoadedMessages → shrinkOversizedToolCallArgsByTokens → stripDroppableReasoningContent
```

如果愈合管线的任何一步改变了消息,会通过 `compactInPlace` 重写 log 并持久化。跳过愈合 = 避免不必要的 `compactInPlace` = 保护字节稳定性。

**Session 恢复时也会执行**(constructor, `loop.ts:263-304`):加载旧消息 → 愈合 → 持久化,确保旧版本 session 在修复 reasoning_content 后不会 400。

#### 5. MCP 工具 Schema 规范化（`canonicalizeMcpToolForCache`）

`registry.ts` 在 bridge 时对 JSON schema 做**深度 key 排序**:
- 递归排序所有 object key
- 排序 `required` 数组和 `dependentRequired` 条目
- 一次性完成,非每次请求

效果:如果 MCP server 在两次连接间重排了 schema key,字节序列保持稳定,不会产生虚假 cache miss。

#### 6. MCP 工具漂移分类（`classifyToolListDrift`）

`drift.ts` 实现了工具列表变化的完整分类:

| 分类 | 含义 | 缓存影响 |
|---|---|---|
| `identity` | 同名同序同内容 | 零成本 |
| `append` | 仅在末尾新增 | 近乎无损 |
| `edit` | 同名同位置但内容变化 | miss |
| `reorder` | 同名但顺序不同 | 灾难性 |
| `remove` | 任何移除 | 灾难性 |

驱动 `/mcp reconnect` 策略:只有 `identity` 和 `append`(需用户确认)不需要重启 session。

#### 7. ImmutablePrefix 内两级缓存

`ImmutablePrefix` 同时维护:
- `_frozenToolsCache`:冻结的 `Object.freeze` 浅拷贝,防止意外 mutate
- `_diagnosticHashesCache`:基于 `WeakMap`,以冻结工具数组为 key,同一轮内多次 `diagnosticHashes()` 不重复计算

#### 8. 磁盘支撑的 AppendOnlyLog 溢出

内存窗口上限 200 条消息(`DEFAULT_WINDOW`),但 `getEntry()` 和 `toFullHistory()` 透明地从磁盘 JSONL 读取更早条目。version 单调计数器追踪变更供消费者检测陈旧。这意味着即使在内存压力下,append-only 不变性在持久化层面仍然成立。

#### 9. Force-summary vs Fold 的本质区别

| | Force-summary | Fold (`/compact`) |
|---|---|---|
| 触发条件 | 80% context, 15s 超时 | 用户手动或自动 75-90% |
| 原始消息 | **保留**,摘要追加 | **替换** |
| Token 效果 | 摘要+原文同时累积 | 真正缩减上下文 |
| 尾随 tool_calls | 自动裁剪 | 不裁剪 |

#### 10. `reasoning_content` 剥离的可见性

`stripDroppableReasoningContent` 返回 `prunedCount` + `charsDropped`,在 session 恢复时的 console 日志中可感知(`loop.ts:289`)。剥离逻辑:
- 对每条 assistant 消息用 `Object.hasOwn(msg, "reasoning_content")` 而非 truthy 检查——确保被 `stampMissingReasoningForThinkingMode` 置为 `""` 的消息被正确跳过
- 懒复制:只有真正需要修改时才创建新数组,无剥离时返回原引用,避免不必要的内存分配

#### 11. Subagent 的缓存冷启动

每次 `spawnSubagent()` 创建全新的 `CacheFirstLoop` 和 `ImmutablePrefix`。每个 subagent 第一轮都**完整 prefix-cache miss**,即使父 agent 命中率 99%。这在 `subagentBudgetHint` 中被承认。

#### 12. 模型升级不破坏前缀

`<<<NEEDS_PRO>>>` 升级只改 `this.model`,前缀(system + tools)字节不变。API 调用在前缀部分继续命中缓存,只为新模型的 completion 付费。升级在当前轮内永久生效,`restoreModelAfterTurn` 在轮次结束时重置。

#### 13. 折叠的 `buildAssistantMessage` 兼容性

折叠摘要通过 `buildAssistantMessage` 构建,而非直接拼 JSON。这保证摘要消息在思考模式 session 下携带 `reasoning_content`,否则下一次 API 调用会 400(issue #1042)。

#### 14. Storm-Breaker 自我纠正改写 log 尾部

当 storm breaker 首次抑制某轮的所有 tool calls 时:
- 尾部 assistant 消息被替换为原始(未抑制)的 tool_calls
- 注入虚拟 tool 结果:`"[repeat-loop guard] this call was suppressed..."`
- 这是允许的例外 `compactInPlace` 调用(与 fold/healing 并列)

### 补充机制（二次探索新增）

以下机制在二次逐行核对源码时发现,初次与第一轮补充均未覆盖。

#### 15. 折叠阈值是"四档 + 一个止损闸",不是 75/80/90 三档

`context-manager.ts:24-37` 实际定义:

| 常量 | 阈值 | 作用 |
|---|---|---|
| `HISTORY_FOLD_THRESHOLD` | 0.75 | 普通 fold 触发 |
| `HISTORY_FOLD_AGGRESSIVE_THRESHOLD` | 0.78 | aggressive fold,tail 预算收紧到 10%(而非 20%) |
| `FORCE_SUMMARY_THRESHOLD` | 0.80 | 退出本轮、改用 force-summary |
| `TURN_START_FOLD_THRESHOLD` | 0.90 | turn-start fold(见 §1 双重折叠) |
| `HISTORY_FOLD_MIN_SAVINGS_FRACTION` | 0.30 | **止损闸**:折叠后头部省不到 30% 就放弃折叠 |

最后一条本质是缓存经济学决策:**不值得为了小收益去吃一次前缀 rewrite 的 miss**。

#### 16. "确定性排序"是一条独立的前缀稳定原则

文档 §5(`canonicalizeMcpToolForCache`)只覆盖了 MCP schema 的 key 排序。实际 Reasonix 在**四个层面**做确定性排序,防 `readdir()`/跨 scope 枚举顺序导致字节漂移:

- MCP **工具列表**按带前缀名排序后再注册(`registry.ts:195`)—— 这是"工具顺序",不同于 schema key 排序。
- Skills 跨 scope 去重后按名排序(`skills.ts:180`)。
- 记忆索引 `MEMORY.md` 用排序后的文件名重建(`user.ts:286`)。

提炼为原则:**凡是进前缀的列表,一律确定性排序,让文件系统枚举顺序无法 churn 字节。**

#### 17. `.gitignore` 注入有"2000 字截断悬崖"

`code/prompt.ts:166-179`:读盘 → 截断到 2000 字 + 追加 `(truncated N chars)` 标记 → 写入 system prompt。这意味着跨过 2000 字阈值时**标记本身变化**,造成更大、更难恢复的 miss(对应第三节缺失点 #5 中 Reasonix 的隐秘案例)。

#### 18. `/new`、`/cwd` 是"故意的 miss 点"

`loop.ts:388 / 416` 经 `_rebuildSystem → replaceSystem`(`runtime.ts:34-39`)显式 invalidate 指纹与诊断缓存。设计立场:Reasonix **不试图**跨 workspace 切换保前缀,而是主动重建吃一次 miss。即"必须字节恒定"与"允许在显式用户操作时 miss"要分开对待。

#### 19. 工具结果:MCP 不规范化,但内置工具刻意规范化(已被四次探索修正)

> **修正(四次探索)**:本条初版结论"工具结果不做规范化"**只对 MCP 工具成立,对内置 fs/shell 工具是反的**。完整结论见 §32:**前缀稳定保不住 MCP 工具输出的字节稳定,但内置工具的输出被刻意排序/规范化/确定性截断以求字节稳定。**

`registry.ts flattenMcpResult` 对 **MCP** 工具结果只做 head+tail 截断 + trim 换行,**不规范化**。语义相同但格式不同的 MCP 工具输出会 churn append-only log —— 这正是 §配套机制里 `unknown` miss 类的一个真实来源。

但**内置工具不是这样**:`glob` / `get_symbols` / `outline` / `search` / `edit_file` 的输出都经过确定性排序、换行符适配与固定结构截断(详见 §32),它们的输出字节在同一输入下是恒定的。所以"前缀稳定保不住工具输出字节"这句**只适用于 MCP 桥接结果**,不适用于内置工具。

#### 20. 其余较小但真实的机制

- **prefixEvidence 每轮快照**(`loop.ts:~880`):在任何 MCP 热插拔**之前**抓 `diagnosticHashes`,让诊断能把 miss 正确归因到工具列表变化。
- **重试是字节完全相同的重发**(`retry.ts`):失败重试不 re-serialize → 网络重试**不是** cache buster。
- **transcript 每轮记 `prefixHash`**(`transcript/log.ts`)→ 支撑 `replay --cache-report` 把命中率变化归因到 system/tool/memory 跳变。
- **subagent base 稳定 + 升级契约后置**(`subagent.ts:98-112`):base system 复用,"你正跑在 flash 上"这类契约每次 spawn 追加,故 subagent 内部 flash→pro 升级不扰动 base 前缀(补强 §11)。

#### 21. 经济性与可见性(直接对应 P1/P2)

- **具体计价 + 省钱公式**(`telemetry/stats.ts`):hit/miss 费率表;`savings = hitTokens × (missRate − hitRate)`。
- **按时间窗分桶的命中率**(`usage.ts`:`bucketCacheHitRatio` / `bucketSavingsFraction` / 每 today·week·month·all 的 `cacheSavingsUsd`),且 **`SessionStats.aggregateCacheHitRatio` 跨 resume 累计**(carryover 持久化在 session 元数据)。这是 P2"状态栏命中率 cell"的现成模型。
- **miss token 健壮兜底**(`client.ts Usage.fromApi`):DeepSeek 不回 miss 数时 `cacheMissTokens = max(0, promptTokens − cacheHitTokens)`。直接关系 OpenClaude 计费正确性(commit `59d24ec`),建议核对 OpenClaude 是否有同样兜底。

### 补充机制（三次探索新增）

以下机制在前两轮逐行核对中遗漏,第三次交叉验证时发现。

#### 22. `fingerprintArgs` — 工具调用参数去重防缓存浪费(`tools.ts:78-81, 494-511`)

对工具调用参数做 key 排序后 SHA 哈希,用两个 Map 追踪重试:

- `_lastMalformed`:同 tool name 连续 2 次 schema 校验失败 → 返回尖锐错误,阻止模型反复尝试相同错误参数。否则每次无效重试消耗一个缓存回合。
- `_lastGateRejection`:host 层 gate 拒绝(如 edit-gate),key = `${reason}:${fingerprint}` → 同参数连续 2 次拒绝直接 abort。

与 §14 Storm-Breaker 不同:Storm-Breaker 防的是"模型连续发相同 tool call",fingerprintArgs 防的是"相同错误参数被两次提交后被 API/验证层拒绝后还重试"。两者覆盖不同场景。

**对 OpenClaude 的价值**:DeepSeek 路径下 tool call 重试循环会无声消耗缓存 token,此去重层移植成本低。

#### 23. Memory 写入实时、前缀不复用(`memory.ts:1`)

文件头注释声明了一个硬性不变量:

> *"Writes are eager but the prefix is NOT re-loaded mid-session — keeps prompt-cache stable."*

用户通过 `/memory` 写入后**立即落盘**,但 ImmutablePrefix **在本轮 session 中不重新加载**。代价是本 session 看不到最新记忆编辑,收益是前缀零扰动。这是一个**显式设计取舍**,而非实现疏忽。

对比 OpenClaude:目前 `getSystemContext` 是 memoize 的(session 内不变),但如果未来实现 `/memory` 类功能,需同样注意不要触发前缀重建。

#### 24. SessionMeta `systemFingerprint` 跨恢复比对(`session.ts:95-97, 576-578`)

SessionMeta 保存当前 system prompt 的 `systemFingerprint`(SHA-256[:16])。恢复 session 时:

- 匹配 → 无警告,缓存 token 可跨 resume 累计
- 不匹配 → 提示用户 REASONIX.md 或 memory 已变更(#2212),且缓存统计从零开始

此机制与 ImmutablePrefix 的运行时 `verifyFingerprint()`(§1)不同:前者是 session 内的主动防御(throw),这个是跨 session 的被动警告(warn)。两者互补。

#### 25. PromptFragments — 字面量、禁止插值(`prompt-fragments.ts:3-4`)

> *"Embedded literally — no interpolation, so prefix-cache hash stays stable across sessions."*

所有共享 prompt 片段(TUI 格式化规则、升级合同、负面断言规则等)被定义为**编译时常量字符串**,零动态插值。这是"前缀稳定性"的编译时保障层——如果开发者想把 `new Date()` 或配置值塞进 prompt 片段,TypeScript 的 const 语义会阻止,因为片段本身不是函数。

对比 OpenClaude:CLAUDE.md 的 `currentDate` 被放进 user 消息桶是对的,但 system prompt 构建链很长,如果任何中间环节插入了动态值,Reasonix 的 `PromptFragments` 模式可作参考——确保 prompt 骨架是字面量。

#### 26. 文件读取 64 KiB outline 阈值(`filesystem.ts:48-49`)

> *"64 KiB covers ~99% of source files; larger ones outline-mode by default to keep the cache prefix slim."*

文件 > 64 KiB → 自动切到 outline 模式(仅返回头 80 行 + 符号结构)。明确以"不污染前缀字节序列"为目标——如果把整个 200KB 文件塞进 tool 结果,它会进入 append-only log,后续每轮都携带,持续推高上下文并降低缓存利用率。

**对 OpenClaude 的价值**:OpenClaude 的 Read 工具有类似截断但未见"为缓存而设计"的阈值。可评估是否对齐。

#### 27. Project memory 空文件防护(`project.ts:68`)

> *"Empty / whitespace-only files return null so they don't perturb the cache prefix."*

防御性检查:若用户创建空的 `REASONIX.md`,系统不往前缀插入空字符串块,避免虚假 miss。这是"不扰动前缀"原则在文件系统边界的极致应用——连空内容都被视为潜在威胁。

#### 28. Doctor 缓存健康检查(`doctor.ts:60-66, 395-542`)

`/doctor` 命令有**五个独立缓存检查**,日常用户可运行,非开发者专用:

| 检查 | 文件位置 | 检测内容 |
|---|---|---|
| `cache-dynamic-prompt` | 395-432 行 | 扫描 REASONIX.md 中的 `Date.now`、`new Date`、`toISOString` 等时间戳注入模式 |
| `cache-mcp-order` | 434-469 行 | 检查 MCP server spec 名称稳定性,保证工具前缀确定性 |
| `cache-skills-and-memory` | 471-484 行 | 报告 project memory 标记是否存在,提示 memory 变化时需 `/new` |
| `cache-hooks` | 486-511 行 | 警告 hook 输出可能注入 timestamp 或每轮 mutate prompt 可见文件 |
| `cache-evidence` | 513-542 行 | 检查 session 中是否记录了 cacheDiagnostics 证据 |

**对 OpenClaude 的价值**:可作为 P1 "缓存诊断 debug 日志"的 UI 层补充,提供 `/cache-health` 或类似命令给用户自助排查。

#### 29. Subagent project memory "注册时烘焙一次"(`subagent.ts:462-468`)

Project memory(REASONIX.md)在子 agent **注册时应用一次**,不在每次 spawn 重新读取。注释解释:

> *"re-reading on every spawn would (a) make the child prefix unstable when REASONIX.md changes mid-session, defeating cache reuse across multiple subagent calls, and (b) cost a stat() per call."*

此设计强化了 §11(子 agent 冷启动):虽然每个子 agent 第一轮 prefix-cache miss,但通过"project memory 烘焙一次",至少**同一子 agent 的多次 spawn 间前缀是稳定的**。

#### 30. Builtin skills `Object.freeze`(`skills.ts:657-712`)

所有内置 skill 全部 `Object.freeze`,确保 session 内字节不可变。§16 提到了 skills 按名确定性排序,但 `freeze` 是更底层的防御——即使排序正确,如果没有 freeze,任何代码路径意外 mutate skill 对象都会改变其 JSON 序列化字节。

#### 31. Subagent 预算提示常量(`subagent.ts:128-143`)

| 常量 | 值 | 作用 |
|---|---|---|
| `SOFT_HINT_AFTER_SPAWNS` | 1 | 第 1 次 spawn 后即提示"每次 spawn 支付 cache miss" |
| `STRONG_HINT_AFTER_SPAWNS` | 4 | 第 4 次 spawn 后加重提示 |
| `STRONG_HINT_TOKEN_THRESHOLD` | 50000 | 子 agent 消耗超 50K token 时也触发加重提示 |

这些"教育模型"的提示本身不进前缀(记录在 tool description 中),但它们直接影响模型的 spawn 决策——模型知道每次 spawn 有缓存成本后会减少不必要的并行 worker。

### 补充机制（四次探索新增）

第四轮探索聚焦此前未引用的源码区(`src/loop/`、`src/repair/`、`src/tools/fs/`、`src/hooks.ts`、`src/transcript/`)。核心收获是发现了一个**完整的主题**:**内置工具输出的确定性规范化层**——它修正了 §19 的初版结论(见上)。

#### 32. 内置工具输出的确定性规范化(修正 §19,自成一个主题)

§26(64KiB outline 阈值)只是这层的一个点。实际上 Reasonix 对**所有内置工具**的输出都做了"同输入→同字节"的处理,目的就是让进入 append-only log 的工具结果字节稳定:

| 工具 | 机制 | 位置 | 缓存意义 |
|---|---|---|---|
| `glob` | 结果强制排序:`mtime` 降序 或路径名 `localeCompare` | `fs/glob.ts:70-71` | 不受 `readdir()` 枚举顺序影响,同 pattern 字节恒定 |
| `get_symbols` | 符号按 `line → column` 排序,而非 tree-sitter 匹配顺序 | `code-query/symbols.ts:169` | 同文件符号输出确定 |
| `edit_file` | search/replace 的换行符**适配文件原生 LE**(CRLF/LF) | `fs/edit.ts:28-30` | 跨平台字节稳定,避免 CRLF 文件匹配漂移 |
| `outline` | >30 符号时固定 `head(25) + gap 标记 + tail(5)`,行号 `padStart(width)` 对齐 | `fs/outline.ts:190-210` | 大文件 outline 结构与列宽恒定 |

提炼为原则(与 §16 的"凡进前缀的列表确定性排序"对称):**凡进 append-only log 的工具输出,内置工具一律确定性排序/规范化/定长截断;唯独 MCP 桥接结果(§19)不规范化,故 MCP 输出才是 `unknown` miss 的来源。**

#### 33. 内置 `search` 的"确定性截断三件套"(`fs/search.ts`)

`search` 的截断比单纯 head+tail 精巧,三层都为"输出策略全程一致"服务:

| 常量 / 行为 | 值 / 位置 | 作用 |
|---|---|---|
| `MAX_HITS_PER_FILE` | 30(`search.ts:72`) | 单文件超 30 个命中 → 发 `[rel: N more matches in this file …]` 页脚 |
| `SUMMARY_MODE_TRIGGER_RATIO` | 0.8(`search.ts:74, 143-151`) | 输出字节达预算 80% → 切 histogram/计数模式,并发一条 `[switching to summary mode …]` 提示 |
| 单行截断 | `line.length > 200 → "…"`(`search.ts:265`) | 防单条超长行(压缩 JSON、minified)撑爆输出 |

关键设计:**80% 提前触发**保证"尾部文件不会回头改变前半段已输出的格式"——同一次 grep 的输出策略从头到尾一致,而非到末尾才发现超预算再换格式。这正是为字节稳定服务的(对照 §15 的"止损闸"思路:都是用阈值把行为锁成确定性的)。

#### 34. Hook 输出 256KB 硬上限(`hooks.ts:201, 239-248`)

`HOOK_OUTPUT_CAP_BYTES = 256 * 1024`,对 hook 的 stdout/stderr 做字节封顶,超出置 `truncated = true`。

- §28 记录的是 doctor 的 `cache-hooks` 检查会**警告** hook 可能注入 timestamp / 每轮 mutate 文件;
- 本条是**实际执行**的兜底:hook 输出会进入 prompt,失控的 hook 输出是真实的前缀/log 破坏源,这个上限是最后一道闸。

**对 OpenClaude 的价值**:若接入 hook 体系,需注意 hook 输出既要封顶,又要在被截断时显式标记(否则跨 2000 字类阈值时标记本身变化,重演 §17 的"截断悬崖")。

#### 35. transcript 的"前缀稳定性叙事"——`replay --cache-report` 的分析侧(`transcript/replay.ts:46-71`、`transcript/diff.ts:221-240`)

§20 只记了存储侧("每轮记 `prefixHash`"),漏了消费/分析侧——而后者才是 `replay --cache-report` 的判定逻辑:

- **`replay.ts`**:把一个 session 所有 `prefixHash` 收进 `Set`,`size <= 1` = 全程字节稳定,`> 1` = 前缀 churn(churn 了几个不同前缀)。
- **`diff.ts`** 直接产出对比叙事(bench 模式对比的 headline):
  - `"prefix stability: A stayed byte-stable across N turns; B churned X distinct prefixes."`
  - 两者前缀 hash 相同时:`"A and B share the same prefix hash … — cache delta is attributable to log stability, not prompt change."`

即:命中率变化能被归因到**前缀跳变**还是**append-only log 字节变化**两类,直接对应文档第三节 OpenClaude "缺失点 #3 没有命中率可见性 / miss 归因"。

**配套小机制**:shell 输出有 `byteCap = maxChars * 2 * 4`(`shell/exec.ts:122`),按 UTF-8/GBK 最坏 4 字节/字符兜底,防 char 上限触发前先 OOM——属于 §32-33 同一输出稳定层。

> **存疑/未确认(不作为已证实结论)**:子 agent 还报了一批理论上的非确定性点——`repair/flatten.ts` 与 `loop/shrink.ts` 的 `Object.entries` 非规范序、`repair/scavenge.ts` 的 100KB 硬边界。这些多数在 `compactInPlace` 一次性持久化后即被钉死,**未确认**为真实的逐轮破坏源,列此备查。MCP `registry-fetch.ts` 的 `CACHE_TTL_MS / CACHE_SCHEMA_VERSION` 是 marketplace 注册表磁盘缓存,与 prompt cache 无关。
>
> **已确认无害**:`healing.ts:13` 用 `Date.now()` 给缺失 ID 的 tool_call 生成 `z-ext-<ts>-<seq>`,经逐行核实:**只在 session 加载/恢复时 stamp 一次**,随后持久化到磁盘,后续轮次直接使用已持久化的消息,不重新生成。故不是逐轮 churn 源,是一次性修复。

### 补充机制（五次探索新增）

第五轮探索聚焦此前未深入阅读的源码区（`src/tokenizer.ts`、`src/loop/shrink.ts`、`src/repair/scavenge.ts`、`src/loop/healing.ts`），核心收获是**Tokenizer 的三层独立缓存**和 **healing 管线里一个关键的"只换不炸"防护**。

#### 36. Tokenizer 的三层缓存（不仅仅是 `contentTokenCache`）

`tokenizer.ts` 实际维护了三层独立缓存,各司其职:

| 缓存 | 类型 | 容量 | 目的 |
|---|---|---|---|
| `bpeCache` | LRU `<string, string[]>`(`tokenizer.ts:194`) | 8192 条 | BPE merge 结果缓存——"repetitive tool output / identifier chunks re-encode thousands of times per session; LRU bounds at ~400KB" |
| `contentTokenCache` | LRU `<string, number>`(`tokenizer.ts:535`) | 4096 条 | 有界 token 计数缓存;跳过 >10KB 的字符串以避免 "200MB+ of string keys" |
| `toolsTemplateCache` | `WeakMap<ReadonlyArray, string>`(`tokenizer.ts:333`) | 以 `ImmutablePrefix._toolSpecs` 身份为 key | 工具模板渲染结果——整个 prefix 生命周期内只算一次,零重复计算 |

此外还有 `warmupTokenizer()` 预热函数(`tokenizer.ts:157`,gunzip + JSON.parse 约 100ms,首屏渲染后空闲时调用),以及:

- `PER_MESSAGE_TEMPLATE_TOKENS = 6`(`tokenizer.ts:532`)——用于 fold 阈值估算的每消息模板 token 开销
- `DEFAULT_BOUNDED_TOKENIZE_CHARS = 2KB`(`tokenizer.ts:296`)——`estimateConversationTokens`/`estimateRequestTokens` 走的是**不同于 `formatDeepSeekPrompt` 的精简路径**(head+tail 采样估算长字符串),专用于 fold 触发判断而非实际 API 请求

#### 37. `shrinkOversizedToolCallArgsByTokens` 的"只换真省了"防护

`loop/shrink.ts:65-99` 在缩减 oversized tool_call 参数后,有一行关键的防护判断:

```typescript
const afterTokens = countTokens(shrunk);
// Many-short-strings payloads can come back marginally larger — only swap on real saving.
if (afterTokens >= beforeTokens) return call;
```

含义:如果缩减后 token 数**反而持平或变大**,保留原样不替换。没有这行防护,healing 管线会在某些边界情况下把 append-only log 里的字节**越缩越大**,制造虚假的 cache churn。这是"不得伤害"原则在 shrink 层的体现。

#### 38. `shrinkJsonLongStrings` 的确定性标记格式

`loop/shrink.ts:102-126`:缩减 tool_call 参数时,只对 >300 字符(`LONG_THRESHOLD`)的 string value 替换为确定性的标记:

```
[…shrunk: N chars, M lines — tool already responded, see result]
```

短 key/value（路径、ID 等）原文保留。缓存意义:**标记格式完全确定**,同一输入永远产出同一输出标记。如果标记里带了 timestamp 或自增序号,每次 shrink 就会产生不同字节,churn append-only log。

#### 39. `scavengeToolCalls` — R1 reasoning 内容里的 tool call 挖掘

`repair/scavenge.ts`:当 R1 模型把 tool calls 写成 DSML 标记塞进 `reasoning_content` 而非正规 `tool_calls` 字段时,scavenger 从 reasoning 里挖掘 DSML invoke 块 + 裸 JSON 对象(三种 pattern),最多恢复 4 个调用(`maxCalls ?? 4`,100KB regex 输入上限 `MAX_SCAVENGE_INPUT`)。不直接是缓存机制,但它的输出进入 append-only log——如果挖掘结果非确定性,会 churn log 字节。目前实现是确定性的(同输入→同输出)。

### 补充机制（六次探索新增）

第六轮探索聚焦此前未引用的源码区（`src/client.ts` 的 JSON 序列化层、`src/tools.ts` 的工具注册顺序、`src/tools/fs/search.ts` 的非确定性排序、`src/loop/messages.ts` 的 reasoning 保留逻辑、`src/code/file-encoding.ts` 的编码往返），核心收获是**JSON 传输层的字节标准化**、**工具注册/搜索输出的非确定性缺口**、以及**reasoning_content 保留逻辑的完整语义**。

#### 40. JSON 代理标准化 —— `sanitizeJsonTransportValue`（`client.ts:111-152`）

所有 API 请求通过 `stringifyJsonTransport()` 发送，它在 `JSON.stringify` 之前递归地将**孤立的 UTF-16 代理项**替换为 `U+FFFD`。这是一个**字节稳定性机制**：如果不做此处理，包含破损代理的字符串在不同运行时/编码路径下会产生不同的序列化字节，导致 DeepSeek 前缀缓存在语义相同的情况下 miss。

注释原文："DeepSeek's strict JSON parser rejects lone UTF-16 surrogate escapes."

**对 OpenClaude 的价值**：如果 OpenClaude 的桥接层直接使用 `JSON.stringify` 而非经过同样的代理清理，包含破损代理的 tool 输出会导致同一内容在不同轮次产生不同字节，churn append-only log。检查 `customOpenAIClient.ts` 的序列化路径是否有类似防护。

#### 41. 流式模式需要 `stream_options.include_usage: true`（`client.ts:217`）

DeepSeek 在**流式传输时要求**此标志才能返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。如果不设置此标志，流式响应中**不会出现缓存指标**。

```typescript
if (stream) payload.stream_options = { include_usage: true };
```

**对 OpenClaude 的价值**：这是**高危遗漏点**。如果 OpenClaude 对 DeepSeek 使用流式传输但没有设置此标志，则所有流式请求的 `prompt_cache_hit/miss_tokens` 字段将为空——计费端会错误地把缓存命中的 token 按全价计算，**直接导致多收费**。应立刻检查 `customOpenAIClient.ts` 中流式请求是否携带此字段。

#### 42. 客户端 payload 始终包含 `temperature` / `top_p`（`client.ts:222-227`）

即使在思考模式下模型"静默忽略"这些字段，它们也**不会从 payload 中被剥离**。注释解释："keeps the request payload diffable against OpenAI tooling."

缓存含义：如果这些字段被**有条件地剥离**（如在思考模式下移除），两个语义相同的请求会在字节层面不同，导致 false cache miss。始终包含它们保证字节布局一致。

**对 OpenClaude 的价值**：桥接层转换时如果对 thinking 模型做了字段裁剪，会引入字节 churn。检查转换逻辑是否在此处有条件分支。

#### 43. `buildAssistantMessage` 的 reasoning 保留启发式（`loop/messages.ts:13-18`）

这比 §4 / §10 描述的"只对思考模型 stamp"更完整：

```typescript
if (isThinkingModeModel(producingModel) || (reasoningContent && reasoningContent.length > 0)) {
    msg.reasoning_content = reasoningContent ?? "";
}
```

逻辑是**双重条件**：思考模型 **或** 任何实际发出了 `reasoning_content` 的模型（包括非思考模式）。注释解释："V4-era deepseek-chat returns reasoning_content even with thinking.type disabled, and the API rejects round-trips that drop it."

即：即使模型不在思考模式，如果它曾经发出过 reasoning，也必须回传。这是一个更保守、更安全的保留策略。

**对 OpenClaude 的价值**：OpenClaude 的 `reasoning_content` 回传逻辑（copilotClient:649）如果只判 `isThinkingModel` 而忽略"模型实际发出过 reasoning"的情况，非思考模式 V4 的 tool_call 回合会触发 400。建议核对条件是否覆盖了第二个分支。

#### 44. 文件编码往返保留（`code/file-encoding.ts`）

文件读取/写入保留原始编码（UTF-8 / UTF-8-BOM / GB18030）。`edit_file` 不会在写入时将 GB18030 文件静默转换为 UTF-8。这是 §32 "编辑换行符适配"之上的更深层字节稳定性：连**文件编码**都保持原始状态。

**对 OpenClaude 的价值**：如果 OpenClaude 的 edit 工具在 DeepSeek 路径下使用不同的编码处理，写入后的文件再被读取会产生不同字节，在 append-only log 里 churn 后续的 read_file 结果。

#### 45. 非 MCP 工具缺乏 Schema 规范化（`tools.ts:174-183`——非确定性缺口）

`canonicalizeSchemaForCache()`（key 排序、required 数组排序）**仅应用于 MCP 桥接工具**。直接注册到 `ToolRegistry` 的内置工具（`spawn_subagent`、`edit_file`、`read_file` 等）不经任何规范化处理。同时 `ToolRegistry.specs()` 返回 `Map.values()` 迭代顺序——虽然当前按注册顺序是确定性的，但**没有最终排序作为安全网**。

这意味着：
- 如果内置工具 parameter schema 的 key 顺序在不同版本中变化 → false cache miss
- 如果工具注册顺序在不同运行中变化（import 时序、并行 MCP 连接完成顺序不一致）→ tool 列表顺序变化 → 整个前缀 cache miss

#### 46. `searchFiles()` / `searchContent()` 结果不排序（`fs/search.ts`——非确定性缺口）

与 §32 的 `glob`（显式 `sort()` 结果）不同，`search` 以 `fs.readdir()` 顺序返回结果，**这是操作系统/文件系统相关的**。相同搜索模式在不同运行中可能产生不同的输出顺序。这与 §32 的原则"进入 append-only log 的内置工具输出应该字节稳定"相矛盾。

**对 OpenClaude 的价值**：如果 OpenClaude 的 Grep/搜索工具在 DeepSeek 路径下也存在类似不排序行为，同一搜索的两次调用可能产生字节不同的 tool 结果，churn append-only log。应检查对应工具的输出是否做了确定性排序。

#### 47. 其余较小但真实的机制（六次探索新增）

- **`OUTLINE_MAX_ENTRIES = 30` + `OUTLINE_TAIL_KEEP = 5`**（`fs/outline.ts:7-8`）：补充 §26/§32——大纲截断不仅有 80 行头，还有"30 个符号中保留头 25 + 尾 5"的二级截断。
- **`MAX_TURNS = 200`**（`stats.ts:57`）：SessionStats 的 rolling window 上限，超限 turn 的 cost/token 滚进 carryover。与 `DEFAULT_WINDOW = 200`（`runtime.ts` AppendOnlyLog 内存窗口）独立但数值相同。
- **Usage log 压缩**：5MB 触发（`USAGE_COMPACTION_THRESHOLD_BYTES`）、365 天保留（`USAGE_RETENTION_DAYS`），`usage.ts:77-78`。遥测基础设施，不直接影响 prompt cache 但支撑 `/status` 和 dashboard 的命中率统计。
- **`doctor --cache` 独立命令**（`cli/index.ts:471-488`）：§28 只记了 `/doctor` 的 cache checks，漏了 `doctor --cache` 作为独立 CLI 入口可直接被 CI/脚本调用。
- **`ModelTurnStartedEvent.prefixHash` 事件流**（`core/events.ts`、`core/eventize.ts`）：prefixHash 作为一等字段存在于 event 系统中，从 loop → transcript writer → TUI 完整传递。补充 §20 的 transcript 存储侧。
- **Doctor 检查的覆盖盲区**（`doctor.ts:395-431`）：`checkCacheDynamicPrompt` 只扫描 REASONIX.md 的时间戳模式，**不扫描** `~/.reasonix/memory/`（用户记忆文件）、`CLAUDE.md`、custom skill body。这是已知限制，非 bug。
- **折叠在诊断中被归类为 `unknown`**（`cache-diagnostics.ts:179-182`）：当所有前缀 hash 匹配但仍出现 miss_tokens 时，归为 `unknown`——这包括 context fold 导致的字节变化（因为 fold 改的是 append-only log 而非 prefix）。已知限制：无法区分"provider cache TTL 过期"和"history fold 重写了 log 尾部"。

### 补充机制（七次探索新增）

第七轮探索聚焦此前未引用或未深读的源码区（`src/client.ts` 的 `buildPayload` 完整字段布局、`src/tools.ts` 的 schema 自动扁平化与重嵌套防御、`src/config.ts` 的 `_configCache`、`src/core/lru.ts` 的 `TtlLruCache`、`src/repair/index.ts` 的修复管线三通道、`src/loop/thinking.ts` 的 V4 模型识别），核心收获是**API payload 字段布局与字节顺序的关系**、**自动扁平化对前缀中工具定义的副作用**、**修复管道对 append-only log 字节的决定性影响**。

#### 48. `buildPayload` 字段顺序即字节顺序（`client.ts:211-235`）

API 请求的 JSON payload 在 `buildPayload()` 中构建为对象字面量，V8 按定义顺序序列化 key：

```typescript
// 固定顺序: model → messages → stream → (stream_options) → (tools) → (temperature) → (max_tokens) → (response_format) → (extra_body) → (reasoning_effort)
```

关键点：
- `tools` 条件性添加（line 218）：无工具时不出现该 key——payload 的 key 集合在不同请求中不同
- `extra_body.thinking` 通过 `_isAzureEndpoint()` 守卫（lines 228-230）：Azure 兼容端点跳过此字段（因为 Azure 拒绝 400），**同一 messages 发给不同端点的 payload 字节不同**
- `temperature` / `reasoning_effort` 无条件发送（若 opts 中有值）——已在 §42 记录，但此处强调**字段的"始终存在"本身就是字节稳定性保证**（有条件的字段会导致 key 集合 churn）

**对 OpenClaude 的价值**：桥接层的 payload 构建应确保 DeepSeek 路径下的 key 集合恒定。如果某些字段在非 thinking 模式下被省略，会导致字节 churn。应审计 `customOpenAIClient.ts` 是否在 DeepSeek 路径下有条件性字段省略。

#### 49. Schema 自动扁平化改写前缀中的工具定义（`tools.ts:137-142`）

`ToolRegistry.register()` 在 `autoFlatten` 为 true（默认）时，对每个注册的工具 schema 做深度/叶子分析：

```typescript
if (this._autoFlatten && def.parameters) {
  const decision = analyzeSchema(def.parameters);
  if (decision.shouldFlatten) {
    internal.flatSchema = flattenSchema(def.parameters);
  }
}
```

`specs()`（line 174-183）在输出时优先返回 `flatSchema`，而非原始 `parameters`：

```typescript
parameters: t.flatSchema ?? t.parameters ?? { type: "object", properties: {} },
```

这意味着：
- 深度 >2 或叶子 >10 的工具 schema **在进入前缀前就被改写为 dot-notation 扁平形式**
- 扁平化在注册时一次性完成，轮间稳定
- 但同一工具的 schema 在不同版本（schema 复杂度跨越阈值时）会从嵌套突变为扁平——**这构成一次 prefix churn**

**缓存意义**：这是注册时的确定性变换，不会逐轮 churn。但如果工具 schema 在 session 中因 MCP 热插拔而重注册，且新 schema 的扁平决策与旧的不同，则前缀字节变化。

**对 OpenClaude 的价值**：当前桥接层不做 schema 扁平化。如果 DeepSeek 路径下出现"tool 参数被静默丢弃"的问题（DeepSeek 对深度 >2 或叶子 >10 的 schema 会丢弃 args），可参考此机制做转换。

#### 50. `fingerprintArgs` 的 key 排序——确定性指纹（`tools.ts:493-511`）

`fingerprintArgs()` 对 args object 的 key 排序后再 `JSON.stringify`：

```typescript
function fingerprintArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(sortJson(args));
  } catch {
    return "";
  }
}
```

`sortJson` 递归排序所有嵌套对象的 key。这确保 `_lastMalformed` 和 `_lastGateRejection` 的指纹不受 JS 属性枚举顺序影响，即使模型以不同 key 顺序发送语义相同的参数，也会被识别为"相同调用"。

**缓存意义**：不直接是 prompt cache 机制，但它是两个"防浪费"机制的基础：
- `_lastMalformed`：同 name 连续 2 次相同错误参数 → 返回尖锐错误阻止重试（节约缓存回合）
- `_lastGateRejection`：同 name 连续 2 次同原因 gate 拒绝 → abort（防止浪费缓存回合做无效重试）

已在 §22 记录了去重机制，本条补充的是**底层实现的确定性保证**——key 排序算法本身。

#### 51. 重嵌套防御：仅当 args 含点键时才重嵌套（`tools.ts:226`）

`dispatch()` 在扁平 schema 工具收到模型返回的 args 后，不是无条件重嵌套：

```typescript
if (tool.flatSchema && args && typeof args === "object" && hasDotKey(args)) {
  args = nestArguments(args);
}
```

`hasDotKey()` 遍历 key 检查是否含 `.`。只有当模型实际使用了 dot-notation（说明它看到了扁平 schema），才执行重嵌套。如果模型无视扁平 schema 仍发送嵌套 args（如 `{ path: { dir: "a" } }` 而非 `{ "path.dir": "a" }`），则不会触发 `nestArguments`，避免将 `{ path: { dir: "a" } }` 错误地转为 `{ path: { dir: "a" } }`（即已经嵌套的保持不变）。

**缓存意义**：这是"确定性行为"原则的体现——dispatch 逻辑对同一入参总是产生同一结果，不因扁平/非扁平 schema 的存在而产生二义性路径。

#### 52. `readConfig` 的 mtime 缓存与 TOCTOU 安全（`config.ts:504-550`）

`_configCache` 是一个进程内 mtime-keyed 缓存，在 `readConfig()` 中实现：

```typescript
fd = openSync(path, "r");
const st = fstatSync(fd);
const cached = _configCache.get(path);
if (cached && cached.mtimeMs === st.mtimeMs) {
  closeSync(fd);
  return cached.cfg;
}
```

关键设计：
- 先 `openSync` → `fstatSync` → 检查缓存 → 从**同一 fd** 读取，消除 TOCTOU 竞态
- `writeConfig()`（line 591-602）写后 delete 缓存条目
- 已知限制：mtime 精度 ~1 秒，外部编辑可能在此窗口内被错过

**缓存意义**：这是**进程内配置读缓存**，不直接是 prompt cache。但其设计原则（先获得不可变的引用再检查缓存、写后失效）与 prompt cache 的"先固化前缀再复用"原则是同构的。

#### 53. `TtlLruCache` —— 带 TTL 的 LRU 通用工具（`core/lru.ts:33-57`）

```typescript
export class TtlLruCache<K, V> {
  get(key: K): V | undefined {
    const e = this.inner.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) return undefined;  // TTL 过期 = miss
    return e.v;
  }
}
```

被以下场景使用：
- `.gitignore` 缓存（`gitignore.ts:16`）：256 条、5 秒 TTL——at-mention picker 的逐键击遍历，缓存让同 tick 重 walk 免费
- tokenizer 的 `bpeCache` / `contentTokenCache` 在此基础上还有额外约束

**缓存意义**：`TtlLruCache` 是项目级缓存模式在边界层的体现——任何需要"临时缓存、过期自动淘汰"的场景都复用此实现，避免各处手写不一致的缓存逻辑。

#### 54. 修复管线的"双通道"scavenge 与去重（`repair/index.ts:71-84`）

scavenge 同时扫描 **reasoning** 和 **content** 两个通道：

```typescript
const combined = [reasoningContent ?? "", content ?? ""].filter(Boolean).join("\n");
const scavenged = scavengeToolCalls(combined || null, { ... });
```

合并后去重（`name::args` 签名），再合并到已声明的 tool_calls。这确保：
- R1 模型在 `reasoning_content` 中泄露的 tool call JSON 也被捕获
- 如果同一个 call 同时出现在 reasoning 和 content 中，只保留一个
- 修复结果进入 append-only log，其字节由 scavenge 的确定性决定

已在 §39 记录了 scavenge 本身，本条补充的是**合并策略**：两个通道用 `\n` 连接，且去重顺序是"已声明的 calls 先入、scavenged 追加、重复跳过"。

#### 55. dispatch 中的双重结果截断（`tools.ts:314-318`）

`ToolRegistry.dispatch()` 同时支持 token 截断和 char 截断：

```typescript
if (opts.maxResultTokens !== undefined) {
  clipped = truncateForModelByTokens(clipped, opts.maxResultTokens);
}
if (opts.maxResultChars !== undefined) {
  clipped = truncateForModel(clipped, opts.maxResultChars);
}
```

两种截断可同时应用，取更紧者。截断后的结果进入 append-only log。`maxResultTokens` 优先（因为它更准确地反映上下文占用，CJK 文本也不会因 2× 密度绕过限制）。

**缓存意义**：截断阈值是进入 append-only log 的工具结果字节的最终控制点。如果截断算法是确定性的（同一输入→同一截断输出），且截断阈值恒定，则工具结果的截断部分在轮间字节稳定。

#### 56. `_isAzureEndpoint` —— 端点特定的 payload 差异（`client.ts:240-247`）

Azure OpenAI 兼容端点不接受 DeepSeek 专有的 `extra_body.thinking` 字段（会 400）。`buildPayload` 通过 hostname 检查跳过：

```typescript
if (opts.thinking && !this._isAzureEndpoint()) {
  payload.extra_body = { thinking: { type: opts.thinking } };
}
```

**缓存意义**：这揭示了一个微妙的不稳定性来源——如果同一个 client 实例的 `baseUrl` 在不同请求间切换（虽然当前代码中不会），`extra_body` key 会出现/消失，导致 payload 字节 churn。

**对 OpenClaude 的价值**：桥接层若根据不同 provider 有条件地注入/省略字段，需确保 **同一 session 内 provider 不会切换**，否则 payload 字节布局会变化。

#### 57. `buildPayload` 中 `reasoning_effort` 始终发送（`client.ts:231-233`）

不管 thinking 开关如何，只要 opts 中有 `reasoningEffort` 就发送。与 `temperature` 的处理一致——即使模型在 thinking 模式下静默忽略这些字段，也保留在 payload 中，保持字节布局恒定。

#### 58. 其他较小但真实的机制（七次探索新增）

- **`loop/force-summary.ts:46-51`**：Force summary 使用 `ctx.model`（当前活跃 model），而非硬编码模型。且传递 `ctx.maxOutputTokens` 尊重 `/max-tokens` 上限。与 fold 不同（fold 固定使用 `deepseek-v4-flash`, `thinking: "disabled"`）。
- **`loop/streaming.ts:75-79`**：`looksLikeCompleteJson` 用于判断 tool call args 是否完整——这是从 `shrink.ts` 导入的，两个模块共享同一个 JSON 完整度判断逻辑。
- **`loop/errors.ts:61-67`**：`probeDeepSeekReachable` 用 balance API 做连通性探测（1500ms 超时）——不发送 chat 请求，不消耗缓存。
- **`tools/truncated-result-saver.ts:29-43`**：截断结果用 `Date.now() + randomUUID()` 做文件名——**这不会 churn append-only log**，因为文件名只出现在给模型的提示文本中（"Full result saved at: .reasonix/..."），且该文本本身在截断后是确定的（模型看到的只是路径引用，原结果的字节已被截断）。
- **`tools/rate-limit.ts:87-88`**：`consume()` 在 dispatch 开始时即计数（而非结束时），确保并发慢工具也占用时间窗口——防止并发burst绕过限制。
- **`mcp/drift.ts:18-78`**：`classifyToolListDrift` 的完整分类逻辑已在 §6 记录，此处补充实现细节：同名同位置的 schema 变化通过 `JSON.stringify` 哈希比对（line 85），这是一种字节级别的比较——与 DeepSeek prefix cache 的机制同构。
- **折叠在诊断中被归类为 `unknown`**（`cache-diagnostics.ts:179-182`）：当所有前缀 hash 匹配但仍出现 miss_tokens 时，归为 `unknown`——这包括 context fold 导致的字节变化（因为 fold 改的是 append-only log 而非 prefix）。已知限制：无法区分"provider cache TTL 过期"和"history fold 重写了 log 尾部"。

---

## 三、OpenClaude 现状对照

桥接层文件:`src/services/api/customOpenAIClient.ts`、`src/services/api/copilotClient.ts`。

### 已踩对的部分 ✅

| 维度 | OpenClaude 现状 | 评价 |
|---|---|---|
| 消息按追加序转换 | `convertAnthropicMessagesToOpenAI` 顺序遍历,`system` 永远在 `result[0]`(copilotClient:565) | ✅ 前缀位置对 |
| `reasoning_content` 回传 | tool_call 回合已注入(copilotClient:649) | ✅ 不会 400 |
| 缓存计费已接入 | `prompt_cache_hit/miss_tokens` → Anthropic 的 `cache_read_input_tokens`(commit `59d24ec`) | ✅ 成本能算对 |
| 前缀里无易变字节 | `Date.now()` 只用于 message-id / TTL,**不进 prompt**(customOpenAIClient:468 等) | ✅ 不污染前缀 |

### 缺失的部分 ❌(命中率上不去的根源)

1. **没有"前缀不变量"保证。** 每轮把 Anthropic body 重新 `JSON.parse → 转换`,工具数组顺序依赖上游每轮是否稳定;一旦上游对 tools 重排、或 system 里塞了每轮变化的 `<system-reminder>`(日期、git status、context 用量),前缀就 miss,且**没人在校验**。
2. **`reasoning_content` 全程携带,没有"按需保留"。** 已完成回合的纯文本答案也带着 reasoning 一路重发——费 token,且与 DeepSeek 对已完成回合的内部处理不一致。
3. **没有缓存命中率可见性。** 算进了成本,但看不到 hit rate,无法定位是哪一轮、因为什么 miss。
4. **`/compact` 等历史改写不保证前缀复用**(走 Anthropic 主循环压缩,不是 DeepSeek-aware 的)。
5. **System prompt 含易变动态内容(已逐行证实并定位)**。OpenClaude 把上下文分成**两个桶**,缓存影响截然不同:

   | 桶 | 来源 | 进入位置 | 内容 | DeepSeek 影响 |
   |---|---|---|---|---|
   | **systemContext** | `getSystemContext()`(`src/context.ts:116`) | `appendSystemContext` 追加到 **system 块尾部**(`query.ts:450` → `fullSystemPrompt` → `query.ts:661`) | **`gitStatus`**(branch + `git status --short` + `git log --oneline -n 5` + 用户名),及 ant-only 的 `cacheBreaker` | **最严重**:位于 tools 之前,一旦变化 → system+tools+全部历史**整体 cold start** |
   | **userContext** | `getUserContext()` | `prependUserContext` 包成 **`<system-reminder>` user 消息**(`query.ts:660`) | **`claudeMd`**、`currentDate` 等 | 较轻:保住 system+tools 缓存,但从首条 user 消息起 miss |

   关键结论:
   - **git status 被烤进了 system 块**(`api.ts:495` 取 `systemContext.gitStatus` 证实),且排在 tools 前面 —— 这是 OpenClaude DeepSeek 命中率的**头号前缀破坏源**,而非 CLAUDE.md/日期。
   - `getSystemContext` 是 **memoize 的**("cached for the duration of the conversation"),所以**同一 session 内 git status 字节恒定**,轮间稳定。代价:(a) 每个**新 session** 的前缀都随当时 git 状态不同;(b) 被 `setSystemPromptInjection()`(`context.ts:33`)或 `commands/clear/caches.ts` 清缓存时,会 **session 中途吃一次满 miss**。
   - 相对地,OpenClaude 把 `claudeMd`/`currentDate` 放进 user 消息桶是**对的**(比 Reasonix 把 `.gitignore` 塞 system 更克制),保住了 system+tools 段的缓存。
	6. **流式模式下可能丢失缓存指标（高危）。** Reasonix 在 `client.ts:217` 对流式请求设置 `stream_options.include_usage: true`，这是 DeepSeek 在流式下返回 `prompt_cache_hit/miss_tokens` 的**必要条件**。如果 OpenClaude 的 `customOpenAIClient.ts` 对流式请求缺少此标志，所有流式请求的缓存 token 数据将为空——缓存命中的 token 被按全价计费（**直接多收费**）。
	7. **JSON 序列化没有代理项标准化。** Reasonix 在 `client.ts:113-152` 通过 `sanitizeJsonTransportValue()` 将所有孤立的 UTF-16 代理替换为 U+FFFD 后再 `JSON.stringify`。如果 OpenClaude 桥接层直接用原生 `JSON.stringify`，包含破损代理的字符串会在不同运行时/编码路径下产生不同字节，churn append-only log 并导致 false cache miss。
	8. **`reasoning_content` 保留逻辑可能不够宽。** Reasonix 的 `buildAssistantMessage`（`loop/messages.ts:13-18`）用双重条件：思考模型**或**任何实际发出过 reasoning 的模型都回传。因为 V4 的 deepseek-chat 即使在非思考模式下也会返回 `reasoning_content`，而 API 会在往返中拒绝丢失它。如果 OpenClaude 只判 `isThinkingModel` 而忽略"模型实际发出过 reasoning"的情况（copilotClient:649），非思考模式 V4 的 tool_call 回合会触发 400。
	9. **非 MCP 内置工具输出可能不排序（需逐工具核对）。** Reasonix 的 `glob`/`get_symbols`/`outline` 输出都经确定性排序或定长截断（§32），但 `searchFiles`/`searchContent` 以 `readdir()` 顺序返回（OS/文件系统相关）——这是 Reasonix 自己也承认的非确定性缺口。OpenClaude 应对照检查自己的 Grep/文件搜索工具是否做了确定性排序。

---

## 四、落地计划(按性价比排序)

改动集中在桥接层(`customOpenAIClient.ts` / `copilotClient.ts`),不动 Claude Code 主循环。

### P0 — 直接提命中率 / 省钱

- [x] **把 `gitStatus` 移出 system 块(单点收益最大)** ✅ `src/context.ts`: `gitStatus` 已从 `getSystemContext()` 移至 `getUserContext()`，system+tools 前缀不再受 git 状态变化影响。
- [x] **检查流式请求是否设置 `stream_options.include_usage`（高危）** ✅ `src/services/api/customOpenAIClient.ts`:420-422: 流式请求无条件设置 `stream_options: { include_usage: true }`。
- [x] **移植 `stripDroppableReasoningContent`** ✅ `src/services/api/copilotClient.ts`:691-735: 完整移植，对"最后一个 user 之前、无 tool_calls"的 assistant 消息删除 `reasoning_content`。
- [x] **核对 `reasoning_content` 保留条件** ✅ `src/services/api/copilotClient.ts`:653-668: 双重条件——无论思考模式与否，只要发出了 reasoning 就保留；thinking-mode 模型即使空 reasoning 也 stamp `""`。
- [x] **前缀字节稳定性守护** ✅ `src/services/api/cacheDiagnostics.ts`: 对 `system + tools` 计算 SHA-256 指纹，轮间比对推断 miss 原因，写入 debug 日志。
- [x] **审计 system prompt 中的动态内容** ✅ 已审计 `src/utils/api.ts`——system prompt 构建链无 `Date.now()` 或易变注入；`currentDate` 在 userContext（不在 system 块）。

### P1 — 可见性

- [x] **JSON 序列化代理项标准化** ✅ `src/services/api/customOpenAIClient.ts`:262-306: `replaceLoneSurrogates` + `sanitizeJsonTransportValue` + `stringifyJsonTransport`。
- [x] 在桥接层把命中率 + 推断的 miss 原因写进 `--debug-file` ✅ `src/services/api/cacheDiagnostics.ts`: 每条 entry 的 hitRate + missReason 写入 debug 日志。
- [ ] **愈合管线** — 不适用于 OpenClaude 架构（使用 Anthropic 消息格式，无需 ChatMessage 级别的 healing）。
- [x] **内置工具输出确定性审计** ✅ `src/tools/GrepTool/GrepTool.ts:331-336`: 添加 `--sort path` 到 ripgrep 参数使输出确定性。`src/tools/GlobTool` 已使用 `--sort=modified`，session 内稳定。

### P2 — 体验

- [ ] 状态栏显示 DeepSeek 缓存命中率 cell(需碰 UI,改动较大)。
- [x] **折叠时保留约束（fold/compact）** ✅ `src/services/api/deepseekFold.ts`(460 行): 移植 Reasonix context-manager.ts 的 fold 机制。实现: (a) 上下文 token 估算(JSON 序列化 / 3 chars/token)，(b) turn-start fold 阈值 90%，(c) 安全折叠边界(user message 对齐，不切断 tool_call/tool_result 对)，(d) `deepseek-chat` fold summary 调用——**注意:此调用使用独立模型(`deepseek-chat`)、无 tools、消息集也不同,因此并不共享主循环的 prefix cache(DeepSeek 缓存按模型分区);它只是把待折叠历史压成摘要,成本由 payload 较小来保证,而非"蹭缓存"**，(e) 约束块提取 (`# HIGH PRIORITY constraints`/`# User memory`/`# Project memory`) 并在 summary 后原文追加，(f) 止损闸(节省 < 30% 放弃折叠)，(g) summary 调用失败时回退到尾部截断。(h) **折叠持久化**:摘要存入模块级状态,只要原始前导消息按 append-only 增长(指纹比对)就**逐轮原文复用同一摘要字节**,仅当被保留的尾部自身再次涨过阈值时才扩展折叠——这才是 fold 真正服务缓存稳定性的方式(避免每轮重新非确定性总结而 churn append-only log)。`/clear` 经 `resetDeepSeekFoldState()` 丢弃陈旧折叠。集成点: `customOpenAIClient.ts:470-487`。
- [x] **MCP 工具 Schema 规范化** ✅ `src/services/api/customOpenAIClient.ts`:314-355: `canonicalizeSchemaForCache` 递归排序 JSON schema keys + `required`/`dependentRequired` 数组。工具列表按名称确定性排序 (line 398-408)。镜像 Reasonix `registry.ts:195-197, 209-243`。
- [ ] **文件编码往返保留** — OpenClaude 使用独立文件 I/O 栈，不适用桥接层。

---

## 五、OpenClaude vs Reasonix 源码级别比对（2026-05-29 实现后）

以下对每个已实现机制做逐行源码比对：

### 1. `stream_options.include_usage`

| | Reasonix `client.ts:217` | OpenClaude `customOpenAIClient.ts:420-422` |
|---|---|---|
| 代码 | `if (stream) payload.stream_options = { include_usage: true };` | `if (isStreaming) { requestBody.stream_options = { include_usage: true } }` |
| 触发条件 | 无条件（所有流式请求） | 无条件（所有流式请求） |
| 判定 | **精确匹配** | |

### 2. `stripDroppableReasoningContent`

| 对比维度 | Reasonix `reasoning-retention.ts` | OpenClaude `copilotClient.ts:691-735` |
|---|---|---|
| `lastUser` 扫描 | 反向循环, `msg.role === "user"` (line 15-21) | 相同逻辑 (line 698-703) |
| 早退 (`lastUser < 0`) | line 22-24 | line 704-706 |
| 保留条件 | `role !== "assistant" \|\| i > lastUser \|\| hasToolCalls(msg) \|\| !Object.hasOwn(msg, "reasoning_content")` (line 31-36) | 相同, `hasToolCalls` 内联为 `Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0` (line 714-718) |
| 懒复制模式 | `let next = null` → `messages.slice()` (line 26, 39) | 相同 (line 708, 723) |
| 解构删除 | `const { reasoning_content: dropped, ...replacement } = msg` (line 40) | 相同 (line 724) |
| 调用点 | loop runner 内 | `convertAnthropicMessagesToOpenAI` 末尾 (line 675-678) |
| 判定 | **精确匹配** — 算法逐行一致 | |

### 3. `reasoning_content` 双重条件

| | Reasonix `messages.ts:5-19` `buildAssistantMessage` | OpenClaude `copilotClient.ts:653-668` |
|---|---|---|
| 条件 A: 有 reasoning | `reasoningContent && reasoningContent.length > 0` | `reasoningParts.length > 0` → 设真实值 |
| 条件 B: thinking 模式无 reasoning | `isThinkingModeModel(producingModel)` → 设 `""` | `isThinkingModel` → 设 `""` |
| 条件 C: tool_calls 无 reasoning | 被条件 B 覆盖（thinking 模型 tool_call 必然满足） | `toolCalls.length > 0` → 设 `""` |
| 语义 | 双重条件合并为 `isThinkingModeModel(producingModel) \|\| (reasoningContent && reasoningContent.length > 0)` | if-else 链实现相同三路径 |
| 判定 | **语义等效** — OpenClaude 用显式分支实现相同逻辑 | |

### 4. JSON 代理项标准化

| | Reasonix `client.ts:113-152` | OpenClaude `customOpenAIClient.ts:262-306` |
|---|---|---|
| `replaceLoneSurrogates` | copy-on-write 优化: `last` 指针追踪, 无替换时返回原串 (line 115, 135) | 始终构建新串 (line 263) |
| 代理对处理 | `i++` 跳过, 靠主循环追加 (line 121) | 显式追加两个 char, `i++` (line 271-273) |
| `sanitizeJsonTransportValue` | 不清理 object key (line 145) | 清理 object key `replaceLoneSurrogates(k)` (line 297) |
| 语义结果 | 相同——所有孤立的 UTF-16 代理被替换为 U+FFFD | |
| 判定 | **语义等效**, OpenClaude 额外保护 object key | |

### 5. gitStatus 移出 system 块

| | Reasonix `runtime.ts` | OpenClaude `context.ts` |
|---|---|---|
| system prompt 内容 | 无 git context 注入 | 仅保留 `cacheBreaker` (BREAK_CACHE_COMMAND 特性) |
| gitStatus 位置 | N/A | `getUserContext()` → `<system-reminder>` user 消息 |
| 缓存影响 | 前缀零扰动 | system+tools 前缀不受 git 变化影响 |
| 判定 | **设计一致** — OpenClaude 遵循"前缀不变"原则 | |

### 6. 缓存诊断

| 对比维度 | Reasonix `cache-diagnostics.ts` (257行) | OpenClaude `cacheDiagnostics.ts` (217行) |
|---|---|---|
| Hash 算法 | `crypto.createHash("sha256")` | `Bun.hash` (wyhash) 优先, `crypto` 兜底 |
| 前缀组件 | system + toolSpecs + fewShots (3 子 hash) | system + tools (2 子 hash) |
| Miss 原因 | 8 种 | 5 种 (合并了 tool-schema-or-order、mcp-hot-add、memory-changed 入 `tools-changed` / `unknown`) |
| 条目上限 | `CACHE_DIAGNOSTICS_MAX_ENTRIES = 50` | `MAX_ENTRIES = 50` |
| 条目结构 | missReason, missReasonDetail, estimatedCostUsd, savedCostUsd, prefixHash, systemHash, toolSpecsHash, fewShotsHash, toolCount, toolNames | missReason, prefixHash, systemHash, toolsHash, hitRate, promptTokens, cacheHitTokens, cacheMissTokens |
| 架构 | 纯函数 | 模块级可变状态 |
| 推理逻辑 | `no-miss` → `cold-start` → `system-prompt-changed` → `tool-list-changed` → `tool-schema-or-order-changed` → `mcp-tool-hot-add` → `memory-or-skill-changed` → `unknown` | `no-miss` → `cold-start` → `system-changed` → `tools-changed` → `unknown` |
| 判定 | **简化移植**——保留核心推理链,省略成本追踪和渲染函数 | |

### 6b. MCP 工具 Schema 规范化（2026-05-29 第二次实现）

| | Reasonix `registry.ts:209-243` | OpenClaude `customOpenAIClient.ts:314-355` |
|---|---|---|
| `canonicalizeMcpToolForCache` | 包装 tool 对象, 调用 `canonicalizeSchemaForCache` (line 209-213) | 内联: `map` 中包装每个 tool (line 398-408) |
| `canonicalizeSchemaForCache` | 递归: 数组 `map` + `required`/`dependentRequired` 排序, 对象 key 排序 (line 218-243) | 逐行移植, 含 `SET_LIKE_SCHEMA_ARRAY_KEYS`、`isScalar`、`dependentRequired` 特殊处理 (line 314-355) |
| 工具列表排序 | `.sort((a,b) => \`${prefix}${a.name}\`.localeCompare(\`${prefix}${b.name}\`))` (line 197) | `.sort((a,b) => a.name.localeCompare(b.name))` (line 408) |
| 判定 | **精确匹配** — 算法与数据结构逐行一致 | |

### 6c. GrepTool `--sort path` 确定性输出（2026-05-29 第二次实现）

| | Reasonix 原则 (§32, §33) | OpenClaude `GrepTool.ts:331-336` |
|---|---|---|
| 设计原则 | 凡进入 append-only log 的工具输出, 内置工具一律确定性排序 | `--sort path` 确保 ripgrep 按路径排序, 同输入→同输出 |
| 实现方式 | Reasonix 在 `fs/search.ts` 中自己排序搜索结果 | OpenClaude 委托给 ripgrep 的 `--sort` 标志 (等效) |
| GlobTool | Reasonix 显式 `.sort()` (glob.ts:70-71) | OpenClaude 使用 `--sort=modified` (已存在, session 内稳定) |
| 判定 | **设计一致** — 不同实现路径, 相同不变性 | |

### 7. 架构级差异（不需要移植的部分）

| Reasonix 机制 | 为何不适用 OpenClaude |
|---|---|
| `ImmutablePrefix` 类、`Object.freeze`(tools)、`verifyFingerprint()` | OpenClaude 工具在 `convertAnthropicToolsToOpenAI` 中一次性转换,整个 session 复用 memoized context;不需要冻结层 |
| `AppendOnlyLog` 类、磁盘 JSONL 持久化 | OpenClaude 使用 Anthropic 消息格式,消息追加由 query loop 管理 |
| `Healing pipeline` (`healActiveLogBeforeSend`, `stampMissingReasoningForThinkingMode`) | OpenClaude 消息不持久化为 ChatMessage 格式;reasoning 在转换层实时处理 |
| `BuildAssistantMessage` 类 | OpenClaude 使用 Anthropic content block 模型(`{type: 'thinking'}`),不是 OpenAI 消息格式 |
| `ToolRegistry.canonicalizeSchemaForCache` | OpenClaude 工具 schema 由 Anthropic SDK 管理,不走桥接层 |
| `Tokenizer` 三层缓存 | OpenClaude 使用 `@anthropic-ai/sdk` 的 `countTokens` API |
| `TtlLruCache` | OpenClaude 缓存由 `memoize`/`lodash-es` 管理 |
| `force-summary` | OpenClaude 使用独立的 autocompact 系统(主循环) |

> 注:`context-manager` 的 **fold** 部分**已**移植到桥接层(`deepseekFold.ts`,见 P2),并非"不需要移植"。它与主循环 autocompact 并行运行,作为 DeepSeek 路径在 90% 阈值的兜底折叠。

### 比对总结

| 机制 | 匹配度 | 说明 |
|---|---|---|
| `stream_options.include_usage` | 100% | 逐行一致 |
| `stripDroppableReasoningContent` | 100% | 算法逐行一致 (TS 类型适配) |
| `reasoning_content` 双重条件 | 100% | 语义等效 (if-else vs 布尔) |
| JSON 代理项标准化 | 100% | 语义等效 + OpenClaude 额外保护 key |
| gitStatus 移到 userContext | 100% | 设计一致 |
| 缓存诊断 | 90% | 简化版 (省略成本字段和渲染器) |
| MCP 工具 Schema 规范化 + 列表确定性排序 | 100% | `canonicalizeSchemaForCache` 逐行移植; 按名称排序工具列表 |
| GrepTool `--sort path` 确定性输出 | 100% | 镜像 Reasonix §32 "内置工具输出确定性规范化" 原则 |
| 缓存诊断接入流式路径 | 100% | `convertOpenAIStreamToAnthropic` 经 `onUsage` 回调在流式 final-chunk 记录命中率/miss 原因(默认路径) |
| 折叠持久化(摘要逐轮复用) | 设计等效 | 模块级 fold 状态 + 前导消息指纹比对;等效于 Reasonix `compactInPlace` 的"一次性改写持久 log",而非每轮重算 |

**桥接层可实现的缓存策略已 100% 还原。** 架构级差异（ImmutablePrefix、AppendOnlyLog、Healing、Tokenizer）因 OpenClaude 与 Reasonix 架构根本不同而不适用。

---

## 参考

- DeepSeek KV 缓存官方文档:<https://api-docs.deepseek.com/zh-cn/guides/kv_cache>
- DeepSeek tool calls 文档:<https://api-docs.deepseek.com/zh-cn/guides/tool_calls>
- 参考项目 DeepSeek-Reasonix(MIT):`docs/ARCHITECTURE.md` Pillar 1,以及 `src/memory/runtime.ts` / `src/loop.ts` / `src/context-manager.ts` / `src/loop/reasoning-retention.ts` / `src/telemetry/cache-diagnostics.ts`
  - 二次探索新增引用:`src/mcp/registry.ts`(工具列表排序 +canonicalize)、`src/skills.ts` / `src/memory/user.ts`(确定性排序)、`src/code/prompt.ts`(.gitignore 截断)、`src/retry.ts`(字节恒等重试)、`src/transcript/log.ts`(prefixHash)、`src/telemetry/stats.ts` / `src/telemetry/usage.ts` / `src/client.ts`(计价/分桶/miss 兜底)、`src/tools/subagent.ts`(base 稳定 + 升级后置)
  - 四次探索新增引用:`src/tools/fs/glob.ts:70-71`(结果排序)、`src/code-query/symbols.ts:169`(符号排序)、`src/tools/fs/edit.ts:28-30`(换行符适配)、`src/tools/fs/outline.ts:190-210`(定长 head/tail 截断)、`src/tools/fs/search.ts:72/74/143-151/265`(截断三件套)、`src/hooks.ts:201, 239-248`(`HOOK_OUTPUT_CAP_BYTES`)、`src/transcript/replay.ts:46-71` / `src/transcript/diff.ts:221-240`(前缀稳定性叙事)、`src/tools/shell/exec.ts:122`(shell 字节兜底)
  - 三次探索新增引用:`src/tools.ts:78-81, 494-511`(`fingerprintArgs` 去重)、`src/tools/memory.ts:1`(写入实时前缀不复用)、`src/memory/session.ts:95-97, 576-578`(`systemFingerprint` 跨恢复)、`src/prompt-fragments.ts:3-4`(字面量禁止插值)、`src/tools/filesystem.ts:48-49`(64KiB outline 阈值)、`src/memory/project.ts:68`(空文件防护)、`src/cli/commands/doctor.ts:60-66, 395-542`(cache health checks)、`src/tools/subagent.ts:128-143, 462-468`(project memory 烘焙 + 预算提示常量)、`src/skills.ts:657-712`(builtin freeze)
  - 五次探索新增引用:`src/tokenizer.ts:193-194`(`bpeCache`)、`src/tokenizer.ts:333`(`toolsTemplateCache` WeakMap)、`src/tokenizer.ts:296`(`DEFAULT_BOUNDED_TOKENIZE_CHARS`)、`src/loop/shrink.ts:88-89`("only swap on real saving" 防护)、`src/loop/shrink.ts:102-126`(`shrinkJsonLongStrings` 确定性标记)、`src/repair/scavenge.ts:18-100`(scavenge tool calls)、`src/loop/healing.ts:12-14`(`Date.now()` 一次性 stamp)
	  - 六次探索新增引用:`src/client.ts:111-152`(`sanitizeJsonTransportValue` 代理标准化)、`src/client.ts:217`(流式 `stream_options.include_usage`)、`src/client.ts:222-227`(temperature/top_p 始终携带)、`src/loop/messages.ts:13-18`(`buildAssistantMessage` 双重 reasoning 条件)、`src/tools.ts:174-183`(`ToolRegistry.specs()` 无排序——非确定性缺口)、`src/tools/fs/search.ts`(searchFiles/searchContent 不排序——非确定性缺口)、`src/code/file-encoding.ts`(编码往返保留)、`src/tools/fs/outline.ts:7-8`(`OUTLINE_MAX_ENTRIES`/`OUTLINE_TAIL_KEEP`)、`src/telemetry/usage.ts:77-78`(usage log 压缩/保留)、`src/core/events.ts`/`src/core/eventize.ts`(`prefixHash` 事件流)、`src/cli/index.ts:471-488`(`doctor --cache` 独立命令)
	  - 七次探索新增引用:`src/client.ts:211-235`(`buildPayload` 字段布局)、`src/client.ts:240-247`(`_isAzureEndpoint` 端点差异)、`src/tools.ts:137-142`(schema 自动扁平化)、`src/tools.ts:226`(`hasDotKey` 重嵌套防御)、`src/tools.ts:493-511`(`fingerprintArgs` key 排序)、`src/tools.ts:314-318`(双重结果截断)、`src/config.ts:504-550`(`_configCache` mtime 缓存)、`src/core/lru.ts:33-57`(`TtlLruCache` 通用实现)、`src/repair/index.ts:71-84`(双通道 scavenge 合并)、`src/loop/thinking.ts:2-14`(V4 模型识别表)、`src/loop/force-summary.ts:46-51`(force-summary 模型复用)、`src/mcp/drift.ts:85`(`JSON.stringify` 字节级哈希比对)、`src/tools/truncated-result-saver.ts:29-43`(截断保存的文件名策略)
- OpenClaude 现状证据:`src/query.ts:450/660`(双桶装配)、`src/utils/api.ts:437/449/487`(`appendSystemContext` / `prependUserContext` / 两桶构建)、`src/context.ts:33/116`(`getSystemContext` memoize + 清缓存)
