import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  formatElapsed,
  formatGoalStatus,
} from '../../utils/goal.js'
import {
  DESCRIPTION,
  GET_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const goalInfoSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.string(),
  elapsed_ms: z.number(),
  elapsed_formatted: z.string(),
  continuation_count: z.number(),
})

const outputSchema = lazySchema(() =>
  z.object({
    goal: goalInfoSchema.nullable(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GoalGetTool = buildTool({
  name: GET_GOAL_TOOL_NAME,
  searchHint: 'get current thread goal status and budget',
  maxResultSizeChars: 4_000,
  userFacingName: () => 'Get Goal',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return GET_GOAL_TOOL_PROMPT
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
  async call(_input, { getAppState }) {
    const goal = getAppState().goal

    if (!goal) {
      return {
        data: {
          goal: null,
          message: 'No active goal.',
        },
      }
    }

    const now = Date.now()
    const elapsed = now - goal.startedAt

    return {
      data: {
        goal: {
          id: goal.id,
          objective: goal.objective,
          status: formatGoalStatus(goal.status),
          elapsed_ms: elapsed,
          elapsed_formatted: formatElapsed(elapsed),
          continuation_count: goal.continuationCount,
        },
        message: `Current goal: ${goal.objective} (${formatGoalStatus(goal.status)})`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
