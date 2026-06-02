/**
 * Shared types for the WorkflowTool system.
 *
 * Uses plain JSON Schema objects instead of typebox since OpenClaude
 * uses zod for runtime validation.
 */

// ─── JSON Schema (for structured subagent output) ────────────────────

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  enum?: unknown[]
  const?: unknown
  description?: string
  [key: string]: unknown
}

// ─── Workflow Metadata ───────────────────────────────────────────────

export interface WorkflowMetaPhase {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowMetaPhase[]
}

// ─── Agent Options (inside workflow scripts) ─────────────────────────

export interface AgentOptions {
  label?: string
  phase?: string
  schema?: JsonSchema
  model?: string
  isolation?: 'worktree'
  agentType?: string
}

// ─── Workflow Run Options ────────────────────────────────────────────

export interface WorkflowRunOptions {
  cwd?: string
  args?: unknown
  agent?: WorkflowAgentRunner
  concurrency?: number
  tokenBudget?: number | null
  signal?: AbortSignal
  /** Load a workflow script by name. Required for the workflow() sub-call primitive. */
  workflowLoader?: (name: string) => string | undefined
  /** Nesting depth for inline sub-workflows (0 = top-level). */
  depth?: number
  /** Cumulative agent count from ancestor workflows (for enforcing global MAX_AGENTS_PER_RUN). Internal, set by runSubWorkflow. */
  agentCountOffset?: number
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  onAgentStart?: (event: { label: string; phase?: string; prompt: string; startedAt: number }) => void
  onAgentEnd?: (event: {
    label: string
    phase?: string
    result: unknown
    model?: string
    inputTokens?: number
    outputTokens?: number
    toolCount?: number
    durationMs: number
  }) => void
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta
  result: T
  logs: string[]
  phases: string[]
  agentCount: number
  durationMs: number
}

// ─── Agent Runner Interface ──────────────────────────────────────────

export interface WorkflowAgentRunner {
  run(prompt: string, options?: AgentRunOptions): Promise<unknown>
}

export interface AgentRunOptions {
  label?: string
  schema?: JsonSchema
  signal?: AbortSignal
  instructions?: string
  model?: string
}

// ─── Display Types ───────────────────────────────────────────────────

export type WorkflowAgentStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped'

export interface WorkflowAgentSnapshot {
  id: number
  label: string
  phase?: string
  prompt: string
  status: WorkflowAgentStatus
  resultPreview?: string
  error?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  toolCount?: number
  durationMs?: number
  startedAt?: number
}

export interface WorkflowSnapshot {
  name: string
  description?: string
  phases: string[]
  currentPhase?: string
  logs: string[]
  agents: WorkflowAgentSnapshot[]
  agentCount: number
  runningCount: number
  doneCount: number
  errorCount: number
  durationMs?: number
  result?: unknown
}
