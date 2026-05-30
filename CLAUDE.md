# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **OpenClaude** (v2.1.88) — an independent, rebranded fork of the Claude Code CLI, reconstructed from the `@anthropic-ai/claude-code` npm package source map. The codebase is a TypeScript/React terminal application built with Bun. The shipped binary is `openclaude` (a thin Node wrapper at `bin/openclaude.cjs` that loads `dist/cli.js`), and it stores runtime data (config, sessions, plugins, cache, teams) under `~/.openclaude` by default (override with `OPENCLAUDE_CONFIG_DIR`). README.md is in Chinese and documents the end-user install flow (`install.sh`).

## Build System

**Build Tool:** Bun v1.3.11 (pinned; required for the `bun:bundle` `feature()` API used for dead-code elimination)

**Package Manager:** pnpm (`node_modules` is committed, so install is optional)

### Common Commands

```bash
# Build the project (package.json pins the Bun version via npx)
npx --yes bun@1.3.11 run build.ts   # or: pnpm build

# Run the built CLI
npx --yes bun@1.3.11 dist/cli.js --version   # or: pnpm start

# Dev / debug workflow — builds then runs dist/cli.js under Node (the recommended path)
./run-dev.sh -- --version
./run-dev.sh --no-build -- --help     # skip rebuild
./run-dev.sh --inspect -- -p "hi"     # launch under the Node inspector (port 9229)

# Install dependencies (optional, node_modules is committed)
pnpm install --registry https://registry.npmjs.org
```

> **Do not run `src/entrypoints/cli.tsx` directly.** Per `run-dev.sh`, the source does not run reliably without the build step because `MACRO` constants and feature flags are only injected at bundle time. Always build first (or use `run-dev.sh`, which builds for you).

### Debug Logging

To trace model provider / base URL / `/model` switching, write a debug log and tail the API request lines:

```bash
./run-dev.sh -- --debug-file /tmp/oc-debug.log
tail -f /tmp/oc-debug.log | rg "API REQUEST|API:request|Anthropic SDK"
```

### Build Configuration

The build is configured in `build.ts`:
- Entry point: `src/entrypoints/cli.tsx`
- Output: `dist/cli.js` (ES module, 22MB)
- Target: Node.js
- Source maps: linked

**Feature Flags:** 90+ compile-time feature flags defined in `build.ts`. Key flags include:
- `BRIDGE_MODE: false` - IDE bridge (disabled in production)
- `COORDINATOR_MODE: false` - Multi-agent coordination
- `BUILTIN_EXPLORE_PLAN_AGENTS: true` - Built-in exploration/planning agents
- `TOKEN_BUDGET: true` - Token budget display
- `MCP_SKILLS: true` - MCP skill support

**MACRO Constants:** Build-time constants injected via `define`:
- `MACRO.VERSION` - Version string ("2.1.88")
- `MACRO.BUILD_TIME` - ISO build timestamp
- `MACRO.ISSUES_EXPLAINER` - Support URL
- `MACRO.FEEDBACK_CHANNEL` - Feedback URL
- `MACRO.PACKAGE_URL` / `MACRO.NATIVE_PACKAGE_URL` - npm package URL
- `MACRO.VERSION_CHANGELOG` - Changelog URL
- `Bun.env.NODE_ENV` - Set to `"production"`

## Architecture

### Entry Points

- **`src/entrypoints/cli.tsx`** - Main CLI entry point. Handles argument parsing, initialization, and launches the REPL or executes commands directly.
- **`src/main.tsx`** - Core REPL logic and command processing.

### Key Directory Structure

```
src/
├── entrypoints/     # Application entry points (cli.tsx, etc.)
├── commands/        # Slash commands (~220 files)
├── components/      # Terminal UI React components (~394 files)
│   ├── design-system/  # UI primitives
│   ├── messages/       # Message rendering
│   └── permissions/    # Permission dialogs
├── tools/           # Tool implementations (~200 tools)
│   ├── AgentTool/      # Subagent spawning
│   ├── BashTool/       # Shell execution
│   ├── File*Tool/      # File operations
│   └── ...
├── services/        # Core business logic (~140 files)
│   ├── mcp/            # MCP (Model Context Protocol)
│   ├── api/            # API clients
│   └── analytics/      # Telemetry/GrowthBook
├── utils/           # Utility functions (~570 files)
├── hooks/           # Lifecycle hooks (~106 files)
├── ink/             # Custom terminal rendering engine (~98 files)
├── types/           # Shared TypeScript types
└── vendor/          # Internal vendor code
```

### Provider Architecture

OpenClaude supports multiple AI providers beyond the Anthropic first-party API. Provider selection is managed via `/connect` and `/disconnect` slash commands, with credentials stored in the global config (`connectedProviders`).

**Provider types and model value prefixes:**

| Provider | Model prefix | Protocol |
|---|---|---|
| Anthropic first-party | (no prefix) | Native Anthropic Messages API |
| GitHub Copilot | `copilot:` | OpenAI-compatible chat completions |
| OpenRouter | `openrouter:` | Anthropic-compatible API |
| Custom OpenAI-compatible | `custom-openai:`, `openai-compatible:` | OpenAI chat completions |
| Custom Anthropic-compatible | `anthropic-compatible:` | Anthropic Messages API |

