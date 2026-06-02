/**
 * Structured output tool for workflow subagents.
 *
 * When a workflow script calls agent(prompt, { schema: {...} }), this tool
 * is injected into the subagent's tool pool so it can return validated,
 * machine-readable results instead of plain text.
 *
 * Ported from pi-dynamic-workflows (MIT) and adapted for OpenClaude.
 */

import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { buildTool } from '../../Tool.js'
import type { JsonSchema } from './types.js'

// ─── Capture ──────────────────────────────────────────────────────────

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined
  called: boolean
}

// ─── JSON Schema → Zod ────────────────────────────────────────────────

/**
 * Converts a JSON Schema object to a Zod schema for runtime validation.
 * Handles the subset of JSON Schema used in workflow structured output:
 * object (with properties, required, additionalProperties), string, number,
 * boolean, array (with items), enum, const.
 */
function jsonSchemaToZod(schema: JsonSchema, path = '$'): z.ZodType {
  // Handle type unions: { type: ['string', 'null'] }
  if (Array.isArray(schema.type)) {
    const schemas = schema.type.map(t => {
      const single: JsonSchema = { ...schema, type: t }
      return jsonSchemaToZod(single, path)
    })
    if (schemas.length === 0) return z.unknown()
    // Build a union: z.union([a, b, ...])
    return schemas.reduce((acc, s) => (acc as any).or(s), schemas[0])
  }

  if (schema.const !== undefined) {
    return z.literal(schema.const)
  }

  if (schema.enum !== undefined) {
    if (schema.enum.length === 0) return z.never()
    const values = schema.enum.map(v => z.literal(v))
    if (values.length === 1) return values[0]
    return (values[0] as any).or(values[1], ...values.slice(2))
  }

  switch (schema.type) {
    case 'string': {
      let s = z.string()
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case 'number': {
      let s = z.number()
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case 'integer': {
      let s = z.number().refine(v => Number.isInteger(v), 'must be an integer')
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case 'boolean': {
      let s = z.boolean()
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case 'array': {
      const itemSchema = schema.items
        ? jsonSchemaToZod(
            Array.isArray(schema.items) ? (schema.items[0] as JsonSchema) : (schema.items as JsonSchema),
            `${path}[]`,
          )
        : z.unknown()
      let s = z.array(itemSchema)
      if (schema.description) s = s.describe(schema.description)
      return s
    }
    case 'object': {
      const shape: Record<string, z.ZodType> = {}
      const required = new Set(schema.required ?? [])

      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          let field = jsonSchemaToZod(propSchema as JsonSchema, `${path}.${key}`)
          if (!required.has(key)) {
            field = field.optional()
          }
          if ((propSchema as JsonSchema).description) {
            field = field.describe((propSchema as JsonSchema).description!)
          }
          shape[key] = field
        }
      }

      let obj = z.object(shape)
      if (schema.description) obj = obj.describe(schema.description)
      if (schema.additionalProperties === false) obj = obj.strict()
      return obj
    }
    case 'null':
      return z.null()
    default: {
      // No explicit type — treat as unknown (pass-through)
      return z.unknown()
    }
  }
}

// ─── Tool Definition ──────────────────────────────────────────────────

export interface StructuredOutputToolOptions {
  schema: JsonSchema
  capture: StructuredOutputCapture
  name?: string
}

/**
 * Creates a structured_output tool that captures validated params as the
 * subagent's return value. The tool's inputSchema is derived from the
 * provided JSON Schema so the model knows the expected output shape.
 */
export function createStructuredOutputTool({
  schema,
  capture,
  name = 'structured_output',
}: StructuredOutputToolOptions) {
  const zodSchema = jsonSchemaToZod(schema)

  return buildTool({
    name,
    userFacingName: () => 'Structured Output',

    get inputSchema() {
      return zodSchema
    },

    isReadOnly() {
      return true
    },

    isConcurrencySafe() {
      return true
    },

    async description() {
      return [
        'Return the final machine-readable result for this subagent task.',
        'Call this exactly once when all work is complete.',
      ].join(' ')
    },

    async prompt() {
      return [
        `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
        `Do not write a prose final answer after calling ${name}.`,
      ].join('\n')
    },

    async call(args) {
      capture.value = args
      capture.called = true
      return {
        data: {
          text: 'Structured output received.',
          details: args,
        },
      }
    },

    mapToolResultToToolResultBlockParam(content) {
      return {
        type: 'tool_result' as const,
        tool_use_id: '',
        content: content.text,
      }
    },

    renderToolUseMessage() {
      return React.createElement(Text, null, 'Structured Output')
    },

    renderToolResultMessage(content) {
      return React.createElement(Text, null, content.text)
    },

    toAutoClassifierInput() {
      return 'structured_output'
    },
  })
}
