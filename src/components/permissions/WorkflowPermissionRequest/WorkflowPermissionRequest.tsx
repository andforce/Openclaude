/**
 * WorkflowPermissionRequest — Permission dialog for the WorkflowTool.
 *
 * Shown when the user needs to approve a workflow tool invocation.
 * Follows the same pattern as FallbackPermissionRequest.
 */
import React, { useCallback, useMemo } from 'react'
import { Box, Text, useTheme } from '../../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import { env } from '../../../utils/env.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../../utils/stringUtils.js'
import { logUnaryEvent } from '../../../utils/unaryLogging.js'
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption, type ToolAnalyticsContext } from '../PermissionPrompt.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'

type OptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [theme] = useTheme()

  const userFacingName = toolUseConfirm.tool.userFacingName(
    toolUseConfirm.input as never,
  )

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleSelect = useCallback(
    (value: OptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-dont-ask-again':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [{ toolName: toolUseConfirm.tool.name }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        case 'no':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()

  const options = useMemo((): PermissionPromptOption<OptionValue>[] => {
    const result: PermissionPromptOption<OptionValue>[] = [
      {
        label: 'Yes',
        value: 'yes',
        feedbackConfig: { type: 'accept' },
      },
    ]
    if (showAlwaysAllowOptions) {
      result.push({
        label: `Yes, and don't ask again for ${userFacingName} workflows`,
        value: 'yes-dont-ask-again',
      })
    }
    result.push({
      label: 'No',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })
    return result
  }, [userFacingName, showAlwaysAllowOptions])

  const toolAnalyticsContext = useMemo<ToolAnalyticsContext>(
    () => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  return (
    <PermissionDialog title="Tool use" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {userFacingName}(
          {toolUseConfirm.tool.renderToolUseMessage(
            toolUseConfirm.input as never,
            { theme, verbose: true },
          )})
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}
