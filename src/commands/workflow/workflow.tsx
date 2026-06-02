import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getActiveWorkflows,
  listWorkflows,
  getLatestWorkflow,
  type WorkflowEntry,
  type WorkflowStatus,
} from '../../tools/WorkflowTool/registry.js'
import type { WorkflowAgentSnapshot } from '../../tools/WorkflowTool/types.js'
import { formatDuration, formatTokens, shorten } from '../../tools/WorkflowTool/display.js'
import { createWorkflowLoader } from '../../tools/WorkflowTool/loader.js'
import { renderToString } from '../../utils/staticRender.js'
import { isBackgroundTask, type TaskState, type BackgroundTaskState } from '../../tasks/types.js'

// ─── Public API ──────────────────────────────────────────────────────

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()

  // No args — show the rich status view immediately (like /goal)
  if (!trimmed) {
    const appState = context.getAppState()
    const display = <WorkflowStatusView tasks={appState.tasks} />
    const output = await renderToString(display)
    onDone(output)
    return null
  }

  // Check if the name matches a saved workflow
  const loader = await createWorkflowLoader(process.cwd())
  const script = loader(trimmed)

  if (script) {
    // Directly invoke the saved workflow
    onDone(
      `Run the saved workflow '${trimmed}'. Use the workflow tool with a script that calls workflow('${trimmed}').`,
      { display: 'user', shouldQuery: true },
    )
  } else {
    // Explicitly tell the model to use the workflow tool for this task.
    // Without this, the model may spawn individual agents instead, which
    // won't show up in the workflow registry.
    onDone(
      [
        `Use the workflow tool to accomplish this task. Write a JavaScript workflow script that:`,
        `1. Starts with \`export const meta = { name: '<snake_case>', description: '<human description>' }\``,
        `2. Uses phase(), agent(), parallel(), or pipeline() to fan out the work`,
        `3. Returns a JSON-serializable result at the end`,
        ``,
        `Task: ${trimmed}`,
      ].join('\n'),
      { display: 'user', shouldQuery: true },
    )
  }

  return null
}

// ─── Components ──────────────────────────────────────────────────────

function WorkflowStatusView({ tasks }: { tasks: { [taskId: string]: TaskState } }): React.ReactNode {
  const active = getActiveWorkflows()
  const all = listWorkflows()

  // Also check for background tasks (agents spawned directly by the model,
  // outside of a workflow). These show up in /tasks but not in the workflow
  // registry. When the model falls back to individual agents, the user may
  // still expect /workflow to show them.
  const bgTasks = Object.values(tasks ?? {}).filter(isBackgroundTask) as BackgroundTaskState[]

  if (all.length === 0 && bgTasks.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>No workflows found</Text>
        <Text dimColor>
          Workflows are created when the model uses the workflow tool. None have been run yet in this session.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Start one with: /workflow {'<task description>'}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Active workflows */}
      {active.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {active.map(wf => (
            <WorkflowDetail key={wf.id} entry={wf} />
          ))}
        </Box>
      )}

      {/* Latest completed/failed when nothing active */}
      {active.length === 0 && (() => {
        const latest = getLatestWorkflow()
        return latest ? <WorkflowDetail entry={latest} /> : null
      })()}

      {/* Show background tasks when no workflows exist but tasks are running.
          This handles the case where the model fell back from WorkflowTool
          to spawning individual agents. */}
      {all.length === 0 && bgTasks.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold>Background Tasks</Text>
            <Text dimColor> (agents spawned directly, not via workflow tool)</Text>
          </Box>
          <BackgroundTaskList tasks={bgTasks} />
          <Box marginTop={1}>
            <Text dimColor>Tip: Use /workflow {'<task>'} to explicitly request the workflow tool for parallel agent orchestration.</Text>
          </Box>
        </Box>
      )}

      {/* When both active and completed exist */}
      {active.length > 0 && (() => {
        const latest = getLatestWorkflow()
        if (!latest || active.some(a => a.id === latest.id)) return null
        return (
          <>
            <Box marginY={1}>
              <Text dimColor>─────────────────────────────</Text>
            </Box>
            <Text bold>Latest Completed</Text>
            <WorkflowSummary entry={latest} />
          </>
        )
      })()}
    </Box>
  )
}

// ─── Background Task List ────────────────────────────────────────────

