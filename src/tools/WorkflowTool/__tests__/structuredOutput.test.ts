import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod/v4'
import { createStructuredOutputTool } from '../structuredOutput.js'


// ─── JSON Schema → Zod conversion tests ───────────────────────────────

// We test via createStructuredOutputTool which internally calls jsonSchemaToZod

test('structured output tool accepts valid object against schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['ok', 'summary'],
    },
    capture,
  })

  // Verify the inputSchema is a zod schema
  assert.ok(tool.inputSchema instanceof z.ZodType)

  // Parse valid input
  const result = tool.inputSchema.parse({ ok: true, summary: 'done' })
  assert.deepEqual(result, { ok: true, summary: 'done' })
})

test('structured output tool rejects invalid object against schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['ok', 'summary'],
    },
    capture,
  })

  // Missing required field
  assert.throws(
    () => tool.inputSchema.parse({ ok: true }),
    /summary/,
  )

  // Wrong type
  assert.throws(
    () => tool.inputSchema.parse({ ok: 'yes', summary: 'done' }),
    /ok/,
  )
})

test('structured output tool handles optional fields', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['ok'],
    },
    capture,
  })

  // Parse without optional field
  const result = tool.inputSchema.parse({ ok: true })
  assert.deepEqual(result, { ok: true })

  // Parse with optional field
  const result2 = tool.inputSchema.parse({ ok: true, note: 'extra' })
  assert.deepEqual(result2, { ok: true, note: 'extra' })
})

test('structured output tool handles strict mode (additionalProperties: false)', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    capture,
  })

  // Valid
  const result = tool.inputSchema.parse({ ok: true })
  assert.deepEqual(result, { ok: true })

  // Extra property should fail in strict mode
  assert.throws(
    () => tool.inputSchema.parse({ ok: true, extra: 'nope' }),
  )
})

test('structured output tool handles string schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'string' },
    capture,
  })

  assert.equal(tool.inputSchema.parse('hello'), 'hello')
  assert.throws(() => tool.inputSchema.parse(42))
})

test('structured output tool handles number schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'number' },
    capture,
  })

  assert.equal(tool.inputSchema.parse(42), 42)
  assert.throws(() => tool.inputSchema.parse('nope'))
})

test('structured output tool handles boolean schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'boolean' },
    capture,
  })

  assert.equal(tool.inputSchema.parse(true), true)
  assert.throws(() => tool.inputSchema.parse('yes'))
})

test('structured output tool handles array schema with items', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'array',
      items: { type: 'string' },
    },
    capture,
  })

  const result = tool.inputSchema.parse(['a', 'b', 'c'])
  assert.deepEqual(result, ['a', 'b', 'c'])

  assert.throws(() => tool.inputSchema.parse([1, 2, 3]))
})

test('structured output tool handles const schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { const: 'ACK' },
    capture,
  })

  assert.equal(tool.inputSchema.parse('ACK'), 'ACK')
  assert.throws(() => tool.inputSchema.parse('NAK'))
})

test('structured output tool handles enum schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { enum: ['red', 'green', 'blue'] },
    capture,
  })

  assert.equal(tool.inputSchema.parse('red'), 'red')
  assert.throws(() => tool.inputSchema.parse('yellow'))
})

test('structured output tool handles type union', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: ['string', 'null'] },
    capture,
  })

  assert.equal(tool.inputSchema.parse('hello'), 'hello')
  assert.equal(tool.inputSchema.parse(null), null)
  assert.throws(() => tool.inputSchema.parse(42))
})

test('structured output tool handles null schema', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'null' },
    capture,
  })

  assert.equal(tool.inputSchema.parse(null), null)
  assert.throws(() => tool.inputSchema.parse('not null'))
})

test('structured output tool call captures value and sets called flag', async () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
    },
    capture,
  })

  const result = await tool.call(
    { ok: true },
    {} as any,
    {} as any,
    {} as any,
  )

  assert.equal(capture.called, true)
  assert.deepEqual(capture.value, { ok: true })
  assert.equal(result.data.text, 'Structured output received.')
})

test('structured output tool has correct tool metadata', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'string' },
    capture,
    name: 'custom_output',
  })

  assert.equal(tool.name, 'custom_output')
  assert.equal(tool.isReadOnly({} as any), true)
  assert.equal(tool.isConcurrencySafe({} as any), true)
})

test('structured output tool handles nested objects', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'string' } },
            count: { type: 'number' },
          },
          required: ['items', 'count'],
        },
      },
      required: ['data'],
    },
    capture,
  })

  const result = tool.inputSchema.parse({
    data: { items: ['a', 'b'], count: 2 },
  })
  assert.deepEqual(result, { data: { items: ['a', 'b'], count: 2 } })

  // Missing nested required field
  assert.throws(
    () => tool.inputSchema.parse({ data: { items: ['a'] } }),
  )
})

test('structured output tool handles integer type as number', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: { type: 'integer' },
    capture,
  })

  assert.equal(tool.inputSchema.parse(42), 42)
  assert.throws(() => tool.inputSchema.parse(3.14))
})

test('structured output tool handles descriptions on fields', () => {
  const capture = { called: false, value: undefined as any }
  const tool = createStructuredOutputTool({
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'Whether the operation succeeded' },
      },
      required: ['ok'],
    },
    capture,
  })

  const result = tool.inputSchema.parse({ ok: true })
  assert.equal(result.ok, true)
})
