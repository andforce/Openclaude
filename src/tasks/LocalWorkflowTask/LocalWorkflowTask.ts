/**
 * LocalWorkflowTask — Task implementation for background workflow execution.
 *
 * Provides the Task interface for the task system, plus kill/skip/retry
 * helper functions for managing workflow subagents.
 */

import type { SetAppState } from '../../state/AppState.js'
import type { Task } from '../../Task.js'
import type { TaskStateBase } from '../types.js'
import type { WorkflowSnapshot } from '../../tools/WorkflowTool/types.js'
import { getWorkflow, abortWorkflow } from '../../tools/WorkflowTool/registry.js'

// ─── State Type ───────────────────────────────────────────────────────

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  /** The registry workflow ID for tracking progress. */
  workflowId: string
  /** Latest snapshot from the workflow registry. */
  snapshot?: WorkflowSnapshot
  /** Final result when completed. */
  result?: unknown
}

// ─── Task Implementation ──────────────────────────────────────────────

export const LocalWorkflowTask: Task = {
  name: 'local_workflow',
  type: 'local_workflow',

  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    // Find the task to get its workflowId, then abort the right workflow
    setAppState(prev => {
      const task = prev.backgroundTasks.find(
        t => t.id === taskId && t.type === 'local_workflow',
      ) as LocalWorkflowTaskState | undefined
      if (task?.workflowId) {
        const wf = getWorkflow(task.workflowId)
        if (wf) {
          abortWorkflow(wf.id, wf.snapshot)
        }
      }
      return {
        ...prev,
        backgroundTasks: prev.backgroundTasks.map(t =>
          t.id === taskId && t.type === 'local_workflow'
            ? { ...t, status: 'killed', endTime: Date.now() } as any
            : t,
        ),
      }
    })
  },
}

// ─── Helper Functions ─────────────────────────────────────────────────

export async function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): Promise<void> {
  await LocalWorkflowTask.kill(taskId, setAppState)
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => ({
    ...prev,
    backgroundTasks: prev.backgroundTasks.map(t => {
      if (t.id !== taskId || t.type !== 'local_workflow') return t
      const wf = t as unknown as LocalWorkflowTaskState
      if (!wf.snapshot) return t
      return {
        ...t,
        snapshot: {
          ...wf.snapshot,
          agents: wf.snapshot.agents.map(a =>
            a.id === Number(agentId) && a.status === 'queued'
              ? { ...a, status: 'skipped' as const }
              : a,
          ),
        },
      } as any
    }),
  }))
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => ({
    ...prev,
    backgroundTasks: prev.backgroundTasks.map(t => {
      if (t.id !== taskId || t.type !== 'local_workflow') return t
      const wf = t as unknown as LocalWorkflowTaskState
      if (!wf.snapshot) return t
      return {
        ...t,
        snapshot: {
          ...wf.snapshot,
          agents: wf.snapshot.agents.map(a =>
            a.id === Number(agentId) && a.status === 'error'
              ? { ...a, status: 'queued' as const, error: undefined }
              : a,
          ),
        },
      } as any
    }),
  }))
}
