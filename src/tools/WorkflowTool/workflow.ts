/**
 * Workflow script parser and sandboxed runtime.
 *
 * Parses JavaScript workflow scripts using acorn, validates determinism
 * (no Date.now / Math.random / new Date), extracts literal metadata,
 * and runs the script body in a Node.js vm sandbox with workflow globals.
 *
 * Ported from pi-dynamic-workflows (MIT) and adapted for OpenClaude.
 */

import vm from 'node:vm'
import type { Node } from 'acorn'
import { parse } from 'acorn'
import type {
  AgentOptions,
  WorkflowAgentRunner,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult,
} from './types.js'
import type { WorkflowAgentRunResult } from './workflowAgent.js'

// ─── Types ───────────────────────────────────────────────────────────

interface RuntimeState {
  currentPhase?: string
  logs: string[]
  phases: string[]
  agentCount: number
  spent: number
  depth: number
}

type AnyNode = Node & { [key: string]: any; start: number; end: number }

// ─── Constants ───────────────────────────────────────────────────────

const NONDETERMINISM_ERROR =
  'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable'

/** Safety fuse: prevent runaway scripts from spawning unbounded agents. */
const MAX_AGENTS_PER_RUN = 1000

/** Maximum nesting depth for inline sub-workflows. */
const MAX_WORKFLOW_DEPTH = 1

