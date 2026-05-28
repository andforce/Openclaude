import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './GoalUpdateTool.js'

export function renderToolUseMessage(input: {
  status?: 'complete' | 'blocked'
}): React.ReactNode {
  const verb = input.status === 'blocked' ? 'blocked' : 'complete'
  return <Text dimColor>marking goal {verb}...</Text>
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const color =
    output.status === 'complete'
      ? 'green'
      : output.status === 'blocked'
        ? 'yellow'
        : 'gray'
  const label =
    output.status === 'no-active-goal' || output.status === 'stale-goal'
      ? output.message
      : `Goal ${output.status}`
  return (
    <MessageResponse>
      <Text>
        <Text color={color}>{label}</Text>
        {output.reason ? ` · ${output.reason}` : ''}
      </Text>
    </MessageResponse>
  )
}
