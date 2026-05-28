import * as React from 'react'
import { randomUUID } from 'crypto'
import { getTotalCostUSD } from '../../cost-tracker.js'
import { getTotalTokensUsed } from '../../bootstrap/state.js'
import { Box, Text, useInput } from '../../ink.js'
import type { Goal, GoalStatus } from '../../state/AppStateStore.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  buildObjectiveUpdatedPrompt,
  formatElapsed,
  formatGoalStatus,
  isGoalContinuationPrompt,
} from '../../utils/goal.js'
import { removeByFilter } from '../../utils/messageQueueManager.js'
import { renderToString } from '../../utils/staticRender.js'

function statusColor(status: GoalStatus): string {
  switch (status) {
    case 'pursuing':
      return 'green'
    case 'paused':
      return 'yellow'
    case 'achieved':
      return 'cyan'
    case 'blocked':
      return 'red'
    case 'usage-limited':
      return 'gray'
    case 'budget-limited':
      return 'magenta'
  }
}

function GoalDisplay({
  goal,
  now,
}: {
  goal: Goal
  now: number
}): React.ReactNode {
  const elapsed = formatElapsed(now - goal.startedAt)

  return (
    <Box flexDirection="column">
      <Text bold>Goal</Text>
      <Text>{goal.objective}</Text>
      <Box marginTop={1}>
        <Text>Status: </Text>
        <Text color={statusColor(goal.status)}>
          {formatGoalStatus(goal.status)}
        </Text>
      </Box>
      <Text dimColor>
        Elapsed: {elapsed} · Continuations:{' '}
        {goal.continuationCount}
      </Text>
      {goal.lastReason ? (
        <Text dimColor>Last update: {goal.lastReason}</Text>
      ) : null}
    </Box>
  )
}

function GoalOverwriteConfirm({
  existing,
  objective,
  context,
  onDone,
  inPlanMode,
}: {
  existing: Goal
  objective: string
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
  inPlanMode: boolean
}): React.ReactNode {
  const [choice, setChoice] = React.useState<'replace' | 'cancel' | null>(null)

  useInput((input, key) => {
    if (choice !== null) return
    if (input === 'y' || input === 'Y' || key.return) {
      setChoice('replace')
    } else if (input === 'n' || input === 'N' || key.escape) {
      setChoice('cancel')
    }
  })

  React.useEffect(() => {
    if (choice === null) return
    const { setAppState } = context

    if (choice === 'cancel') {
      onDone('Goal not changed.')
      return
    }

    const now = Date.now()
    const newGoal: Goal = {
      id: randomUUID(),
      objective,
      status: 'pursuing',
      startedAt: now,
      startCostUSD: getTotalCostUSD(),
      startTokensUsed: getTotalTokensUsed(),
      continuationCount: 0,
      lastUpdatedAt: now,
    }
    setAppState(prev => ({ ...prev, goal: newGoal }))
    clearQueuedGoalContinuations()

    const message = inPlanMode
      ? `Goal set: ${objective}\nAuto-continuation is disabled while in Plan mode. Exit plan mode (Shift+Tab) to begin pursuit.`
      : `Goal set: ${objective}\nThe agent will auto-continue toward this objective until it is achieved, blocked, or paused. Use /goal pause, /goal resume, /goal edit, or /goal clear to manage it.`
    onDone(message, {
      metaMessages: [
        `[goal] Active goal id: ${newGoal.id}. If calling update_goal for this goal, include goal_id='${newGoal.id}'.`,
      ],
    })
  }, [choice, objective, context, onDone, inPlanMode])

  return (
    <Box flexDirection="column">
      <Text bold>Replace existing goal?</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Current goal ({formatGoalStatus(existing.status)}):
        </Text>
      </Box>
      <Text>{existing.objective}</Text>
      <Box marginTop={1}>
        <Text dimColor>New objective:</Text>
      </Box>
      <Text>{objective}</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text bold>Enter</Text> to replace, <Text bold>Esc</Text> to
          cancel.
        </Text>
      </Box>
    </Box>
  )
}

function setGoal(
  setAppState: LocalJSXCommandContext['setAppState'],
  updater: (prev: Goal | undefined) => Goal | undefined,
): void {
  setAppState(prev => ({ ...prev, goal: updater(prev.goal) }))
}

