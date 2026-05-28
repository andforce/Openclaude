import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './GoalCreateTool.js'

export function renderToolUseMessage(input: {
  objective: string
}): React.ReactNode {
  return (
    <Text dimColor>
      creating goal: {input.objective}...
    </Text>
  )
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const color = output.success ? 'green' : 'yellow'
  return (
    <MessageResponse>
      <Text color={color}>{output.message}</Text>
    </MessageResponse>
  )
}
