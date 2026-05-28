import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set or manage a long-running autonomous goal. The agent auto-continues toward it across turns until achieved, blocked, or paused.',
  argumentHint: '[pause|resume|clear|edit|set <objective>]',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