// ─── Public API ──────────────────────────────────────────────────────

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now()
  const { meta, body } = parseWorkflowScript(script)
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0, depth: options.depth ?? 0 }
  const agentRunner = options.agent
  if (!agentRunner) throw new Error('workflow requires an agent runner')

  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
      16,
    ),
  )
  const limiter = createLimiter(concurrency)
  const pendingAgentRuns = new Set<Promise<unknown>>()

  const log = (message: string) => {
    const text = String(message)
    state.logs.push(text)
    options.onLog?.(text)
  }

  const phase = (title: unknown) => {
    const text = requireString(title, 'phase title')
    state.currentPhase = text
    if (!state.phases.includes(text)) state.phases.push(text)
    options.onPhase?.(text)
  }

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () =>
      options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent),
  })

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error('workflow aborted')
  }

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted()
    const taskPrompt = requireString(prompt, 'agent prompt')
    const normalizedOptions = normalizeAgentOptions(agentOptions)
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase
    const requestedLabel = normalizedOptions.label?.trim()
    const run = limiter(async () => {
      // Check limits at execution time (inside limiter) so concurrent
      // scheduling cannot bypass MAX_AGENTS_PER_RUN.
      throwIfAborted()
      const cumulativeCount = state.agentCount + (options.agentCountOffset ?? 0)
      if (cumulativeCount >= MAX_AGENTS_PER_RUN)
        throw new Error(
          `workflow agent limit reached (${MAX_AGENTS_PER_RUN}); aborting to prevent runaway scripts`,
        )
      if (budget.total !== null && budget.remaining() <= 0)
        throw new Error('workflow token budget exhausted')

      state.agentCount++
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount)
      const startedAt = Date.now()
      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt, startedAt })
      try {
        throwIfAborted()
        const rawResult = await agentRunner.run(taskPrompt, {
          label,
          schema: normalizedOptions.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
          model: normalizedOptions.model,
        })
        throwIfAborted()

        // Extract rich metrics if available (from WorkflowAgentRunResult)
        const agentResult = extractAgentResult(rawResult)
        const output = agentResult.output
        const durationMs = Date.now() - startedAt

        state.spent += (agentResult.inputTokens ?? 0) + (agentResult.outputTokens ?? 0)
        options.onAgentEnd?.({
          label,
          phase: assignedPhase,
          result: output,
          model: agentResult.model,
          inputTokens: agentResult.inputTokens,
          outputTokens: agentResult.outputTokens,
          toolCount: agentResult.toolCount,
          durationMs,
        })
        return output
      } catch (error) {
        if (options.signal?.aborted) throw error
        const durationMs = Date.now() - startedAt
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null, durationMs })
        return null
      }
    })
    pendingAgentRuns.add(run)
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    )
    return run
  }

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted()
    if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions')
    if (thunks.some(thunk => typeof thunk !== 'function')) {
      throw new TypeError(
        'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
      )
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk()
        } catch (error) {
          if (options.signal?.aborted) throw error
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`)
          return null
        }
      }),
    )
  }

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted()
    if (!Array.isArray(items)) throw new TypeError('pipeline() expects an array as the first argument')
    if (stages.some(stage => typeof stage !== 'function')) {
      throw new TypeError(
        'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
      )
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          try {
            throwIfAborted()
            value = await stage(value, item, index)
            throwIfAborted()
          } catch (error) {
            if (options.signal?.aborted) throw error
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`)
            return null
          }
        }
        return value
      }),
    )
  }

  const runSubWorkflow = async (name: unknown, subArgs: unknown = {}) => {
    throwIfAborted()
    const workflowName = requireString(name, 'workflow name')
    if (state.depth >= MAX_WORKFLOW_DEPTH) {
      throw new Error(
        `workflow nesting limit reached (max ${MAX_WORKFLOW_DEPTH} level${MAX_WORKFLOW_DEPTH > 1 ? 's' : ''}); sub-workflows cannot call sub-workflows`,
      )
    }
    if (!options.workflowLoader) {
      throw new Error(
        `workflow('${workflowName}') requires a workflowLoader to resolve workflow scripts`,
      )
    }
    const script = options.workflowLoader(workflowName)
    if (!script) {
      throw new Error(`workflow '${workflowName}' not found`)
    }
    const subResult = await runWorkflow(script, {
      ...options,
      args: subArgs,
      depth: state.depth + 1,
      agentCountOffset: (options.agentCountOffset ?? 0) + state.agentCount,
      // Sub-workflows share the parent's agent runner, concurrency, budget, signal
    })
    // Propagate sub-workflow's state into parent
    for (const logLine of subResult.logs) {
      state.logs.push(logLine)
      options.onLog?.(logLine)
    }
    for (const phaseName of subResult.phases) {
      if (!state.phases.includes(phaseName)) state.phases.push(phaseName)
    }
    state.agentCount += subResult.agentCount
    state.spent += estimateTokens(subResult.result)
    return subResult.result
  }

  // Create sandboxed context with workflow globals
  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    workflow: runSubWorkflow,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  })

  // Run the script body inside the async IIFE wrapper. Wrap in try/finally
  // so pending agent runs are always drained — even on abort or script error.
  const wrapped = `(async () => {\n${body}\n})()`
  let result: unknown
  try {
    result = await new vm.Script(wrapped, {
      filename: `${meta.name || 'workflow'}.js`,
    }).runInContext(context)
  } finally {
    // Wait for any pending agent runs to complete
    await Promise.allSettled([...pendingAgentRuns])
  }

  // Validate the result is serializable
  assertStructuredCloneable(result, 'workflow result')

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  }
}

// ─── Parser ──────────────────────────────────────────────────────────

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode

  assertDeterministicAst(ast)

  const first = ast.body?.[0] as AnyNode | undefined
  if (first?.type !== 'ExportNamedDeclaration') {
    throw new Error('`export const meta = { name, description }` must be the first statement in the script')
  }

  const declaration = first.declaration as AnyNode | null
  if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
    throw new Error('meta export must be `export const meta = ...`')
  }
  if (declaration.declarations.length !== 1) {
    throw new Error('meta export must declare only `meta`')
  }

  const declarator = declaration.declarations[0] as AnyNode
  if (declarator.id?.type !== 'Identifier' || declarator.id.name !== 'meta') {
    throw new Error('meta export must declare `meta`')
  }
  if (!declarator.init) throw new Error('meta must have a literal value')

  const meta = evaluateLiteral(declarator.init, 'meta')
  validateMeta(meta)

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  }
}

