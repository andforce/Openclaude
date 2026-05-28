import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './GoalGetTool.js'

export function renderToolUseMessage(): React.ReactNode {
  return <Text dimColor>getting current goal...</Text>
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (!output.goal) {
    return (
      <MessageResponse>
        <Text dimColor>No active goal.</Text>
      </MessageResponse>
    )
  }
  const g = output.goal
  return (
    <MessageResponse>
      <Text>
        Goal: {g.objective}{'\n'}
        Status: {g.status}{'\n'}
        Elapsed: {g.elapsed_formatted}
        {'\n'}
        Continuations: {g.continuation_count}
      </Text>
    </MessageResponse>
  )
}
