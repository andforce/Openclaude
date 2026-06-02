/**
 * WorkflowDetailDialog — Detail view for a background workflow task.
 *
 * Shows workflow progress with phases panel, per-agent metrics table,
 * and status information. Keyboard shortcuts:
 *   Space / yes    → dismiss
 *   Left / Escape  → back to list
 *   x              → kill workflow
 */

import React, { useCallback } from 'react'
import type { CommandResultDisplay } from '../../../commands.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import { useKeybindings } from '../../../keybindings/useKeybinding.js'
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatTokens, shorten } from '../../../tools/WorkflowTool/display.js'
import type { WorkflowAgentSnapshot } from '../../../tools/WorkflowTool/types.js'
import type { DeepImmutable } from '../../../types/utils.js'
import { Byline } from '../../design-system/Byline.js'
import { Dialog } from '../../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js'

// ─── Props ────────────────────────────────────────────────────────────

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack?: () => void
}

// ─── Constants ────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  running: 'yellow',
  completed: 'green',
  failed: 'red',
  killed: 'red',
}

const AGENT_STATUS_COLORS: Record<string, string | undefined> = {
  done: 'green',
  running: 'yellow',
  error: 'red',
  queued: undefined,
  skipped: 'gray',
}

const AGENT_MARKERS: Record<string, string> = {
  done: '\u2713',
  running: '\u25CF',
  error: '\u2717',
  queued: '\u25CB',
  skipped: '-',
}

// ─── Component ────────────────────────────────────────────────────────

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onBack,
}: Props): React.ReactNode {
  const { status, snapshot } = workflow
  const statusColor = STATUS_COLORS[status] ?? 'gray'
  const isRunning = status === 'running'
  const duration = workflow.endTime
    ? workflow.endTime - workflow.startTime
    : Date.now() - workflow.startTime

  const handleKeyDown = useCallback(
    (key: KeyboardEvent) => {
      // Space/Enter is handled by useKeybindings('confirm:yes', ...) below
      if (key.leftArrow || key.escape) {
        onBack?.()
      }
      if (key.input === 'x' && isRunning && onKill) {
        onKill()
      }
    },
    [onBack, onKill, isRunning],
  )

  useKeybindings(
    {
      'confirm:yes': () =>
        onDone('Background tasks dialog dismissed', { display: 'system' }),
    },
    { modalSafe: true },
  )

  const inputGuide = useCallback(
    (exitState: any) => (
      <Box>
        <Byline>
          <KeyboardShortcutHint exitState={exitState} insertAt={0} />
        </Byline>
      </Box>
    ),
    [],
  )

  // Collect phase names from snapshot
  const agentPhaseNames = (snapshot?.agents ?? [])
    .map((a: WorkflowAgentSnapshot) => a.phase)
    .filter((p: unknown): p is string => Boolean(p))
  const phaseNames = [...new Set([...(snapshot?.phases ?? []), ...agentPhaseNames])]

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`Workflow: ${snapshot?.name ?? 'unknown'}`}
        subtitle={
          <Text color={statusColor}>
            {status} · {snapshot?.doneCount ?? 0}/{snapshot?.agentCount ?? 0} agents
            {isRunning && snapshot?.runningCount ? ` · ${snapshot.runningCount} running` : ''}
            {snapshot?.errorCount ? ` · ${snapshot.errorCount} errors` : ''}
            {' · '}
            {formatDuration(duration)}
          </Text>
        }
        onCancel={() => onBack?.()}
        color="background"
        inputGuide={inputGuide}
      >
        <Box flexDirection="column" paddingX={2}>
          {/* Progress line */}
          <Box marginBottom={1}>
            <Text>
              {snapshot?.doneCount ?? 0}/{snapshot?.agentCount ?? 0} agents
              {' · '}
              {formatDuration(duration)}
            </Text>
          </Box>

          {/* Phases */}
          {phaseNames.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Phases</Text>
              {phaseNames.map((phase: string, i: number) => {
                const agents =
                  snapshot?.agents?.filter(
                    (a: WorkflowAgentSnapshot) => a.phase === phase,
                  ) ?? []
                const done = agents.filter(
                  (a: WorkflowAgentSnapshot) => a.status === 'done',
                ).length
                const running = agents.filter(
                  (a: WorkflowAgentSnapshot) => a.status === 'running',
                ).length
                const errors = agents.filter(
                  (a: WorkflowAgentSnapshot) => a.status === 'error',
                ).length
                const skipped = agents.filter(
                  (a: WorkflowAgentSnapshot) => a.status === 'skipped',
                ).length
                const complete =
                  agents.length > 0 && done + errors + skipped === agents.length
                const marker = running > 0 ? '\u25B6' : complete ? '\u2713' : ' '

                return (
                  <Box key={phase}>
                    <Text>
                      {'  '}
                      {i + 1}. {phase} · {agents.length || '0'} agents {marker}
                    </Text>
                    {running > 0 && <Text dimColor> ({running} running)</Text>}
                    {errors > 0 && <Text color="red"> ({errors} errors)</Text>}
                  </Box>
                )
              })}
            </Box>
          )}

          {/* Agent Table */}
          {snapshot?.agents && snapshot.agents.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Agents</Text>
              <AgentTable
                agents={snapshot.agents}
                isRunning={isRunning}
                onSkipAgent={onSkipAgent}
                onRetryAgent={onRetryAgent}
              />
            </Box>
          )}

          {/* Recent Logs */}
          {snapshot?.logs && snapshot.logs.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Recent Logs</Text>
              {snapshot.logs.slice(-3).map((log: string, i: number) => (
                <Text key={i} dimColor>
                  {'  '}
                  {log}
                </Text>
              ))}
            </Box>
          )}

          {/* Result (when completed) */}
          {status === 'completed' && workflow.result != null && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Result</Text>
              <Text dimColor>
                {typeof workflow.result === 'string'
                  ? workflow.result
                  : JSON.stringify(workflow.result, null, 2).slice(0, 500)}
              </Text>
            </Box>
          )}

          {/* Error (when failed) */}
          {status === 'failed' && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="red" bold>
                Failed
              </Text>
              {snapshot?.logs &&
                snapshot.logs
                  .filter((l: string) => l.includes('failed'))
                  .slice(-2)
                  .map((log: string, i: number) => (
                    <Text key={i} color="red">
                      {log}
                    </Text>
                  ))}
            </Box>
          )}
        </Box>
      </Dialog>
    </Box>
  )
}

