/**
 * WorkflowTool — OpenClaude tool for dynamic multi-agent workflow orchestration.
 *
 * The model writes a JavaScript workflow script that fans out work across
 * multiple isolated subagents via agent(), parallel(), and pipeline(),
 * then synthesizes the results.
 *
 * Inspired by Anthropic's dynamic workflows in Claude Code.
 * Ported from pi-dynamic-workflows (MIT) and adapted for OpenClaude.
 */

import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { preview, recomputeWorkflowSnapshot, renderWorkflowText, createWorkflowSnapshot } from './display.js'
import { createWorkflowAgent } from './workflowAgent.js'
import { parseWorkflowScript, runWorkflow } from './workflow.js'
import { createWorkflowLoader } from './loader.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  registerWorkflow,
  updateWorkflow,
  completeWorkflow,
  failWorkflow,
  abortWorkflow,
} from './registry.js'
import type { WorkflowSnapshot } from './types.js'

// ─── Input Schema ────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    script: z
      .string()
      .describe(
        [
          'Required raw JavaScript workflow script, with no Markdown fences.',
          "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
          'Use phase(\'Name\'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.',
          'parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).',
        ].join(' '),
      ),
    args: z
      .any()
      .optional()
      .describe('Optional JSON value exposed to the workflow script as global `args`.'),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional token budget limit for the entire workflow. When exceeded, the workflow stops.'),
  }),
)

type InputSchema = typeof inputSchema
type Output = {
  text: string
  details: WorkflowSnapshot & { meta: any; phases: string[]; logs: string[]; result: unknown; durationMs: number }
}

// ─── Display Constants ───────────────────────────────────────────────

