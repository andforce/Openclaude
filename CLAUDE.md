# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **OpenClaude** (v2.1.88) — an independent, rebranded fork of the Claude Code CLI, reconstructed from the `@anthropic-ai/claude-code` npm package source map. The codebase is a TypeScript/React terminal application built with Bun. The shipped binary is `openclaude`, and it stores runtime data (config, sessions, plugins, cache, teams) under `~/.openclaude` by default (override with `OPENCLAUDE_CONFIG_DIR`). README.md is in Chinese and documents the end-user install flow (`install.sh`).

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

