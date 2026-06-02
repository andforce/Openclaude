/**
 * Workflow registry — in-memory store for tracking active and completed
 * workflow runs. Used by the WorkflowTool to register progress and by
 * the /workflow command to display status.
 */

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
}

// ─── Registry State ──────────────────────────────────────────────────

const activeWorkflows = new Map<string, WorkflowEntry>()
const completedWorkflows: WorkflowEntry[] = []
const MAX_COMPLETED = 20

// ─── Public API ──────────────────────────────────────────────────────

export function registerWorkflow(meta: WorkflowMeta): string {
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
  }
  activeWorkflows.set(id, entry)
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
