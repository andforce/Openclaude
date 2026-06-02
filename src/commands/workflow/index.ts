import type { Command } from '../../commands.js'

const workflow = {
  type: 'local-jsx',
  name: 'workflow',
  aliases: ['workflows'],
  description: 'Run or view workflows — /workflow to see status, /workflow <task> to run',
  argumentHint: '[name|task]',
  immediate: true,
  load: () => import('./workflow.js'),
} satisfies Command

export default workflow
