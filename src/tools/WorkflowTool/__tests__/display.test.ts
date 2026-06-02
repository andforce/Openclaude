import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
} from '../display.js'
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from '../types.js'

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: 'demo_workflow',
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  })
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: 'scan repo',
    phase: 'Scan',
    prompt: 'Scan the repo',
    status: 'done',
    ...overrides,
  }
}

test('createWorkflowSnapshot does not pre-render declared phases', () => {
  const value = createWorkflowSnapshot({
    name: 'demo_workflow',
    description: 'A useful workflow',
    phases: [{ title: 'Scan' }, { title: 'Review' }],
  })

  assert.deepEqual(value.phases, [])
})

test('renderWorkflowLines hides empty phase rows', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan', 'Review'],
      agents: [agent()],
    }),
  )

  assert.ok(lines.some(line => line.includes('Scan 1/1')))
  assert.ok(!lines.some(line => line.includes('Review 0/0')))
})

test('renderWorkflowLines keeps the current empty phase visible', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan'],
      currentPhase: 'Scan',
    }),
  )

  assert.ok(lines.some(line => line.includes('▶ Scan 0/0')))
})

test('renderWorkflowLines groups agents by phase even when the phase was not pre-recorded', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Scan'],
      agents: [agent({ id: 2, label: 'review diff', phase: 'Review' })],
    }),
  )

  assert.ok(lines.some(line => line.includes('Review 1/1')))
  assert.ok(!lines.some(line => line.trim() === 'Unphased'))
})

test('renderWorkflowLines renders runtime-created phases from the phase list', () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ['Inspect API'],
      agents: [agent({ label: 'inspect api', phase: 'Inspect API' })],
    }),
  )

  assert.ok(lines.some(line => line.includes('Inspect API 1/1')))
})

test('renderWorkflowText respects log limits', () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ['first', 'second', 'third'],
    }),
    true,
    { maxLogs: 1 },
  )

  assert.doesNotMatch(text, /log: first/)
  assert.doesNotMatch(text, /log: second/)
  assert.match(text, /log: third/)
})

test('renderWorkflowLines separates logs from progress', () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ['finished scan'],
    }),
  )

  const logIndex = lines.findIndex(line => line.includes('log: finished scan'))
  assert.ok(logIndex > 0)
  assert.equal(lines[logIndex - 1], '')
})

test('renderWorkflowText includes phases panel with numbering', () => {
  const text = renderWorkflowText(
    snapshot({
      phases: ['Scan', 'Review'],
      currentPhase: 'Scan',
      agents: [
        agent({ id: 1, label: 'scan A', phase: 'Scan', status: 'done' }),
        agent({ id: 2, label: 'review B', phase: 'Review', status: 'running' }),
      ],
    }),
    false,
  )

  assert.match(text, /1 Scan/)
  assert.match(text, /2 Review/)
  assert.match(text, /Phases/)
})

test('renderWorkflowText shows per-agent metrics columns', () => {
  const text = renderWorkflowText(
    snapshot({
      phases: ['Build'],
      currentPhase: 'Build',
      agents: [
        agent({
          id: 1,
          label: 'compile',
          phase: 'Build',
          status: 'done',
          model: 'claude-sonnet-4-20250514',
          inputTokens: 1500,
          outputTokens: 500,
          toolCount: 3,
          durationMs: 12345,
        }),
      ],
    }),
    false,
  )

  assert.match(text, /compile/)
  assert.match(text, /claude-sonnet/)
  assert.match(text, /1\.5K/)  // input tokens
  assert.match(text, /500/)   // output tokens
  assert.match(text, /3/)     // tool count
  assert.match(text, /12s/)   // duration
})

test('renderWorkflowText shows overall progress', () => {
  const text = renderWorkflowText(
    snapshot({
      agents: [
        agent({ id: 1, status: 'done' }),
        agent({ id: 2, status: 'done' }),
        agent({ id: 3, status: 'running' }),
      ],
      durationMs: 330000,
    }),
    false,
  )

  assert.match(text, /2\/3 agents/)
  assert.match(text, /5m30s/)
})

test('renderWorkflowText shows active phase agent details', () => {
  const text = renderWorkflowText(
    snapshot({
      phases: ['Scan', 'Build'],
      currentPhase: 'Build',
      agents: [
        agent({ id: 1, label: 'scan', phase: 'Scan', status: 'done' }),
        agent({ id: 2, label: 'build A', phase: 'Build', status: 'running' }),
        agent({ id: 3, label: 'build B', phase: 'Build', status: 'done', toolCount: 5 }),
      ],
    }),
    false,
  )

  assert.match(text, /Build · 2 agents/)
  assert.match(text, /label/)
  assert.match(text, /model/)
  assert.match(text, /tokens/)
  assert.match(text, /tools/)
  assert.match(text, /duration/)
})

test('renderWorkflowText completed workflow header', () => {
  const text = renderWorkflowText(
    snapshot({ agents: [agent()] }),
    true,
  )

  assert.match(text, /^Workflow completed/)
})

test('renderWorkflowText running workflow header', () => {
  const text = renderWorkflowText(
    snapshot({ agents: [agent({ status: 'running' })] }),
    false,
  )

  assert.match(text, /^Workflow running/)
})
