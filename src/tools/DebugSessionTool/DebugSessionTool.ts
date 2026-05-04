import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  DEBUG_SESSION_DIR,
  DEBUG_SESSION_LOG_FILE,
  DEBUG_SESSION_STATE_FILE,
  DEBUG_SESSION_TOOL_NAME,
} from './constants.js'

const DEFAULT_TAIL_LINES = 200
const MAX_TAIL_LINES = 1000
const TAIL_READ_BYTES = 512 * 1024
const LOCK_TIMEOUT_MS = 2_000
const LOCK_STALE_MS = 5_000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 100

type DebugState = {
  runCount: number
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['init', 'begin_run', 'begin_verify', 'read_log', 'cleanup'])
      .describe('Debug session action to perform.'),
    label: z
      .string()
      .max(120)
      .optional()
      .describe('Optional label for run or verification separators.'),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAIL_LINES)
      .optional()
      .describe('Number of log lines to read for read_log. Default: 200.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(['init', 'begin_run', 'begin_verify', 'read_log', 'cleanup']),
    debugDir: z.string(),
    logFile: z.string(),
    message: z.string(),
    runNumber: z.number().optional(),
    log: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function getPaths() {
  const cwd = getCwd()
  const debugDir = join(cwd, DEBUG_SESSION_DIR)
  return {
    cwd,
    debugDir,
    logFile: join(debugDir, DEBUG_SESSION_LOG_FILE),
    stateFile: join(debugDir, DEBUG_SESSION_STATE_FILE),
  }
}

function formatLabel(label: string | undefined): string {
  const trimmed = label?.trim()
  return trimmed ? ` | ${trimmed.replace(/\s+/g, ' ')}` : ''
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code
}

function isENOENT(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT')
}

function hasSessionPermission(
  commandRules: readonly string[] | undefined,
): boolean {
  return (
    commandRules?.some(
      rule => rule === '*' || rule === DEBUG_SESSION_TOOL_NAME,
    ) ?? false
  )
}

async function ensureDebugDir(): Promise<ReturnType<typeof getPaths>> {
  const paths = getPaths()
  await mkdir(paths.debugDir, { recursive: true })
  return paths
}

async function ensureStateFile(stateFile: string): Promise<void> {
  const fh = await open(stateFile, 'a')
  await fh.close()
}

function getLockRetryDelay(attempt: number): number {
  return Math.min(
    LOCK_RETRY_MAX_MS,
    LOCK_RETRY_MIN_MS * Math.max(1, attempt),
  )
}

async function acquireStateLock(stateFile: string): Promise<() => Promise<void>> {
  const lockFile = `${stateFile}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let attempt = 1

  while (true) {
    try {
      const fh = await open(lockFile, 'wx')
      try {
        await fh.writeFile(
          `${JSON.stringify({ createdAt: new Date().toISOString() })}\n`,
          'utf8',
        )
      } finally {
        await fh.close()
      }

      let released = false
      return async () => {
        if (released) return
        released = true
        await rm(lockFile, { force: true })
      }
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error

      try {
        const lockStats = await stat(lockFile)
        if (Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) {
          await rm(lockFile, { force: true })
          continue
        }
      } catch (statError) {
        if (isENOENT(statError)) continue
        throw statError
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${DEBUG_SESSION_TOOL_NAME} state lock: ${lockFile}`,
        )
      }

      await sleep(getLockRetryDelay(attempt))
      attempt += 1
    }
  }
}

async function withStateLock<T>(
  stateFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureStateFile(stateFile)
  const release = await acquireStateLock(stateFile)
  try {
    return await fn()
  } finally {
    await release()
  }
}

function parseDebugState(content: string): DebugState {
  const trimmed = content.trim()
  if (!trimmed) return { runCount: 0 }

  try {
    const parsed = JSON.parse(trimmed) as { runCount?: unknown }
    if (
      typeof parsed.runCount === 'number' &&
      Number.isInteger(parsed.runCount) &&
      parsed.runCount >= 0
    ) {
      return { runCount: parsed.runCount }
    }
  } catch {
    // Fall back to the legacy run_count=N format below.
  }

  const legacyMatch = trimmed.match(/run_count=(\d+)/)
  if (legacyMatch) {
    return { runCount: Number.parseInt(legacyMatch[1]!, 10) }
  }

  return { runCount: 0 }
}

async function readDebugState(stateFile: string): Promise<DebugState> {
  try {
    const content = await readFile(stateFile, 'utf8')
    return parseDebugState(content)
  } catch (error) {
    if (isENOENT(error)) return { runCount: 0 }
    throw error
  }
}