// ─── AST Evaluation ──────────────────────────────────────────────────

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === 'SpreadElement') throw new Error(`spread not allowed in ${path}`)
        if (prop.type !== 'Property') throw new Error(`only plain properties allowed in ${path}`)
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`)
        if (prop.kind !== 'init' || prop.method)
          throw new Error(`methods/accessors not allowed in ${path}`)
        const key = propertyKey(prop.key as AnyNode, path)
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`)
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`)
      }
      return out
    }
    case 'ArrayExpression':
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`)
        if (element.type === 'SpreadElement') throw new Error(`spread not allowed in ${path}`)
        return evaluateLiteral(element, `${path}[${index}]`)
      })
    case 'Literal':
      return node.value
    case 'TemplateLiteral':
      if (node.expressions.length > 0)
        throw new Error(`template interpolation not allowed in ${path}`)
      return node.quasis
        .map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw)
        .join('')
    case 'UnaryExpression':
      if (
        node.operator === '-' &&
        node.argument?.type === 'Literal' &&
        typeof node.argument.value === 'number'
      ) {
        return -node.argument.value
      }
      throw new Error(`only negative-number unary allowed in ${path}`)
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`)
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value)
  throw new Error(`unsupported key type in ${path}: ${node.type}`)
}

// ─── Determinism Validation ──────────────────────────────────────────

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR)
  }
  for (const child of astChildren(node)) assertDeterministicAst(child)
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode))
    else if (isAstNode(value)) children.push(value)
  }
  return children
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === 'object' && typeof (value as AnyNode).type === 'string'
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === 'CallExpression' && isMemberExpression(node.callee, 'Date', 'now')
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === 'CallExpression' && isMemberExpression(node.callee, 'Math', 'random')
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'Date'
}

function isMemberExpression(
  node: AnyNode | undefined,
  objectName: string,
  propertyName: string,
): boolean {
  if (
    node?.type !== 'MemberExpression' ||
    node.object?.type !== 'Identifier' ||
    node.object.name !== objectName
  ) {
    return false
  }
  return propertyNameOf(node) === propertyName
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name
  return staticStringOf(node.property)
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringOf(node.left)
    const right = staticStringOf(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

// ─── Validation ──────────────────────────────────────────────────────

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== 'object') throw new Error('meta must be an object')
  const value = meta as WorkflowMeta
  if (typeof value.name !== 'string' || !value.name.trim())
    throw new Error('meta.name must be a non-empty string')
  if (typeof value.description !== 'string' || !value.description.trim())
    throw new Error('meta.description must be a non-empty string')
  if (value.whenToUse !== undefined && typeof value.whenToUse !== 'string')
    throw new Error('meta.whenToUse must be a string')
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error('meta.phases must be an array')
    for (let i = 0; i < value.phases.length; i++) {
      const phase = value.phases[i]
      if (!phase || typeof phase !== 'object') {
        throw new Error(
          `meta.phases[${i}] must be an object with a title string, e.g. { title: 'Phase Name' }`,
        )
      }
      if (typeof (phase as WorkflowMetaPhase).title !== 'string' || !(phase as WorkflowMetaPhase).title.trim()) {
        throw new Error(
          `meta.phases[${i}] must have a non-empty title string, e.g. { title: 'Phase Name' }`,
        )
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

function createLimiter(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    active--
    queue.shift()?.()
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, name)
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== 'object') throw new TypeError('agent options must be an object')
  const options = value as AgentOptions
  return {
    ...options,
    label: optionalString(options.label, 'agent label'),
    phase: optionalString(options.phase, 'agent phase'),
    model: optionalString(options.model, 'agent model'),
    isolation: options.isolation,
    agentType: optionalString(options.agentType, 'agent type'),
  }
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    )
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines: string[] = []
  if (phase) lines.push(`Workflow phase: ${phase}`)
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`)
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`)
  if (options.model) lines.push(`Requested model: ${options.model}`)
  return lines.length ? lines.join('\n') : undefined
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / 4)
}

function extractAgentResult(value: unknown): {
  output: unknown
  model?: string
  inputTokens?: number
  outputTokens?: number
  toolCount: number
} {
  if (
    value &&
    typeof value === 'object' &&
    'output' in value &&
    'toolCount' in value
  ) {
    const r = value as WorkflowAgentRunResult
    return {
      output: r.output,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      toolCount: r.toolCount,
    }
  }
  // Fallback for non-WorkflowAgentRunner implementations
  return { output: value, toolCount: 0 }
}
