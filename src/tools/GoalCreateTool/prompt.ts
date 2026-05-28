export const CREATE_GOAL_TOOL_NAME = 'create_goal'

export const DESCRIPTION =
  'Create a goal only when explicitly requested by the user or system/developer instructions. Do not infer goals from ordinary tasks. Fails if a goal exists; use update_goal only for status.'

export const CREATE_GOAL_TOOL_PROMPT = `Create a new active goal for this thread only when explicitly requested by the user or system/developer instructions. Do not infer goals from ordinary tasks.

When called:
- \`objective\` — required. The concrete objective to start pursuing.

This tool fails if a goal already exists; use update_goal only for status changes to the existing goal.`
