/**
 * WorkflowFullscreenView — registry-backed wrapper around WorkflowDetailDialog.
 *
 * Foreground workflows live only in the workflow registry (not AppState.tasks),
 * so this reads the entry by id, polls for live progress, adapts it to the
 * shape WorkflowDetailDialog expects, and wires up stop / save / back.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useRegisterOverlay } from '../../../context/overlayContext.js'
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  abortWorkflow,
  getWorkflow,
  saveWorkflowScript,
  type WorkflowStatus,
} from '../../../tools/WorkflowTool/registry.js'
import type { DeepImmutable } from '../../../types/utils.js'
import { WorkflowDetailDialog } from './WorkflowDetailDialog.js'

type Props = {
  workflowId: string
  onClose: () => void
}

const STATUS_MAP: Record<WorkflowStatus, LocalWorkflowTaskState['status']> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  aborted: 'killed',
}

export function WorkflowFullscreenView({ workflowId, onClose }: Props): React.ReactNode {
  // Register as a modal overlay so the prompt input + footer keybindings behind
  // the full-screen view go inactive while it's open.
  useRegisterOverlay('workflow-detail')

  // Poll for live progress — the registry mutates snapshots in place.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const [notice, setNotice] = useState<string | null>(null)

  const entry = getWorkflow(workflowId)

  const onSave = useCallback(() => {
    saveWorkflowScript(workflowId)
      .then(p => setNotice(p ? `Saved workflow script to ${p}` : 'No saved script available'))
      .catch(err => setNotice(`Save failed: ${err instanceof Error ? err.message : String(err)}`))
  }, [workflowId])

  const onKill = useCallback(() => {
    const e = getWorkflow(workflowId)
    if (e && e.status === 'running') abortWorkflow(e.id, e.snapshot)
    onClose()
  }, [workflowId, onClose])

  // Close (in an effect, not during render) once the workflow rolls off the
  // registry entirely.
  useEffect(() => {
    if (!entry) onClose()
  }, [entry, onClose])

  if (!entry) {
    return null
  }

  const isRunning = entry.status === 'running'
  const workflow = {
    type: 'local_workflow',
    id: entry.id,
    workflowId: entry.id,
    status: STATUS_MAP[entry.status] ?? 'completed',
    description: entry.meta.description ?? entry.meta.name,
    startTime: entry.startedAt,
    endTime: entry.endedAt,
    notified: true,
    snapshot: entry.snapshot,
    result: entry.result,
  } as unknown as DeepImmutable<LocalWorkflowTaskState>

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
      <WorkflowDetailDialog
        workflow={workflow}
        onDone={onClose}
        onBack={onClose}
        onKill={isRunning ? onKill : undefined}
        onSave={onSave}
      />
      {notice ? (
        <Box marginTop={1}>
          <Text color="green">{notice}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
