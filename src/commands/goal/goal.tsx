import * as React from 'react'
import { randomUUID } from 'crypto'
import { getTotalCostUSD } from '../../cost-tracker.js'
import { Box, Text } from '../../ink.js'
import type { Goal, GoalStatus } from '../../state/AppStateStore.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  formatElapsed,
  formatGoalStatus,
  isGoalContinuationPrompt,
  parseGoalArgs,
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
    case 'unmet':
      return 'gray'
    case 'budget-limited':
      return 'red'
  }
}

function GoalDisplay({
  goal,
  currentCostUSD,
  now,
}: {
  goal: Goal
  currentCostUSD: number
  now: number
}): React.ReactNode {
  const elapsed = formatElapsed(now - goal.startedAt)
  const spent = (currentCostUSD - goal.startCostUSD).toFixed(2)
  const budget =
    goal.budgetUSD !== undefined
      ? `$${goal.budgetUSD.toFixed(2)}`
      : 'no budget'
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
        Elapsed: {elapsed} · Spent: ${spent} of {budget} · Continuations:{' '}
        {goal.continuationCount}
      </Text>
      {goal.lastReason ? (
        <Text dimColor>Last update: {goal.lastReason}</Text>
      ) : null}
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
      onDone(`Goal is already ${existing.status}.`)
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
    if (
      existing.status === 'achieved' ||
      existing.status === 'unmet' ||
      existing.status === 'budget-limited'
    ) {
      onDone(
        `Goal already ${existing.status}. Use /goal <objective> to start a new one.`,
      )
      return null
    }
    setGoal(setAppState, g =>
      g
        ? {
            ...g,
            status: 'pursuing',
            continuationCount: 0,
            startedAt: Date.now(),
            startCostUSD: getTotalCostUSD(),
            lastUpdatedAt: Date.now(),
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
        currentCostUSD={getTotalCostUSD()}
        now={Date.now()}
      />
    )
    const output = await renderToString(display)
    onDone(output)
    return null
  }

  // Anything else is treated as a new objective. Flags: --budget=$5 --time=30m
  const argSource = sub === 'set' ? rest : trimmed
  const parsed = parseGoalArgs(argSource)
  if (parsed.errors.length > 0) {
    onDone(
      `Could not parse /goal arguments:\n  - ${parsed.errors.join('\n  - ')}\nUsage: /goal [--budget=$5] [--time=30m] <objective>`,
    )
    return null
  }
  if (!parsed.objective) {
    onDone(
      'Missing objective.\nUsage: /goal [--budget=$5] [--time=30m] <objective>',
    )
    return null
  }
  const now = Date.now()
  const newGoal: Goal = {
    id: randomUUID(),
    objective: parsed.objective,
    status: 'pursuing',
    startedAt: now,
    startCostUSD: getTotalCostUSD(),
    continuationCount: 0,
    budgetUSD: parsed.budgetUSD,
    budgetDurationMs: parsed.budgetDurationMs,
    lastUpdatedAt: now,
  }
  setGoal(setAppState, () => newGoal)
  clearQueuedGoalContinuations()

  const budgetParts: string[] = []
  if (parsed.budgetUSD !== undefined)
    budgetParts.push(`$${parsed.budgetUSD.toFixed(2)}`)
  if (parsed.budgetDurationMs !== undefined)
    budgetParts.push(formatElapsed(parsed.budgetDurationMs))
  const budgetSuffix =
    budgetParts.length > 0 ? ` (budget: ${budgetParts.join(', ')})` : ''
  const message = inPlanMode
    ? `Goal set: ${parsed.objective}${budgetSuffix}\nAuto-continuation is disabled while in Plan mode. Exit plan mode (Shift+Tab) to begin pursuit.`
    : `Goal set: ${parsed.objective}${budgetSuffix}\nThe agent will auto-continue toward this objective until it is achieved, unmet, paused, budget-limited, or hits the continuation cap. Use /goal pause, /goal resume, or /goal clear to manage it.`
  onDone(message, {
    metaMessages: [
      `[goal] Active goal id: ${newGoal.id}. If calling goal_update for this goal, include goal_id='${newGoal.id}'.`,
    ],
  })
  return null
}