async function writeDebugState(
  stateFile: string,
  state: DebugState,
): Promise<void> {
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function readLogTail(logFile: string, tailLines: number): Promise<string> {
  let stats
  try {
    stats = await stat(logFile)
  } catch (error) {
    if (isENOENT(error)) return ''
    throw error
  }

  const readSize = Math.min(stats.size, TAIL_READ_BYTES)
  if (readSize === 0) return ''

  const fd = await open(logFile, 'r')
  try {
    const { buffer, bytesRead } = await fd.read({
      buffer: Buffer.alloc(readSize),
      position: stats.size - readSize,
    })
    return buffer
      .toString('utf8', 0, bytesRead)
      .split('\n')
      .slice(-tailLines)
      .join('\n')
  } finally {
    await fd.close()
  }
}

export const DebugSessionTool = buildTool({
  name: DEBUG_SESSION_TOOL_NAME,
  searchHint: 'manage runtime debug log sessions',
  maxResultSizeChars: 200_000,
  strict: true,
  async description() {
    return 'Manage the fixed .openclaude-debug runtime debugging directory, log separators, log reading, and cleanup.'
  },
  async prompt() {
    return `Use ${DEBUG_SESSION_TOOL_NAME} only during /debug-mode runtime debugging.

Actions:
- init: create ${DEBUG_SESSION_DIR}/, reset ${DEBUG_SESSION_LOG_FILE}, and reset the run counter.
- begin_run: append a RUN #N separator before reproducing the bug.
- begin_verify: append a VERIFY separator before validating a fix.
- read_log: read the tail of ${DEBUG_SESSION_LOG_FILE}.
- cleanup: delete ${DEBUG_SESSION_DIR}/ after all DEBUG PROBE blocks have been removed from source files.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly(input: Input) {
    return input.action === 'read_log'
  },
  toAutoClassifierInput(input: Input) {
    return input.action
  },
  userFacingName() {
    return 'DebugSession'
  },
  getActivityDescription(input) {
    const action = input?.action ?? 'debug'
    return `Managing debug session: ${action}`
  },
  renderToolUseMessage(input) {
    return `Debug session ${input.action ?? 'operation'}`
  },
  async checkPermissions(input, context) {
    if (
      input.action === 'read_log' ||
      hasSessionPermission(
        context.getAppState().toolPermissionContext.alwaysAllowRules.command,
      )
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    return {
      behavior: 'ask' as const,
      message: `Run debug session action: ${input.action}`,
    }
  },
  async call(input: Input) {
    const tailLines = input.tailLines ?? DEFAULT_TAIL_LINES

    if (input.action === 'cleanup') {
      const paths = getPaths()
      await rm(paths.debugDir, { recursive: true, force: true })
      return {
        data: {
          success: true,
          action: input.action,
          debugDir: paths.debugDir,
          logFile: paths.logFile,
          message: `Removed ${DEBUG_SESSION_DIR}/`,
        },
      }
    }

    if (input.action === 'read_log') {
      const paths = getPaths()
      const log = await readLogTail(paths.logFile, tailLines)
      return {
        data: {
          success: true,
          action: input.action,
          debugDir: paths.debugDir,
          logFile: paths.logFile,
          log,
          message: log
            ? `Read last ${tailLines} lines from ${DEBUG_SESSION_LOG_FILE}`
            : `${DEBUG_SESSION_LOG_FILE} is empty or has not been created yet`,
        },
      }
    }

    const paths = await ensureDebugDir()

    if (input.action === 'init') {
      await withStateLock(paths.stateFile, async () => {
        await writeFile(paths.logFile, '', 'utf8')
        await writeDebugState(paths.stateFile, { runCount: 0 })
      })
      return {
        data: {
          success: true,
          action: input.action,
          debugDir: paths.debugDir,
          logFile: paths.logFile,
          message: `Initialized ${DEBUG_SESSION_DIR}/`,
        },
      }
    }

    if (input.action === 'begin_run') {
      const runNumber = await withStateLock(paths.stateFile, async () => {
        const state = await readDebugState(paths.stateFile)
        const nextRunNumber = state.runCount + 1
        await writeDebugState(paths.stateFile, { runCount: nextRunNumber })
        const separator = `\n========== RUN #${nextRunNumber}${formatLabel(input.label)} | ${new Date().toISOString()} ==========\n`
        await appendFile(paths.logFile, separator, 'utf8')
        return nextRunNumber
      })
      return {
        data: {
          success: true,
          action: input.action,
          debugDir: paths.debugDir,
          logFile: paths.logFile,
          runNumber,
          message: `Started RUN #${runNumber}`,
        },
      }
    }

    if (input.action === 'begin_verify') {
      const separator = `\n========== VERIFY${formatLabel(input.label)} | ${new Date().toISOString()} ==========\n`
      await appendFile(paths.logFile, separator, 'utf8')
      return {
        data: {
          success: true,
          action: input.action,
          debugDir: paths.debugDir,
          logFile: paths.logFile,
          message: 'Started VERIFY run',
        },
      }
    }

    const _exhaustive: never = input.action
    return _exhaustive
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