function clearQueuedGoalContinuations(): void {
  removeByFilter(cmd => isGoalContinuationPrompt(cmd.value))
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const { getAppState, setAppState } = context
  const trimmed = args.trim()
  const firstTokenMatch = trimmed.match(/^\S+/)
  const firstToken = firstTokenMatch?.[0] ?? ''
  const sub = firstToken.toLowerCase()
  const rest = firstTokenMatch
    ? trimmed.slice(firstTokenMatch[0].length).trimStart()
    : ''

  const appState = getAppState()
  const existing = appState.goal
  const inPlanMode = appState.toolPermissionContext.mode === 'plan'

  if (sub === 'pause') {
    if (!existing) {
      onDone('No active goal.')
      return null
    }
    if (existing.status !== 'pursuing') {
      onDone(`Goal is already ${formatGoalStatus(existing.status)}.`)
      return null
    }
    setGoal(setAppState, g =>
      g ? { ...g, status: 'paused', lastUpdatedAt: Date.now() } : g,
    )
    clearQueuedGoalContinuations()
    onDone('Goal paused. Auto-continuation suspended.')
    return null
  }

  if (sub === 'resume') {
    if (!existing) {
      onDone('No active goal.')
      return null
    }
    if (existing.status === 'pursuing') {
      onDone('Goal already pursuing.')
      return null
    }
    if (existing.status === 'achieved') {
      onDone(
        `Goal already ${formatGoalStatus(existing.status)}. Use /goal <objective> to start a new one.`,
      )
      return null
    }
    // Allow resume from paused, blocked, budget-limited, usage-limited
    setGoal(setAppState, g =>
      g
        ? {
            ...g,
            status: 'pursuing',
            continuationCount: 0,
            startedAt: Date.now(),
            startCostUSD: getTotalCostUSD(),
            startTokensUsed: getTotalTokensUsed(),
            lastUpdatedAt: Date.now(),
            lastReason: undefined,
          }
        : g,
    )
    clearQueuedGoalContinuations()
    onDone(
      'Goal resumed. Continuation count and budget window reset; auto-continuation will start on the next idle tick.',
    )
    return null
  }

  if (sub === 'clear') {
    if (!existing) {
      onDone('No active goal.')
      return null
    }
    setGoal(setAppState, () => undefined)
    clearQueuedGoalContinuations()
    onDone('Goal cleared.')
    return null
  }

  if (sub === 'edit') {
    if (!existing) {
      onDone('No active goal. Set one with: /goal <objective>')
      return null
    }
    if (!rest) {
      onDone('Usage: /goal edit <new objective>')
      return null
    }
    setGoal(setAppState, g =>
      g
        ? {
            ...g,
            objective: rest,
            lastUpdatedAt: Date.now(),
          }
        : g,
    )
    clearQueuedGoalContinuations()
    onDone(`Goal objective updated to: ${rest}`, {
      metaMessages: [
        buildObjectiveUpdatedPrompt({ ...existing, objective: rest }),
      ],
    })
    return null
  }

  if (trimmed === '') {
    if (!existing) {
      onDone(
        'No active goal. Set one with: /goal <objective>\nThen the agent will auto-continue toward it across turns.',
      )
      return null
    }
    const display = (
      <GoalDisplay
        goal={existing as Goal}
        now={Date.now()}
      />
    )
    const output = await renderToString(display)
    onDone(output)
    return null
  }

  // Anything else is treated as a new objective.
  // If the user typed "/goal set <objective>", strip "set".
  const objective = (sub === 'set' ? rest : trimmed).trim()
  if (!objective) {
    onDone('Missing objective.\nUsage: /goal <objective>')
    return null
  }

  // Only allow overwriting a completed goal without confirmation.
  // For in-progress goals, show an interactive confirmation prompt.
  if (existing && (existing.status === 'pursuing' || existing.status === 'paused')) {
    return (
      <GoalOverwriteConfirm
        existing={existing}
        objective={objective}
        context={context}
        onDone={onDone}
        inPlanMode={inPlanMode}
      />
    )
  }

  const now = Date.now()
  const newGoal: Goal = {
    id: randomUUID(),
    objective,
    status: 'pursuing',
    startedAt: now,
    startCostUSD: getTotalCostUSD(),
    startTokensUsed: getTotalTokensUsed(),
    continuationCount: 0,
    lastUpdatedAt: now,
  }
  setGoal(setAppState, () => newGoal)
  clearQueuedGoalContinuations()

  const message = inPlanMode
    ? `Goal set: ${objective}\nAuto-continuation is disabled while in Plan mode. Exit plan mode (Shift+Tab) to begin pursuit.`
    : `Goal set: ${objective}\nThe agent will auto-continue toward this objective until it is achieved, blocked, or paused. Use /goal pause, /goal resume, /goal edit, or /goal clear to manage it.`
  onDone(message, {
    metaMessages: [
      `[goal] Active goal id: ${newGoal.id}. If calling update_goal for this goal, include goal_id='${newGoal.id}'.`,
    ],
  })
  return null
}
