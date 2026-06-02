/**
 * Bundled workflow definitions.
 *
 * Called at tool-load time (tools.ts) before the WorkflowTool is exported.
 * Pre-registers any built-in workflow definitions so they appear in the
 * model's prompt as available workflow patterns.
 *
 * For now this is a no-op — workflow scripts are generated dynamically
 * by the model. Future work could add pre-built workflow templates here.
 */
export function initBundledWorkflows(): void {
  // No bundled workflow definitions yet.
  // The model generates workflow scripts dynamically.
}
