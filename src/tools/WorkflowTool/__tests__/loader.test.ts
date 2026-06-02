import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkflowLoader, listWorkflows } from '../loader.js'

// ─── Helpers ───────────────────────────────────────────────────────────

function mkdir(...parts: string[]): string {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8')
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-loader-test-'))
}

const validScript = (name: string) => `export const meta = {
  name: '${name}',
  description: 'A ${name} workflow'
}

phase('Scan')
const result = await agent('scan', { label: 'scan' })
return { ok: true, result }
`

// ─── Tests ─────────────────────────────────────────────────────────────

test('createWorkflowLoader returns undefined for unknown workflow name', async () => {
  const dir = tmpdir()
  const loader = await createWorkflowLoader(dir)
  assert.equal(loader('nonexistent'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader loads a valid workflow script by meta.name', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'my-script.js'), validScript('demo_workflow'))

  const loader = await createWorkflowLoader(dir)

  const script = loader('demo_workflow')
  assert.ok(script)
  assert.match(script!, /export const meta/)
  assert.match(script!, /phase\('Scan'\)/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader loads multiple scripts', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'scan.js'), validScript('scan_workflow'))
  writeFile(path.join(workflowsDir, 'review.js'), validScript('review_workflow'))

  const loader = await createWorkflowLoader(dir)

  assert.ok(loader('scan_workflow'))
  assert.ok(loader('review_workflow'))
  assert.equal(loader('nonexistent'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader skips non-js files', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'notes.md'), '# just notes')
  writeFile(path.join(workflowsDir, 'script.js'), validScript('my_workflow'))

  const loader = await createWorkflowLoader(dir)

  // The .md file should be ignored, only .js should load
  assert.ok(loader('my_workflow'))
  assert.equal(loader('notes'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader skips invalid scripts without crashing', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'bad.js'), 'this is not a valid workflow script')

  const loader = await createWorkflowLoader(dir)

  // Should not throw and should not return anything for the bad script
  assert.equal(loader('bad'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader handles empty workflows directory', async () => {
  const dir = tmpdir()
  mkdir(dir, '.openclaude', 'workflows')

  const loader = await createWorkflowLoader(dir)

  assert.equal(loader('anything'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createWorkflowLoader handles missing workflows directory', async () => {
  const dir = tmpdir()
  // Don't create .openclaude/workflows/ at all

  const loader = await createWorkflowLoader(dir)

  assert.equal(loader('anything'), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ─── listWorkflows Tests ─────────────────────────────────────────────

test('listWorkflows returns entries with name, description, and script', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'scan.js'), validScript('scan_workflow'))
  writeFile(path.join(workflowsDir, 'review.js'), validScript('review_workflow'))

  const entries = await listWorkflows(dir)

  assert.equal(entries.length, 2)
  const names = entries.map(e => e.name).sort()
  assert.deepEqual(names, ['review_workflow', 'scan_workflow'])
  for (const entry of entries) {
    assert.ok(entry.description)
    assert.ok(entry.script.includes('export const meta'))
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('listWorkflows returns empty array for missing directory', async () => {
  const dir = tmpdir()
  const entries = await listWorkflows(dir)
  assert.deepEqual(entries, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('listWorkflows skips invalid scripts without crashing', async () => {
  const dir = tmpdir()
  const workflowsDir = mkdir(dir, '.openclaude', 'workflows')
  writeFile(path.join(workflowsDir, 'bad.js'), 'not a workflow')
  writeFile(path.join(workflowsDir, 'ok.js'), validScript('good'))

  const entries = await listWorkflows(dir)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'good')
  fs.rmSync(dir, { recursive: true, force: true })
})
