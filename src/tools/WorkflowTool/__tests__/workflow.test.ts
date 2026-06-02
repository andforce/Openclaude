import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkflowScript, runWorkflow } from '../workflow.js'

// ─── Parser Tests ────────────────────────────────────────────────────

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`

test('parseWorkflowScript accepts literal workflow metadata', () => {
  const parsed = parseWorkflowScript(validScript)
  assert.equal(parsed.meta.name, 'demo_workflow')
  assert.equal(parsed.meta.description, 'A useful workflow')
  assert.deepEqual(parsed.meta.phases, [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }])
  assert.match(parsed.body, /phase\('Scan'\)/)
  assert.doesNotMatch(parsed.body, /export const meta/)
})

test('parseWorkflowScript accepts static template literals', () => {
  const parsed = parseWorkflowScript(
    'export const meta = { name: `demo`, description: `static` }\nreturn true',
  )
  assert.equal(parsed.meta.name, 'demo')
  assert.equal(parsed.meta.description, 'static')
})

test('parseWorkflowScript requires meta export first', () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "const x = 1\nexport const meta = { name: 'demo', description: 'desc' }",
      ),
    /must be the first statement/,
  )
})

test('parseWorkflowScript requires name and description', () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo' }"),
    /meta.description/,
  )
  assert.throws(
    () => parseWorkflowScript("export const meta = { description: 'desc' }"),
    /meta.name/,
  )
})

test('parseWorkflowScript rejects non-literal metadata', () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: makeName(), description: 'desc' }",
      ),
    /non-literal node type.*CallExpression/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "const name = 'demo'; export const meta = { name, description: 'desc' }",
      ),
    /must be the first statement/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: name, description: 'desc' }",
      ),
    /non-literal node type.*Identifier/,
  )
})

test('parseWorkflowScript rejects object hazards', () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { ...base, name: 'demo', description: 'desc' }",
      ),
    /spread not allowed/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { ['name']: 'demo', description: 'desc' }",
      ),
    /computed keys not allowed/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { __proto__: {}, name: 'demo', description: 'desc' }",
      ),
    /reserved key name/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { get name() { return 'demo' }, description: 'desc' }",
      ),
    /methods\/accessors not allowed/,
  )
})

test('parseWorkflowScript rejects array hazards', () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc', phases: [,,] }",
      ),
    /sparse arrays not allowed/,
  )
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc', phases: [...items] }",
      ),
    /spread not allowed/,
  )
})

test('parseWorkflowScript rejects template interpolation', () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: `demo_${`id`}`, description: 'desc' }",
      ),
    /template interpolation not allowed/,
  )
})

test('parseWorkflowScript rejects nondeterministic APIs', () => {
  for (const expression of [
    'Date.now()',
    "Date['now']()",
    'Date[`now`]()',
    "Date['n' + 'ow']()",
    'Date?.now()',
    'Date.now?.()',
    'Math.random()',
    "Math['random']()",
    'Math[`random`]()',
    "Math['ran' + 'dom']()",
    'Math?.random()',
    'Math.random?.()',
    'new Date()',
    'new (Date)()',
  ]) {
    assert.throws(
      () =>
        parseWorkflowScript(
          `export const meta = { name: 'demo', description: 'desc' }\nreturn ${expression}`,
        ),
      /must be deterministic/,
      expression,
    )
  }
})

test('parseWorkflowScript allows deterministic Date and Math APIs', () => {
  for (const expression of [
    "Date.parse('2020-01-01T00:00:00Z')",
    'Date.UTC(2020, 0, 1)',
    'Math.max(1, 2)',
    'Math.floor(1.5)',
    '({ Date: { now: true }, Math: { random: true } })',
    '({ now: () => 1 }).now()',
    '({ random: () => 1 }).random()',
  ]) {
    assert.doesNotThrow(
      () =>
        parseWorkflowScript(
          `export const meta = { name: 'demo', description: 'desc' }\nreturn ${expression}`,
        ),
      expression,
    )
  }
})

test('parseWorkflowScript allows nondeterministic API names in text', () => {
  const parsed = parseWorkflowScript(`export const meta = {
  name: 'mentions_demo',
  description: 'Catalog Date.now(), Math.random(), and new Date() usage',
  whenToUse: 'When prompts mention Date.now()',
  phases: [{ title: 'Find Date.now() mentions', detail: 'Check Math.random() and new Date() too' }]
}