**Anthropic-to-OpenAI protocol bridge** (`src/services/api/copilotClient.ts`): Shared by Copilot and Custom OpenAI paths. Converts Anthropic messages, tools, tool_choice, and streaming responses to/from OpenAI chat completions format. The bridge is reused by `customOpenAIClient.ts` for all OpenAI-compatible providers.

**Multi-provider routing for custom-openai** (`src/utils/customOpenAIProviders.ts`): Multiple OpenAI-compatible endpoints can be connected simultaneously. The first uses the legacy `custom-openai` provider ID; additional endpoints get slug-scoped IDs (`custom-openai:<host-slug>`). Model values are `openai-compatible:<providerId>:<model>` (or `custom-openai:<model>` for the legacy single-provider format).

**Provider-specific features in `customOpenAIClient.ts`:**
- **DeepSeek**: context folding via `deepseekFold.ts` (summarizes oldest messages to stay under 128K window), strict tool mode (requires `additionalProperties: false`, nullable optionals), tool schema canonicalization for prefix cache stability, and `stream_options.include_usage` for correct cache billing in streaming responses.
- **Kimi**: requires `reasoning_content` echoed back on assistant tool-call turns (otherwise the API 400s on the round-trip).
- **Generic OpenAI**: `max_completion_tokens` vs `max_tokens` switching for o1/o3/o4/gpt-5 reasoning models.

**Model resolution** (`src/utils/model/`):
- `model.ts` — canonical model names, default model selection, pricing
- `modelOptions.ts` — builds the `/model` command's selector list across all connected providers
- `providers.ts` — first-party API provider detection (bedrock/vertex/foundry/firstParty)
- `modelSupportOverrides.ts` — per-model capability overrides (e.g., parallel tool calls, image support)

**Client creation** (`src/services/api/client.ts`): The central `createAnthropicClient()` factory resolves which provider to use based on the model prefix and builds the appropriate SDK client or fetch-override (for non-Anthropic providers).

### Core Concepts

**Tool System** (`src/Tool.ts`):
- Tools are the primary interface for LLM interactions
- Each tool implements: `call()`, `description()`, `inputSchema`, `checkPermissions()`, render methods
- Tools can be deferred (loaded on-demand via ToolSearch)
- Tools declare: `isReadOnly()`, `isDestructive()`, `isConcurrencySafe()`

**Task System** (`src/Task.ts`):
- Task types: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `dream`
- Task IDs are prefixed: `b` (bash), `a` (agent), `r` (remote), `t` (teammate), etc.
- Tasks have lifecycle: `pending` → `running` → `completed|failed|killed`

**Permission System** (`src/types/permissions.ts`):
- Modes: `default`, `auto`, `bypass`
- Rules: `alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules`
- Tools implement `checkPermissions()` for custom logic

**State Management** (`src/state/AppState.ts`):
- Centralized React-like state using immutable updates
- `setAppState()` for updates, `getAppState()` for reads
- Persisted to disk for session recovery

**Skills System** (`src/skills/`):
- Bundled skills shipped with the CLI (`src/skills/bundled/`)
- MCP skill builders (`mcpSkillBuilders.ts`) bridge MCP tools into the skill registry
- Skills are invoked via the Skill tool at runtime

### Technology Stack

- **Runtime:** Bun (bundling + execution)
- **UI Framework:** React + Ink (terminal React renderer)
- **Type System:** TypeScript 5.x with Zod for runtime validation
- **API Client:** @anthropic-ai/sdk
- **MCP:** @modelcontextprotocol/sdk

### Private Package Stubs

The following internal Anthropic packages are stubbed (not on public npm):
- `@ant/claude-for-chrome-mcp` - Chrome extension MCP
- `@anthropic-ai/sandbox-runtime` - Sandbox runtime
- `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/foundry-sdk`, `@anthropic-ai/vertex-sdk` - Cloud providers
- `@anthropic-ai/mcpb` - MCP bundle processor
- `color-diff-napi` - Syntax highlighting native module
- `modifiers-napi` - macOS key modifier detection

### Commander.js Patch

Multi-character short options (e.g., `-d2e`) require patching `node_modules/commander/lib/option.js`: change the regex `/^-[^-]$/` (around line 332) to `/^-[^-]+$/`. Note: the committed `node_modules` currently ships the **unpatched** regex, so reapply this if multi-char short flags misbehave.

## Development Notes

- **Bun-specific code:** Heavy use of `bun:bundle` `feature()` API for compile-time dead code elimination
- **File watching:** Uses `chokidar` for file system watching
- **Terminal handling:** Custom Ink-based rendering engine in `src/ink/`
- **Vim mode:** Custom implementation in `src/vim/`

## Testing

No test suite is included in the reconstructed source. Testing would require:
1. Setting up a test framework (Bun's built-in test runner)
2. Creating mock implementations of Anthropic API clients
3. Stubbing native modules

