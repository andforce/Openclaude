export const UPDATE_GOAL_TOOL_NAME = 'update_goal'

export const DESCRIPTION =
  "Update the existing goal. Use this only to mark the goal complete or genuinely blocked. Set status to 'complete' only when the objective has been fully achieved with no remaining work. Set status to 'blocked' only when the same blocking condition has repeated for at least three consecutive goal turns."

export const UPDATE_GOAL_TOOL_PROMPT = `Use this tool only to mark the goal achieved or genuinely blocked.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked \`blocked\`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to \`blocked\` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to \`blocked\`.
Do not use \`blocked\` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.

When called:
- \`goal_id\` — the exact id from the latest active goal continuation prompt.
- \`status: 'complete'\` — the objective is fully achieved; auto-continuation stops.
- \`status: 'blocked'\` — the same blocking condition has repeated for 3+ consecutive goal turns; auto-continuation stops.
- \`reason\` — one short sentence explaining what was accomplished or what blocked progress. The user reads this.

Only call this when you are confident and the goal_id you have matches the active goal. The tool is a no-op if no matching goal is active.`