// Comments may mention Date.now(), Math.random(), and new Date().
const terms = {
  'Date.now()': 'Date.now()',
  'Math.random()': 'Math.random()',
  'new Date()': 'new Date()'
}
phase('Find Date.now() mentions')
await agent('Catalog Date.now(), Math.random(), and new Date() usage')
await agent(\`Find Date.now(), Math.random(), and new Date() mentions\`)
return { ok: true, terms }
`)

  assert.equal(parsed.meta.description, 'Catalog Date.now(), Math.random(), and new Date() usage')
  assert.match(parsed.body, /Catalog Date\.now\(\)/)
})

// ─── Runtime Tests ───────────────────────────────────────────────────

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`
  },
}

test('runWorkflow accepts metadata without phases and records runtime phases', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  )

  assert.deepEqual(result.phases, ['Scan'])
  assert.equal(result.agentCount, 1)
  assert.equal((result.result as { scan: string }).scan, 'result:scan')
})

test('runWorkflow records loop-created phases without skipped conditional phases', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ['API', 'UI'] },
      agent: fakeAgent,
    },
  )

  assert.deepEqual(result.phases, ['Inspect API', 'Inspect UI'])
  assert.equal(result.agentCount, 2)
})

test('runWorkflow rejects unawaited nested agent promises before returning details', async () => {
  let ended = 0

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?/,
  )

  assert.equal(ended, 1)
})

test('runWorkflow rejects non-string runtime phase titles', async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  )
})

test('runWorkflow allows prompts that mention nondeterministic API names', async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  )

  assert.equal(
    (result.result as { scan: string }).scan,
    'result:Catalog Date.now(), Math.random(), and new Date() usage',
  )
})

// ─── Agent Count Limit Tests ─────────────────────────────────────────

test('runWorkflow enforces MAX_AGENTS_PER_RUN limit', async () => {
  // Generate a script that spawns exactly 1001 agents
  const agents = Array.from({ length: 1001 }, (_, i) =>
    `await agent('task ${i}', { label: 'task ${i}' })`,
  ).join('\n')

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'overrun', description: 'Too many agents' }
${agents}
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /workflow agent limit reached/,
  )
})

// ─── workflow() Sub-workflow Primitive Tests ──────────────────────────

test('runWorkflow supports workflow() sub-call', async () => {
  const subScript = `export const meta = { name: 'sub_workflow', description: 'A sub-workflow' }
phase('Sub Phase')
const result = await agent('sub task', { label: 'sub agent' })
return { subResult: result }`

  const loader = (name: string) => {
    if (name === 'my_sub') return subScript
    return undefined
  }

  const result = await runWorkflow(
    `export const meta = { name: 'parent', description: 'Parent workflow with sub-call' }
phase('Parent Phase')
const sub = await workflow('my_sub', { input: 'hello' })
return { parent: true, sub }
`,
    { agent: fakeAgent, workflowLoader: loader },
  )

  assert.equal((result.result as any).parent, true)
  assert.deepEqual((result.result as any).sub, { subResult: 'result:sub task' })
  assert.equal(result.agentCount, 1)
  assert.deepEqual(result.phases, ['Parent Phase', 'Sub Phase'])
})

test('runWorkflow rejects workflow() without loader', async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'no_loader', description: 'No loader provided' }
await workflow('missing', {})
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /requires a workflowLoader/,
  )
})

test('runWorkflow rejects workflow() for unknown name', async () => {
  const loader = () => undefined

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'unknown_sub', description: 'Unknown sub-workflow' }
await workflow('does_not_exist', {})
return { ok: true }
`,
        { agent: fakeAgent, workflowLoader: loader },
      ),
    /workflow 'does_not_exist' not found/,
  )
})

test('runWorkflow rejects nested sub-workflows beyond depth limit', async () => {
  const subScript = `export const meta = { name: 'inner', description: 'Inner sub-workflow' }
await workflow('innermost', {})
return { ok: true }`

  const innermost = `export const meta = { name: 'innermost', description: 'Too deep' }
return { ok: true }`

  const loader = (name: string) => {
    if (name === 'inner') return subScript
    if (name === 'innermost') return innermost
    return undefined
  }

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'outer', description: 'Outer workflow' }
await workflow('inner', {})
return { ok: true }
`,
        { agent: fakeAgent, workflowLoader: loader },
      ),
    /workflow nesting limit reached/,
  )
})

// ─── Terminate (structured output) Tests ─────────────────────────────

test('structured output capture.called triggers early termination', async () => {
  // Verify the capture mechanism works correctly
  const { createStructuredOutputTool } = await import('../structuredOutput.js')
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    capture,
  })

  // Before call
  assert.equal(capture.called, false)
  assert.equal(capture.value, undefined)

  // Simulate tool call
  await (tool as any).call({ answer: '42' })

  // After call — capture should be set
  assert.equal(capture.called, true)
  assert.deepEqual(capture.value, { answer: '42' })
})