function BackgroundTaskList({ tasks }: { tasks: BackgroundTaskState[] }) {
  const running = tasks.filter(t => t.status === 'running').length
  const pending = tasks.filter(t => t.status === 'pending').length
  const done = tasks.filter(t => t.status === 'completed').length
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'killed').length

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {tasks.length} tasks
          {running > 0 ? <Text color="yellow"> · {running} running</Text> : null}
          {pending > 0 ? <Text dimColor> · {pending} pending</Text> : null}
          {done > 0 ? <Text color="green"> · {done} done</Text> : null}
          {failed > 0 ? <Text color="red"> · {failed} failed</Text> : null}
        </Text>
      </Box>
      {tasks.map(task => {
        const icon = task.status === 'running' ? '●' : task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'killed' ? '⊘' : '○'
        const color = task.status === 'running' ? 'yellow' : task.status === 'completed' ? 'green' : task.status === 'failed' || task.status === 'killed' ? 'red' : undefined
        const label = 'description' in task ? (task as any).description ?? task.type : task.type
        return (
          <Box key={task.id}>
            <Text color={color}>{icon} </Text>
            <Text>{shorten(typeof label === 'string' ? label : task.type, 64)}</Text>
            <Text dimColor> · {task.type}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ─── Summary ─────────────────────────────────────────────────────────

function WorkflowSummary({ entry }: { entry: WorkflowEntry }) {
  const { meta, snapshot, status } = entry
  const icon = status === 'running' ? '●' : status === 'completed' ? '✓' : status === 'failed' ? '✗' : '⊘'
  const color = status === 'running' ? 'yellow' : status === 'completed' ? 'green' : 'red'

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold>{meta.name}</Text>
        <Text dimColor> — {snapshot.doneCount}/{snapshot.agentCount} agents</Text>
        {snapshot.durationMs ? <Text dimColor> · {formatDuration(snapshot.durationMs)}</Text> : null}
        {status === 'running' ? <Text dimColor> · {snapshot.runningCount} running</Text> : null}
        {snapshot.errorCount > 0 ? <Text color="red"> · {snapshot.errorCount} errors</Text> : null}
      </Box>
      {meta.description ? <Text dimColor>{meta.description}</Text> : null}
    </Box>
  )
}

// ─── Detail (matching WORKFLOW-INFO.md format) ───────────────────────

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  running: '▶ active',
  completed: '✓ completed',
  failed: '✗ failed',
  aborted: '⊘ aborted',
}

function WorkflowDetail({ entry }: { entry: WorkflowEntry }) {
  const { meta, snapshot, status, result, error, startedAt, endedAt } = entry
  const agentCount = snapshot.agentCount
  const doneCount = snapshot.doneCount
  const durationMs = snapshot.durationMs ?? (endedAt ? endedAt - startedAt : undefined)

  // Collect phases
  const agentPhaseNames = snapshot.agents
    .map(a => a.phase)
    .filter((p): p is string => Boolean(p))
  const phaseNames = unique([...snapshot.phases, ...agentPhaseNames])

  // Separate agents with phases vs unphased
  const phasedAgentIds = new Set<number>()
  for (const phase of phaseNames) {
    for (const agent of snapshot.agents) {
      if (agent.phase === phase) phasedAgentIds.add(agent.id)
    }
  }
  const unphased = snapshot.agents.filter(a => !phasedAgentIds.has(a.id))

  return (
    <Box flexDirection="column">
      {/* Header — matching WORKFLOW-INFO.md: name + agent count + duration */}
      <Box marginBottom={1}>
        <Text bold>{meta.name}</Text>
      </Box>
      {meta.description ? (
        <Box marginBottom={1}>
          <Text>{meta.description}</Text>
        </Box>
      ) : null}

      {/* Progress line */}
      <Box marginBottom={1}>
        <Text bold>
          {doneCount}/{agentCount} agents
        </Text>
        {durationMs ? <Text> · {formatDuration(durationMs)}</Text> : null}
        {status === 'running' && snapshot.runningCount > 0 ? (
          <Text color="yellow"> · {snapshot.runningCount} running</Text>
        ) : null}
        {snapshot.errorCount > 0 ? (
          <Text color="red"> · {snapshot.errorCount} errors</Text>
        ) : null}
        {status !== 'running' ? (
          <Text dimColor> · {STATUS_LABEL[status] ?? status}</Text>
        ) : null}
      </Box>

      {/* Error */}
      {error ? (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      ) : null}

      {/* Phases Table */}
      {phaseNames.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold>Phases</Text>
          </Box>
          {phaseNames.map((phase, i) => {
            const agents = snapshot.agents.filter(a => a.phase === phase)
            const done = agents.filter(a => a.status === 'done').length
            const running = agents.filter(a => a.status === 'running').length
            const errors = agents.filter(a => a.status === 'error').length
            const skipped = agents.filter(a => a.status === 'skipped').length
            const complete = agents.length > 0 && done + errors + skipped === agents.length
            const marker = running > 0 ? '▶' : complete ? '✓' : '○'

            return (
              <Box key={phase}>
                <Text>
                  {'  '}{i + 1}. {phase} · {agents.length || '0'} agents {marker}
                </Text>
                {running > 0 ? <Text dimColor> ({running} running)</Text> : null}
                {errors > 0 ? <Text color="red"> ({errors} errors)</Text> : null}
                {skipped > 0 ? <Text dimColor> ({skipped} skipped)</Text> : null}
              </Box>
            )
          })}
        </Box>
      )}

      {/* Active phase agent details table — only show for the current active phase */}
      {status === 'running' && (() => {
        const activePhase = snapshot.currentPhase ?? phaseNames.find(p => {
          const a = snapshot.agents.filter(ag => ag.phase === p)
          return a.some(ag => ag.status === 'running')
        })

        if (!activePhase) return null
        const agents = snapshot.agents.filter(a => a.phase === activePhase)
        if (agents.length === 0) return null

        return (
          <Box flexDirection="column" marginBottom={1}>
            <Box marginBottom={1}>
              <Text bold>{activePhase} · {agents.length} agents</Text>
            </Box>
            <AgentTable agents={agents} />
          </Box>
        )
      })()}

      {/* All agents table when completed */}
      {(status === 'completed' || status === 'failed' || status === 'aborted') && snapshot.agents.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold>Agents</Text>
          </Box>
          <AgentTable agents={snapshot.agents} />
        </Box>
      )}

      {/* Running agents without phase context */}
      {status === 'running' && unphased.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold>Unphased Agents</Text>
          </Box>
          <AgentTable agents={unphased} />
        </Box>
      )}

      {/* Recent logs */}
      {snapshot.logs && snapshot.logs.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginTop={1}>
            <Text bold>Recent Logs</Text>
          </Box>
          {snapshot.logs.slice(-3).map((log: string, i: number) => (
            <Text key={i} dimColor>  {log}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ─── Agent Table ─────────────────────────────────────────────────────

const COL_W = { label: 32, model: 22, tokens: 10, tools: 6, duration: 10 }

function AgentTable({ agents }: { agents: WorkflowAgentSnapshot[] }) {
  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text dimColor>
          {'  '}
          {padEnd('label', COL_W.label)}
          {' '}
          {padEnd('model', COL_W.model)}
          {' '}
          {padStart('tokens', COL_W.tokens)}
          {' '}
          {padStart('tools', COL_W.tools)}
          {' '}
          {padStart('duration', COL_W.duration)}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {'  '}
          {'─'.repeat(COL_W.label)}
          {' '}
          {'─'.repeat(COL_W.model)}
          {' '}
          {'─'.repeat(COL_W.tokens)}
          {' '}
          {'─'.repeat(COL_W.tools)}
          {' '}
          {'─'.repeat(COL_W.duration)}
        </Text>
      </Box>

      {/* Rows */}
      {agents.map(agent => {
        const marker = agent.status === 'done' ? '✓' : agent.status === 'running' ? '●' : agent.status === 'error' ? '✗' : agent.status === 'skipped' ? '-' : '○'
        const markerColor = agent.status === 'done' ? 'green' : agent.status === 'running' ? 'yellow' : agent.status === 'error' ? 'red' : undefined
        const model = agent.model ? shorten(agent.model, COL_W.model) : '—'
        const tokens = agent.inputTokens != null || agent.outputTokens != null
          ? formatTokens(agent.inputTokens, agent.outputTokens)
          : '—'
        const tools = agent.toolCount != null ? String(agent.toolCount) : '—'
        const duration = agent.durationMs != null ? formatDuration(agent.durationMs) : '—'

        return (
          <Box key={agent.id}>
            <Text>
              <Text color={markerColor}>{marker} </Text>
              {padEnd(shorten(agent.label, COL_W.label), COL_W.label)}
              {' '}
              {padEnd(model, COL_W.model)}
              {' '}
              {padStart(tokens, COL_W.tokens)}
              {' '}
              {padStart(tools, COL_W.tools)}
              {' '}
              {padStart(duration, COL_W.duration)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len)
  return str + ' '.repeat(len - str.length)
}

function padStart(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len)
  return ' '.repeat(len - str.length) + str
}
