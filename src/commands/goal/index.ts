import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set or manage a long-running autonomous goal. The agent auto-continues toward it across turns until achieved, unmet, paused, budget-limited, or the continuation cap is reached.',
  argumentHint: '[pause|resume|clear|[--budget=$5] [--time=30m] <objective>]',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