// ─── Sub-component: Agent Table ──────────────────────────────────────

const COL_W = { label: 30, model: 20, tokens: 10, tools: 6, duration: 10 }

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length)
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s
}

function AgentTable({
  agents,
}: {
  agents: WorkflowAgentSnapshot[]
  isRunning: boolean
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}): React.ReactNode {
  // Header
  const header = `  ${padEnd('label', COL_W.label)} ${padEnd('model', COL_W.model)} ${padStart('tokens', COL_W.tokens)} ${padStart('tools', COL_W.tools)} ${padStart('duration', COL_W.duration)}`
  const separator = `  ${'\u2500'.repeat(COL_W.label)} ${'\u2500'.repeat(COL_W.model)} ${'\u2500'.repeat(COL_W.tokens)} ${'\u2500'.repeat(COL_W.tools)} ${'\u2500'.repeat(COL_W.duration)}`

  return (
    <Box flexDirection="column">
      <Text dimColor>{header}</Text>
      <Text dimColor>{separator}</Text>
      {agents.map((agent: WorkflowAgentSnapshot) => {
        const color = AGENT_STATUS_COLORS[agent.status]
        const marker = AGENT_MARKERS[agent.status] ?? '?'
        const model = agent.model ? shorten(agent.model, COL_W.model) : '\u2014'
        const tokens = agent.inputTokens != null || agent.outputTokens != null
          ? formatTokens(agent.inputTokens, agent.outputTokens)
          : '\u2014'
        const tools =
          agent.toolCount != null ? String(agent.toolCount) : '\u2014'
        const duration =
          agent.durationMs != null ? formatDuration(agent.durationMs) : '\u2014'

        return (
          <Box key={agent.id}>
            <Text>
              <Text color={color}>{marker} </Text>
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
