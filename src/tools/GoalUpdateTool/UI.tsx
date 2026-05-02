import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './GoalUpdateTool.js'

export function renderToolUseMessage(input: {
  status?: 'achieved' | 'unmet'
}): React.ReactNode {
  const verb = input.status === 'unmet' ? 'unmet' : 'achieved'
  return <Text dimColor>marking goal {verb}…</Text>
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const color =
    output.status === 'achieved'
      ? 'green'
      : output.status === 'unmet'
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
