export const GOAL_UPDATE_TOOL_NAME = 'goal_update'

export const DESCRIPTION =
  "Declare the outcome of an active /goal: 'achieved' if the objective is complete, 'unmet' if it is blocked or impossible. Requires the active goal_id and stops the auto-continuation loop. No-op if no matching goal is active."

export const GOAL_UPDATE_TOOL_PROMPT = `Use this tool to declare the outcome of the user's active goal (set via the /goal slash command).

When called:
- \`goal_id\` — the exact id from the latest active /goal continuation prompt.
- \`status: 'achieved'\` — the objective is fully complete; auto-continuation stops.
- \`status: 'unmet'\` — the objective is blocked, impossible, or no longer makes sense; auto-continuation stops.
- \`reason\` — one short sentence explaining what was accomplished or what blocked progress. The user reads this.

Only call this when you are confident and the goal_id you have matches the active goal. If you are still working toward the goal, just continue with normal tool calls and let the next continuation tick fire. The tool is a no-op if no matching goal is active.`
