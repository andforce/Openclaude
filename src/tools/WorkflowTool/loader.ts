/**
 * Workflow script loader — reads saved workflow scripts from disk.
 *
 * Scans .openclaude/workflows/ directories at both the project and
 * user level. Files with matching names resolve to the project-level
 * version (project takes priority).
 *
 * Used by the WorkflowTool to enable the workflow() sub-call primitive,
 * by /workflow <name> to invoke pre-saved workflow scripts, and by
 * getWorkflowCommands to register saved workflows as slash commands.
 */

import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { parseWorkflowScript } from './workflow.js'

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkflowScriptEntry {
  /** meta.name from the workflow script */
  name: string
  /** meta.description from the workflow script */
  description: string
  /** Raw script content */
  script: string
}

// ─── Internal — directory scanning ───────────────────────────────────

type DirSpec = { path: string; label: string }

async function scanWorkflowDirs(
  cwd: string,
  fs: ReturnType<typeof getFsImplementation>,
): Promise<WorkflowScriptEntry[]> {
  const dirs: DirSpec[] = [
    { path: join(cwd, '.openclaude', 'workflows'), label: 'project' },
    { path: join(getClaudeConfigHomeDir(), 'workflows'), label: 'user' },
  ]

  const seen = new Set<string>()
  const entries: WorkflowScriptEntry[] = []

  for (const { path: dirPath, label } of dirs) {
    let dirEntries: Array<string | { name: string }>
    try {
      dirEntries = await fs.readdir(dirPath)
    } catch {
      continue
    }

    for (const rawEntry of dirEntries) {
      const entryName: string =
        typeof rawEntry === 'string'
          ? rawEntry
          : (rawEntry as { name?: string }).name ?? String(rawEntry)
      if (!entryName.endsWith('.js')) continue

      const filePath = join(dirPath, entryName)
      let content: string
      try {
        content = await fs.readFile(filePath, { encoding: 'utf-8' })
      } catch {
        console.warn(`[workflow/loader] Failed to read ${label} workflow: ${filePath}`)
        continue
      }

      let meta: { name: string; description: string }
      try {
        meta = parseWorkflowScript(content).meta
      } catch (error) {
        console.warn(
          `[workflow/loader] Skipping invalid ${label} workflow ${entryName}: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }

      if (!seen.has(meta.name)) {
        seen.add(meta.name)
        entries.push({ name: meta.name, description: meta.description, script: content })
      }
    }
  }

  return entries
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Creates a workflow script loader that scans .openclaude/workflows/
 * directories at project and user level, then returns a sync lookup
 * function keyed by meta.name.
 *
 * Project-level (<cwd>/.openclaude/workflows/) takes priority over
 * user-level (~/.openclaude/workflows/) when names collide.
 */
export async function createWorkflowLoader(
  cwd: string,
): Promise<(name: string) => string | undefined> {
  const fs = getFsImplementation()
  const scanned = await scanWorkflowDirs(cwd, fs)
  const map = new Map(scanned.map(e => [e.name, e.script]))
  return (name: string) => map.get(name)
}

/**
 * Lists all saved workflow scripts found in .openclaude/workflows/
 * directories. Returns metadata (name + description) plus the raw
 * script content for each discovered workflow.
 */
export async function listWorkflows(
  cwd: string,
): Promise<WorkflowScriptEntry[]> {
  const fs = getFsImplementation()
  return scanWorkflowDirs(cwd, fs)
}
