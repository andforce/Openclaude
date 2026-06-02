/**
 * WorkflowDetailDialog — Full-screen two-panel detail view for a background
 * workflow task.
 *
 *   ┌ Phases ─────┐  ┌ <phase> · N agents ───────────────────────────┐
 *   │ › 1 Free…1/5│  │ ✓ cache:kernel-ram  Opus 4.8  9.2k tok · 4 …  │
 *   └─────────────┘  └───────────────────────────────────────────────┘
 *   ↑↓ select · x stop workflow · esc back · s save
 *
 * Keyboard:
 *   ↑ / ↓          → move phase selection
 *   x              → stop (kill) the workflow (running only)
 *   s              → save / export the workflow script
 *   ← / Escape     → back to the task list
 */

import React, { useCallback, useState } from 'react'
import type { CommandResultDisplay } from '../../../commands.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatTokens, shorten } from '../../../tools/WorkflowTool/display.js'
import type { WorkflowAgentSnapshot } from '../../../tools/WorkflowTool/types.js'
import type { DeepImmutable } from '../../../types/utils.js'
import { Byline } from '../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js'

// ─── Props ────────────────────────────────────────────────────────────

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack?: () => void
  /** Export the workflow script to .openclaude/workflows/<name>.js */
  onSave?: () => void
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
  done: '✓',
  running: '●',
  error: '✗',
  queued: '○',
  skipped: '-',
}

const COL = { label: 28, model: 18 }

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length)
}

// ─── Component ────────────────────────────────────────────────────────

export function WorkflowDetailDialog({
  workflow,
  onKill,
  onBack,
  onSave,
}: Props): React.ReactNode {
  const { status, snapshot } = workflow
  const statusColor = STATUS_COLORS[status] ?? 'gray'
  const isRunning = status === 'running'
  const duration = workflow.endTime
    ? workflow.endTime - workflow.startTime
    : Date.now() - workflow.startTime

  // Collect phase names (recorded phases ∪ phases referenced by agents).
  const agents = (snapshot?.agents ?? []) as WorkflowAgentSnapshot[]
  const agentPhaseNames = agents
    .map(a => a.phase)
    .filter((p): p is string => Boolean(p))
  const phaseNames = [...new Set([...(snapshot?.phases ?? []), ...agentPhaseNames])]

  const [selected, setSelected] = useState(0)
  const selectedIdx = phaseNames.length > 0 ? Math.min(selected, phaseNames.length - 1) : 0
  const selectedPhase = phaseNames[selectedIdx]

  // Agents shown in the right pane: those in the selected phase, or all agents
  // when the workflow has no phases.
  const paneAgents =
    phaseNames.length > 0
      ? agents.filter(a => a.phase === selectedPhase)
      : agents

  const handleKeyDown = useCallback(
    (key: KeyboardEvent) => {
      if (key.key === 'up') {
        setSelected(s => Math.max(0, s - 1))
      } else if (key.key === 'down') {
        setSelected(s => Math.min(Math.max(0, phaseNames.length - 1), s + 1))
      } else if (key.key === 'x' && isRunning && onKill) {
        onKill()
      } else if (key.key === 's' && onSave) {
        onSave()
      } else if (key.key === 'left' || key.key === 'escape') {
        onBack?.()
      }
    },
    [phaseNames.length, isRunning, onKill, onSave, onBack],
  )

  const leftWidth = 26

  return (
    <Box flexDirection="column" flexGrow={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {/* Header */}
      <Box flexDirection="column" flexShrink={0} marginBottom={1}>
        <Text bold color={statusColor}>
          {snapshot?.name ?? 'unknown'}
        </Text>
        {snapshot?.description ? <Text dimColor wrap="truncate-end">{snapshot.description}</Text> : null}
        <Text color={statusColor}>
          {status} · {snapshot?.doneCount ?? 0}/{snapshot?.agentCount ?? 0} agents
          {isRunning && snapshot?.runningCount ? ` · ${snapshot.runningCount} running` : ''}
          {snapshot?.errorCount ? ` · ${snapshot.errorCount} errors` : ''}
          {' · '}
          {formatDuration(duration)}
        </Text>
      </Box>

      {/* Two panes — equal height, fill remaining vertical space */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Phases sidebar */}
        <Box flexDirection="column" borderStyle="round" borderDimColor width={leftWidth} flexShrink={0} paddingX={1} overflow="hidden">
          <Text bold>Phases</Text>
          {phaseNames.length === 0 ? (
            <Text dimColor>(no phases)</Text>
          ) : (
            phaseNames.map((phase, i) => {
              const inPhase = agents.filter(a => a.phase === phase)
              const done = inPhase.filter(a => a.status === 'done').length
              const isSel = i === selectedIdx
              return (
                <Text key={phase} color={isSel ? 'cyan' : undefined} bold={isSel} wrap="truncate-end">
                  {isSel ? '› ' : '  '}
                  {i + 1} {shorten(phase, leftWidth - 9)} {done}/{inPhase.length}
                </Text>
              )
            })
          )}
        </Box>

        {/* Agent table */}
        <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1} paddingX={1} overflow="hidden">
          <Text bold wrap="truncate-end">
            {selectedPhase ? `${selectedPhase} · ` : ''}
            {paneAgents.length} agents
          </Text>
          {paneAgents.length === 0 ? (
            <Text dimColor>(no agents yet)</Text>
          ) : (
            paneAgents.map(agent => <AgentRow key={agent.id} agent={agent} />)
          )}
        </Box>
      </Box>

      {/* Footer */}
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="↑/↓" action="select" />
            {isRunning && onKill ? (
              <KeyboardShortcutHint shortcut="x" action="stop workflow" />
            ) : null}
            <KeyboardShortcutHint shortcut="esc" action="back" />
            {onSave ? <KeyboardShortcutHint shortcut="s" action="save" /> : null}
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}

// ─── Sub-component: Agent Row ────────────────────────────────────────

function AgentRow({ agent }: { agent: WorkflowAgentSnapshot }): React.ReactNode {
  const color = AGENT_STATUS_COLORS[agent.status]
  const marker = AGENT_MARKERS[agent.status] ?? '?'
  const model = agent.model ? shorten(agent.model, COL.model) : ''

  // Left group: marker + label + model. Right group: metrics (or status word).
  const left = (
    <Text wrap="truncate-end">
      <Text color={color}>{marker} </Text>
      {padEnd(shorten(agent.label, COL.label), COL.label)}
      {model ? <Text dimColor>  {model}</Text> : null}
    </Text>
  )

  // Queued/skipped agents have no metrics yet — show their status word instead.
  let right: React.ReactNode
  if (agent.status === 'queued' || agent.status === 'skipped') {
    right = <Text dimColor>{agent.status}</Text>
  } else {
    const tokens =
      agent.inputTokens != null || agent.outputTokens != null
        ? formatTokens(agent.inputTokens, agent.outputTokens)
        : '—'
    const tools = agent.toolCount != null ? ` · ${agent.toolCount} tools` : ''
    const dur = agent.durationMs != null ? ` · ${formatDuration(agent.durationMs)}` : ''
    right = (
      <Text dimColor>
        {tokens} tok{tools}{dur}
      </Text>
    )
  }

  return (
    <Box justifyContent="space-between">
      {left}
      <Box flexShrink={0} marginLeft={2}>{right}</Box>
    </Box>
  )
}
