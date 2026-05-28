export const GET_GOAL_TOOL_NAME = 'get_goal'

export const DESCRIPTION =
  'Get the current goal for this thread, including status and elapsed-time usage.'

export const GET_GOAL_TOOL_PROMPT = `Get the current goal for this thread. Use this to inspect the goal state, including its objective, status, elapsed time, and continuation count.

This tool takes no arguments and returns structured data about the active goal, or indicates that no goal is active.`
