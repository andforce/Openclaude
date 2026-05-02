import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  DESCRIPTION,
  GOAL_UPDATE_TOOL_NAME,
  GOAL_UPDATE_TOOL_PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    goal_id: z
      .string()
      .min(1)
      .describe('The active goal id from the latest /goal continuation prompt.'),
    status: z
      .enum(['achieved', 'unmet'])
      .describe(
        "'achieved' if the goal is complete; 'unmet' if blocked or impossible.",
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe('One-sentence explanation visible to the user.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['achieved', 'unmet', 'no-active-goal', 'stale-goal']),
    reason: z.string(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GoalUpdateTool = buildTool({
  name: GOAL_UPDATE_TOOL_NAME,
  searchHint: 'declare /goal outcome — achieved or unmet',
  maxResultSizeChars: 4_000,
  userFacingName: () => 'Goal Update',
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
    return input.reason
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return GOAL_UPDATE_TOOL_PROMPT
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
  async call({ goal_id, status, reason }, { getAppState, setAppState }) {
    const goal = getAppState().goal
    if (!goal || (goal.status !== 'pursuing' && goal.status !== 'paused')) {
      return {
        data: {
          status: 'no-active-goal' as const,
          reason,
          message: 'No active goal — nothing to update.',
        },
      }
    }
    if (goal.id !== goal_id) {
      return {
        data: {
          status: 'stale-goal' as const,
          reason,
          message:
            'Goal id does not match the active goal — ignoring stale update.',
        },
      }
    }
    const now = Date.now()
    let updated = false
    setAppState(prev => {
      const current = prev.goal
      if (
        !current ||
        current.id !== goal_id ||
        (current.status !== 'pursuing' && current.status !== 'paused')
      ) {
        return prev
      }
      updated = true
      return {
        ...prev,
        goal: {
          ...current,
          status,
          lastReason: reason,
          lastUpdatedAt: now,
        },
      }
    })
    if (!updated) {
      return {
        data: {
          status: 'stale-goal' as const,
          reason,
          message:
            'Goal changed before the update was applied — ignoring stale update.',
        },
      }
    }
    return {
      data: {
        status,
        reason,
        message: `Goal marked ${status}.`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
