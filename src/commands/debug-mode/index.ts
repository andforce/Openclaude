import type { Command } from '../../commands.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { DEBUG_SESSION_DIR, DEBUG_SESSION_TOOL_NAME } from '../../tools/DebugSessionTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'

const ALLOWED_TOOLS = [
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  BASH_TOOL_NAME,
  AGENT_TOOL_NAME,
  DEBUG_SESSION_TOOL_NAME,
]

function buildDebugModePrompt(args: string): string {
  const issue = args.trim() || 'The user did not provide a bug description yet.'

  return `# /debug-mode - Native Runtime Debugging

You are in OpenClaude debug mode. Debug mode is evidence-driven: insert temporary probes, collect runtime data, identify the root cause from logs, fix, verify, and clean up.

Debug artifact directory: \`${DEBUG_SESSION_DIR}/\`
Runtime log file: \`${DEBUG_SESSION_DIR}/debug.log\`
Use the \`${DEBUG_SESSION_TOOL_NAME}\` tool to initialize the session, add run separators, read logs, add verify separators, and clean up the debug directory.

## User Issue

${issue}

## Mandatory Checkpoints

Print each checkpoint marker exactly before moving past that step:

- \`CHECKPOINT 0: Context gathered\`
- \`CHECKPOINT 1: Probe plan created - N probes planned\`
- \`CHECKPOINT 2: Log collector initialized\`
- \`CHECKPOINT 3: N probes inserted into source files\`
- \`CHECKPOINT 4: N log entries collected\`
- \`CHECKPOINT 5: Root cause identified with log evidence\`
- \`CHECKPOINT 6: Fix applied and verified with probes\`
- \`CHECKPOINT 7: All probes removed, cleanup complete\`

Hard rules:

1. Do not print CHECKPOINT 5 until checkpoints 1-4 are complete.
2. Do not propose or apply a fix until you can cite specific collected log entries, except for asking the user for missing reproduction details.
3. Probe insertion must use the Edit tool to physically add probe blocks to source files.
4. Probe cleanup must use the Edit tool to remove every probe block.
5. Before final response, grep for \`DEBUG PROBE\`; no probe code may remain.
6. Use at most 3 instrumentation iterations. If still unresolved, summarize evidence and ask for the next reproduction clue.

## Workflow

### Step 0: Triage

If the user did not provide expected behavior, actual behavior, reproduction steps, consistency, and relevant errors, ask only for the missing details. If enough context is already present, continue.

After this, print:
\`CHECKPOINT 0: Context gathered\`

### Step 1: Understand and Plan Probes

Read relevant code. Form 2-3 hypotheses. Plan minimal probes on critical paths.

Output a compact table:

| # | File:Line | Label | Variables | Hypothesis |
|---|-----------|-------|-----------|------------|

Choose logging strategy:

- CLI, server, worker, script: file-based logging to \`${DEBUG_SESSION_DIR}/debug.log\`.
- Browser or frontend-only: \`console.log\` probes with \`[DEBUG PROBE N]\`; ask the user to paste console output if it cannot be captured directly.
- Android physical device: write probes to Logcat with tag \`OpenClaudeDebug\`, then use \`adb logcat\` to append matching lines into \`${DEBUG_SESSION_DIR}/debug.log\`.
- iPhone/iPad physical device: write probes to Apple logs and stdout/stderr using \`Logger\`/\`os_log\` plus \`print\`/\`NSLog\`, then capture with \`idevicesyslog\` when available or \`xcrun devicectl device process launch --console\` when the app can be launched from the CLI.
- macOS app: write probes with \`Logger\`/\`os_log\` plus stdout/stderr, then capture with \`/usr/bin/log stream\` or by teeing the launched app's console output.
- Hybrid: file-based for server code and console probes for browser code.

Then print:
\`CHECKPOINT 1: Probe plan created - N probes planned\`

### Step 2: Initialize Debug Session

Call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"init"}\` for file-based or hybrid logging. For frontend-only console logging, still use \`${DEBUG_SESSION_TOOL_NAME}\` only if file logs are useful.

Then print:
\`CHECKPOINT 2: Log collector initialized\`

### Step 3: Insert Probes

Every probe block must include START and END markers:

\`\`\`ts
// DEBUG PROBE [1] label
try {
  require('fs').appendFileSync('${DEBUG_SESSION_DIR}/debug.log', \`[\${new Date().toISOString()}] [js] file.ts:42 | label | value=\${JSON.stringify(value)}\\n\`)
} catch {}
// DEBUG PROBE END [1]
\`\`\`

Frontend probe example:

\`\`\`ts
// DEBUG PROBE [1] label
console.log(\`[DEBUG PROBE 1] label | value=\${JSON.stringify(value)}\`)
// DEBUG PROBE END [1]
\`\`\`

Python example:

\`\`\`py
# DEBUG PROBE [1] label
try:
    import datetime
    open("${DEBUG_SESSION_DIR}/debug.log", "a").write(f"[{datetime.datetime.now().isoformat()}] [python] file.py:42 | label | value={value}\\n")
except Exception:
    pass
# DEBUG PROBE END [1]
\`\`\`

Android Java example:

\`\`\`java
// DEBUG PROBE [1] label
try {
    android.util.Log.d("OpenClaudeDebug", "DEBUG PROBE [1] file.java:42 | label | value=" + String.valueOf(value));
} catch (Throwable ignored) {}
// DEBUG PROBE END [1]
\`\`\`

Android Kotlin example:

\`\`\`kt
// DEBUG PROBE [1] label
try {
    android.util.Log.d("OpenClaudeDebug", "DEBUG PROBE [1] file.kt:42 | label | value=\${value}")
} catch (_: Throwable) {}
// DEBUG PROBE END [1]
\`\`\`

Swift or SwiftUI example:

\`\`\`swift
// DEBUG PROBE [1] label
do {
    let message = "DEBUG PROBE [1] file.swift:42 | label | value=\\(String(describing: value))"
    if #available(iOS 14.0, macOS 11.0, *) {
        let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "OpenClaudeDebug", category: "OpenClaudeDebug")
        log.notice("\\(message, privacy: .public)")
    }
    print("[\\(message)]")
}
// DEBUG PROBE END [1]
\`\`\`

SwiftUI lifecycle probe example:

\`\`\`swift
.onAppear {
    // DEBUG PROBE [1] label
    let message = "DEBUG PROBE [1] ViewName.swift:42 | onAppear | value=\\(String(describing: value))"
    if #available(iOS 14.0, macOS 11.0, *) {
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "OpenClaudeDebug", category: "OpenClaudeDebug")
            .notice("\\(message, privacy: .public)")
    }
    print("[\\(message)]")
    // DEBUG PROBE END [1]
}
\`\`\`

Objective-C example:

\`\`\`objc
// DEBUG PROBE [1] label
@try {
    os_log_t log = os_log_create("OpenClaudeDebug", "OpenClaudeDebug");
    os_log_with_type(log, OS_LOG_TYPE_DEFAULT, "DEBUG PROBE [1] file.m:42 | label | value=%{public}@", value);
    NSLog(@"[DEBUG PROBE 1] file.m:42 | label | value=%@", value);
} @catch (__unused NSException *exception) {}
// DEBUG PROBE END [1]
\`\`\`

C example for CLI or desktop code:

\`\`\`c
// DEBUG PROBE [1] label
FILE *debug_file = fopen("${DEBUG_SESSION_DIR}/debug.log", "a");
if (debug_file) {
    fprintf(debug_file, "[DEBUG PROBE 1] file.c:42 | label | value=%d\\n", value);
    fclose(debug_file);
}
// DEBUG PROBE END [1]
\`\`\`

C/C++ example for Android NDK:

\`\`\`cpp
// DEBUG PROBE [1] label
__android_log_print(ANDROID_LOG_DEBUG, "OpenClaudeDebug", "DEBUG PROBE [1] file.cpp:42 | label | value=%d", value);
// DEBUG PROBE END [1]
\`\`\`

C/C++ example for Apple platforms:

\`\`\`cpp
// DEBUG PROBE [1] label
os_log_with_type(OS_LOG_DEFAULT, OS_LOG_TYPE_DEFAULT, "DEBUG PROBE [1] file.mm:42 | label | value=%{public}d", value);
fprintf(stderr, "[DEBUG PROBE 1] file.mm:42 | label | value=%d\\n", value);
// DEBUG PROBE END [1]
\`\`\`

For mobile physical-device debugging, do not rely on writing \`${DEBUG_SESSION_DIR}/debug.log\` from inside the app sandbox. Use platform logging probes and collect device logs from the host machine into \`${DEBUG_SESSION_DIR}/debug.log\`.

For Go, Rust, shell scripts, or other languages, adapt the probe to that language's normal append-to-file or platform console API. Keep the same \`DEBUG PROBE [N]\` / \`DEBUG PROBE END [N]\` markers, timestamp or host/device log timestamp, file:line, label, and observed variables.

Probe code must observe only; it must not alter program behavior.
If a probe requires a temporary import, include, logger declaration, or helper function, wrap that temporary addition in its own \`DEBUG PROBE [N]\` / \`DEBUG PROBE END [N]\` markers too.

Then print:
\`CHECKPOINT 3: N probes inserted into source files\`

### Step 4: Reproduce and Collect Logs

For file-based runs, call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_run","label":"short label"}\` before each reproduction command. Run the reproduction with Bash or ask the user to perform manual UI steps. For intermittent issues, collect 2-3 runs.

For Android physical-device runs:

1. List devices with \`adb devices -l\`. If multiple devices are connected, use \`adb -s <SERIAL> ...\`.
2. Before reproduction, call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_run","label":"android device"}\`.
3. Prefer bounded one-shot capture after reproduction:

\`\`\`sh
adb logcat -v time -d OpenClaudeDebug:D AndroidRuntime:E libc:E DEBUG:E '*:S' >> ${DEBUG_SESSION_DIR}/debug.log
\`\`\`

4. If the issue requires live capture while the user taps through the app, start and later stop a background collector:

\`\`\`sh
adb logcat -c
(adb logcat -v time OpenClaudeDebug:D AndroidRuntime:E libc:E DEBUG:E '*:S' >> ${DEBUG_SESSION_DIR}/debug.log & echo $! > ${DEBUG_SESSION_DIR}/android-logcat.pid)
# reproduce on the physical device
kill "$(cat ${DEBUG_SESSION_DIR}/android-logcat.pid)" 2>/dev/null || true
\`\`\`

For iPhone or iPad physical-device runs:

1. List devices with \`xcrun xcdevice list\` or \`xcrun xctrace list devices\`; identify the real device UDID.
2. Before reproduction, call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_run","label":"ios device"}\`.
3. If \`idevicesyslog\` is installed, prefer live syslog capture:

\`\`\`sh
(idevicesyslog -u <UDID> | rg --line-buffered 'DEBUG PROBE|OpenClaudeDebug|<AppProcessName>' >> ${DEBUG_SESSION_DIR}/debug.log & echo $! > ${DEBUG_SESSION_DIR}/ios-syslog.pid)
# reproduce on the physical device
kill "$(cat ${DEBUG_SESSION_DIR}/ios-syslog.pid)" 2>/dev/null || true
\`\`\`

4. If \`idevicesyslog\` is unavailable and the app can be launched from the CLI, capture attached stdout/stderr with CoreDevice:

\`\`\`sh
xcrun devicectl device process launch --device <UDID> --terminate-existing --console <bundle.identifier> 2>&1 | tee -a ${DEBUG_SESSION_DIR}/debug.log
\`\`\`

5. If neither CLI collector is available, ask the user to open Console.app, select the iPhone/iPad, filter for \`DEBUG PROBE\` or \`OpenClaudeDebug\`, reproduce, and paste the matching lines. Treat pasted lines as collected evidence.

For macOS app runs:

\`\`\`sh
/usr/bin/log stream --style compact --level debug --predicate 'eventMessage CONTAINS "DEBUG PROBE" OR subsystem == "OpenClaudeDebug" OR category == "OpenClaudeDebug"' --timeout 60 >> ${DEBUG_SESSION_DIR}/debug.log
\`\`\`

For browser console runs, tell the user exactly which actions to perform and ask them to paste all lines beginning with \`[DEBUG PROBE\`.

Read logs with \`${DEBUG_SESSION_TOOL_NAME}\` using \`{"action":"read_log","tailLines":200}\`.

Then print:
\`CHECKPOINT 4: N log entries collected\`

### Step 5: Analyze Evidence

Analyze ordering, missing probes, unexpected values, duplicates, timing gaps, and before/after differences. Cite exact log lines or pasted console lines.

Then print:
\`CHECKPOINT 5: Root cause identified with log evidence\`

### Step 6: Fix and Verify

Apply the smallest targeted fix. Keep probes in place. For file-based verification, call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_verify","label":"fix verification"}\`, rerun reproduction, then read logs again. For frontend-only verification, ask the user to reproduce and paste verify logs.

Compare failing runs and VERIFY logs. The problematic value, ordering, or missing path must be corrected.

Then print:
\`CHECKPOINT 6: Fix applied and verified with probes\`

### Step 7: Cleanup

Remove all probe blocks from source files using Edit. Search with Grep for \`DEBUG PROBE\` and continue cleanup until there are zero matches. Then call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"cleanup"}\`.

Then print:
\`CHECKPOINT 7: All probes removed, cleanup complete\`

## Final Response

Summarize the root cause, the log evidence, the fix, the verification result, and cleanup status.`
}

const debugMode = {
  type: 'prompt',
  name: 'debug-mode',
  aliases: ['runtime-debug', 'probe-debug'],
  description:
    'Runtime debug mode: insert temporary probes, collect logs, identify root cause, fix, verify, and clean up.',
  argumentHint: '<bug description>',
  allowedTools: ALLOWED_TOOLS,
  contentLength: 0,
  progressMessage: 'debugging',
  source: 'builtin',
  async getPromptForCommand(args) {
    return [{ type: 'text', text: buildDebugModePrompt(args) }]
  },
} satisfies Command

export default debugMode
