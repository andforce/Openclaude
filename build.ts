/**
 * Build script for Claude Code source reconstruction.
 * Uses Bun's bundler with feature flag definitions and MACRO constants.
 */

const VERSION = '2.1.88'
const BUILD_TIME = new Date().toISOString()

// All feature flags - matching production external build defaults
const featureFlags: Record<string, boolean> = {
  ABLATION_BASELINE: false,
  AGENT_MEMORY_SNAPSHOT: false,
  AGENT_TRIGGERS: false,
  AGENT_TRIGGERS_REMOTE: false,
  ALLOW_TEST_VERSIONS: false,
  ANTI_DISTILLATION_CC: false,
  AUTO_THEME: false,
  AWAY_SUMMARY: false,
  BASH_CLASSIFIER: false,
  BG_SESSIONS: false,
  BREAK_CACHE_COMMAND: false,
  BRIDGE_MODE: false,
  BUDDY: true,
  BUILDING_CLAUDE_APPS: false,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  BYOC_ENVIRONMENT_RUNNER: false,
  CACHED_MICROCOMPACT: false,
  CCR_AUTO_CONNECT: false,
  CCR_MIRROR: false,
  CCR_REMOTE_SETUP: false,
  CHICAGO_MCP: false,
  COMMIT_ATTRIBUTION: false,
  COMPACTION_REMINDERS: true,
  CONNECTOR_TEXT: false,
  CONTEXT_COLLAPSE: false,
  COORDINATOR_MODE: false,
  COWORKER_TYPE_TELEMETRY: false,
  DAEMON: false,
  DIRECT_CONNECT: false,
  DOWNLOAD_USER_SETTINGS: false,
  DUMP_SYSTEM_PROMPT: false,
  ENHANCED_TELEMETRY_BETA: false,
  EXPERIMENTAL_SKILL_SEARCH: false,
  EXTRACT_MEMORIES: false,
  FILE_PERSISTENCE: false,
  FORK_SUBAGENT: false,
  HARD_FAIL: false,
  HISTORY_PICKER: false,
  HISTORY_SNIP: false,
  HOOK_PROMPTS: false,
  IS_LIBC_GLIBC: false,
  IS_LIBC_MUSL: false,
  KAIROS: false,
  KAIROS_BRIEF: false,
  KAIROS_CHANNELS: false,
  KAIROS_DREAM: false,
  KAIROS_GITHUB_WEBHOOKS: false,
  KAIROS_PUSH_NOTIFICATION: false,
  LODESTONE: false,
  MCP_RICH_OUTPUT: false,
  MCP_SKILLS: true,
  MEMORY_SHAPE_TELEMETRY: false,
  MESSAGE_ACTIONS: false,
  MONITOR_TOOL: false,
  NATIVE_CLIENT_ATTESTATION: false,
  NATIVE_CLIPBOARD_IMAGE: false,
  NEW_INIT: false,
  OVERFLOW_TEST_TOOL: false,
  PERFETTO_TRACING: false,
  POWERSHELL_AUTO_MODE: false,
  PROACTIVE: false,
  PROMPT_CACHE_BREAK_DETECTION: false,
  QUICK_SEARCH: false,
  REACTIVE_COMPACT: false,
  REVIEW_ARTIFACT: false,
  RUN_SKILL_GENERATOR: false,
  SELF_HOSTED_RUNNER: false,
  SHOT_STATS: false,
  SKILL_IMPROVEMENT: false,
  SLOW_OPERATION_LOGGING: false,
  SSH_REMOTE: false,
  STREAMLINED_OUTPUT: false,
  TEAMMEM: false,
  TEMPLATES: false,
  TERMINAL_PANEL: false,
  TOKEN_BUDGET: true,
  TORCH: false,
  TRANSCRIPT_CLASSIFIER: false,
  TREE_SITTER_BASH: false,
  TREE_SITTER_BASH_SHADOW: false,
  UDS_INBOX: false,
  ULTRAPLAN: false,
  ULTRATHINK: false,
  UNATTENDED_RETRY: false,
  UPLOAD_USER_SETTINGS: false,
  VERIFICATION_AGENT: false,
  VOICE_MODE: false,
  WEB_BROWSER_TOOL: false,
  WORKFLOW_SCRIPTS: true,
}

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  define: {
    // MACRO constants inlined at build time
    'MACRO.VERSION': JSON.stringify(VERSION),
    'MACRO.BUILD_TIME': JSON.stringify(BUILD_TIME),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('report the issue at https://github.com/anthropics/claude-code/issues'),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
    'MACRO.PACKAGE_URL': JSON.stringify('https://www.npmjs.com/package/@anthropic-ai/claude-code'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify('https://www.npmjs.com/package/@anthropic-ai/claude-code'),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    // Bun global
    'Bun.env.NODE_ENV': JSON.stringify('production'),
  },
  external: [
    '*.node',
    'sharp',
    '@img/*',
  ],
  plugins: [
    {
      name: 'unavailable-package-stub',
      setup(build) {
        // Stub out packages not available on public npm.
        // These are either Anthropic-internal or native addons
        // that are only loaded behind feature flags / try-catch at runtime.
        const stubPackages = [
          '@ant/claude-for-chrome-mcp',
          '@anthropic-ai/sandbox-runtime',
          '@anthropic-ai/bedrock-sdk',
          '@anthropic-ai/foundry-sdk',
          '@anthropic-ai/vertex-sdk',
          '@anthropic-ai/mcpb',
          'color-diff-napi',
          'modifiers-napi',
        ]
        const filter = new RegExp(
          '^(' + stubPackages.map(p => p.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')).join('|') + ')$'
        )
        build.onResolve({ filter }, (args) => ({
          path: args.path,
          namespace: 'stub-package',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub-package' }, (args) => {
          // Build a comprehensive stub that re-exports everything needed.
          const stubs: Record<string, string> = {
            '@ant/claude-for-chrome-mcp': `
export const BROWSER_TOOLS = [];
export const createClaudeForChromeMcpServer = undefined;
export const ClaudeForChromeContext = undefined;
export const Logger = undefined;
export const PermissionMode = undefined;
export default undefined;
`,
            '@anthropic-ai/sandbox-runtime': `
const noop = () => {};
const noopAsync = async () => {};
const noopFalse = () => false;
const noopTrue = () => true;
const noopObj = () => ({});
const noopArr = () => [];
const noopStr = () => '';
const noopUndef = () => undefined;
const noopUnsub = () => {};
const createSandboxViolationStore = () => ({
  getViolations: noopArr,
  getTotalCount: () => 0,
  clearViolations: noop,
  onViolation: noop,
  subscribe: () => noopUnsub,
});

export const SandboxManager = {
  checkDependencies: () => ({ errors: [], warnings: [] }),
  isSupportedPlatform: noopFalse,
  initialize: noopAsync,
  updateConfig: noop,
  reset: noopAsync,
  getFsReadConfig: noopObj,
  getFsWriteConfig: noopObj,
  getNetworkRestrictionConfig: noopObj,
  getIgnoreViolations: noopUndef,
  getAllowUnixSockets: noopUndef,
  getAllowLocalBinding: noopUndef,
  getEnableWeakerNestedSandbox: noopUndef,
  getProxyPort: noopUndef,
  getSocksProxyPort: noopUndef,
  getLinuxHttpSocketPath: noopUndef,
  getLinuxSocksSocketPath: noopUndef,
  waitForNetworkInitialization: async () => false,
  wrapWithSandbox: async (cmd) => cmd,
  cleanupAfterCommand: noop,
  getSandboxViolationStore: createSandboxViolationStore,
  annotateStderrWithSandboxFailures: (cmd, stderr) => stderr,
};
export const SandboxRuntimeConfigSchema = {};
export const SandboxViolationStore = class {
  getViolations() { return []; }
  getTotalCount() { return 0; }
  clearViolations() {}
  onViolation() {}
  subscribe() { return noopUnsub; }
};
export default undefined;
`,
            '@anthropic-ai/bedrock-sdk': `export const AnthropicBedrock = undefined; export default undefined;`,
            '@anthropic-ai/foundry-sdk': `export const AnthropicFoundry = undefined; export default undefined;`,
            '@anthropic-ai/vertex-sdk': `export const AnthropicVertex = undefined; export default undefined;`,
            '@anthropic-ai/mcpb': `export const getMcpConfigForManifest = () => { throw new Error('mcpb not available'); }; export default undefined;`,
            'color-diff-napi': `export const ColorDiff = undefined; export const ColorFile = undefined; export const getSyntaxTheme = () => undefined; export const SyntaxTheme = undefined; export default undefined;`,
            'modifiers-napi': `export const isModifierPressed = () => false; export const prewarm = () => {}; export default { isModifierPressed: () => false, prewarm: () => {} };`,
          }
          const contents = stubs[args.path] || `export default undefined;`
          return {
            contents: `// Stub: ${args.path}\n${contents}`,
            loader: 'js',
          }
        })
      },
    },
    {
      name: 'bun-bundle-feature-shim',
      setup(build) {
        // Intercept bun:bundle imports and replace feature() with compile-time values
        build.onResolve({ filter: /^bun:bundle$/ }, () => ({
          path: 'bun:bundle',
          namespace: 'bun-bundle-shim',
        }))
        build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => {
          const lines = Object.entries(featureFlags)
            .map(([k, v]) => `  '${k}': ${v},`)
            .join('\n')
          return {
            contents: `
const features = {\n${lines}\n};
export function feature(name) {
  if (name in features) return features[name];
  return false;
}
`,
            loader: 'js',
          }
        })
      },
    },
    {
      name: 'text-file-loader',
      setup(build) {
        // Load .md and .txt files as strings
        build.onLoad({ filter: /\.(md|txt)$/ }, async (args) => {
          const fs = await import('fs/promises')
          const contents = await fs.readFile(args.path, 'utf-8')
          return {
            contents: `export default ${JSON.stringify(contents)}`,
            loader: 'js',
          }
        })
        // Load .d.ts files as empty modules (they're type-only)
        build.onLoad({ filter: /\.d\.ts$/ }, () => ({
          contents: 'export {}',
          loader: 'js',
        }))
      },
    },
  ],
})

if (result.success) {
  // Add shebang to output
  const fs = await import('fs/promises')
  const outFile = result.outputs[0]!.path
  const content = await fs.readFile(outFile, 'utf-8')
  if (!content.startsWith('#!/')) {
    await fs.writeFile(outFile, `#!/usr/bin/env node\n${content}`)
  }
  await fs.chmod(outFile, 0o755)

  console.log('✓ Build succeeded')
  console.log(`  Output: ${result.outputs.map(o => o.path).join(', ')}`)
  const stat = await fs.stat(outFile)
  console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
} else {
  console.error('✗ Build failed')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
