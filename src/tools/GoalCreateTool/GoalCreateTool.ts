import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { getTotalTokensUsed } from '../../bootstrap/state.js'
import { getTotalCostUSD } from '../../cost-tracker.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  formatGoalStatus,
  isGoalInactive,
} from '../../utils/goal.js'
import {
  CREATE_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_PROMPT,
  DESCRIPTION,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    objective: z
      .string()
      .min(1)
      .describe(
        'Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    goal_id: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GoalCreateTool = buildTool({
  name: CREATE_GOAL_TOOL_NAME,
  searchHint: 'create a new thread goal',
  maxResultSizeChars: 4_000,
  userFacingName: () => 'Create Goal',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.objective
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return CREATE_GOAL_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ objective }, { getAppState, setAppState }) {
    const appState = getAppState()
    const existing = appState.goal

    if (existing && !isGoalInactive(existing.status)) {
      return {
        data: {
          success: false,
          message: `Cannot create a new goal because this thread already has an active goal (status: ${formatGoalStatus(existing.status)}). Use update_goal to change its status, or ask the user to clear it with /goal clear first.`,
        },
      }
    }

    const now = Date.now()
    const goalId = randomUUID()

    setAppState(prev => ({
      ...prev,
      goal: {
        id: goalId,
        objective: objective.trim(),
        status: 'pursuing' as const,
        startedAt: now,
        startCostUSD: getTotalCostUSD(),
        startTokensUsed: getTotalTokensUsed(),
        continuationCount: 0,
        lastUpdatedAt: now,
      },
    }))

    return {
      data: {
        success: true,
        goal_id: goalId,
        message: `Goal created: ${objective.trim()}. The agent will auto-continue toward this objective.`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
