/**
 * Workflow snapshot and text rendering for OpenClaude.
 *
 * Tracks workflow progress via snapshots and renders structured text output
 * for tool results and progress updates. The rendering matches the rich
 * workflow progress UI with phases panel, per-agent metrics, and status.
 *
 * Ported from pi-dynamic-workflows (MIT) and adapted for OpenClaude.
 */

import type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowMeta,
  WorkflowSnapshot,
} from './types.js'

// ─── Display Options ─────────────────────────────────────────────────

export interface WorkflowDisplayOptions {
  maxAgents?: number
  maxLogs?: number
  showResultPreviews?: boolean
}

// ─── Snapshot Factory ────────────────────────────────────────────────

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  }
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter(agent => agent.status === 'running').length
  const doneCount = snapshot.agents.filter(agent => agent.status === 'done').length
  const errorCount = snapshot.agents.filter(agent => agent.status === 'error').length
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount }
}

// ─── Text Rendering ──────────────────────────────────────────────────

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
): string[] {
  const maxAgents = options.maxAgents ?? 8
  const maxLogs = options.maxLogs ?? 2
  const showResultPreviews = options.showResultPreviews ?? false

  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : ''

  const lines = [
    `◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`,
  ]

  // Collect all phase names from agents and recorded phases
  const agentPhaseNames = snapshot.agents
    .map(agent => agent.phase)
    .filter((phase): phase is string => Boolean(phase))
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ])

  const rendered = new Set<WorkflowAgentSnapshot>()

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter(agent => agent.phase === phase)
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue
    for (const agent of agents) rendered.add(agent)

    const done = agents.filter(agent => agent.status === 'done').length
    const running = agents.filter(agent => agent.status === 'running').length
    const errors = agents.filter(agent => agent.status === 'error').length
    const skipped = agents.filter(agent => agent.status === 'skipped').length
    const complete = agents.length > 0 && done + errors + skipped === agents.length
    const marker =
      running > 0 || (!complete && snapshot.currentPhase === phase) ? '▶' : complete ? '✓' : ' '

    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ''}${errors ? ` · ${errors} errors` : ''}${skipped ? ` · ${skipped} skipped` : ''}`,
    )

    const visibleAgents = agents.slice(-maxAgents)
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`
      const result =
        showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : ''
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`)
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`)
  }

  // Render agents that don't belong to any phase
  const unphased = snapshot.agents.filter(agent => !rendered.has(agent))
  if (unphased.length) {
    lines.push('  Unphased')
    for (const agent of unphased.slice(-maxAgents)) {
      const result =
        showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : ''
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`)
    }
  }

  // Render recent logs
  const visibleLogs = snapshot.logs.slice(-maxLogs)
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push('')
    for (const log of visibleLogs) lines.push(`  log: ${log}`)
  }

  return lines
}

/**
 * Renders the rich workflow progress display with phases panel and per-agent
 * metrics, matching the Claude Code Dynamic Workflows UI layout.
 */
export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const maxAgents = options.maxAgents ?? 8
  const maxLogs = options.maxLogs ?? 2

  const header = completed ? 'Workflow completed' : 'Workflow running'
  const totalAgents = snapshot.agentCount
  const doneCount = snapshot.doneCount

  // ── Overall progress line ──
  const progressParts: string[] = []
  progressParts.push(`${doneCount}/${totalAgents} agents`)
  if (snapshot.durationMs) progressParts.push(formatDuration(snapshot.durationMs))
  const progressLine = progressParts.join(' · ')

  // ── Collect phases ──
  const agentPhaseNames = snapshot.agents
    .map(a => a.phase)
    .filter((p): p is string => Boolean(p))
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ])

  // ── Phases panel ──
  const phaseLines: string[] = []
  phaseLines.push('Phases')
  for (let i = 0; i < phaseNames.length; i++) {
    const phase = phaseNames[i]
    const agents = snapshot.agents.filter(a => a.phase === phase)
    const done = agents.filter(a => a.status === 'done').length
    const running = agents.filter(a => a.status === 'running').length
    const errors = agents.filter(a => a.status === 'error').length
    const skipped = agents.filter(a => a.status === 'skipped').length
    const complete = agents.length > 0 && done + errors + skipped === agents.length
    const marker =
      running > 0 || (!complete && snapshot.currentPhase === phase) ? '▶' : complete ? '✓' : ' '

    const agentCount = agents.length || '0'
    phaseLines.push(`  ${i + 1} ${phase} · ${agentCount} agents ${marker}`)
  }

  // ── Active phase agent details ──
  const activePhase = snapshot.currentPhase ?? phaseNames.find(p => {
    const agents = snapshot.agents.filter(a => a.phase === p)
    return agents.some(a => a.status === 'running')
  })

  const agentDetailLines: string[] = []
  if (activePhase) {
    const agents = snapshot.agents.filter(a => a.phase === activePhase)
    agentDetailLines.push('')
    agentDetailLines.push(`${activePhase} · ${agents.length} agents`)
    agentDetailLines.push('')

    // Header row
    agentDetailLines.push(
      `  ${padEnd('label', 32)} ${padEnd('model', 20)} ${padStart('tokens', 10)} ${padStart('tools', 6)} ${padStart('duration', 10)}`,
    )
    agentDetailLines.push(
      `  ${'─'.repeat(32)} ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(10)}`,
    )

    // Agent rows — show all agents (up to maxAgents from end)
    const visibleAgents = agents.slice(-maxAgents)
    for (const agent of visibleAgents) {
      const marker = agent.status === 'done' ? '✓' : agent.status === 'running' ? '●' : agent.status === 'error' ? '✗' : '○'
      const model = agent.model ? shorten(agent.model, 20) : '—'
      const tokens = agent.inputTokens != null || agent.outputTokens != null
        ? formatTokens(agent.inputTokens, agent.outputTokens)
        : '—'
      const tools = agent.toolCount != null ? String(agent.toolCount) : '—'
      const duration = agent.durationMs != null ? formatDuration(agent.durationMs) : '—'

      agentDetailLines.push(
        `  ${marker} ${padEnd(shorten(agent.label, 30), 30)} ${padEnd(model, 20)} ${padStart(tokens, 10)} ${padStart(tools, 6)} ${padStart(duration, 10)}`,
      )
    }
    if (agents.length > visibleAgents.length) {
      agentDetailLines.push(`    … ${agents.length - visibleAgents.length} earlier agents`)
    }
  }

  // ── Unphased agents ──
  const rendered = new Set<string>(phaseNames)
  const unphased = snapshot.agents.filter(a => !a.phase || !rendered.has(a.phase))
  const unphasedLines: string[] = []
  if (unphased.length) {
    unphasedLines.push('')
    unphasedLines.push('Unphased')
    for (const agent of unphased.slice(-maxAgents)) {
      const marker = statusIcon(agent.status)
      unphasedLines.push(`    #${agent.id} ${marker} ${shorten(agent.label, 48)}`)
    }
  }

  // ── Logs ──
  const visibleLogs = snapshot.logs.slice(-maxLogs)
  const logLines: string[] = []
  if (visibleLogs.length) {
    logLines.push('')
    for (const log of visibleLogs) logLines.push(`  log: ${log}`)
  }

  // ── Assemble ──
  return [
    header,
    '',
    progressLine,
    '',
    ...phaseLines,
    ...agentDetailLines,
    ...unphasedLines,
    ...logLines,
  ].join('\n')
}

// ─── Status Helpers ──────────────────────────────────────────────────

export function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed)
    return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case 'queued':
      return '○'
    case 'running':
      return '●'
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    case 'skipped':
      return '-'
  }
}

// ─── Formatting ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`
}

export function formatTokens(input?: number, output?: number): string {
  const parts: string[] = []
  if (input != null && input > 0) parts.push(formatTokenCount(input))
  if (output != null && output > 0) parts.push(formatTokenCount(output))
  return parts.length > 0 ? parts.join('/') : '—'
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len)
  return str + ' '.repeat(len - str.length)
}

function padStart(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len)
  return ' '.repeat(len - str.length) + str
}

// ─── Utility ─────────────────────────────────────────────────────────

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
