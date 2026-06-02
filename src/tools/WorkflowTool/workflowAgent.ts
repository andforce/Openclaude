/**
 * WorkflowAgent — spawns OpenClaude subagents for workflow scripts.
 *
 * Each agent() call in a workflow script creates a fresh subagent via
 * OpenClaude's runAgent() infrastructure, giving it full tool access
 * (read files, run commands, etc.) just like a regular Agent tool call.
 *
 * The subagent runs synchronously (foreground) and returns its final
 * text result, or a structured object if a JSON schema was provided.
 *
 * Ported from pi-dynamic-workflows (MIT) and adapted for OpenClaude.
 */

import type { ToolUseContext } from '../../Tool.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  createStructuredOutputTool,
  type StructuredOutputCapture,
} from './structuredOutput.js'
import type { AgentRunOptions, WorkflowAgentRunner } from './types.js'

export interface WorkflowAgentOptions {
  /** Parent tool use context — provides tools, model, abort controller, etc. */
  toolUseContext: ToolUseContext
  /** CanUseTool function from the parent context */
  canUseTool: any
  /** Parent message for context */
  parentMessage: any
  /** Agent definition to use for subagents (defaults to general-purpose) */
  agentDefinition?: AgentDefinition
}

/** Result from a workflow subagent run, including metrics. */
export interface WorkflowAgentRunResult {
  /** The agent's output text or structured data */
  output: unknown
  /** Model name used by the agent */
  model?: string
  /** Input tokens consumed */
  inputTokens?: number
  /** Output tokens generated */
  outputTokens?: number
  /** Number of tool_use calls in the run */
  toolCount: number
}

/**
 * Creates a WorkflowAgentRunner that spawns OpenClaude subagents.
 */
export function createWorkflowAgent(options: WorkflowAgentOptions): WorkflowAgentRunner {
  const {
    toolUseContext,
    canUseTool,
    parentMessage,
    agentDefinition = GENERAL_PURPOSE_AGENT,
  } = options

  return {
    async run(prompt: string, runOptions: AgentRunOptions = {}): Promise<unknown> {
      // Resolve available tools from the parent context
      let availableTools = toolUseContext.options.tools ?? []

      // ── Structured output support ────────────────────────────────
      let capture: StructuredOutputCapture | undefined
      if (runOptions.schema) {
        capture = { called: false, value: undefined }
        const soTool = createStructuredOutputTool({
          schema: runOptions.schema,
          capture,
        })
        availableTools = [...availableTools, soTool as any]
      }

      // Build the full prompt with optional instructions (matching pi's buildPrompt)
      const parts = [
        runOptions.instructions,
        runOptions.label ? `Task label: ${runOptions.label}` : undefined,
        prompt,
      ].filter(Boolean)
      let fullPrompt = parts.join('\n\n')

      // Add structured output contract instructions when schema is used
      if (runOptions.schema) {
        const contract = [
          'Final output contract:',
          '- Your final action MUST be a structured_output tool call.',
          '- The structured_output arguments are the return value of this subagent.',
          '- Do not emit a prose final answer instead of structured_output.',
          '- If you need to inspect files or run commands first, do so, then call structured_output exactly once.',
        ].join('\n')
        fullPrompt = `${fullPrompt}\n\n${contract}`
      }

      // Create a child abort controller if signal is provided
      let abortController = toolUseContext.abortController
      if (runOptions.signal) {
        abortController = new AbortController()
        runOptions.signal.addEventListener(
          'abort',
          () => abortController.abort(),
          { once: true },
        )
      }

      // Collect the final result from the async generator
      let finalText = ''
      let lastUsage: any = undefined
      let lastModel: string | undefined
      let toolCount = 0

      const agentIterator = runAgent({
        agentDefinition,
        promptMessages: [
          {
            type: 'user' as const,
            uuid: crypto.randomUUID() as any,
            message: {
              role: 'user' as const,
              content: fullPrompt,
            },
            isApiMessage: true,
          } as any,
        ],
        toolUseContext: {
          ...toolUseContext,
          abortController,
        },
        canUseTool,
        isAsync: false,
        canShowPermissionPrompts: false,
        querySource: 'workflow' as any,
        model: (runOptions.model as any) ?? 'sonnet',
        availableTools,
        description: runOptions.label || 'workflow subagent',
      })

      for await (const msg of agentIterator) {
        if (msg.type === 'assistant') {
          const assistantMsg = (msg as any).message
          if (assistantMsg?.model) lastModel = assistantMsg.model
          if (assistantMsg?.usage) lastUsage = assistantMsg.usage

          const content = assistantMsg?.content
          if (Array.isArray(content)) {
            // Count tool_use blocks
            for (const block of content) {
              if (block.type === 'tool_use') toolCount++
            }
            // Extract text
            const textParts = content
              .filter((part: any) => part.type === 'text')
              .map((part: any) => part.text)
            if (textParts.length > 0) {
              finalText = textParts.join('')
            }
          }

          // Terminate immediately: abort any in-flight/follow-up API call
          // so the agent does not consume another LLM round-trip.
          if (capture?.called) {
            abortController.abort()
            break
          }
        }
      }

      const result: WorkflowAgentRunResult = {
        output: finalText,
        model: lastModel,
        inputTokens: lastUsage?.input_tokens ?? undefined,
        outputTokens: lastUsage?.output_tokens ?? undefined,
        toolCount,
      }

      // Handle structured output override
      if (runOptions.schema) {
        if (!capture!.called) {
          throw new Error('Subagent finished without calling structured_output')
        }
        result.output = capture!.value
      }

      return result
    },
  }
}