const WORKFLOW_DISPLAY_OPTIONS = {
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const

// ─── Prompt Guidelines ───────────────────────────────────────────────

const DESCRIPTION = [
  'Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().',
  'script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.',
].join(' ')

const PROMPT_GUIDELINES = [
  'Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.',
  'For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.',
  "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
  'For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().',
  'For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.',
  'For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.',
  'For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.',
  "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
  'For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).',
  'For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: \'repo inventory\' } or { label: \'source modules\' }; unique labels make live status and error reporting readable.',
  'For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.',
  'For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.',
  'For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.',
  'For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.',
  'For workflow, use workflow(\'name\', args) to invoke a saved workflow as a sub-workflow. Saved workflows live in .openclaude/workflows/ and are named by their meta.name. This allows composing workflows from reusable pieces.',
  'For workflow, set tokenBudget to limit total token spend across all subagents. Use budget.spent and budget.remaining in the script to check usage and stop early when needed.',
].join('\n')

// ─── Tool Definition ─────────────────────────────────────────────────

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'dynamic workflow multi-agent orchestration fan-out',
  maxResultSizeChars: 100_000,

  async description() {
    return DESCRIPTION
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isReadOnly() {
    return false
  },

  isConcurrencySafe() {
    return false
  },

  interruptBehavior() {
    return 'cancel'
  },

  async prompt() {
    return PROMPT_GUIDELINES
  },

  async checkPermissions(_input, _context) {
    return { behavior: 'allow' as const }
  },

  async call(args, context, canUseTool, parentMessage, onProgress) {
    const script = normalizeWorkflowScript(args.script)
    const parsed = parseWorkflowScript(script)
    let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta)

    // Register this workflow with the registry for /workflow command visibility
    const workflowId = registerWorkflow(parsed.meta)

    // Create the workflow agent runner using the parent context
    const agentRunner = createWorkflowAgent({
      toolUseContext: context,
      canUseTool,
      parentMessage,
    })

    const update = () => {
      snapshot = recomputeWorkflowSnapshot(snapshot)
      updateWorkflow(workflowId, snapshot)
      // Emit progress update with the current snapshot text
      onProgress?.({
        toolUseID: context.toolUseId ?? '',
        data: {
          type: 'workflow_progress' as any,
          text: renderWorkflowText(snapshot, false, WORKFLOW_DISPLAY_OPTIONS),
          snapshot,
        } as any,
      })
    }

    const recordPhase = (title: string | undefined) => {
      if (!title) return
      if (!snapshot.phases.includes(title)) snapshot.phases.push(title)
    }

    // Create the workflow loader for the workflow() sub-call primitive
    const workflowLoader = await createWorkflowLoader(process.cwd())

    let result: Awaited<ReturnType<typeof runWorkflow>>
    try {
      result = await runWorkflow(script, {
        // debug mode: omit real cwd to avoid exposing local paths
      cwd: context.options.debug ? undefined : getCwd(),
        args: args.args,
        agent: agentRunner,
        tokenBudget: args.tokenBudget ?? null,
        workflowLoader,
        signal: context.abortController.signal,
        onLog(message) {
          snapshot.logs.push(message)
          update()
        },
        onPhase(title) {
          snapshot.currentPhase = title
          recordPhase(title)
          update()
        },
        onAgentStart(event) {
          if (context.abortController.signal.aborted) throw new Error('Workflow was aborted')
          recordPhase(event.phase)
          snapshot.agents.push({
            id: snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: 'running',
            startedAt: event.startedAt,
          })
          update()
        },
        onAgentEnd(event) {
          const agent = [...snapshot.agents]
            .reverse()
            .find(item => item.label === event.label && item.status === 'running')
          if (agent) {
            agent.status = event.result === null ? 'error' : 'done'
            agent.resultPreview = preview(event.result)
            agent.model = event.model
            agent.inputTokens = event.inputTokens
            agent.outputTokens = event.outputTokens
            agent.toolCount = event.toolCount
            agent.durationMs = event.durationMs
          }
          update()
        },
      })
    } catch (error) {
      if (context.abortController.signal.aborted || isAbortError(error)) {
        for (const agent of snapshot.agents) {
          if (agent.status === 'running') {
            agent.status = 'skipped'
            agent.error = 'aborted'
          }
        }
        snapshot = recomputeWorkflowSnapshot(snapshot)
        abortWorkflow(workflowId, snapshot)
        throw new Error('Workflow was aborted')
      }
      snapshot = recomputeWorkflowSnapshot(snapshot)
      failWorkflow(workflowId, snapshot, error instanceof Error ? error.message : String(error))
      throw error
    }

    if (result.agentCount === 0) {
      snapshot = recomputeWorkflowSnapshot(snapshot)
      failWorkflow(workflowId, snapshot, 'No agents were run')
      throw new Error(
        'workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents',
      )
    }

    // Build final snapshot
    snapshot.result = result.result
    snapshot.durationMs = result.durationMs
    snapshot = recomputeWorkflowSnapshot(snapshot)
    completeWorkflow(workflowId, snapshot, result.result)

    const resultText = renderWorkflowText(snapshot, true, WORKFLOW_DISPLAY_OPTIONS)
    const resultJson = JSON.stringify(result.result, null, 2)

    return {
      data: {
        text: `${resultText}\n\nResult:\n${resultJson}`,
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
        },
      },
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: content.text,
    }
  },

  renderToolUseMessage(input) {
    return (
      <Text bold>
        workflow
        {input.script ? ` — ${extractMetaName(input.script)}` : ''}
      </Text>
    )
  },

  renderToolResultMessage(content) {
    return <Text>{content.text}</Text>
  },

  userFacingName() {
    return 'workflow'
  },

  toAutoClassifierInput(input) {
    return `workflow: ${input.script?.slice(0, 200) ?? ''}`
  },
} satisfies ToolDef<InputSchema, Output>)

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeWorkflowScript(script: string): string {
  let text = script.trim()
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) text = fence[1].trim()
  return text
}

function extractMetaName(script: string): string {
  try {
    const { meta } = parseWorkflowScript(script)
    return meta.name
  } catch {
    return 'unknown'
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /\babort(?:ed)?\b/i.test(error.message)
}

function getCwd(): string {
  return process.cwd()
}
