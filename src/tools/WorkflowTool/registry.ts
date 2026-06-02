/**
 * Workflow registry — in-memory store for tracking active and completed
 * workflow runs. Used by the WorkflowTool to register progress and by
 * the /workflow command to display status.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowMeta, WorkflowSnapshot } from './types.js'
import { generateTaskId } from '../../Task.js'

// ─── Types ───────────────────────────────────────────────────────────

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface WorkflowEntry {
  id: string
  meta: WorkflowMeta
  status: WorkflowStatus
  snapshot: WorkflowSnapshot
  result?: unknown
  error?: string
  startedAt: number
  endedAt?: number
  /** Raw workflow script source, used by the "save" action to export it. */
  script?: string
}

// ─── Registry State ──────────────────────────────────────────────────

const activeWorkflows = new Map<string, WorkflowEntry>()
const completedWorkflows: WorkflowEntry[] = []
const MAX_COMPLETED = 20

// ─── Reactivity ──────────────────────────────────────────────────────
// Lightweight pub/sub so UI (e.g. the footer) can re-render when the set of
// active workflows changes. We bump on membership changes only (register /
// complete / fail / abort) — live progress within a run is polled by the UI,
// not pushed here, to avoid re-rendering heavy components per agent event.

let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const cb of listeners) cb()
}

export function subscribeWorkflows(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Monotonic version for useSyncExternalStore snapshots. */
export function getWorkflowsVersion(): number {
  return version
}

export function getActiveWorkflowCount(): number {
  return activeWorkflows.size
}

// ─── Public API ──────────────────────────────────────────────────────

export function registerWorkflow(meta: WorkflowMeta, script?: string): string {
  const id = generateTaskId('local_workflow')
  const snapshot: WorkflowSnapshot = {
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
  const entry: WorkflowEntry = {
    id,
    meta,
    status: 'running',
    snapshot,
    startedAt: Date.now(),
    script,
  }
  activeWorkflows.set(id, entry)
  notify()
  return id
}

export function updateWorkflow(id: string, snapshot: WorkflowSnapshot): void {
  const entry = activeWorkflows.get(id)
  if (entry) {
    entry.snapshot = snapshot
  }
}

export function completeWorkflow(id: string, snapshot: WorkflowSnapshot, result: unknown): void {
  const entry = activeWorkflows.get(id)
  if (!entry) return
  entry.status = 'completed'
  entry.snapshot = snapshot
  entry.result = result
  entry.endedAt = Date.now()
  activeWorkflows.delete(id)
  completedWorkflows.push(entry)
  if (completedWorkflows.length > MAX_COMPLETED) {
    completedWorkflows.shift()
  }
  notify()
}

export function failWorkflow(id: string, snapshot: WorkflowSnapshot, error: string): void {
  const entry = activeWorkflows.get(id)
  if (!entry) return
  entry.status = 'failed'
  entry.snapshot = snapshot
  entry.error = error
  entry.endedAt = Date.now()
  activeWorkflows.delete(id)
  completedWorkflows.push(entry)
  if (completedWorkflows.length > MAX_COMPLETED) {
    completedWorkflows.shift()
  }
  notify()
}

export function abortWorkflow(id: string, snapshot: WorkflowSnapshot): void {
  const entry = activeWorkflows.get(id)
  if (!entry) return
  entry.status = 'aborted'
  entry.snapshot = snapshot
  entry.endedAt = Date.now()
  activeWorkflows.delete(id)
  completedWorkflows.push(entry)
  if (completedWorkflows.length > MAX_COMPLETED) {
    completedWorkflows.shift()
  }
  notify()
}

export function getWorkflow(id: string): WorkflowEntry | undefined {
  return activeWorkflows.get(id) ?? completedWorkflows.find(e => e.id === id)
}

export function getActiveWorkflows(): WorkflowEntry[] {
  return [...activeWorkflows.values()]
}

export function listWorkflows(): WorkflowEntry[] {
  return [...getActiveWorkflows(), ...completedWorkflows]
}

export function getLatestWorkflow(): WorkflowEntry | undefined {
  const active = getActiveWorkflows()
  if (active.length > 0) return active[active.length - 1]
  return completedWorkflows[completedWorkflows.length - 1]
}

export function clearCompletedWorkflows(): void {
  completedWorkflows.length = 0
}

// ─── Save / Export ────────────────────────────────────────────────────

/**
 * Sanitize a workflow name into a safe filename stem.
 */
function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'workflow'
}

/**
 * Export a workflow's raw script to the project-level workflows directory
 * (`.openclaude/workflows/<name>.js`) so it can be re-run via `/workflow <name>`.
 *
 * Returns the absolute path written, or null when the workflow has no stored
 * script (e.g. an older session) or cannot be found.
 */
export async function saveWorkflowScript(id: string): Promise<string | null> {
  const entry = getWorkflow(id)
  if (!entry || !entry.script) return null
  const dir = join(process.cwd(), '.openclaude', 'workflows')
  const filePath = join(dir, `${safeName(entry.meta.name)}.js`)
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, entry.script, 'utf-8')
  return filePath
}
