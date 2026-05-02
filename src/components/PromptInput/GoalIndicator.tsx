import * as React from 'react'
import { Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { GoalStatus } from '../../state/AppStateStore.js'

const MAX_OBJECTIVE_CHARS = 30

function statusColor(status: GoalStatus): string {
  switch (status) {
    case 'pursuing':
      return 'green'
    case 'paused':
      return 'yellow'
    case 'achieved':
      return 'cyan'
    case 'unmet':
      return 'gray'
    case 'budget-limited':
      return 'red'
  }
}

export function GoalIndicator(): React.ReactNode {
  const goal = useAppState(s => s.goal)
  const mode = useAppState(s => s.toolPermissionContext.mode)
  if (!goal) return null

  const truncated =
    goal.objective.length > MAX_OBJECTIVE_CHARS
      ? goal.objective.slice(0, MAX_OBJECTIVE_CHARS - 1) + '…'
      : goal.objective

  const planSuppressed = goal.status === 'pursuing' && mode === 'plan'
  const label = planSuppressed ? 'paused: plan mode' : goal.status
  const color = planSuppressed ? 'yellow' : statusColor(goal.status)

  return (
    <Text>
      <Text color={color}>●</Text>
      <Text dimColor> goal: </Text>
      <Text>{truncated}</Text>
      <Text dimColor> [{label}]</Text>
    </Text>
  )
}
