/**
 * WorkflowFooterStatus — dedicated status rows for running workflows, rendered
 * directly below the permission-mode indicator in the prompt footer.
 *
 * One row per running workflow:
 *   ○ <name>  <description>   <done>/<total> agents done · <runtime> · ↓ <tokens> tokens
 *
 * Source of truth is the in-memory workflow registry (the same one /workflow
 * reads), so this covers workflows running in the foreground turn as well as
 * background ones — neither is guaranteed to appear in AppState.tasks. The
 * registry is non-reactive, so we poll once per second and only re-render when
 * the rendered content actually changes (idle = no re-renders).
 */

import figures from 'figures'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { useAppState } from 'src/state/AppState.js'
import { getActiveWorkflows, type WorkflowEntry } from '../../tools/WorkflowTool/registry.js'
import { formatDuration, formatTokenCount, shorten } from '../../tools/WorkflowTool/display.js'
import { Box, Text } from '../../ink.js'

type Props = {
  /** Open the workflow detail view for the given workflow id (fullscreen env only). */
  onOpen?: (taskId: string) => void
}

function totalTokens(entry: WorkflowEntry): number {
  let sum = 0
  for (const a of entry.snapshot.agents) sum += (a.inputTokens ?? 0) + (a.outputTokens ?? 0)
  return sum
}

/** Stable signature of what we display — used to skip idle re-renders. */
function signature(entries: WorkflowEntry[]): string {
  return entries
    .map(
      e =>
        `${e.id}:${e.snapshot.doneCount}/${e.snapshot.agentCount}:${Math.floor(
          (Date.now() - e.startedAt) / 1000,
        )}:${totalTokens(e)}`,
    )
    .join('|')
}

function WorkflowRow({
  entry,
  selected,
  onOpen,
}: {
  entry: WorkflowEntry
  selected: boolean
  onOpen?: (taskId: string) => void
}): React.ReactNode {
  const { snapshot } = entry
  const name = snapshot.name || entry.meta.name
  const description = snapshot.description || entry.meta.description || ''
  const done = snapshot.doneCount
  const total = snapshot.agentCount
  const elapsedMs = (entry.endedAt ?? Date.now()) - entry.startedAt
  const tokens = totalTokens(entry)
  const marker = selected ? figures.pointer : figures.circle

  const content = (
    <Text inverse={selected}>
      <Text dimColor={!selected}>{marker} </Text>
      {name}
      {description ? <Text dimColor={!selected}>{'  '}{shorten(description, 56)}</Text> : null}
      <Text dimColor={!selected}>
        {'   '}
        {done}/{total} agents done · {formatDuration(elapsedMs)} · {figures.arrowDown}{' '}
        {tokens > 0 ? formatTokenCount(tokens).toLowerCase() : '0'} tokens
      </Text>
      {selected ? <Text dimColor={false}> · Enter to view · x to stop</Text> : null}
    </Text>
  )

  if (!onOpen) return content
  return <Box onClick={() => onOpen(entry.id)}>{content}</Box>
}

export function WorkflowFooterStatus({ onOpen }: Props): React.ReactNode {
  const footerSelection = useAppState(s => s.footerSelection)
  const isSelected = footerSelection === 'workflow'

  // Re-render whenever the registry's rendered content changes (or runtime ticks).
  const [, force] = useState(0)
  useEffect(() => {
    let last = signature(getActiveWorkflows())
    const id = setInterval(() => {
      const sig = signature(getActiveWorkflows())
      if (sig !== last) {
        last = sig
        force(n => n + 1)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const active = getActiveWorkflows()
  if (active.length === 0) return null

  return (
    <Box flexDirection="column">
      {active.map((entry, i) => (
        <WorkflowRow key={entry.id} entry={entry} selected={isSelected && i === 0} onOpen={onOpen} />
      ))}
    </Box>
  )
}
