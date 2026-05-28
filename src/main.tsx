// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query) so they run in
//    parallel with the remaining ~135ms of imports below
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API
//    key) in parallel — isRemoteManagedSettingsEligible() otherwise reads them
//    sequentially via sync spawn inside applySafeConfigEnvironmentVariables()
//    (~65ms on every macOS startup)
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch();
import { feature } from 'bun:bundle';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import mapValues from 'lodash-es/mapValues.js';
import pickBy from 'lodash-es/pickBy.js';
import uniqBy from 'lodash-es/uniqBy.js';
import React from 'react';
import { getOauthConfig } from './constants/oauth.js';
import { getRemoteSessionUrl } from './constants/product.js';
import { getSystemContext, getUserContext } from './context.js';
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { addToHistory } from './history.js';
import type { Root } from './ink.js';
import { launchRepl } from './replLauncher.js';
import { hasGrowthBookEnvOverride, initializeGrowthBook, refreshGrowthBookAfterAuthChange } from './services/analytics/growthbook.js';
import { fetchBootstrapData } from './services/api/bootstrap.js';
import { type DownloadResult, downloadSessionFiles, type FilesApiConfig, parseFileSpecs } from './services/api/filesApi.js';
import { prefetchPassesEligibility } from './services/api/referral.js';
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import { isPolicyAllowed, loadPolicyLimits, refreshPolicyLimits, waitForPolicyLimitsToLoad } from './services/policyLimits/index.js';
import { loadRemoteManagedSettings, refreshRemoteManagedSettings } from './services/remoteManagedSettings/index.js';
import type { ToolInputJSONSchema } from './Tool.js';
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from './tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from './utils/advisor.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count, uniq } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import { getSubscriptionType, isClaudeAISubscriber, prefetchAwsCredentialsAndBedRockInfoIfSafe, prefetchGcpCredentialsIfSafe, validateForceLoginOrg } from './utils/auth.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, getRemoteControlAtStartup, isAutoUpdaterDisabled, saveGlobalConfig } from './utils/config.js';
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js';
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js';
import { getInitialFastModeSetting, isFastModeEnabled, prefetchFastModeStatus, resolveFastModeStatusFromCache } from './utils/fastMode.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { createSystemMessage, createUserMessage } from './utils/messages.js';
import { getPlatform } from './utils/platform.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js';
import { settingsChangeDetector } from './utils/settings/changeDetector.js';
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js';
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js';
import { computeInitialTeamContext } from './utils/swarm/reconnection.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js';

// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () => require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () => require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for KAIROS (assistant mode)
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS') ? require('./assistant/index.js') as typeof import('./assistant/index.js') : null;
const kairosGate = feature('KAIROS') ? require('./assistant/gate.js') as typeof import('./assistant/gate.js') : null;
import { relative, resolve } from 'path';
import { isAnalyticsDisabled } from 'src/services/analytics/config.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { getOriginalCwd, setAdditionalDirectoriesForClaudeMd, setIsRemoteMode, setMainLoopModelOverride, setMainThreadAgentType, setTeleportedSessionInfo } from './bootstrap/state.js';
import { filterCommandsForRemoteMode, getCommands } from './commands.js';
import type { StatsStore } from './context/stats.js';
import { launchAssistantInstallWizard, launchAssistantSessionChooser, launchInvalidSettingsDialog, launchResumeChooser, launchSnapshotUpdateDialog, launchTeleportRepoMismatchDialog, launchTeleportResumeWrapper } from './dialogLaunchers.js';
import { SHOW_CURSOR } from './ink/termio/dec.js';
import { exitWithError, exitWithMessage, getRenderContext, renderAndRun, showSetupScreens } from './interactiveHelpers.js';
import { initBuiltinPlugins } from './plugins/bundled/index.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/claudeAiLimits.js';
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js';
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from './services/plugins/pluginCliCommands.js';
import { initBundledSkills } from './skills/bundled/index.js';
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, isCustomAgent, parseAgentsFromJson } from './tools/AgentTool/loadAgentsDir.js';
import type { LogOption } from './types/logs.js';
import type { Message as MessageType } from './types/message.js';
import { assertMinVersion } from './utils/autoUpdater.js';
import { CLAUDE_IN_CHROME_SKILL_HINT, CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER } from './utils/claudeInChrome/prompt.js';
import { setupClaudeInChrome, shouldAutoEnableClaudeInChrome, shouldEnableClaudeInChrome } from './utils/claudeInChrome/setup.js';
import { getContextWindowForModel } from './utils/context.js';
import { loadConversationForResume } from './utils/conversationRecovery.js';
import { buildDeepLinkBanner } from './utils/deepLink/banner.js';
import { hasNodeOption, isBareMode, isEnvTruthy, isInProtectedNamespace } from './utils/envUtils.js';
import { refreshExampleCommands } from './utils/exampleCommands.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getWorktreePaths } from './utils/getWorktreePaths.js';
import { findGitRoot, getBranch, getIsGit, getWorktreeCount } from './utils/git.js';
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js';
import { safeParseJSON } from './utils/json.js';
import { logError } from './utils/log.js';
import { getModelDeprecationWarning } from './utils/model/deprecation.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import { checkAndDisableBypassPermissions, getAutoModeEnabledStateIfCached, initializeToolPermissionContext, initialPermissionModeFromCLI, isDefaultPermissionModeAuto, parseToolListFromCLI, removeDangerousPermissions, stripDangerousPermissionsForAutoMode, verifyAutoModeGateAccess } from './utils/permissions/permissionSetup.js';
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js';
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js';
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js';
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js';
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js';
import { countFilesRoundedRg } from './utils/ripgrep.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import { cacheSessionTitle, getSessionIdFromLog, loadTranscriptFromFile, saveAgentSetting, saveMode, searchSessionsByCustomTitle, sessionIdExists } from './utils/sessionStorage.js';
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js';
import { getInitialSettings, getManagedSettingsKeysForLogging, getSettingsForSource, getSettingsWithErrors } from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID, TASK_STATUSES } from './utils/tasks.js';
import { logPluginLoadErrors, logPluginsEnabledForSession } from './utils/telemetry/pluginTelemetry.js';
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// Plugin startup checks are now handled non-blockingly in REPL.tsx

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js';
import { logPermissionContextForAnts } from 'src/services/internalLogging.js';
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/services/mcp/claudeai.js';
import { clearServerCache } from 'src/services/mcp/client.js';
import { areMcpConfigsAllowedWithEnterpriseMcpConfig, dedupClaudeAiMcpServers, doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getClaudeCodeMcpConfigs, getMcpServerSignature, parseMcpConfig, parseMcpConfigFromFilePath } from 'src/services/mcp/config.js';
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/services/mcp/utils.js';
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { logContextMetrics } from 'src/utils/api.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME, isClaudeInChromeMCPServer } from 'src/utils/claudeInChrome/common.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js';
import { countConcurrentSessions, registerSession, updateSessionName } from 'src/utils/concurrentSessions.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js';
import { errorMessage, getErrnoCode, isENOENT, TeleportOperationError, toError } from 'src/utils/errors.js';
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { peekForStdinData, writeToStderr } from 'src/utils/process.js';
import { setCwd } from 'src/utils/Shell.js';
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js';
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import { type ChannelEntry, getInitialMainLoopModel, getIsNonInteractiveSession, getSdkBetas, getSessionId, getUserMsgOptIn, setAllowedChannels, setAllowedSettingSources, setChromeFlagOverride, setClientType, setCwdState, setDirectConnectServerUrl, setFlagSettingsPath, setInitialMainLoopModel, setInlinePlugins, setIsInteractive, setKairosActive, setOriginalCwd, setQuestionPreviewFormat, setSdkBetas, setSessionBypassPermissionsMode, setSessionPersistenceDisabled, setSessionSource, setUserMsgOptIn, switchSession } from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

// TeleportRepoMismatchDialog, TeleportResumeWrapper dynamically imported at call sites
import { migrateAutoUpdatesToSettings } from './migrations/migrateAutoUpdatesToSettings.js';
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateFennecToOpus } from './migrations/migrateFennecToOpus.js';
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js';
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js';
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js';
import { migrateSonnet45ToSonnet46 } from './migrations/migrateSonnet45ToSonnet46.js';
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js';
import { resetProToOpusDefault } from './migrations/resetProToOpusDefault.js';
import { createRemoteSessionConfig } from './remote/RemoteSessionManager.js';
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress dynamically imported at call site
import { createDirectConnectSession, DirectConnectError } from './server/createDirectConnectSession.js';
import { initializeLspServerManager } from './services/lsp/manager.js';
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js';
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE, setCurrentAppStateStore } from './state/AppStateStore.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { createStore } from './state/store.js';
import { asSessionId } from './types/ids.js';
import { filterAllowedSdkBetas } from './utils/betas.js';
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js';
import { logForDiagnosticsNoPII } from './utils/diagLogs.js';
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js';
import { clearPluginCache, loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js';
import { migrateChangelogFromConfig } from './utils/releaseNotes.js';
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js';
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js';
import { checkOutTeleportedSessionBranch, processMessagesForTeleportResume, teleportToRemoteWithErrorHandling, validateGitState, validateSessionRepository } from './utils/teleport.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js';
import { initUser, resetUserCache } from './utils/user.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

/**
 * Log managed settings keys to Statsig for analytics.
 * This is called after init() completes to ensure settings are loaded
 * and environment variables are applied before model resolution.
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings');
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings);
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(',') as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
  } catch {
    // Silently ignore errors - this is just for analytics
  }
}

// Check if running in debug/inspection mode
function isBeingDebugged() {
  const isBun = isRunningWithBun();

  // Check for inspect flags in process arguments (including all variants)
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // Note: Bun has an issue with single-file executables where application arguments
      // from process.argv leak into process.execArgv (similar to https://github.com/oven-sh/bun/issues/11673)
      // This breaks use of --debug mode if we omit this branch
      // We're fine to skip that check, because Bun doesn't support Node.js legacy --debug or --debug-brk flags
      return /--inspect(-brk)?/.test(arg);
    } else {
      // In Node.js, check for both --inspect and legacy --debug flags
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });

  // Check if NODE_OPTIONS contains inspect flags
  const hasInspectEnv = process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);

  // Check if inspector is available and active (indicates debugging)
  try {
    // Dynamic import would be better but is async - use global object instead
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    // Ignore error and fall back to argument detection
    return hasInspectArg || hasInspectEnv;
  }
}

// Exit if we detect node debugging or inspection
if ("external" !== 'ant' && isBeingDebugged()) {
  // Use process.exit directly here since we're in the top-level code before imports
  // and gracefulShutdown is not yet available
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1);
}

/**
 * Per-session skill/plugin telemetry. Called from both the interactive path
 * and the headless -p path (before runHeadless) — both go through
 * main.tsx but branch before the interactive startup path, so it needs two
 * call sites here rather than one here + one in QueryEngine.
 */
function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(getInitialMainLoopModel() ?? getDefaultMainLoopModel());
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()));
  void loadAllPluginsCacheOnly().then(({
    enabled,
    errors
  }) => {
    const managedNames = getManagedPluginNames();
    logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs());
    logPluginLoadErrors(errors, managedNames);
  }).catch(err => logError(err));
}
function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true;
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true;
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true;
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true;
  }
  return result;
}
async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return;
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([getIsGit(), getWorktreeCount(), getGhAuthStatus()]);
  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry()
  });
}

// @[MODEL LAUNCH]: Consider any migrations you may need for model strings. See migrateSonnet1mToSonnet45.ts for an example.
// Bump this when adding a new sync migration so existing users re-run the set.
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    if ("external" === 'ant') {
      migrateFennecToOpus();
    }
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
  // Async migration - fire and forget since it's non-blocking
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}

/**
 * Prefetch system context (including git status) only when it's safe to do so.
 * Git commands can execute arbitrary code via hooks and config (e.g., core.fsmonitor,
 * diff.external), so we must only run them after trust is established or in
 * non-interactive mode where trust is implicit.
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // In non-interactive mode (--print), trust dialog is skipped and
  // execution is considered trusted (as documented in help text)
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // In interactive mode, only prefetch if trust has already been established
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // Otherwise, don't prefetch - wait for trust to be established first
}

/**
 * Start background prefetches and housekeeping that are NOT needed before first render.
 * These are deferred from setup() to reduce event loop contention and child process
 * spawning during the critical startup path.
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // This function runs after first render, so it doesn't block the initial paint.
  // However, the spawned processes and async work still contend for CPU and event
  // loop time, which skews startup benchmarks (CPU profiles, time-to-first-render
  // measurements). Skip all of it when we're only measuring startup performance.
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
  // --bare: skip ALL prefetches. These are cache-warms for the REPL's
  // first-turn responsiveness (initUser, getUserContext, tips, countFiles,
  // modelCapabilities, change detectors). Scripted -p calls don't have a
  // "user is typing" window to hide this work in — it's pure overhead on
  // the critical path.
  isBareMode()) {
    return;
  }

  // Process-spawning prefetches (consumed at first API call, user is still typing)
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  void prefetchOfficialMcpUrls();
  void refreshModelCapabilities();

  // File change detectors deferred from init() to unblock first render
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

  // Event loop stall detector — logs when the main thread is blocked >500ms
  if ("external" === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}
function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim();
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}');
    let settingsPath: string;
    if (looksLikeJson) {
      // It's a JSON string - validate and create temp file
      const parsedJson = safeParseJSON(trimmedSettings);
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'));
        process.exit(1);
      }

      // Create a temporary file and write the JSON to it.
      // Use a content-hash-based path instead of random UUID to avoid
      // busting the Anthropic API prompt cache. The settings path ends up
      // in the Bash tool's sandbox denyWithinAllow list, which is part of
      // the tool description sent to the API. A random UUID per subprocess
      // changes the tool description on every query() call, invalidating
      // the cache prefix and causing a 12x input token cost penalty.
      // The content hash ensures identical settings produce the same path
      // across process boundaries (each SDK query() spawns a new process).
      settingsPath = generateTempFilePath('openclaude-settings', '.json', {
        contentHash: trimmedSettings
      });
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8');
    } else {
      // It's a file path - resolve and validate by attempting to read
      const {
        resolvedPath: resolvedSettingsPath
      } = safeResolvePath(getFsImplementation(), settingsFile);
      try {
        readFileSync(resolvedSettingsPath, 'utf8');
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`));
          process.exit(1);
        }
        throw e;
      }
      settingsPath = resolvedSettingsPath;
    }
    setFlagSettingsPath(settingsPath);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}
function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg);
    setAllowedSettingSources(sources);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}

/**
 * Parse and load settings flags early, before init()
 * This ensures settings are filtered from the start of initialization
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // Parse --settings flag early to ensure settings are loaded before init()
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // Parse --setting-sources flag early to control which sources are loaded
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}
function initializeEntrypoint(isNonInteractive: boolean): void {
  // Skip if already set (e.g., by SDK or other entrypoints)
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return;
  }
  const cliArgs = process.argv.slice(2);

  // Check for MCP serve command (handle flags before mcp serve, e.g., --debug mcp serve)
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp';
    return;
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action';
    return;
  }

  // Note: 'local-agent' entrypoint is set by the local agent mode launcher
  // via CLAUDE_CODE_ENTRYPOINT env var (handled by early return above)

  // Set based on interactive status
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}

// Set by early argv processing when `claude open <url>` is detected (interactive mode only)
type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT') ? {
  url: undefined,
  authToken: undefined,
  dangerouslySkipPermissions: false
} : undefined;

// Set by early argv processing when `claude assistant [sessionId]` is detected
type PendingAssistantChat = {
  sessionId?: string;
  discover: boolean;
};
const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS') ? {
  sessionId: undefined,
  discover: false
} : undefined;

// `claude ssh <host> [dir]` — parsed from argv early (same pattern as
// DIRECT_CONNECT above) so the main command path can pick it up and hand
// the REPL an SSH-backed session instead of a local one.
type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean;
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[];
};
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE') ? {
  host: undefined,
  cwd: undefined,
  permissionMode: undefined,
  dangerouslySkipPermissions: false,
  local: false,
  extraCliArgs: []
} : undefined;
export async function main() {
  profileCheckpoint('main_function_start');

  // SECURITY: Prevent Windows from executing commands from current directory
  // This must be set before ANY command execution to prevent PATH hijacking attacks
  // See: https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // Initialize warning handler early to catch warnings
  initializeWarningHandler();
  process.on('exit', () => {
    resetCursor();
  });
  process.on('SIGINT', () => {
    // In print mode, print.ts registers its own SIGINT handler that aborts
    // the in-flight query and calls gracefulShutdown; skip here to avoid
    // preempting it with a synchronous process.exit().
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
  profileCheckpoint('main_warning_handler_initialized');

  // Check for cc:// or cc+unix:// URL in argv — rewrite so the main command
  // handles it, giving the full interactive TUI instead of a stripped-down subcommand.
  // For headless (-p), we rewrite to the internal `open` subcommand.
  if (feature('DIRECT_CONNECT')) {
    const rawCliArgs = process.argv.slice(2);
    const ccIdx = rawCliArgs.findIndex(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
    if (ccIdx !== -1 && _pendingConnect) {
      const ccUrl = rawCliArgs[ccIdx]!;
      const {
        parseConnectUrl
      } = await import('./server/parseConnectUrl.js');
      const parsed = parseConnectUrl(ccUrl);
      _pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes('--dangerously-skip-permissions');
      if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
        // Headless: rewrite to internal `open` subcommand
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped];
      } else {
        // Interactive: strip cc:// URL and flags, run main command
        _pendingConnect.url = parsed.serverUrl;
        _pendingConnect.authToken = parsed.authToken;
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, ...stripped];
      }
    }
  }

  // Handle deep link URIs early — this is invoked by the OS protocol handler
  // and should bail out before full init since it only needs to parse the URI
  // and open a terminal.
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri');
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const uri = process.argv[handleUriIdx + 1]!;
      const {
        handleDeepLinkUri
      } = await import('./utils/deepLink/protocolHandler.js');
      const exitCode = await handleDeepLinkUri(uri);
      process.exit(exitCode);
    }

    // macOS URL handler: when LaunchServices launches our .app bundle, the
    // URL arrives via Apple Event (not argv). LaunchServices overwrites
    // __CFBundleIdentifier to the launching bundle's ID, which is a precise
    // positive signal — cheaper than importing and guessing with heuristics.
    if (process.platform === 'darwin' && process.env.__CFBundleIdentifier === 'com.anthropic.claude-code-url-handler') {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const {
        handleUrlSchemeLaunch
      } = await import('./utils/deepLink/protocolHandler.js');
      const urlSchemeResult = await handleUrlSchemeLaunch();
      process.exit(urlSchemeResult ?? 1);
    }
  }

  // `claude assistant [sessionId]` — stash and strip so the main
  // command handles it, giving the full interactive TUI. Position-0 only
  // (matching the ssh pattern below) — indexOf would false-positive on
  // `claude -p "explain assistant"`. Root-flag-before-subcommand
  // (e.g. `--debug assistant`) falls through to the stub, which
  // prints usage.
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1];
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg;
        rawArgs.splice(0, 2); // drop 'assistant' and sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true;
        rawArgs.splice(0, 1); // drop 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      }
      // else: `claude assistant --help` → fall through to stub
    }
  }

  // `claude ssh <host> [dir]` — strip from argv so the main command handler
  // runs (full interactive TUI), stash the host/dir for the REPL branch at
  // ~line 3720 to pick up. Headless (-p) mode not supported in v1: SSH
  // sessions need the local REPL to drive them (interrupt, permissions).
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2);
    // SSH-specific flags can appear before the host positional (e.g.
    // `ssh --permission-mode auto host /tmp` — standard POSIX flags-before-
    // positionals). Pull them all out BEFORE checking whether a host was
    // given, so `claude ssh --permission-mode auto host` and `claude ssh host
    // --permission-mode auto` are equivalent. The host check below only needs
    // to guard against `-h`/`--help` (which commander should handle).
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local');
      if (localIdx !== -1) {
        _pendingSSH.local = true;
        rawCliArgs.splice(localIdx, 1);
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions');
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true;
        rawCliArgs.splice(dspIdx, 1);
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode');
      if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1];
        rawCliArgs.splice(pmIdx, 2);
      }
      const pmEqIdx = rawCliArgs.findIndex(a => a.startsWith('--permission-mode='));
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1];
        rawCliArgs.splice(pmEqIdx, 1);
      }
      // Forward session-resume + model flags to the remote CLI's initial spawn.
      // --continue/-c and --resume <uuid> operate on the REMOTE session history
      // (which persists under the remote's ~/.openclaude/projects/<cwd>/).
      // --model controls which model the remote uses.
      const extractFlag = (flag: string, opts: {
        hasValue?: boolean;
        as?: string;
      } = {}) => {
        const i = rawCliArgs.indexOf(flag);
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag);
          const val = rawCliArgs[i + 1];
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val);
            rawCliArgs.splice(i, 2);
          } else {
            rawCliArgs.splice(i, 1);
          }
        }
        const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`));
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1));
          rawCliArgs.splice(eqI, 1);
        }
      };
      extractFlag('-c', {
        as: '--continue'
      });
      extractFlag('--continue');
      extractFlag('--resume', {
        hasValue: true
      });
      extractFlag('--model', {
        hasValue: true
      });
    }
    // After pre-extraction, any remaining dash-arg at [1] is either -h/--help
    // (commander handles) or an unknown-to-ssh flag (fall through to commander
    // so it surfaces a proper error). Only a non-dash arg is the host.
    if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
      _pendingSSH.host = rawCliArgs[1];
      // Optional positional cwd.
      let consumed = 2;
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2];
        consumed = 3;
      }
      const rest = rawCliArgs.slice(consumed);

      // Headless (-p) mode is not supported with SSH in v1 — reject early
      // so the flag doesn't silently cause local execution.
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write('Error: headless (-p/--print) mode is not supported with openclaude ssh\n');
        gracefulShutdownSync(1);
        return;
      }

      // Rewrite argv so the main command sees remaining flags but not `ssh`.
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    }
  }

  // Check for -p/--print and --init-only flags early to set isInteractiveSession before init()
  // This is needed because telemetry initialization calls auth functions that need this flag
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;

  // Stop capturing early input for non-interactive modes
  if (isNonInteractive) {
    stopCapturingEarlyInput();
  }

  // Set simplified tracking fields
  const isInteractive = !isNonInteractive;
  setIsInteractive(isInteractive);

  // Initialize entrypoint based on mode - needs to be set before any event is logged
  initializeEntrypoint(isNonInteractive);

  // Determine client type
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop';

    // Check if session-ingress token is provided (indicates remote session)
    const hasSessionIngressToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN || process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote';
    }
    return 'cli';
  })();
  setClientType(clientType);
  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat);
  } else if (!clientType.startsWith('sdk-') &&
  // Desktop and CCR pass previewFormat via toolConfig; when the feature is
  // gated off they pass undefined — don't override that with markdown.
  clientType !== 'claude-desktop' && clientType !== 'local-agent' && clientType !== 'remote') {
    setQuestionPreviewFormat('markdown');
  }

  // Tag sessions created via `claude remote-control` so the backend can identify them
  if (process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control');
  }
  profileCheckpoint('main_client_type_determined');

  // Parse and load settings flags early, before init()
  eagerLoadSettings();
  profileCheckpoint('main_before_run');
  await run();
  profileCheckpoint('main_after_run');
}
async function getInputPrompt(prompt: string, inputFormat: 'text' | 'stream-json'): Promise<string | AsyncIterable<string>> {
  if (!process.stdin.isTTY &&
  // Input hijacking breaks MCP.
  !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      return process.stdin;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    const onData = (chunk: string) => {
      data += chunk;
    };
    process.stdin.on('data', onData);
    // If no data arrives in 3s, stop waiting and warn. Stdin is likely an
    // inherited pipe from a parent that isn't writing (subprocess spawned
    // without explicit stdin handling). 3s covers slow producers like curl,
    // jq on large files, python with import overhead. The warning makes
    // silent data loss visible for the rare producer that's slower still.
    const timedOut = await peekForStdinData(process.stdin, 3000);
    process.stdin.off('data', onData);
    if (timedOut) {
      process.stderr.write('Warning: no stdin data received in 3s, proceeding without it. ' + 'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n');
    }
    return [prompt, data].filter(Boolean).join('\n');
  }
  return prompt;
}
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // Create help config that sorts options by long option name.
  // Commander supports compareOptions at runtime but @commander-js/extra-typings
  // doesn't include it in the type definitions, so we use Object.assign to add it.
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({
      sortSubcommands: true,
      sortOptions: true
    } as const, {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b))
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // Use preAction hook to run initialization only when executing a command,
  // not when displaying help. This avoids the need for env variable signaling.
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    // Await async subprocess loads started at module evaluation (lines 12-20).
    // Nearly free — subprocesses complete during the ~135ms of imports above.
    // Must resolve before init() which triggers the first settings read
    // (applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → sync keychain reads otherwise ~65ms).
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    profileCheckpoint('preAction_after_mdm');
    await init();
    profileCheckpoint('preAction_after_init');

    // process.title on Windows sets the console title directly; on POSIX,
    // terminal shell integration may mirror the process name to the tab.
    // After init() so settings.json env can also gate this (gh-4765).
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude';
    }

    // Attach logging sinks so subcommand handlers can use logEvent/logError.
    // Before PR #11106 logEvent dispatched directly; after, events queue until
    // a sink attaches. setup() attaches sinks for the default command, but
    // subcommands (doctor, mcp, plugin, auth) never call setup() and would
    // silently drop events on process.exit(). Both inits are idempotent.
    const {
      initSinks
    } = await import('./utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508: --plugin-dir is a top-level program option. The default
    // action reads it from its own options destructure, but subcommands
    // (plugin list, plugin install, mcp *) have their own actions and
    // never see it. Wire it up here so getInlinePlugins() works everywhere.
    // thisCommand.opts() is typed {} here because this hook is attached
    // before .option('--plugin-dir', ...) in the chain — extra-typings
    // builds the type as options are added. Narrow with a runtime guard;
    // the collect accumulator + [] default guarantee string[] in practice.
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // Load remote managed settings for enterprise customers (non-blocking)
    // Fails open - if fetch fails, continues without remote settings
    // Settings are applied via hot-reload when they arrive
    // Must happen after init() to ensure config reading is allowed
    void loadRemoteManagedSettings();
    void loadPolicyLimits();
    profileCheckpoint('preAction_after_remote_settings');

    // Load settings sync (non-blocking, fail-open)
    // CLI: uploads local settings to remote (CCR download is handled by print.ts)
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
    }
    profileCheckpoint('preAction_after_settings_sync');
  });
  program.name('openclaude').description(`OpenClaude - starts an interactive session by default, use -p/--print for non-interactive output`).argument('[prompt]', 'Your prompt', String)
  // Subcommands inherit helpOption via commander's copyInheritedSettings —
  // setting it once here covers mcp, plugin, auth, and all other subcommands.
  .helpOption('-h, --help', 'Display help for command').option('-d, --debug [filter]', 'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")', (_value: string | true) => {
    // If value is provided, it will be the filter string
    // If not provided but flag is present, value will be true
    // The actual filtering is handled in debug.ts by parsing process.argv
    return true;
  }).addOption(new Option('--debug-to-stderr', 'Enable debug mode (to stderr)').argParser(Boolean).hideHelp()).option('--debug-file <path>', 'Write debug logs to a specific file path (implicitly enables debug mode)', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).option('-p, --print', 'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when OpenClaude is run with the -p mode. Only use this flag in directories you trust.', () => true).option('--bare', 'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.', () => true).addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp()).addOption(new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp()).addOption(new Option('--maintenance', 'Run Setup hooks with maintenance trigger, then continue').hideHelp()).addOption(new Option('--output-format <format>', 'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)').choices(['text', 'json', 'stream-json'])).addOption(new Option('--json-schema <schema>', 'JSON Schema for structured output validation. ' + 'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String)).option('--include-hook-events', 'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)', () => true).option('--include-partial-messages', 'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)', () => true).addOption(new Option('--input-format <format>', 'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)').choices(['text', 'stream-json'])).option('--mcp-debug', '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)', () => true).option('--dangerously-skip-permissions', 'Bypass all permission checks. Recommended only for sandboxes with no internet access.', () => true).option('--allow-dangerously-skip-permissions', 'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.', () => true).addOption(new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled').choices(['enabled', 'adaptive', 'disabled']).hideHelp()).addOption(new Option('--max-thinking-tokens <tokens>', '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-turns <turns>', 'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-budget-usd <amount>', 'Maximum dollar amount to spend on API calls (only works with --print)').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd must be a positive number greater than 0');
    }
    return amount;
  })).addOption(new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget must be a positive integer');
    }
    return tokens;
  }).hideHelp()).option('--replay-user-messages', 'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)', () => true).addOption(new Option('--enable-auth-status', 'Enable auth status messages in SDK mode').default(false).hideHelp()).option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")').option('--tools <tools...>', 'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").').option('--disallowedTools, --disallowed-tools <tools...>', 'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")').option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings (space-separated)').addOption(new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts (only works with --print)').argParser(String).hideHelp()).addOption(new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(String)).addOption(new Option('--system-prompt-file <file>', 'Read system prompt from a file').argParser(String).hideHelp()).addOption(new Option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt').argParser(String)).addOption(new Option('--append-system-prompt-file <file>', 'Read system prompt from a file and append to the default system prompt').argParser(String).hideHelp()).addOption(new Option('--permission-mode <mode>', 'Permission mode to use for the session').argParser(String).choices(PERMISSION_MODES)).option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true).option('-r, --resume [value]', 'Resume a conversation by session ID, or open interactive picker with optional search term', value => value || true).option('--fork-session', 'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)', () => true).addOption(new Option('--prefill <text>', 'Pre-fill the prompt input with text without submitting it').hideHelp()).addOption(new Option('--deep-link-origin', 'Signal that this session was launched from a deep link').hideHelp()).addOption(new Option('--deep-link-repo <slug>', 'Repo slug the deep link ?repo= parameter resolved to the current cwd').hideHelp()).addOption(new Option('--deep-link-last-fetch <ms>', 'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline').argParser(v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }).hideHelp()).option('--from-pr [value]', 'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term', value => value || true).option('--no-session-persistence', 'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)').addOption(new Option('--resume-session-at <message id>', 'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)').argParser(String).hideHelp()).addOption(new Option('--rewind-files <user-message-id>', 'Restore files to state at the specified user message and exit (requires --resume)').hideHelp())
  // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
  .option('--model <model>', `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').`).addOption(new Option('--effort <level>', `Effort level for the current session (low, medium, high, max)`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
    }
    return value;
  })).option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`).option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)').option('--fallback-model <model>', 'Enable automatic fallback to specified model when default model is overloaded (only works with --print)').addOption(new Option('--workload <tag>', 'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)').hideHelp()).option('--settings <file-or-json>', 'Path to a settings JSON file or a JSON string to load additional settings from').option('--add-dir <directories...>', 'Additional directories to allow tool access to').option('--ide', 'Automatically connect to IDE on startup if exactly one valid IDE is available', () => true).option('--strict-mcp-config', 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations', () => true).option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)').option('-n, --name <name>', 'Set a display name for this session (shown in /resume and terminal title)').option('--agents <json>', 'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
  // gh-33508: <paths...> (variadic) consumed everything until the next
  // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
  // `mcp` and `add` as paths, then choked on --transport as an unknown
  // top-level option. Single-value + collect accumulator means each
  // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
  .option('--plugin-dir <path>', 'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)', (val: string, prev: string[]) => [...prev, val], [] as string[]).option('--disable-slash-commands', 'Disable all skills', () => true).option('--chrome', 'Enable Claude in Chrome integration').option('--no-chrome', 'Disable Claude in Chrome integration').option('--file <specs...>', 'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)').action(async (prompt, options) => {
    profileCheckpoint('action_handler_start');

    // --bare = one-switch minimal mode. Sets SIMPLE so all the existing
    // gates fire (CLAUDE.md, skills, hooks inside executeHooks, agent
    // dir-walk). Must be set before setup() / any of the gated work runs.
    if ((options as {
      bare?: boolean;
    }).bare) {
      process.env.CLAUDE_CODE_SIMPLE = '1';
    }

    // Ignore "code" as a prompt - treat it the same as no prompt
    if (prompt === 'code') {
      logEvent('tengu_code_prompt_ignored', {});
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(chalk.yellow('Tip: You can launch OpenClaude with just `openclaude`'));
      prompt = undefined;
    }

    // Log event for any single-word prompt
    if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
      logEvent('tengu_single_word_prompt', {
        length: prompt.length
      });
    }

    // Assistant mode: when .claude/settings.json has assistant: true AND
    // the tengu_kairos GrowthBook gate is on, force brief on. Permission
    // mode is left to the user — settings defaultMode or --permission-mode
    // apply as normal. REPL-typed messages already default to 'next'
    // priority (messageQueueManager.enqueue) so they drain mid-turn between
    // tool calls. SendUserMessage (BriefTool) is enabled via the brief env
    // var. SleepTool stays disabled (its isEnabled() gates on proactive).
    // kairosEnabled is computed once here and reused at the
    // getAssistantSystemPromptAddendum() call site further down.
    //
    // Trust gate: .claude/settings.json is attacker-controllable in an
    // untrusted clone. We run ~1000 lines before showSetupScreens() shows
    // the trust dialog, and by then we've already appended
    // .claude/agents/assistant.md to the system prompt. Refuse to activate
    // until the directory has been explicitly trusted.
    let kairosEnabled = false;
    let assistantTeamContext: Awaited<ReturnType<NonNullable<typeof assistantModule>['initializeAssistantTeam']>> | undefined;
    if (feature('KAIROS') && (options as {
      assistant?: boolean;
    }).assistant && assistantModule) {
      // --assistant (Agent SDK daemon mode): force the latch before
      // isAssistantMode() runs below. The daemon has already checked
      // entitlement — don't make the child re-check tengu_kairos.
      assistantModule.markAssistantForced();
    }
    if (feature('KAIROS') && assistantModule?.isAssistantMode() &&
    // Spawned teammates share the leader's cwd + settings.json, so
    // isAssistantMode() is true for them too. --agent-id being set
    // means we ARE a spawned teammate (extractTeammateOptions runs
    // ~170 lines later so check the raw commander option) — don't
    // re-init the team or override teammateMode/proactive/brief.
    !(options as {
      agentId?: unknown;
    }).agentId && kairosGate) {
      if (!checkHasTrustDialogAccepted()) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.warn(chalk.yellow('Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.'));
      } else {
        // Blocking gate check — returns cached `true` instantly; if disk
        // cache is false/missing, lazily inits GrowthBook and fetches fresh
        // (max ~5s). --assistant skips the gate entirely (daemon is
        // pre-entitled).
        kairosEnabled = assistantModule.isAssistantForced() || (await kairosGate.isKairosEnabled());
        if (kairosEnabled) {
          const opts = options as {
            brief?: boolean;
          };
          opts.brief = true;
          setKairosActive(true);
          // Pre-seed an in-process team so Agent(name: "foo") spawns
          // teammates without TeamCreate. Must run BEFORE setup() captures
          // the teammateMode snapshot (initializeAssistantTeam calls
          // setCliTeammateModeOverride internally).
          assistantTeamContext = await assistantModule.initializeAssistantTeam();
        }
      }
    }
    const {
      debug = false,
      debugToStderr = false,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions = false,
      tools: baseTools = [],
      allowedTools = [],
      disallowedTools = [],
      mcpConfig = [],
      permissionMode: permissionModeCli,
      addDir = [],
      fallbackModel,
      betas = [],
      ide = false,
      sessionId,
      includeHookEvents,
      includePartialMessages
    } = options;
    if (options.prefill) {
      seedEarlyInput(options.prefill);
    }

    // Promise for file downloads - started early, awaited before REPL renders
    let fileDownloadPromise: Promise<DownloadResult[]> | undefined;
    const agentsJson = options.agents;
    const agentCli = options.agent;
    if (feature('BG_SESSIONS') && agentCli) {
      process.env.CLAUDE_CODE_AGENT = agentCli;
    }

    // NOTE: LSP manager initialization is intentionally deferred until after
    // the trust dialog is accepted. This prevents plugin LSP servers from
    // executing code in untrusted directories before user consent.

    // Extract these separately so they can be modified if needed
    let outputFormat = options.outputFormat;
    let inputFormat = options.inputFormat;
    let verbose = options.verbose ?? getGlobalConfig().verbose;
    let print = options.print;
    const init = options.init ?? false;
    const initOnly = options.initOnly ?? false;
    const maintenance = options.maintenance ?? false;

    // Extract disable slash commands flag
    const disableSlashCommands = options.disableSlashCommands || false;

    // Extract tasks mode options (ant-only)
    const tasksOption = "external" === 'ant' && (options as {
      tasks?: boolean | string;
    }).tasks;
    const taskListId = tasksOption ? typeof tasksOption === 'string' ? tasksOption : DEFAULT_TASKS_MODE_TASK_LIST_ID : undefined;
    if ("external" === 'ant' && taskListId) {
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
    }

    // Extract worktree option
    // worktree can be true (flag without value) or a string (custom name or PR reference)
    const worktreeOption = isWorktreeModeEnabled() ? (options as {
      worktree?: boolean | string;
    }).worktree : undefined;
    let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined;
    const worktreeEnabled = worktreeOption !== undefined;

    // Check if worktree name is a PR reference (#N or GitHub PR URL)
    let worktreePRNumber: number | undefined;
    if (worktreeName) {
      const prNum = parsePRReference(worktreeName);
      if (prNum !== null) {
        worktreePRNumber = prNum;
        worktreeName = undefined; // slug will be generated in setup()
      }
    }

    // Extract tmux option (requires --worktree)
    const tmuxEnabled = isWorktreeModeEnabled() && (options as {
      tmux?: boolean;
    }).tmux === true;

    // Validate tmux option
    if (tmuxEnabled) {
      if (!worktreeEnabled) {
        process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'));
        process.exit(1);
      }
      if (getPlatform() === 'windows') {
        process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'));
        process.exit(1);
      }
      if (!(await isTmuxAvailable())) {
        process.stderr.write(chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`));
        process.exit(1);
      }
    }

    // Extract teammate options (for tmux-spawned agents)
    // Declared outside the if block so it's accessible later for system prompt addendum
    let storedTeammateOpts: TeammateOptions | undefined;
    if (isAgentSwarmsEnabled()) {
      // Extract agent identity options (for tmux-spawned agents)
      // These replace the CLAUDE_CODE_* environment variables
      const teammateOpts = extractTeammateOptions(options);
      storedTeammateOpts = teammateOpts;

      // If any teammate identity option is provided, all three required ones must be present
      const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
      const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;
      if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
        process.stderr.write(chalk.red('Error: --agent-id, --agent-name, and --team-name must all be provided together\n'));
        process.exit(1);
      }

      // If teammate identity is provided via CLI, set up dynamicTeamContext
      if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
        getTeammateUtils().setDynamicTeamContext?.({
          agentId: teammateOpts.agentId,
          agentName: teammateOpts.agentName,
          teamName: teammateOpts.teamName,
          color: teammateOpts.agentColor,
          planModeRequired: teammateOpts.planModeRequired ?? false,
          parentSessionId: teammateOpts.parentSessionId
        });
      }

      // Set teammate mode CLI override if provided
      // This must be done before setup() captures the snapshot
      if (teammateOpts.teammateMode) {
        getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
      }
    }

    // Extract remote sdk options
    const sdkUrl = (options as {
      sdkUrl?: string;
    }).sdkUrl ?? undefined;

    // Allow env var to enable partial messages (used by sandbox gateway for baku)
    const effectiveIncludePartialMessages = includePartialMessages || isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES);

    // Enable all hook event types when explicitly requested via SDK option
    // or when running in CLAUDE_CODE_REMOTE mode (CCR needs them).
    // Without this, only SessionStart and Setup events are emitted.
    if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      setAllHookEventsEnabled(true);
    }

    // Auto-set input/output formats, verbose mode, and print mode when SDK URL is provided
    if (sdkUrl) {
      // If SDK URL is provided, automatically use stream-json formats unless explicitly set
      if (!inputFormat) {
        inputFormat = 'stream-json';
      }
      if (!outputFormat) {
        outputFormat = 'stream-json';
      }
      // Auto-enable verbose mode unless explicitly disabled or already set
      if (options.verbose === undefined) {
        verbose = true;
      }
      // Auto-enable print mode unless explicitly disabled
      if (!options.print) {
        print = true;
      }
    }

    // Extract teleport option
    const teleport = (options as {
      teleport?: string | true;
    }).teleport ?? null;

    // Extract remote option (can be true if no description provided, or a string)
    const remoteOption = (options as {
      remote?: string | true;
    }).remote;
    const remote = remoteOption === true ? '' : remoteOption ?? null;

    // Extract --remote-control / --rc flag (enable bridge in interactive session)
    const remoteControlOption = (options as {
      remoteControl?: string | true;
    }).remoteControl ?? (options as {
      rc?: string | true;
    }).rc;
    // Actual bridge check is deferred to after showSetupScreens() so that
    // trust is established and GrowthBook has auth headers.
    let remoteControl = false;
    const remoteControlName = typeof remoteControlOption === 'string' && remoteControlOption.length > 0 ? remoteControlOption : undefined;

    // Validate session ID if provided
    if (sessionId) {
      // Check for conflicting flags
      // --session-id can be used with --continue or --resume when --fork-session is also provided
      // (to specify a custom ID for the forked session)
      if ((options.continue || options.resume) && !options.forkSession) {
        process.stderr.write(chalk.red('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n'));
        process.exit(1);
      }

      // When --sdk-url is provided (bridge/remote mode), the session ID is a
      // server-assigned tagged ID (e.g. "session_local_01...") rather than a
      // UUID. Skip UUID validation and local existence checks in that case.
      if (!sdkUrl) {
        const validatedSessionId = validateUuid(sessionId);
        if (!validatedSessionId) {
          process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'));
          process.exit(1);
        }

        // Check if session ID already exists
        if (sessionIdExists(validatedSessionId)) {
          process.stderr.write(chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`));
          process.exit(1);
        }
      }
    }

    // Download file resources if specified via --file flag
    const fileSpecs = (options as {
      file?: string[];
    }).file;
    if (fileSpecs && fileSpecs.length > 0) {
      // Get session ingress token (provided by EnvManager via CLAUDE_CODE_SESSION_ACCESS_TOKEN)
      const sessionToken = getSessionIngressAuthToken();
      if (!sessionToken) {
        process.stderr.write(chalk.red('Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n'));
        process.exit(1);
      }

      // Resolve session ID: prefer remote session ID, fall back to internal session ID
      const fileSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId();
      const files = parseFileSpecs(fileSpecs);
      if (files.length > 0) {
        // Use ANTHROPIC_BASE_URL if set (by EnvManager), otherwise use OAuth config
        // This ensures consistency with session ingress API in all environments
        const config: FilesApiConfig = {
          baseUrl: process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
          oauthToken: sessionToken,
          sessionId: fileSessionId
        };

        // Start download without blocking startup - await before REPL renders
        fileDownloadPromise = downloadSessionFiles(files, config);
      }
    }

    // Get isNonInteractiveSession from state (was set before init())
    const isNonInteractiveSession = getIsNonInteractiveSession();

    // Validate that fallback model is different from main model
    if (fallbackModel && options.model && fallbackModel === options.model) {
      process.stderr.write(chalk.red('Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n'));
      process.exit(1);
    }

    // Handle system prompt options
    let systemPrompt = options.systemPrompt;
    if (options.systemPromptFile) {
      if (options.systemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.systemPromptFile);
        systemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // Handle append system prompt options
    let appendSystemPrompt = options.appendSystemPrompt;
    if (options.appendSystemPromptFile) {
      if (options.appendSystemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.appendSystemPromptFile);
        appendSystemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // Add teammate-specific system prompt addendum for tmux teammates
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName) {
      const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
    }
    const {
      mode: permissionMode,
      notification: permissionModeNotification
    } = initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions
    });

    // Store session bypass permissions mode for trust dialog check
    setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      // autoModeFlagCli is the "did the user intend auto this session" signal.
      // Set when: --enable-auto-mode, --permission-mode auto, resolved mode
      // is auto, OR settings defaultMode is auto but the gate denied it
      // (permissionMode resolved to default with no explicit CLI override).
      // Used by verifyAutoModeGateAccess to decide whether to notify on
      // auto-unavailable, and by tengu_auto_mode_config opt-in carousel.
      if ((options as {
        enableAutoMode?: boolean;
      }).enableAutoMode || permissionModeCli === 'auto' || permissionMode === 'auto' || !permissionModeCli && isDefaultPermissionModeAuto()) {
        autoModeStateModule?.setAutoModeFlagCli(true);
      }
    }

    // Parse the MCP config files/strings if provided
    let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {};
    if (mcpConfig && mcpConfig.length > 0) {
      // Process mcpConfig array
      const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);
      let allConfigs: Record<string, McpServerConfig> = {};
      const allErrors: ValidationError[] = [];
      for (const configItem of processedConfigs) {
        let configs: Record<string, McpServerConfig> | null = null;
        let errors: ValidationError[] = [];

        // First try to parse as JSON string
        const parsedJson = safeParseJSON(configItem);
        if (parsedJson) {
          const result = parseMcpConfig({
            configObject: parsedJson,
            filePath: 'command line',
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        } else {
          // Try as file path
          const configPath = resolve(configItem);
          const result = parseMcpConfigFromFilePath({
            filePath: configPath,
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        }
        if (errors.length > 0) {
          allErrors.push(...errors);
        } else if (configs) {
          // Merge configs, later ones override earlier ones
          allConfigs = {
            ...allConfigs,
            ...configs
          };
        }
      }
      if (allErrors.length > 0) {
        const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
        logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
          level: 'error'
        });
        process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`);
        process.exit(1);
      }
      if (Object.keys(allConfigs).length > 0) {
        // SDK hosts (Nest/Desktop) own their server naming and may reuse
        // built-in names — skip reserved-name checks for type:'sdk'.
        const nonSdkConfigNames = Object.entries(allConfigs).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
        let reservedNameError: string | null = null;
        if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
          reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`;
        } else if (feature('CHICAGO_MCP')) {
          const {
            isComputerUseMCPServer,
            COMPUTER_USE_MCP_SERVER_NAME
          } = await import('src/utils/computerUse/common.js');
          if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
            reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`;
          }
        }
        if (reservedNameError) {
          // stderr+exit(1) — a throw here becomes a silent unhandled
          // rejection in stream-json mode (void main() in cli.tsx).
          process.stderr.write(`Error: ${reservedNameError}\n`);
          process.exit(1);
        }

        // Add dynamic scope to all configs. type:'sdk' entries pass through
        // unchanged — they're extracted into sdkMcpConfigs downstream and
        // passed to print.ts. The Python SDK relies on this path (it doesn't
        // send sdkMcpServers in the initialize message). Dropping them here
        // broke Coworker (inc-5122). The policy filter below already exempts
        // type:'sdk', and the entries are inert without an SDK transport on
        // stdin, so there's no bypass risk from letting them through.
        const scopedConfigs = mapValues(allConfigs, config => ({
          ...config,
          scope: 'dynamic' as const
        }));

        // Enforce managed policy (allowedMcpServers / deniedMcpServers) on
        // --mcp-config servers. Without this, the CLI flag bypasses the
        // enterprise allowlist that user/project/local configs go through in
        // getClaudeCodeMcpConfigs — callers spread dynamicMcpConfig back on
        // top of filtered results. Filter here at the source so all
        // downstream consumers see the policy-filtered set.
        const {
          allowed,
          blocked
        } = filterMcpServersByPolicy(scopedConfigs);
        if (blocked.length > 0) {
          process.stderr.write(`Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
        }
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...allowed
        };
      }
    }

    // Extract Claude in Chrome option and enforce claude.ai subscriber check (unless user is ant)
    const chromeOpts = options as {
      chrome?: boolean;
    };
    // Store the explicit CLI flag so teammates can inherit it
    setChromeFlagOverride(chromeOpts.chrome);
    const enableClaudeInChrome = shouldEnableClaudeInChrome(chromeOpts.chrome) && ("external" === 'ant' || isClaudeAISubscriber());
    const autoEnableClaudeInChrome = !enableClaudeInChrome && shouldAutoEnableClaudeInChrome();
    if (enableClaudeInChrome) {
      const platform = getPlatform();
      try {
        logEvent('tengu_claude_in_chrome_setup', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        const {
          mcpConfig: chromeMcpConfig,
          allowedTools: chromeMcpTools,
          systemPrompt: chromeSystemPrompt
        } = setupClaudeInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        allowedTools.push(...chromeMcpTools);
        if (chromeSystemPrompt) {
          appendSystemPrompt = appendSystemPrompt ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}` : chromeSystemPrompt;
        }
      } catch (error) {
        logEvent('tengu_claude_in_chrome_setup_failed', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        logForDebugging(`[Claude in Chrome] Error: ${error}`);
        logError(error);
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: Failed to run with Claude in Chrome.`);
        process.exit(1);
      }
    } else if (autoEnableClaudeInChrome) {
      try {
        const {
          mcpConfig: chromeMcpConfig
        } = setupClaudeInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        const hint = feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER : CLAUDE_IN_CHROME_SKILL_HINT;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint;
      } catch (error) {
        // Silently skip any errors for the auto-enable
        logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`);
      }
    }

    // Extract strict MCP config flag
    const strictMcpConfig = options.strictMcpConfig || false;

    // Check if enterprise MCP configuration exists. When it does, only allow dynamic MCP
    // configs that contain special server types (sdk)
    if (doesEnterpriseMcpConfigExist()) {
      if (strictMcpConfig) {
        process.stderr.write(chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'));
        process.exit(1);
      }

      // For --mcp-config, allow if all servers are internal types (sdk)
      if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
        process.stderr.write(chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'));
        process.exit(1);
      }
    }

    // chicago MCP: guarded Computer Use (app allowlist + frontmost gate +
    // SCContentFilter screenshots). Ant-only, GrowthBook-gated — failures
    // are silent (this is dogfooding). Platform + interactive checks inline
    // so non-macOS / print-mode ants skip the heavy @ant/computer-use-mcp
    // import entirely. gates.js is light (type-only package import).
    //
    // Placed AFTER the enterprise-MCP-config check: that check rejects any
    // dynamicMcpConfig entry with `type !== 'sdk'`, and our config is
    // `type: 'stdio'`. An enterprise-config ant with the GB gate on would
    // otherwise process.exit(1). Chrome has the same latent issue but has
    // shipped without incident; chicago places itself correctly.
    if (feature('CHICAGO_MCP') && getPlatform() === 'macos' && !getIsNonInteractiveSession()) {
      try {
        const {
          getChicagoEnabled
        } = await import('src/utils/computerUse/gates.js');
        if (getChicagoEnabled()) {
          const {
            setupComputerUseMCP
          } = await import('src/utils/computerUse/setup.js');
          const {
            mcpConfig,
            allowedTools: cuTools
          } = setupComputerUseMCP();
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...mcpConfig
          };
          allowedTools.push(...cuTools);
        }
      } catch (error) {
        logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`);
      }
    }

    // Store additional directories for CLAUDE.md loading (controlled by env var)
    setAdditionalDirectoriesForClaudeMd(addDir);

    // Channel server allowlist from --channels flag — servers whose
    // inbound push notifications should register this session. The option
    // is added inside a feature() block so TS doesn't know about it
    // on the options type — same pattern as --assistant at main.tsx:1824.
    // devChannels is deferred: showSetupScreens shows a confirmation dialog
    // and only appends to allowedChannels on accept.
    let devChannels: ChannelEntry[] | undefined;
    if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
      // Parse plugin:name@marketplace / server:Y tags into typed entries.
      // Tag decides trust model downstream: plugin-kind hits marketplace
      // verification + GrowthBook allowlist, server-kind always fails
      // allowlist (schema is plugin-only) unless dev flag is set.
      // Untagged or marketplace-less plugin entries are hard errors —
      // silently not-matching in the gate would look like channels are
      // "on" but nothing ever fires.
      const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
        const entries: ChannelEntry[] = [];
        const bad: string[] = [];
        for (const c of raw) {
          if (c.startsWith('plugin:')) {
            const rest = c.slice(7);
            const at = rest.indexOf('@');
            if (at <= 0 || at === rest.length - 1) {
              bad.push(c);
            } else {
              entries.push({
                kind: 'plugin',
                name: rest.slice(0, at),
                marketplace: rest.slice(at + 1)
              });
            }
          } else if (c.startsWith('server:') && c.length > 7) {
            entries.push({
              kind: 'server',
              name: c.slice(7)
            });
          } else {
            bad.push(c);
          }
        }
        if (bad.length > 0) {
          process.stderr.write(chalk.red(`${flag} entries must be tagged: ${bad.join(', ')}\n` + `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` + `  server:<name>                — manually configured MCP server\n`));
          process.exit(1);
        }
        return entries;
      };
      const channelOpts = options as {
        channels?: string[];
        dangerouslyLoadDevelopmentChannels?: string[];
      };
      const rawChannels = channelOpts.channels;
      const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels;
      // Always parse + set. ChannelsNotice reads getAllowedChannels() and
      // renders the appropriate branch (disabled/noAuth/policyBlocked/
      // listening) in the startup screen. gateChannelServer() enforces.
      // --channels works in both interactive and print/SDK modes; dev-channels
      // stays interactive-only (requires a confirmation dialog).
      let channelEntries: ChannelEntry[] = [];
      if (rawChannels && rawChannels.length > 0) {
        channelEntries = parseChannelEntries(rawChannels, '--channels');
        setAllowedChannels(channelEntries);
      }
      if (!isNonInteractiveSession) {
        if (rawDev && rawDev.length > 0) {
          devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels');
        }
      }
      // Flag-usage telemetry. Plugin identifiers are logged (same tier as
      // tengu_plugin_installed — public-registry-style names); server-kind
      // names are not (MCP-server-name tier, opt-in-only elsewhere).
      // Per-server gate outcomes land in tengu_mcp_channel_gate once
      // servers connect. Dev entries go through a confirmation dialog after
      // this — dev_plugins captures what was typed, not what was accepted.
      if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
        const joinPluginIds = (entries: ChannelEntry[]) => {
          const ids = entries.flatMap(e => e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : []);
          return ids.length > 0 ? ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : undefined;
        };
        logEvent('tengu_mcp_channel_flags', {
          channels_count: channelEntries.length,
          dev_count: devChannels?.length ?? 0,
          plugins: joinPluginIds(channelEntries),
          dev_plugins: joinPluginIds(devChannels ?? [])
        });
      }
    }

    // SDK opt-in for SendUserMessage via --tools. All sessions require
    // explicit opt-in; listing it in --tools signals intent. Runs BEFORE
    // initializeToolPermissionContext so getToolsForDefaultPreset() sees
    // the tool as enabled when computing the base-tools disallow filter.
    // Conditional require avoids leaking the tool-name string into
    // external builds.
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        BRIEF_TOOL_NAME,
        LEGACY_BRIEF_TOOL_NAME
      } = require('./tools/BriefTool/prompt.js') as typeof import('./tools/BriefTool/prompt.js');
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const parsed = parseToolListFromCLI(baseTools);
      if ((parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) && isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }

    // This await replaces blocking existsSync/statSync calls that were already in
    // the startup path. Wall-clock time is unchanged; we just yield to the event
    // loop during the fs I/O instead of blocking it. See #19661.
    const initResult = await initializeToolPermissionContext({
      allowedToolsCli: allowedTools,
      disallowedToolsCli: disallowedTools,
      baseToolsCli: baseTools,
      permissionMode,
      allowDangerouslySkipPermissions,
      addDirs: addDir
    });
    let toolPermissionContext = initResult.toolPermissionContext;
    const {
      warnings,
      dangerousPermissions,
      overlyBroadBashPermissions
    } = initResult;

    // Handle overly broad shell allow rules for ant users (Bash(*), PowerShell(*))
    if ("external" === 'ant' && overlyBroadBashPermissions.length > 0) {
      for (const permission of overlyBroadBashPermissions) {
        logForDebugging(`Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`);
      }
      toolPermissionContext = removeDangerousPermissions(toolPermissionContext, overlyBroadBashPermissions);
    }
    if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
      toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
    }

    // Print any warnings from initialization
    warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(warning);
    });
    void assertMinVersion();

    // claude.ai config fetch: -p mode only (interactive uses useManageMCPConnections
    // two-phase loading). Kicked off here to overlap with setup(); awaited
    // before runHeadless so single-turn -p sees connectors. Skipped under
    // enterprise/strict MCP to preserve policy boundaries.
    const claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> = isNonInteractiveSession && !strictMcpConfig && !doesEnterpriseMcpConfigExist() &&
    // --bare / SIMPLE: skip claude.ai proxy servers (datadog, Gmail,
    // Slack, BigQuery, PubMed — 6-14s each to connect). Scripted calls
    // that need MCP pass --mcp-config explicitly.
    !isBareMode() ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
      const {
        allowed,
        blocked
      } = filterMcpServersByPolicy(configs);
      if (blocked.length > 0) {
        process.stderr.write(`Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
      }
      return allowed;
    }) : Promise.resolve({});

    // Kick off MCP config loading early (safe - just reads files, no execution).
    // Both interactive and -p use getClaudeCodeMcpConfigs (local file reads only).
    // The local promise is awaited later (before prefetchAllMcpResources) to
    // overlap config I/O with setup(), commands loading, and trust dialog.
    logForDebugging('[STARTUP] Loading MCP configs...');
    const mcpConfigStart = Date.now();
    let mcpConfigResolvedMs: number | undefined;
    // --bare skips auto-discovered MCP (.mcp.json, user settings, plugins) —
    // only explicit --mcp-config works. dynamicMcpConfig is spread onto
    // allMcpConfigs downstream so it survives this skip.
    const mcpConfigPromise = (strictMcpConfig || isBareMode() ? Promise.resolve({
      servers: {} as Record<string, ScopedMcpServerConfig>
    }) : getClaudeCodeMcpConfigs(dynamicMcpConfig)).then(result => {
      mcpConfigResolvedMs = Date.now() - mcpConfigStart;
      return result;
    });

    // NOTE: We do NOT call prefetchAllMcpResources here - that's deferred until after trust dialog

    if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Invalid input format "${inputFormat}".`);
      process.exit(1);
    }
    if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
      process.exit(1);
    }

    // Validate sdkUrl is only used with appropriate formats (formats are auto-set above)
    if (sdkUrl) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate replayUserMessages is only used with stream-json formats
    if (options.replayUserMessages) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate includePartialMessages is only used with print mode and stream-json output
    if (effectiveIncludePartialMessages) {
      if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
        writeToStderr(`Error: --include-partial-messages requires --print and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate --no-session-persistence is only used with print mode
    if (options.sessionPersistence === false && !isNonInteractiveSession) {
      writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
      process.exit(1);
    }
    const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
    profileCheckpoint('action_after_input_prompt');

    // Activate proactive mode BEFORE getTools() so SleepTool.isEnabled()
    // (which returns isProactiveActive()) passes and Sleep is included.
    // The later REPL-path maybeActivateProactive() calls are idempotent.
    maybeActivateProactive(options);
    let tools = getTools(toolPermissionContext);

    // Apply coordinator mode tool filtering for headless path
    // (mirrors useMergedTools.ts filtering for REPL/interactive path)
    if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      const {
        applyCoordinatorToolFilter
      } = await import('./utils/toolPool.js');
      tools = applyCoordinatorToolFilter(tools);
    }
    profileCheckpoint('action_tools_loaded');
    let jsonSchema: ToolInputJSONSchema | undefined;
    if (isSyntheticOutputToolEnabled({
      isNonInteractiveSession
    }) && options.jsonSchema) {
      jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema;
    }
    if (jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(jsonSchema);
      if ('tool' in syntheticOutputResult) {
        // Add SyntheticOutputTool to the tools array AFTER getTools() filtering.
        // This tool is excluded from normal filtering (see tools.ts) because it's
        // an implementation detail for structured output, not a user-controlled tool.
        tools = [...tools, syntheticOutputResult.tool];
        logEvent('tengu_structured_output_enabled', {
          schema_property_count: Object.keys(jsonSchema.properties as Record<string, unknown> || {}).length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_required_fields: Boolean(jsonSchema.required) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      } else {
        logEvent('tengu_structured_output_failure', {
          error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
    }

    // IMPORTANT: setup() must be called before any other code that depends on the cwd or worktree setup
    profileCheckpoint('action_before_setup');
    logForDebugging('[STARTUP] Running setup()...');
    const setupStart = Date.now();
    const {
      setup
    } = await import('./setup.js');
    const messagingSocketPath = feature('UDS_INBOX') ? (options as {
      messagingSocketPath?: string;
    }).messagingSocketPath : undefined;
    // Parallelize setup() with commands+agents loading. setup()'s ~28ms is
    // mostly startUdsMessaging (socket bind, ~20ms) — not disk-bound, so it
    // doesn't contend with getCommands' file reads. Gated on !worktreeEnabled
    // since --worktree makes setup() process.chdir() (setup.ts:203), and
    // commands/agents need the post-chdir cwd.
    const preSetupCwd = getCwd();
    // Register bundled skills/plugins before kicking getCommands() — they're
    // pure in-memory array pushes (<1ms, zero I/O) that getBundledSkills()
    // reads synchronously. Previously ran inside setup() after ~20ms of
    // await points, so the parallel getCommands() memoized an empty list.
    if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
      initBuiltinPlugins();
      initBundledSkills();
    }
    const setupPromise = setup(preSetupCwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, sessionId ? validateUuid(sessionId) : undefined, worktreePRNumber, messagingSocketPath);
    const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
    const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
    // Suppress transient unhandledRejection if these reject during the
    // ~28ms setupPromise await before Promise.all joins them below.
    commandsPromise?.catch(() => {});
    agentDefsPromise?.catch(() => {});
    await setupPromise;
    logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
    profileCheckpoint('action_after_setup');

    // Replay user messages into stream-json only when the socket was
    // explicitly requested. The auto-generated socket is passive — it
    // lets tools inject if they want to, but turning it on by default
    // shouldn't reshape stream-json for SDK consumers who never touch it.
    // Callers who inject and also want those injections visible in the
    // stream pass --messaging-socket-path explicitly (or --replay-user-messages).
    let effectiveReplayUserMessages = !!options.replayUserMessages;
    if (feature('UDS_INBOX')) {
      if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
        effectiveReplayUserMessages = !!(options as {
          messagingSocketPath?: string;
        }).messagingSocketPath;
      }
    }
    if (getIsNonInteractiveSession()) {
      // Apply full merged settings env now (including project-scoped
      // .claude/settings.json PATH/GIT_DIR/GIT_WORK_TREE) so gitExe() and
      // the git spawn below see it. Trust is implicit in -p mode; the
      // docstring at managedEnv.ts:96-97 says this applies "potentially
      // dangerous environment variables such as LD_PRELOAD, PATH" from all
      // sources. The later call in the isNonInteractiveSession block below
      // is idempotent (Object.assign, configureGlobalAgents ejects prior
      // interceptor) and picks up any plugin-contributed env after plugin
      // init. Project settings are already loaded here:
      // applySafeConfigEnvironmentVariables in init() called
      // getSettings_DEPRECATED at managedEnv.ts:86 which merges all enabled
      // sources including projectSettings/localSettings.
      applyConfigEnvironmentVariables();

      // Spawn git status/log/branch now so the subprocess execution overlaps
      // with the getCommands await below and startDeferredPrefetches. After
      // setup() so cwd is final (setup.ts:254 may process.chdir(worktreePath)
      // for --worktree) and after the applyConfigEnvironmentVariables above
      // so PATH/GIT_DIR/GIT_WORK_TREE from all sources (trusted + project)
      // are applied. getSystemContext is memoized; the
      // prefetchSystemContextIfSafe call in startDeferredPrefetches becomes
      // a cache hit. The microtask from await getIsGit() drains at the
      // getCommands Promise.all await below. Trust is implicit in -p mode
      // (same gate as prefetchSystemContextIfSafe).
      void getSystemContext();
      // Kick getUserContext now too — its first await (fs.readFile in
      // getMemoryFiles) yields naturally, so the CLAUDE.md directory walk
      // runs during the ~280ms overlap window before the context
      // Promise.all join in print.ts. The void getUserContext() in
      // startDeferredPrefetches becomes a memoize cache-hit.
      void getUserContext();
      // Kick ensureModelStringsInitialized now — for Bedrock this triggers
      // a 100-200ms profile fetch that was awaited serially at
      // print.ts:739. updateBedrockModelStrings is sequential()-wrapped so
      // the await joins the in-flight fetch. Non-Bedrock is a sync
      // early-return (zero-cost).
      void ensureModelStringsInitialized();
    }

    // Apply --name: cache-only so no orphan file is created before the
    // session ID is finalized by --continue/--resume. materializeSessionFile
    // persists it on the first user message; REPL's useTerminalTitle reads it
    // via getCurrentSessionTitle.
    const sessionNameArg = options.name?.trim();
    if (sessionNameArg) {
      cacheSessionTitle(sessionNameArg);
    }

    // Ant model aliases (capybara-fast etc.) resolve via the
    // tengu_ant_model_override GrowthBook flag. _CACHED_MAY_BE_STALE reads
    // disk synchronously; disk is populated by a fire-and-forget write. On a
    // cold cache, parseUserSpecifiedModel returns the unresolved alias, the
    // API 404s, and -p exits before the async write lands — crashloop on
    // fresh pods. Awaiting init here populates the in-memory payload map that
    // _CACHED_MAY_BE_STALE now checks first. Gated so the warm path stays
    // non-blocking:
    //  - explicit model via --model or ANTHROPIC_MODEL (both feed alias resolution)
    //  - no env override (which short-circuits _CACHED_MAY_BE_STALE before disk)
    //  - flag absent from disk (== null also catches pre-#22279 poisoned null)
    const explicitModel = options.model || process.env.ANTHROPIC_MODEL;
    if ("external" === 'ant' && explicitModel && explicitModel !== 'default' && !hasGrowthBookEnvOverride('tengu_ant_model_override') && getGlobalConfig().cachedGrowthBookFeatures?.['tengu_ant_model_override'] == null) {
      await initializeGrowthBook();
    }

    // Special case the default model with the null keyword
    // NOTE: Model resolution happens after setup() to ensure trust is established before AWS auth
    const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
    const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

    // Reuse preSetupCwd unless setup() chdir'd (worktreeEnabled). Saves a
    // getCwd() syscall in the common path.
    const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd;
    logForDebugging('[STARTUP] Loading commands and agents...');
    const commandsStart = Date.now();
    // Join the promises kicked before setup() (or start fresh if
    // worktreeEnabled gated the early kick). Both memoized by cwd.
    const [commands, agentDefinitionsResult] = await Promise.all([commandsPromise ?? getCommands(currentCwd), agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd)]);
    logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);
    profileCheckpoint('action_commands_loaded');

    // Parse CLI agents if provided via --agents flag
    let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
    if (agentsJson) {
      try {
        const parsedAgents = safeParseJSON(agentsJson);
        if (parsedAgents) {
          cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
        }
      } catch (error) {
        logError(error);
      }
    }

    // Merge CLI agents with existing ones
    const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
    const agentDefinitions = {
      ...agentDefinitionsResult,
      allAgents,
      activeAgents: getActiveAgentsFromList(allAgents)
    };

    // Look up main thread agent from CLI flag or settings
    const agentSetting = agentCli ?? getInitialSettings().agent;
    let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
    if (agentSetting) {
      mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
      if (!mainThreadAgentDefinition) {
        logForDebugging(`Warning: agent "${agentSetting}" not found. ` + `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` + `Using default behavior.`);
      }
    }

    // Store the main thread agent type in bootstrap state so hooks can access it
    setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

    // Log agent flag usage — only log agent name for built-in agents to avoid leaking custom agent names
    if (mainThreadAgentDefinition) {
      logEvent('tengu_agent_flag', {
        agentType: isBuiltInAgent(mainThreadAgentDefinition) ? mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : 'custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(agentCli && {
          source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        })
      });
    }

    // Persist agent setting to session transcript for resume view display and restoration
    if (mainThreadAgentDefinition?.agentType) {
      saveAgentSetting(mainThreadAgentDefinition.agentType);
    }

    // Apply the agent's system prompt for non-interactive sessions
    // (interactive mode uses buildEffectiveSystemPrompt instead)
    if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt && !isBuiltInAgent(mainThreadAgentDefinition)) {
      const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
      if (agentSystemPrompt) {
        systemPrompt = agentSystemPrompt;
      }
    }

    // initialPrompt goes first so its slash command (if any) is processed;
    // user-provided text becomes trailing context.
    // Only concatenate when inputPrompt is a string. When it's an
    // AsyncIterable (SDK stream-json mode), template interpolation would
    // call .toString() producing "[object Object]". The AsyncIterable case
    // is handled in print.ts via structuredIO.prependUserMessage().
    if (mainThreadAgentDefinition?.initialPrompt) {
      if (typeof inputPrompt === 'string') {
        inputPrompt = inputPrompt ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}` : mainThreadAgentDefinition.initialPrompt;
      } else if (!inputPrompt) {
        inputPrompt = mainThreadAgentDefinition.initialPrompt;
      }
    }

    // Compute effective model early so hooks can run in parallel with MCP
    // If user didn't specify a model but agent has one, use the agent's model
    let effectiveModel = userSpecifiedModel;
    if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
      effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
    }
    setMainLoopModelOverride(effectiveModel);

    // Compute resolved model for hooks (use user-specified model at launch)
    setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
    const initialMainLoopModel = getInitialMainLoopModel();
    const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());
    let advisorModel: string | undefined;
    if (isAdvisorEnabled()) {
      const advisorOption = canUserConfigureAdvisor() ? (options as {
        advisor?: string;
      }).advisor : undefined;
      if (advisorOption) {
        logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
        if (!modelSupportsAdvisor(resolvedInitialModel)) {
          process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`));
          process.exit(1);
        }
        const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
        if (!isValidAdvisorModel(normalizedAdvisorModel)) {
          process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
          process.exit(1);
        }
      }
      advisorModel = canUserConfigureAdvisor() ? advisorOption ?? getInitialAdvisorSetting() : advisorOption;
      if (advisorModel) {
        logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
      }
    }

    // For tmux teammates with --agent-type, append the custom agent's prompt
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName && storedTeammateOpts?.agentType) {
      // Look up the custom agent definition
      const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === storedTeammateOpts.agentType);
      if (customAgent) {
        // Get the prompt - need to handle both built-in and custom agents
        let customPrompt: string | undefined;
        if (customAgent.source === 'built-in') {
          // Built-in agents have getSystemPrompt that takes toolUseContext
          // We can't access full toolUseContext here, so skip for now
          logForDebugging(`[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`);
        } else {
          // Custom agents have getSystemPrompt that takes no args
          customPrompt = customAgent.getSystemPrompt();
        }

        // Log agent memory loaded event for tmux teammates
        if (customAgent.memory) {
          logEvent('tengu_agent_memory_loaded', {
            ...("external" === 'ant' && {
              agent_type: customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            }),
            scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }
        if (customPrompt) {
          const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
          appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
        }
      } else {
        logForDebugging(`[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`);
      }
    }
    maybeActivateBrief(options);
    // defaultView: 'chat' is a persisted opt-in — check entitlement and set
    // userMsgOptIn so the tool + prompt section activate. Interactive-only:
    // defaultView is a display preference; SDK sessions have no display, and
    // the assistant installer writes defaultView:'chat' to settings.local.json
    // which would otherwise leak into --print sessions in the same directory.
    // Runs right after maybeActivateBrief() so all startup opt-in paths fire
    // BEFORE any isBriefEnabled() read below (proactive prompt's
    // briefVisibility). A persisted 'chat' after a GB kill-switch falls
    // through (entitlement fails).
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && !getIsNonInteractiveSession() && !getUserMsgOptIn() && getInitialSettings().defaultView === 'chat') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }
    // Coordinator mode has its own system prompt and filters out Sleep, so
    // the generic proactive prompt would tell it to call a tool it can't
    // access and conflict with delegation instructions.
    if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
      proactive?: boolean;
    }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) && !coordinatorModeModule?.isCoordinatorMode()) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const briefVisibility = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')).isBriefEnabled() ? 'Call SendUserMessage at checkpoints to mark where things stand.' : 'The user will see any text you output.' : 'The user will see any text you output.';
      /* eslint-enable @typescript-eslint/no-require-imports */
      const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
    }
    if (feature('KAIROS') && kairosEnabled && assistantModule) {
      const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum();
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${assistantAddendum}` : assistantAddendum;
    }

    // Ink root is only needed for interactive sessions — patchConsole in the
    // Ink constructor would swallow console output in headless mode.
    let root!: Root;
    let getFpsMetrics!: () => FpsMetrics | undefined;
    let stats!: StatsStore;

    // Show setup screens after commands are loaded
    if (!isNonInteractiveSession) {
      const ctx = getRenderContext(false);
      getFpsMetrics = ctx.getFpsMetrics;
      stats = ctx.stats;
      // Install asciicast recorder before Ink mounts (ant-only, opt-in via CLAUDE_CODE_TERMINAL_RECORDING=1)
      if ("external" === 'ant') {
        installAsciicastRecorder();
      }
      const {
        createRoot
      } = await import('./ink.js');
      root = await createRoot(ctx.renderOptions);

      // Log startup time now, before any blocking dialog renders. Logging
      // from REPL's first render (the old location) included however long
      // the user sat on trust/OAuth/onboarding/resume-picker — p99 was ~70s
      // dominated by dialog-wait time, not code-path startup.
      logEvent('tengu_timer', {
        event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs: Math.round(process.uptime() * 1000)
      });
      logForDebugging('[STARTUP] Running showSetupScreens()...');
      const setupScreensStart = Date.now();
      const onboardingShown = await showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands, enableClaudeInChrome, devChannels);
      logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`);

      // Now that trust is established and GrowthBook has auth headers,
      // resolve the --remote-control / --rc entitlement gate.
      if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
        const {
          getBridgeDisabledReason
        } = await import('./bridge/bridgeEnabled.js');
        const disabledReason = await getBridgeDisabledReason();
        remoteControl = disabledReason === null;
        if (disabledReason) {
          process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`));
        }
      }

      // Check for pending agent memory snapshot updates (only for --agent mode, ant-only)
      if (feature('AGENT_MEMORY_SNAPSHOT') && mainThreadAgentDefinition && isCustomAgent(mainThreadAgentDefinition) && mainThreadAgentDefinition.memory && mainThreadAgentDefinition.pendingSnapshotUpdate) {
        const agentDef = mainThreadAgentDefinition;
        const choice = await launchSnapshotUpdateDialog(root, {
          agentType: agentDef.agentType,
          scope: agentDef.memory!,
          snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp
        });
        if (choice === 'merge') {
          const {
            buildMergePrompt
          } = await import('./components/agents/SnapshotUpdateDialog.js');
          const mergePrompt = buildMergePrompt(agentDef.agentType, agentDef.memory!);
          inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt;
        }
        agentDef.pendingSnapshotUpdate = undefined;
      }

      // Skip executing /login if we just completed onboarding for it
      if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
        prompt = '';
      }
      if (onboardingShown) {
        // Refresh auth-dependent services now that the user has logged in during onboarding.
        // Keep in sync with the post-login logic in src/commands/login.tsx
        void refreshRemoteManagedSettings();
        void refreshPolicyLimits();
        // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
        resetUserCache();
        // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
        refreshGrowthBookAfterAuthChange();
        // Clear any stale trusted device token then enroll for Remote Control.
        // Both self-gate on tengu_sessions_elevated_auth_enforcement internally
        // — enrollTrustedDevice() via checkGate_CACHED_OR_BLOCKING (awaits
        // the GrowthBook reinit above), clearTrustedDeviceToken() via the
        // sync cached check (acceptable since clear is idempotent).
        void import('./bridge/trustedDevice.js').then(m => {
          m.clearTrustedDeviceToken();
          return m.enrollTrustedDevice();
        });
      }

      // Validate that the active token's org matches forceLoginOrgUUID (if set
      // in managed settings). Runs after onboarding so managed settings and
      // login state are fully loaded.
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        await exitWithError(root, orgValidation.message);
      }
    }

    // If gracefulShutdown was initiated (e.g., user rejected trust dialog),
    // process.exitCode will be set. Skip all subsequent operations that could
    // trigger code execution before the process exits (e.g. we don't want apiKeyHelper
    // to run if trust was not established).
    if (process.exitCode !== undefined) {
      logForDebugging('Graceful shutdown initiated, skipping further initialization');
      return;
    }

    // Initialize LSP manager AFTER trust is established (or in non-interactive mode
    // where trust is implicit). This prevents plugin LSP servers from executing
    // code in untrusted directories before user consent.
    // Must be after inline plugins are set (if any) so --plugin-dir LSP servers are included.
    initializeLspServerManager();

    // Show settings validation errors after trust is established
    // MCP config errors don't block settings from loading, so exclude them
    if (!isNonInteractiveSession) {
      const {
        errors
      } = getSettingsWithErrors();
      const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
      if (nonMcpErrors.length > 0) {
        await launchInvalidSettingsDialog(root, {
          settingsErrors: nonMcpErrors,
          onExit: () => gracefulShutdownSync(1)
        });
      }
    }

    // Check quota status, fast mode, passes eligibility, and bootstrap data
    // after trust is established. These make API calls which could trigger
    // apiKeyHelper execution.
    // --bare / SIMPLE: skip — these are cache-warms for the REPL's
    // first-turn responsiveness (quota, passes, fastMode, bootstrap data). Fast
    // mode doesn't apply to the Agent SDK anyway (see getFastModeUnavailableReason).
    const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('tengu_cicada_nap_ms', 0);
    const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
    const skipStartupPrefetches = isBareMode() || bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs;
    if (!skipStartupPrefetches) {
      const lastPrefetchedInfo = lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
      logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);
      checkQuotaStatus().catch(error => logError(error));

      // Fetch bootstrap data from the server and update all cache values.
      void fetchBootstrapData();

      // TODO: Consolidate other prefetches into a single bootstrap request.
      void prefetchPassesEligibility();
      if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)) {
        void prefetchFastModeStatus();
      } else {
        // Kill switch skips the network call, not org-policy enforcement.
        // Resolve from cache so orgStatus doesn't stay 'pending' (which
        // getFastModeUnavailableReason treats as permissive).
        resolveFastModeStatusFromCache();
      }
      if (bgRefreshThrottleMs > 0) {
        saveGlobalConfig(current => ({
          ...current,
          startupPrefetchedAt: Date.now()
        }));
      }
    } else {
      logForDebugging(`Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`);
      // Resolve fast mode org status from cache (no network)
      resolveFastModeStatusFromCache();
    }
    if (!isNonInteractiveSession) {
      void refreshExampleCommands(); // Pre-fetch example commands (runs git log, no API call)
    }

    // Resolve MCP configs (started early, overlaps with setup/trust dialog work)
    const {
      servers: existingMcpConfigs
    } = await mcpConfigPromise;
    logForDebugging(`[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`);
    // CLI flag (--mcp-config) should override file-based configs, matching settings precedence
    const allMcpConfigs = {
      ...existingMcpConfigs,
      ...dynamicMcpConfig
    };

    // Separate SDK configs from regular MCP configs
    const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
    const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};
    for (const [name, config] of Object.entries(allMcpConfigs)) {
      const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
      if (typedConfig.type === 'sdk') {
        sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
      } else {
        regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
      }
    }
    profileCheckpoint('action_mcp_configs_loaded');

    // Prefetch MCP resources after trust dialog (this is where execution happens).
    // Interactive mode only: print mode defers connects until headlessStore exists
    // and pushes per-server (below), so ToolSearch's pending-client handling works
    // and one slow server doesn't block the batch.
    const localMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : prefetchAllMcpResources(regularMcpConfigs);
    const claudeaiMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : claudeaiConfigPromise.then(configs => Object.keys(configs).length > 0 ? prefetchAllMcpResources(configs) : {
      clients: [],
      tools: [],
      commands: []
    });
    // Merge with dedup by name: each prefetchAllMcpResources call independently
    // adds helper tools (ListMcpResourcesTool, ReadMcpResourceTool) via
    // local dedup flags, so merging two calls can yield duplicates. print.ts
    // already uniqBy's the final tool pool, but dedup here keeps appState clean.
    const mcpPromise = Promise.all([localMcpPromise, claudeaiMcpPromise]).then(([local, claudeai]) => ({
      clients: [...local.clients, ...claudeai.clients],
      tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
      commands: uniqBy([...local.commands, ...claudeai.commands], 'name')
    }));

    // Start hooks early so they run in parallel with MCP connections.
    // Skip for initOnly/init/maintenance (handled separately), non-interactive
    // (handled via setupTrigger), and resume/continue (conversationRecovery.ts
    // fires 'resume' instead — without this guard, hooks fire TWICE on /resume
    // and the second systemMessage clobbers the first. gh-30825)
    const hooksPromise = initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume ? null : processSessionStartHooks('startup', {
      agentType: mainThreadAgentDefinition?.agentType,
      model: resolvedInitialModel
    });

    // MCP never blocks REPL render OR turn 1 TTFT. useManageMCPConnections
    // populates appState.mcp async as servers connect (connectToServer is
    // memoized — the prefetch calls above and the hook converge on the same
    // connections). getToolUseContext reads store.getState() fresh via
    // computeTools(), so turn 1 sees whatever's connected by query time.
    // Slow servers populate for turn 2+. Matches interactive-no-prompt
    // behavior. Print mode: per-server push into headlessStore (below).
    const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
    // Suppress transient unhandledRejection — the prefetch warms the
    // memoized connectToServer cache but nobody awaits it in interactive.
    mcpPromise.catch(() => {});
    const mcpClients: Awaited<typeof mcpPromise>['clients'] = [];
    const mcpTools: Awaited<typeof mcpPromise>['tools'] = [];
    const mcpCommands: Awaited<typeof mcpPromise>['commands'] = [];
    let thinkingEnabled = shouldEnableThinkingByDefault();
    let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? {
      type: 'adaptive'
    } : {
      type: 'disabled'
    };
    if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
      thinkingEnabled = true;
      thinkingConfig = {
        type: 'adaptive'
      };
    } else if (options.thinking === 'disabled') {
      thinkingEnabled = false;
      thinkingConfig = {
        type: 'disabled'
      };
    } else {
      const maxThinkingTokens = process.env.MAX_THINKING_TOKENS ? parseInt(process.env.MAX_THINKING_TOKENS, 10) : options.maxThinkingTokens;
      if (maxThinkingTokens !== undefined) {
        if (maxThinkingTokens > 0) {
          thinkingEnabled = true;
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: maxThinkingTokens
          };
        } else if (maxThinkingTokens === 0) {
          thinkingEnabled = false;
          thinkingConfig = {
            type: 'disabled'
          };
        }
      }
    }
    logForDiagnosticsNoPII('info', 'started', {
      version: MACRO.VERSION,
      is_native_binary: isInBundledMode()
    });
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'exited');
    });
    void logTenguInit({
      hasInitialPrompt: Boolean(prompt),
      hasStdin: Boolean(inputPrompt),
      verbose,
      debug,
      debugToStderr,
      print: print ?? false,
      outputFormat: outputFormat ?? 'text',
      inputFormat: inputFormat ?? 'text',
      numAllowedTools: allowedTools.length,
      numDisallowedTools: disallowedTools.length,
      mcpClientCount: Object.keys(allMcpConfigs).length,
      worktreeEnabled,
      skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
      githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
      dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
      permissionMode,
      modeIsBypass: permissionMode === 'bypassPermissions',
      allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
      systemPromptFlag: systemPrompt ? options.systemPromptFile ? 'file' : 'flag' : undefined,
      appendSystemPromptFlag: appendSystemPrompt ? options.appendSystemPromptFile ? 'file' : 'flag' : undefined,
      thinkingConfig,
      assistantActivationPath: feature('KAIROS') && kairosEnabled ? assistantModule?.getAssistantActivationPath() : undefined
    });

    // Log context metrics once at initialization
    void logContextMetrics(regularMcpConfigs, toolPermissionContext);
    void logPermissionContextForAnts(null, 'initialization');
    logManagedSettings();

    // Register PID file for concurrent-session detection (~/.openclaude/sessions/)
    // and fire multi-clauding telemetry. Lives here (not init.ts) so only the
    // REPL path registers — not subcommands like `claude doctor`. Chained:
    // count must run after register's write completes or it misses our own file.
    void registerSession().then(registered => {
      if (!registered) return;
      if (sessionNameArg) {
        void updateSessionName(sessionNameArg);
      }
      void countConcurrentSessions().then(count => {
        if (count >= 2) {
          logEvent('tengu_concurrent_sessions', {
            num_sessions: count
          });
        }
      });
    });

    // Initialize versioned plugins system (triggers V1→V2 migration if
    // needed). Then run orphan GC, THEN warm the Grep/Glob exclusion cache.
    // Sequencing matters: the warmup scans disk for .orphaned_at markers,
    // so it must see the GC's Pass 1 (remove markers from reinstalled
    // versions) and Pass 2 (stamp unmarked orphans) already applied. The
    // warm also lands before autoupdate (fires on first submit in REPL)
    // can orphan this session's active version underneath us.
    // --bare / SIMPLE: skip plugin version sync + orphan cleanup. These
    // are install/upgrade bookkeeping that scripted calls don't need —
    // the next interactive session will reconcile. The await here was
    // blocking -p on a marketplace round-trip.
    if (isBareMode()) {
      // skip — no-op
    } else if (isNonInteractiveSession) {
      // In headless mode, await to ensure plugin sync completes before CLI exits
      await initializeVersionedPlugins();
      profileCheckpoint('action_after_plugins_init');
      void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache());
    } else {
      // In interactive mode, fire-and-forget — this is purely bookkeeping
      // that doesn't affect runtime behavior of the current session
      void initializeVersionedPlugins().then(async () => {
        profileCheckpoint('action_after_plugins_init');
        await cleanupOrphanedPluginVersionsInBackground();
        void getGlobExclusionsForPluginCache();
      });
    }
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
    if (initOnly) {
      applyConfigEnvironmentVariables();
      await processSetupHooks('init', {
        forceSyncExecution: true
      });
      await processSessionStartHooks('startup', {
        forceSyncExecution: true
      });
      gracefulShutdownSync(0);
      return;
    }

    // --print mode
    if (isNonInteractiveSession) {
      if (outputFormat === 'stream-json' || outputFormat === 'json') {
        setHasFormattedOutput(true);
      }

      // Apply full environment variables in print mode since trust dialog is bypassed
      // This includes potentially dangerous environment variables from untrusted sources
      // but print mode is considered trusted (as documented in help text)
      applyConfigEnvironmentVariables();

      // Initialize telemetry after env vars are applied so OTEL endpoint env vars and
      // otelHeadersHelper (which requires trust to execute) are available.
      initializeTelemetryAfterTrust();

      // Kick SessionStart hooks now so the subprocess spawn overlaps with
      // MCP connect + plugin init + print.ts import below. loadInitialMessages
      // joins this at print.ts:4397. Guarded same as loadInitialMessages —
      // continue/resume/teleport paths don't fire startup hooks (or fire them
      // conditionally inside the resume branch, where this promise is
      // undefined and the ?? fallback runs). Also skip when setupTrigger is
      // set — those paths run setup hooks first (print.ts:544), and session
      // start hooks must wait until setup completes.
      const sessionStartHooksPromise = options.continue || options.resume || teleport || setupTrigger ? undefined : processSessionStartHooks('startup');
      // Suppress transient unhandledRejection if this rejects before
      // loadInitialMessages awaits it. Downstream await still observes the
      // rejection — this just prevents the spurious global handler fire.
      sessionStartHooksPromise?.catch(() => {});
      profileCheckpoint('before_validateForceLoginOrg');
      // Validate org restriction for non-interactive sessions
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        process.stderr.write(orgValidation.message + '\n');
        process.exit(1);
      }

      // Headless mode supports all prompt commands and some local commands
      // If disableSlashCommands is true, return empty array
      const commandsHeadless = disableSlashCommands ? [] : commands.filter(command => command.type === 'prompt' && !command.disableNonInteractive || command.type === 'local' && command.supportsNonInteractive);
      const defaultState = getDefaultAppState();
      const headlessInitialState: AppState = {
        ...defaultState,
        mcp: {
          ...defaultState.mcp,
          clients: mcpClients,
          commands: mcpCommands,
          tools: mcpTools
        },
        toolPermissionContext,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        ...(isFastModeEnabled() && {
          fastMode: getInitialFastModeSetting(effectiveModel ?? null)
        }),
        ...(isAdvisorEnabled() && advisorModel && {
          advisorModel
        }),
        // kairosEnabled gates the async fire-and-forget path in
        // executeForkedSlashCommand (processSlashCommand.tsx:132) and
        // AgentTool's shouldRunAsync. The REPL initialState sets this at
        // ~3459; headless was defaulting to false, so the daemon child's
        // scheduled tasks and Agent-tool calls ran synchronously — N
        // overdue cron tasks on spawn = N serial subagent turns blocking
        // user input. Computed at :1620, well before this branch.
        ...(feature('KAIROS') ? {
          kairosEnabled
        } : {})
      };

      // Init app state
      const headlessStore = createStore(headlessInitialState, onChangeAppState);
      setCurrentAppStateStore(headlessStore);

      // Check if bypassPermissions should be disabled based on Statsig gate
      // This runs in parallel to the code below, to avoid blocking the main loop.
      if (toolPermissionContext.mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
        void checkAndDisableBypassPermissions(toolPermissionContext);
      }

      // Async check of auto mode gate — corrects state and disables auto if needed.
      // Gated on TRANSCRIPT_CLASSIFIER (not USER_TYPE) so GrowthBook kill switch runs for external builds too.
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(({
          updateContext
        }) => {
          headlessStore.setState(prev => {
            const nextCtx = updateContext(prev.toolPermissionContext);
            if (nextCtx === prev.toolPermissionContext) return prev;
            return {
              ...prev,
              toolPermissionContext: nextCtx
            };
          });
        });
      }

      // Set global state for session persistence
      if (options.sessionPersistence === false) {
        setSessionPersistenceDisabled(true);
      }

      // Store SDK betas in global state for context window calculation
      // Only store allowed betas (filters by allowlist and subscriber status)
      setSdkBetas(filterAllowedSdkBetas(betas));

      // Print-mode MCP: per-server incremental push into headlessStore.
      // Mirrors useManageMCPConnections — push pending first (so ToolSearch's
      // pending-check at ToolSearchTool.ts:334 sees them), then replace with
      // connected/failed as each server settles.
      const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
        if (Object.keys(configs).length === 0) return Promise.resolve();
        headlessStore.setState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: [...prev.mcp.clients, ...Object.entries(configs).map(([name, config]) => ({
              name,
              type: 'pending' as const,
              config
            }))]
          }
        }));
        return getMcpToolsCommandsAndResources(({
          client,
          tools,
          commands
        }) => {
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.some(c => c.name === client.name) ? prev.mcp.clients.map(c => c.name === client.name ? client : c) : [...prev.mcp.clients, client],
              tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
              commands: uniqBy([...prev.mcp.commands, ...commands], 'name')
            }
          }));
        }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
      };
      // Await all MCP configs — print mode is often single-turn, so
      // "late-connecting servers visible next turn" doesn't help. SDK init
      // message and turn-1 tool list both need configured MCP tools present.
      // Zero-server case is free via the early return in connectMcpBatch.
      // Connectors parallelize inside getMcpToolsCommandsAndResources
      // (processBatched with Promise.all). claude.ai is awaited too — its
      // fetch was kicked off early (line ~2558) so only residual time blocks
      // here. --bare skips claude.ai entirely for perf-sensitive scripts.
      profileCheckpoint('before_connectMcp');
      await connectMcpBatch(regularMcpConfigs, 'regular');
      profileCheckpoint('after_connectMcp');
      // Dedup: suppress plugin MCP servers that duplicate a claude.ai
      // connector (connector wins), then connect claude.ai servers.
      // Bounded wait — #23725 made this blocking so single-turn -p sees
      // connectors, but with 40+ slow connectors tengu_startup_perf p99
      // climbed to 76s. If fetch+connect doesn't finish in time, proceed;
      // the promise keeps running and updates headlessStore in the
      // background so turn 2+ still sees connectors.
      const CLAUDE_AI_MCP_TIMEOUT_MS = 5_000;
      const claudeaiConnect = claudeaiConfigPromise.then(claudeaiConfigs => {
        if (Object.keys(claudeaiConfigs).length > 0) {
          const claudeaiSigs = new Set<string>();
          for (const config of Object.values(claudeaiConfigs)) {
            const sig = getMcpServerSignature(config);
            if (sig) claudeaiSigs.add(sig);
          }
          const suppressed = new Set<string>();
          for (const [name, config] of Object.entries(regularMcpConfigs)) {
            if (!name.startsWith('plugin:')) continue;
            const sig = getMcpServerSignature(config);
            if (sig && claudeaiSigs.has(sig)) suppressed.add(name);
          }
          if (suppressed.size > 0) {
            logForDebugging(`[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate claude.ai connectors: ${[...suppressed].join(', ')}`);
            // Disconnect before filtering from state. Only connected
            // servers need cleanup — clearServerCache on a never-connected
            // server triggers a real connect just to kill it (memoize
            // cache-miss path, see useManageMCPConnections.ts:870).
            for (const c of headlessStore.getState().mcp.clients) {
              if (!suppressed.has(c.name) || c.type !== 'connected') continue;
              c.client.onclose = undefined;
              void clearServerCache(c.name, c.config).catch(() => {});
            }
            headlessStore.setState(prev => {
              let {
                clients,
                tools,
                commands,
                resources
              } = prev.mcp;
              clients = clients.filter(c => !suppressed.has(c.name));
              tools = tools.filter(t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName));
              for (const name of suppressed) {
                commands = excludeCommandsByServer(commands, name);
                resources = excludeResourcesByServer(resources, name);
              }
              return {
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients,
                  tools,
                  commands,
                  resources
                }
              };
            });
          }
        }
        // Suppress claude.ai connectors that duplicate an enabled
        // manual server (URL-signature match). Plugin dedup above only
        // handles `plugin:*` keys; this catches manual `.mcp.json` entries.
        // plugin:* must be excluded here — step 1 already suppressed
        // those (claude.ai wins); leaving them in suppresses the
        // connector too, and neither survives (gh-39974).
        const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'));
        const {
          servers: dedupedClaudeAi
        } = dedupClaudeAiMcpServers(claudeaiConfigs, nonPluginConfigs);
        return connectMcpBatch(dedupedClaudeAi, 'claudeai');
      });
      let claudeaiTimer: ReturnType<typeof setTimeout> | undefined;
      const claudeaiTimedOut = await Promise.race([claudeaiConnect.then(() => false), new Promise<boolean>(resolve => {
        claudeaiTimer = setTimeout(r => r(true), CLAUDE_AI_MCP_TIMEOUT_MS, resolve);
      })]);
      if (claudeaiTimer) clearTimeout(claudeaiTimer);
      if (claudeaiTimedOut) {
        logForDebugging(`[MCP] claude.ai connectors not ready after ${CLAUDE_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`);
      }
      profileCheckpoint('after_connectMcp_claudeai');

      // In headless mode, start deferred prefetches immediately (no user typing delay)
      // --bare / SIMPLE: startDeferredPrefetches early-returns internally.
      // backgroundHousekeeping (initExtractMemories, pruneShellSnapshots,
      // cleanupOldMessageFiles) and sdkHeapDumpMonitor are all bookkeeping
      // that scripted calls don't need — the next interactive session reconciles.
      if (!isBareMode()) {
        startDeferredPrefetches();
        void import('./utils/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
        if ("external" === 'ant') {
          void import('./utils/sdkHeapDumpMonitor.js').then(m => m.startSdkMemoryMonitor());
        }
      }
      logSessionTelemetry();
      profileCheckpoint('before_print_import');
      const {
        runHeadless
      } = await import('src/cli/print.js');
      profileCheckpoint('after_print_import');
      void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, {
        continue: options.continue,
        resume: options.resume,
        verbose: verbose,
        outputFormat: outputFormat,
        jsonSchema,
        permissionPromptToolName: options.permissionPromptTool,
        allowedTools,
        thinkingConfig,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        taskBudget: options.taskBudget ? {
          total: options.taskBudget
        } : undefined,
        systemPrompt,
        appendSystemPrompt,
        userSpecifiedModel: effectiveModel,
        fallbackModel: userSpecifiedFallbackModel,
        teleport,
        sdkUrl,
        replayUserMessages: effectiveReplayUserMessages,
        includePartialMessages: effectiveIncludePartialMessages,
        forkSession: options.forkSession || false,
        resumeSessionAt: options.resumeSessionAt || undefined,
        rewindFiles: options.rewindFiles,
        enableAuthStatus: options.enableAuthStatus,
        agent: agentCli,
        workload: options.workload,
        setupTrigger: setupTrigger ?? undefined,
        sessionStartHooksPromise
      });
      return;
    }

    // Log model config at startup
    logEvent('tengu_startup_manual_model_config', {
      cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      env_var: process.env.ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      settings_file: (getInitialSettings() || {}).model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      subscriptionType: getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });

    // Get deprecation warning for the initial model (resolvedInitialModel computed earlier for hooks parallelization)
    const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

    // Build initial notification queue
    const initialNotifications: Array<{
      key: string;
      text: string;
      color?: 'warning';
      priority: 'high';
    }> = [];
    if (permissionModeNotification) {
      initialNotifications.push({
        key: 'permission-mode-notification',
        text: permissionModeNotification,
        priority: 'high'
      });
    }
    if (deprecationWarning) {
      initialNotifications.push({
        key: 'model-deprecation-warning',
        text: deprecationWarning,
        color: 'warning',
        priority: 'high'
      });
    }
    if (overlyBroadBashPermissions.length > 0) {
      const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay));
      const displays = displayList.join(', ');
      const sources = uniq(overlyBroadBashPermissions.map(p => p.sourceDisplay)).join(', ');
      const n = displayList.length;
      initialNotifications.push({
        key: 'overly-broad-bash-notification',
        text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
        color: 'warning',
        priority: 'high'
      });
    }
    const effectiveToolPermissionContext = {
      ...toolPermissionContext,
      mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? 'plan' as const : toolPermissionContext.mode
    };
    // All startup opt-in paths (--tools, --brief, defaultView) have fired
    // above; initialIsBriefOnly just reads the resulting state.
    const initialIsBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false;
    const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled;
    let ccrMirrorEnabled = false;
    if (feature('CCR_MIRROR') && !fullRemoteControl) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        isCcrMirrorEnabled
      } = require('./bridge/bridgeEnabled.js') as typeof import('./bridge/bridgeEnabled.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      ccrMirrorEnabled = isCcrMirrorEnabled();
    }
    const initialState: AppState = {
      settings: getInitialSettings(),
      tasks: {},
      agentNameRegistry: new Map(),
      verbose: verbose ?? getGlobalConfig().verbose ?? false,
      mainLoopModel: initialMainLoopModel,
      mainLoopModelForSession: null,
      isBriefOnly: initialIsBriefOnly,
      expandedView: getGlobalConfig().showSpinnerTree ? 'teammates' : getGlobalConfig().showExpandedTodos ? 'tasks' : 'none',
      showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
      selectedIPAgentIndex: -1,
      coordinatorTaskIndex: -1,
      viewSelectionMode: 'none',
      footerSelection: null,
      toolPermissionContext: effectiveToolPermissionContext,
      agent: mainThreadAgentDefinition?.agentType,
      agentDefinitions,
      mcp: {
        clients: [],
        tools: [],
        commands: [],
        resources: {},
        pluginReconnectKey: 0
      },
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        installationStatus: {
          marketplaces: [],
          plugins: []
        },
        needsRefresh: false
      },
      statusLineText: undefined,
      kairosEnabled,
      remoteSessionUrl: undefined,
      remoteConnectionStatus: 'connecting',
      remoteBackgroundTaskCount: 0,
      replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
      replBridgeExplicit: remoteControl,
      replBridgeOutboundOnly: ccrMirrorEnabled,
      replBridgeConnected: false,
      replBridgeSessionActive: false,
      replBridgeReconnecting: false,
      replBridgeConnectUrl: undefined,
      replBridgeSessionUrl: undefined,
      replBridgeEnvironmentId: undefined,
      replBridgeSessionId: undefined,
      replBridgeError: undefined,
      replBridgeInitialName: remoteControlName,
      showRemoteCallout: false,
      notifications: {
        current: null,
        queue: initialNotifications
      },
      elicitation: {
        queue: []
      },
      todos: {},
      remoteAgentTaskSuggestions: [],
      fileHistory: {
        snapshots: [],
        trackedFiles: new Set(),
        snapshotSequence: 0
      },
      attribution: createEmptyAttributionState(),
      thinkingEnabled,
      promptSuggestionEnabled: shouldEnablePromptSuggestion(),
      sessionHooks: new Map(),
      inbox: {
        messages: []
      },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      },
      speculation: IDLE_SPECULATION_STATE,
      speculationSessionTimeSavedMs: 0,
      skillImprovement: {
        suggestion: null
      },
      workerSandboxPermissions: {
        queue: [],
        selectedIndex: 0
      },
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      authVersion: 0,
      initialMessage: inputPrompt ? {
        message: createUserMessage({
          content: String(inputPrompt)
        })
      } : null,
      effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
      activeOverlays: new Set<string>(),
      fastMode: getInitialFastModeSetting(resolvedInitialModel),
      ...(isAdvisorEnabled() && advisorModel && {
        advisorModel
      }),
      // Compute teamContext synchronously to avoid useEffect setState during render.
      // KAIROS: assistantTeamContext takes precedence — set earlier in the
      // KAIROS block so Agent(name: "foo") can spawn in-process teammates
      // without TeamCreate. computeInitialTeamContext() is for tmux-spawned
      // teammates reading their own identity, not the assistant-mode leader.
      teamContext: feature('KAIROS') ? assistantTeamContext ?? computeInitialTeamContext?.() : computeInitialTeamContext?.()
    };

    // Add CLI initial prompt to history
    if (inputPrompt) {
      addToHistory(String(inputPrompt));
    }
    const initialTools = mcpTools;

    // Increment numStartups synchronously — first-render readers like
    // shouldShowEffortCallout (via useState initializer) need the updated
    // value before setImmediate fires. Defer only telemetry.
    saveGlobalConfig(current => ({
      ...current,
      numStartups: (current.numStartups ?? 0) + 1
    }));
    setImmediate(() => {
      void logStartupTelemetry();
      logSessionTelemetry();
    });

    // Set up per-turn session environment data uploader (ant-only build).
    // Default-enabled for all ant users when working in an Anthropic-owned
    // repo. Captures git/filesystem state (NOT transcripts) at each turn so
    // environments can be recreated at any user message index. Gating:
    //   - Build-time: this import is stubbed in external builds.
    //   - Runtime: uploader checks github.com/anthropics/* remote + gcloud auth.
    //   - Safety: CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD=1 bypasses (tests set this).
    // Import is dynamic + async to avoid adding startup latency.
    const sessionUploaderPromise = "external" === 'ant' ? import('./utils/sessionDataUploader.js') : null;

    // Defer session uploader resolution to the onTurnComplete callback to avoid
    // adding a new top-level await in main.tsx (performance-critical path).
    // The per-turn auth logic in sessionDataUploader.ts handles unauthenticated
    // state gracefully (re-checks each turn, so auth recovery mid-session works).
    const uploaderReady = sessionUploaderPromise ? sessionUploaderPromise.then(mod => mod.createSessionTurnUploader()).catch(() => null) : null;
    const sessionConfig = {
      debug: debug || debugToStderr,
      commands: [...commands, ...mcpCommands],
      initialTools,
      mcpClients,
      autoConnectIdeFlag: ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      dynamicMcpConfig,
      strictMcpConfig,
      systemPrompt,
      appendSystemPrompt,
      taskListId,
      thinkingConfig,
      ...(uploaderReady && {
        onTurnComplete: (messages: MessageType[]) => {
          void uploaderReady.then(uploader => uploader?.(messages));
        }
      })
    };

    // Shared context for processResumedConversation calls
    const resumeContext = {
      modeApi: coordinatorModeModule,
      mainThreadAgentDefinition,
      agentDefinitions,
      currentCwd,
      cliAgents,
      initialState
    };
    if (options.continue) {
      // Continue the most recent conversation directly
      let resumeSucceeded = false;
      try {
        const resumeStart = performance.now();

        // Clear stale caches before resuming to ensure fresh file/skill discovery
        const {
          clearSessionCaches
        } = await import('./commands/clear/caches.js');
        clearSessionCaches();
        const result = await loadConversationForResume(undefined /* sessionId */, undefined /* sourceFile */);
        if (!result) {
          logEvent('tengu_continue', {
            success: false
          });
          return await exitWithError(root, 'No conversation found to continue');
        }
        const loaded = await processResumedConversation(result, {
          forkSession: !!options.forkSession,
          includeAttribution: true,
          transcriptPath: result.fullPath
        }, resumeContext);
        if (loaded.restoredAgentDef) {
          mainThreadAgentDefinition = loaded.restoredAgentDef;
        }
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        logEvent('tengu_continue', {
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart)
        });
        resumeSucceeded = true;
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: loaded.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: loaded.messages,
          initialFileHistorySnapshots: loaded.fileHistorySnapshots,
          initialContentReplacements: loaded.contentReplacements,
          initialAgentName: loaded.agentName,
          initialAgentColor: loaded.agentColor
        }, renderAndRun);
      } catch (error) {
        if (!resumeSucceeded) {
          logEvent('tengu_continue', {
            success: false
          });
        }
        logError(error);
        process.exit(1);
      }
    } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
      // `claude connect <url>` — full interactive TUI connected to a remote server
      let directConnectConfig;
      try {
        const session = await createDirectConnectSession({
          serverUrl: _pendingConnect.url,
          authToken: _pendingConnect.authToken,
          cwd: getOriginalCwd(),
          dangerouslySkipPermissions: _pendingConnect.dangerouslySkipPermissions
        });
        if (session.workDir) {
          setOriginalCwd(session.workDir);
          setCwdState(session.workDir);
        }
        setDirectConnectServerUrl(_pendingConnect.url);
        directConnectConfig = session.config;
      } catch (err) {
        return await exitWithError(root, err instanceof DirectConnectError ? err.message : String(err), () => gracefulShutdown(1));
      }
      const connectInfoMessage = createSystemMessage(`Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`, 'info');
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [connectInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        directConnectConfig,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
      // `claude ssh <host> [dir]` — probe remote, deploy binary if needed,
      // spawn ssh with unix-socket -R forward to a local auth proxy, hand
      // the REPL an SSHSession. Tools run remotely, UI renders locally.
      // `--local` skips probe/deploy/ssh and spawns the current binary
      // directly with the same env — e2e test of the proxy/auth plumbing.
      const {
        createSSHSession,
        createLocalSSHSession,
        SSHSessionError
      } = await import('./ssh/createSSHSession.js');
      let sshSession;
      try {
        if (_pendingSSH.local) {
          process.stderr.write('Starting local ssh-proxy test session...\n');
          sshSession = createLocalSSHSession({
            cwd: _pendingSSH.cwd,
            permissionMode: _pendingSSH.permissionMode,
            dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions
          });
        } else {
          process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`);
          // In-place progress: \r + EL0 (erase to end of line). Final \n on
          // success so the next message lands on a fresh line. No-op when
          // stderr isn't a TTY (piped/redirected) — \r would just emit noise.
          const isTTY = process.stderr.isTTY;
          let hadProgress = false;
          sshSession = await createSSHSession({
            host: _pendingSSH.host,
            cwd: _pendingSSH.cwd,
            localVersion: MACRO.VERSION,
            permissionMode: _pendingSSH.permissionMode,
            dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
            extraCliArgs: _pendingSSH.extraCliArgs
          }, isTTY ? {
            onProgress: msg => {
              hadProgress = true;
              process.stderr.write(`\r  ${msg}\x1b[K`);
            }
          } : {});
          if (hadProgress) process.stderr.write('\n');
        }
        setOriginalCwd(sshSession.remoteCwd);
        setCwdState(sshSession.remoteCwd);
        setDirectConnectServerUrl(_pendingSSH.local ? 'local' : _pendingSSH.host);
      } catch (err) {
        return await exitWithError(root, err instanceof SSHSessionError ? err.message : String(err), () => gracefulShutdown(1));
      }
      const sshInfoMessage = createSystemMessage(_pendingSSH.local ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy` : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`, 'info');
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [sshInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        sshSession,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (feature('KAIROS') && _pendingAssistantChat && (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)) {
      // `claude assistant [sessionId]` — REPL as a pure viewer client
      // of a remote assistant session. The agentic loop runs remotely; this
      // process streams live events and POSTs messages. History is lazy-
      // loaded by useAssistantHistory on scroll-up (no blocking fetch here).
      const {
        discoverAssistantSessions
      } = await import('./assistant/sessionDiscovery.js');
      let targetSessionId = _pendingAssistantChat.sessionId;

      // Discovery flow — list bridge environments, filter sessions
      if (!targetSessionId) {
        let sessions;
        try {
          sessions = await discoverAssistantSessions();
        } catch (e) {
          return await exitWithError(root, `Failed to discover sessions: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
        }
        if (sessions.length === 0) {
          let installedDir: string | null;
          try {
            installedDir = await launchAssistantInstallWizard(root);
          } catch (e) {
            return await exitWithError(root, `Assistant installation failed: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
          }
          if (installedDir === null) {
            await gracefulShutdown(0);
            process.exit(0);
          }
          // The daemon needs a few seconds to spin up its worker and
          // establish a bridge session before discovery will find it.
          return await exitWithMessage(root, `Assistant installed in ${installedDir}. The daemon is starting up — run \`openclaude assistant\` again in a few seconds to connect.`, {
            exitCode: 0,
            beforeExit: () => gracefulShutdown(0)
          });
        }
        if (sessions.length === 1) {
          targetSessionId = sessions[0]!.id;
        } else {
          const picked = await launchAssistantSessionChooser(root, {
            sessions
          });
          if (!picked) {
            await gracefulShutdown(0);
            process.exit(0);
          }
          targetSessionId = picked;
        }
      }

      // Auth — call prepareApiRequest() once for orgUUID, but use a
      // getAccessToken closure for the token so reconnects get fresh tokens.
      const {
        checkAndRefreshOAuthTokenIfNeeded,
        getClaudeAIOAuthTokens
      } = await import('./utils/auth.js');
      await checkAndRefreshOAuthTokenIfNeeded();
      let apiCreds;
      try {
        apiCreds = await prepareApiRequest();
      } catch (e) {
        return await exitWithError(root, `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`, () => gracefulShutdown(1));
      }
      const getAccessToken = (): string => getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken;

      // Brief mode activation: setKairosActive(true) satisfies BOTH opt-in
      // and entitlement for isBriefEnabled() (BriefTool.ts:124-132).
      setKairosActive(true);
      setUserMsgOptIn(true);
      setIsRemoteMode(true);
      const remoteSessionConfig = createRemoteSessionConfig(targetSessionId, getAccessToken, apiCreds.orgUUID, /* hasInitialPrompt */false, /* viewerOnly */true);
      const infoMessage = createSystemMessage(`Attached to assistant session ${targetSessionId.slice(0, 8)}…`, 'info');
      const assistantInitialState: AppState = {
        ...initialState,
        isBriefOnly: true,
        kairosEnabled: false,
        replBridgeEnabled: false
      };
      const remoteCommands = filterCommandsForRemoteMode(commands);
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState: assistantInitialState
      }, {
        debug: debug || debugToStderr,
        commands: remoteCommands,
        initialTools: [],
        initialMessages: [infoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        remoteSessionConfig,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (options.resume || options.fromPr || teleport || remote !== null) {
      // Handle resume flow - from file (ant-only), session ID, or interactive selector

      // Clear stale caches before resuming to ensure fresh file/skill discovery
      const {
        clearSessionCaches
      } = await import('./commands/clear/caches.js');
      clearSessionCaches();
      let messages: MessageType[] | null = null;
      let processedResume: ProcessedResume | undefined = undefined;
      let maybeSessionId = validateUuid(options.resume);
      let searchTerm: string | undefined = undefined;
      // Store full LogOption when found by custom title (for cross-worktree resume)
      let matchedLog: LogOption | null = null;
      // PR filter for --from-pr flag
      let filterByPr: boolean | number | string | undefined = undefined;

      // Handle --from-pr flag
      if (options.fromPr) {
        if (options.fromPr === true) {
          // Show all sessions with linked PRs
          filterByPr = true;
        } else if (typeof options.fromPr === 'string') {
          // Could be a PR number or URL
          filterByPr = options.fromPr;
        }
      }

      // If resume value is not a UUID, try exact match by custom title first
      if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
        const trimmedValue = options.resume.trim();
        if (trimmedValue) {
          const matches = await searchSessionsByCustomTitle(trimmedValue, {
            exact: true
          });
          if (matches.length === 1) {
            // Exact match found - store full LogOption for cross-worktree resume
            matchedLog = matches[0]!;
            maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
          } else {
            // No match or multiple matches - use as search term for picker
            searchTerm = trimmedValue;
          }
        }
      }

      // --remote and --teleport both create/resume Claude Code Web (CCR) sessions.
      // Remote Control (--rc) is a separate feature gated in initReplBridge.ts.
      if (remote !== null || teleport) {
        await waitForPolicyLimitsToLoad();
        if (!isPolicyAllowed('allow_remote_sessions')) {
          return await exitWithError(root, "Error: Remote sessions are disabled by your organization's policy.", () => gracefulShutdown(1));
        }
      }
      if (remote !== null) {
        // Create remote session (optionally with initial prompt)
        const hasInitialPrompt = remote.length > 0;

        // Check if TUI mode is enabled - description is only optional in TUI mode
        const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_remote_backend', false);
        if (!isRemoteTuiEnabled && !hasInitialPrompt) {
          return await exitWithError(root, 'Error: --remote requires a description.\nUsage: openclaude --remote "your task description"', () => gracefulShutdown(1));
        }
        logEvent('tengu_remote_create_session', {
          has_initial_prompt: String(hasInitialPrompt) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });

        // Pass current branch so CCR clones the repo at the right revision
        const currentBranch = await getBranch();
        const createdSession = await teleportToRemoteWithErrorHandling(root, hasInitialPrompt ? remote : null, new AbortController().signal, currentBranch || undefined);
        if (!createdSession) {
          logEvent('tengu_remote_create_session_error', {
            error: 'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          return await exitWithError(root, 'Error: Unable to create remote session', () => gracefulShutdown(1));
        }
        logEvent('tengu_remote_create_session_success', {
          session_id: createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });

        // Check if new remote TUI mode is enabled via feature gate
        if (!isRemoteTuiEnabled) {
          // Original behavior: print session info and exit
          process.stdout.write(`Created remote session: ${createdSession.title}\n`);
          process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`);
          process.stdout.write(`Resume with: openclaude --teleport ${createdSession.id}\n`);
          await gracefulShutdown(0);
          process.exit(0);
        }

        // New behavior: start local TUI with CCR engine
        // Mark that we're in remote mode for command visibility
        setIsRemoteMode(true);
        switchSession(asSessionId(createdSession.id));

        // Get OAuth credentials for remote session
        let apiCreds: {
          accessToken: string;
          orgUUID: string;
        };
        try {
          apiCreds = await prepareApiRequest();
        } catch (error) {
          logError(toError(error));
          return await exitWithError(root, `Error: ${errorMessage(error) || 'Failed to authenticate'}`, () => gracefulShutdown(1));
        }

        // Create remote session config for the REPL
        const {
          getClaudeAIOAuthTokens: getTokensForRemote
        } = await import('./utils/auth.js');
        const getAccessTokenForRemote = (): string => getTokensForRemote()?.accessToken ?? apiCreds.accessToken;
        const remoteSessionConfig = createRemoteSessionConfig(createdSession.id, getAccessTokenForRemote, apiCreds.orgUUID, hasInitialPrompt);

        // Add remote session info as initial system message
        const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`;
        const remoteInfoMessage = createSystemMessage(`/remote-control is active. Code in CLI or at ${remoteSessionUrl}`, 'info');

        // Create initial user message from the prompt if provided (CCR echoes it back but we ignore that)
        const initialUserMessage = hasInitialPrompt ? createUserMessage({
          content: remote
        }) : null;

        // Set remote session URL in app state for footer indicator
        const remoteInitialState = {
          ...initialState,
          remoteSessionUrl
        };

        // Pre-filter commands to only include remote-safe ones.
        // CCR's init response may further refine the list (via handleRemoteInit in REPL).
        const remoteCommands = filterCommandsForRemoteMode(commands);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: remoteInitialState
        }, {
          debug: debug || debugToStderr,
          commands: remoteCommands,
          initialTools: [],
          initialMessages: initialUserMessage ? [remoteInfoMessage, initialUserMessage] : [remoteInfoMessage],
          mcpClients: [],
          autoConnectIdeFlag: ide,
          mainThreadAgentDefinition,
          disableSlashCommands,
          remoteSessionConfig,
          thinkingConfig
        }, renderAndRun);
        return;
      } else if (teleport) {
        if (teleport === true || teleport === '') {
          // Interactive mode: show task selector and handle resume
          logEvent('tengu_teleport_interactive_mode', {});
          logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...');
          const teleportResult = await launchTeleportResumeWrapper(root);
          if (!teleportResult) {
            // User cancelled or error occurred
            await gracefulShutdown(0);
            process.exit(0);
          }
          const {
            branchError
          } = await checkOutTeleportedSessionBranch(teleportResult.branch);
          messages = processMessagesForTeleportResume(teleportResult.log, branchError);
        } else if (typeof teleport === 'string') {
          logEvent('tengu_teleport_resume_session', {
            mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          try {
            // First, fetch session and validate repository before checking git state
            const sessionData = await fetchSession(teleport);
            const repoValidation = await validateSessionRepository(sessionData);

            // Handle repo mismatch or not in repo cases
            if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
              const sessionRepo = repoValidation.sessionRepo;
              if (sessionRepo) {
                // Check for known paths
                const knownPaths = getKnownPathsForRepo(sessionRepo);
                const existingPaths = await filterExistingPaths(knownPaths);
                if (existingPaths.length > 0) {
                  // Show directory switch dialog
                  const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                    targetRepo: sessionRepo,
                    initialPaths: existingPaths
                  });
                  if (selectedPath) {
                    // Change to the selected directory
                    process.chdir(selectedPath);
                    setCwd(selectedPath);
                    setOriginalCwd(selectedPath);
                  } else {
                    // User cancelled
                    await gracefulShutdown(0);
                  }
                } else {
                  // No known paths - show original error
                  throw new TeleportOperationError(`You must run openclaude --teleport ${teleport} from a checkout of ${sessionRepo}.`, chalk.red(`You must run openclaude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`));
                }
              }
            } else if (repoValidation.status === 'error') {
              throw new TeleportOperationError(repoValidation.errorMessage || 'Failed to validate session', chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`));
            }
            await validateGitState();

            // Use progress UI for teleport
            const {
              teleportWithProgress
            } = await import('./components/TeleportProgress.js');
            const result = await teleportWithProgress(root, teleport);
            // Track teleported session for reliability logging
            setTeleportedSessionInfo({
              sessionId: teleport
            });
            messages = result.messages;
          } catch (error) {
            if (error instanceof TeleportOperationError) {
              process.stderr.write(error.formattedMessage + '\n');
            } else {
              logError(error);
              process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`));
            }
            await gracefulShutdown(1);
          }
        }
      }
      if ("external" === 'ant') {
        if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
          // Check for ccshare URL (e.g. https://go/ccshare/boris-20260311-211036)
          const {
            parseCcshareId,
            loadCcshare
          } = await import('./utils/ccshareResume.js');
          const ccshareId = parseCcshareId(options.resume);
          if (ccshareId) {
            try {
              const resumeStart = performance.now();
              const logOption = await loadCcshare(ccshareId);
              const result = await loadConversationForResume(logOption, undefined);
              if (result) {
                processedResume = await processResumedConversation(result, {
                  forkSession: true,
                  transcriptPath: result.fullPath
                }, resumeContext);
                if (processedResume.restoredAgentDef) {
                  mainThreadAgentDefinition = processedResume.restoredAgentDef;
                }
                logEvent('tengu_session_resumed', {
                  entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: true,
                  resume_duration_ms: Math.round(performance.now() - resumeStart)
                });
              } else {
                logEvent('tengu_session_resumed', {
                  entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false
                });
              }
            } catch (error) {
              logEvent('tengu_session_resumed', {
                entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false
              });
              logError(error);
              await exitWithError(root, `Unable to resume from ccshare: ${errorMessage(error)}`, () => gracefulShutdown(1));
            }
          } else {
            const resolvedPath = resolve(options.resume);
            try {
              const resumeStart = performance.now();
              let logOption;
              try {
                // Attempt to load as a transcript file; ENOENT falls through to session-ID handling
                logOption = await loadTranscriptFromFile(resolvedPath);
              } catch (error) {
                if (!isENOENT(error)) throw error;
                // ENOENT: not a file path — fall through to session-ID handling
              }
              if (logOption) {
                const result = await loadConversationForResume(logOption, undefined /* sourceFile */);
                if (result) {
                  processedResume = await processResumedConversation(result, {
                    forkSession: !!options.forkSession,
                    transcriptPath: result.fullPath
                  }, resumeContext);
                  if (processedResume.restoredAgentDef) {
                    mainThreadAgentDefinition = processedResume.restoredAgentDef;
                  }
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: true,
                    resume_duration_ms: Math.round(performance.now() - resumeStart)
                  });
                } else {
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: false
                  });
                }
              }
            } catch (error) {
              logEvent('tengu_session_resumed', {
                entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false
              });
              logError(error);
              await exitWithError(root, `Unable to load transcript from file: ${options.resume}`, () => gracefulShutdown(1));
            }
          }
        }
      }

      // If not loaded as a file, try as session ID
      if (maybeSessionId) {
        // Resume specific session by ID
        const sessionId = maybeSessionId;
        try {
          const resumeStart = performance.now();
          // Use matchedLog if available (for cross-worktree resume by custom title)
          // Otherwise fall back to sessionId string (for direct UUID resume)
          const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);
          if (!result) {
            logEvent('tengu_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false
            });
            return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
          }
          const fullPath = matchedLog?.fullPath ?? result.fullPath;
          processedResume = await processResumedConversation(result, {
            forkSession: !!options.forkSession,
            sessionIdOverride: sessionId,
            transcriptPath: fullPath
          }, resumeContext);
          if (processedResume.restoredAgentDef) {
            mainThreadAgentDefinition = processedResume.restoredAgentDef;
          }
          logEvent('tengu_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart)
          });
        } catch (error) {
          logEvent('tengu_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false
          });
          logError(error);
          await exitWithError(root, `Failed to resume session ${sessionId}`);
        }
      }

      // Await file downloads before rendering REPL (files must be available)
      if (fileDownloadPromise) {
        try {
          const results = await fileDownloadPromise;
          const failedCount = count(results, r => !r.success);
          if (failedCount > 0) {
            process.stderr.write(chalk.yellow(`Warning: ${failedCount}/${results.length} file(s) failed to download.\n`));
          }
        } catch (error) {
          return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`);
        }
      }

      // If we have a processed resume or teleport messages, render the REPL
      const resumeData = processedResume ?? (Array.isArray(messages) ? {
        messages,
        fileHistorySnapshots: undefined,
        agentName: undefined,
        agentColor: undefined as AgentColorName | undefined,
        restoredAgentDef: mainThreadAgentDefinition,
        initialState,
        contentReplacements: undefined
      } : undefined);
      if (resumeData) {
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: resumeData.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: resumeData.messages,
          initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
          initialContentReplacements: resumeData.contentReplacements,
          initialAgentName: resumeData.agentName,
          initialAgentColor: resumeData.agentColor
        }, renderAndRun);
      } else {
        // Show interactive selector (includes same-repo worktrees)
        // Note: ResumeConversation loads logs internally to ensure proper GC after selection
        await launchResumeChooser(root, {
          getFpsMetrics,
          stats,
          initialState
        }, getWorktreePaths(getOriginalCwd()), {
          ...sessionConfig,
          initialSearchQuery: searchTerm,
          forkSession: options.forkSession,
          filterByPr
        });
      }
    } else {
      // Pass unresolved hooks promise to REPL so it can render immediately
      // instead of blocking ~500ms waiting for SessionStart hooks to finish.
      // REPL will inject hook messages when they resolve and await them before
      // the first API call so the model always sees hook context.
      const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;
      profileCheckpoint('action_after_hooks');
      maybeActivateProactive(options);
      maybeActivateBrief(options);
      // Persist the current mode for fresh sessions so future resumes know what mode was used
      if (feature('COORDINATOR_MODE')) {
        saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // If launched via a deep link, show a provenance banner so the user
      // knows the session originated externally. Linux xdg-open and
      // browsers with "always allow" set dispatch the link with no OS-level
      // confirmation, so this is the only signal the user gets that the
      // prompt — and the working directory / CLAUDE.md it implies — came
      // from an external source rather than something they typed.
      let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null;
      if (feature('LODESTONE')) {
        if (options.deepLinkOrigin) {
          logEvent('tengu_deep_link_opened', {
            has_prefill: Boolean(options.prefill),
            has_repo: Boolean(options.deepLinkRepo)
          });
          deepLinkBanner = createSystemMessage(buildDeepLinkBanner({
            cwd: getCwd(),
            prefillLength: options.prefill?.length,
            repo: options.deepLinkRepo,
            lastFetch: options.deepLinkLastFetch !== undefined ? new Date(options.deepLinkLastFetch) : undefined
          }), 'warning');
        } else if (options.prefill) {
          deepLinkBanner = createSystemMessage('Launched with a pre-filled prompt — review it before pressing Enter.', 'warning');
        }
      }
      const initialMessages = deepLinkBanner ? [deepLinkBanner, ...hookMessages] : hookMessages.length > 0 ? hookMessages : undefined;
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages
      }, renderAndRun);
    }
  }).version(`${MACRO.VERSION} (OpenClaude)`, '-v, --version', 'Output the version number');

  // Worktree flags
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  if (canUserConfigureAdvisor()) {
    program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp());
  }
  if ("external" === 'ant') {
    program.addOption(new Option('--delegate-permissions', '[ANT-ONLY] Alias for --permission-mode auto.').implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--dangerously-skip-permissions-with-classifiers', '[ANT-ONLY] Deprecated alias for --permission-mode auto.').hideHelp().implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--afk', '[ANT-ONLY] Deprecated alias for --permission-mode auto.').hideHelp().implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--tasks [id]', '[ANT-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").').argParser(String).hideHelp());
    program.option('--agent-teams', '[ANT-ONLY] Force Claude to use multi-agent mode for solving problems', () => true);
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  if (feature('UDS_INBOX')) {
    program.addOption(new Option('--messaging-socket-path <path>', 'Unix domain socket path for the UDS messaging server (defaults to a tmp path)'));
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'));
  }
  if (feature('KAIROS')) {
    program.addOption(new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp());
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(new Option('--channels <servers...>', 'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.').hideHelp());
    program.addOption(new Option('--dangerously-load-development-channels <servers...>', 'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.').hideHelp());
  }

  // Teammate identity options (set by leader when spawning tmux teammates)
  // These replace the CLAUDE_CODE_* environment variables
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for analytics correlation').hideHelp());
  program.addOption(new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"').choices(['auto', 'tmux', 'in-process']).hideHelp());
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());

  // Enable SDK URL for all builds but hide from help
  program.addOption(new Option('--sdk-url <url>', 'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)').hideHelp());

  // Enable teleport/remote flags for all builds but keep them undocumented until GA
  program.addOption(new Option('--teleport [session]', 'Resume a teleport session, optionally specify session ID').hideHelp());
  program.addOption(new Option('--remote [description]', 'Create a remote session with the given description').hideHelp());
  if (feature('BRIDGE_MODE')) {
    program.addOption(new Option('--remote-control [name]', 'Start an interactive session with Remote Control enabled (optionally named)').argParser(value => value || true).hideHelp());
    program.addOption(new Option('--rc [name]', 'Alias for --remote-control').argParser(value => value || true).hideHelp());
  }
  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }
  profileCheckpoint('run_main_options_built');

  // -p/--print mode: skip subcommand registration. The 52 subcommands
  // (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
  // never dispatched in print mode — commander routes the prompt to the
  // default action. The subcommand registration path was measured at ~65ms
  // on baseline — mostly the isBridgeEnabled() call (25ms settings Zod parse
  // + 40ms sync keychain subprocess), both hidden by the try/catch that
  // always returns false before enableConfigs(). cc:// URLs are rewritten to
  // `open` at main() line ~851 BEFORE this runs, so argv check is safe here.
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // claude mcp

  const mcp = program.command('mcp').description('Configure and manage MCP servers').configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  mcp.command('serve').description(`Start the Claude Code MCP server`).option('-d, --debug', 'Enable debug mode', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).action(async ({
    debug,
    verbose
  }: {
    debug?: boolean;
    verbose?: boolean;
  }) => {
    const {
      mcpServeHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpServeHandler({
      debug,
      verbose
    });
  });

  // Register the mcp add subcommand (extracted for testability)
  registerMcpAddCommand(mcp);
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp);
  }
  mcp.command('remove <name>').description('Remove an MCP server').option('-s, --scope <scope>', 'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in').action(async (name: string, options: {
    scope?: string;
  }) => {
    const {
      mcpRemoveHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpRemoveHandler(name, options);
  });
  mcp.command('list').description('List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const {
      mcpListHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpListHandler();
  });
  mcp.command('get <name>').description('Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async (name: string) => {
    const {
      mcpGetHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpGetHandler(name);
  });
  mcp.command('add-json <name> <json>').description('Add an MCP server (stdio or SSE) with a JSON string').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)').action(async (name: string, json: string, options: {
    scope?: string;
    clientSecret?: true;
  }) => {
    const {
      mcpAddJsonHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddJsonHandler(name, json, options);
  });
  mcp.command('add-from-claude-desktop').description('Import MCP servers from Claude Desktop (Mac and WSL only)').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').action(async (options: {
    scope?: string;
  }) => {
    const {
      mcpAddFromDesktopHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddFromDesktopHandler(options);
  });
  mcp.command('reset-project-choices').description('Reset all approved and rejected project-scoped (.mcp.json) servers within this project').action(async () => {
    const {
      mcpResetChoicesHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpResetChoicesHandler();
  });

  // claude server
  if (feature('DIRECT_CONNECT')) {
    program.command('server').description('Start a Claude Code session server').option('--port <number>', 'HTTP port', '0').option('--host <string>', 'Bind address', '0.0.0.0').option('--auth-token <token>', 'Bearer token for auth').option('--unix <path>', 'Listen on a unix domain socket').option('--workspace <dir>', 'Default working directory for sessions that do not specify cwd').option('--idle-timeout <ms>', 'Idle timeout for detached sessions in ms (0 = never expire)', '600000').option('--max-sessions <n>', 'Maximum concurrent sessions (0 = unlimited)', '32').action(async (opts: {
      port: string;
      host: string;
      authToken?: string;
      unix?: string;
      workspace?: string;
      idleTimeout: string;
      maxSessions: string;
    }) => {
      const {
        randomBytes
      } = await import('crypto');
      const {
        startServer
      } = await import('./server/server.js');
      const {
        SessionManager
      } = await import('./server/sessionManager.js');
      const {
        DangerousBackend
      } = await import('./server/backends/dangerousBackend.js');
      const {
        printBanner
      } = await import('./server/serverBanner.js');
      const {
        createServerLogger
      } = await import('./server/serverLog.js');
      const {
        writeServerLock,
        removeServerLock,
        probeRunningServer
      } = await import('./server/lockfile.js');
      const existing = await probeRunningServer();
      if (existing) {
        process.stderr.write(`A claude server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`);
        process.exit(1);
      }
      const authToken = opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`;
      const config = {
        port: parseInt(opts.port, 10),
        host: opts.host,
        authToken,
        unix: opts.unix,
        workspace: opts.workspace,
        idleTimeoutMs: parseInt(opts.idleTimeout, 10),
        maxSessions: parseInt(opts.maxSessions, 10)
      };
      const backend = new DangerousBackend();
      const sessionManager = new SessionManager(backend, {
        idleTimeoutMs: config.idleTimeoutMs,
        maxSessions: config.maxSessions
      });
      const logger = createServerLogger();
      const server = startServer(config, sessionManager, logger);
      const actualPort = server.port ?? config.port;
      printBanner(config, authToken, actualPort);
      await writeServerLock({
        pid: process.pid,
        port: actualPort,
        host: config.host,
        httpUrl: config.unix ? `unix:${config.unix}` : `http://${config.host}:${actualPort}`,
        startedAt: Date.now()
      });
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Stop accepting new connections before tearing down sessions.
        server.stop(true);
        await sessionManager.destroyAll();
        await removeServerLock();
        process.exit(0);
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
    });
  }

  // `claude ssh <host> [dir]` — registered here only so --help shows it.
  // The actual interactive flow is handled by early argv rewriting in main()
  // (parallels the DIRECT_CONNECT/cc:// pattern above). If commander reaches
  // this action it means the argv rewrite didn't fire (e.g. user ran
  // `claude ssh` with no host) — just print usage.
  if (feature('SSH_REMOTE')) {
    program.command('ssh <host> [dir]').description('Run Claude Code on a remote host over SSH. Deploys the binary and ' + 'tunnels API auth back through your local machine — no remote setup needed.').option('--permission-mode <mode>', 'Permission mode for the remote session').option('--dangerously-skip-permissions', 'Skip all permission prompts on the remote (dangerous)').option('--local', 'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' + 'Exercises the auth proxy and unix-socket plumbing without a remote host.').action(async () => {
      // Argv rewriting in main() should have consumed `ssh <host>` before
      // commander runs. Reaching here means host was missing or the
      // rewrite predicate didn't match.
      process.stderr.write('Usage: openclaude ssh <user@host | ssh-config-alias> [dir]\n\n' + "Runs OpenClaude on a remote Linux host. You don't need to install\n" + 'anything on the remote or run `openclaude auth login` there — the binary is\n' + 'deployed over SSH and API auth tunnels back through your local machine.\n');
      process.exit(1);
    });
  }

  // claude connect — subcommand only handles -p (headless) mode.
  // Interactive mode (without -p) is handled by early argv rewriting in main()
  // which redirects to the main command with full TUI support.
  if (feature('DIRECT_CONNECT')) {
    program.command('open <cc-url>').description('Connect to a Claude Code server (internal — use cc:// URLs)').option('-p, --print [prompt]', 'Print mode (headless)').option('--output-format <format>', 'Output format: text, json, stream-json', 'text').action(async (ccUrl: string, opts: {
      print?: string | boolean;
      outputFormat: string;
    }) => {
      const {
        parseConnectUrl
      } = await import('./server/parseConnectUrl.js');
      const {
        serverUrl,
        authToken
      } = parseConnectUrl(ccUrl);
      let connectConfig;
      try {
        const session = await createDirectConnectSession({
          serverUrl,
          authToken,
          cwd: getOriginalCwd(),
          dangerouslySkipPermissions: _pendingConnect?.dangerouslySkipPermissions
        });
        if (session.workDir) {
          setOriginalCwd(session.workDir);
          setCwdState(session.workDir);
        }
        setDirectConnectServerUrl(serverUrl);
        connectConfig = session.config;
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: intentional error output
        console.error(err instanceof DirectConnectError ? err.message : String(err));
        process.exit(1);
      }
      const {
        runConnectHeadless
      } = await import('./server/connectHeadless.js');
      const prompt = typeof opts.print === 'string' ? opts.print : '';
      const interactive = opts.print === true;
      await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive);
    });
  }

  // claude auth

  const auth = program.command('auth').description('Manage authentication').configureHelp(createSortedHelpConfig());
  auth.command('login').description('Sign in to your Anthropic account').option('--email <email>', 'Pre-populate email address on the login page').option('--sso', 'Force SSO login flow').option('--console', 'Use Anthropic Console (API usage billing) instead of Claude subscription').option('--claudeai', 'Use Claude subscription (default)').action(async ({
    email,
    sso,
    console: useConsole,
    claudeai
  }: {
    email?: string;
    sso?: boolean;
    console?: boolean;
    claudeai?: boolean;
  }) => {
    const {
      authLogin
    } = await import('./cli/handlers/auth.js');
    await authLogin({
      email,
      sso,
      console: useConsole,
      claudeai
    });
  });
  auth.command('status').description('Show authentication status').option('--json', 'Output as JSON (default)').option('--text', 'Output as human-readable text').action(async (opts: {
    json?: boolean;
    text?: boolean;
  }) => {
    const {
      authStatus
    } = await import('./cli/handlers/auth.js');
    await authStatus(opts);
  });
  auth.command('logout').description('Log out from your Anthropic account').action(async () => {
    const {
      authLogout
    } = await import('./cli/handlers/auth.js');
    await authLogout();
  });

  /**
   * Helper function to handle marketplace command errors consistently.
   * Logs the error and exits the process with status 1.
   * @param error The error that occurred
   * @param action Description of the action that failed
   */
  // Hidden flag on all plugin/marketplace subcommands to target cowork_plugins.
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // Plugin validate command
  const pluginCmd = program.command('plugin').alias('plugins').description('Manage Claude Code plugins').configureHelp(createSortedHelpConfig());
  pluginCmd.command('validate <path>').description('Validate a plugin or marketplace manifest').addOption(coworkOption()).action(async (manifestPath: string, options: {
    cowork?: boolean;
  }) => {
    const {
      pluginValidateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginValidateHandler(manifestPath, options);
  });

  // Plugin list command
  pluginCmd.command('list').description('List installed plugins').option('--json', 'Output as JSON').option('--available', 'Include available plugins from marketplaces (requires --json)').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    available?: boolean;
    cowork?: boolean;
  }) => {
    const {
      pluginListHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginListHandler(options);
  });

  // Marketplace subcommands
  const marketplaceCmd = pluginCmd.command('marketplace').description('Manage Claude Code marketplaces').configureHelp(createSortedHelpConfig());
  marketplaceCmd.command('add <source>').description('Add a marketplace from a URL, path, or GitHub repo').addOption(coworkOption()).option('--sparse <paths...>', 'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins').option('--scope <scope>', 'Where to declare the marketplace: user (default), project, or local').action(async (source: string, options: {
    cowork?: boolean;
    sparse?: string[];
    scope?: string;
  }) => {
    const {
      marketplaceAddHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceAddHandler(source, options);
  });
  marketplaceCmd.command('list').description('List all configured marketplaces').option('--json', 'Output as JSON').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    cowork?: boolean;
  }) => {
    const {
      marketplaceListHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceListHandler(options);
  });
  marketplaceCmd.command('remove <name>').alias('rm').description('Remove a configured marketplace').addOption(coworkOption()).action(async (name: string, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceRemoveHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceRemoveHandler(name, options);
  });
  marketplaceCmd.command('update [name]').description('Update marketplace(s) from their source - updates all if no name specified').addOption(coworkOption()).action(async (name: string | undefined, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceUpdateHandler(name, options);
  });

  // Plugin install command
  pluginCmd.command('install <plugin>').alias('i').description('Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)').option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user').addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginInstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginInstallHandler(plugin, options);
  });

  // Plugin uninstall command
  pluginCmd.command('uninstall <plugin>').alias('remove').alias('rm').description('Uninstall an installed plugin').option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user').option('--keep-data', "Preserve the plugin's persistent data directory (~/.openclaude/plugins/data/{id}/)").addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
    keepData?: boolean;
  }) => {
    const {
      pluginUninstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUninstallHandler(plugin, options);
  });

  // Plugin enable command
  pluginCmd.command('enable <plugin>').description('Enable a disabled plugin').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginEnableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginEnableHandler(plugin, options);
  });

  // Plugin disable command
  pluginCmd.command('disable [plugin]').description('Disable an enabled plugin').option('-a, --all', 'Disable all enabled plugins').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string | undefined, options: {
    scope?: string;
    cowork?: boolean;
    all?: boolean;
  }) => {
    const {
      pluginDisableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginDisableHandler(plugin, options);
  });

  // Plugin update command
  pluginCmd.command('update <plugin>').description('Update a plugin to the latest version (restart required to apply)').option('-s, --scope <scope>', `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUpdateHandler(plugin, options);
  });
  // END ANT-ONLY

  // Setup token command
  program.command('setup-token').description('Set up a long-lived authentication token (requires Claude subscription)').action(async () => {
    const [{
      setupTokenHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await setupTokenHandler(root);
  });

  // Agents command - list configured agents
  program.command('agents').description('List configured agents').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).').action(async () => {
    const {
      agentsHandler
    } = await import('./cli/handlers/agents.js');
    await agentsHandler();
    process.exit(0);
  });
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Skip when tengu_auto_mode_config.enabled === 'disabled' (circuit breaker).
    // Reads from disk cache — GrowthBook isn't initialized at registration time.
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration');
      autoModeCmd.command('defaults').description('Print the default auto mode environment, allow, and deny rules as JSON').action(async () => {
        const {
          autoModeDefaultsHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeDefaultsHandler();
        process.exit(0);
      });
      autoModeCmd.command('config').description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise').action(async () => {
        const {
          autoModeConfigHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeConfigHandler();
        process.exit(0);
      });
      autoModeCmd.command('critique').description('Get AI feedback on your custom auto mode rules').option('--model <model>', 'Override which model is used').action(async options => {
        const {
          autoModeCritiqueHandler
        } = await import('./cli/handlers/autoMode.js');
        await autoModeCritiqueHandler(options);
        process.exit();
      });
    }
  }

  // Remote Control command — connect local environment to claude.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw inside isClaudeAISubscriber → getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program.command('remote-control', {
      hidden: true
    }).alias('rc').description('Connect your local environment for remote-control sessions via claude.ai/code').action(async () => {
      // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
      // If somehow reached, delegate to bridgeMain.
      const {
        bridgeMain
      } = await import('./bridge/bridgeMain.js');
      await bridgeMain(process.argv.slice(3));
    });
  }
  if (feature('KAIROS')) {
    program.command('assistant [sessionId]').description('Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.').action(() => {
      // Argv rewriting above should have consumed `assistant [id]`
      // before commander runs. Reaching here means a root flag came first
      // (e.g. `--debug assistant`) and the position-0 predicate
      // didn't match. Print usage like the ssh stub does.
      process.stderr.write('Usage: openclaude assistant [sessionId]\n\n' + 'Attach the REPL as a viewer client to a running bridge session.\n' + 'Omit sessionId to discover and pick from available sessions.\n');
      process.exit(1);
    });
  }

  // Doctor command - check installation health
  program.command('doctor').description('Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const [{
      doctorHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await doctorHandler(root);
  });

  // claude update
  //
  // For SemVer-compliant versioning with build metadata (X.X.X+SHA):
  // - We perform exact string comparison (including SHA) to detect any change
  // - This ensures users always get the latest build, even when only the SHA changes
  // - UI shows both versions including build metadata for clarity
  program.command('update').alias('upgrade').description('Check for updates and install if available').action(async () => {
    const {
      update
    } = await import('src/cli/update.js');
    await update();
  });

  // claude up — run the project's CLAUDE.md "# claude up" setup instructions.
  if ("external" === 'ant') {
    program.command('up').description('[ANT-ONLY] Initialize or upgrade the local dev environment using the "# claude up" section of the nearest CLAUDE.md').action(async () => {
      const {
        up
      } = await import('src/cli/up.js');
      await up();
    });
  }

  // openclaude rollback (ant-only)
  // Rolls back to previous releases
  if ("external" === 'ant') {
    program.command('rollback [target]').description('[ANT-ONLY] Roll back to a previous release\n\nExamples:\n  openclaude rollback                                Go 1 version back from current\n  openclaude rollback 3                              Go 3 versions back from current\n  openclaude rollback 2.0.73-dev.20251217.t190658    Roll back to a specific version').option('-l, --list', 'List recent published versions with ages').option('--dry-run', 'Show what would be installed without installing').option('--safe', 'Roll back to the server-pinned safe version (set by oncall during incidents)').action(async (target?: string, options?: {
      list?: boolean;
      dryRun?: boolean;
      safe?: boolean;
    }) => {
      const {
        rollback
      } = await import('src/cli/rollback.js');
      await rollback(target, options);
    });
  }

  // claude install
  program.command('install [target]').description('Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)').option('--force', 'Force installation even if already installed').action(async (target: string | undefined, options: {
    force?: boolean;
  }) => {
    const {
      installHandler
    } = await import('./cli/handlers/util.js');
    await installHandler(target, options);
  });

  // ant-only commands
  if ("external" === 'ant') {
    const validateLogId = (value: string) => {
      const maybeSessionId = validateUuid(value);
      if (maybeSessionId) return maybeSessionId;
      return Number(value);
    };
    // claude log
    program.command('log').description('[ANT-ONLY] Manage conversation logs.').argument('[number|sessionId]', 'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log', validateLogId).action(async (logId: string | number | undefined) => {
      const {
        logHandler
      } = await import('./cli/handlers/ant.js');
      await logHandler(logId);
    });

    // claude error
    program.command('error').description('[ANT-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.').argument('[number]', 'A number (0, 1, 2, etc.) to display a specific log', parseInt).action(async (number: number | undefined) => {
      const {
        errorHandler
      } = await import('./cli/handlers/ant.js');
      await errorHandler(number);
    });

    // claude export
    program.command('export').description('[ANT-ONLY] Export a conversation to a text file.').usage('<source> <outputFile>').argument('<source>', 'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file').argument('<outputFile>', 'Output file path for the exported text').addHelpText('after', `
Examples:
  $ claude export 0 conversation.txt                Export conversation at log index 0
  $ claude export <uuid> conversation.txt           Export conversation by session ID
  $ claude export input.json output.txt             Render JSON log file to text
  $ claude export <uuid>.jsonl output.txt           Render JSONL session file to text`).action(async (source: string, outputFile: string) => {
      const {
        exportHandler
      } = await import('./cli/handlers/ant.js');
      await exportHandler(source, outputFile);
    });
    if ("external" === 'ant') {
      const taskCmd = program.command('task').description('[ANT-ONLY] Manage task list tasks');
      taskCmd.command('create <subject>').description('Create a new task').option('-d, --description <text>', 'Task description').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (subject: string, opts: {
        description?: string;
        list?: string;
      }) => {
        const {
          taskCreateHandler
        } = await import('./cli/handlers/ant.js');
        await taskCreateHandler(subject, opts);
      });
      taskCmd.command('list').description('List all tasks').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').option('--pending', 'Show only pending tasks').option('--json', 'Output as JSON').action(async (opts: {
        list?: string;
        pending?: boolean;
        json?: boolean;
      }) => {
        const {
          taskListHandler
        } = await import('./cli/handlers/ant.js');
        await taskListHandler(opts);
      });
      taskCmd.command('get <id>').description('Get details of a task').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (id: string, opts: {
        list?: string;
      }) => {
        const {
          taskGetHandler
        } = await import('./cli/handlers/ant.js');
        await taskGetHandler(id, opts);
      });
      taskCmd.command('update <id>').description('Update a task').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').option('-s, --status <status>', `Set status (${TASK_STATUSES.join(', ')})`).option('--subject <text>', 'Update subject').option('-d, --description <text>', 'Update description').option('--owner <agentId>', 'Set owner').option('--clear-owner', 'Clear owner').action(async (id: string, opts: {
        list?: string;
        status?: string;
        subject?: string;
        description?: string;
        owner?: string;
        clearOwner?: boolean;
      }) => {
        const {
          taskUpdateHandler
        } = await import('./cli/handlers/ant.js');
        await taskUpdateHandler(id, opts);
      });
      taskCmd.command('dir').description('Show the tasks directory path').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (opts: {
        list?: string;
      }) => {
        const {
          taskDirHandler
        } = await import('./cli/handlers/ant.js');
        await taskDirHandler(opts);
      });
    }

    // claude completion <shell>
    program.command('completion <shell>', {
      hidden: true
    }).description('Generate shell completion script (bash, zsh, or fish)').option('--output <file>', 'Write completion script directly to a file instead of stdout').action(async (shell: string, opts: {
      output?: string;
    }) => {
      const {
        completionHandler
      } = await import('./cli/handlers/ant.js');
      await completionHandler(shell, opts, program);
    });
  }
  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // Record final checkpoint for total_time calculation
  profileCheckpoint('main_after_run');

  // Log startup perf to Statsig (sampled) and output detailed report if enabled
  profileReport();
  return program;
}
async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath
}: {
  hasInitialPrompt: boolean;
  hasStdin: boolean;
  verbose: boolean;
  debug: boolean;
  debugToStderr: boolean;
  print: boolean;
  outputFormat: string;
  inputFormat: string;
  numAllowedTools: number;
  numDisallowedTools: number;
  mcpClientCount: number;
  worktreeEnabled: boolean;
  skipWebFetchPreflight: boolean | undefined;
  githubActionInputs: string | undefined;
  dangerouslySkipPermissionsPassed: boolean;
  permissionMode: string;
  modeIsBypass: boolean;
  allowDangerouslySkipPermissionsPassed: boolean;
  systemPromptFlag: 'file' | 'flag' | undefined;
  appendSystemPromptFlag: 'file' | 'flag' | undefined;
  thinkingConfig: ThinkingConfig;
  assistantActivationPath: string | undefined;
}): Promise<void> {
  try {
    logEvent('tengu_init', {
      entrypoint: 'claude' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat: outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat: inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs: githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode: permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType: thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(systemPromptFlag && {
        systemPromptFlag: systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag: appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator: feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode() ? true : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath: assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ?? 'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...("external" === 'ant' ? (() => {
        const cwd = getCwd();
        const gitRoot = findGitRoot(cwd);
        const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined;
        return rp ? {
          relativeProjectPath: rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        } : {};
      })() : {})
    });
  } catch (error) {
    logError(error);
  }
}
function maybeActivateProactive(options: unknown): void {
  if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
    proactive?: boolean;
  }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js');
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command');
    }
  }
}
function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return;
  const briefFlag = (options as {
    brief?: boolean;
  }).brief;
  const briefEnv = isEnvTruthy(process.env.CLAUDE_CODE_BRIEF);
  if (!briefFlag && !briefEnv) return;
  // --brief / CLAUDE_CODE_BRIEF are explicit opt-ins: check entitlement,
  // then set userMsgOptIn to activate the tool + prompt section. The env
  // var also grants entitlement (isBriefEntitled() reads it), so setting
  // CLAUDE_CODE_BRIEF=1 alone force-enables for dev/testing — no GB gate
  // needed. initialIsBriefOnly reads getUserMsgOptIn() directly.
  // Conditional require: static import would leak the tool name string
  // into external builds via BriefTool.ts → prompt.ts.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    isBriefEntitled
  } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled();
  if (entitled) {
    setUserMsgOptIn(true);
  }
  // Fire unconditionally once intent is seen: enabled=false captures the
  // "user tried but was gated" failure mode in Datadog.
  logEvent('tengu_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv ? 'env' : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
}
function resetCursor() {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  terminal?.write(SHOW_CURSOR);
}
type TeammateOptions = {
  agentId?: string;
  agentName?: string;
  teamName?: string;
  agentColor?: string;
  planModeRequired?: boolean;
  parentSessionId?: string;
  teammateMode?: 'auto' | 'tmux' | 'in-process';
  agentType?: string;
};
function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const opts = options as Record<string, unknown>;
  const teammateMode = opts.teammateMode;
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode: teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJwcm9maWxlQ2hlY2twb2ludCIsInByb2ZpbGVSZXBvcnQiLCJzdGFydE1kbVJhd1JlYWQiLCJlbnN1cmVLZXljaGFpblByZWZldGNoQ29tcGxldGVkIiwic3RhcnRLZXljaGFpblByZWZldGNoIiwiZmVhdHVyZSIsIkNvbW1hbmQiLCJDb21tYW5kZXJDb21tYW5kIiwiSW52YWxpZEFyZ3VtZW50RXJyb3IiLCJPcHRpb24iLCJjaGFsayIsInJlYWRGaWxlU3luYyIsIm1hcFZhbHVlcyIsInBpY2tCeSIsInVuaXFCeSIsIlJlYWN0IiwiZ2V0T2F1dGhDb25maWciLCJnZXRSZW1vdGVTZXNzaW9uVXJsIiwiZ2V0U3lzdGVtQ29udGV4dCIsImdldFVzZXJDb250ZXh0IiwiaW5pdCIsImluaXRpYWxpemVUZWxlbWV0cnlBZnRlclRydXN0IiwiYWRkVG9IaXN0b3J5IiwiUm9vdCIsImxhdW5jaFJlcGwiLCJoYXNHcm93dGhCb29rRW52T3ZlcnJpZGUiLCJpbml0aWFsaXplR3Jvd3RoQm9vayIsInJlZnJlc2hHcm93dGhCb29rQWZ0ZXJBdXRoQ2hhbmdlIiwiZmV0Y2hCb290c3RyYXBEYXRhIiwiRG93bmxvYWRSZXN1bHQiLCJkb3dubG9hZFNlc3Npb25GaWxlcyIsIkZpbGVzQXBpQ29uZmlnIiwicGFyc2VGaWxlU3BlY3MiLCJwcmVmZXRjaFBhc3Nlc0VsaWdpYmlsaXR5IiwicHJlZmV0Y2hPZmZpY2lhbE1jcFVybHMiLCJNY3BTZGtTZXJ2ZXJDb25maWciLCJNY3BTZXJ2ZXJDb25maWciLCJTY29wZWRNY3BTZXJ2ZXJDb25maWciLCJpc1BvbGljeUFsbG93ZWQiLCJsb2FkUG9saWN5TGltaXRzIiwicmVmcmVzaFBvbGljeUxpbWl0cyIsIndhaXRGb3JQb2xpY3lMaW1pdHNUb0xvYWQiLCJsb2FkUmVtb3RlTWFuYWdlZFNldHRpbmdzIiwicmVmcmVzaFJlbW90ZU1hbmFnZWRTZXR0aW5ncyIsIlRvb2xJbnB1dEpTT05TY2hlbWEiLCJjcmVhdGVTeW50aGV0aWNPdXRwdXRUb29sIiwiaXNTeW50aGV0aWNPdXRwdXRUb29sRW5hYmxlZCIsImdldFRvb2xzIiwiY2FuVXNlckNvbmZpZ3VyZUFkdmlzb3IiLCJnZXRJbml0aWFsQWR2aXNvclNldHRpbmciLCJpc0Fkdmlzb3JFbmFibGVkIiwiaXNWYWxpZEFkdmlzb3JNb2RlbCIsIm1vZGVsU3VwcG9ydHNBZHZpc29yIiwiaXNBZ2VudFN3YXJtc0VuYWJsZWQiLCJjb3VudCIsInVuaXEiLCJpbnN0YWxsQXNjaWljYXN0UmVjb3JkZXIiLCJnZXRTdWJzY3JpcHRpb25UeXBlIiwiaXNDbGF1ZGVBSVN1YnNjcmliZXIiLCJwcmVmZXRjaEF3c0NyZWRlbnRpYWxzQW5kQmVkUm9ja0luZm9JZlNhZmUiLCJwcmVmZXRjaEdjcENyZWRlbnRpYWxzSWZTYWZlIiwidmFsaWRhdGVGb3JjZUxvZ2luT3JnIiwiY2hlY2tIYXNUcnVzdERpYWxvZ0FjY2VwdGVkIiwiZ2V0R2xvYmFsQ29uZmlnIiwiZ2V0UmVtb3RlQ29udHJvbEF0U3RhcnR1cCIsImlzQXV0b1VwZGF0ZXJEaXNhYmxlZCIsInNhdmVHbG9iYWxDb25maWciLCJzZWVkRWFybHlJbnB1dCIsInN0b3BDYXB0dXJpbmdFYXJseUlucHV0IiwiZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmciLCJwYXJzZUVmZm9ydFZhbHVlIiwiZ2V0SW5pdGlhbEZhc3RNb2RlU2V0dGluZyIsImlzRmFzdE1vZGVFbmFibGVkIiwicHJlZmV0Y2hGYXN0TW9kZVN0YXR1cyIsInJlc29sdmVGYXN0TW9kZVN0YXR1c0Zyb21DYWNoZSIsImFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMiLCJjcmVhdGVTeXN0ZW1NZXNzYWdlIiwiY3JlYXRlVXNlck1lc3NhZ2UiLCJnZXRQbGF0Zm9ybSIsImdldEJhc2VSZW5kZXJPcHRpb25zIiwiZ2V0U2Vzc2lvbkluZ3Jlc3NBdXRoVG9rZW4iLCJzZXR0aW5nc0NoYW5nZURldGVjdG9yIiwic2tpbGxDaGFuZ2VEZXRlY3RvciIsImpzb25QYXJzZSIsIndyaXRlRmlsZVN5bmNfREVQUkVDQVRFRCIsImNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQiLCJpbml0aWFsaXplV2FybmluZ0hhbmRsZXIiLCJpc1dvcmt0cmVlTW9kZUVuYWJsZWQiLCJnZXRUZWFtbWF0ZVV0aWxzIiwicmVxdWlyZSIsImdldFRlYW1tYXRlUHJvbXB0QWRkZW5kdW0iLCJnZXRUZWFtbWF0ZU1vZGVTbmFwc2hvdCIsImNvb3JkaW5hdG9yTW9kZU1vZHVsZSIsImFzc2lzdGFudE1vZHVsZSIsImthaXJvc0dhdGUiLCJyZWxhdGl2ZSIsInJlc29sdmUiLCJpc0FuYWx5dGljc0Rpc2FibGVkIiwiZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUiLCJBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTIiwibG9nRXZlbnQiLCJpbml0aWFsaXplQW5hbHl0aWNzR2F0ZXMiLCJnZXRPcmlnaW5hbEN3ZCIsInNldEFkZGl0aW9uYWxEaXJlY3Rvcmllc0ZvckNsYXVkZU1kIiwic2V0SXNSZW1vdGVNb2RlIiwic2V0TWFpbkxvb3BNb2RlbE92ZXJyaWRlIiwic2V0TWFpblRocmVhZEFnZW50VHlwZSIsInNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyIsImZpbHRlckNvbW1hbmRzRm9yUmVtb3RlTW9kZSIsImdldENvbW1hbmRzIiwiU3RhdHNTdG9yZSIsImxhdW5jaEFzc2lzdGFudEluc3RhbGxXaXphcmQiLCJsYXVuY2hBc3Npc3RhbnRTZXNzaW9uQ2hvb3NlciIsImxhdW5jaEludmFsaWRTZXR0aW5nc0RpYWxvZyIsImxhdW5jaFJlc3VtZUNob29zZXIiLCJsYXVuY2hTbmFwc2hvdFVwZGF0ZURpYWxvZyIsImxhdW5jaFRlbGVwb3J0UmVwb01pc21hdGNoRGlhbG9nIiwibGF1bmNoVGVsZXBvcnRSZXN1bWVXcmFwcGVyIiwiU0hPV19DVVJTT1IiLCJleGl0V2l0aEVycm9yIiwiZXhpdFdpdGhNZXNzYWdlIiwiZ2V0UmVuZGVyQ29udGV4dCIsInJlbmRlckFuZFJ1biIsInNob3dTZXR1cFNjcmVlbnMiLCJpbml0QnVpbHRpblBsdWdpbnMiLCJjaGVja1F1b3RhU3RhdHVzIiwiZ2V0TWNwVG9vbHNDb21tYW5kc0FuZFJlc291cmNlcyIsInByZWZldGNoQWxsTWNwUmVzb3VyY2VzIiwiVkFMSURfSU5TVEFMTEFCTEVfU0NPUEVTIiwiVkFMSURfVVBEQVRFX1NDT1BFUyIsImluaXRCdW5kbGVkU2tpbGxzIiwiQWdlbnRDb2xvck5hbWUiLCJnZXRBY3RpdmVBZ2VudHNGcm9tTGlzdCIsImdldEFnZW50RGVmaW5pdGlvbnNXaXRoT3ZlcnJpZGVzIiwiaXNCdWlsdEluQWdlbnQiLCJpc0N1c3RvbUFnZW50IiwicGFyc2VBZ2VudHNGcm9tSnNvbiIsIkxvZ09wdGlvbiIsIk1lc3NhZ2UiLCJNZXNzYWdlVHlwZSIsImFzc2VydE1pblZlcnNpb24iLCJDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlQiLCJDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlRfV0lUSF9XRUJCUk9XU0VSIiwic2V0dXBDbGF1ZGVJbkNocm9tZSIsInNob3VsZEF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSIsInNob3VsZEVuYWJsZUNsYXVkZUluQ2hyb21lIiwiZ2V0Q29udGV4dFdpbmRvd0Zvck1vZGVsIiwibG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZSIsImJ1aWxkRGVlcExpbmtCYW5uZXIiLCJoYXNOb2RlT3B0aW9uIiwiaXNCYXJlTW9kZSIsImlzRW52VHJ1dGh5IiwiaXNJblByb3RlY3RlZE5hbWVzcGFjZSIsInJlZnJlc2hFeGFtcGxlQ29tbWFuZHMiLCJGcHNNZXRyaWNzIiwiZ2V0V29ya3RyZWVQYXRocyIsImZpbmRHaXRSb290IiwiZ2V0QnJhbmNoIiwiZ2V0SXNHaXQiLCJnZXRXb3JrdHJlZUNvdW50IiwiZ2V0R2hBdXRoU3RhdHVzIiwic2FmZVBhcnNlSlNPTiIsImxvZ0Vycm9yIiwiZ2V0TW9kZWxEZXByZWNhdGlvbldhcm5pbmciLCJnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCIsImdldFVzZXJTcGVjaWZpZWRNb2RlbFNldHRpbmciLCJub3JtYWxpemVNb2RlbFN0cmluZ0ZvckFQSSIsInBhcnNlVXNlclNwZWNpZmllZE1vZGVsIiwiZW5zdXJlTW9kZWxTdHJpbmdzSW5pdGlhbGl6ZWQiLCJQRVJNSVNTSU9OX01PREVTIiwiY2hlY2tBbmREaXNhYmxlQnlwYXNzUGVybWlzc2lvbnMiLCJnZXRBdXRvTW9kZUVuYWJsZWRTdGF0ZUlmQ2FjaGVkIiwiaW5pdGlhbGl6ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCIsImluaXRpYWxQZXJtaXNzaW9uTW9kZUZyb21DTEkiLCJpc0RlZmF1bHRQZXJtaXNzaW9uTW9kZUF1dG8iLCJwYXJzZVRvb2xMaXN0RnJvbUNMSSIsInJlbW92ZURhbmdlcm91c1Blcm1pc3Npb25zIiwic3RyaXBEYW5nZXJvdXNQZXJtaXNzaW9uc0ZvckF1dG9Nb2RlIiwidmVyaWZ5QXV0b01vZGVHYXRlQWNjZXNzIiwiY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQiLCJpbml0aWFsaXplVmVyc2lvbmVkUGx1Z2lucyIsImdldE1hbmFnZWRQbHVnaW5OYW1lcyIsImdldEdsb2JFeGNsdXNpb25zRm9yUGx1Z2luQ2FjaGUiLCJnZXRQbHVnaW5TZWVkRGlycyIsImNvdW50RmlsZXNSb3VuZGVkUmciLCJwcm9jZXNzU2Vzc2lvblN0YXJ0SG9va3MiLCJwcm9jZXNzU2V0dXBIb29rcyIsImNhY2hlU2Vzc2lvblRpdGxlIiwiZ2V0U2Vzc2lvbklkRnJvbUxvZyIsImxvYWRUcmFuc2NyaXB0RnJvbUZpbGUiLCJzYXZlQWdlbnRTZXR0aW5nIiwic2F2ZU1vZGUiLCJzZWFyY2hTZXNzaW9uc0J5Q3VzdG9tVGl0bGUiLCJzZXNzaW9uSWRFeGlzdHMiLCJlbnN1cmVNZG1TZXR0aW5nc0xvYWRlZCIsImdldEluaXRpYWxTZXR0aW5ncyIsImdldE1hbmFnZWRTZXR0aW5nc0tleXNGb3JMb2dnaW5nIiwiZ2V0U2V0dGluZ3NGb3JTb3VyY2UiLCJnZXRTZXR0aW5nc1dpdGhFcnJvcnMiLCJyZXNldFNldHRpbmdzQ2FjaGUiLCJWYWxpZGF0aW9uRXJyb3IiLCJERUZBVUxUX1RBU0tTX01PREVfVEFTS19MSVNUX0lEIiwiVEFTS19TVEFUVVNFUyIsImxvZ1BsdWdpbkxvYWRFcnJvcnMiLCJsb2dQbHVnaW5zRW5hYmxlZEZvclNlc3Npb24iLCJsb2dTa2lsbHNMb2FkZWQiLCJnZW5lcmF0ZVRlbXBGaWxlUGF0aCIsInZhbGlkYXRlVXVpZCIsInJlZ2lzdGVyTWNwQWRkQ29tbWFuZCIsInJlZ2lzdGVyTWNwWGFhSWRwQ29tbWFuZCIsImxvZ1Blcm1pc3Npb25Db250ZXh0Rm9yQW50cyIsImZldGNoQ2xhdWRlQUlNY3BDb25maWdzSWZFbGlnaWJsZSIsImNsZWFyU2VydmVyQ2FjaGUiLCJhcmVNY3BDb25maWdzQWxsb3dlZFdpdGhFbnRlcnByaXNlTWNwQ29uZmlnIiwiZGVkdXBDbGF1ZGVBaU1jcFNlcnZlcnMiLCJkb2VzRW50ZXJwcmlzZU1jcENvbmZpZ0V4aXN0IiwiZmlsdGVyTWNwU2VydmVyc0J5UG9saWN5IiwiZ2V0Q2xhdWRlQ29kZU1jcENvbmZpZ3MiLCJnZXRNY3BTZXJ2ZXJTaWduYXR1cmUiLCJwYXJzZU1jcENvbmZpZyIsInBhcnNlTWNwQ29uZmlnRnJvbUZpbGVQYXRoIiwiZXhjbHVkZUNvbW1hbmRzQnlTZXJ2ZXIiLCJleGNsdWRlUmVzb3VyY2VzQnlTZXJ2ZXIiLCJpc1hhYUVuYWJsZWQiLCJnZXRSZWxldmFudFRpcHMiLCJsb2dDb250ZXh0TWV0cmljcyIsIkNMQVVERV9JTl9DSFJPTUVfTUNQX1NFUlZFUl9OQU1FIiwiaXNDbGF1ZGVJbkNocm9tZU1DUFNlcnZlciIsInJlZ2lzdGVyQ2xlYW51cCIsImVhZ2VyUGFyc2VDbGlGbGFnIiwiY3JlYXRlRW1wdHlBdHRyaWJ1dGlvblN0YXRlIiwiY291bnRDb25jdXJyZW50U2Vzc2lvbnMiLCJyZWdpc3RlclNlc3Npb24iLCJ1cGRhdGVTZXNzaW9uTmFtZSIsImdldEN3ZCIsImxvZ0ZvckRlYnVnZ2luZyIsInNldEhhc0Zvcm1hdHRlZE91dHB1dCIsImVycm9yTWVzc2FnZSIsImdldEVycm5vQ29kZSIsImlzRU5PRU5UIiwiVGVsZXBvcnRPcGVyYXRpb25FcnJvciIsInRvRXJyb3IiLCJnZXRGc0ltcGxlbWVudGF0aW9uIiwic2FmZVJlc29sdmVQYXRoIiwiZ3JhY2VmdWxTaHV0ZG93biIsImdyYWNlZnVsU2h1dGRvd25TeW5jIiwic2V0QWxsSG9va0V2ZW50c0VuYWJsZWQiLCJyZWZyZXNoTW9kZWxDYXBhYmlsaXRpZXMiLCJwZWVrRm9yU3RkaW5EYXRhIiwid3JpdGVUb1N0ZGVyciIsInNldEN3ZCIsIlByb2Nlc3NlZFJlc3VtZSIsInByb2Nlc3NSZXN1bWVkQ29udmVyc2F0aW9uIiwicGFyc2VTZXR0aW5nU291cmNlc0ZsYWciLCJwbHVyYWwiLCJDaGFubmVsRW50cnkiLCJnZXRJbml0aWFsTWFpbkxvb3BNb2RlbCIsImdldElzTm9uSW50ZXJhY3RpdmVTZXNzaW9uIiwiZ2V0U2RrQmV0YXMiLCJnZXRTZXNzaW9uSWQiLCJnZXRVc2VyTXNnT3B0SW4iLCJzZXRBbGxvd2VkQ2hhbm5lbHMiLCJzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMiLCJzZXRDaHJvbWVGbGFnT3ZlcnJpZGUiLCJzZXRDbGllbnRUeXBlIiwic2V0Q3dkU3RhdGUiLCJzZXREaXJlY3RDb25uZWN0U2VydmVyVXJsIiwic2V0RmxhZ1NldHRpbmdzUGF0aCIsInNldEluaXRpYWxNYWluTG9vcE1vZGVsIiwic2V0SW5saW5lUGx1Z2lucyIsInNldElzSW50ZXJhY3RpdmUiLCJzZXRLYWlyb3NBY3RpdmUiLCJzZXRPcmlnaW5hbEN3ZCIsInNldFF1ZXN0aW9uUHJldmlld0Zvcm1hdCIsInNldFNka0JldGFzIiwic2V0U2Vzc2lvbkJ5cGFzc1Blcm1pc3Npb25zTW9kZSIsInNldFNlc3Npb25QZXJzaXN0ZW5jZURpc2FibGVkIiwic2V0U2Vzc2lvblNvdXJjZSIsInNldFVzZXJNc2dPcHRJbiIsInN3aXRjaFNlc3Npb24iLCJhdXRvTW9kZVN0YXRlTW9kdWxlIiwibWlncmF0ZUF1dG9VcGRhdGVzVG9TZXR0aW5ncyIsIm1pZ3JhdGVCeXBhc3NQZXJtaXNzaW9uc0FjY2VwdGVkVG9TZXR0aW5ncyIsIm1pZ3JhdGVFbmFibGVBbGxQcm9qZWN0TWNwU2VydmVyc1RvU2V0dGluZ3MiLCJtaWdyYXRlRmVubmVjVG9PcHVzIiwibWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQiLCJtaWdyYXRlT3B1c1RvT3B1czFtIiwibWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwIiwibWlncmF0ZVNvbm5ldDFtVG9Tb25uZXQ0NSIsIm1pZ3JhdGVTb25uZXQ0NVRvU29ubmV0NDYiLCJyZXNldEF1dG9Nb2RlT3B0SW5Gb3JEZWZhdWx0T2ZmZXIiLCJyZXNldFByb1RvT3B1c0RlZmF1bHQiLCJjcmVhdGVSZW1vdGVTZXNzaW9uQ29uZmlnIiwiY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24iLCJEaXJlY3RDb25uZWN0RXJyb3IiLCJpbml0aWFsaXplTHNwU2VydmVyTWFuYWdlciIsInNob3VsZEVuYWJsZVByb21wdFN1Z2dlc3Rpb24iLCJBcHBTdGF0ZSIsImdldERlZmF1bHRBcHBTdGF0ZSIsIklETEVfU1BFQ1VMQVRJT05fU1RBVEUiLCJvbkNoYW5nZUFwcFN0YXRlIiwiY3JlYXRlU3RvcmUiLCJhc1Nlc3Npb25JZCIsImZpbHRlckFsbG93ZWRTZGtCZXRhcyIsImlzSW5CdW5kbGVkTW9kZSIsImlzUnVubmluZ1dpdGhCdW4iLCJsb2dGb3JEaWFnbm9zdGljc05vUElJIiwiZmlsdGVyRXhpc3RpbmdQYXRocyIsImdldEtub3duUGF0aHNGb3JSZXBvIiwiY2xlYXJQbHVnaW5DYWNoZSIsImxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5IiwibWlncmF0ZUNoYW5nZWxvZ0Zyb21Db25maWciLCJTYW5kYm94TWFuYWdlciIsImZldGNoU2Vzc2lvbiIsInByZXBhcmVBcGlSZXF1ZXN0IiwiY2hlY2tPdXRUZWxlcG9ydGVkU2Vzc2lvbkJyYW5jaCIsInByb2Nlc3NNZXNzYWdlc0ZvclRlbGVwb3J0UmVzdW1lIiwidGVsZXBvcnRUb1JlbW90ZVdpdGhFcnJvckhhbmRsaW5nIiwidmFsaWRhdGVHaXRTdGF0ZSIsInZhbGlkYXRlU2Vzc2lvblJlcG9zaXRvcnkiLCJzaG91bGRFbmFibGVUaGlua2luZ0J5RGVmYXVsdCIsIlRoaW5raW5nQ29uZmlnIiwiaW5pdFVzZXIiLCJyZXNldFVzZXJDYWNoZSIsImdldFRtdXhJbnN0YWxsSW5zdHJ1Y3Rpb25zIiwiaXNUbXV4QXZhaWxhYmxlIiwicGFyc2VQUlJlZmVyZW5jZSIsImxvZ01hbmFnZWRTZXR0aW5ncyIsInBvbGljeVNldHRpbmdzIiwiYWxsS2V5cyIsImtleUNvdW50IiwibGVuZ3RoIiwia2V5cyIsImpvaW4iLCJpc0JlaW5nRGVidWdnZWQiLCJpc0J1biIsImhhc0luc3BlY3RBcmciLCJwcm9jZXNzIiwiZXhlY0FyZ3YiLCJzb21lIiwiYXJnIiwidGVzdCIsImhhc0luc3BlY3RFbnYiLCJlbnYiLCJOT0RFX09QVElPTlMiLCJpbnNwZWN0b3IiLCJnbG9iYWwiLCJoYXNJbnNwZWN0b3JVcmwiLCJ1cmwiLCJleGl0IiwibG9nU2Vzc2lvblRlbGVtZXRyeSIsIm1vZGVsIiwidGhlbiIsImVuYWJsZWQiLCJlcnJvcnMiLCJtYW5hZ2VkTmFtZXMiLCJjYXRjaCIsImVyciIsImdldENlcnRFbnZWYXJUZWxlbWV0cnkiLCJSZWNvcmQiLCJyZXN1bHQiLCJOT0RFX0VYVFJBX0NBX0NFUlRTIiwiaGFzX25vZGVfZXh0cmFfY2FfY2VydHMiLCJDTEFVREVfQ09ERV9DTElFTlRfQ0VSVCIsImhhc19jbGllbnRfY2VydCIsImhhc191c2Vfc3lzdGVtX2NhIiwiaGFzX3VzZV9vcGVuc3NsX2NhIiwibG9nU3RhcnR1cFRlbGVtZXRyeSIsIlByb21pc2UiLCJpc0dpdCIsIndvcmt0cmVlQ291bnQiLCJnaEF1dGhTdGF0dXMiLCJhbGwiLCJpc19naXQiLCJ3b3JrdHJlZV9jb3VudCIsImdoX2F1dGhfc3RhdHVzIiwic2FuZGJveF9lbmFibGVkIiwiaXNTYW5kYm94aW5nRW5hYmxlZCIsImFyZV91bnNhbmRib3hlZF9jb21tYW5kc19hbGxvd2VkIiwiYXJlVW5zYW5kYm94ZWRDb21tYW5kc0FsbG93ZWQiLCJpc19hdXRvX2Jhc2hfYWxsb3dlZF9pZl9zYW5kYm94X2VuYWJsZWQiLCJpc0F1dG9BbGxvd0Jhc2hJZlNhbmRib3hlZEVuYWJsZWQiLCJhdXRvX3VwZGF0ZXJfZGlzYWJsZWQiLCJwcmVmZXJzX3JlZHVjZWRfbW90aW9uIiwicHJlZmVyc1JlZHVjZWRNb3Rpb24iLCJDVVJSRU5UX01JR1JBVElPTl9WRVJTSU9OIiwicnVuTWlncmF0aW9ucyIsIm1pZ3JhdGlvblZlcnNpb24iLCJwcmV2IiwicHJlZmV0Y2hTeXN0ZW1Db250ZXh0SWZTYWZlIiwiaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24iLCJoYXNUcnVzdCIsInN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzIiwiQ0xBVURFX0NPREVfRVhJVF9BRlRFUl9GSVJTVF9SRU5ERVIiLCJDTEFVREVfQ09ERV9VU0VfQkVEUk9DSyIsIkNMQVVERV9DT0RFX1NLSVBfQkVEUk9DS19BVVRIIiwiQ0xBVURFX0NPREVfVVNFX1ZFUlRFWCIsIkNMQVVERV9DT0RFX1NLSVBfVkVSVEVYX0FVVEgiLCJBYm9ydFNpZ25hbCIsInRpbWVvdXQiLCJpbml0aWFsaXplIiwibSIsInN0YXJ0RXZlbnRMb29wU3RhbGxEZXRlY3RvciIsImxvYWRTZXR0aW5nc0Zyb21GbGFnIiwic2V0dGluZ3NGaWxlIiwidHJpbW1lZFNldHRpbmdzIiwidHJpbSIsImxvb2tzTGlrZUpzb24iLCJzdGFydHNXaXRoIiwiZW5kc1dpdGgiLCJzZXR0aW5nc1BhdGgiLCJwYXJzZWRKc29uIiwic3RkZXJyIiwid3JpdGUiLCJyZWQiLCJjb250ZW50SGFzaCIsInJlc29sdmVkUGF0aCIsInJlc29sdmVkU2V0dGluZ3NQYXRoIiwiZSIsImVycm9yIiwiRXJyb3IiLCJsb2FkU2V0dGluZ1NvdXJjZXNGcm9tRmxhZyIsInNldHRpbmdTb3VyY2VzQXJnIiwic291cmNlcyIsImVhZ2VyTG9hZFNldHRpbmdzIiwidW5kZWZpbmVkIiwiaW5pdGlhbGl6ZUVudHJ5cG9pbnQiLCJpc05vbkludGVyYWN0aXZlIiwiQ0xBVURFX0NPREVfRU5UUllQT0lOVCIsImNsaUFyZ3MiLCJhcmd2Iiwic2xpY2UiLCJtY3BJbmRleCIsImluZGV4T2YiLCJDTEFVREVfQ09ERV9BQ1RJT04iLCJQZW5kaW5nQ29ubmVjdCIsImF1dGhUb2tlbiIsImRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zIiwiX3BlbmRpbmdDb25uZWN0IiwiUGVuZGluZ0Fzc2lzdGFudENoYXQiLCJzZXNzaW9uSWQiLCJkaXNjb3ZlciIsIl9wZW5kaW5nQXNzaXN0YW50Q2hhdCIsIlBlbmRpbmdTU0giLCJob3N0IiwiY3dkIiwicGVybWlzc2lvbk1vZGUiLCJsb2NhbCIsImV4dHJhQ2xpQXJncyIsIl9wZW5kaW5nU1NIIiwibWFpbiIsIk5vRGVmYXVsdEN1cnJlbnREaXJlY3RvcnlJbkV4ZVBhdGgiLCJvbiIsInJlc2V0Q3Vyc29yIiwiaW5jbHVkZXMiLCJyYXdDbGlBcmdzIiwiY2NJZHgiLCJmaW5kSW5kZXgiLCJhIiwiY2NVcmwiLCJwYXJzZUNvbm5lY3RVcmwiLCJwYXJzZWQiLCJzdHJpcHBlZCIsImZpbHRlciIsIl8iLCJpIiwiZHNwSWR4Iiwic3BsaWNlIiwic2VydmVyVXJsIiwiaGFuZGxlVXJpSWR4IiwiZW5hYmxlQ29uZmlncyIsInVyaSIsImhhbmRsZURlZXBMaW5rVXJpIiwiZXhpdENvZGUiLCJwbGF0Zm9ybSIsIl9fQ0ZCdW5kbGVJZGVudGlmaWVyIiwiaGFuZGxlVXJsU2NoZW1lTGF1bmNoIiwidXJsU2NoZW1lUmVzdWx0IiwicmF3QXJncyIsIm5leHRBcmciLCJsb2NhbElkeCIsInBtSWR4IiwicG1FcUlkeCIsInNwbGl0IiwiZXh0cmFjdEZsYWciLCJmbGFnIiwib3B0cyIsImhhc1ZhbHVlIiwiYXMiLCJwdXNoIiwidmFsIiwiZXFJIiwiY29uc3VtZWQiLCJyZXN0IiwiaGFzUHJpbnRGbGFnIiwiaGFzSW5pdE9ubHlGbGFnIiwiaGFzU2RrVXJsIiwic3Rkb3V0IiwiaXNUVFkiLCJpc0ludGVyYWN0aXZlIiwiY2xpZW50VHlwZSIsIkdJVEhVQl9BQ1RJT05TIiwiaGFzU2Vzc2lvbkluZ3Jlc3NUb2tlbiIsIkNMQVVERV9DT0RFX1NFU1NJT05fQUNDRVNTX1RPS0VOIiwiQ0xBVURFX0NPREVfV0VCU09DS0VUX0FVVEhfRklMRV9ERVNDUklQVE9SIiwicHJldmlld0Zvcm1hdCIsIkNMQVVERV9DT0RFX1FVRVNUSU9OX1BSRVZJRVdfRk9STUFUIiwiQ0xBVURFX0NPREVfRU5WSVJPTk1FTlRfS0lORCIsInJ1biIsImdldElucHV0UHJvbXB0IiwicHJvbXB0IiwiaW5wdXRGb3JtYXQiLCJBc3luY0l0ZXJhYmxlIiwic3RkaW4iLCJzZXRFbmNvZGluZyIsImRhdGEiLCJvbkRhdGEiLCJjaHVuayIsInRpbWVkT3V0Iiwib2ZmIiwiQm9vbGVhbiIsImNyZWF0ZVNvcnRlZEhlbHBDb25maWciLCJzb3J0U3ViY29tbWFuZHMiLCJzb3J0T3B0aW9ucyIsImdldE9wdGlvblNvcnRLZXkiLCJvcHQiLCJsb25nIiwicmVwbGFjZSIsInNob3J0IiwiT2JqZWN0IiwiYXNzaWduIiwiY29uc3QiLCJjb21wYXJlT3B0aW9ucyIsImIiLCJsb2NhbGVDb21wYXJlIiwicHJvZ3JhbSIsImNvbmZpZ3VyZUhlbHAiLCJlbmFibGVQb3NpdGlvbmFsT3B0aW9ucyIsImhvb2siLCJ0aGlzQ29tbWFuZCIsIkNMQVVERV9DT0RFX0RJU0FCTEVfVEVSTUlOQUxfVElUTEUiLCJ0aXRsZSIsImluaXRTaW5rcyIsInBsdWdpbkRpciIsImdldE9wdGlvblZhbHVlIiwiQXJyYXkiLCJpc0FycmF5IiwiZXZlcnkiLCJwIiwidXBsb2FkVXNlclNldHRpbmdzSW5CYWNrZ3JvdW5kIiwibmFtZSIsImRlc2NyaXB0aW9uIiwiYXJndW1lbnQiLCJTdHJpbmciLCJoZWxwT3B0aW9uIiwib3B0aW9uIiwiX3ZhbHVlIiwiYWRkT3B0aW9uIiwiYXJnUGFyc2VyIiwiaGlkZUhlbHAiLCJjaG9pY2VzIiwiTnVtYmVyIiwidmFsdWUiLCJhbW91bnQiLCJpc05hTiIsInRva2VucyIsImlzSW50ZWdlciIsImRlZmF1bHQiLCJ2IiwibiIsImlzRmluaXRlIiwicmF3VmFsdWUiLCJ0b0xvd2VyQ2FzZSIsImFsbG93ZWQiLCJhY3Rpb24iLCJvcHRpb25zIiwiYmFyZSIsIkNMQVVERV9DT0RFX1NJTVBMRSIsImNvbnNvbGUiLCJ3YXJuIiwieWVsbG93Iiwia2Fpcm9zRW5hYmxlZCIsImFzc2lzdGFudFRlYW1Db250ZXh0IiwiQXdhaXRlZCIsIlJldHVyblR5cGUiLCJOb25OdWxsYWJsZSIsImFzc2lzdGFudCIsIm1hcmtBc3Npc3RhbnRGb3JjZWQiLCJpc0Fzc2lzdGFudE1vZGUiLCJhZ2VudElkIiwiaXNBc3Npc3RhbnRGb3JjZWQiLCJpc0thaXJvc0VuYWJsZWQiLCJicmllZiIsImluaXRpYWxpemVBc3Npc3RhbnRUZWFtIiwiZGVidWciLCJkZWJ1Z1RvU3RkZXJyIiwiYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyIsInRvb2xzIiwiYmFzZVRvb2xzIiwiYWxsb3dlZFRvb2xzIiwiZGlzYWxsb3dlZFRvb2xzIiwibWNwQ29uZmlnIiwicGVybWlzc2lvbk1vZGVDbGkiLCJhZGREaXIiLCJmYWxsYmFja01vZGVsIiwiYmV0YXMiLCJpZGUiLCJpbmNsdWRlSG9va0V2ZW50cyIsImluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMiLCJwcmVmaWxsIiwiZmlsZURvd25sb2FkUHJvbWlzZSIsImFnZW50c0pzb24iLCJhZ2VudHMiLCJhZ2VudENsaSIsImFnZW50IiwiQ0xBVURFX0NPREVfQUdFTlQiLCJvdXRwdXRGb3JtYXQiLCJ2ZXJib3NlIiwicHJpbnQiLCJpbml0T25seSIsIm1haW50ZW5hbmNlIiwiZGlzYWJsZVNsYXNoQ29tbWFuZHMiLCJ0YXNrc09wdGlvbiIsInRhc2tzIiwidGFza0xpc3RJZCIsIkNMQVVERV9DT0RFX1RBU0tfTElTVF9JRCIsIndvcmt0cmVlT3B0aW9uIiwid29ya3RyZWUiLCJ3b3JrdHJlZU5hbWUiLCJ3b3JrdHJlZUVuYWJsZWQiLCJ3b3JrdHJlZVBSTnVtYmVyIiwicHJOdW0iLCJ0bXV4RW5hYmxlZCIsInRtdXgiLCJzdG9yZWRUZWFtbWF0ZU9wdHMiLCJUZWFtbWF0ZU9wdGlvbnMiLCJ0ZWFtbWF0ZU9wdHMiLCJleHRyYWN0VGVhbW1hdGVPcHRpb25zIiwiaGFzQW55VGVhbW1hdGVPcHQiLCJhZ2VudE5hbWUiLCJ0ZWFtTmFtZSIsImhhc0FsbFJlcXVpcmVkVGVhbW1hdGVPcHRzIiwic2V0RHluYW1pY1RlYW1Db250ZXh0IiwiY29sb3IiLCJhZ2VudENvbG9yIiwicGxhbk1vZGVSZXF1aXJlZCIsInBhcmVudFNlc3Npb25JZCIsInRlYW1tYXRlTW9kZSIsInNldENsaVRlYW1tYXRlTW9kZU92ZXJyaWRlIiwic2RrVXJsIiwiZWZmZWN0aXZlSW5jbHVkZVBhcnRpYWxNZXNzYWdlcyIsIkNMQVVERV9DT0RFX0lOQ0xVREVfUEFSVElBTF9NRVNTQUdFUyIsIkNMQVVERV9DT0RFX1JFTU9URSIsInRlbGVwb3J0IiwicmVtb3RlT3B0aW9uIiwicmVtb3RlIiwicmVtb3RlQ29udHJvbE9wdGlvbiIsInJlbW90ZUNvbnRyb2wiLCJyYyIsInJlbW90ZUNvbnRyb2xOYW1lIiwiY29udGludWUiLCJyZXN1bWUiLCJmb3JrU2Vzc2lvbiIsInZhbGlkYXRlZFNlc3Npb25JZCIsImZpbGVTcGVjcyIsImZpbGUiLCJzZXNzaW9uVG9rZW4iLCJmaWxlU2Vzc2lvbklkIiwiQ0xBVURFX0NPREVfUkVNT1RFX1NFU1NJT05fSUQiLCJmaWxlcyIsImNvbmZpZyIsImJhc2VVcmwiLCJBTlRIUk9QSUNfQkFTRV9VUkwiLCJCQVNFX0FQSV9VUkwiLCJvYXV0aFRva2VuIiwic3lzdGVtUHJvbXB0Iiwic3lzdGVtUHJvbXB0RmlsZSIsImZpbGVQYXRoIiwiY29kZSIsImFwcGVuZFN5c3RlbVByb21wdCIsImFwcGVuZFN5c3RlbVByb21wdEZpbGUiLCJhZGRlbmR1bSIsIlRFQU1NQVRFX1NZU1RFTV9QUk9NUFRfQURERU5EVU0iLCJtb2RlIiwibm90aWZpY2F0aW9uIiwicGVybWlzc2lvbk1vZGVOb3RpZmljYXRpb24iLCJlbmFibGVBdXRvTW9kZSIsInNldEF1dG9Nb2RlRmxhZ0NsaSIsImR5bmFtaWNNY3BDb25maWciLCJwcm9jZXNzZWRDb25maWdzIiwibWFwIiwiYWxsQ29uZmlncyIsImFsbEVycm9ycyIsImNvbmZpZ0l0ZW0iLCJjb25maWdzIiwiY29uZmlnT2JqZWN0IiwiZXhwYW5kVmFycyIsInNjb3BlIiwibWNwU2VydmVycyIsImNvbmZpZ1BhdGgiLCJmb3JtYXR0ZWRFcnJvcnMiLCJwYXRoIiwibWVzc2FnZSIsImxldmVsIiwibm9uU2RrQ29uZmlnTmFtZXMiLCJlbnRyaWVzIiwidHlwZSIsInJlc2VydmVkTmFtZUVycm9yIiwiaXNDb21wdXRlclVzZU1DUFNlcnZlciIsIkNPTVBVVEVSX1VTRV9NQ1BfU0VSVkVSX05BTUUiLCJzY29wZWRDb25maWdzIiwiYmxvY2tlZCIsImNocm9tZU9wdHMiLCJjaHJvbWUiLCJlbmFibGVDbGF1ZGVJbkNocm9tZSIsImF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSIsImNocm9tZU1jcENvbmZpZyIsImNocm9tZU1jcFRvb2xzIiwiY2hyb21lU3lzdGVtUHJvbXB0IiwiaGludCIsIkJ1biIsInN0cmljdE1jcENvbmZpZyIsImdldENoaWNhZ29FbmFibGVkIiwic2V0dXBDb21wdXRlclVzZU1DUCIsImN1VG9vbHMiLCJkZXZDaGFubmVscyIsInBhcnNlQ2hhbm5lbEVudHJpZXMiLCJyYXciLCJiYWQiLCJjIiwiYXQiLCJraW5kIiwibWFya2V0cGxhY2UiLCJjaGFubmVsT3B0cyIsImNoYW5uZWxzIiwiZGFuZ2Vyb3VzbHlMb2FkRGV2ZWxvcG1lbnRDaGFubmVscyIsInJhd0NoYW5uZWxzIiwicmF3RGV2IiwiY2hhbm5lbEVudHJpZXMiLCJqb2luUGx1Z2luSWRzIiwiaWRzIiwiZmxhdE1hcCIsInNvcnQiLCJjaGFubmVsc19jb3VudCIsImRldl9jb3VudCIsInBsdWdpbnMiLCJkZXZfcGx1Z2lucyIsIkJSSUVGX1RPT0xfTkFNRSIsIkxFR0FDWV9CUklFRl9UT09MX05BTUUiLCJpc0JyaWVmRW50aXRsZWQiLCJpbml0UmVzdWx0IiwiYWxsb3dlZFRvb2xzQ2xpIiwiZGlzYWxsb3dlZFRvb2xzQ2xpIiwiYmFzZVRvb2xzQ2xpIiwiYWRkRGlycyIsInRvb2xQZXJtaXNzaW9uQ29udGV4dCIsIndhcm5pbmdzIiwiZGFuZ2Vyb3VzUGVybWlzc2lvbnMiLCJvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucyIsInBlcm1pc3Npb24iLCJydWxlRGlzcGxheSIsInNvdXJjZURpc3BsYXkiLCJmb3JFYWNoIiwid2FybmluZyIsImNsYXVkZWFpQ29uZmlnUHJvbWlzZSIsIm1jcENvbmZpZ1N0YXJ0IiwiRGF0ZSIsIm5vdyIsIm1jcENvbmZpZ1Jlc29sdmVkTXMiLCJtY3BDb25maWdQcm9taXNlIiwic2VydmVycyIsInJlcGxheVVzZXJNZXNzYWdlcyIsInNlc3Npb25QZXJzaXN0ZW5jZSIsImVmZmVjdGl2ZVByb21wdCIsImlucHV0UHJvbXB0IiwibWF5YmVBY3RpdmF0ZVByb2FjdGl2ZSIsIkNMQVVERV9DT0RFX0NPT1JESU5BVE9SX01PREUiLCJhcHBseUNvb3JkaW5hdG9yVG9vbEZpbHRlciIsImpzb25TY2hlbWEiLCJzeW50aGV0aWNPdXRwdXRSZXN1bHQiLCJ0b29sIiwic2NoZW1hX3Byb3BlcnR5X2NvdW50IiwicHJvcGVydGllcyIsImhhc19yZXF1aXJlZF9maWVsZHMiLCJyZXF1aXJlZCIsInNldHVwU3RhcnQiLCJzZXR1cCIsIm1lc3NhZ2luZ1NvY2tldFBhdGgiLCJwcmVTZXR1cEN3ZCIsInNldHVwUHJvbWlzZSIsImNvbW1hbmRzUHJvbWlzZSIsImFnZW50RGVmc1Byb21pc2UiLCJlZmZlY3RpdmVSZXBsYXlVc2VyTWVzc2FnZXMiLCJzZXNzaW9uTmFtZUFyZyIsImV4cGxpY2l0TW9kZWwiLCJBTlRIUk9QSUNfTU9ERUwiLCJjYWNoZWRHcm93dGhCb29rRmVhdHVyZXMiLCJ1c2VyU3BlY2lmaWVkTW9kZWwiLCJ1c2VyU3BlY2lmaWVkRmFsbGJhY2tNb2RlbCIsImN1cnJlbnRDd2QiLCJjb21tYW5kc1N0YXJ0IiwiY29tbWFuZHMiLCJhZ2VudERlZmluaXRpb25zUmVzdWx0IiwiY2xpQWdlbnRzIiwiYWN0aXZlQWdlbnRzIiwicGFyc2VkQWdlbnRzIiwiYWxsQWdlbnRzIiwiYWdlbnREZWZpbml0aW9ucyIsImFnZW50U2V0dGluZyIsIm1haW5UaHJlYWRBZ2VudERlZmluaXRpb24iLCJmaW5kIiwiYWdlbnRUeXBlIiwic291cmNlIiwiYWdlbnRTeXN0ZW1Qcm9tcHQiLCJnZXRTeXN0ZW1Qcm9tcHQiLCJpbml0aWFsUHJvbXB0IiwiZWZmZWN0aXZlTW9kZWwiLCJpbml0aWFsTWFpbkxvb3BNb2RlbCIsInJlc29sdmVkSW5pdGlhbE1vZGVsIiwiYWR2aXNvck1vZGVsIiwiYWR2aXNvck9wdGlvbiIsImFkdmlzb3IiLCJub3JtYWxpemVkQWR2aXNvck1vZGVsIiwiY3VzdG9tQWdlbnQiLCJjdXN0b21Qcm9tcHQiLCJtZW1vcnkiLCJhZ2VudF90eXBlIiwiY3VzdG9tSW5zdHJ1Y3Rpb25zIiwibWF5YmVBY3RpdmF0ZUJyaWVmIiwiZGVmYXVsdFZpZXciLCJwcm9hY3RpdmUiLCJDTEFVREVfQ09ERV9QUk9BQ1RJVkUiLCJpc0Nvb3JkaW5hdG9yTW9kZSIsImJyaWVmVmlzaWJpbGl0eSIsImlzQnJpZWZFbmFibGVkIiwicHJvYWN0aXZlUHJvbXB0IiwiYXNzaXN0YW50QWRkZW5kdW0iLCJnZXRBc3Npc3RhbnRTeXN0ZW1Qcm9tcHRBZGRlbmR1bSIsInJvb3QiLCJnZXRGcHNNZXRyaWNzIiwic3RhdHMiLCJjdHgiLCJjcmVhdGVSb290IiwicmVuZGVyT3B0aW9ucyIsImV2ZW50IiwiZHVyYXRpb25NcyIsIk1hdGgiLCJyb3VuZCIsInVwdGltZSIsInNldHVwU2NyZWVuc1N0YXJ0Iiwib25ib2FyZGluZ1Nob3duIiwiZ2V0QnJpZGdlRGlzYWJsZWRSZWFzb24iLCJkaXNhYmxlZFJlYXNvbiIsInBlbmRpbmdTbmFwc2hvdFVwZGF0ZSIsImFnZW50RGVmIiwiY2hvaWNlIiwic25hcHNob3RUaW1lc3RhbXAiLCJidWlsZE1lcmdlUHJvbXB0IiwibWVyZ2VQcm9tcHQiLCJjbGVhclRydXN0ZWREZXZpY2VUb2tlbiIsImVucm9sbFRydXN0ZWREZXZpY2UiLCJvcmdWYWxpZGF0aW9uIiwidmFsaWQiLCJub25NY3BFcnJvcnMiLCJtY3BFcnJvck1ldGFkYXRhIiwic2V0dGluZ3NFcnJvcnMiLCJvbkV4aXQiLCJiZ1JlZnJlc2hUaHJvdHRsZU1zIiwibGFzdFByZWZldGNoZWQiLCJzdGFydHVwUHJlZmV0Y2hlZEF0Iiwic2tpcFN0YXJ0dXBQcmVmZXRjaGVzIiwibGFzdFByZWZldGNoZWRJbmZvIiwiY3VycmVudCIsImV4aXN0aW5nTWNwQ29uZmlncyIsImFsbE1jcENvbmZpZ3MiLCJzZGtNY3BDb25maWdzIiwicmVndWxhck1jcENvbmZpZ3MiLCJ0eXBlZENvbmZpZyIsImxvY2FsTWNwUHJvbWlzZSIsImNsaWVudHMiLCJjbGF1ZGVhaU1jcFByb21pc2UiLCJtY3BQcm9taXNlIiwiY2xhdWRlYWkiLCJob29rc1Byb21pc2UiLCJob29rTWVzc2FnZXMiLCJtY3BDbGllbnRzIiwibWNwVG9vbHMiLCJtY3BDb21tYW5kcyIsInRoaW5raW5nRW5hYmxlZCIsInRoaW5raW5nQ29uZmlnIiwidGhpbmtpbmciLCJtYXhUaGlua2luZ1Rva2VucyIsIk1BWF9USElOS0lOR19UT0tFTlMiLCJwYXJzZUludCIsImJ1ZGdldFRva2VucyIsInZlcnNpb24iLCJNQUNSTyIsIlZFUlNJT04iLCJpc19uYXRpdmVfYmluYXJ5IiwibG9nVGVuZ3VJbml0IiwiaGFzSW5pdGlhbFByb21wdCIsImhhc1N0ZGluIiwibnVtQWxsb3dlZFRvb2xzIiwibnVtRGlzYWxsb3dlZFRvb2xzIiwibWNwQ2xpZW50Q291bnQiLCJza2lwV2ViRmV0Y2hQcmVmbGlnaHQiLCJnaXRodWJBY3Rpb25JbnB1dHMiLCJHSVRIVUJfQUNUSU9OX0lOUFVUUyIsImRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkIiwibW9kZUlzQnlwYXNzIiwiYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCIsInN5c3RlbVByb21wdEZsYWciLCJhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnIiwiYXNzaXN0YW50QWN0aXZhdGlvblBhdGgiLCJnZXRBc3Npc3RhbnRBY3RpdmF0aW9uUGF0aCIsInJlZ2lzdGVyZWQiLCJudW1fc2Vzc2lvbnMiLCJzZXR1cFRyaWdnZXIiLCJmb3JjZVN5bmNFeGVjdXRpb24iLCJzZXNzaW9uU3RhcnRIb29rc1Byb21pc2UiLCJjb21tYW5kc0hlYWRsZXNzIiwiY29tbWFuZCIsImRpc2FibGVOb25JbnRlcmFjdGl2ZSIsInN1cHBvcnRzTm9uSW50ZXJhY3RpdmUiLCJkZWZhdWx0U3RhdGUiLCJoZWFkbGVzc0luaXRpYWxTdGF0ZSIsIm1jcCIsImVmZm9ydFZhbHVlIiwiZWZmb3J0IiwiZmFzdE1vZGUiLCJoZWFkbGVzc1N0b3JlIiwiZ2V0U3RhdGUiLCJ1cGRhdGVDb250ZXh0Iiwic2V0U3RhdGUiLCJuZXh0Q3R4IiwiY29ubmVjdE1jcEJhdGNoIiwibGFiZWwiLCJjbGllbnQiLCJDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMiLCJjbGF1ZGVhaUNvbm5lY3QiLCJjbGF1ZGVhaUNvbmZpZ3MiLCJjbGF1ZGVhaVNpZ3MiLCJTZXQiLCJ2YWx1ZXMiLCJzaWciLCJhZGQiLCJzdXBwcmVzc2VkIiwiaGFzIiwic2l6ZSIsIm9uY2xvc2UiLCJyZXNvdXJjZXMiLCJ0IiwibWNwSW5mbyIsInNlcnZlck5hbWUiLCJub25QbHVnaW5Db25maWdzIiwiZGVkdXBlZENsYXVkZUFpIiwiY2xhdWRlYWlUaW1lciIsInNldFRpbWVvdXQiLCJjbGF1ZGVhaVRpbWVkT3V0IiwicmFjZSIsInIiLCJjbGVhclRpbWVvdXQiLCJzdGFydEJhY2tncm91bmRIb3VzZWtlZXBpbmciLCJzdGFydFNka01lbW9yeU1vbml0b3IiLCJydW5IZWFkbGVzcyIsInBlcm1pc3Npb25Qcm9tcHRUb29sTmFtZSIsInBlcm1pc3Npb25Qcm9tcHRUb29sIiwibWF4VHVybnMiLCJtYXhCdWRnZXRVc2QiLCJ0YXNrQnVkZ2V0IiwidG90YWwiLCJyZXN1bWVTZXNzaW9uQXQiLCJyZXdpbmRGaWxlcyIsImVuYWJsZUF1dGhTdGF0dXMiLCJ3b3JrbG9hZCIsImNsaV9mbGFnIiwiZW52X3ZhciIsInNldHRpbmdzX2ZpbGUiLCJzdWJzY3JpcHRpb25UeXBlIiwiZGVwcmVjYXRpb25XYXJuaW5nIiwiaW5pdGlhbE5vdGlmaWNhdGlvbnMiLCJrZXkiLCJ0ZXh0IiwicHJpb3JpdHkiLCJkaXNwbGF5TGlzdCIsImRpc3BsYXlzIiwiZWZmZWN0aXZlVG9vbFBlcm1pc3Npb25Db250ZXh0IiwiaXNQbGFuTW9kZVJlcXVpcmVkIiwiaW5pdGlhbElzQnJpZWZPbmx5IiwiZnVsbFJlbW90ZUNvbnRyb2wiLCJjY3JNaXJyb3JFbmFibGVkIiwiaXNDY3JNaXJyb3JFbmFibGVkIiwiaW5pdGlhbFN0YXRlIiwic2V0dGluZ3MiLCJhZ2VudE5hbWVSZWdpc3RyeSIsIk1hcCIsIm1haW5Mb29wTW9kZWwiLCJtYWluTG9vcE1vZGVsRm9yU2Vzc2lvbiIsImlzQnJpZWZPbmx5IiwiZXhwYW5kZWRWaWV3Iiwic2hvd1NwaW5uZXJUcmVlIiwic2hvd0V4cGFuZGVkVG9kb3MiLCJzaG93VGVhbW1hdGVNZXNzYWdlUHJldmlldyIsInNlbGVjdGVkSVBBZ2VudEluZGV4IiwiY29vcmRpbmF0b3JUYXNrSW5kZXgiLCJ2aWV3U2VsZWN0aW9uTW9kZSIsImZvb3RlclNlbGVjdGlvbiIsInBsdWdpblJlY29ubmVjdEtleSIsImRpc2FibGVkIiwiaW5zdGFsbGF0aW9uU3RhdHVzIiwibWFya2V0cGxhY2VzIiwibmVlZHNSZWZyZXNoIiwic3RhdHVzTGluZVRleHQiLCJyZW1vdGVTZXNzaW9uVXJsIiwicmVtb3RlQ29ubmVjdGlvblN0YXR1cyIsInJlbW90ZUJhY2tncm91bmRUYXNrQ291bnQiLCJyZXBsQnJpZGdlRW5hYmxlZCIsInJlcGxCcmlkZ2VFeHBsaWNpdCIsInJlcGxCcmlkZ2VPdXRib3VuZE9ubHkiLCJyZXBsQnJpZGdlQ29ubmVjdGVkIiwicmVwbEJyaWRnZVNlc3Npb25BY3RpdmUiLCJyZXBsQnJpZGdlUmVjb25uZWN0aW5nIiwicmVwbEJyaWRnZUNvbm5lY3RVcmwiLCJyZXBsQnJpZGdlU2Vzc2lvblVybCIsInJlcGxCcmlkZ2VFbnZpcm9ubWVudElkIiwicmVwbEJyaWRnZVNlc3Npb25JZCIsInJlcGxCcmlkZ2VFcnJvciIsInJlcGxCcmlkZ2VJbml0aWFsTmFtZSIsInNob3dSZW1vdGVDYWxsb3V0Iiwibm90aWZpY2F0aW9ucyIsInF1ZXVlIiwiZWxpY2l0YXRpb24iLCJ0b2RvcyIsInJlbW90ZUFnZW50VGFza1N1Z2dlc3Rpb25zIiwiZmlsZUhpc3RvcnkiLCJzbmFwc2hvdHMiLCJ0cmFja2VkRmlsZXMiLCJzbmFwc2hvdFNlcXVlbmNlIiwiYXR0cmlidXRpb24iLCJwcm9tcHRTdWdnZXN0aW9uRW5hYmxlZCIsInNlc3Npb25Ib29rcyIsImluYm94IiwibWVzc2FnZXMiLCJwcm9tcHRTdWdnZXN0aW9uIiwicHJvbXB0SWQiLCJzaG93bkF0IiwiYWNjZXB0ZWRBdCIsImdlbmVyYXRpb25SZXF1ZXN0SWQiLCJzcGVjdWxhdGlvbiIsInNwZWN1bGF0aW9uU2Vzc2lvblRpbWVTYXZlZE1zIiwic2tpbGxJbXByb3ZlbWVudCIsInN1Z2dlc3Rpb24iLCJ3b3JrZXJTYW5kYm94UGVybWlzc2lvbnMiLCJzZWxlY3RlZEluZGV4IiwicGVuZGluZ1dvcmtlclJlcXVlc3QiLCJwZW5kaW5nU2FuZGJveFJlcXVlc3QiLCJhdXRoVmVyc2lvbiIsImluaXRpYWxNZXNzYWdlIiwiY29udGVudCIsImFjdGl2ZU92ZXJsYXlzIiwidGVhbUNvbnRleHQiLCJpbml0aWFsVG9vbHMiLCJudW1TdGFydHVwcyIsInNldEltbWVkaWF0ZSIsInNlc3Npb25VcGxvYWRlclByb21pc2UiLCJ1cGxvYWRlclJlYWR5IiwibW9kIiwiY3JlYXRlU2Vzc2lvblR1cm5VcGxvYWRlciIsInNlc3Npb25Db25maWciLCJhdXRvQ29ubmVjdElkZUZsYWciLCJvblR1cm5Db21wbGV0ZSIsInVwbG9hZGVyIiwicmVzdW1lQ29udGV4dCIsIm1vZGVBcGkiLCJyZXN1bWVTdWNjZWVkZWQiLCJyZXN1bWVTdGFydCIsInBlcmZvcm1hbmNlIiwiY2xlYXJTZXNzaW9uQ2FjaGVzIiwic3VjY2VzcyIsImxvYWRlZCIsImluY2x1ZGVBdHRyaWJ1dGlvbiIsInRyYW5zY3JpcHRQYXRoIiwiZnVsbFBhdGgiLCJyZXN0b3JlZEFnZW50RGVmIiwicmVzdW1lX2R1cmF0aW9uX21zIiwiaW5pdGlhbE1lc3NhZ2VzIiwiaW5pdGlhbEZpbGVIaXN0b3J5U25hcHNob3RzIiwiZmlsZUhpc3RvcnlTbmFwc2hvdHMiLCJpbml0aWFsQ29udGVudFJlcGxhY2VtZW50cyIsImNvbnRlbnRSZXBsYWNlbWVudHMiLCJpbml0aWFsQWdlbnROYW1lIiwiaW5pdGlhbEFnZW50Q29sb3IiLCJkaXJlY3RDb25uZWN0Q29uZmlnIiwic2Vzc2lvbiIsIndvcmtEaXIiLCJjb25uZWN0SW5mb01lc3NhZ2UiLCJjcmVhdGVTU0hTZXNzaW9uIiwiY3JlYXRlTG9jYWxTU0hTZXNzaW9uIiwiU1NIU2Vzc2lvbkVycm9yIiwic3NoU2Vzc2lvbiIsImhhZFByb2dyZXNzIiwibG9jYWxWZXJzaW9uIiwib25Qcm9ncmVzcyIsIm1zZyIsInJlbW90ZUN3ZCIsInNzaEluZm9NZXNzYWdlIiwiZGlzY292ZXJBc3Npc3RhbnRTZXNzaW9ucyIsInRhcmdldFNlc3Npb25JZCIsInNlc3Npb25zIiwiaW5zdGFsbGVkRGlyIiwiYmVmb3JlRXhpdCIsImlkIiwicGlja2VkIiwiY2hlY2tBbmRSZWZyZXNoT0F1dGhUb2tlbklmTmVlZGVkIiwiZ2V0Q2xhdWRlQUlPQXV0aFRva2VucyIsImFwaUNyZWRzIiwiZ2V0QWNjZXNzVG9rZW4iLCJhY2Nlc3NUb2tlbiIsInJlbW90ZVNlc3Npb25Db25maWciLCJvcmdVVUlEIiwiaW5mb01lc3NhZ2UiLCJhc3Npc3RhbnRJbml0aWFsU3RhdGUiLCJyZW1vdGVDb21tYW5kcyIsImZyb21QciIsInByb2Nlc3NlZFJlc3VtZSIsIm1heWJlU2Vzc2lvbklkIiwic2VhcmNoVGVybSIsIm1hdGNoZWRMb2ciLCJmaWx0ZXJCeVByIiwidHJpbW1lZFZhbHVlIiwibWF0Y2hlcyIsImV4YWN0IiwiaXNSZW1vdGVUdWlFbmFibGVkIiwiaGFzX2luaXRpYWxfcHJvbXB0IiwiY3VycmVudEJyYW5jaCIsImNyZWF0ZWRTZXNzaW9uIiwiQWJvcnRDb250cm9sbGVyIiwic2lnbmFsIiwic2Vzc2lvbl9pZCIsImdldFRva2Vuc0ZvclJlbW90ZSIsImdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlIiwicmVtb3RlSW5mb01lc3NhZ2UiLCJpbml0aWFsVXNlck1lc3NhZ2UiLCJyZW1vdGVJbml0aWFsU3RhdGUiLCJ0ZWxlcG9ydFJlc3VsdCIsImJyYW5jaEVycm9yIiwiYnJhbmNoIiwibG9nIiwic2Vzc2lvbkRhdGEiLCJyZXBvVmFsaWRhdGlvbiIsInN0YXR1cyIsInNlc3Npb25SZXBvIiwia25vd25QYXRocyIsImV4aXN0aW5nUGF0aHMiLCJzZWxlY3RlZFBhdGgiLCJ0YXJnZXRSZXBvIiwiaW5pdGlhbFBhdGhzIiwiY2hkaXIiLCJib2xkIiwidGVsZXBvcnRXaXRoUHJvZ3Jlc3MiLCJmb3JtYXR0ZWRNZXNzYWdlIiwicGFyc2VDY3NoYXJlSWQiLCJsb2FkQ2NzaGFyZSIsImNjc2hhcmVJZCIsImxvZ09wdGlvbiIsImVudHJ5cG9pbnQiLCJzZXNzaW9uSWRPdmVycmlkZSIsInJlc3VsdHMiLCJmYWlsZWRDb3VudCIsInJlc3VtZURhdGEiLCJpbml0aWFsU2VhcmNoUXVlcnkiLCJwZW5kaW5nSG9va01lc3NhZ2VzIiwiZGVlcExpbmtCYW5uZXIiLCJkZWVwTGlua09yaWdpbiIsImhhc19wcmVmaWxsIiwiaGFzX3JlcG8iLCJkZWVwTGlua1JlcG8iLCJwcmVmaWxsTGVuZ3RoIiwicmVwbyIsImxhc3RGZXRjaCIsImRlZXBMaW5rTGFzdEZldGNoIiwiaW1wbGllcyIsImlzUHJpbnRNb2RlIiwiaXNDY1VybCIsInBhcnNlQXN5bmMiLCJtY3BTZXJ2ZUhhbmRsZXIiLCJtY3BSZW1vdmVIYW5kbGVyIiwibWNwTGlzdEhhbmRsZXIiLCJtY3BHZXRIYW5kbGVyIiwianNvbiIsImNsaWVudFNlY3JldCIsIm1jcEFkZEpzb25IYW5kbGVyIiwibWNwQWRkRnJvbURlc2t0b3BIYW5kbGVyIiwibWNwUmVzZXRDaG9pY2VzSGFuZGxlciIsInBvcnQiLCJ1bml4Iiwid29ya3NwYWNlIiwiaWRsZVRpbWVvdXQiLCJtYXhTZXNzaW9ucyIsInJhbmRvbUJ5dGVzIiwic3RhcnRTZXJ2ZXIiLCJTZXNzaW9uTWFuYWdlciIsIkRhbmdlcm91c0JhY2tlbmQiLCJwcmludEJhbm5lciIsImNyZWF0ZVNlcnZlckxvZ2dlciIsIndyaXRlU2VydmVyTG9jayIsInJlbW92ZVNlcnZlckxvY2siLCJwcm9iZVJ1bm5pbmdTZXJ2ZXIiLCJleGlzdGluZyIsInBpZCIsImh0dHBVcmwiLCJ0b1N0cmluZyIsImlkbGVUaW1lb3V0TXMiLCJiYWNrZW5kIiwic2Vzc2lvbk1hbmFnZXIiLCJsb2dnZXIiLCJzZXJ2ZXIiLCJhY3R1YWxQb3J0Iiwic3RhcnRlZEF0Iiwic2h1dHRpbmdEb3duIiwic2h1dGRvd24iLCJzdG9wIiwiZGVzdHJveUFsbCIsIm9uY2UiLCJjb25uZWN0Q29uZmlnIiwicnVuQ29ubmVjdEhlYWRsZXNzIiwiaW50ZXJhY3RpdmUiLCJhdXRoIiwiZW1haWwiLCJzc28iLCJ1c2VDb25zb2xlIiwiYXV0aExvZ2luIiwiYXV0aFN0YXR1cyIsImF1dGhMb2dvdXQiLCJjb3dvcmtPcHRpb24iLCJwbHVnaW5DbWQiLCJhbGlhcyIsIm1hbmlmZXN0UGF0aCIsImNvd29yayIsInBsdWdpblZhbGlkYXRlSGFuZGxlciIsImF2YWlsYWJsZSIsInBsdWdpbkxpc3RIYW5kbGVyIiwibWFya2V0cGxhY2VDbWQiLCJzcGFyc2UiLCJtYXJrZXRwbGFjZUFkZEhhbmRsZXIiLCJtYXJrZXRwbGFjZUxpc3RIYW5kbGVyIiwibWFya2V0cGxhY2VSZW1vdmVIYW5kbGVyIiwibWFya2V0cGxhY2VVcGRhdGVIYW5kbGVyIiwicGx1Z2luIiwicGx1Z2luSW5zdGFsbEhhbmRsZXIiLCJrZWVwRGF0YSIsInBsdWdpblVuaW5zdGFsbEhhbmRsZXIiLCJwbHVnaW5FbmFibGVIYW5kbGVyIiwicGx1Z2luRGlzYWJsZUhhbmRsZXIiLCJwbHVnaW5VcGRhdGVIYW5kbGVyIiwic2V0dXBUb2tlbkhhbmRsZXIiLCJhZ2VudHNIYW5kbGVyIiwiYXV0b01vZGVDbWQiLCJhdXRvTW9kZURlZmF1bHRzSGFuZGxlciIsImF1dG9Nb2RlQ29uZmlnSGFuZGxlciIsImF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyIiwiaGlkZGVuIiwiYnJpZGdlTWFpbiIsImRvY3RvckhhbmRsZXIiLCJ1cGRhdGUiLCJ1cCIsInRhcmdldCIsImxpc3QiLCJkcnlSdW4iLCJzYWZlIiwicm9sbGJhY2siLCJmb3JjZSIsImluc3RhbGxIYW5kbGVyIiwidmFsaWRhdGVMb2dJZCIsImxvZ0lkIiwibG9nSGFuZGxlciIsIm51bWJlciIsImVycm9ySGFuZGxlciIsInVzYWdlIiwiYWRkSGVscFRleHQiLCJvdXRwdXRGaWxlIiwiZXhwb3J0SGFuZGxlciIsInRhc2tDbWQiLCJzdWJqZWN0IiwidGFza0NyZWF0ZUhhbmRsZXIiLCJwZW5kaW5nIiwidGFza0xpc3RIYW5kbGVyIiwidGFza0dldEhhbmRsZXIiLCJvd25lciIsImNsZWFyT3duZXIiLCJ0YXNrVXBkYXRlSGFuZGxlciIsInRhc2tEaXJIYW5kbGVyIiwic2hlbGwiLCJvdXRwdXQiLCJjb21wbGV0aW9uSGFuZGxlciIsImluUHJvdGVjdGVkTmFtZXNwYWNlIiwidGhpbmtpbmdUeXBlIiwiaXNfc2ltcGxlIiwiaXNfY29vcmRpbmF0b3IiLCJhdXRvVXBkYXRlc0NoYW5uZWwiLCJnaXRSb290IiwicnAiLCJyZWxhdGl2ZVByb2plY3RQYXRoIiwicHJvYWN0aXZlTW9kdWxlIiwiaXNQcm9hY3RpdmVBY3RpdmUiLCJhY3RpdmF0ZVByb2FjdGl2ZSIsImJyaWVmRmxhZyIsImJyaWVmRW52IiwiQ0xBVURFX0NPREVfQlJJRUYiLCJlbnRpdGxlZCIsImdhdGVkIiwidGVybWluYWwiXSwic291cmNlcyI6WyJtYWluLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBUaGVzZSBzaWRlLWVmZmVjdHMgbXVzdCBydW4gYmVmb3JlIGFsbCBvdGhlciBpbXBvcnRzOlxuLy8gMS4gcHJvZmlsZUNoZWNrcG9pbnQgbWFya3MgZW50cnkgYmVmb3JlIGhlYXZ5IG1vZHVsZSBldmFsdWF0aW9uIGJlZ2luc1xuLy8gMi4gc3RhcnRNZG1SYXdSZWFkIGZpcmVzIE1ETSBzdWJwcm9jZXNzZXMgKHBsdXRpbC9yZWcgcXVlcnkpIHNvIHRoZXkgcnVuIGluXG4vLyAgICBwYXJhbGxlbCB3aXRoIHRoZSByZW1haW5pbmcgfjEzNW1zIG9mIGltcG9ydHMgYmVsb3dcbi8vIDMuIHN0YXJ0S2V5Y2hhaW5QcmVmZXRjaCBmaXJlcyBib3RoIG1hY09TIGtleWNoYWluIHJlYWRzIChPQXV0aCArIGxlZ2FjeSBBUElcbi8vICAgIGtleSkgaW4gcGFyYWxsZWwg4oCUIGlzUmVtb3RlTWFuYWdlZFNldHRpbmdzRWxpZ2libGUoKSBvdGhlcndpc2UgcmVhZHMgdGhlbVxuLy8gICAgc2VxdWVudGlhbGx5IHZpYSBzeW5jIHNwYXduIGluc2lkZSBhcHBseVNhZmVDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcygpXG4vLyAgICAofjY1bXMgb24gZXZlcnkgbWFjT1Mgc3RhcnR1cClcbmltcG9ydCB7IHByb2ZpbGVDaGVja3BvaW50LCBwcm9maWxlUmVwb3J0IH0gZnJvbSAnLi91dGlscy9zdGFydHVwUHJvZmlsZXIuanMnXG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xucHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fdHN4X2VudHJ5JylcblxuaW1wb3J0IHsgc3RhcnRNZG1SYXdSZWFkIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9tZG0vcmF3UmVhZC5qcydcblxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGN1c3RvbS1ydWxlcy9uby10b3AtbGV2ZWwtc2lkZS1lZmZlY3RzXG5zdGFydE1kbVJhd1JlYWQoKVxuXG5pbXBvcnQge1xuICBlbnN1cmVLZXljaGFpblByZWZldGNoQ29tcGxldGVkLFxuICBzdGFydEtleWNoYWluUHJlZmV0Y2gsXG59IGZyb20gJy4vdXRpbHMvc2VjdXJlU3RvcmFnZS9rZXljaGFpblByZWZldGNoLmpzJ1xuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgY3VzdG9tLXJ1bGVzL25vLXRvcC1sZXZlbC1zaWRlLWVmZmVjdHNcbnN0YXJ0S2V5Y2hhaW5QcmVmZXRjaCgpXG5cbmltcG9ydCB7IGZlYXR1cmUgfSBmcm9tICdidW46YnVuZGxlJ1xuaW1wb3J0IHtcbiAgQ29tbWFuZCBhcyBDb21tYW5kZXJDb21tYW5kLFxuICBJbnZhbGlkQXJndW1lbnRFcnJvcixcbiAgT3B0aW9uLFxufSBmcm9tICdAY29tbWFuZGVyLWpzL2V4dHJhLXR5cGluZ3MnXG5pbXBvcnQgY2hhbGsgZnJvbSAnY2hhbGsnXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcydcbmltcG9ydCBtYXBWYWx1ZXMgZnJvbSAnbG9kYXNoLWVzL21hcFZhbHVlcy5qcydcbmltcG9ydCBwaWNrQnkgZnJvbSAnbG9kYXNoLWVzL3BpY2tCeS5qcydcbmltcG9ydCB1bmlxQnkgZnJvbSAnbG9kYXNoLWVzL3VuaXFCeS5qcydcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IGdldE9hdXRoQ29uZmlnIH0gZnJvbSAnLi9jb25zdGFudHMvb2F1dGguanMnXG5pbXBvcnQgeyBnZXRSZW1vdGVTZXNzaW9uVXJsIH0gZnJvbSAnLi9jb25zdGFudHMvcHJvZHVjdC5qcydcbmltcG9ydCB7IGdldFN5c3RlbUNvbnRleHQsIGdldFVzZXJDb250ZXh0IH0gZnJvbSAnLi9jb250ZXh0LmpzJ1xuaW1wb3J0IHsgaW5pdCwgaW5pdGlhbGl6ZVRlbGVtZXRyeUFmdGVyVHJ1c3QgfSBmcm9tICcuL2VudHJ5cG9pbnRzL2luaXQuanMnXG5pbXBvcnQgeyBhZGRUb0hpc3RvcnkgfSBmcm9tICcuL2hpc3RvcnkuanMnXG5pbXBvcnQgdHlwZSB7IFJvb3QgfSBmcm9tICcuL2luay5qcydcbmltcG9ydCB7IGxhdW5jaFJlcGwgfSBmcm9tICcuL3JlcGxMYXVuY2hlci5qcydcbmltcG9ydCB7XG4gIGhhc0dyb3d0aEJvb2tFbnZPdmVycmlkZSxcbiAgaW5pdGlhbGl6ZUdyb3d0aEJvb2ssXG4gIHJlZnJlc2hHcm93dGhCb29rQWZ0ZXJBdXRoQ2hhbmdlLFxufSBmcm9tICcuL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHsgZmV0Y2hCb290c3RyYXBEYXRhIH0gZnJvbSAnLi9zZXJ2aWNlcy9hcGkvYm9vdHN0cmFwLmpzJ1xuaW1wb3J0IHtcbiAgdHlwZSBEb3dubG9hZFJlc3VsdCxcbiAgZG93bmxvYWRTZXNzaW9uRmlsZXMsXG4gIHR5cGUgRmlsZXNBcGlDb25maWcsXG4gIHBhcnNlRmlsZVNwZWNzLFxufSBmcm9tICcuL3NlcnZpY2VzL2FwaS9maWxlc0FwaS5qcydcbmltcG9ydCB7IHByZWZldGNoUGFzc2VzRWxpZ2liaWxpdHkgfSBmcm9tICcuL3NlcnZpY2VzL2FwaS9yZWZlcnJhbC5qcydcbmltcG9ydCB7IHByZWZldGNoT2ZmaWNpYWxNY3BVcmxzIH0gZnJvbSAnLi9zZXJ2aWNlcy9tY3Avb2ZmaWNpYWxSZWdpc3RyeS5qcydcbmltcG9ydCB0eXBlIHtcbiAgTWNwU2RrU2VydmVyQ29uZmlnLFxuICBNY3BTZXJ2ZXJDb25maWcsXG4gIFNjb3BlZE1jcFNlcnZlckNvbmZpZyxcbn0gZnJvbSAnLi9zZXJ2aWNlcy9tY3AvdHlwZXMuanMnXG5pbXBvcnQge1xuICBpc1BvbGljeUFsbG93ZWQsXG4gIGxvYWRQb2xpY3lMaW1pdHMsXG4gIHJlZnJlc2hQb2xpY3lMaW1pdHMsXG4gIHdhaXRGb3JQb2xpY3lMaW1pdHNUb0xvYWQsXG59IGZyb20gJy4vc2VydmljZXMvcG9saWN5TGltaXRzL2luZGV4LmpzJ1xuaW1wb3J0IHtcbiAgbG9hZFJlbW90ZU1hbmFnZWRTZXR0aW5ncyxcbiAgcmVmcmVzaFJlbW90ZU1hbmFnZWRTZXR0aW5ncyxcbn0gZnJvbSAnLi9zZXJ2aWNlcy9yZW1vdGVNYW5hZ2VkU2V0dGluZ3MvaW5kZXguanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xJbnB1dEpTT05TY2hlbWEgfSBmcm9tICcuL1Rvb2wuanMnXG5pbXBvcnQge1xuICBjcmVhdGVTeW50aGV0aWNPdXRwdXRUb29sLFxuICBpc1N5bnRoZXRpY091dHB1dFRvb2xFbmFibGVkLFxufSBmcm9tICcuL3Rvb2xzL1N5bnRoZXRpY091dHB1dFRvb2wvU3ludGhldGljT3V0cHV0VG9vbC5qcydcbmltcG9ydCB7IGdldFRvb2xzIH0gZnJvbSAnLi90b29scy5qcydcbmltcG9ydCB7XG4gIGNhblVzZXJDb25maWd1cmVBZHZpc29yLFxuICBnZXRJbml0aWFsQWR2aXNvclNldHRpbmcsXG4gIGlzQWR2aXNvckVuYWJsZWQsXG4gIGlzVmFsaWRBZHZpc29yTW9kZWwsXG4gIG1vZGVsU3VwcG9ydHNBZHZpc29yLFxufSBmcm9tICcuL3V0aWxzL2Fkdmlzb3IuanMnXG5pbXBvcnQgeyBpc0FnZW50U3dhcm1zRW5hYmxlZCB9IGZyb20gJy4vdXRpbHMvYWdlbnRTd2FybXNFbmFibGVkLmpzJ1xuaW1wb3J0IHsgY291bnQsIHVuaXEgfSBmcm9tICcuL3V0aWxzL2FycmF5LmpzJ1xuaW1wb3J0IHsgaW5zdGFsbEFzY2lpY2FzdFJlY29yZGVyIH0gZnJvbSAnLi91dGlscy9hc2NpaWNhc3QuanMnXG5pbXBvcnQge1xuICBnZXRTdWJzY3JpcHRpb25UeXBlLFxuICBpc0NsYXVkZUFJU3Vic2NyaWJlcixcbiAgcHJlZmV0Y2hBd3NDcmVkZW50aWFsc0FuZEJlZFJvY2tJbmZvSWZTYWZlLFxuICBwcmVmZXRjaEdjcENyZWRlbnRpYWxzSWZTYWZlLFxuICB2YWxpZGF0ZUZvcmNlTG9naW5PcmcsXG59IGZyb20gJy4vdXRpbHMvYXV0aC5qcydcbmltcG9ydCB7XG4gIGNoZWNrSGFzVHJ1c3REaWFsb2dBY2NlcHRlZCxcbiAgZ2V0R2xvYmFsQ29uZmlnLFxuICBnZXRSZW1vdGVDb250cm9sQXRTdGFydHVwLFxuICBpc0F1dG9VcGRhdGVyRGlzYWJsZWQsXG4gIHNhdmVHbG9iYWxDb25maWcsXG59IGZyb20gJy4vdXRpbHMvY29uZmlnLmpzJ1xuaW1wb3J0IHsgc2VlZEVhcmx5SW5wdXQsIHN0b3BDYXB0dXJpbmdFYXJseUlucHV0IH0gZnJvbSAnLi91dGlscy9lYXJseUlucHV0LmpzJ1xuaW1wb3J0IHsgZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmcsIHBhcnNlRWZmb3J0VmFsdWUgfSBmcm9tICcuL3V0aWxzL2VmZm9ydC5qcydcbmltcG9ydCB7XG4gIGdldEluaXRpYWxGYXN0TW9kZVNldHRpbmcsXG4gIGlzRmFzdE1vZGVFbmFibGVkLFxuICBwcmVmZXRjaEZhc3RNb2RlU3RhdHVzLFxuICByZXNvbHZlRmFzdE1vZGVTdGF0dXNGcm9tQ2FjaGUsXG59IGZyb20gJy4vdXRpbHMvZmFzdE1vZGUuanMnXG5pbXBvcnQgeyBhcHBseUNvbmZpZ0Vudmlyb25tZW50VmFyaWFibGVzIH0gZnJvbSAnLi91dGlscy9tYW5hZ2VkRW52LmpzJ1xuaW1wb3J0IHsgY3JlYXRlU3lzdGVtTWVzc2FnZSwgY3JlYXRlVXNlck1lc3NhZ2UgfSBmcm9tICcuL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgZ2V0UGxhdGZvcm0gfSBmcm9tICcuL3V0aWxzL3BsYXRmb3JtLmpzJ1xuaW1wb3J0IHsgZ2V0QmFzZVJlbmRlck9wdGlvbnMgfSBmcm9tICcuL3V0aWxzL3JlbmRlck9wdGlvbnMuanMnXG5pbXBvcnQgeyBnZXRTZXNzaW9uSW5ncmVzc0F1dGhUb2tlbiB9IGZyb20gJy4vdXRpbHMvc2Vzc2lvbkluZ3Jlc3NBdXRoLmpzJ1xuaW1wb3J0IHsgc2V0dGluZ3NDaGFuZ2VEZXRlY3RvciB9IGZyb20gJy4vdXRpbHMvc2V0dGluZ3MvY2hhbmdlRGV0ZWN0b3IuanMnXG5pbXBvcnQgeyBza2lsbENoYW5nZURldGVjdG9yIH0gZnJvbSAnLi91dGlscy9za2lsbHMvc2tpbGxDaGFuZ2VEZXRlY3Rvci5qcydcbmltcG9ydCB7IGpzb25QYXJzZSwgd3JpdGVGaWxlU3luY19ERVBSRUNBVEVEIH0gZnJvbSAnLi91dGlscy9zbG93T3BlcmF0aW9ucy5qcydcbmltcG9ydCB7IGNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQgfSBmcm9tICcuL3V0aWxzL3N3YXJtL3JlY29ubmVjdGlvbi5qcydcbmltcG9ydCB7IGluaXRpYWxpemVXYXJuaW5nSGFuZGxlciB9IGZyb20gJy4vdXRpbHMvd2FybmluZ0hhbmRsZXIuanMnXG5pbXBvcnQgeyBpc1dvcmt0cmVlTW9kZUVuYWJsZWQgfSBmcm9tICcuL3V0aWxzL3dvcmt0cmVlTW9kZUVuYWJsZWQuanMnXG5cbi8vIExhenkgcmVxdWlyZSB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmN5OiB0ZWFtbWF0ZS50cyAtPiBBcHBTdGF0ZS50c3ggLT4gLi4uIC0+IG1haW4udHN4XG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG5jb25zdCBnZXRUZWFtbWF0ZVV0aWxzID0gKCkgPT5cbiAgcmVxdWlyZSgnLi91dGlscy90ZWFtbWF0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvdGVhbW1hdGUuanMnKVxuY29uc3QgZ2V0VGVhbW1hdGVQcm9tcHRBZGRlbmR1bSA9ICgpID0+XG4gIHJlcXVpcmUoJy4vdXRpbHMvc3dhcm0vdGVhbW1hdGVQcm9tcHRBZGRlbmR1bS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvc3dhcm0vdGVhbW1hdGVQcm9tcHRBZGRlbmR1bS5qcycpXG5jb25zdCBnZXRUZWFtbWF0ZU1vZGVTbmFwc2hvdCA9ICgpID0+XG4gIHJlcXVpcmUoJy4vdXRpbHMvc3dhcm0vYmFja2VuZHMvdGVhbW1hdGVNb2RlU25hcHNob3QuanMnKSBhcyB0eXBlb2YgaW1wb3J0KCcuL3V0aWxzL3N3YXJtL2JhY2tlbmRzL3RlYW1tYXRlTW9kZVNuYXBzaG90LmpzJylcbi8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuLy8gRGVhZCBjb2RlIGVsaW1pbmF0aW9uOiBjb25kaXRpb25hbCBpbXBvcnQgZm9yIENPT1JESU5BVE9SX01PREVcbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbmNvbnN0IGNvb3JkaW5hdG9yTW9kZU1vZHVsZSA9IGZlYXR1cmUoJ0NPT1JESU5BVE9SX01PREUnKVxuICA/IChyZXF1aXJlKCcuL2Nvb3JkaW5hdG9yL2Nvb3JkaW5hdG9yTW9kZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vY29vcmRpbmF0b3IvY29vcmRpbmF0b3JNb2RlLmpzJykpXG4gIDogbnVsbFxuLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4vLyBEZWFkIGNvZGUgZWxpbWluYXRpb246IGNvbmRpdGlvbmFsIGltcG9ydCBmb3IgS0FJUk9TIChhc3Npc3RhbnQgbW9kZSlcbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbmNvbnN0IGFzc2lzdGFudE1vZHVsZSA9IGZlYXR1cmUoJ0tBSVJPUycpXG4gID8gKHJlcXVpcmUoJy4vYXNzaXN0YW50L2luZGV4LmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi9hc3Npc3RhbnQvaW5kZXguanMnKSlcbiAgOiBudWxsXG5jb25zdCBrYWlyb3NHYXRlID0gZmVhdHVyZSgnS0FJUk9TJylcbiAgPyAocmVxdWlyZSgnLi9hc3Npc3RhbnQvZ2F0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vYXNzaXN0YW50L2dhdGUuanMnKSlcbiAgOiBudWxsXG5cbmltcG9ydCB7IHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IGlzQW5hbHl0aWNzRGlzYWJsZWQgfSBmcm9tICdzcmMvc2VydmljZXMvYW5hbHl0aWNzL2NvbmZpZy5qcydcbmltcG9ydCB7IGdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFIH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHtcbiAgdHlwZSBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICBsb2dFdmVudCxcbn0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcydcbmltcG9ydCB7IGluaXRpYWxpemVBbmFseXRpY3NHYXRlcyB9IGZyb20gJ3NyYy9zZXJ2aWNlcy9hbmFseXRpY3Mvc2luay5qcydcbmltcG9ydCB7XG4gIGdldE9yaWdpbmFsQ3dkLFxuICBzZXRBZGRpdGlvbmFsRGlyZWN0b3JpZXNGb3JDbGF1ZGVNZCxcbiAgc2V0SXNSZW1vdGVNb2RlLFxuICBzZXRNYWluTG9vcE1vZGVsT3ZlcnJpZGUsXG4gIHNldE1haW5UaHJlYWRBZ2VudFR5cGUsXG4gIHNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyxcbn0gZnJvbSAnLi9ib290c3RyYXAvc3RhdGUuanMnXG5pbXBvcnQgeyBmaWx0ZXJDb21tYW5kc0ZvclJlbW90ZU1vZGUsIGdldENvbW1hbmRzIH0gZnJvbSAnLi9jb21tYW5kcy5qcydcbmltcG9ydCB0eXBlIHsgU3RhdHNTdG9yZSB9IGZyb20gJy4vY29udGV4dC9zdGF0cy5qcydcbmltcG9ydCB7XG4gIGxhdW5jaEFzc2lzdGFudEluc3RhbGxXaXphcmQsXG4gIGxhdW5jaEFzc2lzdGFudFNlc3Npb25DaG9vc2VyLFxuICBsYXVuY2hJbnZhbGlkU2V0dGluZ3NEaWFsb2csXG4gIGxhdW5jaFJlc3VtZUNob29zZXIsXG4gIGxhdW5jaFNuYXBzaG90VXBkYXRlRGlhbG9nLFxuICBsYXVuY2hUZWxlcG9ydFJlcG9NaXNtYXRjaERpYWxvZyxcbiAgbGF1bmNoVGVsZXBvcnRSZXN1bWVXcmFwcGVyLFxufSBmcm9tICcuL2RpYWxvZ0xhdW5jaGVycy5qcydcbmltcG9ydCB7IFNIT1dfQ1VSU09SIH0gZnJvbSAnLi9pbmsvdGVybWlvL2RlYy5qcydcbmltcG9ydCB7XG4gIGV4aXRXaXRoRXJyb3IsXG4gIGV4aXRXaXRoTWVzc2FnZSxcbiAgZ2V0UmVuZGVyQ29udGV4dCxcbiAgcmVuZGVyQW5kUnVuLFxuICBzaG93U2V0dXBTY3JlZW5zLFxufSBmcm9tICcuL2ludGVyYWN0aXZlSGVscGVycy5qcydcbmltcG9ydCB7IGluaXRCdWlsdGluUGx1Z2lucyB9IGZyb20gJy4vcGx1Z2lucy9idW5kbGVkL2luZGV4LmpzJ1xuLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG5pbXBvcnQgeyBjaGVja1F1b3RhU3RhdHVzIH0gZnJvbSAnLi9zZXJ2aWNlcy9jbGF1ZGVBaUxpbWl0cy5qcydcbmltcG9ydCB7XG4gIGdldE1jcFRvb2xzQ29tbWFuZHNBbmRSZXNvdXJjZXMsXG4gIHByZWZldGNoQWxsTWNwUmVzb3VyY2VzLFxufSBmcm9tICcuL3NlcnZpY2VzL21jcC9jbGllbnQuanMnXG5pbXBvcnQge1xuICBWQUxJRF9JTlNUQUxMQUJMRV9TQ09QRVMsXG4gIFZBTElEX1VQREFURV9TQ09QRVMsXG59IGZyb20gJy4vc2VydmljZXMvcGx1Z2lucy9wbHVnaW5DbGlDb21tYW5kcy5qcydcbmltcG9ydCB7IGluaXRCdW5kbGVkU2tpbGxzIH0gZnJvbSAnLi9za2lsbHMvYnVuZGxlZC9pbmRleC5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRDb2xvck5hbWUgfSBmcm9tICcuL3Rvb2xzL0FnZW50VG9vbC9hZ2VudENvbG9yTWFuYWdlci5qcydcbmltcG9ydCB7XG4gIGdldEFjdGl2ZUFnZW50c0Zyb21MaXN0LFxuICBnZXRBZ2VudERlZmluaXRpb25zV2l0aE92ZXJyaWRlcyxcbiAgaXNCdWlsdEluQWdlbnQsXG4gIGlzQ3VzdG9tQWdlbnQsXG4gIHBhcnNlQWdlbnRzRnJvbUpzb24sXG59IGZyb20gJy4vdG9vbHMvQWdlbnRUb29sL2xvYWRBZ2VudHNEaXIuanMnXG5pbXBvcnQgdHlwZSB7IExvZ09wdGlvbiB9IGZyb20gJy4vdHlwZXMvbG9ncy5qcydcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSBhcyBNZXNzYWdlVHlwZSB9IGZyb20gJy4vdHlwZXMvbWVzc2FnZS5qcydcbmltcG9ydCB7IGFzc2VydE1pblZlcnNpb24gfSBmcm9tICcuL3V0aWxzL2F1dG9VcGRhdGVyLmpzJ1xuaW1wb3J0IHtcbiAgQ0xBVURFX0lOX0NIUk9NRV9TS0lMTF9ISU5ULFxuICBDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlRfV0lUSF9XRUJCUk9XU0VSLFxufSBmcm9tICcuL3V0aWxzL2NsYXVkZUluQ2hyb21lL3Byb21wdC5qcydcbmltcG9ydCB7XG4gIHNldHVwQ2xhdWRlSW5DaHJvbWUsXG4gIHNob3VsZEF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSxcbiAgc2hvdWxkRW5hYmxlQ2xhdWRlSW5DaHJvbWUsXG59IGZyb20gJy4vdXRpbHMvY2xhdWRlSW5DaHJvbWUvc2V0dXAuanMnXG5pbXBvcnQgeyBnZXRDb250ZXh0V2luZG93Rm9yTW9kZWwgfSBmcm9tICcuL3V0aWxzL2NvbnRleHQuanMnXG5pbXBvcnQgeyBsb2FkQ29udmVyc2F0aW9uRm9yUmVzdW1lIH0gZnJvbSAnLi91dGlscy9jb252ZXJzYXRpb25SZWNvdmVyeS5qcydcbmltcG9ydCB7IGJ1aWxkRGVlcExpbmtCYW5uZXIgfSBmcm9tICcuL3V0aWxzL2RlZXBMaW5rL2Jhbm5lci5qcydcbmltcG9ydCB7XG4gIGhhc05vZGVPcHRpb24sXG4gIGlzQmFyZU1vZGUsXG4gIGlzRW52VHJ1dGh5LFxuICBpc0luUHJvdGVjdGVkTmFtZXNwYWNlLFxufSBmcm9tICcuL3V0aWxzL2VudlV0aWxzLmpzJ1xuaW1wb3J0IHsgcmVmcmVzaEV4YW1wbGVDb21tYW5kcyB9IGZyb20gJy4vdXRpbHMvZXhhbXBsZUNvbW1hbmRzLmpzJ1xuaW1wb3J0IHR5cGUgeyBGcHNNZXRyaWNzIH0gZnJvbSAnLi91dGlscy9mcHNUcmFja2VyLmpzJ1xuaW1wb3J0IHsgZ2V0V29ya3RyZWVQYXRocyB9IGZyb20gJy4vdXRpbHMvZ2V0V29ya3RyZWVQYXRocy5qcydcbmltcG9ydCB7XG4gIGZpbmRHaXRSb290LFxuICBnZXRCcmFuY2gsXG4gIGdldElzR2l0LFxuICBnZXRXb3JrdHJlZUNvdW50LFxufSBmcm9tICcuL3V0aWxzL2dpdC5qcydcbmltcG9ydCB7IGdldEdoQXV0aFN0YXR1cyB9IGZyb20gJy4vdXRpbHMvZ2l0aHViL2doQXV0aFN0YXR1cy5qcydcbmltcG9ydCB7IHNhZmVQYXJzZUpTT04gfSBmcm9tICcuL3V0aWxzL2pzb24uanMnXG5pbXBvcnQgeyBsb2dFcnJvciB9IGZyb20gJy4vdXRpbHMvbG9nLmpzJ1xuaW1wb3J0IHsgZ2V0TW9kZWxEZXByZWNhdGlvbldhcm5pbmcgfSBmcm9tICcuL3V0aWxzL21vZGVsL2RlcHJlY2F0aW9uLmpzJ1xuaW1wb3J0IHtcbiAgZ2V0RGVmYXVsdE1haW5Mb29wTW9kZWwsXG4gIGdldFVzZXJTcGVjaWZpZWRNb2RlbFNldHRpbmcsXG4gIG5vcm1hbGl6ZU1vZGVsU3RyaW5nRm9yQVBJLFxuICBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbCxcbn0gZnJvbSAnLi91dGlscy9tb2RlbC9tb2RlbC5qcydcbmltcG9ydCB7IGVuc3VyZU1vZGVsU3RyaW5nc0luaXRpYWxpemVkIH0gZnJvbSAnLi91dGlscy9tb2RlbC9tb2RlbFN0cmluZ3MuanMnXG5pbXBvcnQgeyBQRVJNSVNTSU9OX01PREVTIH0gZnJvbSAnLi91dGlscy9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uTW9kZS5qcydcbmltcG9ydCB7XG4gIGNoZWNrQW5kRGlzYWJsZUJ5cGFzc1Blcm1pc3Npb25zLFxuICBnZXRBdXRvTW9kZUVuYWJsZWRTdGF0ZUlmQ2FjaGVkLFxuICBpbml0aWFsaXplVG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICBpbml0aWFsUGVybWlzc2lvbk1vZGVGcm9tQ0xJLFxuICBpc0RlZmF1bHRQZXJtaXNzaW9uTW9kZUF1dG8sXG4gIHBhcnNlVG9vbExpc3RGcm9tQ0xJLFxuICByZW1vdmVEYW5nZXJvdXNQZXJtaXNzaW9ucyxcbiAgc3RyaXBEYW5nZXJvdXNQZXJtaXNzaW9uc0ZvckF1dG9Nb2RlLFxuICB2ZXJpZnlBdXRvTW9kZUdhdGVBY2Nlc3MsXG59IGZyb20gJy4vdXRpbHMvcGVybWlzc2lvbnMvcGVybWlzc2lvblNldHVwLmpzJ1xuaW1wb3J0IHsgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQgfSBmcm9tICcuL3V0aWxzL3BsdWdpbnMvY2FjaGVVdGlscy5qcydcbmltcG9ydCB7IGluaXRpYWxpemVWZXJzaW9uZWRQbHVnaW5zIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL2luc3RhbGxlZFBsdWdpbnNNYW5hZ2VyLmpzJ1xuaW1wb3J0IHsgZ2V0TWFuYWdlZFBsdWdpbk5hbWVzIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL21hbmFnZWRQbHVnaW5zLmpzJ1xuaW1wb3J0IHsgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSB9IGZyb20gJy4vdXRpbHMvcGx1Z2lucy9vcnBoYW5lZFBsdWdpbkZpbHRlci5qcydcbmltcG9ydCB7IGdldFBsdWdpblNlZWREaXJzIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL3BsdWdpbkRpcmVjdG9yaWVzLmpzJ1xuaW1wb3J0IHsgY291bnRGaWxlc1JvdW5kZWRSZyB9IGZyb20gJy4vdXRpbHMvcmlwZ3JlcC5qcydcbmltcG9ydCB7XG4gIHByb2Nlc3NTZXNzaW9uU3RhcnRIb29rcyxcbiAgcHJvY2Vzc1NldHVwSG9va3MsXG59IGZyb20gJy4vdXRpbHMvc2Vzc2lvblN0YXJ0LmpzJ1xuaW1wb3J0IHtcbiAgY2FjaGVTZXNzaW9uVGl0bGUsXG4gIGdldFNlc3Npb25JZEZyb21Mb2csXG4gIGxvYWRUcmFuc2NyaXB0RnJvbUZpbGUsXG4gIHNhdmVBZ2VudFNldHRpbmcsXG4gIHNhdmVNb2RlLFxuICBzZWFyY2hTZXNzaW9uc0J5Q3VzdG9tVGl0bGUsXG4gIHNlc3Npb25JZEV4aXN0cyxcbn0gZnJvbSAnLi91dGlscy9zZXNzaW9uU3RvcmFnZS5qcydcbmltcG9ydCB7IGVuc3VyZU1kbVNldHRpbmdzTG9hZGVkIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9tZG0vc2V0dGluZ3MuanMnXG5pbXBvcnQge1xuICBnZXRJbml0aWFsU2V0dGluZ3MsXG4gIGdldE1hbmFnZWRTZXR0aW5nc0tleXNGb3JMb2dnaW5nLFxuICBnZXRTZXR0aW5nc0ZvclNvdXJjZSxcbiAgZ2V0U2V0dGluZ3NXaXRoRXJyb3JzLFxufSBmcm9tICcuL3V0aWxzL3NldHRpbmdzL3NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgcmVzZXRTZXR0aW5nc0NhY2hlIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9zZXR0aW5nc0NhY2hlLmpzJ1xuaW1wb3J0IHR5cGUgeyBWYWxpZGF0aW9uRXJyb3IgfSBmcm9tICcuL3V0aWxzL3NldHRpbmdzL3ZhbGlkYXRpb24uanMnXG5pbXBvcnQge1xuICBERUZBVUxUX1RBU0tTX01PREVfVEFTS19MSVNUX0lELFxuICBUQVNLX1NUQVRVU0VTLFxufSBmcm9tICcuL3V0aWxzL3Rhc2tzLmpzJ1xuaW1wb3J0IHtcbiAgbG9nUGx1Z2luTG9hZEVycm9ycyxcbiAgbG9nUGx1Z2luc0VuYWJsZWRGb3JTZXNzaW9uLFxufSBmcm9tICcuL3V0aWxzL3RlbGVtZXRyeS9wbHVnaW5UZWxlbWV0cnkuanMnXG5pbXBvcnQgeyBsb2dTa2lsbHNMb2FkZWQgfSBmcm9tICcuL3V0aWxzL3RlbGVtZXRyeS9za2lsbExvYWRlZEV2ZW50LmpzJ1xuaW1wb3J0IHsgZ2VuZXJhdGVUZW1wRmlsZVBhdGggfSBmcm9tICcuL3V0aWxzL3RlbXBmaWxlLmpzJ1xuaW1wb3J0IHsgdmFsaWRhdGVVdWlkIH0gZnJvbSAnLi91dGlscy91dWlkLmpzJ1xuLy8gUGx1Z2luIHN0YXJ0dXAgY2hlY2tzIGFyZSBub3cgaGFuZGxlZCBub24tYmxvY2tpbmdseSBpbiBSRVBMLnRzeFxuXG5pbXBvcnQgeyByZWdpc3Rlck1jcEFkZENvbW1hbmQgfSBmcm9tICdzcmMvY29tbWFuZHMvbWNwL2FkZENvbW1hbmQuanMnXG5pbXBvcnQgeyByZWdpc3Rlck1jcFhhYUlkcENvbW1hbmQgfSBmcm9tICdzcmMvY29tbWFuZHMvbWNwL3hhYUlkcENvbW1hbmQuanMnXG5pbXBvcnQgeyBsb2dQZXJtaXNzaW9uQ29udGV4dEZvckFudHMgfSBmcm9tICdzcmMvc2VydmljZXMvaW50ZXJuYWxMb2dnaW5nLmpzJ1xuaW1wb3J0IHsgZmV0Y2hDbGF1ZGVBSU1jcENvbmZpZ3NJZkVsaWdpYmxlIH0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC9jbGF1ZGVhaS5qcydcbmltcG9ydCB7IGNsZWFyU2VydmVyQ2FjaGUgfSBmcm9tICdzcmMvc2VydmljZXMvbWNwL2NsaWVudC5qcydcbmltcG9ydCB7XG4gIGFyZU1jcENvbmZpZ3NBbGxvd2VkV2l0aEVudGVycHJpc2VNY3BDb25maWcsXG4gIGRlZHVwQ2xhdWRlQWlNY3BTZXJ2ZXJzLFxuICBkb2VzRW50ZXJwcmlzZU1jcENvbmZpZ0V4aXN0LFxuICBmaWx0ZXJNY3BTZXJ2ZXJzQnlQb2xpY3ksXG4gIGdldENsYXVkZUNvZGVNY3BDb25maWdzLFxuICBnZXRNY3BTZXJ2ZXJTaWduYXR1cmUsXG4gIHBhcnNlTWNwQ29uZmlnLFxuICBwYXJzZU1jcENvbmZpZ0Zyb21GaWxlUGF0aCxcbn0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC9jb25maWcuanMnXG5pbXBvcnQge1xuICBleGNsdWRlQ29tbWFuZHNCeVNlcnZlcixcbiAgZXhjbHVkZVJlc291cmNlc0J5U2VydmVyLFxufSBmcm9tICdzcmMvc2VydmljZXMvbWNwL3V0aWxzLmpzJ1xuaW1wb3J0IHsgaXNYYWFFbmFibGVkIH0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC94YWFJZHBMb2dpbi5qcydcbmltcG9ydCB7IGdldFJlbGV2YW50VGlwcyB9IGZyb20gJ3NyYy9zZXJ2aWNlcy90aXBzL3RpcFJlZ2lzdHJ5LmpzJ1xuaW1wb3J0IHsgbG9nQ29udGV4dE1ldHJpY3MgfSBmcm9tICdzcmMvdXRpbHMvYXBpLmpzJ1xuaW1wb3J0IHtcbiAgQ0xBVURFX0lOX0NIUk9NRV9NQ1BfU0VSVkVSX05BTUUsXG4gIGlzQ2xhdWRlSW5DaHJvbWVNQ1BTZXJ2ZXIsXG59IGZyb20gJ3NyYy91dGlscy9jbGF1ZGVJbkNocm9tZS9jb21tb24uanMnXG5pbXBvcnQgeyByZWdpc3RlckNsZWFudXAgfSBmcm9tICdzcmMvdXRpbHMvY2xlYW51cFJlZ2lzdHJ5LmpzJ1xuaW1wb3J0IHsgZWFnZXJQYXJzZUNsaUZsYWcgfSBmcm9tICdzcmMvdXRpbHMvY2xpQXJncy5qcydcbmltcG9ydCB7IGNyZWF0ZUVtcHR5QXR0cmlidXRpb25TdGF0ZSB9IGZyb20gJ3NyYy91dGlscy9jb21taXRBdHRyaWJ1dGlvbi5qcydcbmltcG9ydCB7XG4gIGNvdW50Q29uY3VycmVudFNlc3Npb25zLFxuICByZWdpc3RlclNlc3Npb24sXG4gIHVwZGF0ZVNlc3Npb25OYW1lLFxufSBmcm9tICdzcmMvdXRpbHMvY29uY3VycmVudFNlc3Npb25zLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnc3JjL3V0aWxzL2N3ZC5qcydcbmltcG9ydCB7IGxvZ0ZvckRlYnVnZ2luZywgc2V0SGFzRm9ybWF0dGVkT3V0cHV0IH0gZnJvbSAnc3JjL3V0aWxzL2RlYnVnLmpzJ1xuaW1wb3J0IHtcbiAgZXJyb3JNZXNzYWdlLFxuICBnZXRFcnJub0NvZGUsXG4gIGlzRU5PRU5ULFxuICBUZWxlcG9ydE9wZXJhdGlvbkVycm9yLFxuICB0b0Vycm9yLFxufSBmcm9tICdzcmMvdXRpbHMvZXJyb3JzLmpzJ1xuaW1wb3J0IHsgZ2V0RnNJbXBsZW1lbnRhdGlvbiwgc2FmZVJlc29sdmVQYXRoIH0gZnJvbSAnc3JjL3V0aWxzL2ZzT3BlcmF0aW9ucy5qcydcbmltcG9ydCB7XG4gIGdyYWNlZnVsU2h1dGRvd24sXG4gIGdyYWNlZnVsU2h1dGRvd25TeW5jLFxufSBmcm9tICdzcmMvdXRpbHMvZ3JhY2VmdWxTaHV0ZG93bi5qcydcbmltcG9ydCB7IHNldEFsbEhvb2tFdmVudHNFbmFibGVkIH0gZnJvbSAnc3JjL3V0aWxzL2hvb2tzL2hvb2tFdmVudHMuanMnXG5pbXBvcnQgeyByZWZyZXNoTW9kZWxDYXBhYmlsaXRpZXMgfSBmcm9tICdzcmMvdXRpbHMvbW9kZWwvbW9kZWxDYXBhYmlsaXRpZXMuanMnXG5pbXBvcnQgeyBwZWVrRm9yU3RkaW5EYXRhLCB3cml0ZVRvU3RkZXJyIH0gZnJvbSAnc3JjL3V0aWxzL3Byb2Nlc3MuanMnXG5pbXBvcnQgeyBzZXRDd2QgfSBmcm9tICdzcmMvdXRpbHMvU2hlbGwuanMnXG5pbXBvcnQge1xuICB0eXBlIFByb2Nlc3NlZFJlc3VtZSxcbiAgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24sXG59IGZyb20gJ3NyYy91dGlscy9zZXNzaW9uUmVzdG9yZS5qcydcbmltcG9ydCB7IHBhcnNlU2V0dGluZ1NvdXJjZXNGbGFnIH0gZnJvbSAnc3JjL3V0aWxzL3NldHRpbmdzL2NvbnN0YW50cy5qcydcbmltcG9ydCB7IHBsdXJhbCB9IGZyb20gJ3NyYy91dGlscy9zdHJpbmdVdGlscy5qcydcbmltcG9ydCB7XG4gIHR5cGUgQ2hhbm5lbEVudHJ5LFxuICBnZXRJbml0aWFsTWFpbkxvb3BNb2RlbCxcbiAgZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24sXG4gIGdldFNka0JldGFzLFxuICBnZXRTZXNzaW9uSWQsXG4gIGdldFVzZXJNc2dPcHRJbixcbiAgc2V0QWxsb3dlZENoYW5uZWxzLFxuICBzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMsXG4gIHNldENocm9tZUZsYWdPdmVycmlkZSxcbiAgc2V0Q2xpZW50VHlwZSxcbiAgc2V0Q3dkU3RhdGUsXG4gIHNldERpcmVjdENvbm5lY3RTZXJ2ZXJVcmwsXG4gIHNldEZsYWdTZXR0aW5nc1BhdGgsXG4gIHNldEluaXRpYWxNYWluTG9vcE1vZGVsLFxuICBzZXRJbmxpbmVQbHVnaW5zLFxuICBzZXRJc0ludGVyYWN0aXZlLFxuICBzZXRLYWlyb3NBY3RpdmUsXG4gIHNldE9yaWdpbmFsQ3dkLFxuICBzZXRRdWVzdGlvblByZXZpZXdGb3JtYXQsXG4gIHNldFNka0JldGFzLFxuICBzZXRTZXNzaW9uQnlwYXNzUGVybWlzc2lvbnNNb2RlLFxuICBzZXRTZXNzaW9uUGVyc2lzdGVuY2VEaXNhYmxlZCxcbiAgc2V0U2Vzc2lvblNvdXJjZSxcbiAgc2V0VXNlck1zZ09wdEluLFxuICBzd2l0Y2hTZXNzaW9uLFxufSBmcm9tICcuL2Jvb3RzdHJhcC9zdGF0ZS5qcydcblxuLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuY29uc3QgYXV0b01vZGVTdGF0ZU1vZHVsZSA9IGZlYXR1cmUoJ1RSQU5TQ1JJUFRfQ0xBU1NJRklFUicpXG4gID8gKHJlcXVpcmUoJy4vdXRpbHMvcGVybWlzc2lvbnMvYXV0b01vZGVTdGF0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvcGVybWlzc2lvbnMvYXV0b01vZGVTdGF0ZS5qcycpKVxuICA6IG51bGxcblxuLy8gVGVsZXBvcnRSZXBvTWlzbWF0Y2hEaWFsb2csIFRlbGVwb3J0UmVzdW1lV3JhcHBlciBkeW5hbWljYWxseSBpbXBvcnRlZCBhdCBjYWxsIHNpdGVzXG5pbXBvcnQgeyBtaWdyYXRlQXV0b1VwZGF0ZXNUb1NldHRpbmdzIH0gZnJvbSAnLi9taWdyYXRpb25zL21pZ3JhdGVBdXRvVXBkYXRlc1RvU2V0dGluZ3MuanMnXG5pbXBvcnQgeyBtaWdyYXRlQnlwYXNzUGVybWlzc2lvbnNBY2NlcHRlZFRvU2V0dGluZ3MgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZUJ5cGFzc1Blcm1pc3Npb25zQWNjZXB0ZWRUb1NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUVuYWJsZUFsbFByb2plY3RNY3BTZXJ2ZXJzVG9TZXR0aW5ncyB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlRW5hYmxlQWxsUHJvamVjdE1jcFNlcnZlcnNUb1NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUZlbm5lY1RvT3B1cyB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlRmVubmVjVG9PcHVzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQuanMnXG5pbXBvcnQgeyBtaWdyYXRlT3B1c1RvT3B1czFtIH0gZnJvbSAnLi9taWdyYXRpb25zL21pZ3JhdGVPcHVzVG9PcHVzMW0uanMnXG5pbXBvcnQgeyBtaWdyYXRlUmVwbEJyaWRnZUVuYWJsZWRUb1JlbW90ZUNvbnRyb2xBdFN0YXJ0dXAgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZVNvbm5ldDFtVG9Tb25uZXQ0NSB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1LmpzJ1xuaW1wb3J0IHsgbWlncmF0ZVNvbm5ldDQ1VG9Tb25uZXQ0NiB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlU29ubmV0NDVUb1Nvbm5ldDQ2LmpzJ1xuaW1wb3J0IHsgcmVzZXRBdXRvTW9kZU9wdEluRm9yRGVmYXVsdE9mZmVyIH0gZnJvbSAnLi9taWdyYXRpb25zL3Jlc2V0QXV0b01vZGVPcHRJbkZvckRlZmF1bHRPZmZlci5qcydcbmltcG9ydCB7IHJlc2V0UHJvVG9PcHVzRGVmYXVsdCB9IGZyb20gJy4vbWlncmF0aW9ucy9yZXNldFByb1RvT3B1c0RlZmF1bHQuanMnXG5pbXBvcnQgeyBjcmVhdGVSZW1vdGVTZXNzaW9uQ29uZmlnIH0gZnJvbSAnLi9yZW1vdGUvUmVtb3RlU2Vzc2lvbk1hbmFnZXIuanMnXG4vKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbi8vIHRlbGVwb3J0V2l0aFByb2dyZXNzIGR5bmFtaWNhbGx5IGltcG9ydGVkIGF0IGNhbGwgc2l0ZVxuaW1wb3J0IHtcbiAgY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24sXG4gIERpcmVjdENvbm5lY3RFcnJvcixcbn0gZnJvbSAnLi9zZXJ2ZXIvY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24uanMnXG5pbXBvcnQgeyBpbml0aWFsaXplTHNwU2VydmVyTWFuYWdlciB9IGZyb20gJy4vc2VydmljZXMvbHNwL21hbmFnZXIuanMnXG5pbXBvcnQgeyBzaG91bGRFbmFibGVQcm9tcHRTdWdnZXN0aW9uIH0gZnJvbSAnLi9zZXJ2aWNlcy9Qcm9tcHRTdWdnZXN0aW9uL3Byb21wdFN1Z2dlc3Rpb24uanMnXG5pbXBvcnQge1xuICB0eXBlIEFwcFN0YXRlLFxuICBnZXREZWZhdWx0QXBwU3RhdGUsXG4gIElETEVfU1BFQ1VMQVRJT05fU1RBVEUsXG59IGZyb20gJy4vc3RhdGUvQXBwU3RhdGVTdG9yZS5qcydcbmltcG9ydCB7IG9uQ2hhbmdlQXBwU3RhdGUgfSBmcm9tICcuL3N0YXRlL29uQ2hhbmdlQXBwU3RhdGUuanMnXG5pbXBvcnQgeyBjcmVhdGVTdG9yZSB9IGZyb20gJy4vc3RhdGUvc3RvcmUuanMnXG5pbXBvcnQgeyBhc1Nlc3Npb25JZCB9IGZyb20gJy4vdHlwZXMvaWRzLmpzJ1xuaW1wb3J0IHsgZmlsdGVyQWxsb3dlZFNka0JldGFzIH0gZnJvbSAnLi91dGlscy9iZXRhcy5qcydcbmltcG9ydCB7IGlzSW5CdW5kbGVkTW9kZSwgaXNSdW5uaW5nV2l0aEJ1biB9IGZyb20gJy4vdXRpbHMvYnVuZGxlZE1vZGUuanMnXG5pbXBvcnQgeyBsb2dGb3JEaWFnbm9zdGljc05vUElJIH0gZnJvbSAnLi91dGlscy9kaWFnTG9ncy5qcydcbmltcG9ydCB7XG4gIGZpbHRlckV4aXN0aW5nUGF0aHMsXG4gIGdldEtub3duUGF0aHNGb3JSZXBvLFxufSBmcm9tICcuL3V0aWxzL2dpdGh1YlJlcG9QYXRoTWFwcGluZy5qcydcbmltcG9ydCB7XG4gIGNsZWFyUGx1Z2luQ2FjaGUsXG4gIGxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5LFxufSBmcm9tICcuL3V0aWxzL3BsdWdpbnMvcGx1Z2luTG9hZGVyLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUNoYW5nZWxvZ0Zyb21Db25maWcgfSBmcm9tICcuL3V0aWxzL3JlbGVhc2VOb3Rlcy5qcydcbmltcG9ydCB7IFNhbmRib3hNYW5hZ2VyIH0gZnJvbSAnLi91dGlscy9zYW5kYm94L3NhbmRib3gtYWRhcHRlci5qcydcbmltcG9ydCB7IGZldGNoU2Vzc2lvbiwgcHJlcGFyZUFwaVJlcXVlc3QgfSBmcm9tICcuL3V0aWxzL3RlbGVwb3J0L2FwaS5qcydcbmltcG9ydCB7XG4gIGNoZWNrT3V0VGVsZXBvcnRlZFNlc3Npb25CcmFuY2gsXG4gIHByb2Nlc3NNZXNzYWdlc0ZvclRlbGVwb3J0UmVzdW1lLFxuICB0ZWxlcG9ydFRvUmVtb3RlV2l0aEVycm9ySGFuZGxpbmcsXG4gIHZhbGlkYXRlR2l0U3RhdGUsXG4gIHZhbGlkYXRlU2Vzc2lvblJlcG9zaXRvcnksXG59IGZyb20gJy4vdXRpbHMvdGVsZXBvcnQuanMnXG5pbXBvcnQge1xuICBzaG91bGRFbmFibGVUaGlua2luZ0J5RGVmYXVsdCxcbiAgdHlwZSBUaGlua2luZ0NvbmZpZyxcbn0gZnJvbSAnLi91dGlscy90aGlua2luZy5qcydcbmltcG9ydCB7IGluaXRVc2VyLCByZXNldFVzZXJDYWNoZSB9IGZyb20gJy4vdXRpbHMvdXNlci5qcydcbmltcG9ydCB7XG4gIGdldFRtdXhJbnN0YWxsSW5zdHJ1Y3Rpb25zLFxuICBpc1RtdXhBdmFpbGFibGUsXG4gIHBhcnNlUFJSZWZlcmVuY2UsXG59IGZyb20gJy4vdXRpbHMvd29ya3RyZWUuanMnXG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xucHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fdHN4X2ltcG9ydHNfbG9hZGVkJylcblxuLyoqXG4gKiBMb2cgbWFuYWdlZCBzZXR0aW5ncyBrZXlzIHRvIFN0YXRzaWcgZm9yIGFuYWx5dGljcy5cbiAqIFRoaXMgaXMgY2FsbGVkIGFmdGVyIGluaXQoKSBjb21wbGV0ZXMgdG8gZW5zdXJlIHNldHRpbmdzIGFyZSBsb2FkZWRcbiAqIGFuZCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgYXJlIGFwcGxpZWQgYmVmb3JlIG1vZGVsIHJlc29sdXRpb24uXG4gKi9cbmZ1bmN0aW9uIGxvZ01hbmFnZWRTZXR0aW5ncygpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwb2xpY3lTZXR0aW5ncyA9IGdldFNldHRpbmdzRm9yU291cmNlKCdwb2xpY3lTZXR0aW5ncycpXG4gICAgaWYgKHBvbGljeVNldHRpbmdzKSB7XG4gICAgICBjb25zdCBhbGxLZXlzID0gZ2V0TWFuYWdlZFNldHRpbmdzS2V5c0ZvckxvZ2dpbmcocG9saWN5U2V0dGluZ3MpXG4gICAgICBsb2dFdmVudCgndGVuZ3VfbWFuYWdlZF9zZXR0aW5nc19sb2FkZWQnLCB7XG4gICAgICAgIGtleUNvdW50OiBhbGxLZXlzLmxlbmd0aCxcbiAgICAgICAga2V5czogYWxsS2V5cy5qb2luKFxuICAgICAgICAgICcsJyxcbiAgICAgICAgKSBhcyB1bmtub3duIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gU2lsZW50bHkgaWdub3JlIGVycm9ycyAtIHRoaXMgaXMganVzdCBmb3IgYW5hbHl0aWNzXG4gIH1cbn1cblxuLy8gQ2hlY2sgaWYgcnVubmluZyBpbiBkZWJ1Zy9pbnNwZWN0aW9uIG1vZGVcbmZ1bmN0aW9uIGlzQmVpbmdEZWJ1Z2dlZCgpIHtcbiAgY29uc3QgaXNCdW4gPSBpc1J1bm5pbmdXaXRoQnVuKClcblxuICAvLyBDaGVjayBmb3IgaW5zcGVjdCBmbGFncyBpbiBwcm9jZXNzIGFyZ3VtZW50cyAoaW5jbHVkaW5nIGFsbCB2YXJpYW50cylcbiAgY29uc3QgaGFzSW5zcGVjdEFyZyA9IHByb2Nlc3MuZXhlY0FyZ3Yuc29tZShhcmcgPT4ge1xuICAgIGlmIChpc0J1bikge1xuICAgICAgLy8gTm90ZTogQnVuIGhhcyBhbiBpc3N1ZSB3aXRoIHNpbmdsZS1maWxlIGV4ZWN1dGFibGVzIHdoZXJlIGFwcGxpY2F0aW9uIGFyZ3VtZW50c1xuICAgICAgLy8gZnJvbSBwcm9jZXNzLmFyZ3YgbGVhayBpbnRvIHByb2Nlc3MuZXhlY0FyZ3YgKHNpbWlsYXIgdG8gaHR0cHM6Ly9naXRodWIuY29tL292ZW4tc2gvYnVuL2lzc3Vlcy8xMTY3MylcbiAgICAgIC8vIFRoaXMgYnJlYWtzIHVzZSBvZiAtLWRlYnVnIG1vZGUgaWYgd2Ugb21pdCB0aGlzIGJyYW5jaFxuICAgICAgLy8gV2UncmUgZmluZSB0byBza2lwIHRoYXQgY2hlY2ssIGJlY2F1c2UgQnVuIGRvZXNuJ3Qgc3VwcG9ydCBOb2RlLmpzIGxlZ2FjeSAtLWRlYnVnIG9yIC0tZGVidWctYnJrIGZsYWdzXG4gICAgICByZXR1cm4gLy0taW5zcGVjdCgtYnJrKT8vLnRlc3QoYXJnKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBJbiBOb2RlLmpzLCBjaGVjayBmb3IgYm90aCAtLWluc3BlY3QgYW5kIGxlZ2FjeSAtLWRlYnVnIGZsYWdzXG4gICAgICByZXR1cm4gLy0taW5zcGVjdCgtYnJrKT98LS1kZWJ1ZygtYnJrKT8vLnRlc3QoYXJnKVxuICAgIH1cbiAgfSlcblxuICAvLyBDaGVjayBpZiBOT0RFX09QVElPTlMgY29udGFpbnMgaW5zcGVjdCBmbGFnc1xuICBjb25zdCBoYXNJbnNwZWN0RW52ID1cbiAgICBwcm9jZXNzLmVudi5OT0RFX09QVElPTlMgJiZcbiAgICAvLS1pbnNwZWN0KC1icmspP3wtLWRlYnVnKC1icmspPy8udGVzdChwcm9jZXNzLmVudi5OT0RFX09QVElPTlMpXG5cbiAgLy8gQ2hlY2sgaWYgaW5zcGVjdG9yIGlzIGF2YWlsYWJsZSBhbmQgYWN0aXZlIChpbmRpY2F0ZXMgZGVidWdnaW5nKVxuICB0cnkge1xuICAgIC8vIER5bmFtaWMgaW1wb3J0IHdvdWxkIGJlIGJldHRlciBidXQgaXMgYXN5bmMgLSB1c2UgZ2xvYmFsIG9iamVjdCBpbnN0ZWFkXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICBjb25zdCBpbnNwZWN0b3IgPSAoZ2xvYmFsIGFzIGFueSkucmVxdWlyZSgnaW5zcGVjdG9yJylcbiAgICBjb25zdCBoYXNJbnNwZWN0b3JVcmwgPSAhIWluc3BlY3Rvci51cmwoKVxuICAgIHJldHVybiBoYXNJbnNwZWN0b3JVcmwgfHwgaGFzSW5zcGVjdEFyZyB8fCBoYXNJbnNwZWN0RW52XG4gIH0gY2F0Y2gge1xuICAgIC8vIElnbm9yZSBlcnJvciBhbmQgZmFsbCBiYWNrIHRvIGFyZ3VtZW50IGRldGVjdGlvblxuICAgIHJldHVybiBoYXNJbnNwZWN0QXJnIHx8IGhhc0luc3BlY3RFbnZcbiAgfVxufVxuXG4vLyBFeGl0IGlmIHdlIGRldGVjdCBub2RlIGRlYnVnZ2luZyBvciBpbnNwZWN0aW9uXG5pZiAoXCJleHRlcm5hbFwiICE9PSAnYW50JyAmJiBpc0JlaW5nRGVidWdnZWQoKSkge1xuICAvLyBVc2UgcHJvY2Vzcy5leGl0IGRpcmVjdGx5IGhlcmUgc2luY2Ugd2UncmUgaW4gdGhlIHRvcC1sZXZlbCBjb2RlIGJlZm9yZSBpbXBvcnRzXG4gIC8vIGFuZCBncmFjZWZ1bFNodXRkb3duIGlzIG5vdCB5ZXQgYXZhaWxhYmxlXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xuICBwcm9jZXNzLmV4aXQoMSlcbn1cblxuLyoqXG4gKiBQZXItc2Vzc2lvbiBza2lsbC9wbHVnaW4gdGVsZW1ldHJ5LiBDYWxsZWQgZnJvbSBib3RoIHRoZSBpbnRlcmFjdGl2ZSBwYXRoXG4gKiBhbmQgdGhlIGhlYWRsZXNzIC1wIHBhdGggKGJlZm9yZSBydW5IZWFkbGVzcykg4oCUIGJvdGggZ28gdGhyb3VnaFxuICogbWFpbi50c3ggYnV0IGJyYW5jaCBiZWZvcmUgdGhlIGludGVyYWN0aXZlIHN0YXJ0dXAgcGF0aCwgc28gaXQgbmVlZHMgdHdvXG4gKiBjYWxsIHNpdGVzIGhlcmUgcmF0aGVyIHRoYW4gb25lIGhlcmUgKyBvbmUgaW4gUXVlcnlFbmdpbmUuXG4gKi9cbmZ1bmN0aW9uIGxvZ1Nlc3Npb25UZWxlbWV0cnkoKTogdm9pZCB7XG4gIGNvbnN0IG1vZGVsID0gcGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwoXG4gICAgZ2V0SW5pdGlhbE1haW5Mb29wTW9kZWwoKSA/PyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpLFxuICApXG4gIHZvaWQgbG9nU2tpbGxzTG9hZGVkKGdldEN3ZCgpLCBnZXRDb250ZXh0V2luZG93Rm9yTW9kZWwobW9kZWwsIGdldFNka0JldGFzKCkpKVxuICB2b2lkIGxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5KClcbiAgICAudGhlbigoeyBlbmFibGVkLCBlcnJvcnMgfSkgPT4ge1xuICAgICAgY29uc3QgbWFuYWdlZE5hbWVzID0gZ2V0TWFuYWdlZFBsdWdpbk5hbWVzKClcbiAgICAgIGxvZ1BsdWdpbnNFbmFibGVkRm9yU2Vzc2lvbihlbmFibGVkLCBtYW5hZ2VkTmFtZXMsIGdldFBsdWdpblNlZWREaXJzKCkpXG4gICAgICBsb2dQbHVnaW5Mb2FkRXJyb3JzKGVycm9ycywgbWFuYWdlZE5hbWVzKVxuICAgIH0pXG4gICAgLmNhdGNoKGVyciA9PiBsb2dFcnJvcihlcnIpKVxufVxuXG5mdW5jdGlvbiBnZXRDZXJ0RW52VmFyVGVsZW1ldHJ5KCk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+IHtcbiAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9XG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VYVFJBX0NBX0NFUlRTKSB7XG4gICAgcmVzdWx0Lmhhc19ub2RlX2V4dHJhX2NhX2NlcnRzID0gdHJ1ZVxuICB9XG4gIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9DTElFTlRfQ0VSVCkge1xuICAgIHJlc3VsdC5oYXNfY2xpZW50X2NlcnQgPSB0cnVlXG4gIH1cbiAgaWYgKGhhc05vZGVPcHRpb24oJy0tdXNlLXN5c3RlbS1jYScpKSB7XG4gICAgcmVzdWx0Lmhhc191c2Vfc3lzdGVtX2NhID0gdHJ1ZVxuICB9XG4gIGlmIChoYXNOb2RlT3B0aW9uKCctLXVzZS1vcGVuc3NsLWNhJykpIHtcbiAgICByZXN1bHQuaGFzX3VzZV9vcGVuc3NsX2NhID0gdHJ1ZVxuICB9XG4gIHJldHVybiByZXN1bHRcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9nU3RhcnR1cFRlbGVtZXRyeSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGlzQW5hbHl0aWNzRGlzYWJsZWQoKSkgcmV0dXJuXG4gIGNvbnN0IFtpc0dpdCwgd29ya3RyZWVDb3VudCwgZ2hBdXRoU3RhdHVzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBnZXRJc0dpdCgpLFxuICAgIGdldFdvcmt0cmVlQ291bnQoKSxcbiAgICBnZXRHaEF1dGhTdGF0dXMoKSxcbiAgXSlcblxuICBsb2dFdmVudCgndGVuZ3Vfc3RhcnR1cF90ZWxlbWV0cnknLCB7XG4gICAgaXNfZ2l0OiBpc0dpdCxcbiAgICB3b3JrdHJlZV9jb3VudDogd29ya3RyZWVDb3VudCxcbiAgICBnaF9hdXRoX3N0YXR1czpcbiAgICAgIGdoQXV0aFN0YXR1cyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgIHNhbmRib3hfZW5hYmxlZDogU2FuZGJveE1hbmFnZXIuaXNTYW5kYm94aW5nRW5hYmxlZCgpLFxuICAgIGFyZV91bnNhbmRib3hlZF9jb21tYW5kc19hbGxvd2VkOlxuICAgICAgU2FuZGJveE1hbmFnZXIuYXJlVW5zYW5kYm94ZWRDb21tYW5kc0FsbG93ZWQoKSxcbiAgICBpc19hdXRvX2Jhc2hfYWxsb3dlZF9pZl9zYW5kYm94X2VuYWJsZWQ6XG4gICAgICBTYW5kYm94TWFuYWdlci5pc0F1dG9BbGxvd0Jhc2hJZlNhbmRib3hlZEVuYWJsZWQoKSxcbiAgICBhdXRvX3VwZGF0ZXJfZGlzYWJsZWQ6IGlzQXV0b1VwZGF0ZXJEaXNhYmxlZCgpLFxuICAgIHByZWZlcnNfcmVkdWNlZF9tb3Rpb246IGdldEluaXRpYWxTZXR0aW5ncygpLnByZWZlcnNSZWR1Y2VkTW90aW9uID8/IGZhbHNlLFxuICAgIC4uLmdldENlcnRFbnZWYXJUZWxlbWV0cnkoKSxcbiAgfSlcbn1cblxuLy8gQFtNT0RFTCBMQVVOQ0hdOiBDb25zaWRlciBhbnkgbWlncmF0aW9ucyB5b3UgbWF5IG5lZWQgZm9yIG1vZGVsIHN0cmluZ3MuIFNlZSBtaWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1LnRzIGZvciBhbiBleGFtcGxlLlxuLy8gQnVtcCB0aGlzIHdoZW4gYWRkaW5nIGEgbmV3IHN5bmMgbWlncmF0aW9uIHNvIGV4aXN0aW5nIHVzZXJzIHJlLXJ1biB0aGUgc2V0LlxuY29uc3QgQ1VSUkVOVF9NSUdSQVRJT05fVkVSU0lPTiA9IDExXG5mdW5jdGlvbiBydW5NaWdyYXRpb25zKCk6IHZvaWQge1xuICBpZiAoZ2V0R2xvYmFsQ29uZmlnKCkubWlncmF0aW9uVmVyc2lvbiAhPT0gQ1VSUkVOVF9NSUdSQVRJT05fVkVSU0lPTikge1xuICAgIG1pZ3JhdGVBdXRvVXBkYXRlc1RvU2V0dGluZ3MoKVxuICAgIG1pZ3JhdGVCeXBhc3NQZXJtaXNzaW9uc0FjY2VwdGVkVG9TZXR0aW5ncygpXG4gICAgbWlncmF0ZUVuYWJsZUFsbFByb2plY3RNY3BTZXJ2ZXJzVG9TZXR0aW5ncygpXG4gICAgcmVzZXRQcm9Ub09wdXNEZWZhdWx0KClcbiAgICBtaWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1KClcbiAgICBtaWdyYXRlTGVnYWN5T3B1c1RvQ3VycmVudCgpXG4gICAgbWlncmF0ZVNvbm5ldDQ1VG9Tb25uZXQ0NigpXG4gICAgbWlncmF0ZU9wdXNUb09wdXMxbSgpXG4gICAgbWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwKClcbiAgICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICAgIHJlc2V0QXV0b01vZGVPcHRJbkZvckRlZmF1bHRPZmZlcigpXG4gICAgfVxuICAgIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgICBtaWdyYXRlRmVubmVjVG9PcHVzKClcbiAgICB9XG4gICAgc2F2ZUdsb2JhbENvbmZpZyhwcmV2ID0+XG4gICAgICBwcmV2Lm1pZ3JhdGlvblZlcnNpb24gPT09IENVUlJFTlRfTUlHUkFUSU9OX1ZFUlNJT05cbiAgICAgICAgPyBwcmV2XG4gICAgICAgIDogeyAuLi5wcmV2LCBtaWdyYXRpb25WZXJzaW9uOiBDVVJSRU5UX01JR1JBVElPTl9WRVJTSU9OIH0sXG4gICAgKVxuICB9XG4gIC8vIEFzeW5jIG1pZ3JhdGlvbiAtIGZpcmUgYW5kIGZvcmdldCBzaW5jZSBpdCdzIG5vbi1ibG9ja2luZ1xuICBtaWdyYXRlQ2hhbmdlbG9nRnJvbUNvbmZpZygpLmNhdGNoKCgpID0+IHtcbiAgICAvLyBTaWxlbnRseSBpZ25vcmUgbWlncmF0aW9uIGVycm9ycyAtIHdpbGwgcmV0cnkgb24gbmV4dCBzdGFydHVwXG4gIH0pXG59XG5cbi8qKlxuICogUHJlZmV0Y2ggc3lzdGVtIGNvbnRleHQgKGluY2x1ZGluZyBnaXQgc3RhdHVzKSBvbmx5IHdoZW4gaXQncyBzYWZlIHRvIGRvIHNvLlxuICogR2l0IGNvbW1hbmRzIGNhbiBleGVjdXRlIGFyYml0cmFyeSBjb2RlIHZpYSBob29rcyBhbmQgY29uZmlnIChlLmcuLCBjb3JlLmZzbW9uaXRvcixcbiAqIGRpZmYuZXh0ZXJuYWwpLCBzbyB3ZSBtdXN0IG9ubHkgcnVuIHRoZW0gYWZ0ZXIgdHJ1c3QgaXMgZXN0YWJsaXNoZWQgb3IgaW5cbiAqIG5vbi1pbnRlcmFjdGl2ZSBtb2RlIHdoZXJlIHRydXN0IGlzIGltcGxpY2l0LlxuICovXG5mdW5jdGlvbiBwcmVmZXRjaFN5c3RlbUNvbnRleHRJZlNhZmUoKTogdm9pZCB7XG4gIGNvbnN0IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uID0gZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24oKVxuXG4gIC8vIEluIG5vbi1pbnRlcmFjdGl2ZSBtb2RlICgtLXByaW50KSwgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kXG4gIC8vIGV4ZWN1dGlvbiBpcyBjb25zaWRlcmVkIHRydXN0ZWQgKGFzIGRvY3VtZW50ZWQgaW4gaGVscCB0ZXh0KVxuICBpZiAoaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24pIHtcbiAgICBsb2dGb3JEaWFnbm9zdGljc05vUElJKCdpbmZvJywgJ3ByZWZldGNoX3N5c3RlbV9jb250ZXh0X25vbl9pbnRlcmFjdGl2ZScpXG4gICAgdm9pZCBnZXRTeXN0ZW1Db250ZXh0KClcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIEluIGludGVyYWN0aXZlIG1vZGUsIG9ubHkgcHJlZmV0Y2ggaWYgdHJ1c3QgaGFzIGFscmVhZHkgYmVlbiBlc3RhYmxpc2hlZFxuICBjb25zdCBoYXNUcnVzdCA9IGNoZWNrSGFzVHJ1c3REaWFsb2dBY2NlcHRlZCgpXG4gIGlmIChoYXNUcnVzdCkge1xuICAgIGxvZ0ZvckRpYWdub3N0aWNzTm9QSUkoJ2luZm8nLCAncHJlZmV0Y2hfc3lzdGVtX2NvbnRleHRfaGFzX3RydXN0JylcbiAgICB2b2lkIGdldFN5c3RlbUNvbnRleHQoKVxuICB9IGVsc2Uge1xuICAgIGxvZ0ZvckRpYWdub3N0aWNzTm9QSUkoJ2luZm8nLCAncHJlZmV0Y2hfc3lzdGVtX2NvbnRleHRfc2tpcHBlZF9ub190cnVzdCcpXG4gIH1cbiAgLy8gT3RoZXJ3aXNlLCBkb24ndCBwcmVmZXRjaCAtIHdhaXQgZm9yIHRydXN0IHRvIGJlIGVzdGFibGlzaGVkIGZpcnN0XG59XG5cbi8qKlxuICogU3RhcnQgYmFja2dyb3VuZCBwcmVmZXRjaGVzIGFuZCBob3VzZWtlZXBpbmcgdGhhdCBhcmUgTk9UIG5lZWRlZCBiZWZvcmUgZmlyc3QgcmVuZGVyLlxuICogVGhlc2UgYXJlIGRlZmVycmVkIGZyb20gc2V0dXAoKSB0byByZWR1Y2UgZXZlbnQgbG9vcCBjb250ZW50aW9uIGFuZCBjaGlsZCBwcm9jZXNzXG4gKiBzcGF3bmluZyBkdXJpbmcgdGhlIGNyaXRpY2FsIHN0YXJ0dXAgcGF0aC5cbiAqIENhbGwgdGhpcyBhZnRlciB0aGUgUkVQTCBoYXMgYmVlbiByZW5kZXJlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzKCk6IHZvaWQge1xuICAvLyBUaGlzIGZ1bmN0aW9uIHJ1bnMgYWZ0ZXIgZmlyc3QgcmVuZGVyLCBzbyBpdCBkb2Vzbid0IGJsb2NrIHRoZSBpbml0aWFsIHBhaW50LlxuICAvLyBIb3dldmVyLCB0aGUgc3Bhd25lZCBwcm9jZXNzZXMgYW5kIGFzeW5jIHdvcmsgc3RpbGwgY29udGVuZCBmb3IgQ1BVIGFuZCBldmVudFxuICAvLyBsb29wIHRpbWUsIHdoaWNoIHNrZXdzIHN0YXJ0dXAgYmVuY2htYXJrcyAoQ1BVIHByb2ZpbGVzLCB0aW1lLXRvLWZpcnN0LXJlbmRlclxuICAvLyBtZWFzdXJlbWVudHMpLiBTa2lwIGFsbCBvZiBpdCB3aGVuIHdlJ3JlIG9ubHkgbWVhc3VyaW5nIHN0YXJ0dXAgcGVyZm9ybWFuY2UuXG4gIGlmIChcbiAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FWElUX0FGVEVSX0ZJUlNUX1JFTkRFUikgfHxcbiAgICAvLyAtLWJhcmU6IHNraXAgQUxMIHByZWZldGNoZXMuIFRoZXNlIGFyZSBjYWNoZS13YXJtcyBmb3IgdGhlIFJFUEwnc1xuICAgIC8vIGZpcnN0LXR1cm4gcmVzcG9uc2l2ZW5lc3MgKGluaXRVc2VyLCBnZXRVc2VyQ29udGV4dCwgdGlwcywgY291bnRGaWxlcyxcbiAgICAvLyBtb2RlbENhcGFiaWxpdGllcywgY2hhbmdlIGRldGVjdG9ycykuIFNjcmlwdGVkIC1wIGNhbGxzIGRvbid0IGhhdmUgYVxuICAgIC8vIFwidXNlciBpcyB0eXBpbmdcIiB3aW5kb3cgdG8gaGlkZSB0aGlzIHdvcmsgaW4g4oCUIGl0J3MgcHVyZSBvdmVyaGVhZCBvblxuICAgIC8vIHRoZSBjcml0aWNhbCBwYXRoLlxuICAgIGlzQmFyZU1vZGUoKVxuICApIHtcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIFByb2Nlc3Mtc3Bhd25pbmcgcHJlZmV0Y2hlcyAoY29uc3VtZWQgYXQgZmlyc3QgQVBJIGNhbGwsIHVzZXIgaXMgc3RpbGwgdHlwaW5nKVxuICB2b2lkIGluaXRVc2VyKClcbiAgdm9pZCBnZXRVc2VyQ29udGV4dCgpXG4gIHByZWZldGNoU3lzdGVtQ29udGV4dElmU2FmZSgpXG4gIHZvaWQgZ2V0UmVsZXZhbnRUaXBzKClcbiAgaWYgKFxuICAgIGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1VTRV9CRURST0NLKSAmJlxuICAgICFpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9TS0lQX0JFRFJPQ0tfQVVUSClcbiAgKSB7XG4gICAgdm9pZCBwcmVmZXRjaEF3c0NyZWRlbnRpYWxzQW5kQmVkUm9ja0luZm9JZlNhZmUoKVxuICB9XG4gIGlmIChcbiAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9VU0VfVkVSVEVYKSAmJlxuICAgICFpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9TS0lQX1ZFUlRFWF9BVVRIKVxuICApIHtcbiAgICB2b2lkIHByZWZldGNoR2NwQ3JlZGVudGlhbHNJZlNhZmUoKVxuICB9XG4gIHZvaWQgY291bnRGaWxlc1JvdW5kZWRSZyhnZXRDd2QoKSwgQWJvcnRTaWduYWwudGltZW91dCgzMDAwKSwgW10pXG5cbiAgLy8gQW5hbHl0aWNzIGFuZCBmZWF0dXJlIGZsYWcgaW5pdGlhbGl6YXRpb25cbiAgdm9pZCBpbml0aWFsaXplQW5hbHl0aWNzR2F0ZXMoKVxuICB2b2lkIHByZWZldGNoT2ZmaWNpYWxNY3BVcmxzKClcblxuICB2b2lkIHJlZnJlc2hNb2RlbENhcGFiaWxpdGllcygpXG5cbiAgLy8gRmlsZSBjaGFuZ2UgZGV0ZWN0b3JzIGRlZmVycmVkIGZyb20gaW5pdCgpIHRvIHVuYmxvY2sgZmlyc3QgcmVuZGVyXG4gIHZvaWQgc2V0dGluZ3NDaGFuZ2VEZXRlY3Rvci5pbml0aWFsaXplKClcbiAgaWYgKCFpc0JhcmVNb2RlKCkpIHtcbiAgICB2b2lkIHNraWxsQ2hhbmdlRGV0ZWN0b3IuaW5pdGlhbGl6ZSgpXG4gIH1cblxuICAvLyBFdmVudCBsb29wIHN0YWxsIGRldGVjdG9yIOKAlCBsb2dzIHdoZW4gdGhlIG1haW4gdGhyZWFkIGlzIGJsb2NrZWQgPjUwMG1zXG4gIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgdm9pZCBpbXBvcnQoJy4vdXRpbHMvZXZlbnRMb29wU3RhbGxEZXRlY3Rvci5qcycpLnRoZW4obSA9PlxuICAgICAgbS5zdGFydEV2ZW50TG9vcFN0YWxsRGV0ZWN0b3IoKSxcbiAgICApXG4gIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNldHRpbmdzRnJvbUZsYWcoc2V0dGluZ3NGaWxlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB0cmltbWVkU2V0dGluZ3MgPSBzZXR0aW5nc0ZpbGUudHJpbSgpXG4gICAgY29uc3QgbG9va3NMaWtlSnNvbiA9XG4gICAgICB0cmltbWVkU2V0dGluZ3Muc3RhcnRzV2l0aCgneycpICYmIHRyaW1tZWRTZXR0aW5ncy5lbmRzV2l0aCgnfScpXG5cbiAgICBsZXQgc2V0dGluZ3NQYXRoOiBzdHJpbmdcblxuICAgIGlmIChsb29rc0xpa2VKc29uKSB7XG4gICAgICAvLyBJdCdzIGEgSlNPTiBzdHJpbmcgLSB2YWxpZGF0ZSBhbmQgY3JlYXRlIHRlbXAgZmlsZVxuICAgICAgY29uc3QgcGFyc2VkSnNvbiA9IHNhZmVQYXJzZUpTT04odHJpbW1lZFNldHRpbmdzKVxuICAgICAgaWYgKCFwYXJzZWRKc29uKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgIGNoYWxrLnJlZCgnRXJyb3I6IEludmFsaWQgSlNPTiBwcm92aWRlZCB0byAtLXNldHRpbmdzXFxuJyksXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG5cbiAgICAgIC8vIENyZWF0ZSBhIHRlbXBvcmFyeSBmaWxlIGFuZCB3cml0ZSB0aGUgSlNPTiB0byBpdC5cbiAgICAgIC8vIFVzZSBhIGNvbnRlbnQtaGFzaC1iYXNlZCBwYXRoIGluc3RlYWQgb2YgcmFuZG9tIFVVSUQgdG8gYXZvaWRcbiAgICAgIC8vIGJ1c3RpbmcgdGhlIEFudGhyb3BpYyBBUEkgcHJvbXB0IGNhY2hlLiBUaGUgc2V0dGluZ3MgcGF0aCBlbmRzIHVwXG4gICAgICAvLyBpbiB0aGUgQmFzaCB0b29sJ3Mgc2FuZGJveCBkZW55V2l0aGluQWxsb3cgbGlzdCwgd2hpY2ggaXMgcGFydCBvZlxuICAgICAgLy8gdGhlIHRvb2wgZGVzY3JpcHRpb24gc2VudCB0byB0aGUgQVBJLiBBIHJhbmRvbSBVVUlEIHBlciBzdWJwcm9jZXNzXG4gICAgICAvLyBjaGFuZ2VzIHRoZSB0b29sIGRlc2NyaXB0aW9uIG9uIGV2ZXJ5IHF1ZXJ5KCkgY2FsbCwgaW52YWxpZGF0aW5nXG4gICAgICAvLyB0aGUgY2FjaGUgcHJlZml4IGFuZCBjYXVzaW5nIGEgMTJ4IGlucHV0IHRva2VuIGNvc3QgcGVuYWx0eS5cbiAgICAgIC8vIFRoZSBjb250ZW50IGhhc2ggZW5zdXJlcyBpZGVudGljYWwgc2V0dGluZ3MgcHJvZHVjZSB0aGUgc2FtZSBwYXRoXG4gICAgICAvLyBhY3Jvc3MgcHJvY2VzcyBib3VuZGFyaWVzIChlYWNoIFNESyBxdWVyeSgpIHNwYXducyBhIG5ldyBwcm9jZXNzKS5cbiAgICAgIHNldHRpbmdzUGF0aCA9IGdlbmVyYXRlVGVtcEZpbGVQYXRoKCdjbGF1ZGUtc2V0dGluZ3MnLCAnLmpzb24nLCB7XG4gICAgICAgIGNvbnRlbnRIYXNoOiB0cmltbWVkU2V0dGluZ3MsXG4gICAgICB9KVxuICAgICAgd3JpdGVGaWxlU3luY19ERVBSRUNBVEVEKHNldHRpbmdzUGF0aCwgdHJpbW1lZFNldHRpbmdzLCAndXRmOCcpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEl0J3MgYSBmaWxlIHBhdGggLSByZXNvbHZlIGFuZCB2YWxpZGF0ZSBieSBhdHRlbXB0aW5nIHRvIHJlYWRcbiAgICAgIGNvbnN0IHsgcmVzb2x2ZWRQYXRoOiByZXNvbHZlZFNldHRpbmdzUGF0aCB9ID0gc2FmZVJlc29sdmVQYXRoKFxuICAgICAgICBnZXRGc0ltcGxlbWVudGF0aW9uKCksXG4gICAgICAgIHNldHRpbmdzRmlsZSxcbiAgICAgIClcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlYWRGaWxlU3luYyhyZXNvbHZlZFNldHRpbmdzUGF0aCwgJ3V0ZjgnKVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoaXNFTk9FTlQoZSkpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgYEVycm9yOiBTZXR0aW5ncyBmaWxlIG5vdCBmb3VuZDogJHtyZXNvbHZlZFNldHRpbmdzUGF0aH1cXG5gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZVxuICAgICAgfVxuICAgICAgc2V0dGluZ3NQYXRoID0gcmVzb2x2ZWRTZXR0aW5nc1BhdGhcbiAgICB9XG5cbiAgICBzZXRGbGFnU2V0dGluZ3NQYXRoKHNldHRpbmdzUGF0aClcbiAgICByZXNldFNldHRpbmdzQ2FjaGUoKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICBsb2dFcnJvcihlcnJvcilcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBjaGFsay5yZWQoYEVycm9yIHByb2Nlc3Npbmcgc2V0dGluZ3M6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gKSxcbiAgICApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNldHRpbmdTb3VyY2VzRnJvbUZsYWcoc2V0dGluZ1NvdXJjZXNBcmc6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHNvdXJjZXMgPSBwYXJzZVNldHRpbmdTb3VyY2VzRmxhZyhzZXR0aW5nU291cmNlc0FyZylcbiAgICBzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMoc291cmNlcylcbiAgICByZXNldFNldHRpbmdzQ2FjaGUoKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICBsb2dFcnJvcihlcnJvcilcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBjaGFsay5yZWQoYEVycm9yIHByb2Nlc3NpbmcgLS1zZXR0aW5nLXNvdXJjZXM6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gKSxcbiAgICApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cblxuLyoqXG4gKiBQYXJzZSBhbmQgbG9hZCBzZXR0aW5ncyBmbGFncyBlYXJseSwgYmVmb3JlIGluaXQoKVxuICogVGhpcyBlbnN1cmVzIHNldHRpbmdzIGFyZSBmaWx0ZXJlZCBmcm9tIHRoZSBzdGFydCBvZiBpbml0aWFsaXphdGlvblxuICovXG5mdW5jdGlvbiBlYWdlckxvYWRTZXR0aW5ncygpOiB2b2lkIHtcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ2VhZ2VyTG9hZFNldHRpbmdzX3N0YXJ0JylcbiAgLy8gUGFyc2UgLS1zZXR0aW5ncyBmbGFnIGVhcmx5IHRvIGVuc3VyZSBzZXR0aW5ncyBhcmUgbG9hZGVkIGJlZm9yZSBpbml0KClcbiAgY29uc3Qgc2V0dGluZ3NGaWxlID0gZWFnZXJQYXJzZUNsaUZsYWcoJy0tc2V0dGluZ3MnKVxuICBpZiAoc2V0dGluZ3NGaWxlKSB7XG4gICAgbG9hZFNldHRpbmdzRnJvbUZsYWcoc2V0dGluZ3NGaWxlKVxuICB9XG5cbiAgLy8gUGFyc2UgLS1zZXR0aW5nLXNvdXJjZXMgZmxhZyBlYXJseSB0byBjb250cm9sIHdoaWNoIHNvdXJjZXMgYXJlIGxvYWRlZFxuICBjb25zdCBzZXR0aW5nU291cmNlc0FyZyA9IGVhZ2VyUGFyc2VDbGlGbGFnKCctLXNldHRpbmctc291cmNlcycpXG4gIGlmIChzZXR0aW5nU291cmNlc0FyZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbG9hZFNldHRpbmdTb3VyY2VzRnJvbUZsYWcoc2V0dGluZ1NvdXJjZXNBcmcpXG4gIH1cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ2VhZ2VyTG9hZFNldHRpbmdzX2VuZCcpXG59XG5cbmZ1bmN0aW9uIGluaXRpYWxpemVFbnRyeXBvaW50KGlzTm9uSW50ZXJhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgLy8gU2tpcCBpZiBhbHJlYWR5IHNldCAoZS5nLiwgYnkgU0RLIG9yIG90aGVyIGVudHJ5cG9pbnRzKVxuICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCkge1xuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3QgY2xpQXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKVxuXG4gIC8vIENoZWNrIGZvciBNQ1Agc2VydmUgY29tbWFuZCAoaGFuZGxlIGZsYWdzIGJlZm9yZSBtY3Agc2VydmUsIGUuZy4sIC0tZGVidWcgbWNwIHNlcnZlKVxuICBjb25zdCBtY3BJbmRleCA9IGNsaUFyZ3MuaW5kZXhPZignbWNwJylcbiAgaWYgKG1jcEluZGV4ICE9PSAtMSAmJiBjbGlBcmdzW21jcEluZGV4ICsgMV0gPT09ICdzZXJ2ZScpIHtcbiAgICBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID0gJ21jcCdcbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmIChpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9BQ1RJT04pKSB7XG4gICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCA9ICdjbGF1ZGUtY29kZS1naXRodWItYWN0aW9uJ1xuICAgIHJldHVyblxuICB9XG5cbiAgLy8gTm90ZTogJ2xvY2FsLWFnZW50JyBlbnRyeXBvaW50IGlzIHNldCBieSB0aGUgbG9jYWwgYWdlbnQgbW9kZSBsYXVuY2hlclxuICAvLyB2aWEgQ0xBVURFX0NPREVfRU5UUllQT0lOVCBlbnYgdmFyIChoYW5kbGVkIGJ5IGVhcmx5IHJldHVybiBhYm92ZSlcblxuICAvLyBTZXQgYmFzZWQgb24gaW50ZXJhY3RpdmUgc3RhdHVzXG4gIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPSBpc05vbkludGVyYWN0aXZlID8gJ3Nkay1jbGknIDogJ2NsaSdcbn1cblxuLy8gU2V0IGJ5IGVhcmx5IGFyZ3YgcHJvY2Vzc2luZyB3aGVuIGBjbGF1ZGUgb3BlbiA8dXJsPmAgaXMgZGV0ZWN0ZWQgKGludGVyYWN0aXZlIG1vZGUgb25seSlcbnR5cGUgUGVuZGluZ0Nvbm5lY3QgPSB7XG4gIHVybDogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGF1dGhUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOiBib29sZWFuXG59XG5jb25zdCBfcGVuZGluZ0Nvbm5lY3Q6IFBlbmRpbmdDb25uZWN0IHwgdW5kZWZpbmVkID0gZmVhdHVyZSgnRElSRUNUX0NPTk5FQ1QnKVxuICA/IHsgdXJsOiB1bmRlZmluZWQsIGF1dGhUb2tlbjogdW5kZWZpbmVkLCBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczogZmFsc2UgfVxuICA6IHVuZGVmaW5lZFxuXG4vLyBTZXQgYnkgZWFybHkgYXJndiBwcm9jZXNzaW5nIHdoZW4gYGNsYXVkZSBhc3Npc3RhbnQgW3Nlc3Npb25JZF1gIGlzIGRldGVjdGVkXG50eXBlIFBlbmRpbmdBc3Npc3RhbnRDaGF0ID0geyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGRpc2NvdmVyOiBib29sZWFuIH1cbmNvbnN0IF9wZW5kaW5nQXNzaXN0YW50Q2hhdDogUGVuZGluZ0Fzc2lzdGFudENoYXQgfCB1bmRlZmluZWQgPSBmZWF0dXJlKFxuICAnS0FJUk9TJyxcbilcbiAgPyB7IHNlc3Npb25JZDogdW5kZWZpbmVkLCBkaXNjb3ZlcjogZmFsc2UgfVxuICA6IHVuZGVmaW5lZFxuXG4vLyBgY2xhdWRlIHNzaCA8aG9zdD4gW2Rpcl1gIOKAlCBwYXJzZWQgZnJvbSBhcmd2IGVhcmx5IChzYW1lIHBhdHRlcm4gYXNcbi8vIERJUkVDVF9DT05ORUNUIGFib3ZlKSBzbyB0aGUgbWFpbiBjb21tYW5kIHBhdGggY2FuIHBpY2sgaXQgdXAgYW5kIGhhbmRcbi8vIHRoZSBSRVBMIGFuIFNTSC1iYWNrZWQgc2Vzc2lvbiBpbnN0ZWFkIG9mIGEgbG9jYWwgb25lLlxudHlwZSBQZW5kaW5nU1NIID0ge1xuICBob3N0OiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgY3dkOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgcGVybWlzc2lvbk1vZGU6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczogYm9vbGVhblxuICAvKiogLS1sb2NhbDogc3Bhd24gdGhlIGNoaWxkIENMSSBkaXJlY3RseSwgc2tpcCBzc2gvcHJvYmUvZGVwbG95LiBlMmUgdGVzdCBtb2RlLiAqL1xuICBsb2NhbDogYm9vbGVhblxuICAvKiogRXh0cmEgQ0xJIGFyZ3MgdG8gZm9yd2FyZCB0byB0aGUgcmVtb3RlIENMSSBvbiBpbml0aWFsIHNwYXduICgtLXJlc3VtZSwgLWMpLiAqL1xuICBleHRyYUNsaUFyZ3M6IHN0cmluZ1tdXG59XG5jb25zdCBfcGVuZGluZ1NTSDogUGVuZGluZ1NTSCB8IHVuZGVmaW5lZCA9IGZlYXR1cmUoJ1NTSF9SRU1PVEUnKVxuICA/IHtcbiAgICAgIGhvc3Q6IHVuZGVmaW5lZCxcbiAgICAgIGN3ZDogdW5kZWZpbmVkLFxuICAgICAgcGVybWlzc2lvbk1vZGU6IHVuZGVmaW5lZCxcbiAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOiBmYWxzZSxcbiAgICAgIGxvY2FsOiBmYWxzZSxcbiAgICAgIGV4dHJhQ2xpQXJnczogW10sXG4gICAgfVxuICA6IHVuZGVmaW5lZFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fZnVuY3Rpb25fc3RhcnQnKVxuXG4gIC8vIFNFQ1VSSVRZOiBQcmV2ZW50IFdpbmRvd3MgZnJvbSBleGVjdXRpbmcgY29tbWFuZHMgZnJvbSBjdXJyZW50IGRpcmVjdG9yeVxuICAvLyBUaGlzIG11c3QgYmUgc2V0IGJlZm9yZSBBTlkgY29tbWFuZCBleGVjdXRpb24gdG8gcHJldmVudCBQQVRIIGhpamFja2luZyBhdHRhY2tzXG4gIC8vIFNlZTogaHR0cHM6Ly9kb2NzLm1pY3Jvc29mdC5jb20vZW4tdXMvd2luZG93cy93aW4zMi9hcGkvcHJvY2Vzc2Vudi9uZi1wcm9jZXNzZW52LXNlYXJjaHBhdGh3XG4gIHByb2Nlc3MuZW52Lk5vRGVmYXVsdEN1cnJlbnREaXJlY3RvcnlJbkV4ZVBhdGggPSAnMSdcblxuICAvLyBJbml0aWFsaXplIHdhcm5pbmcgaGFuZGxlciBlYXJseSB0byBjYXRjaCB3YXJuaW5nc1xuICBpbml0aWFsaXplV2FybmluZ0hhbmRsZXIoKVxuXG4gIHByb2Nlc3Mub24oJ2V4aXQnLCAoKSA9PiB7XG4gICAgcmVzZXRDdXJzb3IoKVxuICB9KVxuICBwcm9jZXNzLm9uKCdTSUdJTlQnLCAoKSA9PiB7XG4gICAgLy8gSW4gcHJpbnQgbW9kZSwgcHJpbnQudHMgcmVnaXN0ZXJzIGl0cyBvd24gU0lHSU5UIGhhbmRsZXIgdGhhdCBhYm9ydHNcbiAgICAvLyB0aGUgaW4tZmxpZ2h0IHF1ZXJ5IGFuZCBjYWxscyBncmFjZWZ1bFNodXRkb3duOyBza2lwIGhlcmUgdG8gYXZvaWRcbiAgICAvLyBwcmVlbXB0aW5nIGl0IHdpdGggYSBzeW5jaHJvbm91cyBwcm9jZXNzLmV4aXQoKS5cbiAgICBpZiAocHJvY2Vzcy5hcmd2LmluY2x1ZGVzKCctcCcpIHx8IHByb2Nlc3MuYXJndi5pbmNsdWRlcygnLS1wcmludCcpKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgcHJvY2Vzcy5leGl0KDApXG4gIH0pXG4gIHByb2ZpbGVDaGVja3BvaW50KCdtYWluX3dhcm5pbmdfaGFuZGxlcl9pbml0aWFsaXplZCcpXG5cbiAgLy8gQ2hlY2sgZm9yIGNjOi8vIG9yIGNjK3VuaXg6Ly8gVVJMIGluIGFyZ3Yg4oCUIHJld3JpdGUgc28gdGhlIG1haW4gY29tbWFuZFxuICAvLyBoYW5kbGVzIGl0LCBnaXZpbmcgdGhlIGZ1bGwgaW50ZXJhY3RpdmUgVFVJIGluc3RlYWQgb2YgYSBzdHJpcHBlZC1kb3duIHN1YmNvbW1hbmQuXG4gIC8vIEZvciBoZWFkbGVzcyAoLXApLCB3ZSByZXdyaXRlIHRvIHRoZSBpbnRlcm5hbCBgb3BlbmAgc3ViY29tbWFuZC5cbiAgaWYgKGZlYXR1cmUoJ0RJUkVDVF9DT05ORUNUJykpIHtcbiAgICBjb25zdCByYXdDbGlBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgY29uc3QgY2NJZHggPSByYXdDbGlBcmdzLmZpbmRJbmRleChcbiAgICAgIGEgPT4gYS5zdGFydHNXaXRoKCdjYzovLycpIHx8IGEuc3RhcnRzV2l0aCgnY2MrdW5peDovLycpLFxuICAgIClcbiAgICBpZiAoY2NJZHggIT09IC0xICYmIF9wZW5kaW5nQ29ubmVjdCkge1xuICAgICAgY29uc3QgY2NVcmwgPSByYXdDbGlBcmdzW2NjSWR4XSFcbiAgICAgIGNvbnN0IHsgcGFyc2VDb25uZWN0VXJsIH0gPSBhd2FpdCBpbXBvcnQoJy4vc2VydmVyL3BhcnNlQ29ubmVjdFVybC5qcycpXG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUNvbm5lY3RVcmwoY2NVcmwpXG4gICAgICBfcGVuZGluZ0Nvbm5lY3QuZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgPSByYXdDbGlBcmdzLmluY2x1ZGVzKFxuICAgICAgICAnLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zJyxcbiAgICAgIClcblxuICAgICAgaWYgKHJhd0NsaUFyZ3MuaW5jbHVkZXMoJy1wJykgfHwgcmF3Q2xpQXJncy5pbmNsdWRlcygnLS1wcmludCcpKSB7XG4gICAgICAgIC8vIEhlYWRsZXNzOiByZXdyaXRlIHRvIGludGVybmFsIGBvcGVuYCBzdWJjb21tYW5kXG4gICAgICAgIGNvbnN0IHN0cmlwcGVkID0gcmF3Q2xpQXJncy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGNjSWR4KVxuICAgICAgICBjb25zdCBkc3BJZHggPSBzdHJpcHBlZC5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgICBpZiAoZHNwSWR4ICE9PSAtMSkge1xuICAgICAgICAgIHN0cmlwcGVkLnNwbGljZShkc3BJZHgsIDEpXG4gICAgICAgIH1cbiAgICAgICAgcHJvY2Vzcy5hcmd2ID0gW1xuICAgICAgICAgIHByb2Nlc3MuYXJndlswXSEsXG4gICAgICAgICAgcHJvY2Vzcy5hcmd2WzFdISxcbiAgICAgICAgICAnb3BlbicsXG4gICAgICAgICAgY2NVcmwsXG4gICAgICAgICAgLi4uc3RyaXBwZWQsXG4gICAgICAgIF1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEludGVyYWN0aXZlOiBzdHJpcCBjYzovLyBVUkwgYW5kIGZsYWdzLCBydW4gbWFpbiBjb21tYW5kXG4gICAgICAgIF9wZW5kaW5nQ29ubmVjdC51cmwgPSBwYXJzZWQuc2VydmVyVXJsXG4gICAgICAgIF9wZW5kaW5nQ29ubmVjdC5hdXRoVG9rZW4gPSBwYXJzZWQuYXV0aFRva2VuXG4gICAgICAgIGNvbnN0IHN0cmlwcGVkID0gcmF3Q2xpQXJncy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGNjSWR4KVxuICAgICAgICBjb25zdCBkc3BJZHggPSBzdHJpcHBlZC5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgICBpZiAoZHNwSWR4ICE9PSAtMSkge1xuICAgICAgICAgIHN0cmlwcGVkLnNwbGljZShkc3BJZHgsIDEpXG4gICAgICAgIH1cbiAgICAgICAgcHJvY2Vzcy5hcmd2ID0gW3Byb2Nlc3MuYXJndlswXSEsIHByb2Nlc3MuYXJndlsxXSEsIC4uLnN0cmlwcGVkXVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEhhbmRsZSBkZWVwIGxpbmsgVVJJcyBlYXJseSDigJQgdGhpcyBpcyBpbnZva2VkIGJ5IHRoZSBPUyBwcm90b2NvbCBoYW5kbGVyXG4gIC8vIGFuZCBzaG91bGQgYmFpbCBvdXQgYmVmb3JlIGZ1bGwgaW5pdCBzaW5jZSBpdCBvbmx5IG5lZWRzIHRvIHBhcnNlIHRoZSBVUklcbiAgLy8gYW5kIG9wZW4gYSB0ZXJtaW5hbC5cbiAgaWYgKGZlYXR1cmUoJ0xPREVTVE9ORScpKSB7XG4gICAgY29uc3QgaGFuZGxlVXJpSWR4ID0gcHJvY2Vzcy5hcmd2LmluZGV4T2YoJy0taGFuZGxlLXVyaScpXG4gICAgaWYgKGhhbmRsZVVyaUlkeCAhPT0gLTEgJiYgcHJvY2Vzcy5hcmd2W2hhbmRsZVVyaUlkeCArIDFdKSB7XG4gICAgICBjb25zdCB7IGVuYWJsZUNvbmZpZ3MgfSA9IGF3YWl0IGltcG9ydCgnLi91dGlscy9jb25maWcuanMnKVxuICAgICAgZW5hYmxlQ29uZmlncygpXG4gICAgICBjb25zdCB1cmkgPSBwcm9jZXNzLmFyZ3ZbaGFuZGxlVXJpSWR4ICsgMV0hXG4gICAgICBjb25zdCB7IGhhbmRsZURlZXBMaW5rVXJpIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICcuL3V0aWxzL2RlZXBMaW5rL3Byb3RvY29sSGFuZGxlci5qcydcbiAgICAgIClcbiAgICAgIGNvbnN0IGV4aXRDb2RlID0gYXdhaXQgaGFuZGxlRGVlcExpbmtVcmkodXJpKVxuICAgICAgcHJvY2Vzcy5leGl0KGV4aXRDb2RlKVxuICAgIH1cblxuICAgIC8vIG1hY09TIFVSTCBoYW5kbGVyOiB3aGVuIExhdW5jaFNlcnZpY2VzIGxhdW5jaGVzIG91ciAuYXBwIGJ1bmRsZSwgdGhlXG4gICAgLy8gVVJMIGFycml2ZXMgdmlhIEFwcGxlIEV2ZW50IChub3QgYXJndikuIExhdW5jaFNlcnZpY2VzIG92ZXJ3cml0ZXNcbiAgICAvLyBfX0NGQnVuZGxlSWRlbnRpZmllciB0byB0aGUgbGF1bmNoaW5nIGJ1bmRsZSdzIElELCB3aGljaCBpcyBhIHByZWNpc2VcbiAgICAvLyBwb3NpdGl2ZSBzaWduYWwg4oCUIGNoZWFwZXIgdGhhbiBpbXBvcnRpbmcgYW5kIGd1ZXNzaW5nIHdpdGggaGV1cmlzdGljcy5cbiAgICBpZiAoXG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSAnZGFyd2luJyAmJlxuICAgICAgcHJvY2Vzcy5lbnYuX19DRkJ1bmRsZUlkZW50aWZpZXIgPT09XG4gICAgICAgICdjb20uYW50aHJvcGljLmNsYXVkZS1jb2RlLXVybC1oYW5kbGVyJ1xuICAgICkge1xuICAgICAgY29uc3QgeyBlbmFibGVDb25maWdzIH0gPSBhd2FpdCBpbXBvcnQoJy4vdXRpbHMvY29uZmlnLmpzJylcbiAgICAgIGVuYWJsZUNvbmZpZ3MoKVxuICAgICAgY29uc3QgeyBoYW5kbGVVcmxTY2hlbWVMYXVuY2ggfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vdXRpbHMvZGVlcExpbmsvcHJvdG9jb2xIYW5kbGVyLmpzJ1xuICAgICAgKVxuICAgICAgY29uc3QgdXJsU2NoZW1lUmVzdWx0ID0gYXdhaXQgaGFuZGxlVXJsU2NoZW1lTGF1bmNoKClcbiAgICAgIHByb2Nlc3MuZXhpdCh1cmxTY2hlbWVSZXN1bHQgPz8gMSlcbiAgICB9XG4gIH1cblxuICAvLyBgY2xhdWRlIGFzc2lzdGFudCBbc2Vzc2lvbklkXWAg4oCUIHN0YXNoIGFuZCBzdHJpcCBzbyB0aGUgbWFpblxuICAvLyBjb21tYW5kIGhhbmRsZXMgaXQsIGdpdmluZyB0aGUgZnVsbCBpbnRlcmFjdGl2ZSBUVUkuIFBvc2l0aW9uLTAgb25seVxuICAvLyAobWF0Y2hpbmcgdGhlIHNzaCBwYXR0ZXJuIGJlbG93KSDigJQgaW5kZXhPZiB3b3VsZCBmYWxzZS1wb3NpdGl2ZSBvblxuICAvLyBgY2xhdWRlIC1wIFwiZXhwbGFpbiBhc3Npc3RhbnRcImAuIFJvb3QtZmxhZy1iZWZvcmUtc3ViY29tbWFuZFxuICAvLyAoZS5nLiBgLS1kZWJ1ZyBhc3Npc3RhbnRgKSBmYWxscyB0aHJvdWdoIHRvIHRoZSBzdHViLCB3aGljaFxuICAvLyBwcmludHMgdXNhZ2UuXG4gIGlmIChmZWF0dXJlKCdLQUlST1MnKSAmJiBfcGVuZGluZ0Fzc2lzdGFudENoYXQpIHtcbiAgICBjb25zdCByYXdBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgaWYgKHJhd0FyZ3NbMF0gPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICBjb25zdCBuZXh0QXJnID0gcmF3QXJnc1sxXVxuICAgICAgaWYgKG5leHRBcmcgJiYgIW5leHRBcmcuc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgICAgIF9wZW5kaW5nQXNzaXN0YW50Q2hhdC5zZXNzaW9uSWQgPSBuZXh0QXJnXG4gICAgICAgIHJhd0FyZ3Muc3BsaWNlKDAsIDIpIC8vIGRyb3AgJ2Fzc2lzdGFudCcgYW5kIHNlc3Npb25JZFxuICAgICAgICBwcm9jZXNzLmFyZ3YgPSBbcHJvY2Vzcy5hcmd2WzBdISwgcHJvY2Vzcy5hcmd2WzFdISwgLi4ucmF3QXJnc11cbiAgICAgIH0gZWxzZSBpZiAoIW5leHRBcmcpIHtcbiAgICAgICAgX3BlbmRpbmdBc3Npc3RhbnRDaGF0LmRpc2NvdmVyID0gdHJ1ZVxuICAgICAgICByYXdBcmdzLnNwbGljZSgwLCAxKSAvLyBkcm9wICdhc3Npc3RhbnQnXG4gICAgICAgIHByb2Nlc3MuYXJndiA9IFtwcm9jZXNzLmFyZ3ZbMF0hLCBwcm9jZXNzLmFyZ3ZbMV0hLCAuLi5yYXdBcmdzXVxuICAgICAgfVxuICAgICAgLy8gZWxzZTogYGNsYXVkZSBhc3Npc3RhbnQgLS1oZWxwYCDihpIgZmFsbCB0aHJvdWdoIHRvIHN0dWJcbiAgICB9XG4gIH1cblxuICAvLyBgY2xhdWRlIHNzaCA8aG9zdD4gW2Rpcl1gIOKAlCBzdHJpcCBmcm9tIGFyZ3Ygc28gdGhlIG1haW4gY29tbWFuZCBoYW5kbGVyXG4gIC8vIHJ1bnMgKGZ1bGwgaW50ZXJhY3RpdmUgVFVJKSwgc3Rhc2ggdGhlIGhvc3QvZGlyIGZvciB0aGUgUkVQTCBicmFuY2ggYXRcbiAgLy8gfmxpbmUgMzcyMCB0byBwaWNrIHVwLiBIZWFkbGVzcyAoLXApIG1vZGUgbm90IHN1cHBvcnRlZCBpbiB2MTogU1NIXG4gIC8vIHNlc3Npb25zIG5lZWQgdGhlIGxvY2FsIFJFUEwgdG8gZHJpdmUgdGhlbSAoaW50ZXJydXB0LCBwZXJtaXNzaW9ucykuXG4gIGlmIChmZWF0dXJlKCdTU0hfUkVNT1RFJykgJiYgX3BlbmRpbmdTU0gpIHtcbiAgICBjb25zdCByYXdDbGlBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgLy8gU1NILXNwZWNpZmljIGZsYWdzIGNhbiBhcHBlYXIgYmVmb3JlIHRoZSBob3N0IHBvc2l0aW9uYWwgKGUuZy5cbiAgICAvLyBgc3NoIC0tcGVybWlzc2lvbi1tb2RlIGF1dG8gaG9zdCAvdG1wYCDigJQgc3RhbmRhcmQgUE9TSVggZmxhZ3MtYmVmb3JlLVxuICAgIC8vIHBvc2l0aW9uYWxzKS4gUHVsbCB0aGVtIGFsbCBvdXQgQkVGT1JFIGNoZWNraW5nIHdoZXRoZXIgYSBob3N0IHdhc1xuICAgIC8vIGdpdmVuLCBzbyBgY2xhdWRlIHNzaCAtLXBlcm1pc3Npb24tbW9kZSBhdXRvIGhvc3RgIGFuZCBgY2xhdWRlIHNzaCBob3N0XG4gICAgLy8gLS1wZXJtaXNzaW9uLW1vZGUgYXV0b2AgYXJlIGVxdWl2YWxlbnQuIFRoZSBob3N0IGNoZWNrIGJlbG93IG9ubHkgbmVlZHNcbiAgICAvLyB0byBndWFyZCBhZ2FpbnN0IGAtaGAvYC0taGVscGAgKHdoaWNoIGNvbW1hbmRlciBzaG91bGQgaGFuZGxlKS5cbiAgICBpZiAocmF3Q2xpQXJnc1swXSA9PT0gJ3NzaCcpIHtcbiAgICAgIGNvbnN0IGxvY2FsSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLWxvY2FsJylcbiAgICAgIGlmIChsb2NhbElkeCAhPT0gLTEpIHtcbiAgICAgICAgX3BlbmRpbmdTU0gubG9jYWwgPSB0cnVlXG4gICAgICAgIHJhd0NsaUFyZ3Muc3BsaWNlKGxvY2FsSWR4LCAxKVxuICAgICAgfVxuICAgICAgY29uc3QgZHNwSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgaWYgKGRzcElkeCAhPT0gLTEpIHtcbiAgICAgICAgX3BlbmRpbmdTU0guZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgPSB0cnVlXG4gICAgICAgIHJhd0NsaUFyZ3Muc3BsaWNlKGRzcElkeCwgMSlcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBtSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLXBlcm1pc3Npb24tbW9kZScpXG4gICAgICBpZiAoXG4gICAgICAgIHBtSWR4ICE9PSAtMSAmJlxuICAgICAgICByYXdDbGlBcmdzW3BtSWR4ICsgMV0gJiZcbiAgICAgICAgIXJhd0NsaUFyZ3NbcG1JZHggKyAxXSEuc3RhcnRzV2l0aCgnLScpXG4gICAgICApIHtcbiAgICAgICAgX3BlbmRpbmdTU0gucGVybWlzc2lvbk1vZGUgPSByYXdDbGlBcmdzW3BtSWR4ICsgMV1cbiAgICAgICAgcmF3Q2xpQXJncy5zcGxpY2UocG1JZHgsIDIpXG4gICAgICB9XG4gICAgICBjb25zdCBwbUVxSWR4ID0gcmF3Q2xpQXJncy5maW5kSW5kZXgoYSA9PlxuICAgICAgICBhLnN0YXJ0c1dpdGgoJy0tcGVybWlzc2lvbi1tb2RlPScpLFxuICAgICAgKVxuICAgICAgaWYgKHBtRXFJZHggIT09IC0xKSB7XG4gICAgICAgIF9wZW5kaW5nU1NILnBlcm1pc3Npb25Nb2RlID0gcmF3Q2xpQXJnc1twbUVxSWR4XSEuc3BsaXQoJz0nKVsxXVxuICAgICAgICByYXdDbGlBcmdzLnNwbGljZShwbUVxSWR4LCAxKVxuICAgICAgfVxuICAgICAgLy8gRm9yd2FyZCBzZXNzaW9uLXJlc3VtZSArIG1vZGVsIGZsYWdzIHRvIHRoZSByZW1vdGUgQ0xJJ3MgaW5pdGlhbCBzcGF3bi5cbiAgICAgIC8vIC0tY29udGludWUvLWMgYW5kIC0tcmVzdW1lIDx1dWlkPiBvcGVyYXRlIG9uIHRoZSBSRU1PVEUgc2Vzc2lvbiBoaXN0b3J5XG4gICAgICAvLyAod2hpY2ggcGVyc2lzdHMgdW5kZXIgdGhlIHJlbW90ZSdzIH4vLm9wZW5jbGF1ZGUvcHJvamVjdHMvPGN3ZD4vKS5cbiAgICAgIC8vIC0tbW9kZWwgY29udHJvbHMgd2hpY2ggbW9kZWwgdGhlIHJlbW90ZSB1c2VzLlxuICAgICAgY29uc3QgZXh0cmFjdEZsYWcgPSAoXG4gICAgICAgIGZsYWc6IHN0cmluZyxcbiAgICAgICAgb3B0czogeyBoYXNWYWx1ZT86IGJvb2xlYW47IGFzPzogc3RyaW5nIH0gPSB7fSxcbiAgICAgICkgPT4ge1xuICAgICAgICBjb25zdCBpID0gcmF3Q2xpQXJncy5pbmRleE9mKGZsYWcpXG4gICAgICAgIGlmIChpICE9PSAtMSkge1xuICAgICAgICAgIF9wZW5kaW5nU1NILmV4dHJhQ2xpQXJncy5wdXNoKG9wdHMuYXMgPz8gZmxhZylcbiAgICAgICAgICBjb25zdCB2YWwgPSByYXdDbGlBcmdzW2kgKyAxXVxuICAgICAgICAgIGlmIChvcHRzLmhhc1ZhbHVlICYmIHZhbCAmJiAhdmFsLnN0YXJ0c1dpdGgoJy0nKSkge1xuICAgICAgICAgICAgX3BlbmRpbmdTU0guZXh0cmFDbGlBcmdzLnB1c2godmFsKVxuICAgICAgICAgICAgcmF3Q2xpQXJncy5zcGxpY2UoaSwgMilcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmF3Q2xpQXJncy5zcGxpY2UoaSwgMSlcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZXFJID0gcmF3Q2xpQXJncy5maW5kSW5kZXgoYSA9PiBhLnN0YXJ0c1dpdGgoYCR7ZmxhZ309YCkpXG4gICAgICAgIGlmIChlcUkgIT09IC0xKSB7XG4gICAgICAgICAgX3BlbmRpbmdTU0guZXh0cmFDbGlBcmdzLnB1c2goXG4gICAgICAgICAgICBvcHRzLmFzID8/IGZsYWcsXG4gICAgICAgICAgICByYXdDbGlBcmdzW2VxSV0hLnNsaWNlKGZsYWcubGVuZ3RoICsgMSksXG4gICAgICAgICAgKVxuICAgICAgICAgIHJhd0NsaUFyZ3Muc3BsaWNlKGVxSSwgMSlcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgZXh0cmFjdEZsYWcoJy1jJywgeyBhczogJy0tY29udGludWUnIH0pXG4gICAgICBleHRyYWN0RmxhZygnLS1jb250aW51ZScpXG4gICAgICBleHRyYWN0RmxhZygnLS1yZXN1bWUnLCB7IGhhc1ZhbHVlOiB0cnVlIH0pXG4gICAgICBleHRyYWN0RmxhZygnLS1tb2RlbCcsIHsgaGFzVmFsdWU6IHRydWUgfSlcbiAgICB9XG4gICAgLy8gQWZ0ZXIgcHJlLWV4dHJhY3Rpb24sIGFueSByZW1haW5pbmcgZGFzaC1hcmcgYXQgWzFdIGlzIGVpdGhlciAtaC8tLWhlbHBcbiAgICAvLyAoY29tbWFuZGVyIGhhbmRsZXMpIG9yIGFuIHVua25vd24tdG8tc3NoIGZsYWcgKGZhbGwgdGhyb3VnaCB0byBjb21tYW5kZXJcbiAgICAvLyBzbyBpdCBzdXJmYWNlcyBhIHByb3BlciBlcnJvcikuIE9ubHkgYSBub24tZGFzaCBhcmcgaXMgdGhlIGhvc3QuXG4gICAgaWYgKFxuICAgICAgcmF3Q2xpQXJnc1swXSA9PT0gJ3NzaCcgJiZcbiAgICAgIHJhd0NsaUFyZ3NbMV0gJiZcbiAgICAgICFyYXdDbGlBcmdzWzFdLnN0YXJ0c1dpdGgoJy0nKVxuICAgICkge1xuICAgICAgX3BlbmRpbmdTU0guaG9zdCA9IHJhd0NsaUFyZ3NbMV1cbiAgICAgIC8vIE9wdGlvbmFsIHBvc2l0aW9uYWwgY3dkLlxuICAgICAgbGV0IGNvbnN1bWVkID0gMlxuICAgICAgaWYgKHJhd0NsaUFyZ3NbMl0gJiYgIXJhd0NsaUFyZ3NbMl0uc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgICAgIF9wZW5kaW5nU1NILmN3ZCA9IHJhd0NsaUFyZ3NbMl1cbiAgICAgICAgY29uc3VtZWQgPSAzXG4gICAgICB9XG4gICAgICBjb25zdCByZXN0ID0gcmF3Q2xpQXJncy5zbGljZShjb25zdW1lZClcblxuICAgICAgLy8gSGVhZGxlc3MgKC1wKSBtb2RlIGlzIG5vdCBzdXBwb3J0ZWQgd2l0aCBTU0ggaW4gdjEg4oCUIHJlamVjdCBlYXJseVxuICAgICAgLy8gc28gdGhlIGZsYWcgZG9lc24ndCBzaWxlbnRseSBjYXVzZSBsb2NhbCBleGVjdXRpb24uXG4gICAgICBpZiAocmVzdC5pbmNsdWRlcygnLXAnKSB8fCByZXN0LmluY2x1ZGVzKCctLXByaW50JykpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgJ0Vycm9yOiBoZWFkbGVzcyAoLXAvLS1wcmludCkgbW9kZSBpcyBub3Qgc3VwcG9ydGVkIHdpdGggY2xhdWRlIHNzaFxcbicsXG4gICAgICAgIClcbiAgICAgICAgZ3JhY2VmdWxTaHV0ZG93blN5bmMoMSlcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIC8vIFJld3JpdGUgYXJndiBzbyB0aGUgbWFpbiBjb21tYW5kIHNlZXMgcmVtYWluaW5nIGZsYWdzIGJ1dCBub3QgYHNzaGAuXG4gICAgICBwcm9jZXNzLmFyZ3YgPSBbcHJvY2Vzcy5hcmd2WzBdISwgcHJvY2Vzcy5hcmd2WzFdISwgLi4ucmVzdF1cbiAgICB9XG4gIH1cblxuICAvLyBDaGVjayBmb3IgLXAvLS1wcmludCBhbmQgLS1pbml0LW9ubHkgZmxhZ3MgZWFybHkgdG8gc2V0IGlzSW50ZXJhY3RpdmVTZXNzaW9uIGJlZm9yZSBpbml0KClcbiAgLy8gVGhpcyBpcyBuZWVkZWQgYmVjYXVzZSB0ZWxlbWV0cnkgaW5pdGlhbGl6YXRpb24gY2FsbHMgYXV0aCBmdW5jdGlvbnMgdGhhdCBuZWVkIHRoaXMgZmxhZ1xuICBjb25zdCBjbGlBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gIGNvbnN0IGhhc1ByaW50RmxhZyA9IGNsaUFyZ3MuaW5jbHVkZXMoJy1wJykgfHwgY2xpQXJncy5pbmNsdWRlcygnLS1wcmludCcpXG4gIGNvbnN0IGhhc0luaXRPbmx5RmxhZyA9IGNsaUFyZ3MuaW5jbHVkZXMoJy0taW5pdC1vbmx5JylcbiAgY29uc3QgaGFzU2RrVXJsID0gY2xpQXJncy5zb21lKGFyZyA9PiBhcmcuc3RhcnRzV2l0aCgnLS1zZGstdXJsJykpXG4gIGNvbnN0IGlzTm9uSW50ZXJhY3RpdmUgPVxuICAgIGhhc1ByaW50RmxhZyB8fCBoYXNJbml0T25seUZsYWcgfHwgaGFzU2RrVXJsIHx8ICFwcm9jZXNzLnN0ZG91dC5pc1RUWVxuXG4gIC8vIFN0b3AgY2FwdHVyaW5nIGVhcmx5IGlucHV0IGZvciBub24taW50ZXJhY3RpdmUgbW9kZXNcbiAgaWYgKGlzTm9uSW50ZXJhY3RpdmUpIHtcbiAgICBzdG9wQ2FwdHVyaW5nRWFybHlJbnB1dCgpXG4gIH1cblxuICAvLyBTZXQgc2ltcGxpZmllZCB0cmFja2luZyBmaWVsZHNcbiAgY29uc3QgaXNJbnRlcmFjdGl2ZSA9ICFpc05vbkludGVyYWN0aXZlXG4gIHNldElzSW50ZXJhY3RpdmUoaXNJbnRlcmFjdGl2ZSlcblxuICAvLyBJbml0aWFsaXplIGVudHJ5cG9pbnQgYmFzZWQgb24gbW9kZSAtIG5lZWRzIHRvIGJlIHNldCBiZWZvcmUgYW55IGV2ZW50IGlzIGxvZ2dlZFxuICBpbml0aWFsaXplRW50cnlwb2ludChpc05vbkludGVyYWN0aXZlKVxuXG4gIC8vIERldGVybWluZSBjbGllbnQgdHlwZVxuICBjb25zdCBjbGllbnRUeXBlID0gKCgpID0+IHtcbiAgICBpZiAoaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuR0lUSFVCX0FDVElPTlMpKSByZXR1cm4gJ2dpdGh1Yi1hY3Rpb24nXG4gICAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPT09ICdzZGstdHMnKSByZXR1cm4gJ3Nkay10eXBlc2NyaXB0J1xuICAgIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAnc2RrLXB5JykgcmV0dXJuICdzZGstcHl0aG9uJ1xuICAgIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAnc2RrLWNsaScpIHJldHVybiAnc2RrLWNsaSdcbiAgICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCA9PT0gJ2NsYXVkZS12c2NvZGUnKVxuICAgICAgcmV0dXJuICdjbGF1ZGUtdnNjb2RlJ1xuICAgIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAnbG9jYWwtYWdlbnQnKVxuICAgICAgcmV0dXJuICdsb2NhbC1hZ2VudCdcbiAgICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCA9PT0gJ2NsYXVkZS1kZXNrdG9wJylcbiAgICAgIHJldHVybiAnY2xhdWRlLWRlc2t0b3AnXG5cbiAgICAvLyBDaGVjayBpZiBzZXNzaW9uLWluZ3Jlc3MgdG9rZW4gaXMgcHJvdmlkZWQgKGluZGljYXRlcyByZW1vdGUgc2Vzc2lvbilcbiAgICBjb25zdCBoYXNTZXNzaW9uSW5ncmVzc1Rva2VuID1cbiAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1NFU1NJT05fQUNDRVNTX1RPS0VOIHx8XG4gICAgICBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9XRUJTT0NLRVRfQVVUSF9GSUxFX0RFU0NSSVBUT1JcbiAgICBpZiAoXG4gICAgICBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAncmVtb3RlJyB8fFxuICAgICAgaGFzU2Vzc2lvbkluZ3Jlc3NUb2tlblxuICAgICkge1xuICAgICAgcmV0dXJuICdyZW1vdGUnXG4gICAgfVxuXG4gICAgcmV0dXJuICdjbGknXG4gIH0pKClcbiAgc2V0Q2xpZW50VHlwZShjbGllbnRUeXBlKVxuXG4gIGNvbnN0IHByZXZpZXdGb3JtYXQgPSBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9RVUVTVElPTl9QUkVWSUVXX0ZPUk1BVFxuICBpZiAocHJldmlld0Zvcm1hdCA9PT0gJ21hcmtkb3duJyB8fCBwcmV2aWV3Rm9ybWF0ID09PSAnaHRtbCcpIHtcbiAgICBzZXRRdWVzdGlvblByZXZpZXdGb3JtYXQocHJldmlld0Zvcm1hdClcbiAgfSBlbHNlIGlmIChcbiAgICAhY2xpZW50VHlwZS5zdGFydHNXaXRoKCdzZGstJykgJiZcbiAgICAvLyBEZXNrdG9wIGFuZCBDQ1IgcGFzcyBwcmV2aWV3Rm9ybWF0IHZpYSB0b29sQ29uZmlnOyB3aGVuIHRoZSBmZWF0dXJlIGlzXG4gICAgLy8gZ2F0ZWQgb2ZmIHRoZXkgcGFzcyB1bmRlZmluZWQg4oCUIGRvbid0IG92ZXJyaWRlIHRoYXQgd2l0aCBtYXJrZG93bi5cbiAgICBjbGllbnRUeXBlICE9PSAnY2xhdWRlLWRlc2t0b3AnICYmXG4gICAgY2xpZW50VHlwZSAhPT0gJ2xvY2FsLWFnZW50JyAmJlxuICAgIGNsaWVudFR5cGUgIT09ICdyZW1vdGUnXG4gICkge1xuICAgIHNldFF1ZXN0aW9uUHJldmlld0Zvcm1hdCgnbWFya2Rvd24nKVxuICB9XG5cbiAgLy8gVGFnIHNlc3Npb25zIGNyZWF0ZWQgdmlhIGBjbGF1ZGUgcmVtb3RlLWNvbnRyb2xgIHNvIHRoZSBiYWNrZW5kIGNhbiBpZGVudGlmeSB0aGVtXG4gIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlZJUk9OTUVOVF9LSU5EID09PSAnYnJpZGdlJykge1xuICAgIHNldFNlc3Npb25Tb3VyY2UoJ3JlbW90ZS1jb250cm9sJylcbiAgfVxuXG4gIHByb2ZpbGVDaGVja3BvaW50KCdtYWluX2NsaWVudF90eXBlX2RldGVybWluZWQnKVxuXG4gIC8vIFBhcnNlIGFuZCBsb2FkIHNldHRpbmdzIGZsYWdzIGVhcmx5LCBiZWZvcmUgaW5pdCgpXG4gIGVhZ2VyTG9hZFNldHRpbmdzKClcblxuICBwcm9maWxlQ2hlY2twb2ludCgnbWFpbl9iZWZvcmVfcnVuJylcblxuICBhd2FpdCBydW4oKVxuICBwcm9maWxlQ2hlY2twb2ludCgnbWFpbl9hZnRlcl9ydW4nKVxufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRJbnB1dFByb21wdChcbiAgcHJvbXB0OiBzdHJpbmcsXG4gIGlucHV0Rm9ybWF0OiAndGV4dCcgfCAnc3RyZWFtLWpzb24nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBBc3luY0l0ZXJhYmxlPHN0cmluZz4+IHtcbiAgaWYgKFxuICAgICFwcm9jZXNzLnN0ZGluLmlzVFRZICYmXG4gICAgLy8gSW5wdXQgaGlqYWNraW5nIGJyZWFrcyBNQ1AuXG4gICAgIXByb2Nlc3MuYXJndi5pbmNsdWRlcygnbWNwJylcbiAgKSB7XG4gICAgaWYgKGlucHV0Rm9ybWF0ID09PSAnc3RyZWFtLWpzb24nKSB7XG4gICAgICByZXR1cm4gcHJvY2Vzcy5zdGRpblxuICAgIH1cbiAgICBwcm9jZXNzLnN0ZGluLnNldEVuY29kaW5nKCd1dGY4JylcbiAgICBsZXQgZGF0YSA9ICcnXG4gICAgY29uc3Qgb25EYXRhID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgIGRhdGEgKz0gY2h1bmtcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRpbi5vbignZGF0YScsIG9uRGF0YSlcbiAgICAvLyBJZiBubyBkYXRhIGFycml2ZXMgaW4gM3MsIHN0b3Agd2FpdGluZyBhbmQgd2Fybi4gU3RkaW4gaXMgbGlrZWx5IGFuXG4gICAgLy8gaW5oZXJpdGVkIHBpcGUgZnJvbSBhIHBhcmVudCB0aGF0IGlzbid0IHdyaXRpbmcgKHN1YnByb2Nlc3Mgc3Bhd25lZFxuICAgIC8vIHdpdGhvdXQgZXhwbGljaXQgc3RkaW4gaGFuZGxpbmcpLiAzcyBjb3ZlcnMgc2xvdyBwcm9kdWNlcnMgbGlrZSBjdXJsLFxuICAgIC8vIGpxIG9uIGxhcmdlIGZpbGVzLCBweXRob24gd2l0aCBpbXBvcnQgb3ZlcmhlYWQuIFRoZSB3YXJuaW5nIG1ha2VzXG4gICAgLy8gc2lsZW50IGRhdGEgbG9zcyB2aXNpYmxlIGZvciB0aGUgcmFyZSBwcm9kdWNlciB0aGF0J3Mgc2xvd2VyIHN0aWxsLlxuICAgIGNvbnN0IHRpbWVkT3V0ID0gYXdhaXQgcGVla0ZvclN0ZGluRGF0YShwcm9jZXNzLnN0ZGluLCAzMDAwKVxuICAgIHByb2Nlc3Muc3RkaW4ub2ZmKCdkYXRhJywgb25EYXRhKVxuICAgIGlmICh0aW1lZE91dCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICdXYXJuaW5nOiBubyBzdGRpbiBkYXRhIHJlY2VpdmVkIGluIDNzLCBwcm9jZWVkaW5nIHdpdGhvdXQgaXQuICcgK1xuICAgICAgICAgICdJZiBwaXBpbmcgZnJvbSBhIHNsb3cgY29tbWFuZCwgcmVkaXJlY3Qgc3RkaW4gZXhwbGljaXRseTogPCAvZGV2L251bGwgdG8gc2tpcCwgb3Igd2FpdCBsb25nZXIuXFxuJyxcbiAgICAgIClcbiAgICB9XG4gICAgcmV0dXJuIFtwcm9tcHQsIGRhdGFdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKVxuICB9XG4gIHJldHVybiBwcm9tcHRcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8Q29tbWFuZGVyQ29tbWFuZD4ge1xuICBwcm9maWxlQ2hlY2twb2ludCgncnVuX2Z1bmN0aW9uX3N0YXJ0JylcblxuICAvLyBDcmVhdGUgaGVscCBjb25maWcgdGhhdCBzb3J0cyBvcHRpb25zIGJ5IGxvbmcgb3B0aW9uIG5hbWUuXG4gIC8vIENvbW1hbmRlciBzdXBwb3J0cyBjb21wYXJlT3B0aW9ucyBhdCBydW50aW1lIGJ1dCBAY29tbWFuZGVyLWpzL2V4dHJhLXR5cGluZ3NcbiAgLy8gZG9lc24ndCBpbmNsdWRlIGl0IGluIHRoZSB0eXBlIGRlZmluaXRpb25zLCBzbyB3ZSB1c2UgT2JqZWN0LmFzc2lnbiB0byBhZGQgaXQuXG4gIGZ1bmN0aW9uIGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKToge1xuICAgIHNvcnRTdWJjb21tYW5kczogdHJ1ZVxuICAgIHNvcnRPcHRpb25zOiB0cnVlXG4gIH0ge1xuICAgIGNvbnN0IGdldE9wdGlvblNvcnRLZXkgPSAob3B0OiBPcHRpb24pOiBzdHJpbmcgPT5cbiAgICAgIG9wdC5sb25nPy5yZXBsYWNlKC9eLS0vLCAnJykgPz8gb3B0LnNob3J0Py5yZXBsYWNlKC9eLS8sICcnKSA/PyAnJ1xuICAgIHJldHVybiBPYmplY3QuYXNzaWduKFxuICAgICAgeyBzb3J0U3ViY29tbWFuZHM6IHRydWUsIHNvcnRPcHRpb25zOiB0cnVlIH0gYXMgY29uc3QsXG4gICAgICB7XG4gICAgICAgIGNvbXBhcmVPcHRpb25zOiAoYTogT3B0aW9uLCBiOiBPcHRpb24pID0+XG4gICAgICAgICAgZ2V0T3B0aW9uU29ydEtleShhKS5sb2NhbGVDb21wYXJlKGdldE9wdGlvblNvcnRLZXkoYikpLFxuICAgICAgfSxcbiAgICApXG4gIH1cbiAgY29uc3QgcHJvZ3JhbSA9IG5ldyBDb21tYW5kZXJDb21tYW5kKClcbiAgICAuY29uZmlndXJlSGVscChjcmVhdGVTb3J0ZWRIZWxwQ29uZmlnKCkpXG4gICAgLmVuYWJsZVBvc2l0aW9uYWxPcHRpb25zKClcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9jb21tYW5kZXJfaW5pdGlhbGl6ZWQnKVxuXG4gIC8vIFVzZSBwcmVBY3Rpb24gaG9vayB0byBydW4gaW5pdGlhbGl6YXRpb24gb25seSB3aGVuIGV4ZWN1dGluZyBhIGNvbW1hbmQsXG4gIC8vIG5vdCB3aGVuIGRpc3BsYXlpbmcgaGVscC4gVGhpcyBhdm9pZHMgdGhlIG5lZWQgZm9yIGVudiB2YXJpYWJsZSBzaWduYWxpbmcuXG4gIHByb2dyYW0uaG9vaygncHJlQWN0aW9uJywgYXN5bmMgdGhpc0NvbW1hbmQgPT4ge1xuICAgIHByb2ZpbGVDaGVja3BvaW50KCdwcmVBY3Rpb25fc3RhcnQnKVxuICAgIC8vIEF3YWl0IGFzeW5jIHN1YnByb2Nlc3MgbG9hZHMgc3RhcnRlZCBhdCBtb2R1bGUgZXZhbHVhdGlvbiAobGluZXMgMTItMjApLlxuICAgIC8vIE5lYXJseSBmcmVlIOKAlCBzdWJwcm9jZXNzZXMgY29tcGxldGUgZHVyaW5nIHRoZSB+MTM1bXMgb2YgaW1wb3J0cyBhYm92ZS5cbiAgICAvLyBNdXN0IHJlc29sdmUgYmVmb3JlIGluaXQoKSB3aGljaCB0cmlnZ2VycyB0aGUgZmlyc3Qgc2V0dGluZ3MgcmVhZFxuICAgIC8vIChhcHBseVNhZmVDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcyDihpIgZ2V0U2V0dGluZ3NGb3JTb3VyY2UoJ3BvbGljeVNldHRpbmdzJylcbiAgICAvLyDihpIgaXNSZW1vdGVNYW5hZ2VkU2V0dGluZ3NFbGlnaWJsZSDihpIgc3luYyBrZXljaGFpbiByZWFkcyBvdGhlcndpc2UgfjY1bXMpLlxuICAgIGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIGVuc3VyZU1kbVNldHRpbmdzTG9hZGVkKCksXG4gICAgICBlbnN1cmVLZXljaGFpblByZWZldGNoQ29tcGxldGVkKCksXG4gICAgXSlcbiAgICBwcm9maWxlQ2hlY2twb2ludCgncHJlQWN0aW9uX2FmdGVyX21kbScpXG4gICAgYXdhaXQgaW5pdCgpXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9hZnRlcl9pbml0JylcblxuICAgIC8vIHByb2Nlc3MudGl0bGUgb24gV2luZG93cyBzZXRzIHRoZSBjb25zb2xlIHRpdGxlIGRpcmVjdGx5OyBvbiBQT1NJWCxcbiAgICAvLyB0ZXJtaW5hbCBzaGVsbCBpbnRlZ3JhdGlvbiBtYXkgbWlycm9yIHRoZSBwcm9jZXNzIG5hbWUgdG8gdGhlIHRhYi5cbiAgICAvLyBBZnRlciBpbml0KCkgc28gc2V0dGluZ3MuanNvbiBlbnYgY2FuIGFsc28gZ2F0ZSB0aGlzIChnaC00NzY1KS5cbiAgICBpZiAoIWlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0RJU0FCTEVfVEVSTUlOQUxfVElUTEUpKSB7XG4gICAgICBwcm9jZXNzLnRpdGxlID0gJ2NsYXVkZSdcbiAgICB9XG5cbiAgICAvLyBBdHRhY2ggbG9nZ2luZyBzaW5rcyBzbyBzdWJjb21tYW5kIGhhbmRsZXJzIGNhbiB1c2UgbG9nRXZlbnQvbG9nRXJyb3IuXG4gICAgLy8gQmVmb3JlIFBSICMxMTEwNiBsb2dFdmVudCBkaXNwYXRjaGVkIGRpcmVjdGx5OyBhZnRlciwgZXZlbnRzIHF1ZXVlIHVudGlsXG4gICAgLy8gYSBzaW5rIGF0dGFjaGVzLiBzZXR1cCgpIGF0dGFjaGVzIHNpbmtzIGZvciB0aGUgZGVmYXVsdCBjb21tYW5kLCBidXRcbiAgICAvLyBzdWJjb21tYW5kcyAoZG9jdG9yLCBtY3AsIHBsdWdpbiwgYXV0aCkgbmV2ZXIgY2FsbCBzZXR1cCgpIGFuZCB3b3VsZFxuICAgIC8vIHNpbGVudGx5IGRyb3AgZXZlbnRzIG9uIHByb2Nlc3MuZXhpdCgpLiBCb3RoIGluaXRzIGFyZSBpZGVtcG90ZW50LlxuICAgIGNvbnN0IHsgaW5pdFNpbmtzIH0gPSBhd2FpdCBpbXBvcnQoJy4vdXRpbHMvc2lua3MuanMnKVxuICAgIGluaXRTaW5rcygpXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9hZnRlcl9zaW5rcycpXG5cbiAgICAvLyBnaC0zMzUwODogLS1wbHVnaW4tZGlyIGlzIGEgdG9wLWxldmVsIHByb2dyYW0gb3B0aW9uLiBUaGUgZGVmYXVsdFxuICAgIC8vIGFjdGlvbiByZWFkcyBpdCBmcm9tIGl0cyBvd24gb3B0aW9ucyBkZXN0cnVjdHVyZSwgYnV0IHN1YmNvbW1hbmRzXG4gICAgLy8gKHBsdWdpbiBsaXN0LCBwbHVnaW4gaW5zdGFsbCwgbWNwICopIGhhdmUgdGhlaXIgb3duIGFjdGlvbnMgYW5kXG4gICAgLy8gbmV2ZXIgc2VlIGl0LiBXaXJlIGl0IHVwIGhlcmUgc28gZ2V0SW5saW5lUGx1Z2lucygpIHdvcmtzIGV2ZXJ5d2hlcmUuXG4gICAgLy8gdGhpc0NvbW1hbmQub3B0cygpIGlzIHR5cGVkIHt9IGhlcmUgYmVjYXVzZSB0aGlzIGhvb2sgaXMgYXR0YWNoZWRcbiAgICAvLyBiZWZvcmUgLm9wdGlvbignLS1wbHVnaW4tZGlyJywgLi4uKSBpbiB0aGUgY2hhaW4g4oCUIGV4dHJhLXR5cGluZ3NcbiAgICAvLyBidWlsZHMgdGhlIHR5cGUgYXMgb3B0aW9ucyBhcmUgYWRkZWQuIE5hcnJvdyB3aXRoIGEgcnVudGltZSBndWFyZDtcbiAgICAvLyB0aGUgY29sbGVjdCBhY2N1bXVsYXRvciArIFtdIGRlZmF1bHQgZ3VhcmFudGVlIHN0cmluZ1tdIGluIHByYWN0aWNlLlxuICAgIGNvbnN0IHBsdWdpbkRpciA9IHRoaXNDb21tYW5kLmdldE9wdGlvblZhbHVlKCdwbHVnaW5EaXInKVxuICAgIGlmIChcbiAgICAgIEFycmF5LmlzQXJyYXkocGx1Z2luRGlyKSAmJlxuICAgICAgcGx1Z2luRGlyLmxlbmd0aCA+IDAgJiZcbiAgICAgIHBsdWdpbkRpci5ldmVyeShwID0+IHR5cGVvZiBwID09PSAnc3RyaW5nJylcbiAgICApIHtcbiAgICAgIHNldElubGluZVBsdWdpbnMocGx1Z2luRGlyKVxuICAgICAgY2xlYXJQbHVnaW5DYWNoZSgncHJlQWN0aW9uOiAtLXBsdWdpbi1kaXIgaW5saW5lIHBsdWdpbnMnKVxuICAgIH1cblxuICAgIHJ1bk1pZ3JhdGlvbnMoKVxuICAgIHByb2ZpbGVDaGVja3BvaW50KCdwcmVBY3Rpb25fYWZ0ZXJfbWlncmF0aW9ucycpXG5cbiAgICAvLyBMb2FkIHJlbW90ZSBtYW5hZ2VkIHNldHRpbmdzIGZvciBlbnRlcnByaXNlIGN1c3RvbWVycyAobm9uLWJsb2NraW5nKVxuICAgIC8vIEZhaWxzIG9wZW4gLSBpZiBmZXRjaCBmYWlscywgY29udGludWVzIHdpdGhvdXQgcmVtb3RlIHNldHRpbmdzXG4gICAgLy8gU2V0dGluZ3MgYXJlIGFwcGxpZWQgdmlhIGhvdC1yZWxvYWQgd2hlbiB0aGV5IGFycml2ZVxuICAgIC8vIE11c3QgaGFwcGVuIGFmdGVyIGluaXQoKSB0byBlbnN1cmUgY29uZmlnIHJlYWRpbmcgaXMgYWxsb3dlZFxuICAgIHZvaWQgbG9hZFJlbW90ZU1hbmFnZWRTZXR0aW5ncygpXG4gICAgdm9pZCBsb2FkUG9saWN5TGltaXRzKClcblxuICAgIHByb2ZpbGVDaGVja3BvaW50KCdwcmVBY3Rpb25fYWZ0ZXJfcmVtb3RlX3NldHRpbmdzJylcblxuICAgIC8vIExvYWQgc2V0dGluZ3Mgc3luYyAobm9uLWJsb2NraW5nLCBmYWlsLW9wZW4pXG4gICAgLy8gQ0xJOiB1cGxvYWRzIGxvY2FsIHNldHRpbmdzIHRvIHJlbW90ZSAoQ0NSIGRvd25sb2FkIGlzIGhhbmRsZWQgYnkgcHJpbnQudHMpXG4gICAgaWYgKGZlYXR1cmUoJ1VQTE9BRF9VU0VSX1NFVFRJTkdTJykpIHtcbiAgICAgIHZvaWQgaW1wb3J0KCcuL3NlcnZpY2VzL3NldHRpbmdzU3luYy9pbmRleC5qcycpLnRoZW4obSA9PlxuICAgICAgICBtLnVwbG9hZFVzZXJTZXR0aW5nc0luQmFja2dyb3VuZCgpLFxuICAgICAgKVxuICAgIH1cblxuICAgIHByb2ZpbGVDaGVja3BvaW50KCdwcmVBY3Rpb25fYWZ0ZXJfc2V0dGluZ3Nfc3luYycpXG4gIH0pXG5cbiAgcHJvZ3JhbVxuICAgIC5uYW1lKCdjbGF1ZGUnKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgIGBDbGF1ZGUgQ29kZSAtIHN0YXJ0cyBhbiBpbnRlcmFjdGl2ZSBzZXNzaW9uIGJ5IGRlZmF1bHQsIHVzZSAtcC8tLXByaW50IGZvciBub24taW50ZXJhY3RpdmUgb3V0cHV0YCxcbiAgICApXG4gICAgLmFyZ3VtZW50KCdbcHJvbXB0XScsICdZb3VyIHByb21wdCcsIFN0cmluZylcbiAgICAvLyBTdWJjb21tYW5kcyBpbmhlcml0IGhlbHBPcHRpb24gdmlhIGNvbW1hbmRlcidzIGNvcHlJbmhlcml0ZWRTZXR0aW5ncyDigJRcbiAgICAvLyBzZXR0aW5nIGl0IG9uY2UgaGVyZSBjb3ZlcnMgbWNwLCBwbHVnaW4sIGF1dGgsIGFuZCBhbGwgb3RoZXIgc3ViY29tbWFuZHMuXG4gICAgLmhlbHBPcHRpb24oJy1oLCAtLWhlbHAnLCAnRGlzcGxheSBoZWxwIGZvciBjb21tYW5kJylcbiAgICAub3B0aW9uKFxuICAgICAgJy1kLCAtLWRlYnVnIFtmaWx0ZXJdJyxcbiAgICAgICdFbmFibGUgZGVidWcgbW9kZSB3aXRoIG9wdGlvbmFsIGNhdGVnb3J5IGZpbHRlcmluZyAoZS5nLiwgXCJhcGksaG9va3NcIiBvciBcIiExcCwhZmlsZVwiKScsXG4gICAgICAoX3ZhbHVlOiBzdHJpbmcgfCB0cnVlKSA9PiB7XG4gICAgICAgIC8vIElmIHZhbHVlIGlzIHByb3ZpZGVkLCBpdCB3aWxsIGJlIHRoZSBmaWx0ZXIgc3RyaW5nXG4gICAgICAgIC8vIElmIG5vdCBwcm92aWRlZCBidXQgZmxhZyBpcyBwcmVzZW50LCB2YWx1ZSB3aWxsIGJlIHRydWVcbiAgICAgICAgLy8gVGhlIGFjdHVhbCBmaWx0ZXJpbmcgaXMgaGFuZGxlZCBpbiBkZWJ1Zy50cyBieSBwYXJzaW5nIHByb2Nlc3MuYXJndlxuICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgfSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oJy1kMmUsIC0tZGVidWctdG8tc3RkZXJyJywgJ0VuYWJsZSBkZWJ1ZyBtb2RlICh0byBzdGRlcnIpJylcbiAgICAgICAgLmFyZ1BhcnNlcihCb29sZWFuKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWRlYnVnLWZpbGUgPHBhdGg+JyxcbiAgICAgICdXcml0ZSBkZWJ1ZyBsb2dzIHRvIGEgc3BlY2lmaWMgZmlsZSBwYXRoIChpbXBsaWNpdGx5IGVuYWJsZXMgZGVidWcgbW9kZSknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLXZlcmJvc2UnLFxuICAgICAgJ092ZXJyaWRlIHZlcmJvc2UgbW9kZSBzZXR0aW5nIGZyb20gY29uZmlnJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXAsIC0tcHJpbnQnLFxuICAgICAgJ1ByaW50IHJlc3BvbnNlIGFuZCBleGl0ICh1c2VmdWwgZm9yIHBpcGVzKS4gTm90ZTogVGhlIHdvcmtzcGFjZSB0cnVzdCBkaWFsb2cgaXMgc2tpcHBlZCB3aGVuIENsYXVkZSBpcyBydW4gd2l0aCB0aGUgLXAgbW9kZS4gT25seSB1c2UgdGhpcyBmbGFnIGluIGRpcmVjdG9yaWVzIHlvdSB0cnVzdC4nLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWJhcmUnLFxuICAgICAgJ01pbmltYWwgbW9kZTogc2tpcCBob29rcywgTFNQLCBwbHVnaW4gc3luYywgYXR0cmlidXRpb24sIGF1dG8tbWVtb3J5LCBiYWNrZ3JvdW5kIHByZWZldGNoZXMsIGtleWNoYWluIHJlYWRzLCBhbmQgQ0xBVURFLm1kIGF1dG8tZGlzY292ZXJ5LiBTZXRzIENMQVVERV9DT0RFX1NJTVBMRT0xLiBBbnRocm9waWMgYXV0aCBpcyBzdHJpY3RseSBBTlRIUk9QSUNfQVBJX0tFWSBvciBhcGlLZXlIZWxwZXIgdmlhIC0tc2V0dGluZ3MgKE9BdXRoIGFuZCBrZXljaGFpbiBhcmUgbmV2ZXIgcmVhZCkuIDNQIHByb3ZpZGVycyAoQmVkcm9jay9WZXJ0ZXgvRm91bmRyeSkgdXNlIHRoZWlyIG93biBjcmVkZW50aWFscy4gU2tpbGxzIHN0aWxsIHJlc29sdmUgdmlhIC9za2lsbC1uYW1lLiBFeHBsaWNpdGx5IHByb3ZpZGUgY29udGV4dCB2aWE6IC0tc3lzdGVtLXByb21wdFstZmlsZV0sIC0tYXBwZW5kLXN5c3RlbS1wcm9tcHRbLWZpbGVdLCAtLWFkZC1kaXIgKENMQVVERS5tZCBkaXJzKSwgLS1tY3AtY29uZmlnLCAtLXNldHRpbmdzLCAtLWFnZW50cywgLS1wbHVnaW4tZGlyLicsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0taW5pdCcsXG4gICAgICAgICdSdW4gU2V0dXAgaG9va3Mgd2l0aCBpbml0IHRyaWdnZXIsIHRoZW4gY29udGludWUnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0taW5pdC1vbmx5JyxcbiAgICAgICAgJ1J1biBTZXR1cCBhbmQgU2Vzc2lvblN0YXJ0OnN0YXJ0dXAgaG9va3MsIHRoZW4gZXhpdCcsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1tYWludGVuYW5jZScsXG4gICAgICAgICdSdW4gU2V0dXAgaG9va3Mgd2l0aCBtYWludGVuYW5jZSB0cmlnZ2VyLCB0aGVuIGNvbnRpbnVlJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLW91dHB1dC1mb3JtYXQgPGZvcm1hdD4nLFxuICAgICAgICAnT3V0cHV0IGZvcm1hdCAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpOiBcInRleHRcIiAoZGVmYXVsdCksIFwianNvblwiIChzaW5nbGUgcmVzdWx0KSwgb3IgXCJzdHJlYW0tanNvblwiIChyZWFsdGltZSBzdHJlYW1pbmcpJyxcbiAgICAgICkuY2hvaWNlcyhbJ3RleHQnLCAnanNvbicsICdzdHJlYW0tanNvbiddKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWpzb24tc2NoZW1hIDxzY2hlbWE+JyxcbiAgICAgICAgJ0pTT04gU2NoZW1hIGZvciBzdHJ1Y3R1cmVkIG91dHB1dCB2YWxpZGF0aW9uLiAnICtcbiAgICAgICAgICAnRXhhbXBsZToge1widHlwZVwiOlwib2JqZWN0XCIsXCJwcm9wZXJ0aWVzXCI6e1wibmFtZVwiOntcInR5cGVcIjpcInN0cmluZ1wifX0sXCJyZXF1aXJlZFwiOltcIm5hbWVcIl19JyxcbiAgICAgICkuYXJnUGFyc2VyKFN0cmluZyksXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1pbmNsdWRlLWhvb2stZXZlbnRzJyxcbiAgICAgICdJbmNsdWRlIGFsbCBob29rIGxpZmVjeWNsZSBldmVudHMgaW4gdGhlIG91dHB1dCBzdHJlYW0gKG9ubHkgd29ya3Mgd2l0aCAtLW91dHB1dC1mb3JtYXQ9c3RyZWFtLWpzb24pJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1pbmNsdWRlLXBhcnRpYWwtbWVzc2FnZXMnLFxuICAgICAgJ0luY2x1ZGUgcGFydGlhbCBtZXNzYWdlIGNodW5rcyBhcyB0aGV5IGFycml2ZSAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQgYW5kIC0tb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbiknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWlucHV0LWZvcm1hdCA8Zm9ybWF0PicsXG4gICAgICAgICdJbnB1dCBmb3JtYXQgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KTogXCJ0ZXh0XCIgKGRlZmF1bHQpLCBvciBcInN0cmVhbS1qc29uXCIgKHJlYWx0aW1lIHN0cmVhbWluZyBpbnB1dCknLFxuICAgICAgKS5jaG9pY2VzKFsndGV4dCcsICdzdHJlYW0tanNvbiddKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLW1jcC1kZWJ1ZycsXG4gICAgICAnW0RFUFJFQ0FURUQuIFVzZSAtLWRlYnVnIGluc3RlYWRdIEVuYWJsZSBNQ1AgZGVidWcgbW9kZSAoc2hvd3MgTUNQIHNlcnZlciBlcnJvcnMpJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zJyxcbiAgICAgICdCeXBhc3MgYWxsIHBlcm1pc3Npb24gY2hlY2tzLiBSZWNvbW1lbmRlZCBvbmx5IGZvciBzYW5kYm94ZXMgd2l0aCBubyBpbnRlcm5ldCBhY2Nlc3MuJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1hbGxvdy1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zJyxcbiAgICAgICdFbmFibGUgYnlwYXNzaW5nIGFsbCBwZXJtaXNzaW9uIGNoZWNrcyBhcyBhbiBvcHRpb24sIHdpdGhvdXQgaXQgYmVpbmcgZW5hYmxlZCBieSBkZWZhdWx0LiBSZWNvbW1lbmRlZCBvbmx5IGZvciBzYW5kYm94ZXMgd2l0aCBubyBpbnRlcm5ldCBhY2Nlc3MuJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS10aGlua2luZyA8bW9kZT4nLFxuICAgICAgICAnVGhpbmtpbmcgbW9kZTogZW5hYmxlZCAoZXF1aXZhbGVudCB0byBhZGFwdGl2ZSksIGRpc2FibGVkJyxcbiAgICAgIClcbiAgICAgICAgLmNob2ljZXMoWydlbmFibGVkJywgJ2FkYXB0aXZlJywgJ2Rpc2FibGVkJ10pXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tbWF4LXRoaW5raW5nLXRva2VucyA8dG9rZW5zPicsXG4gICAgICAgICdbREVQUkVDQVRFRC4gVXNlIC0tdGhpbmtpbmcgaW5zdGVhZCBmb3IgbmV3ZXIgbW9kZWxzXSBNYXhpbXVtIG51bWJlciBvZiB0aGlua2luZyB0b2tlbnMgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoTnVtYmVyKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLW1heC10dXJucyA8dHVybnM+JyxcbiAgICAgICAgJ01heGltdW0gbnVtYmVyIG9mIGFnZW50aWMgdHVybnMgaW4gbm9uLWludGVyYWN0aXZlIG1vZGUuIFRoaXMgd2lsbCBlYXJseSBleGl0IHRoZSBjb252ZXJzYXRpb24gYWZ0ZXIgdGhlIHNwZWNpZmllZCBudW1iZXIgb2YgdHVybnMuIChvbmx5IHdvcmtzIHdpdGggLS1wcmludCknLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKE51bWJlcilcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1tYXgtYnVkZ2V0LXVzZCA8YW1vdW50PicsXG4gICAgICAgICdNYXhpbXVtIGRvbGxhciBhbW91bnQgdG8gc3BlbmQgb24gQVBJIGNhbGxzIChvbmx5IHdvcmtzIHdpdGggLS1wcmludCknLFxuICAgICAgKS5hcmdQYXJzZXIodmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBhbW91bnQgPSBOdW1iZXIodmFsdWUpXG4gICAgICAgIGlmIChpc05hTihhbW91bnQpIHx8IGFtb3VudCA8PSAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJy0tbWF4LWJ1ZGdldC11c2QgbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlciBncmVhdGVyIHRoYW4gMCcsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBhbW91bnRcbiAgICAgIH0pLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tdGFzay1idWRnZXQgPHRva2Vucz4nLFxuICAgICAgICAnQVBJLXNpZGUgdGFzayBidWRnZXQgaW4gdG9rZW5zIChvdXRwdXRfY29uZmlnLnRhc2tfYnVkZ2V0KScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIodmFsdWUgPT4ge1xuICAgICAgICAgIGNvbnN0IHRva2VucyA9IE51bWJlcih2YWx1ZSlcbiAgICAgICAgICBpZiAoaXNOYU4odG9rZW5zKSB8fCB0b2tlbnMgPD0gMCB8fCAhTnVtYmVyLmlzSW50ZWdlcih0b2tlbnMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJy0tdGFzay1idWRnZXQgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXInKVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdG9rZW5zXG4gICAgICAgIH0pXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tcmVwbGF5LXVzZXItbWVzc2FnZXMnLFxuICAgICAgJ1JlLWVtaXQgdXNlciBtZXNzYWdlcyBmcm9tIHN0ZGluIGJhY2sgb24gc3Rkb3V0IGZvciBhY2tub3dsZWRnbWVudCAob25seSB3b3JrcyB3aXRoIC0taW5wdXQtZm9ybWF0PXN0cmVhbS1qc29uIGFuZCAtLW91dHB1dC1mb3JtYXQ9c3RyZWFtLWpzb24pJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1lbmFibGUtYXV0aC1zdGF0dXMnLFxuICAgICAgICAnRW5hYmxlIGF1dGggc3RhdHVzIG1lc3NhZ2VzIGluIFNESyBtb2RlJyxcbiAgICAgIClcbiAgICAgICAgLmRlZmF1bHQoZmFsc2UpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYWxsb3dlZFRvb2xzLCAtLWFsbG93ZWQtdG9vbHMgPHRvb2xzLi4uPicsXG4gICAgICAnQ29tbWEgb3Igc3BhY2Utc2VwYXJhdGVkIGxpc3Qgb2YgdG9vbCBuYW1lcyB0byBhbGxvdyAoZS5nLiBcIkJhc2goZ2l0OiopIEVkaXRcIiknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tdG9vbHMgPHRvb2xzLi4uPicsXG4gICAgICAnU3BlY2lmeSB0aGUgbGlzdCBvZiBhdmFpbGFibGUgdG9vbHMgZnJvbSB0aGUgYnVpbHQtaW4gc2V0LiBVc2UgXCJcIiB0byBkaXNhYmxlIGFsbCB0b29scywgXCJkZWZhdWx0XCIgdG8gdXNlIGFsbCB0b29scywgb3Igc3BlY2lmeSB0b29sIG5hbWVzIChlLmcuIFwiQmFzaCxFZGl0LFJlYWRcIikuJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWRpc2FsbG93ZWRUb29scywgLS1kaXNhbGxvd2VkLXRvb2xzIDx0b29scy4uLj4nLFxuICAgICAgJ0NvbW1hIG9yIHNwYWNlLXNlcGFyYXRlZCBsaXN0IG9mIHRvb2wgbmFtZXMgdG8gZGVueSAoZS5nLiBcIkJhc2goZ2l0OiopIEVkaXRcIiknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tbWNwLWNvbmZpZyA8Y29uZmlncy4uLj4nLFxuICAgICAgJ0xvYWQgTUNQIHNlcnZlcnMgZnJvbSBKU09OIGZpbGVzIG9yIHN0cmluZ3MgKHNwYWNlLXNlcGFyYXRlZCknLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tcGVybWlzc2lvbi1wcm9tcHQtdG9vbCA8dG9vbD4nLFxuICAgICAgICAnTUNQIHRvb2wgdG8gdXNlIGZvciBwZXJtaXNzaW9uIHByb21wdHMgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXN5c3RlbS1wcm9tcHQgPHByb21wdD4nLFxuICAgICAgICAnU3lzdGVtIHByb21wdCB0byB1c2UgZm9yIHRoZSBzZXNzaW9uJyxcbiAgICAgICkuYXJnUGFyc2VyKFN0cmluZyksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1zeXN0ZW0tcHJvbXB0LWZpbGUgPGZpbGU+JyxcbiAgICAgICAgJ1JlYWQgc3lzdGVtIHByb21wdCBmcm9tIGEgZmlsZScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWFwcGVuZC1zeXN0ZW0tcHJvbXB0IDxwcm9tcHQ+JyxcbiAgICAgICAgJ0FwcGVuZCBhIHN5c3RlbSBwcm9tcHQgdG8gdGhlIGRlZmF1bHQgc3lzdGVtIHByb21wdCcsXG4gICAgICApLmFyZ1BhcnNlcihTdHJpbmcpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tYXBwZW5kLXN5c3RlbS1wcm9tcHQtZmlsZSA8ZmlsZT4nLFxuICAgICAgICAnUmVhZCBzeXN0ZW0gcHJvbXB0IGZyb20gYSBmaWxlIGFuZCBhcHBlbmQgdG8gdGhlIGRlZmF1bHQgc3lzdGVtIHByb21wdCcsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXBlcm1pc3Npb24tbW9kZSA8bW9kZT4nLFxuICAgICAgICAnUGVybWlzc2lvbiBtb2RlIHRvIHVzZSBmb3IgdGhlIHNlc3Npb24nLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKFN0cmluZylcbiAgICAgICAgLmNob2ljZXMoUEVSTUlTU0lPTl9NT0RFUyksXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLWMsIC0tY29udGludWUnLFxuICAgICAgJ0NvbnRpbnVlIHRoZSBtb3N0IHJlY2VudCBjb252ZXJzYXRpb24gaW4gdGhlIGN1cnJlbnQgZGlyZWN0b3J5JyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXIsIC0tcmVzdW1lIFt2YWx1ZV0nLFxuICAgICAgJ1Jlc3VtZSBhIGNvbnZlcnNhdGlvbiBieSBzZXNzaW9uIElELCBvciBvcGVuIGludGVyYWN0aXZlIHBpY2tlciB3aXRoIG9wdGlvbmFsIHNlYXJjaCB0ZXJtJyxcbiAgICAgIHZhbHVlID0+IHZhbHVlIHx8IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1mb3JrLXNlc3Npb24nLFxuICAgICAgJ1doZW4gcmVzdW1pbmcsIGNyZWF0ZSBhIG5ldyBzZXNzaW9uIElEIGluc3RlYWQgb2YgcmV1c2luZyB0aGUgb3JpZ2luYWwgKHVzZSB3aXRoIC0tcmVzdW1lIG9yIC0tY29udGludWUpJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1wcmVmaWxsIDx0ZXh0PicsXG4gICAgICAgICdQcmUtZmlsbCB0aGUgcHJvbXB0IGlucHV0IHdpdGggdGV4dCB3aXRob3V0IHN1Ym1pdHRpbmcgaXQnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tZGVlcC1saW5rLW9yaWdpbicsXG4gICAgICAgICdTaWduYWwgdGhhdCB0aGlzIHNlc3Npb24gd2FzIGxhdW5jaGVkIGZyb20gYSBkZWVwIGxpbmsnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tZGVlcC1saW5rLXJlcG8gPHNsdWc+JyxcbiAgICAgICAgJ1JlcG8gc2x1ZyB0aGUgZGVlcCBsaW5rID9yZXBvPSBwYXJhbWV0ZXIgcmVzb2x2ZWQgdG8gdGhlIGN1cnJlbnQgY3dkJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWRlZXAtbGluay1sYXN0LWZldGNoIDxtcz4nLFxuICAgICAgICAnRkVUQ0hfSEVBRCBtdGltZSBpbiBlcG9jaCBtcywgcHJlY29tcHV0ZWQgYnkgdGhlIGRlZXAgbGluayB0cmFtcG9saW5lJyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcih2ID0+IHtcbiAgICAgICAgICBjb25zdCBuID0gTnVtYmVyKHYpXG4gICAgICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IG4gOiB1bmRlZmluZWRcbiAgICAgICAgfSlcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1mcm9tLXByIFt2YWx1ZV0nLFxuICAgICAgJ1Jlc3VtZSBhIHNlc3Npb24gbGlua2VkIHRvIGEgUFIgYnkgUFIgbnVtYmVyL1VSTCwgb3Igb3BlbiBpbnRlcmFjdGl2ZSBwaWNrZXIgd2l0aCBvcHRpb25hbCBzZWFyY2ggdGVybScsXG4gICAgICB2YWx1ZSA9PiB2YWx1ZSB8fCB0cnVlLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tbm8tc2Vzc2lvbi1wZXJzaXN0ZW5jZScsXG4gICAgICAnRGlzYWJsZSBzZXNzaW9uIHBlcnNpc3RlbmNlIC0gc2Vzc2lvbnMgd2lsbCBub3QgYmUgc2F2ZWQgdG8gZGlzayBhbmQgY2Fubm90IGJlIHJlc3VtZWQgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1yZXN1bWUtc2Vzc2lvbi1hdCA8bWVzc2FnZSBpZD4nLFxuICAgICAgICAnV2hlbiByZXN1bWluZywgb25seSBtZXNzYWdlcyB1cCB0byBhbmQgaW5jbHVkaW5nIHRoZSBhc3Npc3RhbnQgbWVzc2FnZSB3aXRoIDxtZXNzYWdlLmlkPiAodXNlIHdpdGggLS1yZXN1bWUgaW4gcHJpbnQgbW9kZSknLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKFN0cmluZylcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1yZXdpbmQtZmlsZXMgPHVzZXItbWVzc2FnZS1pZD4nLFxuICAgICAgICAnUmVzdG9yZSBmaWxlcyB0byBzdGF0ZSBhdCB0aGUgc3BlY2lmaWVkIHVzZXIgbWVzc2FnZSBhbmQgZXhpdCAocmVxdWlyZXMgLS1yZXN1bWUpJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLy8gQFtNT0RFTCBMQVVOQ0hdOiBVcGRhdGUgdGhlIGV4YW1wbGUgbW9kZWwgSUQgaW4gdGhlIC0tbW9kZWwgaGVscCB0ZXh0LlxuICAgIC5vcHRpb24oXG4gICAgICAnLS1tb2RlbCA8bW9kZWw+JyxcbiAgICAgIGBNb2RlbCBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbi4gUHJvdmlkZSBhbiBhbGlhcyBmb3IgdGhlIGxhdGVzdCBtb2RlbCAoZS5nLiAnc29ubmV0JyBvciAnb3B1cycpIG9yIGEgbW9kZWwncyBmdWxsIG5hbWUgKGUuZy4gJ2NsYXVkZS1zb25uZXQtNC02JykuYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWVmZm9ydCA8bGV2ZWw+JyxcbiAgICAgICAgYEVmZm9ydCBsZXZlbCBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbiAobG93LCBtZWRpdW0sIGhpZ2gsIG1heClgLFxuICAgICAgKS5hcmdQYXJzZXIoKHJhd1ZhbHVlOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSByYXdWYWx1ZS50b0xvd2VyQ2FzZSgpXG4gICAgICAgIGNvbnN0IGFsbG93ZWQgPSBbJ2xvdycsICdtZWRpdW0nLCAnaGlnaCcsICdtYXgnXVxuICAgICAgICBpZiAoIWFsbG93ZWQuaW5jbHVkZXModmFsdWUpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgICAgYEl0IG11c3QgYmUgb25lIG9mOiAke2FsbG93ZWQuam9pbignLCAnKX1gLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWVcbiAgICAgIH0pLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYWdlbnQgPGFnZW50PicsXG4gICAgICBgQWdlbnQgZm9yIHRoZSBjdXJyZW50IHNlc3Npb24uIE92ZXJyaWRlcyB0aGUgJ2FnZW50JyBzZXR0aW5nLmAsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1iZXRhcyA8YmV0YXMuLi4+JyxcbiAgICAgICdCZXRhIGhlYWRlcnMgdG8gaW5jbHVkZSBpbiBBUEkgcmVxdWVzdHMgKEFQSSBrZXkgdXNlcnMgb25seSknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tZmFsbGJhY2stbW9kZWwgPG1vZGVsPicsXG4gICAgICAnRW5hYmxlIGF1dG9tYXRpYyBmYWxsYmFjayB0byBzcGVjaWZpZWQgbW9kZWwgd2hlbiBkZWZhdWx0IG1vZGVsIGlzIG92ZXJsb2FkZWQgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS13b3JrbG9hZCA8dGFnPicsXG4gICAgICAgICdXb3JrbG9hZCB0YWcgZm9yIGJpbGxpbmctaGVhZGVyIGF0dHJpYnV0aW9uIChjY193b3JrbG9hZCkuIFByb2Nlc3Mtc2NvcGVkOyBzZXQgYnkgU0RLIGRhZW1vbiBjYWxsZXJzIHRoYXQgc3Bhd24gc3VicHJvY2Vzc2VzIGZvciBjcm9uIHdvcmsuIChvbmx5IHdvcmtzIHdpdGggLS1wcmludCknLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tc2V0dGluZ3MgPGZpbGUtb3ItanNvbj4nLFxuICAgICAgJ1BhdGggdG8gYSBzZXR0aW5ncyBKU09OIGZpbGUgb3IgYSBKU09OIHN0cmluZyB0byBsb2FkIGFkZGl0aW9uYWwgc2V0dGluZ3MgZnJvbScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1hZGQtZGlyIDxkaXJlY3Rvcmllcy4uLj4nLFxuICAgICAgJ0FkZGl0aW9uYWwgZGlyZWN0b3JpZXMgdG8gYWxsb3cgdG9vbCBhY2Nlc3MgdG8nLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0taWRlJyxcbiAgICAgICdBdXRvbWF0aWNhbGx5IGNvbm5lY3QgdG8gSURFIG9uIHN0YXJ0dXAgaWYgZXhhY3RseSBvbmUgdmFsaWQgSURFIGlzIGF2YWlsYWJsZScsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tc3RyaWN0LW1jcC1jb25maWcnLFxuICAgICAgJ09ubHkgdXNlIE1DUCBzZXJ2ZXJzIGZyb20gLS1tY3AtY29uZmlnLCBpZ25vcmluZyBhbGwgb3RoZXIgTUNQIGNvbmZpZ3VyYXRpb25zJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1zZXNzaW9uLWlkIDx1dWlkPicsXG4gICAgICAnVXNlIGEgc3BlY2lmaWMgc2Vzc2lvbiBJRCBmb3IgdGhlIGNvbnZlcnNhdGlvbiAobXVzdCBiZSBhIHZhbGlkIFVVSUQpJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctbiwgLS1uYW1lIDxuYW1lPicsXG4gICAgICAnU2V0IGEgZGlzcGxheSBuYW1lIGZvciB0aGlzIHNlc3Npb24gKHNob3duIGluIC9yZXN1bWUgYW5kIHRlcm1pbmFsIHRpdGxlKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1hZ2VudHMgPGpzb24+JyxcbiAgICAgICdKU09OIG9iamVjdCBkZWZpbmluZyBjdXN0b20gYWdlbnRzIChlLmcuIFxcJ3tcInJldmlld2VyXCI6IHtcImRlc2NyaXB0aW9uXCI6IFwiUmV2aWV3cyBjb2RlXCIsIFwicHJvbXB0XCI6IFwiWW91IGFyZSBhIGNvZGUgcmV2aWV3ZXJcIn19XFwnKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1zZXR0aW5nLXNvdXJjZXMgPHNvdXJjZXM+JyxcbiAgICAgICdDb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBzZXR0aW5nIHNvdXJjZXMgdG8gbG9hZCAodXNlciwgcHJvamVjdCwgbG9jYWwpLicsXG4gICAgKVxuICAgIC8vIGdoLTMzNTA4OiA8cGF0aHMuLi4+ICh2YXJpYWRpYykgY29uc3VtZWQgZXZlcnl0aGluZyB1bnRpbCB0aGUgbmV4dFxuICAgIC8vIC0tZmxhZy4gYGNsYXVkZSAtLXBsdWdpbi1kaXIgL3BhdGggbWNwIGFkZCAtLXRyYW5zcG9ydCBodHRwYCBzd2FsbG93ZWRcbiAgICAvLyBgbWNwYCBhbmQgYGFkZGAgYXMgcGF0aHMsIHRoZW4gY2hva2VkIG9uIC0tdHJhbnNwb3J0IGFzIGFuIHVua25vd25cbiAgICAvLyB0b3AtbGV2ZWwgb3B0aW9uLiBTaW5nbGUtdmFsdWUgKyBjb2xsZWN0IGFjY3VtdWxhdG9yIG1lYW5zIGVhY2hcbiAgICAvLyAtLXBsdWdpbi1kaXIgdGFrZXMgZXhhY3RseSBvbmUgYXJnOyByZXBlYXQgdGhlIGZsYWcgZm9yIG11bHRpcGxlIGRpcnMuXG4gICAgLm9wdGlvbihcbiAgICAgICctLXBsdWdpbi1kaXIgPHBhdGg+JyxcbiAgICAgICdMb2FkIHBsdWdpbnMgZnJvbSBhIGRpcmVjdG9yeSBmb3IgdGhpcyBzZXNzaW9uIG9ubHkgKHJlcGVhdGFibGU6IC0tcGx1Z2luLWRpciBBIC0tcGx1Z2luLWRpciBCKScsXG4gICAgICAodmFsOiBzdHJpbmcsIHByZXY6IHN0cmluZ1tdKSA9PiBbLi4ucHJldiwgdmFsXSxcbiAgICAgIFtdIGFzIHN0cmluZ1tdLFxuICAgIClcbiAgICAub3B0aW9uKCctLWRpc2FibGUtc2xhc2gtY29tbWFuZHMnLCAnRGlzYWJsZSBhbGwgc2tpbGxzJywgKCkgPT4gdHJ1ZSlcbiAgICAub3B0aW9uKCctLWNocm9tZScsICdFbmFibGUgQ2xhdWRlIGluIENocm9tZSBpbnRlZ3JhdGlvbicpXG4gICAgLm9wdGlvbignLS1uby1jaHJvbWUnLCAnRGlzYWJsZSBDbGF1ZGUgaW4gQ2hyb21lIGludGVncmF0aW9uJylcbiAgICAub3B0aW9uKFxuICAgICAgJy0tZmlsZSA8c3BlY3MuLi4+JyxcbiAgICAgICdGaWxlIHJlc291cmNlcyB0byBkb3dubG9hZCBhdCBzdGFydHVwLiBGb3JtYXQ6IGZpbGVfaWQ6cmVsYXRpdmVfcGF0aCAoZS5nLiwgLS1maWxlIGZpbGVfYWJjOmRvYy50eHQgZmlsZV9kZWY6aW1nLnBuZyknLFxuICAgIClcbiAgICAuYWN0aW9uKGFzeW5jIChwcm9tcHQsIG9wdGlvbnMpID0+IHtcbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25faGFuZGxlcl9zdGFydCcpXG5cbiAgICAgIC8vIC0tYmFyZSA9IG9uZS1zd2l0Y2ggbWluaW1hbCBtb2RlLiBTZXRzIFNJTVBMRSBzbyBhbGwgdGhlIGV4aXN0aW5nXG4gICAgICAvLyBnYXRlcyBmaXJlIChDTEFVREUubWQsIHNraWxscywgaG9va3MgaW5zaWRlIGV4ZWN1dGVIb29rcywgYWdlbnRcbiAgICAgIC8vIGRpci13YWxrKS4gTXVzdCBiZSBzZXQgYmVmb3JlIHNldHVwKCkgLyBhbnkgb2YgdGhlIGdhdGVkIHdvcmsgcnVucy5cbiAgICAgIGlmICgob3B0aW9ucyBhcyB7IGJhcmU/OiBib29sZWFuIH0pLmJhcmUpIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfU0lNUExFID0gJzEnXG4gICAgICB9XG5cbiAgICAgIC8vIElnbm9yZSBcImNvZGVcIiBhcyBhIHByb21wdCAtIHRyZWF0IGl0IHRoZSBzYW1lIGFzIG5vIHByb21wdFxuICAgICAgaWYgKHByb21wdCA9PT0gJ2NvZGUnKSB7XG4gICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9jb2RlX3Byb21wdF9pZ25vcmVkJywge30pXG4gICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGNoYWxrLnllbGxvdygnVGlwOiBZb3UgY2FuIGxhdW5jaCBDbGF1ZGUgQ29kZSB3aXRoIGp1c3QgYGNsYXVkZWAnKSxcbiAgICAgICAgKVxuICAgICAgICBwcm9tcHQgPSB1bmRlZmluZWRcbiAgICAgIH1cblxuICAgICAgLy8gTG9nIGV2ZW50IGZvciBhbnkgc2luZ2xlLXdvcmQgcHJvbXB0XG4gICAgICBpZiAoXG4gICAgICAgIHByb21wdCAmJlxuICAgICAgICB0eXBlb2YgcHJvbXB0ID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAhL1xccy8udGVzdChwcm9tcHQpICYmXG4gICAgICAgIHByb21wdC5sZW5ndGggPiAwXG4gICAgICApIHtcbiAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3NpbmdsZV93b3JkX3Byb21wdCcsIHsgbGVuZ3RoOiBwcm9tcHQubGVuZ3RoIH0pXG4gICAgICB9XG5cbiAgICAgIC8vIEFzc2lzdGFudCBtb2RlOiB3aGVuIC5jbGF1ZGUvc2V0dGluZ3MuanNvbiBoYXMgYXNzaXN0YW50OiB0cnVlIEFORFxuICAgICAgLy8gdGhlIHRlbmd1X2thaXJvcyBHcm93dGhCb29rIGdhdGUgaXMgb24sIGZvcmNlIGJyaWVmIG9uLiBQZXJtaXNzaW9uXG4gICAgICAvLyBtb2RlIGlzIGxlZnQgdG8gdGhlIHVzZXIg4oCUIHNldHRpbmdzIGRlZmF1bHRNb2RlIG9yIC0tcGVybWlzc2lvbi1tb2RlXG4gICAgICAvLyBhcHBseSBhcyBub3JtYWwuIFJFUEwtdHlwZWQgbWVzc2FnZXMgYWxyZWFkeSBkZWZhdWx0IHRvICduZXh0J1xuICAgICAgLy8gcHJpb3JpdHkgKG1lc3NhZ2VRdWV1ZU1hbmFnZXIuZW5xdWV1ZSkgc28gdGhleSBkcmFpbiBtaWQtdHVybiBiZXR3ZWVuXG4gICAgICAvLyB0b29sIGNhbGxzLiBTZW5kVXNlck1lc3NhZ2UgKEJyaWVmVG9vbCkgaXMgZW5hYmxlZCB2aWEgdGhlIGJyaWVmIGVudlxuICAgICAgLy8gdmFyLiBTbGVlcFRvb2wgc3RheXMgZGlzYWJsZWQgKGl0cyBpc0VuYWJsZWQoKSBnYXRlcyBvbiBwcm9hY3RpdmUpLlxuICAgICAgLy8ga2Fpcm9zRW5hYmxlZCBpcyBjb21wdXRlZCBvbmNlIGhlcmUgYW5kIHJldXNlZCBhdCB0aGVcbiAgICAgIC8vIGdldEFzc2lzdGFudFN5c3RlbVByb21wdEFkZGVuZHVtKCkgY2FsbCBzaXRlIGZ1cnRoZXIgZG93bi5cbiAgICAgIC8vXG4gICAgICAvLyBUcnVzdCBnYXRlOiAuY2xhdWRlL3NldHRpbmdzLmpzb24gaXMgYXR0YWNrZXItY29udHJvbGxhYmxlIGluIGFuXG4gICAgICAvLyB1bnRydXN0ZWQgY2xvbmUuIFdlIHJ1biB+MTAwMCBsaW5lcyBiZWZvcmUgc2hvd1NldHVwU2NyZWVucygpIHNob3dzXG4gICAgICAvLyB0aGUgdHJ1c3QgZGlhbG9nLCBhbmQgYnkgdGhlbiB3ZSd2ZSBhbHJlYWR5IGFwcGVuZGVkXG4gICAgICAvLyAuY2xhdWRlL2FnZW50cy9hc3Npc3RhbnQubWQgdG8gdGhlIHN5c3RlbSBwcm9tcHQuIFJlZnVzZSB0byBhY3RpdmF0ZVxuICAgICAgLy8gdW50aWwgdGhlIGRpcmVjdG9yeSBoYXMgYmVlbiBleHBsaWNpdGx5IHRydXN0ZWQuXG4gICAgICBsZXQga2Fpcm9zRW5hYmxlZCA9IGZhbHNlXG4gICAgICBsZXQgYXNzaXN0YW50VGVhbUNvbnRleHQ6XG4gICAgICAgIHwgQXdhaXRlZDxcbiAgICAgICAgICAgIFJldHVyblR5cGU8XG4gICAgICAgICAgICAgIE5vbk51bGxhYmxlPHR5cGVvZiBhc3Npc3RhbnRNb2R1bGU+Wydpbml0aWFsaXplQXNzaXN0YW50VGVhbSddXG4gICAgICAgICAgICA+XG4gICAgICAgICAgPlxuICAgICAgICB8IHVuZGVmaW5lZFxuICAgICAgaWYgKFxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSAmJlxuICAgICAgICAob3B0aW9ucyBhcyB7IGFzc2lzdGFudD86IGJvb2xlYW4gfSkuYXNzaXN0YW50ICYmXG4gICAgICAgIGFzc2lzdGFudE1vZHVsZVxuICAgICAgKSB7XG4gICAgICAgIC8vIC0tYXNzaXN0YW50IChBZ2VudCBTREsgZGFlbW9uIG1vZGUpOiBmb3JjZSB0aGUgbGF0Y2ggYmVmb3JlXG4gICAgICAgIC8vIGlzQXNzaXN0YW50TW9kZSgpIHJ1bnMgYmVsb3cuIFRoZSBkYWVtb24gaGFzIGFscmVhZHkgY2hlY2tlZFxuICAgICAgICAvLyBlbnRpdGxlbWVudCDigJQgZG9uJ3QgbWFrZSB0aGUgY2hpbGQgcmUtY2hlY2sgdGVuZ3Vfa2Fpcm9zLlxuICAgICAgICBhc3Npc3RhbnRNb2R1bGUubWFya0Fzc2lzdGFudEZvcmNlZCgpXG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIGZlYXR1cmUoJ0tBSVJPUycpICYmXG4gICAgICAgIGFzc2lzdGFudE1vZHVsZT8uaXNBc3Npc3RhbnRNb2RlKCkgJiZcbiAgICAgICAgLy8gU3Bhd25lZCB0ZWFtbWF0ZXMgc2hhcmUgdGhlIGxlYWRlcidzIGN3ZCArIHNldHRpbmdzLmpzb24sIHNvXG4gICAgICAgIC8vIGlzQXNzaXN0YW50TW9kZSgpIGlzIHRydWUgZm9yIHRoZW0gdG9vLiAtLWFnZW50LWlkIGJlaW5nIHNldFxuICAgICAgICAvLyBtZWFucyB3ZSBBUkUgYSBzcGF3bmVkIHRlYW1tYXRlIChleHRyYWN0VGVhbW1hdGVPcHRpb25zIHJ1bnNcbiAgICAgICAgLy8gfjE3MCBsaW5lcyBsYXRlciBzbyBjaGVjayB0aGUgcmF3IGNvbW1hbmRlciBvcHRpb24pIOKAlCBkb24ndFxuICAgICAgICAvLyByZS1pbml0IHRoZSB0ZWFtIG9yIG92ZXJyaWRlIHRlYW1tYXRlTW9kZS9wcm9hY3RpdmUvYnJpZWYuXG4gICAgICAgICEob3B0aW9ucyBhcyB7IGFnZW50SWQ/OiB1bmtub3duIH0pLmFnZW50SWQgJiZcbiAgICAgICAga2Fpcm9zR2F0ZVxuICAgICAgKSB7XG4gICAgICAgIGlmICghY2hlY2tIYXNUcnVzdERpYWxvZ0FjY2VwdGVkKCkpIHtcbiAgICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgICAgY2hhbGsueWVsbG93KFxuICAgICAgICAgICAgICAnQXNzaXN0YW50IG1vZGUgZGlzYWJsZWQ6IGRpcmVjdG9yeSBpcyBub3QgdHJ1c3RlZC4gQWNjZXB0IHRoZSB0cnVzdCBkaWFsb2cgYW5kIHJlc3RhcnQuJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEJsb2NraW5nIGdhdGUgY2hlY2sg4oCUIHJldHVybnMgY2FjaGVkIGB0cnVlYCBpbnN0YW50bHk7IGlmIGRpc2tcbiAgICAgICAgICAvLyBjYWNoZSBpcyBmYWxzZS9taXNzaW5nLCBsYXppbHkgaW5pdHMgR3Jvd3RoQm9vayBhbmQgZmV0Y2hlcyBmcmVzaFxuICAgICAgICAgIC8vIChtYXggfjVzKS4gLS1hc3Npc3RhbnQgc2tpcHMgdGhlIGdhdGUgZW50aXJlbHkgKGRhZW1vbiBpc1xuICAgICAgICAgIC8vIHByZS1lbnRpdGxlZCkuXG4gICAgICAgICAga2Fpcm9zRW5hYmxlZCA9XG4gICAgICAgICAgICBhc3Npc3RhbnRNb2R1bGUuaXNBc3Npc3RhbnRGb3JjZWQoKSB8fFxuICAgICAgICAgICAgKGF3YWl0IGthaXJvc0dhdGUuaXNLYWlyb3NFbmFibGVkKCkpXG4gICAgICAgICAgaWYgKGthaXJvc0VuYWJsZWQpIHtcbiAgICAgICAgICAgIGNvbnN0IG9wdHMgPSBvcHRpb25zIGFzIHsgYnJpZWY/OiBib29sZWFuIH1cbiAgICAgICAgICAgIG9wdHMuYnJpZWYgPSB0cnVlXG4gICAgICAgICAgICBzZXRLYWlyb3NBY3RpdmUodHJ1ZSlcbiAgICAgICAgICAgIC8vIFByZS1zZWVkIGFuIGluLXByb2Nlc3MgdGVhbSBzbyBBZ2VudChuYW1lOiBcImZvb1wiKSBzcGF3bnNcbiAgICAgICAgICAgIC8vIHRlYW1tYXRlcyB3aXRob3V0IFRlYW1DcmVhdGUuIE11c3QgcnVuIEJFRk9SRSBzZXR1cCgpIGNhcHR1cmVzXG4gICAgICAgICAgICAvLyB0aGUgdGVhbW1hdGVNb2RlIHNuYXBzaG90IChpbml0aWFsaXplQXNzaXN0YW50VGVhbSBjYWxsc1xuICAgICAgICAgICAgLy8gc2V0Q2xpVGVhbW1hdGVNb2RlT3ZlcnJpZGUgaW50ZXJuYWxseSkuXG4gICAgICAgICAgICBhc3Npc3RhbnRUZWFtQ29udGV4dCA9XG4gICAgICAgICAgICAgIGF3YWl0IGFzc2lzdGFudE1vZHVsZS5pbml0aWFsaXplQXNzaXN0YW50VGVhbSgpXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHtcbiAgICAgICAgZGVidWcgPSBmYWxzZSxcbiAgICAgICAgZGVidWdUb1N0ZGVyciA9IGZhbHNlLFxuICAgICAgICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcbiAgICAgICAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyA9IGZhbHNlLFxuICAgICAgICB0b29sczogYmFzZVRvb2xzID0gW10sXG4gICAgICAgIGFsbG93ZWRUb29scyA9IFtdLFxuICAgICAgICBkaXNhbGxvd2VkVG9vbHMgPSBbXSxcbiAgICAgICAgbWNwQ29uZmlnID0gW10sXG4gICAgICAgIHBlcm1pc3Npb25Nb2RlOiBwZXJtaXNzaW9uTW9kZUNsaSxcbiAgICAgICAgYWRkRGlyID0gW10sXG4gICAgICAgIGZhbGxiYWNrTW9kZWwsXG4gICAgICAgIGJldGFzID0gW10sXG4gICAgICAgIGlkZSA9IGZhbHNlLFxuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIGluY2x1ZGVIb29rRXZlbnRzLFxuICAgICAgICBpbmNsdWRlUGFydGlhbE1lc3NhZ2VzLFxuICAgICAgfSA9IG9wdGlvbnNcblxuICAgICAgaWYgKG9wdGlvbnMucHJlZmlsbCkge1xuICAgICAgICBzZWVkRWFybHlJbnB1dChvcHRpb25zLnByZWZpbGwpXG4gICAgICB9XG5cbiAgICAgIC8vIFByb21pc2UgZm9yIGZpbGUgZG93bmxvYWRzIC0gc3RhcnRlZCBlYXJseSwgYXdhaXRlZCBiZWZvcmUgUkVQTCByZW5kZXJzXG4gICAgICBsZXQgZmlsZURvd25sb2FkUHJvbWlzZTogUHJvbWlzZTxEb3dubG9hZFJlc3VsdFtdPiB8IHVuZGVmaW5lZFxuXG4gICAgICBjb25zdCBhZ2VudHNKc29uID0gb3B0aW9ucy5hZ2VudHNcbiAgICAgIGNvbnN0IGFnZW50Q2xpID0gb3B0aW9ucy5hZ2VudFxuICAgICAgaWYgKGZlYXR1cmUoJ0JHX1NFU1NJT05TJykgJiYgYWdlbnRDbGkpIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfQUdFTlQgPSBhZ2VudENsaVxuICAgICAgfVxuXG4gICAgICAvLyBOT1RFOiBMU1AgbWFuYWdlciBpbml0aWFsaXphdGlvbiBpcyBpbnRlbnRpb25hbGx5IGRlZmVycmVkIHVudGlsIGFmdGVyXG4gICAgICAvLyB0aGUgdHJ1c3QgZGlhbG9nIGlzIGFjY2VwdGVkLiBUaGlzIHByZXZlbnRzIHBsdWdpbiBMU1Agc2VydmVycyBmcm9tXG4gICAgICAvLyBleGVjdXRpbmcgY29kZSBpbiB1bnRydXN0ZWQgZGlyZWN0b3JpZXMgYmVmb3JlIHVzZXIgY29uc2VudC5cblxuICAgICAgLy8gRXh0cmFjdCB0aGVzZSBzZXBhcmF0ZWx5IHNvIHRoZXkgY2FuIGJlIG1vZGlmaWVkIGlmIG5lZWRlZFxuICAgICAgbGV0IG91dHB1dEZvcm1hdCA9IG9wdGlvbnMub3V0cHV0Rm9ybWF0XG4gICAgICBsZXQgaW5wdXRGb3JtYXQgPSBvcHRpb25zLmlucHV0Rm9ybWF0XG4gICAgICBsZXQgdmVyYm9zZSA9IG9wdGlvbnMudmVyYm9zZSA/PyBnZXRHbG9iYWxDb25maWcoKS52ZXJib3NlXG4gICAgICBsZXQgcHJpbnQgPSBvcHRpb25zLnByaW50XG4gICAgICBjb25zdCBpbml0ID0gb3B0aW9ucy5pbml0ID8/IGZhbHNlXG4gICAgICBjb25zdCBpbml0T25seSA9IG9wdGlvbnMuaW5pdE9ubHkgPz8gZmFsc2VcbiAgICAgIGNvbnN0IG1haW50ZW5hbmNlID0gb3B0aW9ucy5tYWludGVuYW5jZSA/PyBmYWxzZVxuXG4gICAgICAvLyBFeHRyYWN0IGRpc2FibGUgc2xhc2ggY29tbWFuZHMgZmxhZ1xuICAgICAgY29uc3QgZGlzYWJsZVNsYXNoQ29tbWFuZHMgPSBvcHRpb25zLmRpc2FibGVTbGFzaENvbW1hbmRzIHx8IGZhbHNlXG5cbiAgICAgIC8vIEV4dHJhY3QgdGFza3MgbW9kZSBvcHRpb25zIChhbnQtb25seSlcbiAgICAgIGNvbnN0IHRhc2tzT3B0aW9uID1cbiAgICAgICAgXCJleHRlcm5hbFwiID09PSAnYW50JyAmJlxuICAgICAgICAob3B0aW9ucyBhcyB7IHRhc2tzPzogYm9vbGVhbiB8IHN0cmluZyB9KS50YXNrc1xuICAgICAgY29uc3QgdGFza0xpc3RJZCA9IHRhc2tzT3B0aW9uXG4gICAgICAgID8gdHlwZW9mIHRhc2tzT3B0aW9uID09PSAnc3RyaW5nJ1xuICAgICAgICAgID8gdGFza3NPcHRpb25cbiAgICAgICAgICA6IERFRkFVTFRfVEFTS1NfTU9ERV9UQVNLX0xJU1RfSURcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnICYmIHRhc2tMaXN0SWQpIHtcbiAgICAgICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfVEFTS19MSVNUX0lEID0gdGFza0xpc3RJZFxuICAgICAgfVxuXG4gICAgICAvLyBFeHRyYWN0IHdvcmt0cmVlIG9wdGlvblxuICAgICAgLy8gd29ya3RyZWUgY2FuIGJlIHRydWUgKGZsYWcgd2l0aG91dCB2YWx1ZSkgb3IgYSBzdHJpbmcgKGN1c3RvbSBuYW1lIG9yIFBSIHJlZmVyZW5jZSlcbiAgICAgIGNvbnN0IHdvcmt0cmVlT3B0aW9uID0gaXNXb3JrdHJlZU1vZGVFbmFibGVkKClcbiAgICAgICAgPyAob3B0aW9ucyBhcyB7IHdvcmt0cmVlPzogYm9vbGVhbiB8IHN0cmluZyB9KS53b3JrdHJlZVxuICAgICAgICA6IHVuZGVmaW5lZFxuICAgICAgbGV0IHdvcmt0cmVlTmFtZSA9XG4gICAgICAgIHR5cGVvZiB3b3JrdHJlZU9wdGlvbiA9PT0gJ3N0cmluZycgPyB3b3JrdHJlZU9wdGlvbiA6IHVuZGVmaW5lZFxuICAgICAgY29uc3Qgd29ya3RyZWVFbmFibGVkID0gd29ya3RyZWVPcHRpb24gIT09IHVuZGVmaW5lZFxuXG4gICAgICAvLyBDaGVjayBpZiB3b3JrdHJlZSBuYW1lIGlzIGEgUFIgcmVmZXJlbmNlICgjTiBvciBHaXRIdWIgUFIgVVJMKVxuICAgICAgbGV0IHdvcmt0cmVlUFJOdW1iZXI6IG51bWJlciB8IHVuZGVmaW5lZFxuICAgICAgaWYgKHdvcmt0cmVlTmFtZSkge1xuICAgICAgICBjb25zdCBwck51bSA9IHBhcnNlUFJSZWZlcmVuY2Uod29ya3RyZWVOYW1lKVxuICAgICAgICBpZiAocHJOdW0gIT09IG51bGwpIHtcbiAgICAgICAgICB3b3JrdHJlZVBSTnVtYmVyID0gcHJOdW1cbiAgICAgICAgICB3b3JrdHJlZU5hbWUgPSB1bmRlZmluZWQgLy8gc2x1ZyB3aWxsIGJlIGdlbmVyYXRlZCBpbiBzZXR1cCgpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCB0bXV4IG9wdGlvbiAocmVxdWlyZXMgLS13b3JrdHJlZSlcbiAgICAgIGNvbnN0IHRtdXhFbmFibGVkID1cbiAgICAgICAgaXNXb3JrdHJlZU1vZGVFbmFibGVkKCkgJiYgKG9wdGlvbnMgYXMgeyB0bXV4PzogYm9vbGVhbiB9KS50bXV4ID09PSB0cnVlXG5cbiAgICAgIC8vIFZhbGlkYXRlIHRtdXggb3B0aW9uXG4gICAgICBpZiAodG11eEVuYWJsZWQpIHtcbiAgICAgICAgaWYgKCF3b3JrdHJlZUVuYWJsZWQpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5yZWQoJ0Vycm9yOiAtLXRtdXggcmVxdWlyZXMgLS13b3JrdHJlZVxcbicpKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICAgIGlmIChnZXRQbGF0Zm9ybSgpID09PSAnd2luZG93cycpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZCgnRXJyb3I6IC0tdG11eCBpcyBub3Qgc3VwcG9ydGVkIG9uIFdpbmRvd3NcXG4nKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCEoYXdhaXQgaXNUbXV4QXZhaWxhYmxlKCkpKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgIGBFcnJvcjogdG11eCBpcyBub3QgaW5zdGFsbGVkLlxcbiR7Z2V0VG11eEluc3RhbGxJbnN0cnVjdGlvbnMoKX1cXG5gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCB0ZWFtbWF0ZSBvcHRpb25zIChmb3IgdG11eC1zcGF3bmVkIGFnZW50cylcbiAgICAgIC8vIERlY2xhcmVkIG91dHNpZGUgdGhlIGlmIGJsb2NrIHNvIGl0J3MgYWNjZXNzaWJsZSBsYXRlciBmb3Igc3lzdGVtIHByb21wdCBhZGRlbmR1bVxuICAgICAgbGV0IHN0b3JlZFRlYW1tYXRlT3B0czogVGVhbW1hdGVPcHRpb25zIHwgdW5kZWZpbmVkXG4gICAgICBpZiAoaXNBZ2VudFN3YXJtc0VuYWJsZWQoKSkge1xuICAgICAgICAvLyBFeHRyYWN0IGFnZW50IGlkZW50aXR5IG9wdGlvbnMgKGZvciB0bXV4LXNwYXduZWQgYWdlbnRzKVxuICAgICAgICAvLyBUaGVzZSByZXBsYWNlIHRoZSBDTEFVREVfQ09ERV8qIGVudmlyb25tZW50IHZhcmlhYmxlc1xuICAgICAgICBjb25zdCB0ZWFtbWF0ZU9wdHMgPSBleHRyYWN0VGVhbW1hdGVPcHRpb25zKG9wdGlvbnMpXG4gICAgICAgIHN0b3JlZFRlYW1tYXRlT3B0cyA9IHRlYW1tYXRlT3B0c1xuXG4gICAgICAgIC8vIElmIGFueSB0ZWFtbWF0ZSBpZGVudGl0eSBvcHRpb24gaXMgcHJvdmlkZWQsIGFsbCB0aHJlZSByZXF1aXJlZCBvbmVzIG11c3QgYmUgcHJlc2VudFxuICAgICAgICBjb25zdCBoYXNBbnlUZWFtbWF0ZU9wdCA9XG4gICAgICAgICAgdGVhbW1hdGVPcHRzLmFnZW50SWQgfHxcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMuYWdlbnROYW1lIHx8XG4gICAgICAgICAgdGVhbW1hdGVPcHRzLnRlYW1OYW1lXG4gICAgICAgIGNvbnN0IGhhc0FsbFJlcXVpcmVkVGVhbW1hdGVPcHRzID1cbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMuYWdlbnRJZCAmJlxuICAgICAgICAgIHRlYW1tYXRlT3B0cy5hZ2VudE5hbWUgJiZcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMudGVhbU5hbWVcblxuICAgICAgICBpZiAoaGFzQW55VGVhbW1hdGVPcHQgJiYgIWhhc0FsbFJlcXVpcmVkVGVhbW1hdGVPcHRzKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdFcnJvcjogLS1hZ2VudC1pZCwgLS1hZ2VudC1uYW1lLCBhbmQgLS10ZWFtLW5hbWUgbXVzdCBhbGwgYmUgcHJvdmlkZWQgdG9nZXRoZXJcXG4nLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0ZWFtbWF0ZSBpZGVudGl0eSBpcyBwcm92aWRlZCB2aWEgQ0xJLCBzZXQgdXAgZHluYW1pY1RlYW1Db250ZXh0XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMuYWdlbnRJZCAmJlxuICAgICAgICAgIHRlYW1tYXRlT3B0cy5hZ2VudE5hbWUgJiZcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMudGVhbU5hbWVcbiAgICAgICAgKSB7XG4gICAgICAgICAgZ2V0VGVhbW1hdGVVdGlscygpLnNldER5bmFtaWNUZWFtQ29udGV4dD8uKHtcbiAgICAgICAgICAgIGFnZW50SWQ6IHRlYW1tYXRlT3B0cy5hZ2VudElkLFxuICAgICAgICAgICAgYWdlbnROYW1lOiB0ZWFtbWF0ZU9wdHMuYWdlbnROYW1lLFxuICAgICAgICAgICAgdGVhbU5hbWU6IHRlYW1tYXRlT3B0cy50ZWFtTmFtZSxcbiAgICAgICAgICAgIGNvbG9yOiB0ZWFtbWF0ZU9wdHMuYWdlbnRDb2xvcixcbiAgICAgICAgICAgIHBsYW5Nb2RlUmVxdWlyZWQ6IHRlYW1tYXRlT3B0cy5wbGFuTW9kZVJlcXVpcmVkID8/IGZhbHNlLFxuICAgICAgICAgICAgcGFyZW50U2Vzc2lvbklkOiB0ZWFtbWF0ZU9wdHMucGFyZW50U2Vzc2lvbklkLFxuICAgICAgICAgIH0pXG4gICAgICAgIH1cblxuICAgICAgICAvLyBTZXQgdGVhbW1hdGUgbW9kZSBDTEkgb3ZlcnJpZGUgaWYgcHJvdmlkZWRcbiAgICAgICAgLy8gVGhpcyBtdXN0IGJlIGRvbmUgYmVmb3JlIHNldHVwKCkgY2FwdHVyZXMgdGhlIHNuYXBzaG90XG4gICAgICAgIGlmICh0ZWFtbWF0ZU9wdHMudGVhbW1hdGVNb2RlKSB7XG4gICAgICAgICAgZ2V0VGVhbW1hdGVNb2RlU25hcHNob3QoKS5zZXRDbGlUZWFtbWF0ZU1vZGVPdmVycmlkZT8uKFxuICAgICAgICAgICAgdGVhbW1hdGVPcHRzLnRlYW1tYXRlTW9kZSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCByZW1vdGUgc2RrIG9wdGlvbnNcbiAgICAgIGNvbnN0IHNka1VybCA9IChvcHRpb25zIGFzIHsgc2RrVXJsPzogc3RyaW5nIH0pLnNka1VybCA/PyB1bmRlZmluZWRcblxuICAgICAgLy8gQWxsb3cgZW52IHZhciB0byBlbmFibGUgcGFydGlhbCBtZXNzYWdlcyAodXNlZCBieSBzYW5kYm94IGdhdGV3YXkgZm9yIGJha3UpXG4gICAgICBjb25zdCBlZmZlY3RpdmVJbmNsdWRlUGFydGlhbE1lc3NhZ2VzID1cbiAgICAgICAgaW5jbHVkZVBhcnRpYWxNZXNzYWdlcyB8fFxuICAgICAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9JTkNMVURFX1BBUlRJQUxfTUVTU0FHRVMpXG5cbiAgICAgIC8vIEVuYWJsZSBhbGwgaG9vayBldmVudCB0eXBlcyB3aGVuIGV4cGxpY2l0bHkgcmVxdWVzdGVkIHZpYSBTREsgb3B0aW9uXG4gICAgICAvLyBvciB3aGVuIHJ1bm5pbmcgaW4gQ0xBVURFX0NPREVfUkVNT1RFIG1vZGUgKENDUiBuZWVkcyB0aGVtKS5cbiAgICAgIC8vIFdpdGhvdXQgdGhpcywgb25seSBTZXNzaW9uU3RhcnQgYW5kIFNldHVwIGV2ZW50cyBhcmUgZW1pdHRlZC5cbiAgICAgIGlmIChpbmNsdWRlSG9va0V2ZW50cyB8fCBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9SRU1PVEUpKSB7XG4gICAgICAgIHNldEFsbEhvb2tFdmVudHNFbmFibGVkKHRydWUpXG4gICAgICB9XG5cbiAgICAgIC8vIEF1dG8tc2V0IGlucHV0L291dHB1dCBmb3JtYXRzLCB2ZXJib3NlIG1vZGUsIGFuZCBwcmludCBtb2RlIHdoZW4gU0RLIFVSTCBpcyBwcm92aWRlZFxuICAgICAgaWYgKHNka1VybCkge1xuICAgICAgICAvLyBJZiBTREsgVVJMIGlzIHByb3ZpZGVkLCBhdXRvbWF0aWNhbGx5IHVzZSBzdHJlYW0tanNvbiBmb3JtYXRzIHVubGVzcyBleHBsaWNpdGx5IHNldFxuICAgICAgICBpZiAoIWlucHV0Rm9ybWF0KSB7XG4gICAgICAgICAgaW5wdXRGb3JtYXQgPSAnc3RyZWFtLWpzb24nXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFvdXRwdXRGb3JtYXQpIHtcbiAgICAgICAgICBvdXRwdXRGb3JtYXQgPSAnc3RyZWFtLWpzb24nXG4gICAgICAgIH1cbiAgICAgICAgLy8gQXV0by1lbmFibGUgdmVyYm9zZSBtb2RlIHVubGVzcyBleHBsaWNpdGx5IGRpc2FibGVkIG9yIGFscmVhZHkgc2V0XG4gICAgICAgIGlmIChvcHRpb25zLnZlcmJvc2UgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHZlcmJvc2UgPSB0cnVlXG4gICAgICAgIH1cbiAgICAgICAgLy8gQXV0by1lbmFibGUgcHJpbnQgbW9kZSB1bmxlc3MgZXhwbGljaXRseSBkaXNhYmxlZFxuICAgICAgICBpZiAoIW9wdGlvbnMucHJpbnQpIHtcbiAgICAgICAgICBwcmludCA9IHRydWVcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBFeHRyYWN0IHRlbGVwb3J0IG9wdGlvblxuICAgICAgY29uc3QgdGVsZXBvcnQgPVxuICAgICAgICAob3B0aW9ucyBhcyB7IHRlbGVwb3J0Pzogc3RyaW5nIHwgdHJ1ZSB9KS50ZWxlcG9ydCA/PyBudWxsXG5cbiAgICAgIC8vIEV4dHJhY3QgcmVtb3RlIG9wdGlvbiAoY2FuIGJlIHRydWUgaWYgbm8gZGVzY3JpcHRpb24gcHJvdmlkZWQsIG9yIGEgc3RyaW5nKVxuICAgICAgY29uc3QgcmVtb3RlT3B0aW9uID0gKG9wdGlvbnMgYXMgeyByZW1vdGU/OiBzdHJpbmcgfCB0cnVlIH0pLnJlbW90ZVxuICAgICAgY29uc3QgcmVtb3RlID0gcmVtb3RlT3B0aW9uID09PSB0cnVlID8gJycgOiAocmVtb3RlT3B0aW9uID8/IG51bGwpXG5cbiAgICAgIC8vIEV4dHJhY3QgLS1yZW1vdGUtY29udHJvbCAvIC0tcmMgZmxhZyAoZW5hYmxlIGJyaWRnZSBpbiBpbnRlcmFjdGl2ZSBzZXNzaW9uKVxuICAgICAgY29uc3QgcmVtb3RlQ29udHJvbE9wdGlvbiA9XG4gICAgICAgIChvcHRpb25zIGFzIHsgcmVtb3RlQ29udHJvbD86IHN0cmluZyB8IHRydWUgfSkucmVtb3RlQ29udHJvbCA/P1xuICAgICAgICAob3B0aW9ucyBhcyB7IHJjPzogc3RyaW5nIHwgdHJ1ZSB9KS5yY1xuICAgICAgLy8gQWN0dWFsIGJyaWRnZSBjaGVjayBpcyBkZWZlcnJlZCB0byBhZnRlciBzaG93U2V0dXBTY3JlZW5zKCkgc28gdGhhdFxuICAgICAgLy8gdHJ1c3QgaXMgZXN0YWJsaXNoZWQgYW5kIEdyb3d0aEJvb2sgaGFzIGF1dGggaGVhZGVycy5cbiAgICAgIGxldCByZW1vdGVDb250cm9sID0gZmFsc2VcbiAgICAgIGNvbnN0IHJlbW90ZUNvbnRyb2xOYW1lID1cbiAgICAgICAgdHlwZW9mIHJlbW90ZUNvbnRyb2xPcHRpb24gPT09ICdzdHJpbmcnICYmXG4gICAgICAgIHJlbW90ZUNvbnRyb2xPcHRpb24ubGVuZ3RoID4gMFxuICAgICAgICAgID8gcmVtb3RlQ29udHJvbE9wdGlvblxuICAgICAgICAgIDogdW5kZWZpbmVkXG5cbiAgICAgIC8vIFZhbGlkYXRlIHNlc3Npb24gSUQgaWYgcHJvdmlkZWRcbiAgICAgIGlmIChzZXNzaW9uSWQpIHtcbiAgICAgICAgLy8gQ2hlY2sgZm9yIGNvbmZsaWN0aW5nIGZsYWdzXG4gICAgICAgIC8vIC0tc2Vzc2lvbi1pZCBjYW4gYmUgdXNlZCB3aXRoIC0tY29udGludWUgb3IgLS1yZXN1bWUgd2hlbiAtLWZvcmstc2Vzc2lvbiBpcyBhbHNvIHByb3ZpZGVkXG4gICAgICAgIC8vICh0byBzcGVjaWZ5IGEgY3VzdG9tIElEIGZvciB0aGUgZm9ya2VkIHNlc3Npb24pXG4gICAgICAgIGlmICgob3B0aW9ucy5jb250aW51ZSB8fCBvcHRpb25zLnJlc3VtZSkgJiYgIW9wdGlvbnMuZm9ya1Nlc3Npb24pIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgJ0Vycm9yOiAtLXNlc3Npb24taWQgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIC0tY29udGludWUgb3IgLS1yZXN1bWUgaWYgLS1mb3JrLXNlc3Npb24gaXMgYWxzbyBzcGVjaWZpZWQuXFxuJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gV2hlbiAtLXNkay11cmwgaXMgcHJvdmlkZWQgKGJyaWRnZS9yZW1vdGUgbW9kZSksIHRoZSBzZXNzaW9uIElEIGlzIGFcbiAgICAgICAgLy8gc2VydmVyLWFzc2lnbmVkIHRhZ2dlZCBJRCAoZS5nLiBcInNlc3Npb25fbG9jYWxfMDEuLi5cIikgcmF0aGVyIHRoYW4gYVxuICAgICAgICAvLyBVVUlELiBTa2lwIFVVSUQgdmFsaWRhdGlvbiBhbmQgbG9jYWwgZXhpc3RlbmNlIGNoZWNrcyBpbiB0aGF0IGNhc2UuXG4gICAgICAgIGlmICghc2RrVXJsKSB7XG4gICAgICAgICAgY29uc3QgdmFsaWRhdGVkU2Vzc2lvbklkID0gdmFsaWRhdGVVdWlkKHNlc3Npb25JZClcbiAgICAgICAgICBpZiAoIXZhbGlkYXRlZFNlc3Npb25JZCkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZCgnRXJyb3I6IEludmFsaWQgc2Vzc2lvbiBJRC4gTXVzdCBiZSBhIHZhbGlkIFVVSUQuXFxuJyksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBDaGVjayBpZiBzZXNzaW9uIElEIGFscmVhZHkgZXhpc3RzXG4gICAgICAgICAgaWYgKHNlc3Npb25JZEV4aXN0cyh2YWxpZGF0ZWRTZXNzaW9uSWQpKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAgIGBFcnJvcjogU2Vzc2lvbiBJRCAke3ZhbGlkYXRlZFNlc3Npb25JZH0gaXMgYWxyZWFkeSBpbiB1c2UuXFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBEb3dubG9hZCBmaWxlIHJlc291cmNlcyBpZiBzcGVjaWZpZWQgdmlhIC0tZmlsZSBmbGFnXG4gICAgICBjb25zdCBmaWxlU3BlY3MgPSAob3B0aW9ucyBhcyB7IGZpbGU/OiBzdHJpbmdbXSB9KS5maWxlXG4gICAgICBpZiAoZmlsZVNwZWNzICYmIGZpbGVTcGVjcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIC8vIEdldCBzZXNzaW9uIGluZ3Jlc3MgdG9rZW4gKHByb3ZpZGVkIGJ5IEVudk1hbmFnZXIgdmlhIENMQVVERV9DT0RFX1NFU1NJT05fQUNDRVNTX1RPS0VOKVxuICAgICAgICBjb25zdCBzZXNzaW9uVG9rZW4gPSBnZXRTZXNzaW9uSW5ncmVzc0F1dGhUb2tlbigpXG4gICAgICAgIGlmICghc2Vzc2lvblRva2VuKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdFcnJvcjogU2Vzc2lvbiB0b2tlbiByZXF1aXJlZCBmb3IgZmlsZSBkb3dubG9hZHMuIENMQVVERV9DT0RFX1NFU1NJT05fQUNDRVNTX1RPS0VOIG11c3QgYmUgc2V0LlxcbicsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFJlc29sdmUgc2Vzc2lvbiBJRDogcHJlZmVyIHJlbW90ZSBzZXNzaW9uIElELCBmYWxsIGJhY2sgdG8gaW50ZXJuYWwgc2Vzc2lvbiBJRFxuICAgICAgICBjb25zdCBmaWxlU2Vzc2lvbklkID1cbiAgICAgICAgICBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9SRU1PVEVfU0VTU0lPTl9JRCB8fCBnZXRTZXNzaW9uSWQoKVxuXG4gICAgICAgIGNvbnN0IGZpbGVzID0gcGFyc2VGaWxlU3BlY3MoZmlsZVNwZWNzKVxuICAgICAgICBpZiAoZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIC8vIFVzZSBBTlRIUk9QSUNfQkFTRV9VUkwgaWYgc2V0IChieSBFbnZNYW5hZ2VyKSwgb3RoZXJ3aXNlIHVzZSBPQXV0aCBjb25maWdcbiAgICAgICAgICAvLyBUaGlzIGVuc3VyZXMgY29uc2lzdGVuY3kgd2l0aCBzZXNzaW9uIGluZ3Jlc3MgQVBJIGluIGFsbCBlbnZpcm9ubWVudHNcbiAgICAgICAgICBjb25zdCBjb25maWc6IEZpbGVzQXBpQ29uZmlnID0ge1xuICAgICAgICAgICAgYmFzZVVybDpcbiAgICAgICAgICAgICAgcHJvY2Vzcy5lbnYuQU5USFJPUElDX0JBU0VfVVJMIHx8IGdldE9hdXRoQ29uZmlnKCkuQkFTRV9BUElfVVJMLFxuICAgICAgICAgICAgb2F1dGhUb2tlbjogc2Vzc2lvblRva2VuLFxuICAgICAgICAgICAgc2Vzc2lvbklkOiBmaWxlU2Vzc2lvbklkLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFN0YXJ0IGRvd25sb2FkIHdpdGhvdXQgYmxvY2tpbmcgc3RhcnR1cCAtIGF3YWl0IGJlZm9yZSBSRVBMIHJlbmRlcnNcbiAgICAgICAgICBmaWxlRG93bmxvYWRQcm9taXNlID0gZG93bmxvYWRTZXNzaW9uRmlsZXMoZmlsZXMsIGNvbmZpZylcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBHZXQgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gZnJvbSBzdGF0ZSAod2FzIHNldCBiZWZvcmUgaW5pdCgpKVxuICAgICAgY29uc3QgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gPSBnZXRJc05vbkludGVyYWN0aXZlU2Vzc2lvbigpXG5cbiAgICAgIC8vIFZhbGlkYXRlIHRoYXQgZmFsbGJhY2sgbW9kZWwgaXMgZGlmZmVyZW50IGZyb20gbWFpbiBtb2RlbFxuICAgICAgaWYgKGZhbGxiYWNrTW9kZWwgJiYgb3B0aW9ucy5tb2RlbCAmJiBmYWxsYmFja01vZGVsID09PSBvcHRpb25zLm1vZGVsKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICdFcnJvcjogRmFsbGJhY2sgbW9kZWwgY2Fubm90IGJlIHRoZSBzYW1lIGFzIHRoZSBtYWluIG1vZGVsLiBQbGVhc2Ugc3BlY2lmeSBhIGRpZmZlcmVudCBtb2RlbCBmb3IgLS1mYWxsYmFjay1tb2RlbC5cXG4nLFxuICAgICAgICAgICksXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBzeXN0ZW0gcHJvbXB0IG9wdGlvbnNcbiAgICAgIGxldCBzeXN0ZW1Qcm9tcHQgPSBvcHRpb25zLnN5c3RlbVByb21wdFxuICAgICAgaWYgKG9wdGlvbnMuc3lzdGVtUHJvbXB0RmlsZSkge1xuICAgICAgICBpZiAob3B0aW9ucy5zeXN0ZW1Qcm9tcHQpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgJ0Vycm9yOiBDYW5ub3QgdXNlIGJvdGggLS1zeXN0ZW0tcHJvbXB0IGFuZCAtLXN5c3RlbS1wcm9tcHQtZmlsZS4gUGxlYXNlIHVzZSBvbmx5IG9uZS5cXG4nLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZShvcHRpb25zLnN5c3RlbVByb21wdEZpbGUpXG4gICAgICAgICAgc3lzdGVtUHJvbXB0ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmOCcpXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc3QgY29kZSA9IGdldEVycm5vQ29kZShlcnJvcilcbiAgICAgICAgICBpZiAoY29kZSA9PT0gJ0VOT0VOVCcpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICAgYEVycm9yOiBTeXN0ZW0gcHJvbXB0IGZpbGUgbm90IGZvdW5kOiAke3Jlc29sdmUob3B0aW9ucy5zeXN0ZW1Qcm9tcHRGaWxlKX1cXG5gLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICBgRXJyb3IgcmVhZGluZyBzeXN0ZW0gcHJvbXB0IGZpbGU6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIGFwcGVuZCBzeXN0ZW0gcHJvbXB0IG9wdGlvbnNcbiAgICAgIGxldCBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBvcHRpb25zLmFwcGVuZFN5c3RlbVByb21wdFxuICAgICAgaWYgKG9wdGlvbnMuYXBwZW5kU3lzdGVtUHJvbXB0RmlsZSkge1xuICAgICAgICBpZiAob3B0aW9ucy5hcHBlbmRTeXN0ZW1Qcm9tcHQpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgJ0Vycm9yOiBDYW5ub3QgdXNlIGJvdGggLS1hcHBlbmQtc3lzdGVtLXByb21wdCBhbmQgLS1hcHBlbmQtc3lzdGVtLXByb21wdC1maWxlLiBQbGVhc2UgdXNlIG9ubHkgb25lLlxcbicsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlKG9wdGlvbnMuYXBwZW5kU3lzdGVtUHJvbXB0RmlsZSlcbiAgICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGY4JylcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zdCBjb2RlID0gZ2V0RXJybm9Db2RlKGVycm9yKVxuICAgICAgICAgIGlmIChjb2RlID09PSAnRU5PRU5UJykge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICBgRXJyb3I6IEFwcGVuZCBzeXN0ZW0gcHJvbXB0IGZpbGUgbm90IGZvdW5kOiAke3Jlc29sdmUob3B0aW9ucy5hcHBlbmRTeXN0ZW1Qcm9tcHRGaWxlKX1cXG5gLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICBgRXJyb3IgcmVhZGluZyBhcHBlbmQgc3lzdGVtIHByb21wdCBmaWxlOiAke2Vycm9yTWVzc2FnZShlcnJvcil9XFxuYCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEFkZCB0ZWFtbWF0ZS1zcGVjaWZpYyBzeXN0ZW0gcHJvbXB0IGFkZGVuZHVtIGZvciB0bXV4IHRlYW1tYXRlc1xuICAgICAgaWYgKFxuICAgICAgICBpc0FnZW50U3dhcm1zRW5hYmxlZCgpICYmXG4gICAgICAgIHN0b3JlZFRlYW1tYXRlT3B0cz8uYWdlbnRJZCAmJlxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHM/LmFnZW50TmFtZSAmJlxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHM/LnRlYW1OYW1lXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgYWRkZW5kdW0gPVxuICAgICAgICAgIGdldFRlYW1tYXRlUHJvbXB0QWRkZW5kdW0oKS5URUFNTUFURV9TWVNURU1fUFJPTVBUX0FEREVORFVNXG4gICAgICAgIGFwcGVuZFN5c3RlbVByb21wdCA9IGFwcGVuZFN5c3RlbVByb21wdFxuICAgICAgICAgID8gYCR7YXBwZW5kU3lzdGVtUHJvbXB0fVxcblxcbiR7YWRkZW5kdW19YFxuICAgICAgICAgIDogYWRkZW5kdW1cbiAgICAgIH1cblxuICAgICAgY29uc3QgeyBtb2RlOiBwZXJtaXNzaW9uTW9kZSwgbm90aWZpY2F0aW9uOiBwZXJtaXNzaW9uTW9kZU5vdGlmaWNhdGlvbiB9ID1cbiAgICAgICAgaW5pdGlhbFBlcm1pc3Npb25Nb2RlRnJvbUNMSSh7XG4gICAgICAgICAgcGVybWlzc2lvbk1vZGVDbGksXG4gICAgICAgICAgZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgIH0pXG5cbiAgICAgIC8vIFN0b3JlIHNlc3Npb24gYnlwYXNzIHBlcm1pc3Npb25zIG1vZGUgZm9yIHRydXN0IGRpYWxvZyBjaGVja1xuICAgICAgc2V0U2Vzc2lvbkJ5cGFzc1Blcm1pc3Npb25zTW9kZShwZXJtaXNzaW9uTW9kZSA9PT0gJ2J5cGFzc1Blcm1pc3Npb25zJylcbiAgICAgIGlmIChmZWF0dXJlKCdUUkFOU0NSSVBUX0NMQVNTSUZJRVInKSkge1xuICAgICAgICAvLyBhdXRvTW9kZUZsYWdDbGkgaXMgdGhlIFwiZGlkIHRoZSB1c2VyIGludGVuZCBhdXRvIHRoaXMgc2Vzc2lvblwiIHNpZ25hbC5cbiAgICAgICAgLy8gU2V0IHdoZW46IC0tZW5hYmxlLWF1dG8tbW9kZSwgLS1wZXJtaXNzaW9uLW1vZGUgYXV0bywgcmVzb2x2ZWQgbW9kZVxuICAgICAgICAvLyBpcyBhdXRvLCBPUiBzZXR0aW5ncyBkZWZhdWx0TW9kZSBpcyBhdXRvIGJ1dCB0aGUgZ2F0ZSBkZW5pZWQgaXRcbiAgICAgICAgLy8gKHBlcm1pc3Npb25Nb2RlIHJlc29sdmVkIHRvIGRlZmF1bHQgd2l0aCBubyBleHBsaWNpdCBDTEkgb3ZlcnJpZGUpLlxuICAgICAgICAvLyBVc2VkIGJ5IHZlcmlmeUF1dG9Nb2RlR2F0ZUFjY2VzcyB0byBkZWNpZGUgd2hldGhlciB0byBub3RpZnkgb25cbiAgICAgICAgLy8gYXV0by11bmF2YWlsYWJsZSwgYW5kIGJ5IHRlbmd1X2F1dG9fbW9kZV9jb25maWcgb3B0LWluIGNhcm91c2VsLlxuICAgICAgICBpZiAoXG4gICAgICAgICAgKG9wdGlvbnMgYXMgeyBlbmFibGVBdXRvTW9kZT86IGJvb2xlYW4gfSkuZW5hYmxlQXV0b01vZGUgfHxcbiAgICAgICAgICBwZXJtaXNzaW9uTW9kZUNsaSA9PT0gJ2F1dG8nIHx8XG4gICAgICAgICAgcGVybWlzc2lvbk1vZGUgPT09ICdhdXRvJyB8fFxuICAgICAgICAgICghcGVybWlzc2lvbk1vZGVDbGkgJiYgaXNEZWZhdWx0UGVybWlzc2lvbk1vZGVBdXRvKCkpXG4gICAgICAgICkge1xuICAgICAgICAgIGF1dG9Nb2RlU3RhdGVNb2R1bGU/LnNldEF1dG9Nb2RlRmxhZ0NsaSh0cnVlKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFBhcnNlIHRoZSBNQ1AgY29uZmlnIGZpbGVzL3N0cmluZ3MgaWYgcHJvdmlkZWRcbiAgICAgIGxldCBkeW5hbWljTWNwQ29uZmlnOiBSZWNvcmQ8c3RyaW5nLCBTY29wZWRNY3BTZXJ2ZXJDb25maWc+ID0ge31cblxuICAgICAgaWYgKG1jcENvbmZpZyAmJiBtY3BDb25maWcubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBQcm9jZXNzIG1jcENvbmZpZyBhcnJheVxuICAgICAgICBjb25zdCBwcm9jZXNzZWRDb25maWdzID0gbWNwQ29uZmlnXG4gICAgICAgICAgLm1hcChjb25maWcgPT4gY29uZmlnLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKGNvbmZpZyA9PiBjb25maWcubGVuZ3RoID4gMClcblxuICAgICAgICBsZXQgYWxsQ29uZmlnczogUmVjb3JkPHN0cmluZywgTWNwU2VydmVyQ29uZmlnPiA9IHt9XG4gICAgICAgIGNvbnN0IGFsbEVycm9yczogVmFsaWRhdGlvbkVycm9yW10gPSBbXVxuXG4gICAgICAgIGZvciAoY29uc3QgY29uZmlnSXRlbSBvZiBwcm9jZXNzZWRDb25maWdzKSB7XG4gICAgICAgICAgbGV0IGNvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIE1jcFNlcnZlckNvbmZpZz4gfCBudWxsID0gbnVsbFxuICAgICAgICAgIGxldCBlcnJvcnM6IFZhbGlkYXRpb25FcnJvcltdID0gW11cblxuICAgICAgICAgIC8vIEZpcnN0IHRyeSB0byBwYXJzZSBhcyBKU09OIHN0cmluZ1xuICAgICAgICAgIGNvbnN0IHBhcnNlZEpzb24gPSBzYWZlUGFyc2VKU09OKGNvbmZpZ0l0ZW0pXG4gICAgICAgICAgaWYgKHBhcnNlZEpzb24pIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlTWNwQ29uZmlnKHtcbiAgICAgICAgICAgICAgY29uZmlnT2JqZWN0OiBwYXJzZWRKc29uLFxuICAgICAgICAgICAgICBmaWxlUGF0aDogJ2NvbW1hbmQgbGluZScsXG4gICAgICAgICAgICAgIGV4cGFuZFZhcnM6IHRydWUsXG4gICAgICAgICAgICAgIHNjb3BlOiAnZHluYW1pYycsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgaWYgKHJlc3VsdC5jb25maWcpIHtcbiAgICAgICAgICAgICAgY29uZmlncyA9IHJlc3VsdC5jb25maWcubWNwU2VydmVyc1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXJyb3JzID0gcmVzdWx0LmVycm9yc1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBUcnkgYXMgZmlsZSBwYXRoXG4gICAgICAgICAgICBjb25zdCBjb25maWdQYXRoID0gcmVzb2x2ZShjb25maWdJdGVtKVxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gcGFyc2VNY3BDb25maWdGcm9tRmlsZVBhdGgoe1xuICAgICAgICAgICAgICBmaWxlUGF0aDogY29uZmlnUGF0aCxcbiAgICAgICAgICAgICAgZXhwYW5kVmFyczogdHJ1ZSxcbiAgICAgICAgICAgICAgc2NvcGU6ICdkeW5hbWljJyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAocmVzdWx0LmNvbmZpZykge1xuICAgICAgICAgICAgICBjb25maWdzID0gcmVzdWx0LmNvbmZpZy5tY3BTZXJ2ZXJzXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBlcnJvcnMgPSByZXN1bHQuZXJyb3JzXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKGVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBhbGxFcnJvcnMucHVzaCguLi5lcnJvcnMpXG4gICAgICAgICAgfSBlbHNlIGlmIChjb25maWdzKSB7XG4gICAgICAgICAgICAvLyBNZXJnZSBjb25maWdzLCBsYXRlciBvbmVzIG92ZXJyaWRlIGVhcmxpZXIgb25lc1xuICAgICAgICAgICAgYWxsQ29uZmlncyA9IHsgLi4uYWxsQ29uZmlncywgLi4uY29uZmlncyB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFsbEVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgZm9ybWF0dGVkRXJyb3JzID0gYWxsRXJyb3JzXG4gICAgICAgICAgICAubWFwKGVyciA9PiBgJHtlcnIucGF0aCA/IGVyci5wYXRoICsgJzogJyA6ICcnfSR7ZXJyLm1lc3NhZ2V9YClcbiAgICAgICAgICAgIC5qb2luKCdcXG4nKVxuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgIGAtLW1jcC1jb25maWcgdmFsaWRhdGlvbiBmYWlsZWQgKCR7YWxsRXJyb3JzLmxlbmd0aH0gZXJyb3JzKTogJHtmb3JtYXR0ZWRFcnJvcnN9YCxcbiAgICAgICAgICAgIHsgbGV2ZWw6ICdlcnJvcicgfSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBgRXJyb3I6IEludmFsaWQgTUNQIGNvbmZpZ3VyYXRpb246XFxuJHtmb3JtYXR0ZWRFcnJvcnN9XFxuYCxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoT2JqZWN0LmtleXMoYWxsQ29uZmlncykubGVuZ3RoID4gMCkge1xuICAgICAgICAgIC8vIFNESyBob3N0cyAoTmVzdC9EZXNrdG9wKSBvd24gdGhlaXIgc2VydmVyIG5hbWluZyBhbmQgbWF5IHJldXNlXG4gICAgICAgICAgLy8gYnVpbHQtaW4gbmFtZXMg4oCUIHNraXAgcmVzZXJ2ZWQtbmFtZSBjaGVja3MgZm9yIHR5cGU6J3NkaycuXG4gICAgICAgICAgY29uc3Qgbm9uU2RrQ29uZmlnTmFtZXMgPSBPYmplY3QuZW50cmllcyhhbGxDb25maWdzKVxuICAgICAgICAgICAgLmZpbHRlcigoWywgY29uZmlnXSkgPT4gY29uZmlnLnR5cGUgIT09ICdzZGsnKVxuICAgICAgICAgICAgLm1hcCgoW25hbWVdKSA9PiBuYW1lKVxuXG4gICAgICAgICAgbGV0IHJlc2VydmVkTmFtZUVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbFxuICAgICAgICAgIGlmIChub25TZGtDb25maWdOYW1lcy5zb21lKGlzQ2xhdWRlSW5DaHJvbWVNQ1BTZXJ2ZXIpKSB7XG4gICAgICAgICAgICByZXNlcnZlZE5hbWVFcnJvciA9IGBJbnZhbGlkIE1DUCBjb25maWd1cmF0aW9uOiBcIiR7Q0xBVURFX0lOX0NIUk9NRV9NQ1BfU0VSVkVSX05BTUV9XCIgaXMgYSByZXNlcnZlZCBNQ1AgbmFtZS5gXG4gICAgICAgICAgfSBlbHNlIGlmIChmZWF0dXJlKCdDSElDQUdPX01DUCcpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGlzQ29tcHV0ZXJVc2VNQ1BTZXJ2ZXIsIENPTVBVVEVSX1VTRV9NQ1BfU0VSVkVSX05BTUUgfSA9XG4gICAgICAgICAgICAgIGF3YWl0IGltcG9ydCgnc3JjL3V0aWxzL2NvbXB1dGVyVXNlL2NvbW1vbi5qcycpXG4gICAgICAgICAgICBpZiAobm9uU2RrQ29uZmlnTmFtZXMuc29tZShpc0NvbXB1dGVyVXNlTUNQU2VydmVyKSkge1xuICAgICAgICAgICAgICByZXNlcnZlZE5hbWVFcnJvciA9IGBJbnZhbGlkIE1DUCBjb25maWd1cmF0aW9uOiBcIiR7Q09NUFVURVJfVVNFX01DUF9TRVJWRVJfTkFNRX1cIiBpcyBhIHJlc2VydmVkIE1DUCBuYW1lLmBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlc2VydmVkTmFtZUVycm9yKSB7XG4gICAgICAgICAgICAvLyBzdGRlcnIrZXhpdCgxKSDigJQgYSB0aHJvdyBoZXJlIGJlY29tZXMgYSBzaWxlbnQgdW5oYW5kbGVkXG4gICAgICAgICAgICAvLyByZWplY3Rpb24gaW4gc3RyZWFtLWpzb24gbW9kZSAodm9pZCBtYWluKCkgaW4gY2xpLnRzeCkuXG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgRXJyb3I6ICR7cmVzZXJ2ZWROYW1lRXJyb3J9XFxuYClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEFkZCBkeW5hbWljIHNjb3BlIHRvIGFsbCBjb25maWdzLiB0eXBlOidzZGsnIGVudHJpZXMgcGFzcyB0aHJvdWdoXG4gICAgICAgICAgLy8gdW5jaGFuZ2VkIOKAlCB0aGV5J3JlIGV4dHJhY3RlZCBpbnRvIHNka01jcENvbmZpZ3MgZG93bnN0cmVhbSBhbmRcbiAgICAgICAgICAvLyBwYXNzZWQgdG8gcHJpbnQudHMuIFRoZSBQeXRob24gU0RLIHJlbGllcyBvbiB0aGlzIHBhdGggKGl0IGRvZXNuJ3RcbiAgICAgICAgICAvLyBzZW5kIHNka01jcFNlcnZlcnMgaW4gdGhlIGluaXRpYWxpemUgbWVzc2FnZSkuIERyb3BwaW5nIHRoZW0gaGVyZVxuICAgICAgICAgIC8vIGJyb2tlIENvd29ya2VyIChpbmMtNTEyMikuIFRoZSBwb2xpY3kgZmlsdGVyIGJlbG93IGFscmVhZHkgZXhlbXB0c1xuICAgICAgICAgIC8vIHR5cGU6J3NkaycsIGFuZCB0aGUgZW50cmllcyBhcmUgaW5lcnQgd2l0aG91dCBhbiBTREsgdHJhbnNwb3J0IG9uXG4gICAgICAgICAgLy8gc3RkaW4sIHNvIHRoZXJlJ3Mgbm8gYnlwYXNzIHJpc2sgZnJvbSBsZXR0aW5nIHRoZW0gdGhyb3VnaC5cbiAgICAgICAgICBjb25zdCBzY29wZWRDb25maWdzID0gbWFwVmFsdWVzKGFsbENvbmZpZ3MsIGNvbmZpZyA9PiAoe1xuICAgICAgICAgICAgLi4uY29uZmlnLFxuICAgICAgICAgICAgc2NvcGU6ICdkeW5hbWljJyBhcyBjb25zdCxcbiAgICAgICAgICB9KSlcblxuICAgICAgICAgIC8vIEVuZm9yY2UgbWFuYWdlZCBwb2xpY3kgKGFsbG93ZWRNY3BTZXJ2ZXJzIC8gZGVuaWVkTWNwU2VydmVycykgb25cbiAgICAgICAgICAvLyAtLW1jcC1jb25maWcgc2VydmVycy4gV2l0aG91dCB0aGlzLCB0aGUgQ0xJIGZsYWcgYnlwYXNzZXMgdGhlXG4gICAgICAgICAgLy8gZW50ZXJwcmlzZSBhbGxvd2xpc3QgdGhhdCB1c2VyL3Byb2plY3QvbG9jYWwgY29uZmlncyBnbyB0aHJvdWdoIGluXG4gICAgICAgICAgLy8gZ2V0Q2xhdWRlQ29kZU1jcENvbmZpZ3Mg4oCUIGNhbGxlcnMgc3ByZWFkIGR5bmFtaWNNY3BDb25maWcgYmFjayBvblxuICAgICAgICAgIC8vIHRvcCBvZiBmaWx0ZXJlZCByZXN1bHRzLiBGaWx0ZXIgaGVyZSBhdCB0aGUgc291cmNlIHNvIGFsbFxuICAgICAgICAgIC8vIGRvd25zdHJlYW0gY29uc3VtZXJzIHNlZSB0aGUgcG9saWN5LWZpbHRlcmVkIHNldC5cbiAgICAgICAgICBjb25zdCB7IGFsbG93ZWQsIGJsb2NrZWQgfSA9IGZpbHRlck1jcFNlcnZlcnNCeVBvbGljeShzY29wZWRDb25maWdzKVxuICAgICAgICAgIGlmIChibG9ja2VkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgV2FybmluZzogTUNQICR7cGx1cmFsKGJsb2NrZWQubGVuZ3RoLCAnc2VydmVyJyl9IGJsb2NrZWQgYnkgZW50ZXJwcmlzZSBwb2xpY3k6ICR7YmxvY2tlZC5qb2luKCcsICcpfVxcbmAsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICAgIGR5bmFtaWNNY3BDb25maWcgPSB7IC4uLmR5bmFtaWNNY3BDb25maWcsIC4uLmFsbG93ZWQgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgQ2xhdWRlIGluIENocm9tZSBvcHRpb24gYW5kIGVuZm9yY2UgY2xhdWRlLmFpIHN1YnNjcmliZXIgY2hlY2sgKHVubGVzcyB1c2VyIGlzIGFudClcbiAgICAgIGNvbnN0IGNocm9tZU9wdHMgPSBvcHRpb25zIGFzIHsgY2hyb21lPzogYm9vbGVhbiB9XG4gICAgICAvLyBTdG9yZSB0aGUgZXhwbGljaXQgQ0xJIGZsYWcgc28gdGVhbW1hdGVzIGNhbiBpbmhlcml0IGl0XG4gICAgICBzZXRDaHJvbWVGbGFnT3ZlcnJpZGUoY2hyb21lT3B0cy5jaHJvbWUpXG4gICAgICBjb25zdCBlbmFibGVDbGF1ZGVJbkNocm9tZSA9XG4gICAgICAgIHNob3VsZEVuYWJsZUNsYXVkZUluQ2hyb21lKGNocm9tZU9wdHMuY2hyb21lKSAmJlxuICAgICAgICAoXCJleHRlcm5hbFwiID09PSAnYW50JyB8fCBpc0NsYXVkZUFJU3Vic2NyaWJlcigpKVxuICAgICAgY29uc3QgYXV0b0VuYWJsZUNsYXVkZUluQ2hyb21lID1cbiAgICAgICAgIWVuYWJsZUNsYXVkZUluQ2hyb21lICYmIHNob3VsZEF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSgpXG5cbiAgICAgIGlmIChlbmFibGVDbGF1ZGVJbkNocm9tZSkge1xuICAgICAgICBjb25zdCBwbGF0Zm9ybSA9IGdldFBsYXRmb3JtKClcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY2xhdWRlX2luX2Nocm9tZV9zZXR1cCcsIHtcbiAgICAgICAgICAgIHBsYXRmb3JtOlxuICAgICAgICAgICAgICBwbGF0Zm9ybSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICBtY3BDb25maWc6IGNocm9tZU1jcENvbmZpZyxcbiAgICAgICAgICAgIGFsbG93ZWRUb29sczogY2hyb21lTWNwVG9vbHMsXG4gICAgICAgICAgICBzeXN0ZW1Qcm9tcHQ6IGNocm9tZVN5c3RlbVByb21wdCxcbiAgICAgICAgICB9ID0gc2V0dXBDbGF1ZGVJbkNocm9tZSgpXG4gICAgICAgICAgZHluYW1pY01jcENvbmZpZyA9IHsgLi4uZHluYW1pY01jcENvbmZpZywgLi4uY2hyb21lTWNwQ29uZmlnIH1cbiAgICAgICAgICBhbGxvd2VkVG9vbHMucHVzaCguLi5jaHJvbWVNY3BUb29scylcbiAgICAgICAgICBpZiAoY2hyb21lU3lzdGVtUHJvbXB0KSB7XG4gICAgICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICAgICAgPyBgJHtjaHJvbWVTeXN0ZW1Qcm9tcHR9XFxuXFxuJHthcHBlbmRTeXN0ZW1Qcm9tcHR9YFxuICAgICAgICAgICAgICA6IGNocm9tZVN5c3RlbVByb21wdFxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY2xhdWRlX2luX2Nocm9tZV9zZXR1cF9mYWlsZWQnLCB7XG4gICAgICAgICAgICBwbGF0Zm9ybTpcbiAgICAgICAgICAgICAgcGxhdGZvcm0gYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhgW0NsYXVkZSBpbiBDaHJvbWVdIEVycm9yOiAke2Vycm9yfWApXG4gICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3VzcGljaW91cy9ub0NvbnNvbGU6OiBpbnRlbnRpb25hbCBjb25zb2xlIG91dHB1dFxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yOiBGYWlsZWQgdG8gcnVuIHdpdGggQ2xhdWRlIGluIENocm9tZS5gKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHsgbWNwQ29uZmlnOiBjaHJvbWVNY3BDb25maWcgfSA9IHNldHVwQ2xhdWRlSW5DaHJvbWUoKVxuICAgICAgICAgIGR5bmFtaWNNY3BDb25maWcgPSB7IC4uLmR5bmFtaWNNY3BDb25maWcsIC4uLmNocm9tZU1jcENvbmZpZyB9XG5cbiAgICAgICAgICBjb25zdCBoaW50ID1cbiAgICAgICAgICAgIGZlYXR1cmUoJ1dFQl9CUk9XU0VSX1RPT0wnKSAmJlxuICAgICAgICAgICAgdHlwZW9mIEJ1biAhPT0gJ3VuZGVmaW5lZCcgJiZcbiAgICAgICAgICAgICdXZWJWaWV3JyBpbiBCdW5cbiAgICAgICAgICAgICAgPyBDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlRfV0lUSF9XRUJCUk9XU0VSXG4gICAgICAgICAgICAgIDogQ0xBVURFX0lOX0NIUk9NRV9TS0lMTF9ISU5UXG4gICAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0ID0gYXBwZW5kU3lzdGVtUHJvbXB0XG4gICAgICAgICAgICA/IGAke2FwcGVuZFN5c3RlbVByb21wdH1cXG5cXG4ke2hpbnR9YFxuICAgICAgICAgICAgOiBoaW50XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgLy8gU2lsZW50bHkgc2tpcCBhbnkgZXJyb3JzIGZvciB0aGUgYXV0by1lbmFibGVcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoYFtDbGF1ZGUgaW4gQ2hyb21lXSBFcnJvciAoYXV0by1lbmFibGUpOiAke2Vycm9yfWApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCBzdHJpY3QgTUNQIGNvbmZpZyBmbGFnXG4gICAgICBjb25zdCBzdHJpY3RNY3BDb25maWcgPSBvcHRpb25zLnN0cmljdE1jcENvbmZpZyB8fCBmYWxzZVxuXG4gICAgICAvLyBDaGVjayBpZiBlbnRlcnByaXNlIE1DUCBjb25maWd1cmF0aW9uIGV4aXN0cy4gV2hlbiBpdCBkb2VzLCBvbmx5IGFsbG93IGR5bmFtaWMgTUNQXG4gICAgICAvLyBjb25maWdzIHRoYXQgY29udGFpbiBzcGVjaWFsIHNlcnZlciB0eXBlcyAoc2RrKVxuICAgICAgaWYgKGRvZXNFbnRlcnByaXNlTWNwQ29uZmlnRXhpc3QoKSkge1xuICAgICAgICBpZiAoc3RyaWN0TWNwQ29uZmlnKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdZb3UgY2Fubm90IHVzZSAtLXN0cmljdC1tY3AtY29uZmlnIHdoZW4gYW4gZW50ZXJwcmlzZSBNQ1AgY29uZmlnIGlzIHByZXNlbnQnLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb3IgLS1tY3AtY29uZmlnLCBhbGxvdyBpZiBhbGwgc2VydmVycyBhcmUgaW50ZXJuYWwgdHlwZXMgKHNkaylcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGR5bmFtaWNNY3BDb25maWcgJiZcbiAgICAgICAgICAhYXJlTWNwQ29uZmlnc0FsbG93ZWRXaXRoRW50ZXJwcmlzZU1jcENvbmZpZyhkeW5hbWljTWNwQ29uZmlnKVxuICAgICAgICApIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgJ1lvdSBjYW5ub3QgZHluYW1pY2FsbHkgY29uZmlndXJlIE1DUCBzZXJ2ZXJzIHdoZW4gYW4gZW50ZXJwcmlzZSBNQ1AgY29uZmlnIGlzIHByZXNlbnQnLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gY2hpY2FnbyBNQ1A6IGd1YXJkZWQgQ29tcHV0ZXIgVXNlIChhcHAgYWxsb3dsaXN0ICsgZnJvbnRtb3N0IGdhdGUgK1xuICAgICAgLy8gU0NDb250ZW50RmlsdGVyIHNjcmVlbnNob3RzKS4gQW50LW9ubHksIEdyb3d0aEJvb2stZ2F0ZWQg4oCUIGZhaWx1cmVzXG4gICAgICAvLyBhcmUgc2lsZW50ICh0aGlzIGlzIGRvZ2Zvb2RpbmcpLiBQbGF0Zm9ybSArIGludGVyYWN0aXZlIGNoZWNrcyBpbmxpbmVcbiAgICAgIC8vIHNvIG5vbi1tYWNPUyAvIHByaW50LW1vZGUgYW50cyBza2lwIHRoZSBoZWF2eSBAYW50L2NvbXB1dGVyLXVzZS1tY3BcbiAgICAgIC8vIGltcG9ydCBlbnRpcmVseS4gZ2F0ZXMuanMgaXMgbGlnaHQgKHR5cGUtb25seSBwYWNrYWdlIGltcG9ydCkuXG4gICAgICAvL1xuICAgICAgLy8gUGxhY2VkIEFGVEVSIHRoZSBlbnRlcnByaXNlLU1DUC1jb25maWcgY2hlY2s6IHRoYXQgY2hlY2sgcmVqZWN0cyBhbnlcbiAgICAgIC8vIGR5bmFtaWNNY3BDb25maWcgZW50cnkgd2l0aCBgdHlwZSAhPT0gJ3NkaydgLCBhbmQgb3VyIGNvbmZpZyBpc1xuICAgICAgLy8gYHR5cGU6ICdzdGRpbydgLiBBbiBlbnRlcnByaXNlLWNvbmZpZyBhbnQgd2l0aCB0aGUgR0IgZ2F0ZSBvbiB3b3VsZFxuICAgICAgLy8gb3RoZXJ3aXNlIHByb2Nlc3MuZXhpdCgxKS4gQ2hyb21lIGhhcyB0aGUgc2FtZSBsYXRlbnQgaXNzdWUgYnV0IGhhc1xuICAgICAgLy8gc2hpcHBlZCB3aXRob3V0IGluY2lkZW50OyBjaGljYWdvIHBsYWNlcyBpdHNlbGYgY29ycmVjdGx5LlxuICAgICAgaWYgKFxuICAgICAgICBmZWF0dXJlKCdDSElDQUdPX01DUCcpICYmXG4gICAgICAgIGdldFBsYXRmb3JtKCkgPT09ICdtYWNvcycgJiZcbiAgICAgICAgIWdldElzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKClcbiAgICAgICkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHsgZ2V0Q2hpY2Fnb0VuYWJsZWQgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICdzcmMvdXRpbHMvY29tcHV0ZXJVc2UvZ2F0ZXMuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmIChnZXRDaGljYWdvRW5hYmxlZCgpKSB7XG4gICAgICAgICAgICBjb25zdCB7IHNldHVwQ29tcHV0ZXJVc2VNQ1AgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICAgJ3NyYy91dGlscy9jb21wdXRlclVzZS9zZXR1cC5qcydcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIGNvbnN0IHsgbWNwQ29uZmlnLCBhbGxvd2VkVG9vbHM6IGN1VG9vbHMgfSA9IHNldHVwQ29tcHV0ZXJVc2VNQ1AoKVxuICAgICAgICAgICAgZHluYW1pY01jcENvbmZpZyA9IHsgLi4uZHluYW1pY01jcENvbmZpZywgLi4ubWNwQ29uZmlnIH1cbiAgICAgICAgICAgIGFsbG93ZWRUb29scy5wdXNoKC4uLmN1VG9vbHMpXG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgIGBbQ29tcHV0ZXIgVXNlIE1DUF0gU2V0dXAgZmFpbGVkOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU3RvcmUgYWRkaXRpb25hbCBkaXJlY3RvcmllcyBmb3IgQ0xBVURFLm1kIGxvYWRpbmcgKGNvbnRyb2xsZWQgYnkgZW52IHZhcilcbiAgICAgIHNldEFkZGl0aW9uYWxEaXJlY3Rvcmllc0ZvckNsYXVkZU1kKGFkZERpcilcblxuICAgICAgLy8gQ2hhbm5lbCBzZXJ2ZXIgYWxsb3dsaXN0IGZyb20gLS1jaGFubmVscyBmbGFnIOKAlCBzZXJ2ZXJzIHdob3NlXG4gICAgICAvLyBpbmJvdW5kIHB1c2ggbm90aWZpY2F0aW9ucyBzaG91bGQgcmVnaXN0ZXIgdGhpcyBzZXNzaW9uLiBUaGUgb3B0aW9uXG4gICAgICAvLyBpcyBhZGRlZCBpbnNpZGUgYSBmZWF0dXJlKCkgYmxvY2sgc28gVFMgZG9lc24ndCBrbm93IGFib3V0IGl0XG4gICAgICAvLyBvbiB0aGUgb3B0aW9ucyB0eXBlIOKAlCBzYW1lIHBhdHRlcm4gYXMgLS1hc3Npc3RhbnQgYXQgbWFpbi50c3g6MTgyNC5cbiAgICAgIC8vIGRldkNoYW5uZWxzIGlzIGRlZmVycmVkOiBzaG93U2V0dXBTY3JlZW5zIHNob3dzIGEgY29uZmlybWF0aW9uIGRpYWxvZ1xuICAgICAgLy8gYW5kIG9ubHkgYXBwZW5kcyB0byBhbGxvd2VkQ2hhbm5lbHMgb24gYWNjZXB0LlxuICAgICAgbGV0IGRldkNoYW5uZWxzOiBDaGFubmVsRW50cnlbXSB8IHVuZGVmaW5lZFxuICAgICAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19DSEFOTkVMUycpKSB7XG4gICAgICAgIC8vIFBhcnNlIHBsdWdpbjpuYW1lQG1hcmtldHBsYWNlIC8gc2VydmVyOlkgdGFncyBpbnRvIHR5cGVkIGVudHJpZXMuXG4gICAgICAgIC8vIFRhZyBkZWNpZGVzIHRydXN0IG1vZGVsIGRvd25zdHJlYW06IHBsdWdpbi1raW5kIGhpdHMgbWFya2V0cGxhY2VcbiAgICAgICAgLy8gdmVyaWZpY2F0aW9uICsgR3Jvd3RoQm9vayBhbGxvd2xpc3QsIHNlcnZlci1raW5kIGFsd2F5cyBmYWlsc1xuICAgICAgICAvLyBhbGxvd2xpc3QgKHNjaGVtYSBpcyBwbHVnaW4tb25seSkgdW5sZXNzIGRldiBmbGFnIGlzIHNldC5cbiAgICAgICAgLy8gVW50YWdnZWQgb3IgbWFya2V0cGxhY2UtbGVzcyBwbHVnaW4gZW50cmllcyBhcmUgaGFyZCBlcnJvcnMg4oCUXG4gICAgICAgIC8vIHNpbGVudGx5IG5vdC1tYXRjaGluZyBpbiB0aGUgZ2F0ZSB3b3VsZCBsb29rIGxpa2UgY2hhbm5lbHMgYXJlXG4gICAgICAgIC8vIFwib25cIiBidXQgbm90aGluZyBldmVyIGZpcmVzLlxuICAgICAgICBjb25zdCBwYXJzZUNoYW5uZWxFbnRyaWVzID0gKFxuICAgICAgICAgIHJhdzogc3RyaW5nW10sXG4gICAgICAgICAgZmxhZzogc3RyaW5nLFxuICAgICAgICApOiBDaGFubmVsRW50cnlbXSA9PiB7XG4gICAgICAgICAgY29uc3QgZW50cmllczogQ2hhbm5lbEVudHJ5W10gPSBbXVxuICAgICAgICAgIGNvbnN0IGJhZDogc3RyaW5nW10gPSBbXVxuICAgICAgICAgIGZvciAoY29uc3QgYyBvZiByYXcpIHtcbiAgICAgICAgICAgIGlmIChjLnN0YXJ0c1dpdGgoJ3BsdWdpbjonKSkge1xuICAgICAgICAgICAgICBjb25zdCByZXN0ID0gYy5zbGljZSg3KVxuICAgICAgICAgICAgICBjb25zdCBhdCA9IHJlc3QuaW5kZXhPZignQCcpXG4gICAgICAgICAgICAgIGlmIChhdCA8PSAwIHx8IGF0ID09PSByZXN0Lmxlbmd0aCAtIDEpIHtcbiAgICAgICAgICAgICAgICBiYWQucHVzaChjKVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGVudHJpZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICBraW5kOiAncGx1Z2luJyxcbiAgICAgICAgICAgICAgICAgIG5hbWU6IHJlc3Quc2xpY2UoMCwgYXQpLFxuICAgICAgICAgICAgICAgICAgbWFya2V0cGxhY2U6IHJlc3Quc2xpY2UoYXQgKyAxKSxcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGMuc3RhcnRzV2l0aCgnc2VydmVyOicpICYmIGMubGVuZ3RoID4gNykge1xuICAgICAgICAgICAgICBlbnRyaWVzLnB1c2goeyBraW5kOiAnc2VydmVyJywgbmFtZTogYy5zbGljZSg3KSB9KVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgYmFkLnB1c2goYylcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGJhZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAgIGAke2ZsYWd9IGVudHJpZXMgbXVzdCBiZSB0YWdnZWQ6ICR7YmFkLmpvaW4oJywgJyl9XFxuYCArXG4gICAgICAgICAgICAgICAgICBgICBwbHVnaW46PG5hbWU+QDxtYXJrZXRwbGFjZT4gIOKAlCBwbHVnaW4tcHJvdmlkZWQgY2hhbm5lbCAoYWxsb3dsaXN0IGVuZm9yY2VkKVxcbmAgK1xuICAgICAgICAgICAgICAgICAgYCAgc2VydmVyOjxuYW1lPiAgICAgICAgICAgICAgICDigJQgbWFudWFsbHkgY29uZmlndXJlZCBNQ1Agc2VydmVyXFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gZW50cmllc1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY2hhbm5lbE9wdHMgPSBvcHRpb25zIGFzIHtcbiAgICAgICAgICBjaGFubmVscz86IHN0cmluZ1tdXG4gICAgICAgICAgZGFuZ2Vyb3VzbHlMb2FkRGV2ZWxvcG1lbnRDaGFubmVscz86IHN0cmluZ1tdXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3Q2hhbm5lbHMgPSBjaGFubmVsT3B0cy5jaGFubmVsc1xuICAgICAgICBjb25zdCByYXdEZXYgPSBjaGFubmVsT3B0cy5kYW5nZXJvdXNseUxvYWREZXZlbG9wbWVudENoYW5uZWxzXG4gICAgICAgIC8vIEFsd2F5cyBwYXJzZSArIHNldC4gQ2hhbm5lbHNOb3RpY2UgcmVhZHMgZ2V0QWxsb3dlZENoYW5uZWxzKCkgYW5kXG4gICAgICAgIC8vIHJlbmRlcnMgdGhlIGFwcHJvcHJpYXRlIGJyYW5jaCAoZGlzYWJsZWQvbm9BdXRoL3BvbGljeUJsb2NrZWQvXG4gICAgICAgIC8vIGxpc3RlbmluZykgaW4gdGhlIHN0YXJ0dXAgc2NyZWVuLiBnYXRlQ2hhbm5lbFNlcnZlcigpIGVuZm9yY2VzLlxuICAgICAgICAvLyAtLWNoYW5uZWxzIHdvcmtzIGluIGJvdGggaW50ZXJhY3RpdmUgYW5kIHByaW50L1NESyBtb2RlczsgZGV2LWNoYW5uZWxzXG4gICAgICAgIC8vIHN0YXlzIGludGVyYWN0aXZlLW9ubHkgKHJlcXVpcmVzIGEgY29uZmlybWF0aW9uIGRpYWxvZykuXG4gICAgICAgIGxldCBjaGFubmVsRW50cmllczogQ2hhbm5lbEVudHJ5W10gPSBbXVxuICAgICAgICBpZiAocmF3Q2hhbm5lbHMgJiYgcmF3Q2hhbm5lbHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNoYW5uZWxFbnRyaWVzID0gcGFyc2VDaGFubmVsRW50cmllcyhyYXdDaGFubmVscywgJy0tY2hhbm5lbHMnKVxuICAgICAgICAgIHNldEFsbG93ZWRDaGFubmVscyhjaGFubmVsRW50cmllcylcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgICAgaWYgKHJhd0RldiAmJiByYXdEZXYubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZGV2Q2hhbm5lbHMgPSBwYXJzZUNoYW5uZWxFbnRyaWVzKFxuICAgICAgICAgICAgICByYXdEZXYsXG4gICAgICAgICAgICAgICctLWRhbmdlcm91c2x5LWxvYWQtZGV2ZWxvcG1lbnQtY2hhbm5lbHMnLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyBGbGFnLXVzYWdlIHRlbGVtZXRyeS4gUGx1Z2luIGlkZW50aWZpZXJzIGFyZSBsb2dnZWQgKHNhbWUgdGllciBhc1xuICAgICAgICAvLyB0ZW5ndV9wbHVnaW5faW5zdGFsbGVkIOKAlCBwdWJsaWMtcmVnaXN0cnktc3R5bGUgbmFtZXMpOyBzZXJ2ZXIta2luZFxuICAgICAgICAvLyBuYW1lcyBhcmUgbm90IChNQ1Atc2VydmVyLW5hbWUgdGllciwgb3B0LWluLW9ubHkgZWxzZXdoZXJlKS5cbiAgICAgICAgLy8gUGVyLXNlcnZlciBnYXRlIG91dGNvbWVzIGxhbmQgaW4gdGVuZ3VfbWNwX2NoYW5uZWxfZ2F0ZSBvbmNlXG4gICAgICAgIC8vIHNlcnZlcnMgY29ubmVjdC4gRGV2IGVudHJpZXMgZ28gdGhyb3VnaCBhIGNvbmZpcm1hdGlvbiBkaWFsb2cgYWZ0ZXJcbiAgICAgICAgLy8gdGhpcyDigJQgZGV2X3BsdWdpbnMgY2FwdHVyZXMgd2hhdCB3YXMgdHlwZWQsIG5vdCB3aGF0IHdhcyBhY2NlcHRlZC5cbiAgICAgICAgaWYgKGNoYW5uZWxFbnRyaWVzLmxlbmd0aCA+IDAgfHwgKGRldkNoYW5uZWxzPy5sZW5ndGggPz8gMCkgPiAwKSB7XG4gICAgICAgICAgY29uc3Qgam9pblBsdWdpbklkcyA9IChlbnRyaWVzOiBDaGFubmVsRW50cnlbXSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgaWRzID0gZW50cmllcy5mbGF0TWFwKGUgPT5cbiAgICAgICAgICAgICAgZS5raW5kID09PSAncGx1Z2luJyA/IFtgJHtlLm5hbWV9QCR7ZS5tYXJrZXRwbGFjZX1gXSA6IFtdLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcmV0dXJuIGlkcy5sZW5ndGggPiAwXG4gICAgICAgICAgICAgID8gKGlkc1xuICAgICAgICAgICAgICAgICAgLnNvcnQoKVxuICAgICAgICAgICAgICAgICAgLmpvaW4oXG4gICAgICAgICAgICAgICAgICAgICcsJyxcbiAgICAgICAgICAgICAgICAgICkgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUylcbiAgICAgICAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgICAgICB9XG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X21jcF9jaGFubmVsX2ZsYWdzJywge1xuICAgICAgICAgICAgY2hhbm5lbHNfY291bnQ6IGNoYW5uZWxFbnRyaWVzLmxlbmd0aCxcbiAgICAgICAgICAgIGRldl9jb3VudDogZGV2Q2hhbm5lbHM/Lmxlbmd0aCA/PyAwLFxuICAgICAgICAgICAgcGx1Z2luczogam9pblBsdWdpbklkcyhjaGFubmVsRW50cmllcyksXG4gICAgICAgICAgICBkZXZfcGx1Z2luczogam9pblBsdWdpbklkcyhkZXZDaGFubmVscyA/PyBbXSksXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBTREsgb3B0LWluIGZvciBTZW5kVXNlck1lc3NhZ2UgdmlhIC0tdG9vbHMuIEFsbCBzZXNzaW9ucyByZXF1aXJlXG4gICAgICAvLyBleHBsaWNpdCBvcHQtaW47IGxpc3RpbmcgaXQgaW4gLS10b29scyBzaWduYWxzIGludGVudC4gUnVucyBCRUZPUkVcbiAgICAgIC8vIGluaXRpYWxpemVUb29sUGVybWlzc2lvbkNvbnRleHQgc28gZ2V0VG9vbHNGb3JEZWZhdWx0UHJlc2V0KCkgc2Vlc1xuICAgICAgLy8gdGhlIHRvb2wgYXMgZW5hYmxlZCB3aGVuIGNvbXB1dGluZyB0aGUgYmFzZS10b29scyBkaXNhbGxvdyBmaWx0ZXIuXG4gICAgICAvLyBDb25kaXRpb25hbCByZXF1aXJlIGF2b2lkcyBsZWFraW5nIHRoZSB0b29sLW5hbWUgc3RyaW5nIGludG9cbiAgICAgIC8vIGV4dGVybmFsIGJ1aWxkcy5cbiAgICAgIGlmIChcbiAgICAgICAgKGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19CUklFRicpKSAmJlxuICAgICAgICBiYXNlVG9vbHMubGVuZ3RoID4gMFxuICAgICAgKSB7XG4gICAgICAgIC8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbiAgICAgICAgY29uc3QgeyBCUklFRl9UT09MX05BTUUsIExFR0FDWV9CUklFRl9UT09MX05BTUUgfSA9XG4gICAgICAgICAgcmVxdWlyZSgnLi90b29scy9CcmllZlRvb2wvcHJvbXB0LmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi90b29scy9CcmllZlRvb2wvcHJvbXB0LmpzJylcbiAgICAgICAgY29uc3QgeyBpc0JyaWVmRW50aXRsZWQgfSA9XG4gICAgICAgICAgcmVxdWlyZSgnLi90b29scy9CcmllZlRvb2wvQnJpZWZUb29sLmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi90b29scy9CcmllZlRvb2wvQnJpZWZUb29sLmpzJylcbiAgICAgICAgLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVG9vbExpc3RGcm9tQ0xJKGJhc2VUb29scylcbiAgICAgICAgaWYgKFxuICAgICAgICAgIChwYXJzZWQuaW5jbHVkZXMoQlJJRUZfVE9PTF9OQU1FKSB8fFxuICAgICAgICAgICAgcGFyc2VkLmluY2x1ZGVzKExFR0FDWV9CUklFRl9UT09MX05BTUUpKSAmJlxuICAgICAgICAgIGlzQnJpZWZFbnRpdGxlZCgpXG4gICAgICAgICkge1xuICAgICAgICAgIHNldFVzZXJNc2dPcHRJbih0cnVlKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRoaXMgYXdhaXQgcmVwbGFjZXMgYmxvY2tpbmcgZXhpc3RzU3luYy9zdGF0U3luYyBjYWxscyB0aGF0IHdlcmUgYWxyZWFkeSBpblxuICAgICAgLy8gdGhlIHN0YXJ0dXAgcGF0aC4gV2FsbC1jbG9jayB0aW1lIGlzIHVuY2hhbmdlZDsgd2UganVzdCB5aWVsZCB0byB0aGUgZXZlbnRcbiAgICAgIC8vIGxvb3AgZHVyaW5nIHRoZSBmcyBJL08gaW5zdGVhZCBvZiBibG9ja2luZyBpdC4gU2VlICMxOTY2MS5cbiAgICAgIGNvbnN0IGluaXRSZXN1bHQgPSBhd2FpdCBpbml0aWFsaXplVG9vbFBlcm1pc3Npb25Db250ZXh0KHtcbiAgICAgICAgYWxsb3dlZFRvb2xzQ2xpOiBhbGxvd2VkVG9vbHMsXG4gICAgICAgIGRpc2FsbG93ZWRUb29sc0NsaTogZGlzYWxsb3dlZFRvb2xzLFxuICAgICAgICBiYXNlVG9vbHNDbGk6IGJhc2VUb29scyxcbiAgICAgICAgcGVybWlzc2lvbk1vZGUsXG4gICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgIGFkZERpcnM6IGFkZERpcixcbiAgICAgIH0pXG4gICAgICBsZXQgdG9vbFBlcm1pc3Npb25Db250ZXh0ID0gaW5pdFJlc3VsdC50b29sUGVybWlzc2lvbkNvbnRleHRcbiAgICAgIGNvbnN0IHsgd2FybmluZ3MsIGRhbmdlcm91c1Blcm1pc3Npb25zLCBvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucyB9ID1cbiAgICAgICAgaW5pdFJlc3VsdFxuXG4gICAgICAvLyBIYW5kbGUgb3Zlcmx5IGJyb2FkIHNoZWxsIGFsbG93IHJ1bGVzIGZvciBhbnQgdXNlcnMgKEJhc2goKiksIFBvd2VyU2hlbGwoKikpXG4gICAgICBpZiAoXG4gICAgICAgIFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcgJiZcbiAgICAgICAgb3Zlcmx5QnJvYWRCYXNoUGVybWlzc2lvbnMubGVuZ3RoID4gMFxuICAgICAgKSB7XG4gICAgICAgIGZvciAoY29uc3QgcGVybWlzc2lvbiBvZiBvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucykge1xuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgIGBJZ25vcmluZyBvdmVybHkgYnJvYWQgc2hlbGwgcGVybWlzc2lvbiAke3Blcm1pc3Npb24ucnVsZURpc3BsYXl9IGZyb20gJHtwZXJtaXNzaW9uLnNvdXJjZURpc3BsYXl9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgdG9vbFBlcm1pc3Npb25Db250ZXh0ID0gcmVtb3ZlRGFuZ2Vyb3VzUGVybWlzc2lvbnMoXG4gICAgICAgICAgdG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICAgICAgICAgIG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIGlmIChmZWF0dXJlKCdUUkFOU0NSSVBUX0NMQVNTSUZJRVInKSAmJiBkYW5nZXJvdXNQZXJtaXNzaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRvb2xQZXJtaXNzaW9uQ29udGV4dCA9IHN0cmlwRGFuZ2Vyb3VzUGVybWlzc2lvbnNGb3JBdXRvTW9kZShcbiAgICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQsXG4gICAgICAgIClcbiAgICAgIH1cblxuICAgICAgLy8gUHJpbnQgYW55IHdhcm5pbmdzIGZyb20gaW5pdGlhbGl6YXRpb25cbiAgICAgIHdhcm5pbmdzLmZvckVhY2god2FybmluZyA9PiB7XG4gICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgY29uc29sZS5lcnJvcih3YXJuaW5nKVxuICAgICAgfSlcblxuICAgICAgdm9pZCBhc3NlcnRNaW5WZXJzaW9uKClcblxuICAgICAgLy8gY2xhdWRlLmFpIGNvbmZpZyBmZXRjaDogLXAgbW9kZSBvbmx5IChpbnRlcmFjdGl2ZSB1c2VzIHVzZU1hbmFnZU1DUENvbm5lY3Rpb25zXG4gICAgICAvLyB0d28tcGhhc2UgbG9hZGluZykuIEtpY2tlZCBvZmYgaGVyZSB0byBvdmVybGFwIHdpdGggc2V0dXAoKTsgYXdhaXRlZFxuICAgICAgLy8gYmVmb3JlIHJ1bkhlYWRsZXNzIHNvIHNpbmdsZS10dXJuIC1wIHNlZXMgY29ubmVjdG9ycy4gU2tpcHBlZCB1bmRlclxuICAgICAgLy8gZW50ZXJwcmlzZS9zdHJpY3QgTUNQIHRvIHByZXNlcnZlIHBvbGljeSBib3VuZGFyaWVzLlxuICAgICAgY29uc3QgY2xhdWRlYWlDb25maWdQcm9taXNlOiBQcm9taXNlPFxuICAgICAgICBSZWNvcmQ8c3RyaW5nLCBTY29wZWRNY3BTZXJ2ZXJDb25maWc+XG4gICAgICA+ID1cbiAgICAgICAgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gJiZcbiAgICAgICAgIXN0cmljdE1jcENvbmZpZyAmJlxuICAgICAgICAhZG9lc0VudGVycHJpc2VNY3BDb25maWdFeGlzdCgpICYmXG4gICAgICAgIC8vIC0tYmFyZSAvIFNJTVBMRTogc2tpcCBjbGF1ZGUuYWkgcHJveHkgc2VydmVycyAoZGF0YWRvZywgR21haWwsXG4gICAgICAgIC8vIFNsYWNrLCBCaWdRdWVyeSwgUHViTWVkIOKAlCA2LTE0cyBlYWNoIHRvIGNvbm5lY3QpLiBTY3JpcHRlZCBjYWxsc1xuICAgICAgICAvLyB0aGF0IG5lZWQgTUNQIHBhc3MgLS1tY3AtY29uZmlnIGV4cGxpY2l0bHkuXG4gICAgICAgICFpc0JhcmVNb2RlKClcbiAgICAgICAgICA/IGZldGNoQ2xhdWRlQUlNY3BDb25maWdzSWZFbGlnaWJsZSgpLnRoZW4oY29uZmlncyA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHsgYWxsb3dlZCwgYmxvY2tlZCB9ID0gZmlsdGVyTWNwU2VydmVyc0J5UG9saWN5KGNvbmZpZ3MpXG4gICAgICAgICAgICAgIGlmIChibG9ja2VkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgICAgIGBXYXJuaW5nOiBjbGF1ZGUuYWkgTUNQICR7cGx1cmFsKGJsb2NrZWQubGVuZ3RoLCAnc2VydmVyJyl9IGJsb2NrZWQgYnkgZW50ZXJwcmlzZSBwb2xpY3k6ICR7YmxvY2tlZC5qb2luKCcsICcpfVxcbmAsXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBhbGxvd2VkXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIDogUHJvbWlzZS5yZXNvbHZlKHt9KVxuXG4gICAgICAvLyBLaWNrIG9mZiBNQ1AgY29uZmlnIGxvYWRpbmcgZWFybHkgKHNhZmUgLSBqdXN0IHJlYWRzIGZpbGVzLCBubyBleGVjdXRpb24pLlxuICAgICAgLy8gQm90aCBpbnRlcmFjdGl2ZSBhbmQgLXAgdXNlIGdldENsYXVkZUNvZGVNY3BDb25maWdzIChsb2NhbCBmaWxlIHJlYWRzIG9ubHkpLlxuICAgICAgLy8gVGhlIGxvY2FsIHByb21pc2UgaXMgYXdhaXRlZCBsYXRlciAoYmVmb3JlIHByZWZldGNoQWxsTWNwUmVzb3VyY2VzKSB0b1xuICAgICAgLy8gb3ZlcmxhcCBjb25maWcgSS9PIHdpdGggc2V0dXAoKSwgY29tbWFuZHMgbG9hZGluZywgYW5kIHRydXN0IGRpYWxvZy5cbiAgICAgIGxvZ0ZvckRlYnVnZ2luZygnW1NUQVJUVVBdIExvYWRpbmcgTUNQIGNvbmZpZ3MuLi4nKVxuICAgICAgY29uc3QgbWNwQ29uZmlnU3RhcnQgPSBEYXRlLm5vdygpXG4gICAgICBsZXQgbWNwQ29uZmlnUmVzb2x2ZWRNczogbnVtYmVyIHwgdW5kZWZpbmVkXG4gICAgICAvLyAtLWJhcmUgc2tpcHMgYXV0by1kaXNjb3ZlcmVkIE1DUCAoLm1jcC5qc29uLCB1c2VyIHNldHRpbmdzLCBwbHVnaW5zKSDigJRcbiAgICAgIC8vIG9ubHkgZXhwbGljaXQgLS1tY3AtY29uZmlnIHdvcmtzLiBkeW5hbWljTWNwQ29uZmlnIGlzIHNwcmVhZCBvbnRvXG4gICAgICAvLyBhbGxNY3BDb25maWdzIGRvd25zdHJlYW0gc28gaXQgc3Vydml2ZXMgdGhpcyBza2lwLlxuICAgICAgY29uc3QgbWNwQ29uZmlnUHJvbWlzZSA9IChcbiAgICAgICAgc3RyaWN0TWNwQ29uZmlnIHx8IGlzQmFyZU1vZGUoKVxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKHtcbiAgICAgICAgICAgICAgc2VydmVyczoge30gYXMgUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPixcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgOiBnZXRDbGF1ZGVDb2RlTWNwQ29uZmlncyhkeW5hbWljTWNwQ29uZmlnKVxuICAgICAgKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIG1jcENvbmZpZ1Jlc29sdmVkTXMgPSBEYXRlLm5vdygpIC0gbWNwQ29uZmlnU3RhcnRcbiAgICAgICAgcmV0dXJuIHJlc3VsdFxuICAgICAgfSlcblxuICAgICAgLy8gTk9URTogV2UgZG8gTk9UIGNhbGwgcHJlZmV0Y2hBbGxNY3BSZXNvdXJjZXMgaGVyZSAtIHRoYXQncyBkZWZlcnJlZCB1bnRpbCBhZnRlciB0cnVzdCBkaWFsb2dcblxuICAgICAgaWYgKFxuICAgICAgICBpbnB1dEZvcm1hdCAmJlxuICAgICAgICBpbnB1dEZvcm1hdCAhPT0gJ3RleHQnICYmXG4gICAgICAgIGlucHV0Rm9ybWF0ICE9PSAnc3RyZWFtLWpzb24nXG4gICAgICApIHtcbiAgICAgICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3VzcGljaW91cy9ub0NvbnNvbGU6OiBpbnRlbnRpb25hbCBjb25zb2xlIG91dHB1dFxuICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvcjogSW52YWxpZCBpbnB1dCBmb3JtYXQgXCIke2lucHV0Rm9ybWF0fVwiLmApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfVxuICAgICAgaWYgKGlucHV0Rm9ybWF0ID09PSAnc3RyZWFtLWpzb24nICYmIG91dHB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJykge1xuICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgYEVycm9yOiAtLWlucHV0LWZvcm1hdD1zdHJlYW0tanNvbiByZXF1aXJlcyBvdXRwdXQtZm9ybWF0PXN0cmVhbS1qc29uLmAsXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIHNka1VybCBpcyBvbmx5IHVzZWQgd2l0aCBhcHByb3ByaWF0ZSBmb3JtYXRzIChmb3JtYXRzIGFyZSBhdXRvLXNldCBhYm92ZSlcbiAgICAgIGlmIChzZGtVcmwpIHtcbiAgICAgICAgaWYgKGlucHV0Rm9ybWF0ICE9PSAnc3RyZWFtLWpzb24nIHx8IG91dHB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJykge1xuICAgICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgYEVycm9yOiAtLXNkay11cmwgcmVxdWlyZXMgYm90aCAtLWlucHV0LWZvcm1hdD1zdHJlYW0tanNvbiBhbmQgLS1vdXRwdXQtZm9ybWF0PXN0cmVhbS1qc29uLmAsXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIHJlcGxheVVzZXJNZXNzYWdlcyBpcyBvbmx5IHVzZWQgd2l0aCBzdHJlYW0tanNvbiBmb3JtYXRzXG4gICAgICBpZiAob3B0aW9ucy5yZXBsYXlVc2VyTWVzc2FnZXMpIHtcbiAgICAgICAgaWYgKGlucHV0Rm9ybWF0ICE9PSAnc3RyZWFtLWpzb24nIHx8IG91dHB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJykge1xuICAgICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgYEVycm9yOiAtLXJlcGxheS11c2VyLW1lc3NhZ2VzIHJlcXVpcmVzIGJvdGggLS1pbnB1dC1mb3JtYXQ9c3RyZWFtLWpzb24gYW5kIC0tb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbi5gLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBpbmNsdWRlUGFydGlhbE1lc3NhZ2VzIGlzIG9ubHkgdXNlZCB3aXRoIHByaW50IG1vZGUgYW5kIHN0cmVhbS1qc29uIG91dHB1dFxuICAgICAgaWYgKGVmZmVjdGl2ZUluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMpIHtcbiAgICAgICAgaWYgKCFpc05vbkludGVyYWN0aXZlU2Vzc2lvbiB8fCBvdXRwdXRGb3JtYXQgIT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgICAgICB3cml0ZVRvU3RkZXJyKFxuICAgICAgICAgICAgYEVycm9yOiAtLWluY2x1ZGUtcGFydGlhbC1tZXNzYWdlcyByZXF1aXJlcyAtLXByaW50IGFuZCAtLW91dHB1dC1mb3JtYXQ9c3RyZWFtLWpzb24uYCxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgLS1uby1zZXNzaW9uLXBlcnNpc3RlbmNlIGlzIG9ubHkgdXNlZCB3aXRoIHByaW50IG1vZGVcbiAgICAgIGlmIChvcHRpb25zLnNlc3Npb25QZXJzaXN0ZW5jZSA9PT0gZmFsc2UgJiYgIWlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgIHdyaXRlVG9TdGRlcnIoXG4gICAgICAgICAgYEVycm9yOiAtLW5vLXNlc3Npb24tcGVyc2lzdGVuY2UgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIC0tcHJpbnQgbW9kZS5gLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfVxuXG4gICAgICBjb25zdCBlZmZlY3RpdmVQcm9tcHQgPSBwcm9tcHQgfHwgJydcbiAgICAgIGxldCBpbnB1dFByb21wdCA9IGF3YWl0IGdldElucHV0UHJvbXB0KFxuICAgICAgICBlZmZlY3RpdmVQcm9tcHQsXG4gICAgICAgIChpbnB1dEZvcm1hdCA/PyAndGV4dCcpIGFzICd0ZXh0JyB8ICdzdHJlYW0tanNvbicsXG4gICAgICApXG4gICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2FmdGVyX2lucHV0X3Byb21wdCcpXG5cbiAgICAgIC8vIEFjdGl2YXRlIHByb2FjdGl2ZSBtb2RlIEJFRk9SRSBnZXRUb29scygpIHNvIFNsZWVwVG9vbC5pc0VuYWJsZWQoKVxuICAgICAgLy8gKHdoaWNoIHJldHVybnMgaXNQcm9hY3RpdmVBY3RpdmUoKSkgcGFzc2VzIGFuZCBTbGVlcCBpcyBpbmNsdWRlZC5cbiAgICAgIC8vIFRoZSBsYXRlciBSRVBMLXBhdGggbWF5YmVBY3RpdmF0ZVByb2FjdGl2ZSgpIGNhbGxzIGFyZSBpZGVtcG90ZW50LlxuICAgICAgbWF5YmVBY3RpdmF0ZVByb2FjdGl2ZShvcHRpb25zKVxuXG4gICAgICBsZXQgdG9vbHMgPSBnZXRUb29scyh0b29sUGVybWlzc2lvbkNvbnRleHQpXG5cbiAgICAgIC8vIEFwcGx5IGNvb3JkaW5hdG9yIG1vZGUgdG9vbCBmaWx0ZXJpbmcgZm9yIGhlYWRsZXNzIHBhdGhcbiAgICAgIC8vIChtaXJyb3JzIHVzZU1lcmdlZFRvb2xzLnRzIGZpbHRlcmluZyBmb3IgUkVQTC9pbnRlcmFjdGl2ZSBwYXRoKVxuICAgICAgaWYgKFxuICAgICAgICBmZWF0dXJlKCdDT09SRElOQVRPUl9NT0RFJykgJiZcbiAgICAgICAgaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfQ09PUkRJTkFUT1JfTU9ERSlcbiAgICAgICkge1xuICAgICAgICBjb25zdCB7IGFwcGx5Q29vcmRpbmF0b3JUb29sRmlsdGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vdXRpbHMvdG9vbFBvb2wuanMnXG4gICAgICAgIClcbiAgICAgICAgdG9vbHMgPSBhcHBseUNvb3JkaW5hdG9yVG9vbEZpbHRlcih0b29scylcbiAgICAgIH1cblxuICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl90b29sc19sb2FkZWQnKVxuXG4gICAgICBsZXQganNvblNjaGVtYTogVG9vbElucHV0SlNPTlNjaGVtYSB8IHVuZGVmaW5lZFxuICAgICAgaWYgKFxuICAgICAgICBpc1N5bnRoZXRpY091dHB1dFRvb2xFbmFibGVkKHsgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gfSkgJiZcbiAgICAgICAgb3B0aW9ucy5qc29uU2NoZW1hXG4gICAgICApIHtcbiAgICAgICAganNvblNjaGVtYSA9IGpzb25QYXJzZShvcHRpb25zLmpzb25TY2hlbWEpIGFzIFRvb2xJbnB1dEpTT05TY2hlbWFcbiAgICAgIH1cblxuICAgICAgaWYgKGpzb25TY2hlbWEpIHtcbiAgICAgICAgY29uc3Qgc3ludGhldGljT3V0cHV0UmVzdWx0ID0gY3JlYXRlU3ludGhldGljT3V0cHV0VG9vbChqc29uU2NoZW1hKVxuICAgICAgICBpZiAoJ3Rvb2wnIGluIHN5bnRoZXRpY091dHB1dFJlc3VsdCkge1xuICAgICAgICAgIC8vIEFkZCBTeW50aGV0aWNPdXRwdXRUb29sIHRvIHRoZSB0b29scyBhcnJheSBBRlRFUiBnZXRUb29scygpIGZpbHRlcmluZy5cbiAgICAgICAgICAvLyBUaGlzIHRvb2wgaXMgZXhjbHVkZWQgZnJvbSBub3JtYWwgZmlsdGVyaW5nIChzZWUgdG9vbHMudHMpIGJlY2F1c2UgaXQnc1xuICAgICAgICAgIC8vIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbCBmb3Igc3RydWN0dXJlZCBvdXRwdXQsIG5vdCBhIHVzZXItY29udHJvbGxlZCB0b29sLlxuICAgICAgICAgIHRvb2xzID0gWy4uLnRvb2xzLCBzeW50aGV0aWNPdXRwdXRSZXN1bHQudG9vbF1cblxuICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zdHJ1Y3R1cmVkX291dHB1dF9lbmFibGVkJywge1xuICAgICAgICAgICAgc2NoZW1hX3Byb3BlcnR5X2NvdW50OiBPYmplY3Qua2V5cyhcbiAgICAgICAgICAgICAgKGpzb25TY2hlbWEucHJvcGVydGllcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgfHwge30sXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAgIC5sZW5ndGggYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgIGhhc19yZXF1aXJlZF9maWVsZHM6IEJvb2xlYW4oXG4gICAgICAgICAgICAgIGpzb25TY2hlbWEucmVxdWlyZWQsXG4gICAgICAgICAgICApIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgfSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc3RydWN0dXJlZF9vdXRwdXRfZmFpbHVyZScsIHtcbiAgICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgICAnSW52YWxpZCBKU09OIHNjaGVtYScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIElNUE9SVEFOVDogc2V0dXAoKSBtdXN0IGJlIGNhbGxlZCBiZWZvcmUgYW55IG90aGVyIGNvZGUgdGhhdCBkZXBlbmRzIG9uIHRoZSBjd2Qgb3Igd29ya3RyZWUgc2V0dXBcbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25fYmVmb3JlX3NldHVwJylcbiAgICAgIGxvZ0ZvckRlYnVnZ2luZygnW1NUQVJUVVBdIFJ1bm5pbmcgc2V0dXAoKS4uLicpXG4gICAgICBjb25zdCBzZXR1cFN0YXJ0ID0gRGF0ZS5ub3coKVxuICAgICAgY29uc3QgeyBzZXR1cCB9ID0gYXdhaXQgaW1wb3J0KCcuL3NldHVwLmpzJylcbiAgICAgIGNvbnN0IG1lc3NhZ2luZ1NvY2tldFBhdGggPSBmZWF0dXJlKCdVRFNfSU5CT1gnKVxuICAgICAgICA/IChvcHRpb25zIGFzIHsgbWVzc2FnaW5nU29ja2V0UGF0aD86IHN0cmluZyB9KS5tZXNzYWdpbmdTb2NrZXRQYXRoXG4gICAgICAgIDogdW5kZWZpbmVkXG4gICAgICAvLyBQYXJhbGxlbGl6ZSBzZXR1cCgpIHdpdGggY29tbWFuZHMrYWdlbnRzIGxvYWRpbmcuIHNldHVwKCkncyB+MjhtcyBpc1xuICAgICAgLy8gbW9zdGx5IHN0YXJ0VWRzTWVzc2FnaW5nIChzb2NrZXQgYmluZCwgfjIwbXMpIOKAlCBub3QgZGlzay1ib3VuZCwgc28gaXRcbiAgICAgIC8vIGRvZXNuJ3QgY29udGVuZCB3aXRoIGdldENvbW1hbmRzJyBmaWxlIHJlYWRzLiBHYXRlZCBvbiAhd29ya3RyZWVFbmFibGVkXG4gICAgICAvLyBzaW5jZSAtLXdvcmt0cmVlIG1ha2VzIHNldHVwKCkgcHJvY2Vzcy5jaGRpcigpIChzZXR1cC50czoyMDMpLCBhbmRcbiAgICAgIC8vIGNvbW1hbmRzL2FnZW50cyBuZWVkIHRoZSBwb3N0LWNoZGlyIGN3ZC5cbiAgICAgIGNvbnN0IHByZVNldHVwQ3dkID0gZ2V0Q3dkKClcbiAgICAgIC8vIFJlZ2lzdGVyIGJ1bmRsZWQgc2tpbGxzL3BsdWdpbnMgYmVmb3JlIGtpY2tpbmcgZ2V0Q29tbWFuZHMoKSDigJQgdGhleSdyZVxuICAgICAgLy8gcHVyZSBpbi1tZW1vcnkgYXJyYXkgcHVzaGVzICg8MW1zLCB6ZXJvIEkvTykgdGhhdCBnZXRCdW5kbGVkU2tpbGxzKClcbiAgICAgIC8vIHJlYWRzIHN5bmNocm9ub3VzbHkuIFByZXZpb3VzbHkgcmFuIGluc2lkZSBzZXR1cCgpIGFmdGVyIH4yMG1zIG9mXG4gICAgICAvLyBhd2FpdCBwb2ludHMsIHNvIHRoZSBwYXJhbGxlbCBnZXRDb21tYW5kcygpIG1lbW9pemVkIGFuIGVtcHR5IGxpc3QuXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCAhPT0gJ2xvY2FsLWFnZW50Jykge1xuICAgICAgICBpbml0QnVpbHRpblBsdWdpbnMoKVxuICAgICAgICBpbml0QnVuZGxlZFNraWxscygpXG4gICAgICB9XG4gICAgICBjb25zdCBzZXR1cFByb21pc2UgPSBzZXR1cChcbiAgICAgICAgcHJlU2V0dXBDd2QsXG4gICAgICAgIHBlcm1pc3Npb25Nb2RlLFxuICAgICAgICBhbGxvd0Rhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICB3b3JrdHJlZUVuYWJsZWQsXG4gICAgICAgIHdvcmt0cmVlTmFtZSxcbiAgICAgICAgdG11eEVuYWJsZWQsXG4gICAgICAgIHNlc3Npb25JZCA/IHZhbGlkYXRlVXVpZChzZXNzaW9uSWQpIDogdW5kZWZpbmVkLFxuICAgICAgICB3b3JrdHJlZVBSTnVtYmVyLFxuICAgICAgICBtZXNzYWdpbmdTb2NrZXRQYXRoLFxuICAgICAgKVxuICAgICAgY29uc3QgY29tbWFuZHNQcm9taXNlID0gd29ya3RyZWVFbmFibGVkID8gbnVsbCA6IGdldENvbW1hbmRzKHByZVNldHVwQ3dkKVxuICAgICAgY29uc3QgYWdlbnREZWZzUHJvbWlzZSA9IHdvcmt0cmVlRW5hYmxlZFxuICAgICAgICA/IG51bGxcbiAgICAgICAgOiBnZXRBZ2VudERlZmluaXRpb25zV2l0aE92ZXJyaWRlcyhwcmVTZXR1cEN3ZClcbiAgICAgIC8vIFN1cHByZXNzIHRyYW5zaWVudCB1bmhhbmRsZWRSZWplY3Rpb24gaWYgdGhlc2UgcmVqZWN0IGR1cmluZyB0aGVcbiAgICAgIC8vIH4yOG1zIHNldHVwUHJvbWlzZSBhd2FpdCBiZWZvcmUgUHJvbWlzZS5hbGwgam9pbnMgdGhlbSBiZWxvdy5cbiAgICAgIGNvbW1hbmRzUHJvbWlzZT8uY2F0Y2goKCkgPT4ge30pXG4gICAgICBhZ2VudERlZnNQcm9taXNlPy5jYXRjaCgoKSA9PiB7fSlcbiAgICAgIGF3YWl0IHNldHVwUHJvbWlzZVxuICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICBgW1NUQVJUVVBdIHNldHVwKCkgY29tcGxldGVkIGluICR7RGF0ZS5ub3coKSAtIHNldHVwU3RhcnR9bXNgLFxuICAgICAgKVxuICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl9hZnRlcl9zZXR1cCcpXG5cbiAgICAgIC8vIFJlcGxheSB1c2VyIG1lc3NhZ2VzIGludG8gc3RyZWFtLWpzb24gb25seSB3aGVuIHRoZSBzb2NrZXQgd2FzXG4gICAgICAvLyBleHBsaWNpdGx5IHJlcXVlc3RlZC4gVGhlIGF1dG8tZ2VuZXJhdGVkIHNvY2tldCBpcyBwYXNzaXZlIOKAlCBpdFxuICAgICAgLy8gbGV0cyB0b29scyBpbmplY3QgaWYgdGhleSB3YW50IHRvLCBidXQgdHVybmluZyBpdCBvbiBieSBkZWZhdWx0XG4gICAgICAvLyBzaG91bGRuJ3QgcmVzaGFwZSBzdHJlYW0tanNvbiBmb3IgU0RLIGNvbnN1bWVycyB3aG8gbmV2ZXIgdG91Y2ggaXQuXG4gICAgICAvLyBDYWxsZXJzIHdobyBpbmplY3QgYW5kIGFsc28gd2FudCB0aG9zZSBpbmplY3Rpb25zIHZpc2libGUgaW4gdGhlXG4gICAgICAvLyBzdHJlYW0gcGFzcyAtLW1lc3NhZ2luZy1zb2NrZXQtcGF0aCBleHBsaWNpdGx5IChvciAtLXJlcGxheS11c2VyLW1lc3NhZ2VzKS5cbiAgICAgIGxldCBlZmZlY3RpdmVSZXBsYXlVc2VyTWVzc2FnZXMgPSAhIW9wdGlvbnMucmVwbGF5VXNlck1lc3NhZ2VzXG4gICAgICBpZiAoZmVhdHVyZSgnVURTX0lOQk9YJykpIHtcbiAgICAgICAgaWYgKCFlZmZlY3RpdmVSZXBsYXlVc2VyTWVzc2FnZXMgJiYgb3V0cHV0Rm9ybWF0ID09PSAnc3RyZWFtLWpzb24nKSB7XG4gICAgICAgICAgZWZmZWN0aXZlUmVwbGF5VXNlck1lc3NhZ2VzID0gISEoXG4gICAgICAgICAgICBvcHRpb25zIGFzIHsgbWVzc2FnaW5nU29ja2V0UGF0aD86IHN0cmluZyB9XG4gICAgICAgICAgKS5tZXNzYWdpbmdTb2NrZXRQYXRoXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGdldElzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKCkpIHtcbiAgICAgICAgLy8gQXBwbHkgZnVsbCBtZXJnZWQgc2V0dGluZ3MgZW52IG5vdyAoaW5jbHVkaW5nIHByb2plY3Qtc2NvcGVkXG4gICAgICAgIC8vIC5jbGF1ZGUvc2V0dGluZ3MuanNvbiBQQVRIL0dJVF9ESVIvR0lUX1dPUktfVFJFRSkgc28gZ2l0RXhlKCkgYW5kXG4gICAgICAgIC8vIHRoZSBnaXQgc3Bhd24gYmVsb3cgc2VlIGl0LiBUcnVzdCBpcyBpbXBsaWNpdCBpbiAtcCBtb2RlOyB0aGVcbiAgICAgICAgLy8gZG9jc3RyaW5nIGF0IG1hbmFnZWRFbnYudHM6OTYtOTcgc2F5cyB0aGlzIGFwcGxpZXMgXCJwb3RlbnRpYWxseVxuICAgICAgICAvLyBkYW5nZXJvdXMgZW52aXJvbm1lbnQgdmFyaWFibGVzIHN1Y2ggYXMgTERfUFJFTE9BRCwgUEFUSFwiIGZyb20gYWxsXG4gICAgICAgIC8vIHNvdXJjZXMuIFRoZSBsYXRlciBjYWxsIGluIHRoZSBpc05vbkludGVyYWN0aXZlU2Vzc2lvbiBibG9jayBiZWxvd1xuICAgICAgICAvLyBpcyBpZGVtcG90ZW50IChPYmplY3QuYXNzaWduLCBjb25maWd1cmVHbG9iYWxBZ2VudHMgZWplY3RzIHByaW9yXG4gICAgICAgIC8vIGludGVyY2VwdG9yKSBhbmQgcGlja3MgdXAgYW55IHBsdWdpbi1jb250cmlidXRlZCBlbnYgYWZ0ZXIgcGx1Z2luXG4gICAgICAgIC8vIGluaXQuIFByb2plY3Qgc2V0dGluZ3MgYXJlIGFscmVhZHkgbG9hZGVkIGhlcmU6XG4gICAgICAgIC8vIGFwcGx5U2FmZUNvbmZpZ0Vudmlyb25tZW50VmFyaWFibGVzIGluIGluaXQoKSBjYWxsZWRcbiAgICAgICAgLy8gZ2V0U2V0dGluZ3NfREVQUkVDQVRFRCBhdCBtYW5hZ2VkRW52LnRzOjg2IHdoaWNoIG1lcmdlcyBhbGwgZW5hYmxlZFxuICAgICAgICAvLyBzb3VyY2VzIGluY2x1ZGluZyBwcm9qZWN0U2V0dGluZ3MvbG9jYWxTZXR0aW5ncy5cbiAgICAgICAgYXBwbHlDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcygpXG5cbiAgICAgICAgLy8gU3Bhd24gZ2l0IHN0YXR1cy9sb2cvYnJhbmNoIG5vdyBzbyB0aGUgc3VicHJvY2VzcyBleGVjdXRpb24gb3ZlcmxhcHNcbiAgICAgICAgLy8gd2l0aCB0aGUgZ2V0Q29tbWFuZHMgYXdhaXQgYmVsb3cgYW5kIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzLiBBZnRlclxuICAgICAgICAvLyBzZXR1cCgpIHNvIGN3ZCBpcyBmaW5hbCAoc2V0dXAudHM6MjU0IG1heSBwcm9jZXNzLmNoZGlyKHdvcmt0cmVlUGF0aClcbiAgICAgICAgLy8gZm9yIC0td29ya3RyZWUpIGFuZCBhZnRlciB0aGUgYXBwbHlDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcyBhYm92ZVxuICAgICAgICAvLyBzbyBQQVRIL0dJVF9ESVIvR0lUX1dPUktfVFJFRSBmcm9tIGFsbCBzb3VyY2VzICh0cnVzdGVkICsgcHJvamVjdClcbiAgICAgICAgLy8gYXJlIGFwcGxpZWQuIGdldFN5c3RlbUNvbnRleHQgaXMgbWVtb2l6ZWQ7IHRoZVxuICAgICAgICAvLyBwcmVmZXRjaFN5c3RlbUNvbnRleHRJZlNhZmUgY2FsbCBpbiBzdGFydERlZmVycmVkUHJlZmV0Y2hlcyBiZWNvbWVzXG4gICAgICAgIC8vIGEgY2FjaGUgaGl0LiBUaGUgbWljcm90YXNrIGZyb20gYXdhaXQgZ2V0SXNHaXQoKSBkcmFpbnMgYXQgdGhlXG4gICAgICAgIC8vIGdldENvbW1hbmRzIFByb21pc2UuYWxsIGF3YWl0IGJlbG93LiBUcnVzdCBpcyBpbXBsaWNpdCBpbiAtcCBtb2RlXG4gICAgICAgIC8vIChzYW1lIGdhdGUgYXMgcHJlZmV0Y2hTeXN0ZW1Db250ZXh0SWZTYWZlKS5cbiAgICAgICAgdm9pZCBnZXRTeXN0ZW1Db250ZXh0KClcbiAgICAgICAgLy8gS2ljayBnZXRVc2VyQ29udGV4dCBub3cgdG9vIOKAlCBpdHMgZmlyc3QgYXdhaXQgKGZzLnJlYWRGaWxlIGluXG4gICAgICAgIC8vIGdldE1lbW9yeUZpbGVzKSB5aWVsZHMgbmF0dXJhbGx5LCBzbyB0aGUgQ0xBVURFLm1kIGRpcmVjdG9yeSB3YWxrXG4gICAgICAgIC8vIHJ1bnMgZHVyaW5nIHRoZSB+MjgwbXMgb3ZlcmxhcCB3aW5kb3cgYmVmb3JlIHRoZSBjb250ZXh0XG4gICAgICAgIC8vIFByb21pc2UuYWxsIGpvaW4gaW4gcHJpbnQudHMuIFRoZSB2b2lkIGdldFVzZXJDb250ZXh0KCkgaW5cbiAgICAgICAgLy8gc3RhcnREZWZlcnJlZFByZWZldGNoZXMgYmVjb21lcyBhIG1lbW9pemUgY2FjaGUtaGl0LlxuICAgICAgICB2b2lkIGdldFVzZXJDb250ZXh0KClcbiAgICAgICAgLy8gS2ljayBlbnN1cmVNb2RlbFN0cmluZ3NJbml0aWFsaXplZCBub3cg4oCUIGZvciBCZWRyb2NrIHRoaXMgdHJpZ2dlcnNcbiAgICAgICAgLy8gYSAxMDAtMjAwbXMgcHJvZmlsZSBmZXRjaCB0aGF0IHdhcyBhd2FpdGVkIHNlcmlhbGx5IGF0XG4gICAgICAgIC8vIHByaW50LnRzOjczOS4gdXBkYXRlQmVkcm9ja01vZGVsU3RyaW5ncyBpcyBzZXF1ZW50aWFsKCktd3JhcHBlZCBzb1xuICAgICAgICAvLyB0aGUgYXdhaXQgam9pbnMgdGhlIGluLWZsaWdodCBmZXRjaC4gTm9uLUJlZHJvY2sgaXMgYSBzeW5jXG4gICAgICAgIC8vIGVhcmx5LXJldHVybiAoemVyby1jb3N0KS5cbiAgICAgICAgdm9pZCBlbnN1cmVNb2RlbFN0cmluZ3NJbml0aWFsaXplZCgpXG4gICAgICB9XG5cbiAgICAgIC8vIEFwcGx5IC0tbmFtZTogY2FjaGUtb25seSBzbyBubyBvcnBoYW4gZmlsZSBpcyBjcmVhdGVkIGJlZm9yZSB0aGVcbiAgICAgIC8vIHNlc3Npb24gSUQgaXMgZmluYWxpemVkIGJ5IC0tY29udGludWUvLS1yZXN1bWUuIG1hdGVyaWFsaXplU2Vzc2lvbkZpbGVcbiAgICAgIC8vIHBlcnNpc3RzIGl0IG9uIHRoZSBmaXJzdCB1c2VyIG1lc3NhZ2U7IFJFUEwncyB1c2VUZXJtaW5hbFRpdGxlIHJlYWRzIGl0XG4gICAgICAvLyB2aWEgZ2V0Q3VycmVudFNlc3Npb25UaXRsZS5cbiAgICAgIGNvbnN0IHNlc3Npb25OYW1lQXJnID0gb3B0aW9ucy5uYW1lPy50cmltKClcbiAgICAgIGlmIChzZXNzaW9uTmFtZUFyZykge1xuICAgICAgICBjYWNoZVNlc3Npb25UaXRsZShzZXNzaW9uTmFtZUFyZylcbiAgICAgIH1cblxuICAgICAgLy8gQW50IG1vZGVsIGFsaWFzZXMgKGNhcHliYXJhLWZhc3QgZXRjLikgcmVzb2x2ZSB2aWEgdGhlXG4gICAgICAvLyB0ZW5ndV9hbnRfbW9kZWxfb3ZlcnJpZGUgR3Jvd3RoQm9vayBmbGFnLiBfQ0FDSEVEX01BWV9CRV9TVEFMRSByZWFkc1xuICAgICAgLy8gZGlzayBzeW5jaHJvbm91c2x5OyBkaXNrIGlzIHBvcHVsYXRlZCBieSBhIGZpcmUtYW5kLWZvcmdldCB3cml0ZS4gT24gYVxuICAgICAgLy8gY29sZCBjYWNoZSwgcGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwgcmV0dXJucyB0aGUgdW5yZXNvbHZlZCBhbGlhcywgdGhlXG4gICAgICAvLyBBUEkgNDA0cywgYW5kIC1wIGV4aXRzIGJlZm9yZSB0aGUgYXN5bmMgd3JpdGUgbGFuZHMg4oCUIGNyYXNobG9vcCBvblxuICAgICAgLy8gZnJlc2ggcG9kcy4gQXdhaXRpbmcgaW5pdCBoZXJlIHBvcHVsYXRlcyB0aGUgaW4tbWVtb3J5IHBheWxvYWQgbWFwIHRoYXRcbiAgICAgIC8vIF9DQUNIRURfTUFZX0JFX1NUQUxFIG5vdyBjaGVja3MgZmlyc3QuIEdhdGVkIHNvIHRoZSB3YXJtIHBhdGggc3RheXNcbiAgICAgIC8vIG5vbi1ibG9ja2luZzpcbiAgICAgIC8vICAtIGV4cGxpY2l0IG1vZGVsIHZpYSAtLW1vZGVsIG9yIEFOVEhST1BJQ19NT0RFTCAoYm90aCBmZWVkIGFsaWFzIHJlc29sdXRpb24pXG4gICAgICAvLyAgLSBubyBlbnYgb3ZlcnJpZGUgKHdoaWNoIHNob3J0LWNpcmN1aXRzIF9DQUNIRURfTUFZX0JFX1NUQUxFIGJlZm9yZSBkaXNrKVxuICAgICAgLy8gIC0gZmxhZyBhYnNlbnQgZnJvbSBkaXNrICg9PSBudWxsIGFsc28gY2F0Y2hlcyBwcmUtIzIyMjc5IHBvaXNvbmVkIG51bGwpXG4gICAgICBjb25zdCBleHBsaWNpdE1vZGVsID0gb3B0aW9ucy5tb2RlbCB8fCBwcm9jZXNzLmVudi5BTlRIUk9QSUNfTU9ERUxcbiAgICAgIGlmIChcbiAgICAgICAgXCJleHRlcm5hbFwiID09PSAnYW50JyAmJlxuICAgICAgICBleHBsaWNpdE1vZGVsICYmXG4gICAgICAgIGV4cGxpY2l0TW9kZWwgIT09ICdkZWZhdWx0JyAmJlxuICAgICAgICAhaGFzR3Jvd3RoQm9va0Vudk92ZXJyaWRlKCd0ZW5ndV9hbnRfbW9kZWxfb3ZlcnJpZGUnKSAmJlxuICAgICAgICBnZXRHbG9iYWxDb25maWcoKS5jYWNoZWRHcm93dGhCb29rRmVhdHVyZXM/LltcbiAgICAgICAgICAndGVuZ3VfYW50X21vZGVsX292ZXJyaWRlJ1xuICAgICAgICBdID09IG51bGxcbiAgICAgICkge1xuICAgICAgICBhd2FpdCBpbml0aWFsaXplR3Jvd3RoQm9vaygpXG4gICAgICB9XG5cbiAgICAgIC8vIFNwZWNpYWwgY2FzZSB0aGUgZGVmYXVsdCBtb2RlbCB3aXRoIHRoZSBudWxsIGtleXdvcmRcbiAgICAgIC8vIE5PVEU6IE1vZGVsIHJlc29sdXRpb24gaGFwcGVucyBhZnRlciBzZXR1cCgpIHRvIGVuc3VyZSB0cnVzdCBpcyBlc3RhYmxpc2hlZCBiZWZvcmUgQVdTIGF1dGhcbiAgICAgIGNvbnN0IHVzZXJTcGVjaWZpZWRNb2RlbCA9XG4gICAgICAgIG9wdGlvbnMubW9kZWwgPT09ICdkZWZhdWx0JyA/IGdldERlZmF1bHRNYWluTG9vcE1vZGVsKCkgOiBvcHRpb25zLm1vZGVsXG4gICAgICBjb25zdCB1c2VyU3BlY2lmaWVkRmFsbGJhY2tNb2RlbCA9XG4gICAgICAgIGZhbGxiYWNrTW9kZWwgPT09ICdkZWZhdWx0JyA/IGdldERlZmF1bHRNYWluTG9vcE1vZGVsKCkgOiBmYWxsYmFja01vZGVsXG5cbiAgICAgIC8vIFJldXNlIHByZVNldHVwQ3dkIHVubGVzcyBzZXR1cCgpIGNoZGlyJ2QgKHdvcmt0cmVlRW5hYmxlZCkuIFNhdmVzIGFcbiAgICAgIC8vIGdldEN3ZCgpIHN5c2NhbGwgaW4gdGhlIGNvbW1vbiBwYXRoLlxuICAgICAgY29uc3QgY3VycmVudEN3ZCA9IHdvcmt0cmVlRW5hYmxlZCA/IGdldEN3ZCgpIDogcHJlU2V0dXBDd2RcbiAgICAgIGxvZ0ZvckRlYnVnZ2luZygnW1NUQVJUVVBdIExvYWRpbmcgY29tbWFuZHMgYW5kIGFnZW50cy4uLicpXG4gICAgICBjb25zdCBjb21tYW5kc1N0YXJ0ID0gRGF0ZS5ub3coKVxuICAgICAgLy8gSm9pbiB0aGUgcHJvbWlzZXMga2lja2VkIGJlZm9yZSBzZXR1cCgpIChvciBzdGFydCBmcmVzaCBpZlxuICAgICAgLy8gd29ya3RyZWVFbmFibGVkIGdhdGVkIHRoZSBlYXJseSBraWNrKS4gQm90aCBtZW1vaXplZCBieSBjd2QuXG4gICAgICBjb25zdCBbY29tbWFuZHMsIGFnZW50RGVmaW5pdGlvbnNSZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjb21tYW5kc1Byb21pc2UgPz8gZ2V0Q29tbWFuZHMoY3VycmVudEN3ZCksXG4gICAgICAgIGFnZW50RGVmc1Byb21pc2UgPz8gZ2V0QWdlbnREZWZpbml0aW9uc1dpdGhPdmVycmlkZXMoY3VycmVudEN3ZCksXG4gICAgICBdKVxuICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICBgW1NUQVJUVVBdIENvbW1hbmRzIGFuZCBhZ2VudHMgbG9hZGVkIGluICR7RGF0ZS5ub3coKSAtIGNvbW1hbmRzU3RhcnR9bXNgLFxuICAgICAgKVxuICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl9jb21tYW5kc19sb2FkZWQnKVxuXG4gICAgICAvLyBQYXJzZSBDTEkgYWdlbnRzIGlmIHByb3ZpZGVkIHZpYSAtLWFnZW50cyBmbGFnXG4gICAgICBsZXQgY2xpQWdlbnRzOiB0eXBlb2YgYWdlbnREZWZpbml0aW9uc1Jlc3VsdC5hY3RpdmVBZ2VudHMgPSBbXVxuICAgICAgaWYgKGFnZW50c0pzb24pIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWRBZ2VudHMgPSBzYWZlUGFyc2VKU09OKGFnZW50c0pzb24pXG4gICAgICAgICAgaWYgKHBhcnNlZEFnZW50cykge1xuICAgICAgICAgICAgY2xpQWdlbnRzID0gcGFyc2VBZ2VudHNGcm9tSnNvbihwYXJzZWRBZ2VudHMsICdmbGFnU2V0dGluZ3MnKVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBsb2dFcnJvcihlcnJvcilcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBNZXJnZSBDTEkgYWdlbnRzIHdpdGggZXhpc3Rpbmcgb25lc1xuICAgICAgY29uc3QgYWxsQWdlbnRzID0gWy4uLmFnZW50RGVmaW5pdGlvbnNSZXN1bHQuYWxsQWdlbnRzLCAuLi5jbGlBZ2VudHNdXG4gICAgICBjb25zdCBhZ2VudERlZmluaXRpb25zID0ge1xuICAgICAgICAuLi5hZ2VudERlZmluaXRpb25zUmVzdWx0LFxuICAgICAgICBhbGxBZ2VudHMsXG4gICAgICAgIGFjdGl2ZUFnZW50czogZ2V0QWN0aXZlQWdlbnRzRnJvbUxpc3QoYWxsQWdlbnRzKSxcbiAgICAgIH1cblxuICAgICAgLy8gTG9vayB1cCBtYWluIHRocmVhZCBhZ2VudCBmcm9tIENMSSBmbGFnIG9yIHNldHRpbmdzXG4gICAgICBjb25zdCBhZ2VudFNldHRpbmcgPSBhZ2VudENsaSA/PyBnZXRJbml0aWFsU2V0dGluZ3MoKS5hZ2VudFxuICAgICAgbGV0IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb246XG4gICAgICAgIHwgKHR5cGVvZiBhZ2VudERlZmluaXRpb25zLmFjdGl2ZUFnZW50cylbbnVtYmVyXVxuICAgICAgICB8IHVuZGVmaW5lZFxuICAgICAgaWYgKGFnZW50U2V0dGluZykge1xuICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uID0gYWdlbnREZWZpbml0aW9ucy5hY3RpdmVBZ2VudHMuZmluZChcbiAgICAgICAgICBhZ2VudCA9PiBhZ2VudC5hZ2VudFR5cGUgPT09IGFnZW50U2V0dGluZyxcbiAgICAgICAgKVxuICAgICAgICBpZiAoIW1haW5UaHJlYWRBZ2VudERlZmluaXRpb24pIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgV2FybmluZzogYWdlbnQgXCIke2FnZW50U2V0dGluZ31cIiBub3QgZm91bmQuIGAgK1xuICAgICAgICAgICAgICBgQXZhaWxhYmxlIGFnZW50czogJHthZ2VudERlZmluaXRpb25zLmFjdGl2ZUFnZW50cy5tYXAoYSA9PiBhLmFnZW50VHlwZSkuam9pbignLCAnKX0uIGAgK1xuICAgICAgICAgICAgICBgVXNpbmcgZGVmYXVsdCBiZWhhdmlvci5gLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBTdG9yZSB0aGUgbWFpbiB0aHJlYWQgYWdlbnQgdHlwZSBpbiBib290c3RyYXAgc3RhdGUgc28gaG9va3MgY2FuIGFjY2VzcyBpdFxuICAgICAgc2V0TWFpblRocmVhZEFnZW50VHlwZShtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uPy5hZ2VudFR5cGUpXG5cbiAgICAgIC8vIExvZyBhZ2VudCBmbGFnIHVzYWdlIOKAlCBvbmx5IGxvZyBhZ2VudCBuYW1lIGZvciBidWlsdC1pbiBhZ2VudHMgdG8gYXZvaWQgbGVha2luZyBjdXN0b20gYWdlbnQgbmFtZXNcbiAgICAgIGlmIChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uKSB7XG4gICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9hZ2VudF9mbGFnJywge1xuICAgICAgICAgIGFnZW50VHlwZTogaXNCdWlsdEluQWdlbnQobWFpblRocmVhZEFnZW50RGVmaW5pdGlvbilcbiAgICAgICAgICAgID8gKG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24uYWdlbnRUeXBlIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMpXG4gICAgICAgICAgICA6ICgnY3VzdG9tJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTKSxcbiAgICAgICAgICAuLi4oYWdlbnRDbGkgJiYge1xuICAgICAgICAgICAgc291cmNlOlxuICAgICAgICAgICAgICAnY2xpJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KVxuICAgICAgfVxuXG4gICAgICAvLyBQZXJzaXN0IGFnZW50IHNldHRpbmcgdG8gc2Vzc2lvbiB0cmFuc2NyaXB0IGZvciByZXN1bWUgdmlldyBkaXNwbGF5IGFuZCByZXN0b3JhdGlvblxuICAgICAgaWYgKG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24/LmFnZW50VHlwZSkge1xuICAgICAgICBzYXZlQWdlbnRTZXR0aW5nKG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24uYWdlbnRUeXBlKVxuICAgICAgfVxuXG4gICAgICAvLyBBcHBseSB0aGUgYWdlbnQncyBzeXN0ZW0gcHJvbXB0IGZvciBub24taW50ZXJhY3RpdmUgc2Vzc2lvbnNcbiAgICAgIC8vIChpbnRlcmFjdGl2ZSBtb2RlIHVzZXMgYnVpbGRFZmZlY3RpdmVTeXN0ZW1Qcm9tcHQgaW5zdGVhZClcbiAgICAgIGlmIChcbiAgICAgICAgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gJiZcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbiAmJlxuICAgICAgICAhc3lzdGVtUHJvbXB0ICYmXG4gICAgICAgICFpc0J1aWx0SW5BZ2VudChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uKVxuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IGFnZW50U3lzdGVtUHJvbXB0ID0gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5nZXRTeXN0ZW1Qcm9tcHQoKVxuICAgICAgICBpZiAoYWdlbnRTeXN0ZW1Qcm9tcHQpIHtcbiAgICAgICAgICBzeXN0ZW1Qcm9tcHQgPSBhZ2VudFN5c3RlbVByb21wdFxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIGluaXRpYWxQcm9tcHQgZ29lcyBmaXJzdCBzbyBpdHMgc2xhc2ggY29tbWFuZCAoaWYgYW55KSBpcyBwcm9jZXNzZWQ7XG4gICAgICAvLyB1c2VyLXByb3ZpZGVkIHRleHQgYmVjb21lcyB0cmFpbGluZyBjb250ZXh0LlxuICAgICAgLy8gT25seSBjb25jYXRlbmF0ZSB3aGVuIGlucHV0UHJvbXB0IGlzIGEgc3RyaW5nLiBXaGVuIGl0J3MgYW5cbiAgICAgIC8vIEFzeW5jSXRlcmFibGUgKFNESyBzdHJlYW0tanNvbiBtb2RlKSwgdGVtcGxhdGUgaW50ZXJwb2xhdGlvbiB3b3VsZFxuICAgICAgLy8gY2FsbCAudG9TdHJpbmcoKSBwcm9kdWNpbmcgXCJbb2JqZWN0IE9iamVjdF1cIi4gVGhlIEFzeW5jSXRlcmFibGUgY2FzZVxuICAgICAgLy8gaXMgaGFuZGxlZCBpbiBwcmludC50cyB2aWEgc3RydWN0dXJlZElPLnByZXBlbmRVc2VyTWVzc2FnZSgpLlxuICAgICAgaWYgKG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24/LmluaXRpYWxQcm9tcHQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBpbnB1dFByb21wdCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBpbnB1dFByb21wdCA9IGlucHV0UHJvbXB0XG4gICAgICAgICAgICA/IGAke21haW5UaHJlYWRBZ2VudERlZmluaXRpb24uaW5pdGlhbFByb21wdH1cXG5cXG4ke2lucHV0UHJvbXB0fWBcbiAgICAgICAgICAgIDogbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5pbml0aWFsUHJvbXB0XG4gICAgICAgIH0gZWxzZSBpZiAoIWlucHV0UHJvbXB0KSB7XG4gICAgICAgICAgaW5wdXRQcm9tcHQgPSBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLmluaXRpYWxQcm9tcHRcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDb21wdXRlIGVmZmVjdGl2ZSBtb2RlbCBlYXJseSBzbyBob29rcyBjYW4gcnVuIGluIHBhcmFsbGVsIHdpdGggTUNQXG4gICAgICAvLyBJZiB1c2VyIGRpZG4ndCBzcGVjaWZ5IGEgbW9kZWwgYnV0IGFnZW50IGhhcyBvbmUsIHVzZSB0aGUgYWdlbnQncyBtb2RlbFxuICAgICAgbGV0IGVmZmVjdGl2ZU1vZGVsID0gdXNlclNwZWNpZmllZE1vZGVsXG4gICAgICBpZiAoXG4gICAgICAgICFlZmZlY3RpdmVNb2RlbCAmJlxuICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uPy5tb2RlbCAmJlxuICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLm1vZGVsICE9PSAnaW5oZXJpdCdcbiAgICAgICkge1xuICAgICAgICBlZmZlY3RpdmVNb2RlbCA9IHBhcnNlVXNlclNwZWNpZmllZE1vZGVsKFxuICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24ubW9kZWwsXG4gICAgICAgIClcbiAgICAgIH1cblxuICAgICAgc2V0TWFpbkxvb3BNb2RlbE92ZXJyaWRlKGVmZmVjdGl2ZU1vZGVsKVxuXG4gICAgICAvLyBDb21wdXRlIHJlc29sdmVkIG1vZGVsIGZvciBob29rcyAodXNlIHVzZXItc3BlY2lmaWVkIG1vZGVsIGF0IGxhdW5jaClcbiAgICAgIHNldEluaXRpYWxNYWluTG9vcE1vZGVsKGdldFVzZXJTcGVjaWZpZWRNb2RlbFNldHRpbmcoKSB8fCBudWxsKVxuICAgICAgY29uc3QgaW5pdGlhbE1haW5Mb29wTW9kZWwgPSBnZXRJbml0aWFsTWFpbkxvb3BNb2RlbCgpXG4gICAgICBjb25zdCByZXNvbHZlZEluaXRpYWxNb2RlbCA9IHBhcnNlVXNlclNwZWNpZmllZE1vZGVsKFxuICAgICAgICBpbml0aWFsTWFpbkxvb3BNb2RlbCA/PyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpLFxuICAgICAgKVxuXG4gICAgICBsZXQgYWR2aXNvck1vZGVsOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICAgIGlmIChpc0Fkdmlzb3JFbmFibGVkKCkpIHtcbiAgICAgICAgY29uc3QgYWR2aXNvck9wdGlvbiA9IGNhblVzZXJDb25maWd1cmVBZHZpc29yKClcbiAgICAgICAgICA/IChvcHRpb25zIGFzIHsgYWR2aXNvcj86IHN0cmluZyB9KS5hZHZpc29yXG4gICAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgICAgaWYgKGFkdmlzb3JPcHRpb24pIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoYFtBZHZpc29yVG9vbF0gLS1hZHZpc29yICR7YWR2aXNvck9wdGlvbn1gKVxuICAgICAgICAgIGlmICghbW9kZWxTdXBwb3J0c0Fkdmlzb3IocmVzb2x2ZWRJbml0aWFsTW9kZWwpKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAgIGBFcnJvcjogVGhlIG1vZGVsIFwiJHtyZXNvbHZlZEluaXRpYWxNb2RlbH1cIiBkb2VzIG5vdCBzdXBwb3J0IHRoZSBhZHZpc29yIHRvb2wuXFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBub3JtYWxpemVkQWR2aXNvck1vZGVsID0gbm9ybWFsaXplTW9kZWxTdHJpbmdGb3JBUEkoXG4gICAgICAgICAgICBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbChhZHZpc29yT3B0aW9uKSxcbiAgICAgICAgICApXG4gICAgICAgICAgaWYgKCFpc1ZhbGlkQWR2aXNvck1vZGVsKG5vcm1hbGl6ZWRBZHZpc29yTW9kZWwpKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAgIGBFcnJvcjogVGhlIG1vZGVsIFwiJHthZHZpc29yT3B0aW9ufVwiIGNhbm5vdCBiZSB1c2VkIGFzIGFuIGFkdmlzb3IuXFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBhZHZpc29yTW9kZWwgPSBjYW5Vc2VyQ29uZmlndXJlQWR2aXNvcigpXG4gICAgICAgICAgPyAoYWR2aXNvck9wdGlvbiA/PyBnZXRJbml0aWFsQWR2aXNvclNldHRpbmcoKSlcbiAgICAgICAgICA6IGFkdmlzb3JPcHRpb25cbiAgICAgICAgaWYgKGFkdmlzb3JNb2RlbCkge1xuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhgW0Fkdmlzb3JUb29sXSBBZHZpc29yIG1vZGVsOiAke2Fkdmlzb3JNb2RlbH1gKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEZvciB0bXV4IHRlYW1tYXRlcyB3aXRoIC0tYWdlbnQtdHlwZSwgYXBwZW5kIHRoZSBjdXN0b20gYWdlbnQncyBwcm9tcHRcbiAgICAgIGlmIChcbiAgICAgICAgaXNBZ2VudFN3YXJtc0VuYWJsZWQoKSAmJlxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHM/LmFnZW50SWQgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy5hZ2VudE5hbWUgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy50ZWFtTmFtZSAmJlxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHM/LmFnZW50VHlwZVxuICAgICAgKSB7XG4gICAgICAgIC8vIExvb2sgdXAgdGhlIGN1c3RvbSBhZ2VudCBkZWZpbml0aW9uXG4gICAgICAgIGNvbnN0IGN1c3RvbUFnZW50ID0gYWdlbnREZWZpbml0aW9ucy5hY3RpdmVBZ2VudHMuZmluZChcbiAgICAgICAgICBhID0+IGEuYWdlbnRUeXBlID09PSBzdG9yZWRUZWFtbWF0ZU9wdHMuYWdlbnRUeXBlLFxuICAgICAgICApXG4gICAgICAgIGlmIChjdXN0b21BZ2VudCkge1xuICAgICAgICAgIC8vIEdldCB0aGUgcHJvbXB0IC0gbmVlZCB0byBoYW5kbGUgYm90aCBidWlsdC1pbiBhbmQgY3VzdG9tIGFnZW50c1xuICAgICAgICAgIGxldCBjdXN0b21Qcm9tcHQ6IHN0cmluZyB8IHVuZGVmaW5lZFxuICAgICAgICAgIGlmIChjdXN0b21BZ2VudC5zb3VyY2UgPT09ICdidWlsdC1pbicpIHtcbiAgICAgICAgICAgIC8vIEJ1aWx0LWluIGFnZW50cyBoYXZlIGdldFN5c3RlbVByb21wdCB0aGF0IHRha2VzIHRvb2xVc2VDb250ZXh0XG4gICAgICAgICAgICAvLyBXZSBjYW4ndCBhY2Nlc3MgZnVsbCB0b29sVXNlQ29udGV4dCBoZXJlLCBzbyBza2lwIGZvciBub3dcbiAgICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgICAgYFt0ZWFtbWF0ZV0gQnVpbHQtaW4gYWdlbnQgJHtzdG9yZWRUZWFtbWF0ZU9wdHMuYWdlbnRUeXBlfSAtIHNraXBwaW5nIGN1c3RvbSBwcm9tcHQgKG5vdCBzdXBwb3J0ZWQpYCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gQ3VzdG9tIGFnZW50cyBoYXZlIGdldFN5c3RlbVByb21wdCB0aGF0IHRha2VzIG5vIGFyZ3NcbiAgICAgICAgICAgIGN1c3RvbVByb21wdCA9IGN1c3RvbUFnZW50LmdldFN5c3RlbVByb21wdCgpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gTG9nIGFnZW50IG1lbW9yeSBsb2FkZWQgZXZlbnQgZm9yIHRtdXggdGVhbW1hdGVzXG4gICAgICAgICAgaWYgKGN1c3RvbUFnZW50Lm1lbW9yeSkge1xuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2FnZW50X21lbW9yeV9sb2FkZWQnLCB7XG4gICAgICAgICAgICAgIC4uLihcImV4dGVybmFsXCIgPT09ICdhbnQnICYmIHtcbiAgICAgICAgICAgICAgICBhZ2VudF90eXBlOlxuICAgICAgICAgICAgICAgICAgY3VzdG9tQWdlbnQuYWdlbnRUeXBlIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBzY29wZTpcbiAgICAgICAgICAgICAgICBjdXN0b21BZ2VudC5tZW1vcnkgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgc291cmNlOlxuICAgICAgICAgICAgICAgICd0ZWFtbWF0ZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKGN1c3RvbVByb21wdCkge1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tSW5zdHJ1Y3Rpb25zID0gYFxcbiMgQ3VzdG9tIEFnZW50IEluc3RydWN0aW9uc1xcbiR7Y3VzdG9tUHJvbXB0fWBcbiAgICAgICAgICAgIGFwcGVuZFN5c3RlbVByb21wdCA9IGFwcGVuZFN5c3RlbVByb21wdFxuICAgICAgICAgICAgICA/IGAke2FwcGVuZFN5c3RlbVByb21wdH1cXG5cXG4ke2N1c3RvbUluc3RydWN0aW9uc31gXG4gICAgICAgICAgICAgIDogY3VzdG9tSW5zdHJ1Y3Rpb25zXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgIGBbdGVhbW1hdGVdIEN1c3RvbSBhZ2VudCAke3N0b3JlZFRlYW1tYXRlT3B0cy5hZ2VudFR5cGV9IG5vdCBmb3VuZCBpbiBhdmFpbGFibGUgYWdlbnRzYCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnMpXG4gICAgICAvLyBkZWZhdWx0VmlldzogJ2NoYXQnIGlzIGEgcGVyc2lzdGVkIG9wdC1pbiDigJQgY2hlY2sgZW50aXRsZW1lbnQgYW5kIHNldFxuICAgICAgLy8gdXNlck1zZ09wdEluIHNvIHRoZSB0b29sICsgcHJvbXB0IHNlY3Rpb24gYWN0aXZhdGUuIEludGVyYWN0aXZlLW9ubHk6XG4gICAgICAvLyBkZWZhdWx0VmlldyBpcyBhIGRpc3BsYXkgcHJlZmVyZW5jZTsgU0RLIHNlc3Npb25zIGhhdmUgbm8gZGlzcGxheSwgYW5kXG4gICAgICAvLyB0aGUgYXNzaXN0YW50IGluc3RhbGxlciB3cml0ZXMgZGVmYXVsdFZpZXc6J2NoYXQnIHRvIHNldHRpbmdzLmxvY2FsLmpzb25cbiAgICAgIC8vIHdoaWNoIHdvdWxkIG90aGVyd2lzZSBsZWFrIGludG8gLS1wcmludCBzZXNzaW9ucyBpbiB0aGUgc2FtZSBkaXJlY3RvcnkuXG4gICAgICAvLyBSdW5zIHJpZ2h0IGFmdGVyIG1heWJlQWN0aXZhdGVCcmllZigpIHNvIGFsbCBzdGFydHVwIG9wdC1pbiBwYXRocyBmaXJlXG4gICAgICAvLyBCRUZPUkUgYW55IGlzQnJpZWZFbmFibGVkKCkgcmVhZCBiZWxvdyAocHJvYWN0aXZlIHByb21wdCdzXG4gICAgICAvLyBicmllZlZpc2liaWxpdHkpLiBBIHBlcnNpc3RlZCAnY2hhdCcgYWZ0ZXIgYSBHQiBraWxsLXN3aXRjaCBmYWxsc1xuICAgICAgLy8gdGhyb3VnaCAoZW50aXRsZW1lbnQgZmFpbHMpLlxuICAgICAgaWYgKFxuICAgICAgICAoZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0JSSUVGJykpICYmXG4gICAgICAgICFnZXRJc05vbkludGVyYWN0aXZlU2Vzc2lvbigpICYmXG4gICAgICAgICFnZXRVc2VyTXNnT3B0SW4oKSAmJlxuICAgICAgICBnZXRJbml0aWFsU2V0dGluZ3MoKS5kZWZhdWx0VmlldyA9PT0gJ2NoYXQnXG4gICAgICApIHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCB7IGlzQnJpZWZFbnRpdGxlZCB9ID1cbiAgICAgICAgICByZXF1aXJlKCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKSBhcyB0eXBlb2YgaW1wb3J0KCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKVxuICAgICAgICAvKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbiAgICAgICAgaWYgKGlzQnJpZWZFbnRpdGxlZCgpKSB7XG4gICAgICAgICAgc2V0VXNlck1zZ09wdEluKHRydWUpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIENvb3JkaW5hdG9yIG1vZGUgaGFzIGl0cyBvd24gc3lzdGVtIHByb21wdCBhbmQgZmlsdGVycyBvdXQgU2xlZXAsIHNvXG4gICAgICAvLyB0aGUgZ2VuZXJpYyBwcm9hY3RpdmUgcHJvbXB0IHdvdWxkIHRlbGwgaXQgdG8gY2FsbCBhIHRvb2wgaXQgY2FuJ3RcbiAgICAgIC8vIGFjY2VzcyBhbmQgY29uZmxpY3Qgd2l0aCBkZWxlZ2F0aW9uIGluc3RydWN0aW9ucy5cbiAgICAgIGlmIChcbiAgICAgICAgKGZlYXR1cmUoJ1BST0FDVElWRScpIHx8IGZlYXR1cmUoJ0tBSVJPUycpKSAmJlxuICAgICAgICAoKG9wdGlvbnMgYXMgeyBwcm9hY3RpdmU/OiBib29sZWFuIH0pLnByb2FjdGl2ZSB8fFxuICAgICAgICAgIGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1BST0FDVElWRSkpICYmXG4gICAgICAgICFjb29yZGluYXRvck1vZGVNb2R1bGU/LmlzQ29vcmRpbmF0b3JNb2RlKClcbiAgICAgICkge1xuICAgICAgICAvKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4gICAgICAgIGNvbnN0IGJyaWVmVmlzaWJpbGl0eSA9XG4gICAgICAgICAgZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0JSSUVGJylcbiAgICAgICAgICAgID8gKFxuICAgICAgICAgICAgICAgIHJlcXVpcmUoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpXG4gICAgICAgICAgICAgICkuaXNCcmllZkVuYWJsZWQoKVxuICAgICAgICAgICAgICA/ICdDYWxsIFNlbmRVc2VyTWVzc2FnZSBhdCBjaGVja3BvaW50cyB0byBtYXJrIHdoZXJlIHRoaW5ncyBzdGFuZC4nXG4gICAgICAgICAgICAgIDogJ1RoZSB1c2VyIHdpbGwgc2VlIGFueSB0ZXh0IHlvdSBvdXRwdXQuJ1xuICAgICAgICAgICAgOiAnVGhlIHVzZXIgd2lsbCBzZWUgYW55IHRleHQgeW91IG91dHB1dC4nXG4gICAgICAgIC8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCBwcm9hY3RpdmVQcm9tcHQgPSBgXFxuIyBQcm9hY3RpdmUgTW9kZVxcblxcbllvdSBhcmUgaW4gcHJvYWN0aXZlIG1vZGUuIFRha2UgaW5pdGlhdGl2ZSDigJQgZXhwbG9yZSwgYWN0LCBhbmQgbWFrZSBwcm9ncmVzcyB3aXRob3V0IHdhaXRpbmcgZm9yIGluc3RydWN0aW9ucy5cXG5cXG5TdGFydCBieSBicmllZmx5IGdyZWV0aW5nIHRoZSB1c2VyLlxcblxcbllvdSB3aWxsIHJlY2VpdmUgcGVyaW9kaWMgPHRpY2s+IHByb21wdHMuIFRoZXNlIGFyZSBjaGVjay1pbnMuIERvIHdoYXRldmVyIHNlZW1zIG1vc3QgdXNlZnVsLCBvciBjYWxsIFNsZWVwIGlmIHRoZXJlJ3Mgbm90aGluZyB0byBkby4gJHticmllZlZpc2liaWxpdHl9YFxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICA/IGAke2FwcGVuZFN5c3RlbVByb21wdH1cXG5cXG4ke3Byb2FjdGl2ZVByb21wdH1gXG4gICAgICAgICAgOiBwcm9hY3RpdmVQcm9tcHRcbiAgICAgIH1cblxuICAgICAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpICYmIGthaXJvc0VuYWJsZWQgJiYgYXNzaXN0YW50TW9kdWxlKSB7XG4gICAgICAgIGNvbnN0IGFzc2lzdGFudEFkZGVuZHVtID1cbiAgICAgICAgICBhc3Npc3RhbnRNb2R1bGUuZ2V0QXNzaXN0YW50U3lzdGVtUHJvbXB0QWRkZW5kdW0oKVxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICA/IGAke2FwcGVuZFN5c3RlbVByb21wdH1cXG5cXG4ke2Fzc2lzdGFudEFkZGVuZHVtfWBcbiAgICAgICAgICA6IGFzc2lzdGFudEFkZGVuZHVtXG4gICAgICB9XG5cbiAgICAgIC8vIEluayByb290IGlzIG9ubHkgbmVlZGVkIGZvciBpbnRlcmFjdGl2ZSBzZXNzaW9ucyDigJQgcGF0Y2hDb25zb2xlIGluIHRoZVxuICAgICAgLy8gSW5rIGNvbnN0cnVjdG9yIHdvdWxkIHN3YWxsb3cgY29uc29sZSBvdXRwdXQgaW4gaGVhZGxlc3MgbW9kZS5cbiAgICAgIGxldCByb290ITogUm9vdFxuICAgICAgbGV0IGdldEZwc01ldHJpY3MhOiAoKSA9PiBGcHNNZXRyaWNzIHwgdW5kZWZpbmVkXG4gICAgICBsZXQgc3RhdHMhOiBTdGF0c1N0b3JlXG5cbiAgICAgIC8vIFNob3cgc2V0dXAgc2NyZWVucyBhZnRlciBjb21tYW5kcyBhcmUgbG9hZGVkXG4gICAgICBpZiAoIWlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgIGNvbnN0IGN0eCA9IGdldFJlbmRlckNvbnRleHQoZmFsc2UpXG4gICAgICAgIGdldEZwc01ldHJpY3MgPSBjdHguZ2V0RnBzTWV0cmljc1xuICAgICAgICBzdGF0cyA9IGN0eC5zdGF0c1xuICAgICAgICAvLyBJbnN0YWxsIGFzY2lpY2FzdCByZWNvcmRlciBiZWZvcmUgSW5rIG1vdW50cyAoYW50LW9ubHksIG9wdC1pbiB2aWEgQ0xBVURFX0NPREVfVEVSTUlOQUxfUkVDT1JESU5HPTEpXG4gICAgICAgIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgICAgICAgaW5zdGFsbEFzY2lpY2FzdFJlY29yZGVyKClcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHsgY3JlYXRlUm9vdCB9ID0gYXdhaXQgaW1wb3J0KCcuL2luay5qcycpXG4gICAgICAgIHJvb3QgPSBhd2FpdCBjcmVhdGVSb290KGN0eC5yZW5kZXJPcHRpb25zKVxuXG4gICAgICAgIC8vIExvZyBzdGFydHVwIHRpbWUgbm93LCBiZWZvcmUgYW55IGJsb2NraW5nIGRpYWxvZyByZW5kZXJzLiBMb2dnaW5nXG4gICAgICAgIC8vIGZyb20gUkVQTCdzIGZpcnN0IHJlbmRlciAodGhlIG9sZCBsb2NhdGlvbikgaW5jbHVkZWQgaG93ZXZlciBsb25nXG4gICAgICAgIC8vIHRoZSB1c2VyIHNhdCBvbiB0cnVzdC9PQXV0aC9vbmJvYXJkaW5nL3Jlc3VtZS1waWNrZXIg4oCUIHA5OSB3YXMgfjcwc1xuICAgICAgICAvLyBkb21pbmF0ZWQgYnkgZGlhbG9nLXdhaXQgdGltZSwgbm90IGNvZGUtcGF0aCBzdGFydHVwLlxuICAgICAgICBsb2dFdmVudCgndGVuZ3VfdGltZXInLCB7XG4gICAgICAgICAgZXZlbnQ6XG4gICAgICAgICAgICAnc3RhcnR1cCcgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICBkdXJhdGlvbk1zOiBNYXRoLnJvdW5kKHByb2Nlc3MudXB0aW1lKCkgKiAxMDAwKSxcbiAgICAgICAgfSlcblxuICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoJ1tTVEFSVFVQXSBSdW5uaW5nIHNob3dTZXR1cFNjcmVlbnMoKS4uLicpXG4gICAgICAgIGNvbnN0IHNldHVwU2NyZWVuc1N0YXJ0ID0gRGF0ZS5ub3coKVxuICAgICAgICBjb25zdCBvbmJvYXJkaW5nU2hvd24gPSBhd2FpdCBzaG93U2V0dXBTY3JlZW5zKFxuICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgcGVybWlzc2lvbk1vZGUsXG4gICAgICAgICAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcbiAgICAgICAgICBjb21tYW5kcyxcbiAgICAgICAgICBlbmFibGVDbGF1ZGVJbkNocm9tZSxcbiAgICAgICAgICBkZXZDaGFubmVscyxcbiAgICAgICAgKVxuICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgYFtTVEFSVFVQXSBzaG93U2V0dXBTY3JlZW5zKCkgY29tcGxldGVkIGluICR7RGF0ZS5ub3coKSAtIHNldHVwU2NyZWVuc1N0YXJ0fW1zYCxcbiAgICAgICAgKVxuXG4gICAgICAgIC8vIE5vdyB0aGF0IHRydXN0IGlzIGVzdGFibGlzaGVkIGFuZCBHcm93dGhCb29rIGhhcyBhdXRoIGhlYWRlcnMsXG4gICAgICAgIC8vIHJlc29sdmUgdGhlIC0tcmVtb3RlLWNvbnRyb2wgLyAtLXJjIGVudGl0bGVtZW50IGdhdGUuXG4gICAgICAgIGlmIChmZWF0dXJlKCdCUklER0VfTU9ERScpICYmIHJlbW90ZUNvbnRyb2xPcHRpb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGNvbnN0IHsgZ2V0QnJpZGdlRGlzYWJsZWRSZWFzb24gfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICcuL2JyaWRnZS9icmlkZ2VFbmFibGVkLmpzJ1xuICAgICAgICAgIClcbiAgICAgICAgICBjb25zdCBkaXNhYmxlZFJlYXNvbiA9IGF3YWl0IGdldEJyaWRnZURpc2FibGVkUmVhc29uKClcbiAgICAgICAgICByZW1vdGVDb250cm9sID0gZGlzYWJsZWRSZWFzb24gPT09IG51bGxcbiAgICAgICAgICBpZiAoZGlzYWJsZWRSZWFzb24pIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBjaGFsay55ZWxsb3coYCR7ZGlzYWJsZWRSZWFzb259XFxuLS1yYyBmbGFnIGlnbm9yZWQuXFxuYCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ2hlY2sgZm9yIHBlbmRpbmcgYWdlbnQgbWVtb3J5IHNuYXBzaG90IHVwZGF0ZXMgKG9ubHkgZm9yIC0tYWdlbnQgbW9kZSwgYW50LW9ubHkpXG4gICAgICAgIGlmIChcbiAgICAgICAgICBmZWF0dXJlKCdBR0VOVF9NRU1PUllfU05BUFNIT1QnKSAmJlxuICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gJiZcbiAgICAgICAgICBpc0N1c3RvbUFnZW50KG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24pICYmXG4gICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5tZW1vcnkgJiZcbiAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLnBlbmRpbmdTbmFwc2hvdFVwZGF0ZVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCBhZ2VudERlZiA9IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb25cbiAgICAgICAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBsYXVuY2hTbmFwc2hvdFVwZGF0ZURpYWxvZyhyb290LCB7XG4gICAgICAgICAgICBhZ2VudFR5cGU6IGFnZW50RGVmLmFnZW50VHlwZSxcbiAgICAgICAgICAgIHNjb3BlOiBhZ2VudERlZi5tZW1vcnkhLFxuICAgICAgICAgICAgc25hcHNob3RUaW1lc3RhbXA6XG4gICAgICAgICAgICAgIGFnZW50RGVmLnBlbmRpbmdTbmFwc2hvdFVwZGF0ZSEuc25hcHNob3RUaW1lc3RhbXAsXG4gICAgICAgICAgfSlcbiAgICAgICAgICBpZiAoY2hvaWNlID09PSAnbWVyZ2UnKSB7XG4gICAgICAgICAgICBjb25zdCB7IGJ1aWxkTWVyZ2VQcm9tcHQgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICAgJy4vY29tcG9uZW50cy9hZ2VudHMvU25hcHNob3RVcGRhdGVEaWFsb2cuanMnXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCBtZXJnZVByb21wdCA9IGJ1aWxkTWVyZ2VQcm9tcHQoXG4gICAgICAgICAgICAgIGFnZW50RGVmLmFnZW50VHlwZSxcbiAgICAgICAgICAgICAgYWdlbnREZWYubWVtb3J5ISxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIGlucHV0UHJvbXB0ID0gaW5wdXRQcm9tcHRcbiAgICAgICAgICAgICAgPyBgJHttZXJnZVByb21wdH1cXG5cXG4ke2lucHV0UHJvbXB0fWBcbiAgICAgICAgICAgICAgOiBtZXJnZVByb21wdFxuICAgICAgICAgIH1cbiAgICAgICAgICBhZ2VudERlZi5wZW5kaW5nU25hcHNob3RVcGRhdGUgPSB1bmRlZmluZWRcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNraXAgZXhlY3V0aW5nIC9sb2dpbiBpZiB3ZSBqdXN0IGNvbXBsZXRlZCBvbmJvYXJkaW5nIGZvciBpdFxuICAgICAgICBpZiAob25ib2FyZGluZ1Nob3duICYmIHByb21wdD8udHJpbSgpLnRvTG93ZXJDYXNlKCkgPT09ICcvbG9naW4nKSB7XG4gICAgICAgICAgcHJvbXB0ID0gJydcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvbmJvYXJkaW5nU2hvd24pIHtcbiAgICAgICAgICAvLyBSZWZyZXNoIGF1dGgtZGVwZW5kZW50IHNlcnZpY2VzIG5vdyB0aGF0IHRoZSB1c2VyIGhhcyBsb2dnZWQgaW4gZHVyaW5nIG9uYm9hcmRpbmcuXG4gICAgICAgICAgLy8gS2VlcCBpbiBzeW5jIHdpdGggdGhlIHBvc3QtbG9naW4gbG9naWMgaW4gc3JjL2NvbW1hbmRzL2xvZ2luLnRzeFxuICAgICAgICAgIHZvaWQgcmVmcmVzaFJlbW90ZU1hbmFnZWRTZXR0aW5ncygpXG4gICAgICAgICAgdm9pZCByZWZyZXNoUG9saWN5TGltaXRzKClcbiAgICAgICAgICAvLyBDbGVhciB1c2VyIGRhdGEgY2FjaGUgQkVGT1JFIEdyb3d0aEJvb2sgcmVmcmVzaCBzbyBpdCBwaWNrcyB1cCBmcmVzaCBjcmVkZW50aWFsc1xuICAgICAgICAgIHJlc2V0VXNlckNhY2hlKClcbiAgICAgICAgICAvLyBSZWZyZXNoIEdyb3d0aEJvb2sgYWZ0ZXIgbG9naW4gdG8gZ2V0IHVwZGF0ZWQgZmVhdHVyZSBmbGFncyAoZS5nLiwgZm9yIGNsYXVkZS5haSBNQ1BzKVxuICAgICAgICAgIHJlZnJlc2hHcm93dGhCb29rQWZ0ZXJBdXRoQ2hhbmdlKClcbiAgICAgICAgICAvLyBDbGVhciBhbnkgc3RhbGUgdHJ1c3RlZCBkZXZpY2UgdG9rZW4gdGhlbiBlbnJvbGwgZm9yIFJlbW90ZSBDb250cm9sLlxuICAgICAgICAgIC8vIEJvdGggc2VsZi1nYXRlIG9uIHRlbmd1X3Nlc3Npb25zX2VsZXZhdGVkX2F1dGhfZW5mb3JjZW1lbnQgaW50ZXJuYWxseVxuICAgICAgICAgIC8vIOKAlCBlbnJvbGxUcnVzdGVkRGV2aWNlKCkgdmlhIGNoZWNrR2F0ZV9DQUNIRURfT1JfQkxPQ0tJTkcgKGF3YWl0c1xuICAgICAgICAgIC8vIHRoZSBHcm93dGhCb29rIHJlaW5pdCBhYm92ZSksIGNsZWFyVHJ1c3RlZERldmljZVRva2VuKCkgdmlhIHRoZVxuICAgICAgICAgIC8vIHN5bmMgY2FjaGVkIGNoZWNrIChhY2NlcHRhYmxlIHNpbmNlIGNsZWFyIGlzIGlkZW1wb3RlbnQpLlxuICAgICAgICAgIHZvaWQgaW1wb3J0KCcuL2JyaWRnZS90cnVzdGVkRGV2aWNlLmpzJykudGhlbihtID0+IHtcbiAgICAgICAgICAgIG0uY2xlYXJUcnVzdGVkRGV2aWNlVG9rZW4oKVxuICAgICAgICAgICAgcmV0dXJuIG0uZW5yb2xsVHJ1c3RlZERldmljZSgpXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFZhbGlkYXRlIHRoYXQgdGhlIGFjdGl2ZSB0b2tlbidzIG9yZyBtYXRjaGVzIGZvcmNlTG9naW5PcmdVVUlEIChpZiBzZXRcbiAgICAgICAgLy8gaW4gbWFuYWdlZCBzZXR0aW5ncykuIFJ1bnMgYWZ0ZXIgb25ib2FyZGluZyBzbyBtYW5hZ2VkIHNldHRpbmdzIGFuZFxuICAgICAgICAvLyBsb2dpbiBzdGF0ZSBhcmUgZnVsbHkgbG9hZGVkLlxuICAgICAgICBjb25zdCBvcmdWYWxpZGF0aW9uID0gYXdhaXQgdmFsaWRhdGVGb3JjZUxvZ2luT3JnKClcbiAgICAgICAgaWYgKCFvcmdWYWxpZGF0aW9uLnZhbGlkKSB7XG4gICAgICAgICAgYXdhaXQgZXhpdFdpdGhFcnJvcihyb290LCBvcmdWYWxpZGF0aW9uLm1lc3NhZ2UpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gSWYgZ3JhY2VmdWxTaHV0ZG93biB3YXMgaW5pdGlhdGVkIChlLmcuLCB1c2VyIHJlamVjdGVkIHRydXN0IGRpYWxvZyksXG4gICAgICAvLyBwcm9jZXNzLmV4aXRDb2RlIHdpbGwgYmUgc2V0LiBTa2lwIGFsbCBzdWJzZXF1ZW50IG9wZXJhdGlvbnMgdGhhdCBjb3VsZFxuICAgICAgLy8gdHJpZ2dlciBjb2RlIGV4ZWN1dGlvbiBiZWZvcmUgdGhlIHByb2Nlc3MgZXhpdHMgKGUuZy4gd2UgZG9uJ3Qgd2FudCBhcGlLZXlIZWxwZXJcbiAgICAgIC8vIHRvIHJ1biBpZiB0cnVzdCB3YXMgbm90IGVzdGFibGlzaGVkKS5cbiAgICAgIGlmIChwcm9jZXNzLmV4aXRDb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgICdHcmFjZWZ1bCBzaHV0ZG93biBpbml0aWF0ZWQsIHNraXBwaW5nIGZ1cnRoZXIgaW5pdGlhbGl6YXRpb24nLFxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBJbml0aWFsaXplIExTUCBtYW5hZ2VyIEFGVEVSIHRydXN0IGlzIGVzdGFibGlzaGVkIChvciBpbiBub24taW50ZXJhY3RpdmUgbW9kZVxuICAgICAgLy8gd2hlcmUgdHJ1c3QgaXMgaW1wbGljaXQpLiBUaGlzIHByZXZlbnRzIHBsdWdpbiBMU1Agc2VydmVycyBmcm9tIGV4ZWN1dGluZ1xuICAgICAgLy8gY29kZSBpbiB1bnRydXN0ZWQgZGlyZWN0b3JpZXMgYmVmb3JlIHVzZXIgY29uc2VudC5cbiAgICAgIC8vIE11c3QgYmUgYWZ0ZXIgaW5saW5lIHBsdWdpbnMgYXJlIHNldCAoaWYgYW55KSBzbyAtLXBsdWdpbi1kaXIgTFNQIHNlcnZlcnMgYXJlIGluY2x1ZGVkLlxuICAgICAgaW5pdGlhbGl6ZUxzcFNlcnZlck1hbmFnZXIoKVxuXG4gICAgICAvLyBTaG93IHNldHRpbmdzIHZhbGlkYXRpb24gZXJyb3JzIGFmdGVyIHRydXN0IGlzIGVzdGFibGlzaGVkXG4gICAgICAvLyBNQ1AgY29uZmlnIGVycm9ycyBkb24ndCBibG9jayBzZXR0aW5ncyBmcm9tIGxvYWRpbmcsIHNvIGV4Y2x1ZGUgdGhlbVxuICAgICAgaWYgKCFpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICBjb25zdCB7IGVycm9ycyB9ID0gZ2V0U2V0dGluZ3NXaXRoRXJyb3JzKClcbiAgICAgICAgY29uc3Qgbm9uTWNwRXJyb3JzID0gZXJyb3JzLmZpbHRlcihlID0+ICFlLm1jcEVycm9yTWV0YWRhdGEpXG4gICAgICAgIGlmIChub25NY3BFcnJvcnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGF3YWl0IGxhdW5jaEludmFsaWRTZXR0aW5nc0RpYWxvZyhyb290LCB7XG4gICAgICAgICAgICBzZXR0aW5nc0Vycm9yczogbm9uTWNwRXJyb3JzLFxuICAgICAgICAgICAgb25FeGl0OiAoKSA9PiBncmFjZWZ1bFNodXRkb3duU3luYygxKSxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIHF1b3RhIHN0YXR1cywgZmFzdCBtb2RlLCBwYXNzZXMgZWxpZ2liaWxpdHksIGFuZCBib290c3RyYXAgZGF0YVxuICAgICAgLy8gYWZ0ZXIgdHJ1c3QgaXMgZXN0YWJsaXNoZWQuIFRoZXNlIG1ha2UgQVBJIGNhbGxzIHdoaWNoIGNvdWxkIHRyaWdnZXJcbiAgICAgIC8vIGFwaUtleUhlbHBlciBleGVjdXRpb24uXG4gICAgICAvLyAtLWJhcmUgLyBTSU1QTEU6IHNraXAg4oCUIHRoZXNlIGFyZSBjYWNoZS13YXJtcyBmb3IgdGhlIFJFUEwnc1xuICAgICAgLy8gZmlyc3QtdHVybiByZXNwb25zaXZlbmVzcyAocXVvdGEsIHBhc3NlcywgZmFzdE1vZGUsIGJvb3RzdHJhcCBkYXRhKS4gRmFzdFxuICAgICAgLy8gbW9kZSBkb2Vzbid0IGFwcGx5IHRvIHRoZSBBZ2VudCBTREsgYW55d2F5IChzZWUgZ2V0RmFzdE1vZGVVbmF2YWlsYWJsZVJlYXNvbikuXG4gICAgICBjb25zdCBiZ1JlZnJlc2hUaHJvdHRsZU1zID0gZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUoXG4gICAgICAgICd0ZW5ndV9jaWNhZGFfbmFwX21zJyxcbiAgICAgICAgMCxcbiAgICAgIClcbiAgICAgIGNvbnN0IGxhc3RQcmVmZXRjaGVkID0gZ2V0R2xvYmFsQ29uZmlnKCkuc3RhcnR1cFByZWZldGNoZWRBdCA/PyAwXG4gICAgICBjb25zdCBza2lwU3RhcnR1cFByZWZldGNoZXMgPVxuICAgICAgICBpc0JhcmVNb2RlKCkgfHxcbiAgICAgICAgKGJnUmVmcmVzaFRocm90dGxlTXMgPiAwICYmXG4gICAgICAgICAgRGF0ZS5ub3coKSAtIGxhc3RQcmVmZXRjaGVkIDwgYmdSZWZyZXNoVGhyb3R0bGVNcylcblxuICAgICAgaWYgKCFza2lwU3RhcnR1cFByZWZldGNoZXMpIHtcbiAgICAgICAgY29uc3QgbGFzdFByZWZldGNoZWRJbmZvID1cbiAgICAgICAgICBsYXN0UHJlZmV0Y2hlZCA+IDBcbiAgICAgICAgICAgID8gYCBsYXN0IHJhbiAke01hdGgucm91bmQoKERhdGUubm93KCkgLSBsYXN0UHJlZmV0Y2hlZCkgLyAxMDAwKX1zIGFnb2BcbiAgICAgICAgICAgIDogJydcbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgIGBTdGFydGluZyBiYWNrZ3JvdW5kIHN0YXJ0dXAgcHJlZmV0Y2hlcyR7bGFzdFByZWZldGNoZWRJbmZvfWAsXG4gICAgICAgIClcblxuICAgICAgICBjaGVja1F1b3RhU3RhdHVzKCkuY2F0Y2goZXJyb3IgPT4gbG9nRXJyb3IoZXJyb3IpKVxuXG4gICAgICAgIC8vIEZldGNoIGJvb3RzdHJhcCBkYXRhIGZyb20gdGhlIHNlcnZlciBhbmQgdXBkYXRlIGFsbCBjYWNoZSB2YWx1ZXMuXG4gICAgICAgIHZvaWQgZmV0Y2hCb290c3RyYXBEYXRhKClcblxuICAgICAgICAvLyBUT0RPOiBDb25zb2xpZGF0ZSBvdGhlciBwcmVmZXRjaGVzIGludG8gYSBzaW5nbGUgYm9vdHN0cmFwIHJlcXVlc3QuXG4gICAgICAgIHZvaWQgcHJlZmV0Y2hQYXNzZXNFbGlnaWJpbGl0eSgpXG4gICAgICAgIGlmIChcbiAgICAgICAgICAhZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUoJ3Rlbmd1X21pcmFjdWxvX3RoZV9iYXJkJywgZmFsc2UpXG4gICAgICAgICkge1xuICAgICAgICAgIHZvaWQgcHJlZmV0Y2hGYXN0TW9kZVN0YXR1cygpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gS2lsbCBzd2l0Y2ggc2tpcHMgdGhlIG5ldHdvcmsgY2FsbCwgbm90IG9yZy1wb2xpY3kgZW5mb3JjZW1lbnQuXG4gICAgICAgICAgLy8gUmVzb2x2ZSBmcm9tIGNhY2hlIHNvIG9yZ1N0YXR1cyBkb2Vzbid0IHN0YXkgJ3BlbmRpbmcnICh3aGljaFxuICAgICAgICAgIC8vIGdldEZhc3RNb2RlVW5hdmFpbGFibGVSZWFzb24gdHJlYXRzIGFzIHBlcm1pc3NpdmUpLlxuICAgICAgICAgIHJlc29sdmVGYXN0TW9kZVN0YXR1c0Zyb21DYWNoZSgpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGJnUmVmcmVzaFRocm90dGxlTXMgPiAwKSB7XG4gICAgICAgICAgc2F2ZUdsb2JhbENvbmZpZyhjdXJyZW50ID0+ICh7XG4gICAgICAgICAgICAuLi5jdXJyZW50LFxuICAgICAgICAgICAgc3RhcnR1cFByZWZldGNoZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICB9KSlcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgIGBTa2lwcGluZyBzdGFydHVwIHByZWZldGNoZXMsIGxhc3QgcmFuICR7TWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGxhc3RQcmVmZXRjaGVkKSAvIDEwMDApfXMgYWdvYCxcbiAgICAgICAgKVxuICAgICAgICAvLyBSZXNvbHZlIGZhc3QgbW9kZSBvcmcgc3RhdHVzIGZyb20gY2FjaGUgKG5vIG5ldHdvcmspXG4gICAgICAgIHJlc29sdmVGYXN0TW9kZVN0YXR1c0Zyb21DYWNoZSgpXG4gICAgICB9XG5cbiAgICAgIGlmICghaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24pIHtcbiAgICAgICAgdm9pZCByZWZyZXNoRXhhbXBsZUNvbW1hbmRzKCkgLy8gUHJlLWZldGNoIGV4YW1wbGUgY29tbWFuZHMgKHJ1bnMgZ2l0IGxvZywgbm8gQVBJIGNhbGwpXG4gICAgICB9XG5cbiAgICAgIC8vIFJlc29sdmUgTUNQIGNvbmZpZ3MgKHN0YXJ0ZWQgZWFybHksIG92ZXJsYXBzIHdpdGggc2V0dXAvdHJ1c3QgZGlhbG9nIHdvcmspXG4gICAgICBjb25zdCB7IHNlcnZlcnM6IGV4aXN0aW5nTWNwQ29uZmlncyB9ID0gYXdhaXQgbWNwQ29uZmlnUHJvbWlzZVxuICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICBgW1NUQVJUVVBdIE1DUCBjb25maWdzIHJlc29sdmVkIGluICR7bWNwQ29uZmlnUmVzb2x2ZWRNc31tcyAoYXdhaXRlZCBhdCArJHtEYXRlLm5vdygpIC0gbWNwQ29uZmlnU3RhcnR9bXMpYCxcbiAgICAgIClcbiAgICAgIC8vIENMSSBmbGFnICgtLW1jcC1jb25maWcpIHNob3VsZCBvdmVycmlkZSBmaWxlLWJhc2VkIGNvbmZpZ3MsIG1hdGNoaW5nIHNldHRpbmdzIHByZWNlZGVuY2VcbiAgICAgIGNvbnN0IGFsbE1jcENvbmZpZ3MgPSB7IC4uLmV4aXN0aW5nTWNwQ29uZmlncywgLi4uZHluYW1pY01jcENvbmZpZyB9XG5cbiAgICAgIC8vIFNlcGFyYXRlIFNESyBjb25maWdzIGZyb20gcmVndWxhciBNQ1AgY29uZmlnc1xuICAgICAgY29uc3Qgc2RrTWNwQ29uZmlnczogUmVjb3JkPHN0cmluZywgTWNwU2RrU2VydmVyQ29uZmlnPiA9IHt9XG4gICAgICBjb25zdCByZWd1bGFyTWNwQ29uZmlnczogUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPiA9IHt9XG5cbiAgICAgIGZvciAoY29uc3QgW25hbWUsIGNvbmZpZ10gb2YgT2JqZWN0LmVudHJpZXMoYWxsTWNwQ29uZmlncykpIHtcbiAgICAgICAgY29uc3QgdHlwZWRDb25maWcgPSBjb25maWcgYXMgU2NvcGVkTWNwU2VydmVyQ29uZmlnIHwgTWNwU2RrU2VydmVyQ29uZmlnXG4gICAgICAgIGlmICh0eXBlZENvbmZpZy50eXBlID09PSAnc2RrJykge1xuICAgICAgICAgIHNka01jcENvbmZpZ3NbbmFtZV0gPSB0eXBlZENvbmZpZyBhcyBNY3BTZGtTZXJ2ZXJDb25maWdcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZWd1bGFyTWNwQ29uZmlnc1tuYW1lXSA9IHR5cGVkQ29uZmlnIGFzIFNjb3BlZE1jcFNlcnZlckNvbmZpZ1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25fbWNwX2NvbmZpZ3NfbG9hZGVkJylcblxuICAgICAgLy8gUHJlZmV0Y2ggTUNQIHJlc291cmNlcyBhZnRlciB0cnVzdCBkaWFsb2cgKHRoaXMgaXMgd2hlcmUgZXhlY3V0aW9uIGhhcHBlbnMpLlxuICAgICAgLy8gSW50ZXJhY3RpdmUgbW9kZSBvbmx5OiBwcmludCBtb2RlIGRlZmVycyBjb25uZWN0cyB1bnRpbCBoZWFkbGVzc1N0b3JlIGV4aXN0c1xuICAgICAgLy8gYW5kIHB1c2hlcyBwZXItc2VydmVyIChiZWxvdyksIHNvIFRvb2xTZWFyY2gncyBwZW5kaW5nLWNsaWVudCBoYW5kbGluZyB3b3Jrc1xuICAgICAgLy8gYW5kIG9uZSBzbG93IHNlcnZlciBkb2Vzbid0IGJsb2NrIHRoZSBiYXRjaC5cbiAgICAgIGNvbnN0IGxvY2FsTWNwUHJvbWlzZSA9IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uXG4gICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKHsgY2xpZW50czogW10sIHRvb2xzOiBbXSwgY29tbWFuZHM6IFtdIH0pXG4gICAgICAgIDogcHJlZmV0Y2hBbGxNY3BSZXNvdXJjZXMocmVndWxhck1jcENvbmZpZ3MpXG4gICAgICBjb25zdCBjbGF1ZGVhaU1jcFByb21pc2UgPSBpc05vbkludGVyYWN0aXZlU2Vzc2lvblxuICAgICAgICA/IFByb21pc2UucmVzb2x2ZSh7IGNsaWVudHM6IFtdLCB0b29sczogW10sIGNvbW1hbmRzOiBbXSB9KVxuICAgICAgICA6IGNsYXVkZWFpQ29uZmlnUHJvbWlzZS50aGVuKGNvbmZpZ3MgPT5cbiAgICAgICAgICAgIE9iamVjdC5rZXlzKGNvbmZpZ3MpLmxlbmd0aCA+IDBcbiAgICAgICAgICAgICAgPyBwcmVmZXRjaEFsbE1jcFJlc291cmNlcyhjb25maWdzKVxuICAgICAgICAgICAgICA6IHsgY2xpZW50czogW10sIHRvb2xzOiBbXSwgY29tbWFuZHM6IFtdIH0sXG4gICAgICAgICAgKVxuICAgICAgLy8gTWVyZ2Ugd2l0aCBkZWR1cCBieSBuYW1lOiBlYWNoIHByZWZldGNoQWxsTWNwUmVzb3VyY2VzIGNhbGwgaW5kZXBlbmRlbnRseVxuICAgICAgLy8gYWRkcyBoZWxwZXIgdG9vbHMgKExpc3RNY3BSZXNvdXJjZXNUb29sLCBSZWFkTWNwUmVzb3VyY2VUb29sKSB2aWFcbiAgICAgIC8vIGxvY2FsIGRlZHVwIGZsYWdzLCBzbyBtZXJnaW5nIHR3byBjYWxscyBjYW4geWllbGQgZHVwbGljYXRlcy4gcHJpbnQudHNcbiAgICAgIC8vIGFscmVhZHkgdW5pcUJ5J3MgdGhlIGZpbmFsIHRvb2wgcG9vbCwgYnV0IGRlZHVwIGhlcmUga2VlcHMgYXBwU3RhdGUgY2xlYW4uXG4gICAgICBjb25zdCBtY3BQcm9taXNlID0gUHJvbWlzZS5hbGwoW1xuICAgICAgICBsb2NhbE1jcFByb21pc2UsXG4gICAgICAgIGNsYXVkZWFpTWNwUHJvbWlzZSxcbiAgICAgIF0pLnRoZW4oKFtsb2NhbCwgY2xhdWRlYWldKSA9PiAoe1xuICAgICAgICBjbGllbnRzOiBbLi4ubG9jYWwuY2xpZW50cywgLi4uY2xhdWRlYWkuY2xpZW50c10sXG4gICAgICAgIHRvb2xzOiB1bmlxQnkoWy4uLmxvY2FsLnRvb2xzLCAuLi5jbGF1ZGVhaS50b29sc10sICduYW1lJyksXG4gICAgICAgIGNvbW1hbmRzOiB1bmlxQnkoWy4uLmxvY2FsLmNvbW1hbmRzLCAuLi5jbGF1ZGVhaS5jb21tYW5kc10sICduYW1lJyksXG4gICAgICB9KSlcblxuICAgICAgLy8gU3RhcnQgaG9va3MgZWFybHkgc28gdGhleSBydW4gaW4gcGFyYWxsZWwgd2l0aCBNQ1AgY29ubmVjdGlvbnMuXG4gICAgICAvLyBTa2lwIGZvciBpbml0T25seS9pbml0L21haW50ZW5hbmNlIChoYW5kbGVkIHNlcGFyYXRlbHkpLCBub24taW50ZXJhY3RpdmVcbiAgICAgIC8vIChoYW5kbGVkIHZpYSBzZXR1cFRyaWdnZXIpLCBhbmQgcmVzdW1lL2NvbnRpbnVlIChjb252ZXJzYXRpb25SZWNvdmVyeS50c1xuICAgICAgLy8gZmlyZXMgJ3Jlc3VtZScgaW5zdGVhZCDigJQgd2l0aG91dCB0aGlzIGd1YXJkLCBob29rcyBmaXJlIFRXSUNFIG9uIC9yZXN1bWVcbiAgICAgIC8vIGFuZCB0aGUgc2Vjb25kIHN5c3RlbU1lc3NhZ2UgY2xvYmJlcnMgdGhlIGZpcnN0LiBnaC0zMDgyNSlcbiAgICAgIGNvbnN0IGhvb2tzUHJvbWlzZSA9XG4gICAgICAgIGluaXRPbmx5IHx8XG4gICAgICAgIGluaXQgfHxcbiAgICAgICAgbWFpbnRlbmFuY2UgfHxcbiAgICAgICAgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gfHxcbiAgICAgICAgb3B0aW9ucy5jb250aW51ZSB8fFxuICAgICAgICBvcHRpb25zLnJlc3VtZVxuICAgICAgICAgID8gbnVsbFxuICAgICAgICAgIDogcHJvY2Vzc1Nlc3Npb25TdGFydEhvb2tzKCdzdGFydHVwJywge1xuICAgICAgICAgICAgICBhZ2VudFR5cGU6IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24/LmFnZW50VHlwZSxcbiAgICAgICAgICAgICAgbW9kZWw6IHJlc29sdmVkSW5pdGlhbE1vZGVsLFxuICAgICAgICAgICAgfSlcblxuICAgICAgLy8gTUNQIG5ldmVyIGJsb2NrcyBSRVBMIHJlbmRlciBPUiB0dXJuIDEgVFRGVC4gdXNlTWFuYWdlTUNQQ29ubmVjdGlvbnNcbiAgICAgIC8vIHBvcHVsYXRlcyBhcHBTdGF0ZS5tY3AgYXN5bmMgYXMgc2VydmVycyBjb25uZWN0IChjb25uZWN0VG9TZXJ2ZXIgaXNcbiAgICAgIC8vIG1lbW9pemVkIOKAlCB0aGUgcHJlZmV0Y2ggY2FsbHMgYWJvdmUgYW5kIHRoZSBob29rIGNvbnZlcmdlIG9uIHRoZSBzYW1lXG4gICAgICAvLyBjb25uZWN0aW9ucykuIGdldFRvb2xVc2VDb250ZXh0IHJlYWRzIHN0b3JlLmdldFN0YXRlKCkgZnJlc2ggdmlhXG4gICAgICAvLyBjb21wdXRlVG9vbHMoKSwgc28gdHVybiAxIHNlZXMgd2hhdGV2ZXIncyBjb25uZWN0ZWQgYnkgcXVlcnkgdGltZS5cbiAgICAgIC8vIFNsb3cgc2VydmVycyBwb3B1bGF0ZSBmb3IgdHVybiAyKy4gTWF0Y2hlcyBpbnRlcmFjdGl2ZS1uby1wcm9tcHRcbiAgICAgIC8vIGJlaGF2aW9yLiBQcmludCBtb2RlOiBwZXItc2VydmVyIHB1c2ggaW50byBoZWFkbGVzc1N0b3JlIChiZWxvdykuXG4gICAgICBjb25zdCBob29rTWVzc2FnZXM6IEF3YWl0ZWQ8Tm9uTnVsbGFibGU8dHlwZW9mIGhvb2tzUHJvbWlzZT4+ID0gW11cbiAgICAgIC8vIFN1cHByZXNzIHRyYW5zaWVudCB1bmhhbmRsZWRSZWplY3Rpb24g4oCUIHRoZSBwcmVmZXRjaCB3YXJtcyB0aGVcbiAgICAgIC8vIG1lbW9pemVkIGNvbm5lY3RUb1NlcnZlciBjYWNoZSBidXQgbm9ib2R5IGF3YWl0cyBpdCBpbiBpbnRlcmFjdGl2ZS5cbiAgICAgIG1jcFByb21pc2UuY2F0Y2goKCkgPT4ge30pXG5cbiAgICAgIGNvbnN0IG1jcENsaWVudHM6IEF3YWl0ZWQ8dHlwZW9mIG1jcFByb21pc2U+WydjbGllbnRzJ10gPSBbXVxuICAgICAgY29uc3QgbWNwVG9vbHM6IEF3YWl0ZWQ8dHlwZW9mIG1jcFByb21pc2U+Wyd0b29scyddID0gW11cbiAgICAgIGNvbnN0IG1jcENvbW1hbmRzOiBBd2FpdGVkPHR5cGVvZiBtY3BQcm9taXNlPlsnY29tbWFuZHMnXSA9IFtdXG5cbiAgICAgIGxldCB0aGlua2luZ0VuYWJsZWQgPSBzaG91bGRFbmFibGVUaGlua2luZ0J5RGVmYXVsdCgpXG4gICAgICBsZXQgdGhpbmtpbmdDb25maWc6IFRoaW5raW5nQ29uZmlnID1cbiAgICAgICAgdGhpbmtpbmdFbmFibGVkICE9PSBmYWxzZSA/IHsgdHlwZTogJ2FkYXB0aXZlJyB9IDogeyB0eXBlOiAnZGlzYWJsZWQnIH1cblxuICAgICAgaWYgKG9wdGlvbnMudGhpbmtpbmcgPT09ICdhZGFwdGl2ZScgfHwgb3B0aW9ucy50aGlua2luZyA9PT0gJ2VuYWJsZWQnKSB7XG4gICAgICAgIHRoaW5raW5nRW5hYmxlZCA9IHRydWVcbiAgICAgICAgdGhpbmtpbmdDb25maWcgPSB7IHR5cGU6ICdhZGFwdGl2ZScgfVxuICAgICAgfSBlbHNlIGlmIChvcHRpb25zLnRoaW5raW5nID09PSAnZGlzYWJsZWQnKSB7XG4gICAgICAgIHRoaW5raW5nRW5hYmxlZCA9IGZhbHNlXG4gICAgICAgIHRoaW5raW5nQ29uZmlnID0geyB0eXBlOiAnZGlzYWJsZWQnIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG1heFRoaW5raW5nVG9rZW5zID0gcHJvY2Vzcy5lbnYuTUFYX1RISU5LSU5HX1RPS0VOU1xuICAgICAgICAgID8gcGFyc2VJbnQocHJvY2Vzcy5lbnYuTUFYX1RISU5LSU5HX1RPS0VOUywgMTApXG4gICAgICAgICAgOiBvcHRpb25zLm1heFRoaW5raW5nVG9rZW5zXG4gICAgICAgIGlmIChtYXhUaGlua2luZ1Rva2VucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgaWYgKG1heFRoaW5raW5nVG9rZW5zID4gMCkge1xuICAgICAgICAgICAgdGhpbmtpbmdFbmFibGVkID0gdHJ1ZVxuICAgICAgICAgICAgdGhpbmtpbmdDb25maWcgPSB7XG4gICAgICAgICAgICAgIHR5cGU6ICdlbmFibGVkJyxcbiAgICAgICAgICAgICAgYnVkZ2V0VG9rZW5zOiBtYXhUaGlua2luZ1Rva2VucyxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKG1heFRoaW5raW5nVG9rZW5zID09PSAwKSB7XG4gICAgICAgICAgICB0aGlua2luZ0VuYWJsZWQgPSBmYWxzZVxuICAgICAgICAgICAgdGhpbmtpbmdDb25maWcgPSB7IHR5cGU6ICdkaXNhYmxlZCcgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBsb2dGb3JEaWFnbm9zdGljc05vUElJKCdpbmZvJywgJ3N0YXJ0ZWQnLCB7XG4gICAgICAgIHZlcnNpb246IE1BQ1JPLlZFUlNJT04sXG4gICAgICAgIGlzX25hdGl2ZV9iaW5hcnk6IGlzSW5CdW5kbGVkTW9kZSgpLFxuICAgICAgfSlcblxuICAgICAgcmVnaXN0ZXJDbGVhbnVwKGFzeW5jICgpID0+IHtcbiAgICAgICAgbG9nRm9yRGlhZ25vc3RpY3NOb1BJSSgnaW5mbycsICdleGl0ZWQnKVxuICAgICAgfSlcblxuICAgICAgdm9pZCBsb2dUZW5ndUluaXQoe1xuICAgICAgICBoYXNJbml0aWFsUHJvbXB0OiBCb29sZWFuKHByb21wdCksXG4gICAgICAgIGhhc1N0ZGluOiBCb29sZWFuKGlucHV0UHJvbXB0KSxcbiAgICAgICAgdmVyYm9zZSxcbiAgICAgICAgZGVidWcsXG4gICAgICAgIGRlYnVnVG9TdGRlcnIsXG4gICAgICAgIHByaW50OiBwcmludCA/PyBmYWxzZSxcbiAgICAgICAgb3V0cHV0Rm9ybWF0OiBvdXRwdXRGb3JtYXQgPz8gJ3RleHQnLFxuICAgICAgICBpbnB1dEZvcm1hdDogaW5wdXRGb3JtYXQgPz8gJ3RleHQnLFxuICAgICAgICBudW1BbGxvd2VkVG9vbHM6IGFsbG93ZWRUb29scy5sZW5ndGgsXG4gICAgICAgIG51bURpc2FsbG93ZWRUb29sczogZGlzYWxsb3dlZFRvb2xzLmxlbmd0aCxcbiAgICAgICAgbWNwQ2xpZW50Q291bnQ6IE9iamVjdC5rZXlzKGFsbE1jcENvbmZpZ3MpLmxlbmd0aCxcbiAgICAgICAgd29ya3RyZWVFbmFibGVkLFxuICAgICAgICBza2lwV2ViRmV0Y2hQcmVmbGlnaHQ6IGdldEluaXRpYWxTZXR0aW5ncygpLnNraXBXZWJGZXRjaFByZWZsaWdodCxcbiAgICAgICAgZ2l0aHViQWN0aW9uSW5wdXRzOiBwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OX0lOUFVUUyxcbiAgICAgICAgZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNQYXNzZWQ6IGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zID8/IGZhbHNlLFxuICAgICAgICBwZXJtaXNzaW9uTW9kZSxcbiAgICAgICAgbW9kZUlzQnlwYXNzOiBwZXJtaXNzaW9uTW9kZSA9PT0gJ2J5cGFzc1Blcm1pc3Npb25zJyxcbiAgICAgICAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZDogYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcbiAgICAgICAgc3lzdGVtUHJvbXB0RmxhZzogc3lzdGVtUHJvbXB0XG4gICAgICAgICAgPyBvcHRpb25zLnN5c3RlbVByb21wdEZpbGVcbiAgICAgICAgICAgID8gJ2ZpbGUnXG4gICAgICAgICAgICA6ICdmbGFnJ1xuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnOiBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICA/IG9wdGlvbnMuYXBwZW5kU3lzdGVtUHJvbXB0RmlsZVxuICAgICAgICAgICAgPyAnZmlsZSdcbiAgICAgICAgICAgIDogJ2ZsYWcnXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIHRoaW5raW5nQ29uZmlnLFxuICAgICAgICBhc3Npc3RhbnRBY3RpdmF0aW9uUGF0aDpcbiAgICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSAmJiBrYWlyb3NFbmFibGVkXG4gICAgICAgICAgICA/IGFzc2lzdGFudE1vZHVsZT8uZ2V0QXNzaXN0YW50QWN0aXZhdGlvblBhdGgoKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KVxuXG4gICAgICAvLyBMb2cgY29udGV4dCBtZXRyaWNzIG9uY2UgYXQgaW5pdGlhbGl6YXRpb25cbiAgICAgIHZvaWQgbG9nQ29udGV4dE1ldHJpY3MocmVndWxhck1jcENvbmZpZ3MsIHRvb2xQZXJtaXNzaW9uQ29udGV4dClcblxuICAgICAgdm9pZCBsb2dQZXJtaXNzaW9uQ29udGV4dEZvckFudHMobnVsbCwgJ2luaXRpYWxpemF0aW9uJylcblxuICAgICAgbG9nTWFuYWdlZFNldHRpbmdzKClcblxuICAgICAgLy8gUmVnaXN0ZXIgUElEIGZpbGUgZm9yIGNvbmN1cnJlbnQtc2Vzc2lvbiBkZXRlY3Rpb24gKH4vLm9wZW5jbGF1ZGUvc2Vzc2lvbnMvKVxuICAgICAgLy8gYW5kIGZpcmUgbXVsdGktY2xhdWRpbmcgdGVsZW1ldHJ5LiBMaXZlcyBoZXJlIChub3QgaW5pdC50cykgc28gb25seSB0aGVcbiAgICAgIC8vIFJFUEwgcGF0aCByZWdpc3RlcnMg4oCUIG5vdCBzdWJjb21tYW5kcyBsaWtlIGBjbGF1ZGUgZG9jdG9yYC4gQ2hhaW5lZDpcbiAgICAgIC8vIGNvdW50IG11c3QgcnVuIGFmdGVyIHJlZ2lzdGVyJ3Mgd3JpdGUgY29tcGxldGVzIG9yIGl0IG1pc3NlcyBvdXIgb3duIGZpbGUuXG4gICAgICB2b2lkIHJlZ2lzdGVyU2Vzc2lvbigpLnRoZW4ocmVnaXN0ZXJlZCA9PiB7XG4gICAgICAgIGlmICghcmVnaXN0ZXJlZCkgcmV0dXJuXG4gICAgICAgIGlmIChzZXNzaW9uTmFtZUFyZykge1xuICAgICAgICAgIHZvaWQgdXBkYXRlU2Vzc2lvbk5hbWUoc2Vzc2lvbk5hbWVBcmcpXG4gICAgICAgIH1cbiAgICAgICAgdm9pZCBjb3VudENvbmN1cnJlbnRTZXNzaW9ucygpLnRoZW4oY291bnQgPT4ge1xuICAgICAgICAgIGlmIChjb3VudCA+PSAyKSB7XG4gICAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY29uY3VycmVudF9zZXNzaW9ucycsIHsgbnVtX3Nlc3Npb25zOiBjb3VudCB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIC8vIEluaXRpYWxpemUgdmVyc2lvbmVkIHBsdWdpbnMgc3lzdGVtICh0cmlnZ2VycyBWMeKGklYyIG1pZ3JhdGlvbiBpZlxuICAgICAgLy8gbmVlZGVkKS4gVGhlbiBydW4gb3JwaGFuIEdDLCBUSEVOIHdhcm0gdGhlIEdyZXAvR2xvYiBleGNsdXNpb24gY2FjaGUuXG4gICAgICAvLyBTZXF1ZW5jaW5nIG1hdHRlcnM6IHRoZSB3YXJtdXAgc2NhbnMgZGlzayBmb3IgLm9ycGhhbmVkX2F0IG1hcmtlcnMsXG4gICAgICAvLyBzbyBpdCBtdXN0IHNlZSB0aGUgR0MncyBQYXNzIDEgKHJlbW92ZSBtYXJrZXJzIGZyb20gcmVpbnN0YWxsZWRcbiAgICAgIC8vIHZlcnNpb25zKSBhbmQgUGFzcyAyIChzdGFtcCB1bm1hcmtlZCBvcnBoYW5zKSBhbHJlYWR5IGFwcGxpZWQuIFRoZVxuICAgICAgLy8gd2FybSBhbHNvIGxhbmRzIGJlZm9yZSBhdXRvdXBkYXRlIChmaXJlcyBvbiBmaXJzdCBzdWJtaXQgaW4gUkVQTClcbiAgICAgIC8vIGNhbiBvcnBoYW4gdGhpcyBzZXNzaW9uJ3MgYWN0aXZlIHZlcnNpb24gdW5kZXJuZWF0aCB1cy5cbiAgICAgIC8vIC0tYmFyZSAvIFNJTVBMRTogc2tpcCBwbHVnaW4gdmVyc2lvbiBzeW5jICsgb3JwaGFuIGNsZWFudXAuIFRoZXNlXG4gICAgICAvLyBhcmUgaW5zdGFsbC91cGdyYWRlIGJvb2trZWVwaW5nIHRoYXQgc2NyaXB0ZWQgY2FsbHMgZG9uJ3QgbmVlZCDigJRcbiAgICAgIC8vIHRoZSBuZXh0IGludGVyYWN0aXZlIHNlc3Npb24gd2lsbCByZWNvbmNpbGUuIFRoZSBhd2FpdCBoZXJlIHdhc1xuICAgICAgLy8gYmxvY2tpbmcgLXAgb24gYSBtYXJrZXRwbGFjZSByb3VuZC10cmlwLlxuICAgICAgaWYgKGlzQmFyZU1vZGUoKSkge1xuICAgICAgICAvLyBza2lwIOKAlCBuby1vcFxuICAgICAgfSBlbHNlIGlmIChpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICAvLyBJbiBoZWFkbGVzcyBtb2RlLCBhd2FpdCB0byBlbnN1cmUgcGx1Z2luIHN5bmMgY29tcGxldGVzIGJlZm9yZSBDTEkgZXhpdHNcbiAgICAgICAgYXdhaXQgaW5pdGlhbGl6ZVZlcnNpb25lZFBsdWdpbnMoKVxuICAgICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2FmdGVyX3BsdWdpbnNfaW5pdCcpXG4gICAgICAgIHZvaWQgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQoKS50aGVuKCgpID0+XG4gICAgICAgICAgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSgpLFxuICAgICAgICApXG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBJbiBpbnRlcmFjdGl2ZSBtb2RlLCBmaXJlLWFuZC1mb3JnZXQg4oCUIHRoaXMgaXMgcHVyZWx5IGJvb2trZWVwaW5nXG4gICAgICAgIC8vIHRoYXQgZG9lc24ndCBhZmZlY3QgcnVudGltZSBiZWhhdmlvciBvZiB0aGUgY3VycmVudCBzZXNzaW9uXG4gICAgICAgIHZvaWQgaW5pdGlhbGl6ZVZlcnNpb25lZFBsdWdpbnMoKS50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2FmdGVyX3BsdWdpbnNfaW5pdCcpXG4gICAgICAgICAgYXdhaXQgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQoKVxuICAgICAgICAgIHZvaWQgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSgpXG4gICAgICAgIH0pXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNldHVwVHJpZ2dlciA9XG4gICAgICAgIGluaXRPbmx5IHx8IGluaXQgPyAnaW5pdCcgOiBtYWludGVuYW5jZSA/ICdtYWludGVuYW5jZScgOiBudWxsXG4gICAgICBpZiAoaW5pdE9ubHkpIHtcbiAgICAgICAgYXBwbHlDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcygpXG4gICAgICAgIGF3YWl0IHByb2Nlc3NTZXR1cEhvb2tzKCdpbml0JywgeyBmb3JjZVN5bmNFeGVjdXRpb246IHRydWUgfSlcbiAgICAgICAgYXdhaXQgcHJvY2Vzc1Nlc3Npb25TdGFydEhvb2tzKCdzdGFydHVwJywgeyBmb3JjZVN5bmNFeGVjdXRpb246IHRydWUgfSlcbiAgICAgICAgZ3JhY2VmdWxTaHV0ZG93blN5bmMoMClcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIC8vIC0tcHJpbnQgbW9kZVxuICAgICAgaWYgKGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgIGlmIChvdXRwdXRGb3JtYXQgPT09ICdzdHJlYW0tanNvbicgfHwgb3V0cHV0Rm9ybWF0ID09PSAnanNvbicpIHtcbiAgICAgICAgICBzZXRIYXNGb3JtYXR0ZWRPdXRwdXQodHJ1ZSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFwcGx5IGZ1bGwgZW52aXJvbm1lbnQgdmFyaWFibGVzIGluIHByaW50IG1vZGUgc2luY2UgdHJ1c3QgZGlhbG9nIGlzIGJ5cGFzc2VkXG4gICAgICAgIC8vIFRoaXMgaW5jbHVkZXMgcG90ZW50aWFsbHkgZGFuZ2Vyb3VzIGVudmlyb25tZW50IHZhcmlhYmxlcyBmcm9tIHVudHJ1c3RlZCBzb3VyY2VzXG4gICAgICAgIC8vIGJ1dCBwcmludCBtb2RlIGlzIGNvbnNpZGVyZWQgdHJ1c3RlZCAoYXMgZG9jdW1lbnRlZCBpbiBoZWxwIHRleHQpXG4gICAgICAgIGFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMoKVxuXG4gICAgICAgIC8vIEluaXRpYWxpemUgdGVsZW1ldHJ5IGFmdGVyIGVudiB2YXJzIGFyZSBhcHBsaWVkIHNvIE9URUwgZW5kcG9pbnQgZW52IHZhcnMgYW5kXG4gICAgICAgIC8vIG90ZWxIZWFkZXJzSGVscGVyICh3aGljaCByZXF1aXJlcyB0cnVzdCB0byBleGVjdXRlKSBhcmUgYXZhaWxhYmxlLlxuICAgICAgICBpbml0aWFsaXplVGVsZW1ldHJ5QWZ0ZXJUcnVzdCgpXG5cbiAgICAgICAgLy8gS2ljayBTZXNzaW9uU3RhcnQgaG9va3Mgbm93IHNvIHRoZSBzdWJwcm9jZXNzIHNwYXduIG92ZXJsYXBzIHdpdGhcbiAgICAgICAgLy8gTUNQIGNvbm5lY3QgKyBwbHVnaW4gaW5pdCArIHByaW50LnRzIGltcG9ydCBiZWxvdy4gbG9hZEluaXRpYWxNZXNzYWdlc1xuICAgICAgICAvLyBqb2lucyB0aGlzIGF0IHByaW50LnRzOjQzOTcuIEd1YXJkZWQgc2FtZSBhcyBsb2FkSW5pdGlhbE1lc3NhZ2VzIOKAlFxuICAgICAgICAvLyBjb250aW51ZS9yZXN1bWUvdGVsZXBvcnQgcGF0aHMgZG9uJ3QgZmlyZSBzdGFydHVwIGhvb2tzIChvciBmaXJlIHRoZW1cbiAgICAgICAgLy8gY29uZGl0aW9uYWxseSBpbnNpZGUgdGhlIHJlc3VtZSBicmFuY2gsIHdoZXJlIHRoaXMgcHJvbWlzZSBpc1xuICAgICAgICAvLyB1bmRlZmluZWQgYW5kIHRoZSA/PyBmYWxsYmFjayBydW5zKS4gQWxzbyBza2lwIHdoZW4gc2V0dXBUcmlnZ2VyIGlzXG4gICAgICAgIC8vIHNldCDigJQgdGhvc2UgcGF0aHMgcnVuIHNldHVwIGhvb2tzIGZpcnN0IChwcmludC50czo1NDQpLCBhbmQgc2Vzc2lvblxuICAgICAgICAvLyBzdGFydCBob29rcyBtdXN0IHdhaXQgdW50aWwgc2V0dXAgY29tcGxldGVzLlxuICAgICAgICBjb25zdCBzZXNzaW9uU3RhcnRIb29rc1Byb21pc2UgPVxuICAgICAgICAgIG9wdGlvbnMuY29udGludWUgfHwgb3B0aW9ucy5yZXN1bWUgfHwgdGVsZXBvcnQgfHwgc2V0dXBUcmlnZ2VyXG4gICAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgICAgOiBwcm9jZXNzU2Vzc2lvblN0YXJ0SG9va3MoJ3N0YXJ0dXAnKVxuICAgICAgICAvLyBTdXBwcmVzcyB0cmFuc2llbnQgdW5oYW5kbGVkUmVqZWN0aW9uIGlmIHRoaXMgcmVqZWN0cyBiZWZvcmVcbiAgICAgICAgLy8gbG9hZEluaXRpYWxNZXNzYWdlcyBhd2FpdHMgaXQuIERvd25zdHJlYW0gYXdhaXQgc3RpbGwgb2JzZXJ2ZXMgdGhlXG4gICAgICAgIC8vIHJlamVjdGlvbiDigJQgdGhpcyBqdXN0IHByZXZlbnRzIHRoZSBzcHVyaW91cyBnbG9iYWwgaGFuZGxlciBmaXJlLlxuICAgICAgICBzZXNzaW9uU3RhcnRIb29rc1Byb21pc2U/LmNhdGNoKCgpID0+IHt9KVxuXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdiZWZvcmVfdmFsaWRhdGVGb3JjZUxvZ2luT3JnJylcbiAgICAgICAgLy8gVmFsaWRhdGUgb3JnIHJlc3RyaWN0aW9uIGZvciBub24taW50ZXJhY3RpdmUgc2Vzc2lvbnNcbiAgICAgICAgY29uc3Qgb3JnVmFsaWRhdGlvbiA9IGF3YWl0IHZhbGlkYXRlRm9yY2VMb2dpbk9yZygpXG4gICAgICAgIGlmICghb3JnVmFsaWRhdGlvbi52YWxpZCkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKG9yZ1ZhbGlkYXRpb24ubWVzc2FnZSArICdcXG4nKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSGVhZGxlc3MgbW9kZSBzdXBwb3J0cyBhbGwgcHJvbXB0IGNvbW1hbmRzIGFuZCBzb21lIGxvY2FsIGNvbW1hbmRzXG4gICAgICAgIC8vIElmIGRpc2FibGVTbGFzaENvbW1hbmRzIGlzIHRydWUsIHJldHVybiBlbXB0eSBhcnJheVxuICAgICAgICBjb25zdCBjb21tYW5kc0hlYWRsZXNzID0gZGlzYWJsZVNsYXNoQ29tbWFuZHNcbiAgICAgICAgICA/IFtdXG4gICAgICAgICAgOiBjb21tYW5kcy5maWx0ZXIoXG4gICAgICAgICAgICAgIGNvbW1hbmQgPT5cbiAgICAgICAgICAgICAgICAoY29tbWFuZC50eXBlID09PSAncHJvbXB0JyAmJiAhY29tbWFuZC5kaXNhYmxlTm9uSW50ZXJhY3RpdmUpIHx8XG4gICAgICAgICAgICAgICAgKGNvbW1hbmQudHlwZSA9PT0gJ2xvY2FsJyAmJiBjb21tYW5kLnN1cHBvcnRzTm9uSW50ZXJhY3RpdmUpLFxuICAgICAgICAgICAgKVxuXG4gICAgICAgIGNvbnN0IGRlZmF1bHRTdGF0ZSA9IGdldERlZmF1bHRBcHBTdGF0ZSgpXG4gICAgICAgIGNvbnN0IGhlYWRsZXNzSW5pdGlhbFN0YXRlOiBBcHBTdGF0ZSA9IHtcbiAgICAgICAgICAuLi5kZWZhdWx0U3RhdGUsXG4gICAgICAgICAgbWNwOiB7XG4gICAgICAgICAgICAuLi5kZWZhdWx0U3RhdGUubWNwLFxuICAgICAgICAgICAgY2xpZW50czogbWNwQ2xpZW50cyxcbiAgICAgICAgICAgIGNvbW1hbmRzOiBtY3BDb21tYW5kcyxcbiAgICAgICAgICAgIHRvb2xzOiBtY3BUb29scyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgICBlZmZvcnRWYWx1ZTpcbiAgICAgICAgICAgIHBhcnNlRWZmb3J0VmFsdWUob3B0aW9ucy5lZmZvcnQpID8/IGdldEluaXRpYWxFZmZvcnRTZXR0aW5nKCksXG4gICAgICAgICAgLi4uKGlzRmFzdE1vZGVFbmFibGVkKCkgJiYge1xuICAgICAgICAgICAgZmFzdE1vZGU6IGdldEluaXRpYWxGYXN0TW9kZVNldHRpbmcoZWZmZWN0aXZlTW9kZWwgPz8gbnVsbCksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgLi4uKGlzQWR2aXNvckVuYWJsZWQoKSAmJiBhZHZpc29yTW9kZWwgJiYgeyBhZHZpc29yTW9kZWwgfSksXG4gICAgICAgICAgLy8ga2Fpcm9zRW5hYmxlZCBnYXRlcyB0aGUgYXN5bmMgZmlyZS1hbmQtZm9yZ2V0IHBhdGggaW5cbiAgICAgICAgICAvLyBleGVjdXRlRm9ya2VkU2xhc2hDb21tYW5kIChwcm9jZXNzU2xhc2hDb21tYW5kLnRzeDoxMzIpIGFuZFxuICAgICAgICAgIC8vIEFnZW50VG9vbCdzIHNob3VsZFJ1bkFzeW5jLiBUaGUgUkVQTCBpbml0aWFsU3RhdGUgc2V0cyB0aGlzIGF0XG4gICAgICAgICAgLy8gfjM0NTk7IGhlYWRsZXNzIHdhcyBkZWZhdWx0aW5nIHRvIGZhbHNlLCBzbyB0aGUgZGFlbW9uIGNoaWxkJ3NcbiAgICAgICAgICAvLyBzY2hlZHVsZWQgdGFza3MgYW5kIEFnZW50LXRvb2wgY2FsbHMgcmFuIHN5bmNocm9ub3VzbHkg4oCUIE5cbiAgICAgICAgICAvLyBvdmVyZHVlIGNyb24gdGFza3Mgb24gc3Bhd24gPSBOIHNlcmlhbCBzdWJhZ2VudCB0dXJucyBibG9ja2luZ1xuICAgICAgICAgIC8vIHVzZXIgaW5wdXQuIENvbXB1dGVkIGF0IDoxNjIwLCB3ZWxsIGJlZm9yZSB0aGlzIGJyYW5jaC5cbiAgICAgICAgICAuLi4oZmVhdHVyZSgnS0FJUk9TJykgPyB7IGthaXJvc0VuYWJsZWQgfSA6IHt9KSxcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEluaXQgYXBwIHN0YXRlXG4gICAgICAgIGNvbnN0IGhlYWRsZXNzU3RvcmUgPSBjcmVhdGVTdG9yZShcbiAgICAgICAgICBoZWFkbGVzc0luaXRpYWxTdGF0ZSxcbiAgICAgICAgICBvbkNoYW5nZUFwcFN0YXRlLFxuICAgICAgICApXG5cbiAgICAgICAgLy8gQ2hlY2sgaWYgYnlwYXNzUGVybWlzc2lvbnMgc2hvdWxkIGJlIGRpc2FibGVkIGJhc2VkIG9uIFN0YXRzaWcgZ2F0ZVxuICAgICAgICAvLyBUaGlzIHJ1bnMgaW4gcGFyYWxsZWwgdG8gdGhlIGNvZGUgYmVsb3csIHRvIGF2b2lkIGJsb2NraW5nIHRoZSBtYWluIGxvb3AuXG4gICAgICAgIGlmIChcbiAgICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQubW9kZSA9PT0gJ2J5cGFzc1Blcm1pc3Npb25zJyB8fFxuICAgICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNcbiAgICAgICAgKSB7XG4gICAgICAgICAgdm9pZCBjaGVja0FuZERpc2FibGVCeXBhc3NQZXJtaXNzaW9ucyh0b29sUGVybWlzc2lvbkNvbnRleHQpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBBc3luYyBjaGVjayBvZiBhdXRvIG1vZGUgZ2F0ZSDigJQgY29ycmVjdHMgc3RhdGUgYW5kIGRpc2FibGVzIGF1dG8gaWYgbmVlZGVkLlxuICAgICAgICAvLyBHYXRlZCBvbiBUUkFOU0NSSVBUX0NMQVNTSUZJRVIgKG5vdCBVU0VSX1RZUEUpIHNvIEdyb3d0aEJvb2sga2lsbCBzd2l0Y2ggcnVucyBmb3IgZXh0ZXJuYWwgYnVpbGRzIHRvby5cbiAgICAgICAgaWYgKGZlYXR1cmUoJ1RSQU5TQ1JJUFRfQ0xBU1NJRklFUicpKSB7XG4gICAgICAgICAgdm9pZCB2ZXJpZnlBdXRvTW9kZUdhdGVBY2Nlc3MoXG4gICAgICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQsXG4gICAgICAgICAgICBoZWFkbGVzc1N0b3JlLmdldFN0YXRlKCkuZmFzdE1vZGUsXG4gICAgICAgICAgKS50aGVuKCh7IHVwZGF0ZUNvbnRleHQgfSkgPT4ge1xuICAgICAgICAgICAgaGVhZGxlc3NTdG9yZS5zZXRTdGF0ZShwcmV2ID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dEN0eCA9IHVwZGF0ZUNvbnRleHQocHJldi50b29sUGVybWlzc2lvbkNvbnRleHQpXG4gICAgICAgICAgICAgIGlmIChuZXh0Q3R4ID09PSBwcmV2LnRvb2xQZXJtaXNzaW9uQ29udGV4dCkgcmV0dXJuIHByZXZcbiAgICAgICAgICAgICAgcmV0dXJuIHsgLi4ucHJldiwgdG9vbFBlcm1pc3Npb25Db250ZXh0OiBuZXh0Q3R4IH1cbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNldCBnbG9iYWwgc3RhdGUgZm9yIHNlc3Npb24gcGVyc2lzdGVuY2VcbiAgICAgICAgaWYgKG9wdGlvbnMuc2Vzc2lvblBlcnNpc3RlbmNlID09PSBmYWxzZSkge1xuICAgICAgICAgIHNldFNlc3Npb25QZXJzaXN0ZW5jZURpc2FibGVkKHRydWUpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBTdG9yZSBTREsgYmV0YXMgaW4gZ2xvYmFsIHN0YXRlIGZvciBjb250ZXh0IHdpbmRvdyBjYWxjdWxhdGlvblxuICAgICAgICAvLyBPbmx5IHN0b3JlIGFsbG93ZWQgYmV0YXMgKGZpbHRlcnMgYnkgYWxsb3dsaXN0IGFuZCBzdWJzY3JpYmVyIHN0YXR1cylcbiAgICAgICAgc2V0U2RrQmV0YXMoZmlsdGVyQWxsb3dlZFNka0JldGFzKGJldGFzKSlcblxuICAgICAgICAvLyBQcmludC1tb2RlIE1DUDogcGVyLXNlcnZlciBpbmNyZW1lbnRhbCBwdXNoIGludG8gaGVhZGxlc3NTdG9yZS5cbiAgICAgICAgLy8gTWlycm9ycyB1c2VNYW5hZ2VNQ1BDb25uZWN0aW9ucyDigJQgcHVzaCBwZW5kaW5nIGZpcnN0IChzbyBUb29sU2VhcmNoJ3NcbiAgICAgICAgLy8gcGVuZGluZy1jaGVjayBhdCBUb29sU2VhcmNoVG9vbC50czozMzQgc2VlcyB0aGVtKSwgdGhlbiByZXBsYWNlIHdpdGhcbiAgICAgICAgLy8gY29ubmVjdGVkL2ZhaWxlZCBhcyBlYWNoIHNlcnZlciBzZXR0bGVzLlxuICAgICAgICBjb25zdCBjb25uZWN0TWNwQmF0Y2ggPSAoXG4gICAgICAgICAgY29uZmlnczogUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPixcbiAgICAgICAgICBsYWJlbDogc3RyaW5nLFxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgICAgICBpZiAoT2JqZWN0LmtleXMoY29uZmlncykubGVuZ3RoID09PSAwKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICBoZWFkbGVzc1N0b3JlLnNldFN0YXRlKHByZXYgPT4gKHtcbiAgICAgICAgICAgIC4uLnByZXYsXG4gICAgICAgICAgICBtY3A6IHtcbiAgICAgICAgICAgICAgLi4ucHJldi5tY3AsXG4gICAgICAgICAgICAgIGNsaWVudHM6IFtcbiAgICAgICAgICAgICAgICAuLi5wcmV2Lm1jcC5jbGllbnRzLFxuICAgICAgICAgICAgICAgIC4uLk9iamVjdC5lbnRyaWVzKGNvbmZpZ3MpLm1hcCgoW25hbWUsIGNvbmZpZ10pID0+ICh7XG4gICAgICAgICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgICAgICAgdHlwZTogJ3BlbmRpbmcnIGFzIGNvbnN0LFxuICAgICAgICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgICAgIH0pKSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSkpXG4gICAgICAgICAgcmV0dXJuIGdldE1jcFRvb2xzQ29tbWFuZHNBbmRSZXNvdXJjZXMoXG4gICAgICAgICAgICAoeyBjbGllbnQsIHRvb2xzLCBjb21tYW5kcyB9KSA9PiB7XG4gICAgICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUocHJldiA9PiAoe1xuICAgICAgICAgICAgICAgIC4uLnByZXYsXG4gICAgICAgICAgICAgICAgbWNwOiB7XG4gICAgICAgICAgICAgICAgICAuLi5wcmV2Lm1jcCxcbiAgICAgICAgICAgICAgICAgIGNsaWVudHM6IHByZXYubWNwLmNsaWVudHMuc29tZShjID0+IGMubmFtZSA9PT0gY2xpZW50Lm5hbWUpXG4gICAgICAgICAgICAgICAgICAgID8gcHJldi5tY3AuY2xpZW50cy5tYXAoYyA9PlxuICAgICAgICAgICAgICAgICAgICAgICAgYy5uYW1lID09PSBjbGllbnQubmFtZSA/IGNsaWVudCA6IGMsXG4gICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICA6IFsuLi5wcmV2Lm1jcC5jbGllbnRzLCBjbGllbnRdLFxuICAgICAgICAgICAgICAgICAgdG9vbHM6IHVuaXFCeShbLi4ucHJldi5tY3AudG9vbHMsIC4uLnRvb2xzXSwgJ25hbWUnKSxcbiAgICAgICAgICAgICAgICAgIGNvbW1hbmRzOiB1bmlxQnkoWy4uLnByZXYubWNwLmNvbW1hbmRzLCAuLi5jb21tYW5kc10sICduYW1lJyksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSkpXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgY29uZmlncyxcbiAgICAgICAgICApLmNhdGNoKGVyciA9PlxuICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBbTUNQXSAke2xhYmVsfSBjb25uZWN0IGVycm9yOiAke2Vycn1gKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgLy8gQXdhaXQgYWxsIE1DUCBjb25maWdzIOKAlCBwcmludCBtb2RlIGlzIG9mdGVuIHNpbmdsZS10dXJuLCBzb1xuICAgICAgICAvLyBcImxhdGUtY29ubmVjdGluZyBzZXJ2ZXJzIHZpc2libGUgbmV4dCB0dXJuXCIgZG9lc24ndCBoZWxwLiBTREsgaW5pdFxuICAgICAgICAvLyBtZXNzYWdlIGFuZCB0dXJuLTEgdG9vbCBsaXN0IGJvdGggbmVlZCBjb25maWd1cmVkIE1DUCB0b29scyBwcmVzZW50LlxuICAgICAgICAvLyBaZXJvLXNlcnZlciBjYXNlIGlzIGZyZWUgdmlhIHRoZSBlYXJseSByZXR1cm4gaW4gY29ubmVjdE1jcEJhdGNoLlxuICAgICAgICAvLyBDb25uZWN0b3JzIHBhcmFsbGVsaXplIGluc2lkZSBnZXRNY3BUb29sc0NvbW1hbmRzQW5kUmVzb3VyY2VzXG4gICAgICAgIC8vIChwcm9jZXNzQmF0Y2hlZCB3aXRoIFByb21pc2UuYWxsKS4gY2xhdWRlLmFpIGlzIGF3YWl0ZWQgdG9vIOKAlCBpdHNcbiAgICAgICAgLy8gZmV0Y2ggd2FzIGtpY2tlZCBvZmYgZWFybHkgKGxpbmUgfjI1NTgpIHNvIG9ubHkgcmVzaWR1YWwgdGltZSBibG9ja3NcbiAgICAgICAgLy8gaGVyZS4gLS1iYXJlIHNraXBzIGNsYXVkZS5haSBlbnRpcmVseSBmb3IgcGVyZi1zZW5zaXRpdmUgc2NyaXB0cy5cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2JlZm9yZV9jb25uZWN0TWNwJylcbiAgICAgICAgYXdhaXQgY29ubmVjdE1jcEJhdGNoKHJlZ3VsYXJNY3BDb25maWdzLCAncmVndWxhcicpXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhZnRlcl9jb25uZWN0TWNwJylcbiAgICAgICAgLy8gRGVkdXA6IHN1cHByZXNzIHBsdWdpbiBNQ1Agc2VydmVycyB0aGF0IGR1cGxpY2F0ZSBhIGNsYXVkZS5haVxuICAgICAgICAvLyBjb25uZWN0b3IgKGNvbm5lY3RvciB3aW5zKSwgdGhlbiBjb25uZWN0IGNsYXVkZS5haSBzZXJ2ZXJzLlxuICAgICAgICAvLyBCb3VuZGVkIHdhaXQg4oCUICMyMzcyNSBtYWRlIHRoaXMgYmxvY2tpbmcgc28gc2luZ2xlLXR1cm4gLXAgc2Vlc1xuICAgICAgICAvLyBjb25uZWN0b3JzLCBidXQgd2l0aCA0MCsgc2xvdyBjb25uZWN0b3JzIHRlbmd1X3N0YXJ0dXBfcGVyZiBwOTlcbiAgICAgICAgLy8gY2xpbWJlZCB0byA3NnMuIElmIGZldGNoK2Nvbm5lY3QgZG9lc24ndCBmaW5pc2ggaW4gdGltZSwgcHJvY2VlZDtcbiAgICAgICAgLy8gdGhlIHByb21pc2Uga2VlcHMgcnVubmluZyBhbmQgdXBkYXRlcyBoZWFkbGVzc1N0b3JlIGluIHRoZVxuICAgICAgICAvLyBiYWNrZ3JvdW5kIHNvIHR1cm4gMisgc3RpbGwgc2VlcyBjb25uZWN0b3JzLlxuICAgICAgICBjb25zdCBDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMgPSA1XzAwMFxuICAgICAgICBjb25zdCBjbGF1ZGVhaUNvbm5lY3QgPSBjbGF1ZGVhaUNvbmZpZ1Byb21pc2UudGhlbihjbGF1ZGVhaUNvbmZpZ3MgPT4ge1xuICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhjbGF1ZGVhaUNvbmZpZ3MpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IGNsYXVkZWFpU2lncyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNvbmZpZyBvZiBPYmplY3QudmFsdWVzKGNsYXVkZWFpQ29uZmlncykpIHtcbiAgICAgICAgICAgICAgY29uc3Qgc2lnID0gZ2V0TWNwU2VydmVyU2lnbmF0dXJlKGNvbmZpZylcbiAgICAgICAgICAgICAgaWYgKHNpZykgY2xhdWRlYWlTaWdzLmFkZChzaWcpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBzdXBwcmVzc2VkID0gbmV3IFNldDxzdHJpbmc+KClcbiAgICAgICAgICAgIGZvciAoY29uc3QgW25hbWUsIGNvbmZpZ10gb2YgT2JqZWN0LmVudHJpZXMocmVndWxhck1jcENvbmZpZ3MpKSB7XG4gICAgICAgICAgICAgIGlmICghbmFtZS5zdGFydHNXaXRoKCdwbHVnaW46JykpIGNvbnRpbnVlXG4gICAgICAgICAgICAgIGNvbnN0IHNpZyA9IGdldE1jcFNlcnZlclNpZ25hdHVyZShjb25maWcpXG4gICAgICAgICAgICAgIGlmIChzaWcgJiYgY2xhdWRlYWlTaWdzLmhhcyhzaWcpKSBzdXBwcmVzc2VkLmFkZChuYW1lKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHN1cHByZXNzZWQuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgICAgICAgIGBbTUNQXSBMYXp5IGRlZHVwOiBzdXBwcmVzc2luZyAke3N1cHByZXNzZWQuc2l6ZX0gcGx1Z2luIHNlcnZlcihzKSB0aGF0IGR1cGxpY2F0ZSBjbGF1ZGUuYWkgY29ubmVjdG9yczogJHtbLi4uc3VwcHJlc3NlZF0uam9pbignLCAnKX1gLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIC8vIERpc2Nvbm5lY3QgYmVmb3JlIGZpbHRlcmluZyBmcm9tIHN0YXRlLiBPbmx5IGNvbm5lY3RlZFxuICAgICAgICAgICAgICAvLyBzZXJ2ZXJzIG5lZWQgY2xlYW51cCDigJQgY2xlYXJTZXJ2ZXJDYWNoZSBvbiBhIG5ldmVyLWNvbm5lY3RlZFxuICAgICAgICAgICAgICAvLyBzZXJ2ZXIgdHJpZ2dlcnMgYSByZWFsIGNvbm5lY3QganVzdCB0byBraWxsIGl0IChtZW1vaXplXG4gICAgICAgICAgICAgIC8vIGNhY2hlLW1pc3MgcGF0aCwgc2VlIHVzZU1hbmFnZU1DUENvbm5lY3Rpb25zLnRzOjg3MCkuXG4gICAgICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBoZWFkbGVzc1N0b3JlLmdldFN0YXRlKCkubWNwLmNsaWVudHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXN1cHByZXNzZWQuaGFzKGMubmFtZSkgfHwgYy50eXBlICE9PSAnY29ubmVjdGVkJykgY29udGludWVcbiAgICAgICAgICAgICAgICBjLmNsaWVudC5vbmNsb3NlID0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgdm9pZCBjbGVhclNlcnZlckNhY2hlKGMubmFtZSwgYy5jb25maWcpLmNhdGNoKCgpID0+IHt9KVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUocHJldiA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IHsgY2xpZW50cywgdG9vbHMsIGNvbW1hbmRzLCByZXNvdXJjZXMgfSA9IHByZXYubWNwXG4gICAgICAgICAgICAgICAgY2xpZW50cyA9IGNsaWVudHMuZmlsdGVyKGMgPT4gIXN1cHByZXNzZWQuaGFzKGMubmFtZSkpXG4gICAgICAgICAgICAgICAgdG9vbHMgPSB0b29scy5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICB0ID0+ICF0Lm1jcEluZm8gfHwgIXN1cHByZXNzZWQuaGFzKHQubWNwSW5mby5zZXJ2ZXJOYW1lKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHN1cHByZXNzZWQpIHtcbiAgICAgICAgICAgICAgICAgIGNvbW1hbmRzID0gZXhjbHVkZUNvbW1hbmRzQnlTZXJ2ZXIoY29tbWFuZHMsIG5hbWUpXG4gICAgICAgICAgICAgICAgICByZXNvdXJjZXMgPSBleGNsdWRlUmVzb3VyY2VzQnlTZXJ2ZXIocmVzb3VyY2VzLCBuYW1lKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgLi4ucHJldixcbiAgICAgICAgICAgICAgICAgIG1jcDogeyAuLi5wcmV2Lm1jcCwgY2xpZW50cywgdG9vbHMsIGNvbW1hbmRzLCByZXNvdXJjZXMgfSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFN1cHByZXNzIGNsYXVkZS5haSBjb25uZWN0b3JzIHRoYXQgZHVwbGljYXRlIGFuIGVuYWJsZWRcbiAgICAgICAgICAvLyBtYW51YWwgc2VydmVyIChVUkwtc2lnbmF0dXJlIG1hdGNoKS4gUGx1Z2luIGRlZHVwIGFib3ZlIG9ubHlcbiAgICAgICAgICAvLyBoYW5kbGVzIGBwbHVnaW46KmAga2V5czsgdGhpcyBjYXRjaGVzIG1hbnVhbCBgLm1jcC5qc29uYCBlbnRyaWVzLlxuICAgICAgICAgIC8vIHBsdWdpbjoqIG11c3QgYmUgZXhjbHVkZWQgaGVyZSDigJQgc3RlcCAxIGFscmVhZHkgc3VwcHJlc3NlZFxuICAgICAgICAgIC8vIHRob3NlIChjbGF1ZGUuYWkgd2lucyk7IGxlYXZpbmcgdGhlbSBpbiBzdXBwcmVzc2VzIHRoZVxuICAgICAgICAgIC8vIGNvbm5lY3RvciB0b28sIGFuZCBuZWl0aGVyIHN1cnZpdmVzIChnaC0zOTk3NCkuXG4gICAgICAgICAgY29uc3Qgbm9uUGx1Z2luQ29uZmlncyA9IHBpY2tCeShcbiAgICAgICAgICAgIHJlZ3VsYXJNY3BDb25maWdzLFxuICAgICAgICAgICAgKF8sIG4pID0+ICFuLnN0YXJ0c1dpdGgoJ3BsdWdpbjonKSxcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3QgeyBzZXJ2ZXJzOiBkZWR1cGVkQ2xhdWRlQWkgfSA9IGRlZHVwQ2xhdWRlQWlNY3BTZXJ2ZXJzKFxuICAgICAgICAgICAgY2xhdWRlYWlDb25maWdzLFxuICAgICAgICAgICAgbm9uUGx1Z2luQ29uZmlncyxcbiAgICAgICAgICApXG4gICAgICAgICAgcmV0dXJuIGNvbm5lY3RNY3BCYXRjaChkZWR1cGVkQ2xhdWRlQWksICdjbGF1ZGVhaScpXG4gICAgICAgIH0pXG4gICAgICAgIGxldCBjbGF1ZGVhaVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZFxuICAgICAgICBjb25zdCBjbGF1ZGVhaVRpbWVkT3V0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICBjbGF1ZGVhaUNvbm5lY3QudGhlbigoKSA9PiBmYWxzZSksXG4gICAgICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4ocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBjbGF1ZGVhaVRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICAgICAgICAgciA9PiByKHRydWUpLFxuICAgICAgICAgICAgICBDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMsXG4gICAgICAgICAgICAgIHJlc29sdmUsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfSksXG4gICAgICAgIF0pXG4gICAgICAgIGlmIChjbGF1ZGVhaVRpbWVyKSBjbGVhclRpbWVvdXQoY2xhdWRlYWlUaW1lcilcbiAgICAgICAgaWYgKGNsYXVkZWFpVGltZWRPdXQpIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgW01DUF0gY2xhdWRlLmFpIGNvbm5lY3RvcnMgbm90IHJlYWR5IGFmdGVyICR7Q0xBVURFX0FJX01DUF9USU1FT1VUX01TfW1zIOKAlCBwcm9jZWVkaW5nOyBiYWNrZ3JvdW5kIGNvbm5lY3Rpb24gY29udGludWVzYCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FmdGVyX2Nvbm5lY3RNY3BfY2xhdWRlYWknKVxuXG4gICAgICAgIC8vIEluIGhlYWRsZXNzIG1vZGUsIHN0YXJ0IGRlZmVycmVkIHByZWZldGNoZXMgaW1tZWRpYXRlbHkgKG5vIHVzZXIgdHlwaW5nIGRlbGF5KVxuICAgICAgICAvLyAtLWJhcmUgLyBTSU1QTEU6IHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzIGVhcmx5LXJldHVybnMgaW50ZXJuYWxseS5cbiAgICAgICAgLy8gYmFja2dyb3VuZEhvdXNla2VlcGluZyAoaW5pdEV4dHJhY3RNZW1vcmllcywgcHJ1bmVTaGVsbFNuYXBzaG90cyxcbiAgICAgICAgLy8gY2xlYW51cE9sZE1lc3NhZ2VGaWxlcykgYW5kIHNka0hlYXBEdW1wTW9uaXRvciBhcmUgYWxsIGJvb2trZWVwaW5nXG4gICAgICAgIC8vIHRoYXQgc2NyaXB0ZWQgY2FsbHMgZG9uJ3QgbmVlZCDigJQgdGhlIG5leHQgaW50ZXJhY3RpdmUgc2Vzc2lvbiByZWNvbmNpbGVzLlxuICAgICAgICBpZiAoIWlzQmFyZU1vZGUoKSkge1xuICAgICAgICAgIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzKClcbiAgICAgICAgICB2b2lkIGltcG9ydCgnLi91dGlscy9iYWNrZ3JvdW5kSG91c2VrZWVwaW5nLmpzJykudGhlbihtID0+XG4gICAgICAgICAgICBtLnN0YXJ0QmFja2dyb3VuZEhvdXNla2VlcGluZygpLFxuICAgICAgICAgIClcbiAgICAgICAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgICAgICAgICAgdm9pZCBpbXBvcnQoJy4vdXRpbHMvc2RrSGVhcER1bXBNb25pdG9yLmpzJykudGhlbihtID0+XG4gICAgICAgICAgICAgIG0uc3RhcnRTZGtNZW1vcnlNb25pdG9yKCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbG9nU2Vzc2lvblRlbGVtZXRyeSgpXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdiZWZvcmVfcHJpbnRfaW1wb3J0JylcbiAgICAgICAgY29uc3QgeyBydW5IZWFkbGVzcyB9ID0gYXdhaXQgaW1wb3J0KCdzcmMvY2xpL3ByaW50LmpzJylcbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FmdGVyX3ByaW50X2ltcG9ydCcpXG4gICAgICAgIHZvaWQgcnVuSGVhZGxlc3MoXG4gICAgICAgICAgaW5wdXRQcm9tcHQsXG4gICAgICAgICAgKCkgPT4gaGVhZGxlc3NTdG9yZS5nZXRTdGF0ZSgpLFxuICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUsXG4gICAgICAgICAgY29tbWFuZHNIZWFkbGVzcyxcbiAgICAgICAgICB0b29scyxcbiAgICAgICAgICBzZGtNY3BDb25maWdzLFxuICAgICAgICAgIGFnZW50RGVmaW5pdGlvbnMuYWN0aXZlQWdlbnRzLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNvbnRpbnVlOiBvcHRpb25zLmNvbnRpbnVlLFxuICAgICAgICAgICAgcmVzdW1lOiBvcHRpb25zLnJlc3VtZSxcbiAgICAgICAgICAgIHZlcmJvc2U6IHZlcmJvc2UsXG4gICAgICAgICAgICBvdXRwdXRGb3JtYXQ6IG91dHB1dEZvcm1hdCxcbiAgICAgICAgICAgIGpzb25TY2hlbWEsXG4gICAgICAgICAgICBwZXJtaXNzaW9uUHJvbXB0VG9vbE5hbWU6IG9wdGlvbnMucGVybWlzc2lvblByb21wdFRvb2wsXG4gICAgICAgICAgICBhbGxvd2VkVG9vbHMsXG4gICAgICAgICAgICB0aGlua2luZ0NvbmZpZyxcbiAgICAgICAgICAgIG1heFR1cm5zOiBvcHRpb25zLm1heFR1cm5zLFxuICAgICAgICAgICAgbWF4QnVkZ2V0VXNkOiBvcHRpb25zLm1heEJ1ZGdldFVzZCxcbiAgICAgICAgICAgIHRhc2tCdWRnZXQ6IG9wdGlvbnMudGFza0J1ZGdldFxuICAgICAgICAgICAgICA/IHsgdG90YWw6IG9wdGlvbnMudGFza0J1ZGdldCB9XG4gICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgc3lzdGVtUHJvbXB0LFxuICAgICAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0LFxuICAgICAgICAgICAgdXNlclNwZWNpZmllZE1vZGVsOiBlZmZlY3RpdmVNb2RlbCxcbiAgICAgICAgICAgIGZhbGxiYWNrTW9kZWw6IHVzZXJTcGVjaWZpZWRGYWxsYmFja01vZGVsLFxuICAgICAgICAgICAgdGVsZXBvcnQsXG4gICAgICAgICAgICBzZGtVcmwsXG4gICAgICAgICAgICByZXBsYXlVc2VyTWVzc2FnZXM6IGVmZmVjdGl2ZVJlcGxheVVzZXJNZXNzYWdlcyxcbiAgICAgICAgICAgIGluY2x1ZGVQYXJ0aWFsTWVzc2FnZXM6IGVmZmVjdGl2ZUluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMsXG4gICAgICAgICAgICBmb3JrU2Vzc2lvbjogb3B0aW9ucy5mb3JrU2Vzc2lvbiB8fCBmYWxzZSxcbiAgICAgICAgICAgIHJlc3VtZVNlc3Npb25BdDogb3B0aW9ucy5yZXN1bWVTZXNzaW9uQXQgfHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgcmV3aW5kRmlsZXM6IG9wdGlvbnMucmV3aW5kRmlsZXMsXG4gICAgICAgICAgICBlbmFibGVBdXRoU3RhdHVzOiBvcHRpb25zLmVuYWJsZUF1dGhTdGF0dXMsXG4gICAgICAgICAgICBhZ2VudDogYWdlbnRDbGksXG4gICAgICAgICAgICB3b3JrbG9hZDogb3B0aW9ucy53b3JrbG9hZCxcbiAgICAgICAgICAgIHNldHVwVHJpZ2dlcjogc2V0dXBUcmlnZ2VyID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHNlc3Npb25TdGFydEhvb2tzUHJvbWlzZSxcbiAgICAgICAgICB9LFxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBMb2cgbW9kZWwgY29uZmlnIGF0IHN0YXJ0dXBcbiAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zdGFydHVwX21hbnVhbF9tb2RlbF9jb25maWcnLCB7XG4gICAgICAgIGNsaV9mbGFnOlxuICAgICAgICAgIG9wdGlvbnMubW9kZWwgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgZW52X3ZhcjogcHJvY2Vzcy5lbnZcbiAgICAgICAgICAuQU5USFJPUElDX01PREVMIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgIHNldHRpbmdzX2ZpbGU6IChnZXRJbml0aWFsU2V0dGluZ3MoKSB8fCB7fSlcbiAgICAgICAgICAubW9kZWwgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgc3Vic2NyaXB0aW9uVHlwZTpcbiAgICAgICAgICBnZXRTdWJzY3JpcHRpb25UeXBlKCkgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgYWdlbnQ6XG4gICAgICAgICAgYWdlbnRTZXR0aW5nIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KVxuXG4gICAgICAvLyBHZXQgZGVwcmVjYXRpb24gd2FybmluZyBmb3IgdGhlIGluaXRpYWwgbW9kZWwgKHJlc29sdmVkSW5pdGlhbE1vZGVsIGNvbXB1dGVkIGVhcmxpZXIgZm9yIGhvb2tzIHBhcmFsbGVsaXphdGlvbilcbiAgICAgIGNvbnN0IGRlcHJlY2F0aW9uV2FybmluZyA9XG4gICAgICAgIGdldE1vZGVsRGVwcmVjYXRpb25XYXJuaW5nKHJlc29sdmVkSW5pdGlhbE1vZGVsKVxuXG4gICAgICAvLyBCdWlsZCBpbml0aWFsIG5vdGlmaWNhdGlvbiBxdWV1ZVxuICAgICAgY29uc3QgaW5pdGlhbE5vdGlmaWNhdGlvbnM6IEFycmF5PHtcbiAgICAgICAga2V5OiBzdHJpbmdcbiAgICAgICAgdGV4dDogc3RyaW5nXG4gICAgICAgIGNvbG9yPzogJ3dhcm5pbmcnXG4gICAgICAgIHByaW9yaXR5OiAnaGlnaCdcbiAgICAgIH0+ID0gW11cbiAgICAgIGlmIChwZXJtaXNzaW9uTW9kZU5vdGlmaWNhdGlvbikge1xuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdwZXJtaXNzaW9uLW1vZGUtbm90aWZpY2F0aW9uJyxcbiAgICAgICAgICB0ZXh0OiBwZXJtaXNzaW9uTW9kZU5vdGlmaWNhdGlvbixcbiAgICAgICAgICBwcmlvcml0eTogJ2hpZ2gnLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgaWYgKGRlcHJlY2F0aW9uV2FybmluZykge1xuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdtb2RlbC1kZXByZWNhdGlvbi13YXJuaW5nJyxcbiAgICAgICAgICB0ZXh0OiBkZXByZWNhdGlvbldhcm5pbmcsXG4gICAgICAgICAgY29sb3I6ICd3YXJuaW5nJyxcbiAgICAgICAgICBwcmlvcml0eTogJ2hpZ2gnLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgaWYgKG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgZGlzcGxheUxpc3QgPSB1bmlxKFxuICAgICAgICAgIG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLm1hcChwID0+IHAucnVsZURpc3BsYXkpLFxuICAgICAgICApXG4gICAgICAgIGNvbnN0IGRpc3BsYXlzID0gZGlzcGxheUxpc3Quam9pbignLCAnKVxuICAgICAgICBjb25zdCBzb3VyY2VzID0gdW5pcShcbiAgICAgICAgICBvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucy5tYXAocCA9PiBwLnNvdXJjZURpc3BsYXkpLFxuICAgICAgICApLmpvaW4oJywgJylcbiAgICAgICAgY29uc3QgbiA9IGRpc3BsYXlMaXN0Lmxlbmd0aFxuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdvdmVybHktYnJvYWQtYmFzaC1ub3RpZmljYXRpb24nLFxuICAgICAgICAgIHRleHQ6IGAke2Rpc3BsYXlzfSBhbGxvdyAke3BsdXJhbChuLCAncnVsZScpfSBmcm9tICR7c291cmNlc30gJHtwbHVyYWwobiwgJ3dhcycsICd3ZXJlJyl9IGlnbm9yZWQgXFx1MjAxNCBub3QgYXZhaWxhYmxlIGZvciBBbnRzLCBwbGVhc2UgdXNlIGF1dG8tbW9kZSBpbnN0ZWFkYCxcbiAgICAgICAgICBjb2xvcjogJ3dhcm5pbmcnLFxuICAgICAgICAgIHByaW9yaXR5OiAnaGlnaCcsXG4gICAgICAgIH0pXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVmZmVjdGl2ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCA9IHtcbiAgICAgICAgLi4udG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICAgICAgICBtb2RlOlxuICAgICAgICAgIGlzQWdlbnRTd2FybXNFbmFibGVkKCkgJiYgZ2V0VGVhbW1hdGVVdGlscygpLmlzUGxhbk1vZGVSZXF1aXJlZCgpXG4gICAgICAgICAgICA/ICgncGxhbicgYXMgY29uc3QpXG4gICAgICAgICAgICA6IHRvb2xQZXJtaXNzaW9uQ29udGV4dC5tb2RlLFxuICAgICAgfVxuICAgICAgLy8gQWxsIHN0YXJ0dXAgb3B0LWluIHBhdGhzICgtLXRvb2xzLCAtLWJyaWVmLCBkZWZhdWx0VmlldykgaGF2ZSBmaXJlZFxuICAgICAgLy8gYWJvdmU7IGluaXRpYWxJc0JyaWVmT25seSBqdXN0IHJlYWRzIHRoZSByZXN1bHRpbmcgc3RhdGUuXG4gICAgICBjb25zdCBpbml0aWFsSXNCcmllZk9ubHkgPVxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKSA/IGdldFVzZXJNc2dPcHRJbigpIDogZmFsc2VcbiAgICAgIGNvbnN0IGZ1bGxSZW1vdGVDb250cm9sID1cbiAgICAgICAgcmVtb3RlQ29udHJvbCB8fCBnZXRSZW1vdGVDb250cm9sQXRTdGFydHVwKCkgfHwga2Fpcm9zRW5hYmxlZFxuICAgICAgbGV0IGNjck1pcnJvckVuYWJsZWQgPSBmYWxzZVxuICAgICAgaWYgKGZlYXR1cmUoJ0NDUl9NSVJST1InKSAmJiAhZnVsbFJlbW90ZUNvbnRyb2wpIHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCB7IGlzQ2NyTWlycm9yRW5hYmxlZCB9ID1cbiAgICAgICAgICByZXF1aXJlKCcuL2JyaWRnZS9icmlkZ2VFbmFibGVkLmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi9icmlkZ2UvYnJpZGdlRW5hYmxlZC5qcycpXG4gICAgICAgIC8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjY3JNaXJyb3JFbmFibGVkID0gaXNDY3JNaXJyb3JFbmFibGVkKClcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5pdGlhbFN0YXRlOiBBcHBTdGF0ZSA9IHtcbiAgICAgICAgc2V0dGluZ3M6IGdldEluaXRpYWxTZXR0aW5ncygpLFxuICAgICAgICB0YXNrczoge30sXG4gICAgICAgIGFnZW50TmFtZVJlZ2lzdHJ5OiBuZXcgTWFwKCksXG4gICAgICAgIHZlcmJvc2U6IHZlcmJvc2UgPz8gZ2V0R2xvYmFsQ29uZmlnKCkudmVyYm9zZSA/PyBmYWxzZSxcbiAgICAgICAgbWFpbkxvb3BNb2RlbDogaW5pdGlhbE1haW5Mb29wTW9kZWwsXG4gICAgICAgIG1haW5Mb29wTW9kZWxGb3JTZXNzaW9uOiBudWxsLFxuICAgICAgICBpc0JyaWVmT25seTogaW5pdGlhbElzQnJpZWZPbmx5LFxuICAgICAgICBleHBhbmRlZFZpZXc6IGdldEdsb2JhbENvbmZpZygpLnNob3dTcGlubmVyVHJlZVxuICAgICAgICAgID8gJ3RlYW1tYXRlcydcbiAgICAgICAgICA6IGdldEdsb2JhbENvbmZpZygpLnNob3dFeHBhbmRlZFRvZG9zXG4gICAgICAgICAgICA/ICd0YXNrcydcbiAgICAgICAgICAgIDogJ25vbmUnLFxuICAgICAgICBzaG93VGVhbW1hdGVNZXNzYWdlUHJldmlldzogaXNBZ2VudFN3YXJtc0VuYWJsZWQoKSA/IGZhbHNlIDogdW5kZWZpbmVkLFxuICAgICAgICBzZWxlY3RlZElQQWdlbnRJbmRleDogLTEsXG4gICAgICAgIGNvb3JkaW5hdG9yVGFza0luZGV4OiAtMSxcbiAgICAgICAgdmlld1NlbGVjdGlvbk1vZGU6ICdub25lJyxcbiAgICAgICAgZm9vdGVyU2VsZWN0aW9uOiBudWxsLFxuICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQ6IGVmZmVjdGl2ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgYWdlbnQ6IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24/LmFnZW50VHlwZSxcbiAgICAgICAgYWdlbnREZWZpbml0aW9ucyxcbiAgICAgICAgbWNwOiB7XG4gICAgICAgICAgY2xpZW50czogW10sXG4gICAgICAgICAgdG9vbHM6IFtdLFxuICAgICAgICAgIGNvbW1hbmRzOiBbXSxcbiAgICAgICAgICByZXNvdXJjZXM6IHt9LFxuICAgICAgICAgIHBsdWdpblJlY29ubmVjdEtleTogMCxcbiAgICAgICAgfSxcbiAgICAgICAgcGx1Z2luczoge1xuICAgICAgICAgIGVuYWJsZWQ6IFtdLFxuICAgICAgICAgIGRpc2FibGVkOiBbXSxcbiAgICAgICAgICBjb21tYW5kczogW10sXG4gICAgICAgICAgZXJyb3JzOiBbXSxcbiAgICAgICAgICBpbnN0YWxsYXRpb25TdGF0dXM6IHtcbiAgICAgICAgICAgIG1hcmtldHBsYWNlczogW10sXG4gICAgICAgICAgICBwbHVnaW5zOiBbXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIG5lZWRzUmVmcmVzaDogZmFsc2UsXG4gICAgICAgIH0sXG4gICAgICAgIHN0YXR1c0xpbmVUZXh0OiB1bmRlZmluZWQsXG4gICAgICAgIGthaXJvc0VuYWJsZWQsXG4gICAgICAgIHJlbW90ZVNlc3Npb25Vcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVtb3RlQ29ubmVjdGlvblN0YXR1czogJ2Nvbm5lY3RpbmcnLFxuICAgICAgICByZW1vdGVCYWNrZ3JvdW5kVGFza0NvdW50OiAwLFxuICAgICAgICByZXBsQnJpZGdlRW5hYmxlZDogZnVsbFJlbW90ZUNvbnRyb2wgfHwgY2NyTWlycm9yRW5hYmxlZCxcbiAgICAgICAgcmVwbEJyaWRnZUV4cGxpY2l0OiByZW1vdGVDb250cm9sLFxuICAgICAgICByZXBsQnJpZGdlT3V0Ym91bmRPbmx5OiBjY3JNaXJyb3JFbmFibGVkLFxuICAgICAgICByZXBsQnJpZGdlQ29ubmVjdGVkOiBmYWxzZSxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25BY3RpdmU6IGZhbHNlLFxuICAgICAgICByZXBsQnJpZGdlUmVjb25uZWN0aW5nOiBmYWxzZSxcbiAgICAgICAgcmVwbEJyaWRnZUNvbm5lY3RVcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25Vcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZUVudmlyb25tZW50SWQ6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25JZDogdW5kZWZpbmVkLFxuICAgICAgICByZXBsQnJpZGdlRXJyb3I6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZUluaXRpYWxOYW1lOiByZW1vdGVDb250cm9sTmFtZSxcbiAgICAgICAgc2hvd1JlbW90ZUNhbGxvdXQ6IGZhbHNlLFxuICAgICAgICBub3RpZmljYXRpb25zOiB7XG4gICAgICAgICAgY3VycmVudDogbnVsbCxcbiAgICAgICAgICBxdWV1ZTogaW5pdGlhbE5vdGlmaWNhdGlvbnMsXG4gICAgICAgIH0sXG4gICAgICAgIGVsaWNpdGF0aW9uOiB7XG4gICAgICAgICAgcXVldWU6IFtdLFxuICAgICAgICB9LFxuICAgICAgICB0b2Rvczoge30sXG4gICAgICAgIHJlbW90ZUFnZW50VGFza1N1Z2dlc3Rpb25zOiBbXSxcbiAgICAgICAgZmlsZUhpc3Rvcnk6IHtcbiAgICAgICAgICBzbmFwc2hvdHM6IFtdLFxuICAgICAgICAgIHRyYWNrZWRGaWxlczogbmV3IFNldCgpLFxuICAgICAgICAgIHNuYXBzaG90U2VxdWVuY2U6IDAsXG4gICAgICAgIH0sXG4gICAgICAgIGF0dHJpYnV0aW9uOiBjcmVhdGVFbXB0eUF0dHJpYnV0aW9uU3RhdGUoKSxcbiAgICAgICAgdGhpbmtpbmdFbmFibGVkLFxuICAgICAgICBwcm9tcHRTdWdnZXN0aW9uRW5hYmxlZDogc2hvdWxkRW5hYmxlUHJvbXB0U3VnZ2VzdGlvbigpLFxuICAgICAgICBzZXNzaW9uSG9va3M6IG5ldyBNYXAoKSxcbiAgICAgICAgaW5ib3g6IHtcbiAgICAgICAgICBtZXNzYWdlczogW10sXG4gICAgICAgIH0sXG4gICAgICAgIHByb21wdFN1Z2dlc3Rpb246IHtcbiAgICAgICAgICB0ZXh0OiBudWxsLFxuICAgICAgICAgIHByb21wdElkOiBudWxsLFxuICAgICAgICAgIHNob3duQXQ6IDAsXG4gICAgICAgICAgYWNjZXB0ZWRBdDogMCxcbiAgICAgICAgICBnZW5lcmF0aW9uUmVxdWVzdElkOiBudWxsLFxuICAgICAgICB9LFxuICAgICAgICBzcGVjdWxhdGlvbjogSURMRV9TUEVDVUxBVElPTl9TVEFURSxcbiAgICAgICAgc3BlY3VsYXRpb25TZXNzaW9uVGltZVNhdmVkTXM6IDAsXG4gICAgICAgIHNraWxsSW1wcm92ZW1lbnQ6IHtcbiAgICAgICAgICBzdWdnZXN0aW9uOiBudWxsLFxuICAgICAgICB9LFxuICAgICAgICB3b3JrZXJTYW5kYm94UGVybWlzc2lvbnM6IHtcbiAgICAgICAgICBxdWV1ZTogW10sXG4gICAgICAgICAgc2VsZWN0ZWRJbmRleDogMCxcbiAgICAgICAgfSxcbiAgICAgICAgcGVuZGluZ1dvcmtlclJlcXVlc3Q6IG51bGwsXG4gICAgICAgIHBlbmRpbmdTYW5kYm94UmVxdWVzdDogbnVsbCxcbiAgICAgICAgYXV0aFZlcnNpb246IDAsXG4gICAgICAgIGluaXRpYWxNZXNzYWdlOiBpbnB1dFByb21wdFxuICAgICAgICAgID8geyBtZXNzYWdlOiBjcmVhdGVVc2VyTWVzc2FnZSh7IGNvbnRlbnQ6IFN0cmluZyhpbnB1dFByb21wdCkgfSkgfVxuICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZWZmb3J0VmFsdWU6XG4gICAgICAgICAgcGFyc2VFZmZvcnRWYWx1ZShvcHRpb25zLmVmZm9ydCkgPz8gZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmcoKSxcbiAgICAgICAgYWN0aXZlT3ZlcmxheXM6IG5ldyBTZXQ8c3RyaW5nPigpLFxuICAgICAgICBmYXN0TW9kZTogZ2V0SW5pdGlhbEZhc3RNb2RlU2V0dGluZyhyZXNvbHZlZEluaXRpYWxNb2RlbCksXG4gICAgICAgIC4uLihpc0Fkdmlzb3JFbmFibGVkKCkgJiYgYWR2aXNvck1vZGVsICYmIHsgYWR2aXNvck1vZGVsIH0pLFxuICAgICAgICAvLyBDb21wdXRlIHRlYW1Db250ZXh0IHN5bmNocm9ub3VzbHkgdG8gYXZvaWQgdXNlRWZmZWN0IHNldFN0YXRlIGR1cmluZyByZW5kZXIuXG4gICAgICAgIC8vIEtBSVJPUzogYXNzaXN0YW50VGVhbUNvbnRleHQgdGFrZXMgcHJlY2VkZW5jZSDigJQgc2V0IGVhcmxpZXIgaW4gdGhlXG4gICAgICAgIC8vIEtBSVJPUyBibG9jayBzbyBBZ2VudChuYW1lOiBcImZvb1wiKSBjYW4gc3Bhd24gaW4tcHJvY2VzcyB0ZWFtbWF0ZXNcbiAgICAgICAgLy8gd2l0aG91dCBUZWFtQ3JlYXRlLiBjb21wdXRlSW5pdGlhbFRlYW1Db250ZXh0KCkgaXMgZm9yIHRtdXgtc3Bhd25lZFxuICAgICAgICAvLyB0ZWFtbWF0ZXMgcmVhZGluZyB0aGVpciBvd24gaWRlbnRpdHksIG5vdCB0aGUgYXNzaXN0YW50LW1vZGUgbGVhZGVyLlxuICAgICAgICB0ZWFtQ29udGV4dDogZmVhdHVyZSgnS0FJUk9TJylcbiAgICAgICAgICA/IChhc3Npc3RhbnRUZWFtQ29udGV4dCA/PyBjb21wdXRlSW5pdGlhbFRlYW1Db250ZXh0Py4oKSlcbiAgICAgICAgICA6IGNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQ/LigpLFxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgQ0xJIGluaXRpYWwgcHJvbXB0IHRvIGhpc3RvcnlcbiAgICAgIGlmIChpbnB1dFByb21wdCkge1xuICAgICAgICBhZGRUb0hpc3RvcnkoU3RyaW5nKGlucHV0UHJvbXB0KSlcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5pdGlhbFRvb2xzID0gbWNwVG9vbHNcblxuICAgICAgLy8gSW5jcmVtZW50IG51bVN0YXJ0dXBzIHN5bmNocm9ub3VzbHkg4oCUIGZpcnN0LXJlbmRlciByZWFkZXJzIGxpa2VcbiAgICAgIC8vIHNob3VsZFNob3dFZmZvcnRDYWxsb3V0ICh2aWEgdXNlU3RhdGUgaW5pdGlhbGl6ZXIpIG5lZWQgdGhlIHVwZGF0ZWRcbiAgICAgIC8vIHZhbHVlIGJlZm9yZSBzZXRJbW1lZGlhdGUgZmlyZXMuIERlZmVyIG9ubHkgdGVsZW1ldHJ5LlxuICAgICAgc2F2ZUdsb2JhbENvbmZpZyhjdXJyZW50ID0+ICh7XG4gICAgICAgIC4uLmN1cnJlbnQsXG4gICAgICAgIG51bVN0YXJ0dXBzOiAoY3VycmVudC5udW1TdGFydHVwcyA/PyAwKSArIDEsXG4gICAgICB9KSlcbiAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7XG4gICAgICAgIHZvaWQgbG9nU3RhcnR1cFRlbGVtZXRyeSgpXG4gICAgICAgIGxvZ1Nlc3Npb25UZWxlbWV0cnkoKVxuICAgICAgfSlcblxuICAgICAgLy8gU2V0IHVwIHBlci10dXJuIHNlc3Npb24gZW52aXJvbm1lbnQgZGF0YSB1cGxvYWRlciAoYW50LW9ubHkgYnVpbGQpLlxuICAgICAgLy8gRGVmYXVsdC1lbmFibGVkIGZvciBhbGwgYW50IHVzZXJzIHdoZW4gd29ya2luZyBpbiBhbiBBbnRocm9waWMtb3duZWRcbiAgICAgIC8vIHJlcG8uIENhcHR1cmVzIGdpdC9maWxlc3lzdGVtIHN0YXRlIChOT1QgdHJhbnNjcmlwdHMpIGF0IGVhY2ggdHVybiBzb1xuICAgICAgLy8gZW52aXJvbm1lbnRzIGNhbiBiZSByZWNyZWF0ZWQgYXQgYW55IHVzZXIgbWVzc2FnZSBpbmRleC4gR2F0aW5nOlxuICAgICAgLy8gICAtIEJ1aWxkLXRpbWU6IHRoaXMgaW1wb3J0IGlzIHN0dWJiZWQgaW4gZXh0ZXJuYWwgYnVpbGRzLlxuICAgICAgLy8gICAtIFJ1bnRpbWU6IHVwbG9hZGVyIGNoZWNrcyBnaXRodWIuY29tL2FudGhyb3BpY3MvKiByZW1vdGUgKyBnY2xvdWQgYXV0aC5cbiAgICAgIC8vICAgLSBTYWZldHk6IENMQVVERV9DT0RFX0RJU0FCTEVfU0VTU0lPTl9EQVRBX1VQTE9BRD0xIGJ5cGFzc2VzICh0ZXN0cyBzZXQgdGhpcykuXG4gICAgICAvLyBJbXBvcnQgaXMgZHluYW1pYyArIGFzeW5jIHRvIGF2b2lkIGFkZGluZyBzdGFydHVwIGxhdGVuY3kuXG4gICAgICBjb25zdCBzZXNzaW9uVXBsb2FkZXJQcm9taXNlID1cbiAgICAgICAgXCJleHRlcm5hbFwiID09PSAnYW50J1xuICAgICAgICAgID8gaW1wb3J0KCcuL3V0aWxzL3Nlc3Npb25EYXRhVXBsb2FkZXIuanMnKVxuICAgICAgICAgIDogbnVsbFxuXG4gICAgICAvLyBEZWZlciBzZXNzaW9uIHVwbG9hZGVyIHJlc29sdXRpb24gdG8gdGhlIG9uVHVybkNvbXBsZXRlIGNhbGxiYWNrIHRvIGF2b2lkXG4gICAgICAvLyBhZGRpbmcgYSBuZXcgdG9wLWxldmVsIGF3YWl0IGluIG1haW4udHN4IChwZXJmb3JtYW5jZS1jcml0aWNhbCBwYXRoKS5cbiAgICAgIC8vIFRoZSBwZXItdHVybiBhdXRoIGxvZ2ljIGluIHNlc3Npb25EYXRhVXBsb2FkZXIudHMgaGFuZGxlcyB1bmF1dGhlbnRpY2F0ZWRcbiAgICAgIC8vIHN0YXRlIGdyYWNlZnVsbHkgKHJlLWNoZWNrcyBlYWNoIHR1cm4sIHNvIGF1dGggcmVjb3ZlcnkgbWlkLXNlc3Npb24gd29ya3MpLlxuICAgICAgY29uc3QgdXBsb2FkZXJSZWFkeSA9IHNlc3Npb25VcGxvYWRlclByb21pc2VcbiAgICAgICAgPyBzZXNzaW9uVXBsb2FkZXJQcm9taXNlXG4gICAgICAgICAgICAudGhlbihtb2QgPT4gbW9kLmNyZWF0ZVNlc3Npb25UdXJuVXBsb2FkZXIoKSlcbiAgICAgICAgICAgIC5jYXRjaCgoKSA9PiBudWxsKVxuICAgICAgICA6IG51bGxcblxuICAgICAgY29uc3Qgc2Vzc2lvbkNvbmZpZyA9IHtcbiAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgIGNvbW1hbmRzOiBbLi4uY29tbWFuZHMsIC4uLm1jcENvbW1hbmRzXSxcbiAgICAgICAgaW5pdGlhbFRvb2xzLFxuICAgICAgICBtY3BDbGllbnRzLFxuICAgICAgICBhdXRvQ29ubmVjdElkZUZsYWc6IGlkZSxcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgZGlzYWJsZVNsYXNoQ29tbWFuZHMsXG4gICAgICAgIGR5bmFtaWNNY3BDb25maWcsXG4gICAgICAgIHN0cmljdE1jcENvbmZpZyxcbiAgICAgICAgc3lzdGVtUHJvbXB0LFxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQsXG4gICAgICAgIHRhc2tMaXN0SWQsXG4gICAgICAgIHRoaW5raW5nQ29uZmlnLFxuICAgICAgICAuLi4odXBsb2FkZXJSZWFkeSAmJiB7XG4gICAgICAgICAgb25UdXJuQ29tcGxldGU6IChtZXNzYWdlczogTWVzc2FnZVR5cGVbXSkgPT4ge1xuICAgICAgICAgICAgdm9pZCB1cGxvYWRlclJlYWR5LnRoZW4odXBsb2FkZXIgPT4gdXBsb2FkZXI/LihtZXNzYWdlcykpXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9XG5cbiAgICAgIC8vIFNoYXJlZCBjb250ZXh0IGZvciBwcm9jZXNzUmVzdW1lZENvbnZlcnNhdGlvbiBjYWxsc1xuICAgICAgY29uc3QgcmVzdW1lQ29udGV4dCA9IHtcbiAgICAgICAgbW9kZUFwaTogY29vcmRpbmF0b3JNb2RlTW9kdWxlLFxuICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICBhZ2VudERlZmluaXRpb25zLFxuICAgICAgICBjdXJyZW50Q3dkLFxuICAgICAgICBjbGlBZ2VudHMsXG4gICAgICAgIGluaXRpYWxTdGF0ZSxcbiAgICAgIH1cblxuICAgICAgaWYgKG9wdGlvbnMuY29udGludWUpIHtcbiAgICAgICAgLy8gQ29udGludWUgdGhlIG1vc3QgcmVjZW50IGNvbnZlcnNhdGlvbiBkaXJlY3RseVxuICAgICAgICBsZXQgcmVzdW1lU3VjY2VlZGVkID0gZmFsc2VcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG5cbiAgICAgICAgICAvLyBDbGVhciBzdGFsZSBjYWNoZXMgYmVmb3JlIHJlc3VtaW5nIHRvIGVuc3VyZSBmcmVzaCBmaWxlL3NraWxsIGRpc2NvdmVyeVxuICAgICAgICAgIGNvbnN0IHsgY2xlYXJTZXNzaW9uQ2FjaGVzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jb21tYW5kcy9jbGVhci9jYWNoZXMuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGNsZWFyU2Vzc2lvbkNhY2hlcygpXG5cbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBsb2FkQ29udmVyc2F0aW9uRm9yUmVzdW1lKFxuICAgICAgICAgICAgdW5kZWZpbmVkIC8qIHNlc3Npb25JZCAqLyxcbiAgICAgICAgICAgIHVuZGVmaW5lZCAvKiBzb3VyY2VGaWxlICovLFxuICAgICAgICAgIClcbiAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NvbnRpbnVlJywge1xuICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgJ05vIGNvbnZlcnNhdGlvbiBmb3VuZCB0byBjb250aW51ZScsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgbG9hZGVkID0gYXdhaXQgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24oXG4gICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGZvcmtTZXNzaW9uOiAhIW9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgIGluY2x1ZGVBdHRyaWJ1dGlvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgdHJhbnNjcmlwdFBhdGg6IHJlc3VsdC5mdWxsUGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICByZXN1bWVDb250ZXh0LFxuICAgICAgICAgIClcblxuICAgICAgICAgIGlmIChsb2FkZWQucmVzdG9yZWRBZ2VudERlZikge1xuICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbiA9IGxvYWRlZC5yZXN0b3JlZEFnZW50RGVmXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbWF5YmVBY3RpdmF0ZVByb2FjdGl2ZShvcHRpb25zKVxuICAgICAgICAgIG1heWJlQWN0aXZhdGVCcmllZihvcHRpb25zKVxuXG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NvbnRpbnVlJywge1xuICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgIHJlc3VtZV9kdXJhdGlvbl9tczogTWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0KSxcbiAgICAgICAgICB9KVxuICAgICAgICAgIHJlc3VtZVN1Y2NlZWRlZCA9IHRydWVcblxuICAgICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlOiBsb2FkZWQuaW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLnNlc3Npb25Db25maWcsXG4gICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb246XG4gICAgICAgICAgICAgICAgbG9hZGVkLnJlc3RvcmVkQWdlbnREZWYgPz8gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBsb2FkZWQubWVzc2FnZXMsXG4gICAgICAgICAgICAgIGluaXRpYWxGaWxlSGlzdG9yeVNuYXBzaG90czogbG9hZGVkLmZpbGVIaXN0b3J5U25hcHNob3RzLFxuICAgICAgICAgICAgICBpbml0aWFsQ29udGVudFJlcGxhY2VtZW50czogbG9hZGVkLmNvbnRlbnRSZXBsYWNlbWVudHMsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudE5hbWU6IGxvYWRlZC5hZ2VudE5hbWUsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudENvbG9yOiBsb2FkZWQuYWdlbnRDb2xvcixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgICAgKVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGlmICghcmVzdW1lU3VjY2VlZGVkKSB7XG4gICAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY29udGludWUnLCB7XG4gICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICB9XG4gICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZmVhdHVyZSgnRElSRUNUX0NPTk5FQ1QnKSAmJiBfcGVuZGluZ0Nvbm5lY3Q/LnVybCkge1xuICAgICAgICAvLyBgY2xhdWRlIGNvbm5lY3QgPHVybD5gIOKAlCBmdWxsIGludGVyYWN0aXZlIFRVSSBjb25uZWN0ZWQgdG8gYSByZW1vdGUgc2VydmVyXG4gICAgICAgIGxldCBkaXJlY3RDb25uZWN0Q29uZmlnXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZURpcmVjdENvbm5lY3RTZXNzaW9uKHtcbiAgICAgICAgICAgIHNlcnZlclVybDogX3BlbmRpbmdDb25uZWN0LnVybCxcbiAgICAgICAgICAgIGF1dGhUb2tlbjogX3BlbmRpbmdDb25uZWN0LmF1dGhUb2tlbixcbiAgICAgICAgICAgIGN3ZDogZ2V0T3JpZ2luYWxDd2QoKSxcbiAgICAgICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOlxuICAgICAgICAgICAgICBfcGVuZGluZ0Nvbm5lY3QuZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgICAgfSlcbiAgICAgICAgICBpZiAoc2Vzc2lvbi53b3JrRGlyKSB7XG4gICAgICAgICAgICBzZXRPcmlnaW5hbEN3ZChzZXNzaW9uLndvcmtEaXIpXG4gICAgICAgICAgICBzZXRDd2RTdGF0ZShzZXNzaW9uLndvcmtEaXIpXG4gICAgICAgICAgfVxuICAgICAgICAgIHNldERpcmVjdENvbm5lY3RTZXJ2ZXJVcmwoX3BlbmRpbmdDb25uZWN0LnVybClcbiAgICAgICAgICBkaXJlY3RDb25uZWN0Q29uZmlnID0gc2Vzc2lvbi5jb25maWdcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRGlyZWN0Q29ubmVjdEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgKVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY29ubmVjdEluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBgQ29ubmVjdGVkIHRvIHNlcnZlciBhdCAke19wZW5kaW5nQ29ubmVjdC51cmx9XFxuU2Vzc2lvbjogJHtkaXJlY3RDb25uZWN0Q29uZmlnLnNlc3Npb25JZH1gLFxuICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgKVxuXG4gICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkZWJ1ZzogZGVidWcgfHwgZGVidWdUb1N0ZGVycixcbiAgICAgICAgICAgIGNvbW1hbmRzLFxuICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlczogW2Nvbm5lY3RJbmZvTWVzc2FnZV0sXG4gICAgICAgICAgICBtY3BDbGllbnRzOiBbXSxcbiAgICAgICAgICAgIGF1dG9Db25uZWN0SWRlRmxhZzogaWRlLFxuICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgIGRpc2FibGVTbGFzaENvbW1hbmRzLFxuICAgICAgICAgICAgZGlyZWN0Q29ubmVjdENvbmZpZyxcbiAgICAgICAgICAgIHRoaW5raW5nQ29uZmlnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVuZGVyQW5kUnVuLFxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgfSBlbHNlIGlmIChmZWF0dXJlKCdTU0hfUkVNT1RFJykgJiYgX3BlbmRpbmdTU0g/Lmhvc3QpIHtcbiAgICAgICAgLy8gYGNsYXVkZSBzc2ggPGhvc3Q+IFtkaXJdYCDigJQgcHJvYmUgcmVtb3RlLCBkZXBsb3kgYmluYXJ5IGlmIG5lZWRlZCxcbiAgICAgICAgLy8gc3Bhd24gc3NoIHdpdGggdW5peC1zb2NrZXQgLVIgZm9yd2FyZCB0byBhIGxvY2FsIGF1dGggcHJveHksIGhhbmRcbiAgICAgICAgLy8gdGhlIFJFUEwgYW4gU1NIU2Vzc2lvbi4gVG9vbHMgcnVuIHJlbW90ZWx5LCBVSSByZW5kZXJzIGxvY2FsbHkuXG4gICAgICAgIC8vIGAtLWxvY2FsYCBza2lwcyBwcm9iZS9kZXBsb3kvc3NoIGFuZCBzcGF3bnMgdGhlIGN1cnJlbnQgYmluYXJ5XG4gICAgICAgIC8vIGRpcmVjdGx5IHdpdGggdGhlIHNhbWUgZW52IOKAlCBlMmUgdGVzdCBvZiB0aGUgcHJveHkvYXV0aCBwbHVtYmluZy5cbiAgICAgICAgY29uc3QgeyBjcmVhdGVTU0hTZXNzaW9uLCBjcmVhdGVMb2NhbFNTSFNlc3Npb24sIFNTSFNlc3Npb25FcnJvciB9ID1cbiAgICAgICAgICBhd2FpdCBpbXBvcnQoJy4vc3NoL2NyZWF0ZVNTSFNlc3Npb24uanMnKVxuICAgICAgICBsZXQgc3NoU2Vzc2lvblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGlmIChfcGVuZGluZ1NTSC5sb2NhbCkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1N0YXJ0aW5nIGxvY2FsIHNzaC1wcm94eSB0ZXN0IHNlc3Npb24uLi5cXG4nKVxuICAgICAgICAgICAgc3NoU2Vzc2lvbiA9IGNyZWF0ZUxvY2FsU1NIU2Vzc2lvbih7XG4gICAgICAgICAgICAgIGN3ZDogX3BlbmRpbmdTU0guY3dkLFxuICAgICAgICAgICAgICBwZXJtaXNzaW9uTW9kZTogX3BlbmRpbmdTU0gucGVybWlzc2lvbk1vZGUsXG4gICAgICAgICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOlxuICAgICAgICAgICAgICAgIF9wZW5kaW5nU1NILmRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYENvbm5lY3RpbmcgdG8gJHtfcGVuZGluZ1NTSC5ob3N0feKAplxcbmApXG4gICAgICAgICAgICAvLyBJbi1wbGFjZSBwcm9ncmVzczogXFxyICsgRUwwIChlcmFzZSB0byBlbmQgb2YgbGluZSkuIEZpbmFsIFxcbiBvblxuICAgICAgICAgICAgLy8gc3VjY2VzcyBzbyB0aGUgbmV4dCBtZXNzYWdlIGxhbmRzIG9uIGEgZnJlc2ggbGluZS4gTm8tb3Agd2hlblxuICAgICAgICAgICAgLy8gc3RkZXJyIGlzbid0IGEgVFRZIChwaXBlZC9yZWRpcmVjdGVkKSDigJQgXFxyIHdvdWxkIGp1c3QgZW1pdCBub2lzZS5cbiAgICAgICAgICAgIGNvbnN0IGlzVFRZID0gcHJvY2Vzcy5zdGRlcnIuaXNUVFlcbiAgICAgICAgICAgIGxldCBoYWRQcm9ncmVzcyA9IGZhbHNlXG4gICAgICAgICAgICBzc2hTZXNzaW9uID0gYXdhaXQgY3JlYXRlU1NIU2Vzc2lvbihcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIGhvc3Q6IF9wZW5kaW5nU1NILmhvc3QsXG4gICAgICAgICAgICAgICAgY3dkOiBfcGVuZGluZ1NTSC5jd2QsXG4gICAgICAgICAgICAgICAgbG9jYWxWZXJzaW9uOiBNQUNSTy5WRVJTSU9OLFxuICAgICAgICAgICAgICAgIHBlcm1pc3Npb25Nb2RlOiBfcGVuZGluZ1NTSC5wZXJtaXNzaW9uTW9kZSxcbiAgICAgICAgICAgICAgICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczpcbiAgICAgICAgICAgICAgICAgIF9wZW5kaW5nU1NILmRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgICAgIGV4dHJhQ2xpQXJnczogX3BlbmRpbmdTU0guZXh0cmFDbGlBcmdzLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBpc1RUWVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICBvblByb2dyZXNzOiBtc2cgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGhhZFByb2dyZXNzID0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBcXHIgICR7bXNnfVxceDFiW0tgKVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIDoge30sXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBpZiAoaGFkUHJvZ3Jlc3MpIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdcXG4nKVxuICAgICAgICAgIH1cbiAgICAgICAgICBzZXRPcmlnaW5hbEN3ZChzc2hTZXNzaW9uLnJlbW90ZUN3ZClcbiAgICAgICAgICBzZXRDd2RTdGF0ZShzc2hTZXNzaW9uLnJlbW90ZUN3ZClcbiAgICAgICAgICBzZXREaXJlY3RDb25uZWN0U2VydmVyVXJsKFxuICAgICAgICAgICAgX3BlbmRpbmdTU0gubG9jYWwgPyAnbG9jYWwnIDogX3BlbmRpbmdTU0guaG9zdCxcbiAgICAgICAgICApXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgIGVyciBpbnN0YW5jZW9mIFNTSFNlc3Npb25FcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNzaEluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBfcGVuZGluZ1NTSC5sb2NhbFxuICAgICAgICAgICAgPyBgTG9jYWwgc3NoLXByb3h5IHRlc3Qgc2Vzc2lvblxcbmN3ZDogJHtzc2hTZXNzaW9uLnJlbW90ZUN3ZH1cXG5BdXRoOiB1bml4IHNvY2tldCDihpIgbG9jYWwgcHJveHlgXG4gICAgICAgICAgICA6IGBTU0ggc2Vzc2lvbiB0byAke19wZW5kaW5nU1NILmhvc3R9XFxuUmVtb3RlIGN3ZDogJHtzc2hTZXNzaW9uLnJlbW90ZUN3ZH1cXG5BdXRoOiB1bml4IHNvY2tldCAtUiDihpIgbG9jYWwgcHJveHlgLFxuICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgKVxuXG4gICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkZWJ1ZzogZGVidWcgfHwgZGVidWdUb1N0ZGVycixcbiAgICAgICAgICAgIGNvbW1hbmRzLFxuICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlczogW3NzaEluZm9NZXNzYWdlXSxcbiAgICAgICAgICAgIG1jcENsaWVudHM6IFtdLFxuICAgICAgICAgICAgYXV0b0Nvbm5lY3RJZGVGbGFnOiBpZGUsXG4gICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICAgICAgZGlzYWJsZVNsYXNoQ29tbWFuZHMsXG4gICAgICAgICAgICBzc2hTZXNzaW9uLFxuICAgICAgICAgICAgdGhpbmtpbmdDb25maWcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgIClcbiAgICAgICAgcmV0dXJuXG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSAmJlxuICAgICAgICBfcGVuZGluZ0Fzc2lzdGFudENoYXQgJiZcbiAgICAgICAgKF9wZW5kaW5nQXNzaXN0YW50Q2hhdC5zZXNzaW9uSWQgfHwgX3BlbmRpbmdBc3Npc3RhbnRDaGF0LmRpc2NvdmVyKVxuICAgICAgKSB7XG4gICAgICAgIC8vIGBjbGF1ZGUgYXNzaXN0YW50IFtzZXNzaW9uSWRdYCDigJQgUkVQTCBhcyBhIHB1cmUgdmlld2VyIGNsaWVudFxuICAgICAgICAvLyBvZiBhIHJlbW90ZSBhc3Npc3RhbnQgc2Vzc2lvbi4gVGhlIGFnZW50aWMgbG9vcCBydW5zIHJlbW90ZWx5OyB0aGlzXG4gICAgICAgIC8vIHByb2Nlc3Mgc3RyZWFtcyBsaXZlIGV2ZW50cyBhbmQgUE9TVHMgbWVzc2FnZXMuIEhpc3RvcnkgaXMgbGF6eS1cbiAgICAgICAgLy8gbG9hZGVkIGJ5IHVzZUFzc2lzdGFudEhpc3Rvcnkgb24gc2Nyb2xsLXVwIChubyBibG9ja2luZyBmZXRjaCBoZXJlKS5cbiAgICAgICAgY29uc3QgeyBkaXNjb3ZlckFzc2lzdGFudFNlc3Npb25zIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vYXNzaXN0YW50L3Nlc3Npb25EaXNjb3ZlcnkuanMnXG4gICAgICAgIClcblxuICAgICAgICBsZXQgdGFyZ2V0U2Vzc2lvbklkID0gX3BlbmRpbmdBc3Npc3RhbnRDaGF0LnNlc3Npb25JZFxuXG4gICAgICAgIC8vIERpc2NvdmVyeSBmbG93IOKAlCBsaXN0IGJyaWRnZSBlbnZpcm9ubWVudHMsIGZpbHRlciBzZXNzaW9uc1xuICAgICAgICBpZiAoIXRhcmdldFNlc3Npb25JZCkge1xuICAgICAgICAgIGxldCBzZXNzaW9uc1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzZXNzaW9ucyA9IGF3YWl0IGRpc2NvdmVyQXNzaXN0YW50U2Vzc2lvbnMoKVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICBgRmFpbGVkIHRvIGRpc2NvdmVyIHNlc3Npb25zOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IGV9YCxcbiAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHNlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgbGV0IGluc3RhbGxlZERpcjogc3RyaW5nIHwgbnVsbFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgaW5zdGFsbGVkRGlyID0gYXdhaXQgbGF1bmNoQXNzaXN0YW50SW5zdGFsbFdpemFyZChyb290KVxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICAgIGBBc3Npc3RhbnQgaW5zdGFsbGF0aW9uIGZhaWxlZDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBlfWAsXG4gICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGluc3RhbGxlZERpciA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiBuZWVkcyBhIGZldyBzZWNvbmRzIHRvIHNwaW4gdXAgaXRzIHdvcmtlciBhbmRcbiAgICAgICAgICAgIC8vIGVzdGFibGlzaCBhIGJyaWRnZSBzZXNzaW9uIGJlZm9yZSBkaXNjb3Zlcnkgd2lsbCBmaW5kIGl0LlxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoTWVzc2FnZShcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgYEFzc2lzdGFudCBpbnN0YWxsZWQgaW4gJHtpbnN0YWxsZWREaXJ9LiBUaGUgZGFlbW9uIGlzIHN0YXJ0aW5nIHVwIOKAlCBydW4gXFxgY2xhdWRlIGFzc2lzdGFudFxcYCBhZ2FpbiBpbiBhIGZldyBzZWNvbmRzIHRvIGNvbm5lY3QuYCxcbiAgICAgICAgICAgICAgeyBleGl0Q29kZTogMCwgYmVmb3JlRXhpdDogKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigwKSB9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc2Vzc2lvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICB0YXJnZXRTZXNzaW9uSWQgPSBzZXNzaW9uc1swXSEuaWRcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcGlja2VkID0gYXdhaXQgbGF1bmNoQXNzaXN0YW50U2Vzc2lvbkNob29zZXIocm9vdCwge1xuICAgICAgICAgICAgICBzZXNzaW9ucyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAoIXBpY2tlZCkge1xuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFyZ2V0U2Vzc2lvbklkID0gcGlja2VkXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQXV0aCDigJQgY2FsbCBwcmVwYXJlQXBpUmVxdWVzdCgpIG9uY2UgZm9yIG9yZ1VVSUQsIGJ1dCB1c2UgYVxuICAgICAgICAvLyBnZXRBY2Nlc3NUb2tlbiBjbG9zdXJlIGZvciB0aGUgdG9rZW4gc28gcmVjb25uZWN0cyBnZXQgZnJlc2ggdG9rZW5zLlxuICAgICAgICBjb25zdCB7IGNoZWNrQW5kUmVmcmVzaE9BdXRoVG9rZW5JZk5lZWRlZCwgZ2V0Q2xhdWRlQUlPQXV0aFRva2VucyB9ID1cbiAgICAgICAgICBhd2FpdCBpbXBvcnQoJy4vdXRpbHMvYXV0aC5qcycpXG4gICAgICAgIGF3YWl0IGNoZWNrQW5kUmVmcmVzaE9BdXRoVG9rZW5JZk5lZWRlZCgpXG4gICAgICAgIGxldCBhcGlDcmVkc1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGFwaUNyZWRzID0gYXdhaXQgcHJlcGFyZUFwaVJlcXVlc3QoKVxuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgYEVycm9yOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6ICdGYWlsZWQgdG8gYXV0aGVudGljYXRlJ31gLFxuICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZ2V0QWNjZXNzVG9rZW4gPSAoKTogc3RyaW5nID0+XG4gICAgICAgICAgZ2V0Q2xhdWRlQUlPQXV0aFRva2VucygpPy5hY2Nlc3NUb2tlbiA/PyBhcGlDcmVkcy5hY2Nlc3NUb2tlblxuXG4gICAgICAgIC8vIEJyaWVmIG1vZGUgYWN0aXZhdGlvbjogc2V0S2Fpcm9zQWN0aXZlKHRydWUpIHNhdGlzZmllcyBCT1RIIG9wdC1pblxuICAgICAgICAvLyBhbmQgZW50aXRsZW1lbnQgZm9yIGlzQnJpZWZFbmFibGVkKCkgKEJyaWVmVG9vbC50czoxMjQtMTMyKS5cbiAgICAgICAgc2V0S2Fpcm9zQWN0aXZlKHRydWUpXG4gICAgICAgIHNldFVzZXJNc2dPcHRJbih0cnVlKVxuICAgICAgICBzZXRJc1JlbW90ZU1vZGUodHJ1ZSlcblxuICAgICAgICBjb25zdCByZW1vdGVTZXNzaW9uQ29uZmlnID0gY3JlYXRlUmVtb3RlU2Vzc2lvbkNvbmZpZyhcbiAgICAgICAgICB0YXJnZXRTZXNzaW9uSWQsXG4gICAgICAgICAgZ2V0QWNjZXNzVG9rZW4sXG4gICAgICAgICAgYXBpQ3JlZHMub3JnVVVJRCxcbiAgICAgICAgICAvKiBoYXNJbml0aWFsUHJvbXB0ICovIGZhbHNlLFxuICAgICAgICAgIC8qIHZpZXdlck9ubHkgKi8gdHJ1ZSxcbiAgICAgICAgKVxuXG4gICAgICAgIGNvbnN0IGluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBgQXR0YWNoZWQgdG8gYXNzaXN0YW50IHNlc3Npb24gJHt0YXJnZXRTZXNzaW9uSWQuc2xpY2UoMCwgOCl94oCmYCxcbiAgICAgICAgICAnaW5mbycsXG4gICAgICAgIClcblxuICAgICAgICBjb25zdCBhc3Npc3RhbnRJbml0aWFsU3RhdGU6IEFwcFN0YXRlID0ge1xuICAgICAgICAgIC4uLmluaXRpYWxTdGF0ZSxcbiAgICAgICAgICBpc0JyaWVmT25seTogdHJ1ZSxcbiAgICAgICAgICBrYWlyb3NFbmFibGVkOiBmYWxzZSxcbiAgICAgICAgICByZXBsQnJpZGdlRW5hYmxlZDogZmFsc2UsXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZW1vdGVDb21tYW5kcyA9IGZpbHRlckNvbW1hbmRzRm9yUmVtb3RlTW9kZShjb21tYW5kcylcbiAgICAgICAgYXdhaXQgbGF1bmNoUmVwbChcbiAgICAgICAgICByb290LFxuICAgICAgICAgIHsgZ2V0RnBzTWV0cmljcywgc3RhdHMsIGluaXRpYWxTdGF0ZTogYXNzaXN0YW50SW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgICAgICBjb21tYW5kczogcmVtb3RlQ29tbWFuZHMsXG4gICAgICAgICAgICBpbml0aWFsVG9vbHM6IFtdLFxuICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBbaW5mb01lc3NhZ2VdLFxuICAgICAgICAgICAgbWNwQ2xpZW50czogW10sXG4gICAgICAgICAgICBhdXRvQ29ubmVjdElkZUZsYWc6IGlkZSxcbiAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24sXG4gICAgICAgICAgICBkaXNhYmxlU2xhc2hDb21tYW5kcyxcbiAgICAgICAgICAgIHJlbW90ZVNlc3Npb25Db25maWcsXG4gICAgICAgICAgICB0aGlua2luZ0NvbmZpZyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlbmRlckFuZFJ1bixcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIG9wdGlvbnMucmVzdW1lIHx8XG4gICAgICAgIG9wdGlvbnMuZnJvbVByIHx8XG4gICAgICAgIHRlbGVwb3J0IHx8XG4gICAgICAgIHJlbW90ZSAhPT0gbnVsbFxuICAgICAgKSB7XG4gICAgICAgIC8vIEhhbmRsZSByZXN1bWUgZmxvdyAtIGZyb20gZmlsZSAoYW50LW9ubHkpLCBzZXNzaW9uIElELCBvciBpbnRlcmFjdGl2ZSBzZWxlY3RvclxuXG4gICAgICAgIC8vIENsZWFyIHN0YWxlIGNhY2hlcyBiZWZvcmUgcmVzdW1pbmcgdG8gZW5zdXJlIGZyZXNoIGZpbGUvc2tpbGwgZGlzY292ZXJ5XG4gICAgICAgIGNvbnN0IHsgY2xlYXJTZXNzaW9uQ2FjaGVzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY29tbWFuZHMvY2xlYXIvY2FjaGVzLmpzJ1xuICAgICAgICApXG4gICAgICAgIGNsZWFyU2Vzc2lvbkNhY2hlcygpXG5cbiAgICAgICAgbGV0IG1lc3NhZ2VzOiBNZXNzYWdlVHlwZVtdIHwgbnVsbCA9IG51bGxcbiAgICAgICAgbGV0IHByb2Nlc3NlZFJlc3VtZTogUHJvY2Vzc2VkUmVzdW1lIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkXG5cbiAgICAgICAgbGV0IG1heWJlU2Vzc2lvbklkID0gdmFsaWRhdGVVdWlkKG9wdGlvbnMucmVzdW1lKVxuICAgICAgICBsZXQgc2VhcmNoVGVybTogc3RyaW5nIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkXG4gICAgICAgIC8vIFN0b3JlIGZ1bGwgTG9nT3B0aW9uIHdoZW4gZm91bmQgYnkgY3VzdG9tIHRpdGxlIChmb3IgY3Jvc3Mtd29ya3RyZWUgcmVzdW1lKVxuICAgICAgICBsZXQgbWF0Y2hlZExvZzogTG9nT3B0aW9uIHwgbnVsbCA9IG51bGxcbiAgICAgICAgLy8gUFIgZmlsdGVyIGZvciAtLWZyb20tcHIgZmxhZ1xuICAgICAgICBsZXQgZmlsdGVyQnlQcjogYm9vbGVhbiB8IG51bWJlciB8IHN0cmluZyB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZFxuXG4gICAgICAgIC8vIEhhbmRsZSAtLWZyb20tcHIgZmxhZ1xuICAgICAgICBpZiAob3B0aW9ucy5mcm9tUHIpIHtcbiAgICAgICAgICBpZiAob3B0aW9ucy5mcm9tUHIgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIFNob3cgYWxsIHNlc3Npb25zIHdpdGggbGlua2VkIFBSc1xuICAgICAgICAgICAgZmlsdGVyQnlQciA9IHRydWVcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmZyb21QciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIC8vIENvdWxkIGJlIGEgUFIgbnVtYmVyIG9yIFVSTFxuICAgICAgICAgICAgZmlsdGVyQnlQciA9IG9wdGlvbnMuZnJvbVByXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgcmVzdW1lIHZhbHVlIGlzIG5vdCBhIFVVSUQsIHRyeSBleGFjdCBtYXRjaCBieSBjdXN0b20gdGl0bGUgZmlyc3RcbiAgICAgICAgaWYgKFxuICAgICAgICAgIG9wdGlvbnMucmVzdW1lICYmXG4gICAgICAgICAgdHlwZW9mIG9wdGlvbnMucmVzdW1lID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAgICFtYXliZVNlc3Npb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cmltbWVkVmFsdWUgPSBvcHRpb25zLnJlc3VtZS50cmltKClcbiAgICAgICAgICBpZiAodHJpbW1lZFZhbHVlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gYXdhaXQgc2VhcmNoU2Vzc2lvbnNCeUN1c3RvbVRpdGxlKHRyaW1tZWRWYWx1ZSwge1xuICAgICAgICAgICAgICBleGFjdDogdHJ1ZSxcbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGlmIChtYXRjaGVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAvLyBFeGFjdCBtYXRjaCBmb3VuZCAtIHN0b3JlIGZ1bGwgTG9nT3B0aW9uIGZvciBjcm9zcy13b3JrdHJlZSByZXN1bWVcbiAgICAgICAgICAgICAgbWF0Y2hlZExvZyA9IG1hdGNoZXNbMF0hXG4gICAgICAgICAgICAgIG1heWJlU2Vzc2lvbklkID0gZ2V0U2Vzc2lvbklkRnJvbUxvZyhtYXRjaGVkTG9nKSA/PyBudWxsXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBObyBtYXRjaCBvciBtdWx0aXBsZSBtYXRjaGVzIC0gdXNlIGFzIHNlYXJjaCB0ZXJtIGZvciBwaWNrZXJcbiAgICAgICAgICAgICAgc2VhcmNoVGVybSA9IHRyaW1tZWRWYWx1ZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIC0tcmVtb3RlIGFuZCAtLXRlbGVwb3J0IGJvdGggY3JlYXRlL3Jlc3VtZSBDbGF1ZGUgQ29kZSBXZWIgKENDUikgc2Vzc2lvbnMuXG4gICAgICAgIC8vIFJlbW90ZSBDb250cm9sICgtLXJjKSBpcyBhIHNlcGFyYXRlIGZlYXR1cmUgZ2F0ZWQgaW4gaW5pdFJlcGxCcmlkZ2UudHMuXG4gICAgICAgIGlmIChyZW1vdGUgIT09IG51bGwgfHwgdGVsZXBvcnQpIHtcbiAgICAgICAgICBhd2FpdCB3YWl0Rm9yUG9saWN5TGltaXRzVG9Mb2FkKClcbiAgICAgICAgICBpZiAoIWlzUG9saWN5QWxsb3dlZCgnYWxsb3dfcmVtb3RlX3Nlc3Npb25zJykpIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICBcIkVycm9yOiBSZW1vdGUgc2Vzc2lvbnMgYXJlIGRpc2FibGVkIGJ5IHlvdXIgb3JnYW5pemF0aW9uJ3MgcG9saWN5LlwiLFxuICAgICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZW1vdGUgIT09IG51bGwpIHtcbiAgICAgICAgICAvLyBDcmVhdGUgcmVtb3RlIHNlc3Npb24gKG9wdGlvbmFsbHkgd2l0aCBpbml0aWFsIHByb21wdClcbiAgICAgICAgICBjb25zdCBoYXNJbml0aWFsUHJvbXB0ID0gcmVtb3RlLmxlbmd0aCA+IDBcblxuICAgICAgICAgIC8vIENoZWNrIGlmIFRVSSBtb2RlIGlzIGVuYWJsZWQgLSBkZXNjcmlwdGlvbiBpcyBvbmx5IG9wdGlvbmFsIGluIFRVSSBtb2RlXG4gICAgICAgICAgY29uc3QgaXNSZW1vdGVUdWlFbmFibGVkID0gZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUoXG4gICAgICAgICAgICAndGVuZ3VfcmVtb3RlX2JhY2tlbmQnLFxuICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmICghaXNSZW1vdGVUdWlFbmFibGVkICYmICFoYXNJbml0aWFsUHJvbXB0KSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgJ0Vycm9yOiAtLXJlbW90ZSByZXF1aXJlcyBhIGRlc2NyaXB0aW9uLlxcblVzYWdlOiBjbGF1ZGUgLS1yZW1vdGUgXCJ5b3VyIHRhc2sgZGVzY3JpcHRpb25cIicsXG4gICAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3JlbW90ZV9jcmVhdGVfc2Vzc2lvbicsIHtcbiAgICAgICAgICAgIGhhc19pbml0aWFsX3Byb21wdDogU3RyaW5nKFxuICAgICAgICAgICAgICBoYXNJbml0aWFsUHJvbXB0LFxuICAgICAgICAgICAgKSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICAvLyBQYXNzIGN1cnJlbnQgYnJhbmNoIHNvIENDUiBjbG9uZXMgdGhlIHJlcG8gYXQgdGhlIHJpZ2h0IHJldmlzaW9uXG4gICAgICAgICAgY29uc3QgY3VycmVudEJyYW5jaCA9IGF3YWl0IGdldEJyYW5jaCgpXG4gICAgICAgICAgY29uc3QgY3JlYXRlZFNlc3Npb24gPSBhd2FpdCB0ZWxlcG9ydFRvUmVtb3RlV2l0aEVycm9ySGFuZGxpbmcoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgaGFzSW5pdGlhbFByb21wdCA/IHJlbW90ZSA6IG51bGwsXG4gICAgICAgICAgICBuZXcgQWJvcnRDb250cm9sbGVyKCkuc2lnbmFsLFxuICAgICAgICAgICAgY3VycmVudEJyYW5jaCB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmICghY3JlYXRlZFNlc3Npb24pIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9yZW1vdGVfY3JlYXRlX3Nlc3Npb25fZXJyb3InLCB7XG4gICAgICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgICAgICd1bmFibGVfdG9fY3JlYXRlX3Nlc3Npb24nIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICdFcnJvcjogVW5hYmxlIHRvIGNyZWF0ZSByZW1vdGUgc2Vzc2lvbicsXG4gICAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9yZW1vdGVfY3JlYXRlX3Nlc3Npb25fc3VjY2VzcycsIHtcbiAgICAgICAgICAgIHNlc3Npb25faWQ6XG4gICAgICAgICAgICAgIGNyZWF0ZWRTZXNzaW9uLmlkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgfSlcblxuICAgICAgICAgIC8vIENoZWNrIGlmIG5ldyByZW1vdGUgVFVJIG1vZGUgaXMgZW5hYmxlZCB2aWEgZmVhdHVyZSBnYXRlXG4gICAgICAgICAgaWYgKCFpc1JlbW90ZVR1aUVuYWJsZWQpIHtcbiAgICAgICAgICAgIC8vIE9yaWdpbmFsIGJlaGF2aW9yOiBwcmludCBzZXNzaW9uIGluZm8gYW5kIGV4aXRcbiAgICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgICBgQ3JlYXRlZCByZW1vdGUgc2Vzc2lvbjogJHtjcmVhdGVkU2Vzc2lvbi50aXRsZX1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICAgIGBWaWV3OiAke2dldFJlbW90ZVNlc3Npb25VcmwoY3JlYXRlZFNlc3Npb24uaWQpfT9tPTBcXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICAgIGBSZXN1bWUgd2l0aDogY2xhdWRlIC0tdGVsZXBvcnQgJHtjcmVhdGVkU2Vzc2lvbi5pZH1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgYXdhaXQgZ3JhY2VmdWxTaHV0ZG93bigwKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gTmV3IGJlaGF2aW9yOiBzdGFydCBsb2NhbCBUVUkgd2l0aCBDQ1IgZW5naW5lXG4gICAgICAgICAgLy8gTWFyayB0aGF0IHdlJ3JlIGluIHJlbW90ZSBtb2RlIGZvciBjb21tYW5kIHZpc2liaWxpdHlcbiAgICAgICAgICBzZXRJc1JlbW90ZU1vZGUodHJ1ZSlcbiAgICAgICAgICBzd2l0Y2hTZXNzaW9uKGFzU2Vzc2lvbklkKGNyZWF0ZWRTZXNzaW9uLmlkKSlcblxuICAgICAgICAgIC8vIEdldCBPQXV0aCBjcmVkZW50aWFscyBmb3IgcmVtb3RlIHNlc3Npb25cbiAgICAgICAgICBsZXQgYXBpQ3JlZHM6IHsgYWNjZXNzVG9rZW46IHN0cmluZzsgb3JnVVVJRDogc3RyaW5nIH1cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXBpQ3JlZHMgPSBhd2FpdCBwcmVwYXJlQXBpUmVxdWVzdCgpXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxvZ0Vycm9yKHRvRXJyb3IoZXJyb3IpKVxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgIGBFcnJvcjogJHtlcnJvck1lc3NhZ2UoZXJyb3IpIHx8ICdGYWlsZWQgdG8gYXV0aGVudGljYXRlJ31gLFxuICAgICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIENyZWF0ZSByZW1vdGUgc2Vzc2lvbiBjb25maWcgZm9yIHRoZSBSRVBMXG4gICAgICAgICAgY29uc3QgeyBnZXRDbGF1ZGVBSU9BdXRoVG9rZW5zOiBnZXRUb2tlbnNGb3JSZW1vdGUgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICcuL3V0aWxzL2F1dGguanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGNvbnN0IGdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlID0gKCk6IHN0cmluZyA9PlxuICAgICAgICAgICAgZ2V0VG9rZW5zRm9yUmVtb3RlKCk/LmFjY2Vzc1Rva2VuID8/IGFwaUNyZWRzLmFjY2Vzc1Rva2VuXG4gICAgICAgICAgY29uc3QgcmVtb3RlU2Vzc2lvbkNvbmZpZyA9IGNyZWF0ZVJlbW90ZVNlc3Npb25Db25maWcoXG4gICAgICAgICAgICBjcmVhdGVkU2Vzc2lvbi5pZCxcbiAgICAgICAgICAgIGdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlLFxuICAgICAgICAgICAgYXBpQ3JlZHMub3JnVVVJRCxcbiAgICAgICAgICAgIGhhc0luaXRpYWxQcm9tcHQsXG4gICAgICAgICAgKVxuXG4gICAgICAgICAgLy8gQWRkIHJlbW90ZSBzZXNzaW9uIGluZm8gYXMgaW5pdGlhbCBzeXN0ZW0gbWVzc2FnZVxuICAgICAgICAgIGNvbnN0IHJlbW90ZVNlc3Npb25VcmwgPSBgJHtnZXRSZW1vdGVTZXNzaW9uVXJsKGNyZWF0ZWRTZXNzaW9uLmlkKX0/bT0wYFxuICAgICAgICAgIGNvbnN0IHJlbW90ZUluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICAgIGAvcmVtb3RlLWNvbnRyb2wgaXMgYWN0aXZlLiBDb2RlIGluIENMSSBvciBhdCAke3JlbW90ZVNlc3Npb25Vcmx9YCxcbiAgICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgICApXG5cbiAgICAgICAgICAvLyBDcmVhdGUgaW5pdGlhbCB1c2VyIG1lc3NhZ2UgZnJvbSB0aGUgcHJvbXB0IGlmIHByb3ZpZGVkIChDQ1IgZWNob2VzIGl0IGJhY2sgYnV0IHdlIGlnbm9yZSB0aGF0KVxuICAgICAgICAgIGNvbnN0IGluaXRpYWxVc2VyTWVzc2FnZSA9IGhhc0luaXRpYWxQcm9tcHRcbiAgICAgICAgICAgID8gY3JlYXRlVXNlck1lc3NhZ2UoeyBjb250ZW50OiByZW1vdGUgfSlcbiAgICAgICAgICAgIDogbnVsbFxuXG4gICAgICAgICAgLy8gU2V0IHJlbW90ZSBzZXNzaW9uIFVSTCBpbiBhcHAgc3RhdGUgZm9yIGZvb3RlciBpbmRpY2F0b3JcbiAgICAgICAgICBjb25zdCByZW1vdGVJbml0aWFsU3RhdGUgPSB7XG4gICAgICAgICAgICAuLi5pbml0aWFsU3RhdGUsXG4gICAgICAgICAgICByZW1vdGVTZXNzaW9uVXJsLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFByZS1maWx0ZXIgY29tbWFuZHMgdG8gb25seSBpbmNsdWRlIHJlbW90ZS1zYWZlIG9uZXMuXG4gICAgICAgICAgLy8gQ0NSJ3MgaW5pdCByZXNwb25zZSBtYXkgZnVydGhlciByZWZpbmUgdGhlIGxpc3QgKHZpYSBoYW5kbGVSZW1vdGVJbml0IGluIFJFUEwpLlxuICAgICAgICAgIGNvbnN0IHJlbW90ZUNvbW1hbmRzID0gZmlsdGVyQ29tbWFuZHNGb3JSZW1vdGVNb2RlKGNvbW1hbmRzKVxuICAgICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlOiByZW1vdGVJbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgICAgICAgIGNvbW1hbmRzOiByZW1vdGVDb21tYW5kcyxcbiAgICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBpbml0aWFsVXNlck1lc3NhZ2VcbiAgICAgICAgICAgICAgICA/IFtyZW1vdGVJbmZvTWVzc2FnZSwgaW5pdGlhbFVzZXJNZXNzYWdlXVxuICAgICAgICAgICAgICAgIDogW3JlbW90ZUluZm9NZXNzYWdlXSxcbiAgICAgICAgICAgICAgbWNwQ2xpZW50czogW10sXG4gICAgICAgICAgICAgIGF1dG9Db25uZWN0SWRlRmxhZzogaWRlLFxuICAgICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICAgICAgICBkaXNhYmxlU2xhc2hDb21tYW5kcyxcbiAgICAgICAgICAgICAgcmVtb3RlU2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgICAgdGhpbmtpbmdDb25maWcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcmVuZGVyQW5kUnVuLFxuICAgICAgICAgIClcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgfSBlbHNlIGlmICh0ZWxlcG9ydCkge1xuICAgICAgICAgIGlmICh0ZWxlcG9ydCA9PT0gdHJ1ZSB8fCB0ZWxlcG9ydCA9PT0gJycpIHtcbiAgICAgICAgICAgIC8vIEludGVyYWN0aXZlIG1vZGU6IHNob3cgdGFzayBzZWxlY3RvciBhbmQgaGFuZGxlIHJlc3VtZVxuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3RlbGVwb3J0X2ludGVyYWN0aXZlX21vZGUnLCB7fSlcbiAgICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgICAgJ3NlbGVjdEFuZFJlc3VtZVRlbGVwb3J0VGFzazogU3RhcnRpbmcgdGVsZXBvcnQgZmxvdy4uLicsXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCB0ZWxlcG9ydFJlc3VsdCA9IGF3YWl0IGxhdW5jaFRlbGVwb3J0UmVzdW1lV3JhcHBlcihyb290KVxuICAgICAgICAgICAgaWYgKCF0ZWxlcG9ydFJlc3VsdCkge1xuICAgICAgICAgICAgICAvLyBVc2VyIGNhbmNlbGxlZCBvciBlcnJvciBvY2N1cnJlZFxuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgeyBicmFuY2hFcnJvciB9ID0gYXdhaXQgY2hlY2tPdXRUZWxlcG9ydGVkU2Vzc2lvbkJyYW5jaChcbiAgICAgICAgICAgICAgdGVsZXBvcnRSZXN1bHQuYnJhbmNoLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgbWVzc2FnZXMgPSBwcm9jZXNzTWVzc2FnZXNGb3JUZWxlcG9ydFJlc3VtZShcbiAgICAgICAgICAgICAgdGVsZXBvcnRSZXN1bHQubG9nLFxuICAgICAgICAgICAgICBicmFuY2hFcnJvcixcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB0ZWxlcG9ydCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV90ZWxlcG9ydF9yZXN1bWVfc2Vzc2lvbicsIHtcbiAgICAgICAgICAgICAgbW9kZTogJ2RpcmVjdCcgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAvLyBGaXJzdCwgZmV0Y2ggc2Vzc2lvbiBhbmQgdmFsaWRhdGUgcmVwb3NpdG9yeSBiZWZvcmUgY2hlY2tpbmcgZ2l0IHN0YXRlXG4gICAgICAgICAgICAgIGNvbnN0IHNlc3Npb25EYXRhID0gYXdhaXQgZmV0Y2hTZXNzaW9uKHRlbGVwb3J0KVxuICAgICAgICAgICAgICBjb25zdCByZXBvVmFsaWRhdGlvbiA9XG4gICAgICAgICAgICAgICAgYXdhaXQgdmFsaWRhdGVTZXNzaW9uUmVwb3NpdG9yeShzZXNzaW9uRGF0YSlcblxuICAgICAgICAgICAgICAvLyBIYW5kbGUgcmVwbyBtaXNtYXRjaCBvciBub3QgaW4gcmVwbyBjYXNlc1xuICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgcmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnbWlzbWF0Y2gnIHx8XG4gICAgICAgICAgICAgICAgcmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnbm90X2luX3JlcG8nXG4gICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlc3Npb25SZXBvID0gcmVwb1ZhbGlkYXRpb24uc2Vzc2lvblJlcG9cbiAgICAgICAgICAgICAgICBpZiAoc2Vzc2lvblJlcG8pIHtcbiAgICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBrbm93biBwYXRoc1xuICAgICAgICAgICAgICAgICAgY29uc3Qga25vd25QYXRocyA9IGdldEtub3duUGF0aHNGb3JSZXBvKHNlc3Npb25SZXBvKVxuICAgICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdQYXRocyA9IGF3YWl0IGZpbHRlckV4aXN0aW5nUGF0aHMoa25vd25QYXRocylcblxuICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUGF0aHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBTaG93IGRpcmVjdG9yeSBzd2l0Y2ggZGlhbG9nXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkUGF0aCA9IGF3YWl0IGxhdW5jaFRlbGVwb3J0UmVwb01pc21hdGNoRGlhbG9nKFxuICAgICAgICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0UmVwbzogc2Vzc2lvblJlcG8sXG4gICAgICAgICAgICAgICAgICAgICAgICBpbml0aWFsUGF0aHM6IGV4aXN0aW5nUGF0aHMsXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzZWxlY3RlZFBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAvLyBDaGFuZ2UgdG8gdGhlIHNlbGVjdGVkIGRpcmVjdG9yeVxuICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuY2hkaXIoc2VsZWN0ZWRQYXRoKVxuICAgICAgICAgICAgICAgICAgICAgIHNldEN3ZChzZWxlY3RlZFBhdGgpXG4gICAgICAgICAgICAgICAgICAgICAgc2V0T3JpZ2luYWxDd2Qoc2VsZWN0ZWRQYXRoKVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgIC8vIFVzZXIgY2FuY2VsbGVkXG4gICAgICAgICAgICAgICAgICAgICAgYXdhaXQgZ3JhY2VmdWxTaHV0ZG93bigwKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBObyBrbm93biBwYXRocyAtIHNob3cgb3JpZ2luYWwgZXJyb3JcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgYFlvdSBtdXN0IHJ1biBjbGF1ZGUgLS10ZWxlcG9ydCAke3RlbGVwb3J0fSBmcm9tIGEgY2hlY2tvdXQgb2YgJHtzZXNzaW9uUmVwb30uYCxcbiAgICAgICAgICAgICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICAgICAgICAgICBgWW91IG11c3QgcnVuIGNsYXVkZSAtLXRlbGVwb3J0ICR7dGVsZXBvcnR9IGZyb20gYSBjaGVja291dCBvZiAke2NoYWxrLmJvbGQoc2Vzc2lvblJlcG8pfS5cXG5gLFxuICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnZXJyb3InKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICByZXBvVmFsaWRhdGlvbi5lcnJvck1lc3NhZ2UgfHwgJ0ZhaWxlZCB0byB2YWxpZGF0ZSBzZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICAgICAgYEVycm9yOiAke3JlcG9WYWxpZGF0aW9uLmVycm9yTWVzc2FnZSB8fCAnRmFpbGVkIHRvIHZhbGlkYXRlIHNlc3Npb24nfVxcbmAsXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGF3YWl0IHZhbGlkYXRlR2l0U3RhdGUoKVxuXG4gICAgICAgICAgICAgIC8vIFVzZSBwcm9ncmVzcyBVSSBmb3IgdGVsZXBvcnRcbiAgICAgICAgICAgICAgY29uc3QgeyB0ZWxlcG9ydFdpdGhQcm9ncmVzcyB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICAgICAgICcuL2NvbXBvbmVudHMvVGVsZXBvcnRQcm9ncmVzcy5qcydcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0ZWxlcG9ydFdpdGhQcm9ncmVzcyhyb290LCB0ZWxlcG9ydClcbiAgICAgICAgICAgICAgLy8gVHJhY2sgdGVsZXBvcnRlZCBzZXNzaW9uIGZvciByZWxpYWJpbGl0eSBsb2dnaW5nXG4gICAgICAgICAgICAgIHNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyh7IHNlc3Npb25JZDogdGVsZXBvcnQgfSlcbiAgICAgICAgICAgICAgbWVzc2FnZXMgPSByZXN1bHQubWVzc2FnZXNcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IpIHtcbiAgICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShlcnJvci5mb3JtYXR0ZWRNZXNzYWdlICsgJ1xcbicpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgICBjaGFsay5yZWQoYEVycm9yOiAke2Vycm9yTWVzc2FnZShlcnJvcil9XFxuYCksXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IGdyYWNlZnVsU2h1dGRvd24oMSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBvcHRpb25zLnJlc3VtZSAmJlxuICAgICAgICAgICAgdHlwZW9mIG9wdGlvbnMucmVzdW1lID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAgICAgIW1heWJlU2Vzc2lvbklkXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgY2NzaGFyZSBVUkwgKGUuZy4gaHR0cHM6Ly9nby9jY3NoYXJlL2JvcmlzLTIwMjYwMzExLTIxMTAzNilcbiAgICAgICAgICAgIGNvbnN0IHsgcGFyc2VDY3NoYXJlSWQsIGxvYWRDY3NoYXJlIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAgICcuL3V0aWxzL2Njc2hhcmVSZXN1bWUuanMnXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCBjY3NoYXJlSWQgPSBwYXJzZUNjc2hhcmVJZChvcHRpb25zLnJlc3VtZSlcbiAgICAgICAgICAgIGlmIChjY3NoYXJlSWQpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG4gICAgICAgICAgICAgICAgY29uc3QgbG9nT3B0aW9uID0gYXdhaXQgbG9hZENjc2hhcmUoY2NzaGFyZUlkKVxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGxvYWRDb252ZXJzYXRpb25Gb3JSZXN1bWUoXG4gICAgICAgICAgICAgICAgICBsb2dPcHRpb24sXG4gICAgICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZSA9IGF3YWl0IHByb2Nlc3NSZXN1bWVkQ29udmVyc2F0aW9uKFxuICAgICAgICAgICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICBmb3JrU2Vzc2lvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0UGF0aDogcmVzdWx0LmZ1bGxQYXRoLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICByZXN1bWVDb250ZXh0LFxuICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgaWYgKHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmKSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gPSBwcm9jZXNzZWRSZXN1bWUucmVzdG9yZWRBZ2VudERlZlxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50cnlwb2ludDpcbiAgICAgICAgICAgICAgICAgICAgICAnY2NzaGFyZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVzdW1lX2R1cmF0aW9uX21zOiBNYXRoLnJvdW5kKFxuICAgICAgICAgICAgICAgICAgICAgIHBlcmZvcm1hbmNlLm5vdygpIC0gcmVzdW1lU3RhcnQsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc2Vzc2lvbl9yZXN1bWVkJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAgICdjY3NoYXJlJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zZXNzaW9uX3Jlc3VtZWQnLCB7XG4gICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAnY2NzaGFyZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgICAgICAgYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgICBgVW5hYmxlIHRvIHJlc3VtZSBmcm9tIGNjc2hhcmU6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gLFxuICAgICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkUGF0aCA9IHJlc29sdmUob3B0aW9ucy5yZXN1bWUpXG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdW1lU3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKVxuICAgICAgICAgICAgICAgIGxldCBsb2dPcHRpb25cbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgLy8gQXR0ZW1wdCB0byBsb2FkIGFzIGEgdHJhbnNjcmlwdCBmaWxlOyBFTk9FTlQgZmFsbHMgdGhyb3VnaCB0byBzZXNzaW9uLUlEIGhhbmRsaW5nXG4gICAgICAgICAgICAgICAgICBsb2dPcHRpb24gPSBhd2FpdCBsb2FkVHJhbnNjcmlwdEZyb21GaWxlKHJlc29sdmVkUGF0aClcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgaWYgKCFpc0VOT0VOVChlcnJvcikpIHRocm93IGVycm9yXG4gICAgICAgICAgICAgICAgICAvLyBFTk9FTlQ6IG5vdCBhIGZpbGUgcGF0aCDigJQgZmFsbCB0aHJvdWdoIHRvIHNlc3Npb24tSUQgaGFuZGxpbmdcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGxvZ09wdGlvbikge1xuICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZShcbiAgICAgICAgICAgICAgICAgICAgbG9nT3B0aW9uLFxuICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWQgLyogc291cmNlRmlsZSAqLyxcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgcHJvY2Vzc2VkUmVzdW1lID0gYXdhaXQgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcmtTZXNzaW9uOiAhIW9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0UGF0aDogcmVzdWx0LmZ1bGxQYXRoLFxuICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgcmVzdW1lQ29udGV4dCxcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICBpZiAocHJvY2Vzc2VkUmVzdW1lLnJlc3RvcmVkQWdlbnREZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uID1cbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAgICAgJ2ZpbGUnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICByZXN1bWVfZHVyYXRpb25fbXM6IE1hdGgucm91bmQoXG4gICAgICAgICAgICAgICAgICAgICAgICBwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0LFxuICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc2Vzc2lvbl9yZXN1bWVkJywge1xuICAgICAgICAgICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAnZmlsZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgICAgICdmaWxlJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICBsb2dFcnJvcihlcnJvcilcbiAgICAgICAgICAgICAgICBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgICAgIGBVbmFibGUgdG8gbG9hZCB0cmFuc2NyaXB0IGZyb20gZmlsZTogJHtvcHRpb25zLnJlc3VtZX1gLFxuICAgICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiBub3QgbG9hZGVkIGFzIGEgZmlsZSwgdHJ5IGFzIHNlc3Npb24gSURcbiAgICAgICAgaWYgKG1heWJlU2Vzc2lvbklkKSB7XG4gICAgICAgICAgLy8gUmVzdW1lIHNwZWNpZmljIHNlc3Npb24gYnkgSURcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSBtYXliZVNlc3Npb25JZFxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG4gICAgICAgICAgICAvLyBVc2UgbWF0Y2hlZExvZyBpZiBhdmFpbGFibGUgKGZvciBjcm9zcy13b3JrdHJlZSByZXN1bWUgYnkgY3VzdG9tIHRpdGxlKVxuICAgICAgICAgICAgLy8gT3RoZXJ3aXNlIGZhbGwgYmFjayB0byBzZXNzaW9uSWQgc3RyaW5nIChmb3IgZGlyZWN0IFVVSUQgcmVzdW1lKVxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZShcbiAgICAgICAgICAgICAgbWF0Y2hlZExvZyA/PyBzZXNzaW9uSWQsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgJ2NsaV9mbGFnJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICAgIGBObyBjb252ZXJzYXRpb24gZm91bmQgd2l0aCBzZXNzaW9uIElEOiAke3Nlc3Npb25JZH1gLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gbWF0Y2hlZExvZz8uZnVsbFBhdGggPz8gcmVzdWx0LmZ1bGxQYXRoXG4gICAgICAgICAgICBwcm9jZXNzZWRSZXN1bWUgPSBhd2FpdCBwcm9jZXNzUmVzdW1lZENvbnZlcnNhdGlvbihcbiAgICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgZm9ya1Nlc3Npb246ICEhb3B0aW9ucy5mb3JrU2Vzc2lvbixcbiAgICAgICAgICAgICAgICBzZXNzaW9uSWRPdmVycmlkZTogc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRQYXRoOiBmdWxsUGF0aCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcmVzdW1lQ29udGV4dCxcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmKSB7XG4gICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gPSBwcm9jZXNzZWRSZXN1bWUucmVzdG9yZWRBZ2VudERlZlxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgZW50cnlwb2ludDpcbiAgICAgICAgICAgICAgICAnY2xpX2ZsYWcnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgICAgIHJlc3VtZV9kdXJhdGlvbl9tczogTWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0KSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zZXNzaW9uX3Jlc3VtZWQnLCB7XG4gICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgJ2NsaV9mbGFnJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBsb2dFcnJvcihlcnJvcilcbiAgICAgICAgICAgIGF3YWl0IGV4aXRXaXRoRXJyb3Iocm9vdCwgYEZhaWxlZCB0byByZXN1bWUgc2Vzc2lvbiAke3Nlc3Npb25JZH1gKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEF3YWl0IGZpbGUgZG93bmxvYWRzIGJlZm9yZSByZW5kZXJpbmcgUkVQTCAoZmlsZXMgbXVzdCBiZSBhdmFpbGFibGUpXG4gICAgICAgIGlmIChmaWxlRG93bmxvYWRQcm9taXNlKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBmaWxlRG93bmxvYWRQcm9taXNlXG4gICAgICAgICAgICBjb25zdCBmYWlsZWRDb3VudCA9IGNvdW50KHJlc3VsdHMsIHIgPT4gIXIuc3VjY2VzcylcbiAgICAgICAgICAgIGlmIChmYWlsZWRDb3VudCA+IDApIHtcbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgY2hhbGsueWVsbG93KFxuICAgICAgICAgICAgICAgICAgYFdhcm5pbmc6ICR7ZmFpbGVkQ291bnR9LyR7cmVzdWx0cy5sZW5ndGh9IGZpbGUocykgZmFpbGVkIHRvIGRvd25sb2FkLlxcbmAsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgYEVycm9yIGRvd25sb2FkaW5nIGZpbGVzOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB3ZSBoYXZlIGEgcHJvY2Vzc2VkIHJlc3VtZSBvciB0ZWxlcG9ydCBtZXNzYWdlcywgcmVuZGVyIHRoZSBSRVBMXG4gICAgICAgIGNvbnN0IHJlc3VtZURhdGEgPVxuICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZSA/P1xuICAgICAgICAgIChBcnJheS5pc0FycmF5KG1lc3NhZ2VzKVxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgbWVzc2FnZXMsXG4gICAgICAgICAgICAgICAgZmlsZUhpc3RvcnlTbmFwc2hvdHM6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBhZ2VudE5hbWU6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBhZ2VudENvbG9yOiB1bmRlZmluZWQgYXMgQWdlbnRDb2xvck5hbWUgfCB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgcmVzdG9yZWRBZ2VudERlZjogbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgICBpbml0aWFsU3RhdGUsXG4gICAgICAgICAgICAgICAgY29udGVudFJlcGxhY2VtZW50czogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZClcbiAgICAgICAgaWYgKHJlc3VtZURhdGEpIHtcbiAgICAgICAgICBtYXliZUFjdGl2YXRlUHJvYWN0aXZlKG9wdGlvbnMpXG4gICAgICAgICAgbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnMpXG5cbiAgICAgICAgICBhd2FpdCBsYXVuY2hSZXBsKFxuICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgIHsgZ2V0RnBzTWV0cmljcywgc3RhdHMsIGluaXRpYWxTdGF0ZTogcmVzdW1lRGF0YS5pbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgLi4uc2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbjpcbiAgICAgICAgICAgICAgICByZXN1bWVEYXRhLnJlc3RvcmVkQWdlbnREZWYgPz8gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiByZXN1bWVEYXRhLm1lc3NhZ2VzLFxuICAgICAgICAgICAgICBpbml0aWFsRmlsZUhpc3RvcnlTbmFwc2hvdHM6IHJlc3VtZURhdGEuZmlsZUhpc3RvcnlTbmFwc2hvdHMsXG4gICAgICAgICAgICAgIGluaXRpYWxDb250ZW50UmVwbGFjZW1lbnRzOiByZXN1bWVEYXRhLmNvbnRlbnRSZXBsYWNlbWVudHMsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudE5hbWU6IHJlc3VtZURhdGEuYWdlbnROYW1lLFxuICAgICAgICAgICAgICBpbml0aWFsQWdlbnRDb2xvcjogcmVzdW1lRGF0YS5hZ2VudENvbG9yLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHJlbmRlckFuZFJ1bixcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gU2hvdyBpbnRlcmFjdGl2ZSBzZWxlY3RvciAoaW5jbHVkZXMgc2FtZS1yZXBvIHdvcmt0cmVlcylcbiAgICAgICAgICAvLyBOb3RlOiBSZXN1bWVDb252ZXJzYXRpb24gbG9hZHMgbG9ncyBpbnRlcm5hbGx5IHRvIGVuc3VyZSBwcm9wZXIgR0MgYWZ0ZXIgc2VsZWN0aW9uXG4gICAgICAgICAgYXdhaXQgbGF1bmNoUmVzdW1lQ2hvb3NlcihcbiAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIGdldFdvcmt0cmVlUGF0aHMoZ2V0T3JpZ2luYWxDd2QoKSksXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLnNlc3Npb25Db25maWcsXG4gICAgICAgICAgICAgIGluaXRpYWxTZWFyY2hRdWVyeTogc2VhcmNoVGVybSxcbiAgICAgICAgICAgICAgZm9ya1Nlc3Npb246IG9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgIGZpbHRlckJ5UHIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB1bnJlc29sdmVkIGhvb2tzIHByb21pc2UgdG8gUkVQTCBzbyBpdCBjYW4gcmVuZGVyIGltbWVkaWF0ZWx5XG4gICAgICAgIC8vIGluc3RlYWQgb2YgYmxvY2tpbmcgfjUwMG1zIHdhaXRpbmcgZm9yIFNlc3Npb25TdGFydCBob29rcyB0byBmaW5pc2guXG4gICAgICAgIC8vIFJFUEwgd2lsbCBpbmplY3QgaG9vayBtZXNzYWdlcyB3aGVuIHRoZXkgcmVzb2x2ZSBhbmQgYXdhaXQgdGhlbSBiZWZvcmVcbiAgICAgICAgLy8gdGhlIGZpcnN0IEFQSSBjYWxsIHNvIHRoZSBtb2RlbCBhbHdheXMgc2VlcyBob29rIGNvbnRleHQuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdIb29rTWVzc2FnZXMgPVxuICAgICAgICAgIGhvb2tzUHJvbWlzZSAmJiBob29rTWVzc2FnZXMubGVuZ3RoID09PSAwID8gaG9va3NQcm9taXNlIDogdW5kZWZpbmVkXG5cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl9hZnRlcl9ob29rcycpXG4gICAgICAgIG1heWJlQWN0aXZhdGVQcm9hY3RpdmUob3B0aW9ucylcbiAgICAgICAgbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnMpXG4gICAgICAgIC8vIFBlcnNpc3QgdGhlIGN1cnJlbnQgbW9kZSBmb3IgZnJlc2ggc2Vzc2lvbnMgc28gZnV0dXJlIHJlc3VtZXMga25vdyB3aGF0IG1vZGUgd2FzIHVzZWRcbiAgICAgICAgaWYgKGZlYXR1cmUoJ0NPT1JESU5BVE9SX01PREUnKSkge1xuICAgICAgICAgIHNhdmVNb2RlKFxuICAgICAgICAgICAgY29vcmRpbmF0b3JNb2RlTW9kdWxlPy5pc0Nvb3JkaW5hdG9yTW9kZSgpXG4gICAgICAgICAgICAgID8gJ2Nvb3JkaW5hdG9yJ1xuICAgICAgICAgICAgICA6ICdub3JtYWwnLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIGxhdW5jaGVkIHZpYSBhIGRlZXAgbGluaywgc2hvdyBhIHByb3ZlbmFuY2UgYmFubmVyIHNvIHRoZSB1c2VyXG4gICAgICAgIC8vIGtub3dzIHRoZSBzZXNzaW9uIG9yaWdpbmF0ZWQgZXh0ZXJuYWxseS4gTGludXggeGRnLW9wZW4gYW5kXG4gICAgICAgIC8vIGJyb3dzZXJzIHdpdGggXCJhbHdheXMgYWxsb3dcIiBzZXQgZGlzcGF0Y2ggdGhlIGxpbmsgd2l0aCBubyBPUy1sZXZlbFxuICAgICAgICAvLyBjb25maXJtYXRpb24sIHNvIHRoaXMgaXMgdGhlIG9ubHkgc2lnbmFsIHRoZSB1c2VyIGdldHMgdGhhdCB0aGVcbiAgICAgICAgLy8gcHJvbXB0IOKAlCBhbmQgdGhlIHdvcmtpbmcgZGlyZWN0b3J5IC8gQ0xBVURFLm1kIGl0IGltcGxpZXMg4oCUIGNhbWVcbiAgICAgICAgLy8gZnJvbSBhbiBleHRlcm5hbCBzb3VyY2UgcmF0aGVyIHRoYW4gc29tZXRoaW5nIHRoZXkgdHlwZWQuXG4gICAgICAgIGxldCBkZWVwTGlua0Jhbm5lcjogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlU3lzdGVtTWVzc2FnZT4gfCBudWxsID0gbnVsbFxuICAgICAgICBpZiAoZmVhdHVyZSgnTE9ERVNUT05FJykpIHtcbiAgICAgICAgICBpZiAob3B0aW9ucy5kZWVwTGlua09yaWdpbikge1xuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2RlZXBfbGlua19vcGVuZWQnLCB7XG4gICAgICAgICAgICAgIGhhc19wcmVmaWxsOiBCb29sZWFuKG9wdGlvbnMucHJlZmlsbCksXG4gICAgICAgICAgICAgIGhhc19yZXBvOiBCb29sZWFuKG9wdGlvbnMuZGVlcExpbmtSZXBvKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBkZWVwTGlua0Jhbm5lciA9IGNyZWF0ZVN5c3RlbU1lc3NhZ2UoXG4gICAgICAgICAgICAgIGJ1aWxkRGVlcExpbmtCYW5uZXIoe1xuICAgICAgICAgICAgICAgIGN3ZDogZ2V0Q3dkKCksXG4gICAgICAgICAgICAgICAgcHJlZmlsbExlbmd0aDogb3B0aW9ucy5wcmVmaWxsPy5sZW5ndGgsXG4gICAgICAgICAgICAgICAgcmVwbzogb3B0aW9ucy5kZWVwTGlua1JlcG8sXG4gICAgICAgICAgICAgICAgbGFzdEZldGNoOlxuICAgICAgICAgICAgICAgICAgb3B0aW9ucy5kZWVwTGlua0xhc3RGZXRjaCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8gbmV3IERhdGUob3B0aW9ucy5kZWVwTGlua0xhc3RGZXRjaClcbiAgICAgICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICAnd2FybmluZycsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLnByZWZpbGwpIHtcbiAgICAgICAgICAgIGRlZXBMaW5rQmFubmVyID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICAgICAgJ0xhdW5jaGVkIHdpdGggYSBwcmUtZmlsbGVkIHByb21wdCDigJQgcmV2aWV3IGl0IGJlZm9yZSBwcmVzc2luZyBFbnRlci4nLFxuICAgICAgICAgICAgICAnd2FybmluZycsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGluaXRpYWxNZXNzYWdlcyA9IGRlZXBMaW5rQmFubmVyXG4gICAgICAgICAgPyBbZGVlcExpbmtCYW5uZXIsIC4uLmhvb2tNZXNzYWdlc11cbiAgICAgICAgICA6IGhvb2tNZXNzYWdlcy5sZW5ndGggPiAwXG4gICAgICAgICAgICA/IGhvb2tNZXNzYWdlc1xuICAgICAgICAgICAgOiB1bmRlZmluZWRcblxuICAgICAgICBhd2FpdCBsYXVuY2hSZXBsKFxuICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgLi4uc2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlcyxcbiAgICAgICAgICAgIHBlbmRpbmdIb29rTWVzc2FnZXMsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgIClcbiAgICAgIH1cbiAgICB9KVxuICAgIC52ZXJzaW9uKFxuICAgICAgYCR7TUFDUk8uVkVSU0lPTn0gKE9wZW5DbGF1ZGUpYCxcbiAgICAgICctdiwgLS12ZXJzaW9uJyxcbiAgICAgICdPdXRwdXQgdGhlIHZlcnNpb24gbnVtYmVyJyxcbiAgICApXG5cbiAgLy8gV29ya3RyZWUgZmxhZ3NcbiAgcHJvZ3JhbS5vcHRpb24oXG4gICAgJy13LCAtLXdvcmt0cmVlIFtuYW1lXScsXG4gICAgJ0NyZWF0ZSBhIG5ldyBnaXQgd29ya3RyZWUgZm9yIHRoaXMgc2Vzc2lvbiAob3B0aW9uYWxseSBzcGVjaWZ5IGEgbmFtZSknLFxuICApXG4gIHByb2dyYW0ub3B0aW9uKFxuICAgICctLXRtdXgnLFxuICAgICdDcmVhdGUgYSB0bXV4IHNlc3Npb24gZm9yIHRoZSB3b3JrdHJlZSAocmVxdWlyZXMgLS13b3JrdHJlZSkuIFVzZXMgaVRlcm0yIG5hdGl2ZSBwYW5lcyB3aGVuIGF2YWlsYWJsZTsgdXNlIC0tdG11eD1jbGFzc2ljIGZvciB0cmFkaXRpb25hbCB0bXV4LicsXG4gIClcblxuICBpZiAoY2FuVXNlckNvbmZpZ3VyZUFkdmlzb3IoKSkge1xuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tYWR2aXNvciA8bW9kZWw+JyxcbiAgICAgICAgJ0VuYWJsZSB0aGUgc2VydmVyLXNpZGUgYWR2aXNvciB0b29sIHdpdGggdGhlIHNwZWNpZmllZCBtb2RlbCAoYWxpYXMgb3IgZnVsbCBJRCkuJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gIH1cblxuICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tZGVsZWdhdGUtcGVybWlzc2lvbnMnLFxuICAgICAgICAnW0FOVC1PTkxZXSBBbGlhcyBmb3IgLS1wZXJtaXNzaW9uLW1vZGUgYXV0by4nLFxuICAgICAgKS5pbXBsaWVzKHsgcGVybWlzc2lvbk1vZGU6ICdhdXRvJyB9KSxcbiAgICApXG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zLXdpdGgtY2xhc3NpZmllcnMnLFxuICAgICAgICAnW0FOVC1PTkxZXSBEZXByZWNhdGVkIGFsaWFzIGZvciAtLXBlcm1pc3Npb24tbW9kZSBhdXRvLicsXG4gICAgICApXG4gICAgICAgIC5oaWRlSGVscCgpXG4gICAgICAgIC5pbXBsaWVzKHsgcGVybWlzc2lvbk1vZGU6ICdhdXRvJyB9KSxcbiAgICApXG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1hZmsnLFxuICAgICAgICAnW0FOVC1PTkxZXSBEZXByZWNhdGVkIGFsaWFzIGZvciAtLXBlcm1pc3Npb24tbW9kZSBhdXRvLicsXG4gICAgICApXG4gICAgICAgIC5oaWRlSGVscCgpXG4gICAgICAgIC5pbXBsaWVzKHsgcGVybWlzc2lvbk1vZGU6ICdhdXRvJyB9KSxcbiAgICApXG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS10YXNrcyBbaWRdJyxcbiAgICAgICAgJ1tBTlQtT05MWV0gVGFza3MgbW9kZTogd2F0Y2ggZm9yIHRhc2tzIGFuZCBhdXRvLXByb2Nlc3MgdGhlbS4gT3B0aW9uYWwgaWQgaXMgdXNlZCBhcyBib3RoIHRoZSB0YXNrIGxpc3QgSUQgYW5kIGFnZW50IElEIChkZWZhdWx0cyB0byBcInRhc2tsaXN0XCIpLicsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgcHJvZ3JhbS5vcHRpb24oXG4gICAgICAnLS1hZ2VudC10ZWFtcycsXG4gICAgICAnW0FOVC1PTkxZXSBGb3JjZSBDbGF1ZGUgdG8gdXNlIG11bHRpLWFnZW50IG1vZGUgZm9yIHNvbHZpbmcgcHJvYmxlbXMnLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gIH1cblxuICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oJy0tZW5hYmxlLWF1dG8tbW9kZScsICdPcHQgaW4gdG8gYXV0byBtb2RlJykuaGlkZUhlbHAoKSxcbiAgICApXG4gIH1cblxuICBpZiAoZmVhdHVyZSgnUFJPQUNUSVZFJykgfHwgZmVhdHVyZSgnS0FJUk9TJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oJy0tcHJvYWN0aXZlJywgJ1N0YXJ0IGluIHByb2FjdGl2ZSBhdXRvbm9tb3VzIG1vZGUnKSxcbiAgICApXG4gIH1cblxuICBpZiAoZmVhdHVyZSgnVURTX0lOQk9YJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLW1lc3NhZ2luZy1zb2NrZXQtcGF0aCA8cGF0aD4nLFxuICAgICAgICAnVW5peCBkb21haW4gc29ja2V0IHBhdGggZm9yIHRoZSBVRFMgbWVzc2FnaW5nIHNlcnZlciAoZGVmYXVsdHMgdG8gYSB0bXAgcGF0aCknLFxuICAgICAgKSxcbiAgICApXG4gIH1cblxuICBpZiAoZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0JSSUVGJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWJyaWVmJyxcbiAgICAgICAgJ0VuYWJsZSBTZW5kVXNlck1lc3NhZ2UgdG9vbCBmb3IgYWdlbnQtdG8tdXNlciBjb21tdW5pY2F0aW9uJyxcbiAgICAgICksXG4gICAgKVxuICB9XG4gIGlmIChmZWF0dXJlKCdLQUlST1MnKSkge1xuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tYXNzaXN0YW50JyxcbiAgICAgICAgJ0ZvcmNlIGFzc2lzdGFudCBtb2RlIChBZ2VudCBTREsgZGFlbW9uIHVzZSknLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgfVxuICBpZiAoZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0NIQU5ORUxTJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWNoYW5uZWxzIDxzZXJ2ZXJzLi4uPicsXG4gICAgICAgICdNQ1Agc2VydmVycyB3aG9zZSBjaGFubmVsIG5vdGlmaWNhdGlvbnMgKGluYm91bmQgcHVzaCkgc2hvdWxkIHJlZ2lzdGVyIHRoaXMgc2Vzc2lvbi4gU3BhY2Utc2VwYXJhdGVkIHNlcnZlciBuYW1lcy4nLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWRhbmdlcm91c2x5LWxvYWQtZGV2ZWxvcG1lbnQtY2hhbm5lbHMgPHNlcnZlcnMuLi4+JyxcbiAgICAgICAgJ0xvYWQgY2hhbm5lbCBzZXJ2ZXJzIG5vdCBvbiB0aGUgYXBwcm92ZWQgYWxsb3dsaXN0LiBGb3IgbG9jYWwgY2hhbm5lbCBkZXZlbG9wbWVudCBvbmx5LiBTaG93cyBhIGNvbmZpcm1hdGlvbiBkaWFsb2cgYXQgc3RhcnR1cC4nLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgfVxuXG4gIC8vIFRlYW1tYXRlIGlkZW50aXR5IG9wdGlvbnMgKHNldCBieSBsZWFkZXIgd2hlbiBzcGF3bmluZyB0bXV4IHRlYW1tYXRlcylcbiAgLy8gVGhlc2UgcmVwbGFjZSB0aGUgQ0xBVURFX0NPREVfKiBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbignLS1hZ2VudC1pZCA8aWQ+JywgJ1RlYW1tYXRlIGFnZW50IElEJykuaGlkZUhlbHAoKSxcbiAgKVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKCctLWFnZW50LW5hbWUgPG5hbWU+JywgJ1RlYW1tYXRlIGRpc3BsYXkgbmFtZScpLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbihcbiAgICAgICctLXRlYW0tbmFtZSA8bmFtZT4nLFxuICAgICAgJ1RlYW0gbmFtZSBmb3Igc3dhcm0gY29vcmRpbmF0aW9uJyxcbiAgICApLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbignLS1hZ2VudC1jb2xvciA8Y29sb3I+JywgJ1RlYW1tYXRlIFVJIGNvbG9yJykuaGlkZUhlbHAoKSxcbiAgKVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tcGxhbi1tb2RlLXJlcXVpcmVkJyxcbiAgICAgICdSZXF1aXJlIHBsYW4gbW9kZSBiZWZvcmUgaW1wbGVtZW50YXRpb24nLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tcGFyZW50LXNlc3Npb24taWQgPGlkPicsXG4gICAgICAnUGFyZW50IHNlc3Npb24gSUQgZm9yIGFuYWx5dGljcyBjb3JyZWxhdGlvbicsXG4gICAgKS5oaWRlSGVscCgpLFxuICApXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oXG4gICAgICAnLS10ZWFtbWF0ZS1tb2RlIDxtb2RlPicsXG4gICAgICAnSG93IHRvIHNwYXduIHRlYW1tYXRlczogXCJ0bXV4XCIsIFwiaW4tcHJvY2Vzc1wiLCBvciBcImF1dG9cIicsXG4gICAgKVxuICAgICAgLmNob2ljZXMoWydhdXRvJywgJ3RtdXgnLCAnaW4tcHJvY2VzcyddKVxuICAgICAgLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbihcbiAgICAgICctLWFnZW50LXR5cGUgPHR5cGU+JyxcbiAgICAgICdDdXN0b20gYWdlbnQgdHlwZSBmb3IgdGhpcyB0ZWFtbWF0ZScsXG4gICAgKS5oaWRlSGVscCgpLFxuICApXG5cbiAgLy8gRW5hYmxlIFNESyBVUkwgZm9yIGFsbCBidWlsZHMgYnV0IGhpZGUgZnJvbSBoZWxwXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oXG4gICAgICAnLS1zZGstdXJsIDx1cmw+JyxcbiAgICAgICdVc2UgcmVtb3RlIFdlYlNvY2tldCBlbmRwb2ludCBmb3IgU0RLIEkvTyBzdHJlYW1pbmcgKG9ubHkgd2l0aCAtcCBhbmQgc3RyZWFtLWpzb24gZm9ybWF0KScsXG4gICAgKS5oaWRlSGVscCgpLFxuICApXG5cbiAgLy8gRW5hYmxlIHRlbGVwb3J0L3JlbW90ZSBmbGFncyBmb3IgYWxsIGJ1aWxkcyBidXQga2VlcCB0aGVtIHVuZG9jdW1lbnRlZCB1bnRpbCBHQVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tdGVsZXBvcnQgW3Nlc3Npb25dJyxcbiAgICAgICdSZXN1bWUgYSB0ZWxlcG9ydCBzZXNzaW9uLCBvcHRpb25hbGx5IHNwZWNpZnkgc2Vzc2lvbiBJRCcsXG4gICAgKS5oaWRlSGVscCgpLFxuICApXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oXG4gICAgICAnLS1yZW1vdGUgW2Rlc2NyaXB0aW9uXScsXG4gICAgICAnQ3JlYXRlIGEgcmVtb3RlIHNlc3Npb24gd2l0aCB0aGUgZ2l2ZW4gZGVzY3JpcHRpb24nLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuICBpZiAoZmVhdHVyZSgnQlJJREdFX01PREUnKSkge1xuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tcmVtb3RlLWNvbnRyb2wgW25hbWVdJyxcbiAgICAgICAgJ1N0YXJ0IGFuIGludGVyYWN0aXZlIHNlc3Npb24gd2l0aCBSZW1vdGUgQ29udHJvbCBlbmFibGVkIChvcHRpb25hbGx5IG5hbWVkKScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIodmFsdWUgPT4gdmFsdWUgfHwgdHJ1ZSlcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbignLS1yYyBbbmFtZV0nLCAnQWxpYXMgZm9yIC0tcmVtb3RlLWNvbnRyb2wnKVxuICAgICAgICAuYXJnUGFyc2VyKHZhbHVlID0+IHZhbHVlIHx8IHRydWUpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgfVxuXG4gIGlmIChmZWF0dXJlKCdIQVJEX0ZBSUwnKSkge1xuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0taGFyZC1mYWlsJyxcbiAgICAgICAgJ0NyYXNoIG9uIGxvZ0Vycm9yIGNhbGxzIGluc3RlYWQgb2Ygc2lsZW50bHkgbG9nZ2luZycsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICB9XG5cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9tYWluX29wdGlvbnNfYnVpbHQnKVxuXG4gIC8vIC1wLy0tcHJpbnQgbW9kZTogc2tpcCBzdWJjb21tYW5kIHJlZ2lzdHJhdGlvbi4gVGhlIDUyIHN1YmNvbW1hbmRzXG4gIC8vIChtY3AsIGF1dGgsIHBsdWdpbiwgc2tpbGwsIHRhc2ssIGNvbmZpZywgZG9jdG9yLCB1cGRhdGUsIGV0Yy4pIGFyZVxuICAvLyBuZXZlciBkaXNwYXRjaGVkIGluIHByaW50IG1vZGUg4oCUIGNvbW1hbmRlciByb3V0ZXMgdGhlIHByb21wdCB0byB0aGVcbiAgLy8gZGVmYXVsdCBhY3Rpb24uIFRoZSBzdWJjb21tYW5kIHJlZ2lzdHJhdGlvbiBwYXRoIHdhcyBtZWFzdXJlZCBhdCB+NjVtc1xuICAvLyBvbiBiYXNlbGluZSDigJQgbW9zdGx5IHRoZSBpc0JyaWRnZUVuYWJsZWQoKSBjYWxsICgyNW1zIHNldHRpbmdzIFpvZCBwYXJzZVxuICAvLyArIDQwbXMgc3luYyBrZXljaGFpbiBzdWJwcm9jZXNzKSwgYm90aCBoaWRkZW4gYnkgdGhlIHRyeS9jYXRjaCB0aGF0XG4gIC8vIGFsd2F5cyByZXR1cm5zIGZhbHNlIGJlZm9yZSBlbmFibGVDb25maWdzKCkuIGNjOi8vIFVSTHMgYXJlIHJld3JpdHRlbiB0b1xuICAvLyBgb3BlbmAgYXQgbWFpbigpIGxpbmUgfjg1MSBCRUZPUkUgdGhpcyBydW5zLCBzbyBhcmd2IGNoZWNrIGlzIHNhZmUgaGVyZS5cbiAgY29uc3QgaXNQcmludE1vZGUgPVxuICAgIHByb2Nlc3MuYXJndi5pbmNsdWRlcygnLXAnKSB8fCBwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoJy0tcHJpbnQnKVxuICBjb25zdCBpc0NjVXJsID0gcHJvY2Vzcy5hcmd2LnNvbWUoXG4gICAgYSA9PiBhLnN0YXJ0c1dpdGgoJ2NjOi8vJykgfHwgYS5zdGFydHNXaXRoKCdjYyt1bml4Oi8vJyksXG4gIClcbiAgaWYgKGlzUHJpbnRNb2RlICYmICFpc0NjVXJsKSB7XG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9iZWZvcmVfcGFyc2UnKVxuICAgIGF3YWl0IHByb2dyYW0ucGFyc2VBc3luYyhwcm9jZXNzLmFyZ3YpXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9hZnRlcl9wYXJzZScpXG4gICAgcmV0dXJuIHByb2dyYW1cbiAgfVxuXG4gIC8vIGNsYXVkZSBtY3BcblxuICBjb25zdCBtY3AgPSBwcm9ncmFtXG4gICAgLmNvbW1hbmQoJ21jcCcpXG4gICAgLmRlc2NyaXB0aW9uKCdDb25maWd1cmUgYW5kIG1hbmFnZSBNQ1Agc2VydmVycycpXG4gICAgLmNvbmZpZ3VyZUhlbHAoY3JlYXRlU29ydGVkSGVscENvbmZpZygpKVxuICAgIC5lbmFibGVQb3NpdGlvbmFsT3B0aW9ucygpXG5cbiAgbWNwXG4gICAgLmNvbW1hbmQoJ3NlcnZlJylcbiAgICAuZGVzY3JpcHRpb24oYFN0YXJ0IHRoZSBDbGF1ZGUgQ29kZSBNQ1Agc2VydmVyYClcbiAgICAub3B0aW9uKCctZCwgLS1kZWJ1ZycsICdFbmFibGUgZGVidWcgbW9kZScsICgpID0+IHRydWUpXG4gICAgLm9wdGlvbihcbiAgICAgICctLXZlcmJvc2UnLFxuICAgICAgJ092ZXJyaWRlIHZlcmJvc2UgbW9kZSBzZXR0aW5nIGZyb20gY29uZmlnJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAoeyBkZWJ1ZywgdmVyYm9zZSB9OiB7IGRlYnVnPzogYm9vbGVhbjsgdmVyYm9zZT86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgICBjb25zdCB7IG1jcFNlcnZlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9tY3AuanMnKVxuICAgICAgICBhd2FpdCBtY3BTZXJ2ZUhhbmRsZXIoeyBkZWJ1ZywgdmVyYm9zZSB9KVxuICAgICAgfSxcbiAgICApXG5cbiAgLy8gUmVnaXN0ZXIgdGhlIG1jcCBhZGQgc3ViY29tbWFuZCAoZXh0cmFjdGVkIGZvciB0ZXN0YWJpbGl0eSlcbiAgcmVnaXN0ZXJNY3BBZGRDb21tYW5kKG1jcClcblxuICBpZiAoaXNYYWFFbmFibGVkKCkpIHtcbiAgICByZWdpc3Rlck1jcFhhYUlkcENvbW1hbmQobWNwKVxuICB9XG5cbiAgbWNwXG4gICAgLmNvbW1hbmQoJ3JlbW92ZSA8bmFtZT4nKVxuICAgIC5kZXNjcmlwdGlvbignUmVtb3ZlIGFuIE1DUCBzZXJ2ZXInKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICAnQ29uZmlndXJhdGlvbiBzY29wZSAobG9jYWwsIHVzZXIsIG9yIHByb2plY3QpIC0gaWYgbm90IHNwZWNpZmllZCwgcmVtb3ZlcyBmcm9tIHdoaWNoZXZlciBzY29wZSBpdCBleGlzdHMgaW4nLFxuICAgIClcbiAgICAuYWN0aW9uKGFzeW5jIChuYW1lOiBzdHJpbmcsIG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgY29uc3QgeyBtY3BSZW1vdmVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL21jcC5qcycpXG4gICAgICBhd2FpdCBtY3BSZW1vdmVIYW5kbGVyKG5hbWUsIG9wdGlvbnMpXG4gICAgfSlcblxuICBtY3BcbiAgICAuY29tbWFuZCgnbGlzdCcpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0xpc3QgY29uZmlndXJlZCBNQ1Agc2VydmVycy4gTm90ZTogVGhlIHdvcmtzcGFjZSB0cnVzdCBkaWFsb2cgaXMgc2tpcHBlZCBhbmQgc3RkaW8gc2VydmVycyBmcm9tIC5tY3AuanNvbiBhcmUgc3Bhd25lZCBmb3IgaGVhbHRoIGNoZWNrcy4gT25seSB1c2UgdGhpcyBjb21tYW5kIGluIGRpcmVjdG9yaWVzIHlvdSB0cnVzdC4nLFxuICAgIClcbiAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgbWNwTGlzdEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgIGF3YWl0IG1jcExpc3RIYW5kbGVyKClcbiAgICB9KVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdnZXQgPG5hbWU+JylcbiAgICAuZGVzY3JpcHRpb24oXG4gICAgICAnR2V0IGRldGFpbHMgYWJvdXQgYW4gTUNQIHNlcnZlci4gTm90ZTogVGhlIHdvcmtzcGFjZSB0cnVzdCBkaWFsb2cgaXMgc2tpcHBlZCBhbmQgc3RkaW8gc2VydmVycyBmcm9tIC5tY3AuanNvbiBhcmUgc3Bhd25lZCBmb3IgaGVhbHRoIGNoZWNrcy4gT25seSB1c2UgdGhpcyBjb21tYW5kIGluIGRpcmVjdG9yaWVzIHlvdSB0cnVzdC4nLFxuICAgIClcbiAgICAuYWN0aW9uKGFzeW5jIChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHsgbWNwR2V0SGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9tY3AuanMnKVxuICAgICAgYXdhaXQgbWNwR2V0SGFuZGxlcihuYW1lKVxuICAgIH0pXG5cbiAgbWNwXG4gICAgLmNvbW1hbmQoJ2FkZC1qc29uIDxuYW1lPiA8anNvbj4nKVxuICAgIC5kZXNjcmlwdGlvbignQWRkIGFuIE1DUCBzZXJ2ZXIgKHN0ZGlvIG9yIFNTRSkgd2l0aCBhIEpTT04gc3RyaW5nJylcbiAgICAub3B0aW9uKFxuICAgICAgJy1zLCAtLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ0NvbmZpZ3VyYXRpb24gc2NvcGUgKGxvY2FsLCB1c2VyLCBvciBwcm9qZWN0KScsXG4gICAgICAnbG9jYWwnLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tY2xpZW50LXNlY3JldCcsXG4gICAgICAnUHJvbXB0IGZvciBPQXV0aCBjbGllbnQgc2VjcmV0IChvciBzZXQgTUNQX0NMSUVOVF9TRUNSRVQgZW52IHZhciknLFxuICAgIClcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBuYW1lOiBzdHJpbmcsXG4gICAgICAgIGpzb246IHN0cmluZyxcbiAgICAgICAgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY2xpZW50U2VjcmV0PzogdHJ1ZSB9LFxuICAgICAgKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgbWNwQWRkSnNvbkhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgICAgYXdhaXQgbWNwQWRkSnNvbkhhbmRsZXIobmFtZSwganNvbiwgb3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdhZGQtZnJvbS1jbGF1ZGUtZGVza3RvcCcpXG4gICAgLmRlc2NyaXB0aW9uKCdJbXBvcnQgTUNQIHNlcnZlcnMgZnJvbSBDbGF1ZGUgRGVza3RvcCAoTWFjIGFuZCBXU0wgb25seSknKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICAnQ29uZmlndXJhdGlvbiBzY29wZSAobG9jYWwsIHVzZXIsIG9yIHByb2plY3QpJyxcbiAgICAgICdsb2NhbCcsXG4gICAgKVxuICAgIC5hY3Rpb24oYXN5bmMgKG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgY29uc3QgeyBtY3BBZGRGcm9tRGVza3RvcEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgIGF3YWl0IG1jcEFkZEZyb21EZXNrdG9wSGFuZGxlcihvcHRpb25zKVxuICAgIH0pXG5cbiAgbWNwXG4gICAgLmNvbW1hbmQoJ3Jlc2V0LXByb2plY3QtY2hvaWNlcycpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ1Jlc2V0IGFsbCBhcHByb3ZlZCBhbmQgcmVqZWN0ZWQgcHJvamVjdC1zY29wZWQgKC5tY3AuanNvbikgc2VydmVycyB3aXRoaW4gdGhpcyBwcm9qZWN0JyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG1jcFJlc2V0Q2hvaWNlc0hhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgIGF3YWl0IG1jcFJlc2V0Q2hvaWNlc0hhbmRsZXIoKVxuICAgIH0pXG5cbiAgLy8gY2xhdWRlIHNlcnZlclxuICBpZiAoZmVhdHVyZSgnRElSRUNUX0NPTk5FQ1QnKSkge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdzZXJ2ZXInKVxuICAgICAgLmRlc2NyaXB0aW9uKCdTdGFydCBhIENsYXVkZSBDb2RlIHNlc3Npb24gc2VydmVyJylcbiAgICAgIC5vcHRpb24oJy0tcG9ydCA8bnVtYmVyPicsICdIVFRQIHBvcnQnLCAnMCcpXG4gICAgICAub3B0aW9uKCctLWhvc3QgPHN0cmluZz4nLCAnQmluZCBhZGRyZXNzJywgJzAuMC4wLjAnKVxuICAgICAgLm9wdGlvbignLS1hdXRoLXRva2VuIDx0b2tlbj4nLCAnQmVhcmVyIHRva2VuIGZvciBhdXRoJylcbiAgICAgIC5vcHRpb24oJy0tdW5peCA8cGF0aD4nLCAnTGlzdGVuIG9uIGEgdW5peCBkb21haW4gc29ja2V0JylcbiAgICAgIC5vcHRpb24oXG4gICAgICAgICctLXdvcmtzcGFjZSA8ZGlyPicsXG4gICAgICAgICdEZWZhdWx0IHdvcmtpbmcgZGlyZWN0b3J5IGZvciBzZXNzaW9ucyB0aGF0IGRvIG5vdCBzcGVjaWZ5IGN3ZCcsXG4gICAgICApXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS1pZGxlLXRpbWVvdXQgPG1zPicsXG4gICAgICAgICdJZGxlIHRpbWVvdXQgZm9yIGRldGFjaGVkIHNlc3Npb25zIGluIG1zICgwID0gbmV2ZXIgZXhwaXJlKScsXG4gICAgICAgICc2MDAwMDAnLFxuICAgICAgKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tbWF4LXNlc3Npb25zIDxuPicsXG4gICAgICAgICdNYXhpbXVtIGNvbmN1cnJlbnQgc2Vzc2lvbnMgKDAgPSB1bmxpbWl0ZWQpJyxcbiAgICAgICAgJzMyJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oXG4gICAgICAgIGFzeW5jIChvcHRzOiB7XG4gICAgICAgICAgcG9ydDogc3RyaW5nXG4gICAgICAgICAgaG9zdDogc3RyaW5nXG4gICAgICAgICAgYXV0aFRva2VuPzogc3RyaW5nXG4gICAgICAgICAgdW5peD86IHN0cmluZ1xuICAgICAgICAgIHdvcmtzcGFjZT86IHN0cmluZ1xuICAgICAgICAgIGlkbGVUaW1lb3V0OiBzdHJpbmdcbiAgICAgICAgICBtYXhTZXNzaW9uczogc3RyaW5nXG4gICAgICAgIH0pID0+IHtcbiAgICAgICAgICBjb25zdCB7IHJhbmRvbUJ5dGVzIH0gPSBhd2FpdCBpbXBvcnQoJ2NyeXB0bycpXG4gICAgICAgICAgY29uc3QgeyBzdGFydFNlcnZlciB9ID0gYXdhaXQgaW1wb3J0KCcuL3NlcnZlci9zZXJ2ZXIuanMnKVxuICAgICAgICAgIGNvbnN0IHsgU2Vzc2lvbk1hbmFnZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9zZXJ2ZXIvc2Vzc2lvbk1hbmFnZXIuanMnKVxuICAgICAgICAgIGNvbnN0IHsgRGFuZ2Vyb3VzQmFja2VuZCB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICAgJy4vc2VydmVyL2JhY2tlbmRzL2Rhbmdlcm91c0JhY2tlbmQuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGNvbnN0IHsgcHJpbnRCYW5uZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9zZXJ2ZXIvc2VydmVyQmFubmVyLmpzJylcbiAgICAgICAgICBjb25zdCB7IGNyZWF0ZVNlcnZlckxvZ2dlciB9ID0gYXdhaXQgaW1wb3J0KCcuL3NlcnZlci9zZXJ2ZXJMb2cuanMnKVxuICAgICAgICAgIGNvbnN0IHsgd3JpdGVTZXJ2ZXJMb2NrLCByZW1vdmVTZXJ2ZXJMb2NrLCBwcm9iZVJ1bm5pbmdTZXJ2ZXIgfSA9XG4gICAgICAgICAgICBhd2FpdCBpbXBvcnQoJy4vc2VydmVyL2xvY2tmaWxlLmpzJylcblxuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcHJvYmVSdW5uaW5nU2VydmVyKClcbiAgICAgICAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBgQSBjbGF1ZGUgc2VydmVyIGlzIGFscmVhZHkgcnVubmluZyAocGlkICR7ZXhpc3RpbmcucGlkfSkgYXQgJHtleGlzdGluZy5odHRwVXJsfVxcbmAsXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBhdXRoVG9rZW4gPVxuICAgICAgICAgICAgb3B0cy5hdXRoVG9rZW4gPz9cbiAgICAgICAgICAgIGBzay1hbnQtY2MtJHtyYW5kb21CeXRlcygxNikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpfWBcblxuICAgICAgICAgIGNvbnN0IGNvbmZpZyA9IHtcbiAgICAgICAgICAgIHBvcnQ6IHBhcnNlSW50KG9wdHMucG9ydCwgMTApLFxuICAgICAgICAgICAgaG9zdDogb3B0cy5ob3N0LFxuICAgICAgICAgICAgYXV0aFRva2VuLFxuICAgICAgICAgICAgdW5peDogb3B0cy51bml4LFxuICAgICAgICAgICAgd29ya3NwYWNlOiBvcHRzLndvcmtzcGFjZSxcbiAgICAgICAgICAgIGlkbGVUaW1lb3V0TXM6IHBhcnNlSW50KG9wdHMuaWRsZVRpbWVvdXQsIDEwKSxcbiAgICAgICAgICAgIG1heFNlc3Npb25zOiBwYXJzZUludChvcHRzLm1heFNlc3Npb25zLCAxMCksXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgYmFja2VuZCA9IG5ldyBEYW5nZXJvdXNCYWNrZW5kKClcbiAgICAgICAgICBjb25zdCBzZXNzaW9uTWFuYWdlciA9IG5ldyBTZXNzaW9uTWFuYWdlcihiYWNrZW5kLCB7XG4gICAgICAgICAgICBpZGxlVGltZW91dE1zOiBjb25maWcuaWRsZVRpbWVvdXRNcyxcbiAgICAgICAgICAgIG1heFNlc3Npb25zOiBjb25maWcubWF4U2Vzc2lvbnMsXG4gICAgICAgICAgfSlcbiAgICAgICAgICBjb25zdCBsb2dnZXIgPSBjcmVhdGVTZXJ2ZXJMb2dnZXIoKVxuXG4gICAgICAgICAgY29uc3Qgc2VydmVyID0gc3RhcnRTZXJ2ZXIoY29uZmlnLCBzZXNzaW9uTWFuYWdlciwgbG9nZ2VyKVxuICAgICAgICAgIGNvbnN0IGFjdHVhbFBvcnQgPSBzZXJ2ZXIucG9ydCA/PyBjb25maWcucG9ydFxuICAgICAgICAgIHByaW50QmFubmVyKGNvbmZpZywgYXV0aFRva2VuLCBhY3R1YWxQb3J0KVxuXG4gICAgICAgICAgYXdhaXQgd3JpdGVTZXJ2ZXJMb2NrKHtcbiAgICAgICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgICAgICBwb3J0OiBhY3R1YWxQb3J0LFxuICAgICAgICAgICAgaG9zdDogY29uZmlnLmhvc3QsXG4gICAgICAgICAgICBodHRwVXJsOiBjb25maWcudW5peFxuICAgICAgICAgICAgICA/IGB1bml4OiR7Y29uZmlnLnVuaXh9YFxuICAgICAgICAgICAgICA6IGBodHRwOi8vJHtjb25maWcuaG9zdH06JHthY3R1YWxQb3J0fWAsXG4gICAgICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgfSlcblxuICAgICAgICAgIGxldCBzaHV0dGluZ0Rvd24gPSBmYWxzZVxuICAgICAgICAgIGNvbnN0IHNodXRkb3duID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKHNodXR0aW5nRG93bikgcmV0dXJuXG4gICAgICAgICAgICBzaHV0dGluZ0Rvd24gPSB0cnVlXG4gICAgICAgICAgICAvLyBTdG9wIGFjY2VwdGluZyBuZXcgY29ubmVjdGlvbnMgYmVmb3JlIHRlYXJpbmcgZG93biBzZXNzaW9ucy5cbiAgICAgICAgICAgIHNlcnZlci5zdG9wKHRydWUpXG4gICAgICAgICAgICBhd2FpdCBzZXNzaW9uTWFuYWdlci5kZXN0cm95QWxsKClcbiAgICAgICAgICAgIGF3YWl0IHJlbW92ZVNlcnZlckxvY2soKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Mub25jZSgnU0lHSU5UJywgKCkgPT4gdm9pZCBzaHV0ZG93bigpKVxuICAgICAgICAgIHByb2Nlc3Mub25jZSgnU0lHVEVSTScsICgpID0+IHZvaWQgc2h1dGRvd24oKSlcbiAgICAgICAgfSxcbiAgICAgIClcbiAgfVxuXG4gIC8vIGBjbGF1ZGUgc3NoIDxob3N0PiBbZGlyXWAg4oCUIHJlZ2lzdGVyZWQgaGVyZSBvbmx5IHNvIC0taGVscCBzaG93cyBpdC5cbiAgLy8gVGhlIGFjdHVhbCBpbnRlcmFjdGl2ZSBmbG93IGlzIGhhbmRsZWQgYnkgZWFybHkgYXJndiByZXdyaXRpbmcgaW4gbWFpbigpXG4gIC8vIChwYXJhbGxlbHMgdGhlIERJUkVDVF9DT05ORUNUL2NjOi8vIHBhdHRlcm4gYWJvdmUpLiBJZiBjb21tYW5kZXIgcmVhY2hlc1xuICAvLyB0aGlzIGFjdGlvbiBpdCBtZWFucyB0aGUgYXJndiByZXdyaXRlIGRpZG4ndCBmaXJlIChlLmcuIHVzZXIgcmFuXG4gIC8vIGBjbGF1ZGUgc3NoYCB3aXRoIG5vIGhvc3QpIOKAlCBqdXN0IHByaW50IHVzYWdlLlxuICBpZiAoZmVhdHVyZSgnU1NIX1JFTU9URScpKSB7XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ3NzaCA8aG9zdD4gW2Rpcl0nKVxuICAgICAgLmRlc2NyaXB0aW9uKFxuICAgICAgICAnUnVuIENsYXVkZSBDb2RlIG9uIGEgcmVtb3RlIGhvc3Qgb3ZlciBTU0guIERlcGxveXMgdGhlIGJpbmFyeSBhbmQgJyArXG4gICAgICAgICAgJ3R1bm5lbHMgQVBJIGF1dGggYmFjayB0aHJvdWdoIHlvdXIgbG9jYWwgbWFjaGluZSDigJQgbm8gcmVtb3RlIHNldHVwIG5lZWRlZC4nLFxuICAgICAgKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tcGVybWlzc2lvbi1tb2RlIDxtb2RlPicsXG4gICAgICAgICdQZXJtaXNzaW9uIG1vZGUgZm9yIHRoZSByZW1vdGUgc2Vzc2lvbicsXG4gICAgICApXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zJyxcbiAgICAgICAgJ1NraXAgYWxsIHBlcm1pc3Npb24gcHJvbXB0cyBvbiB0aGUgcmVtb3RlIChkYW5nZXJvdXMpJyxcbiAgICAgIClcbiAgICAgIC5vcHRpb24oXG4gICAgICAgICctLWxvY2FsJyxcbiAgICAgICAgJ2UyZSB0ZXN0IG1vZGUg4oCUIHNwYXduIHRoZSBjaGlsZCBDTEkgbG9jYWxseSAoc2tpcCBzc2gvZGVwbG95KS4gJyArXG4gICAgICAgICAgJ0V4ZXJjaXNlcyB0aGUgYXV0aCBwcm94eSBhbmQgdW5peC1zb2NrZXQgcGx1bWJpbmcgd2l0aG91dCBhIHJlbW90ZSBob3N0LicsXG4gICAgICApXG4gICAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgICAgLy8gQXJndiByZXdyaXRpbmcgaW4gbWFpbigpIHNob3VsZCBoYXZlIGNvbnN1bWVkIGBzc2ggPGhvc3Q+YCBiZWZvcmVcbiAgICAgICAgLy8gY29tbWFuZGVyIHJ1bnMuIFJlYWNoaW5nIGhlcmUgbWVhbnMgaG9zdCB3YXMgbWlzc2luZyBvciB0aGVcbiAgICAgICAgLy8gcmV3cml0ZSBwcmVkaWNhdGUgZGlkbid0IG1hdGNoLlxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAnVXNhZ2U6IGNsYXVkZSBzc2ggPHVzZXJAaG9zdCB8IHNzaC1jb25maWctYWxpYXM+IFtkaXJdXFxuXFxuJyArXG4gICAgICAgICAgICBcIlJ1bnMgQ2xhdWRlIENvZGUgb24gYSByZW1vdGUgTGludXggaG9zdC4gWW91IGRvbid0IG5lZWQgdG8gaW5zdGFsbFxcblwiICtcbiAgICAgICAgICAgICdhbnl0aGluZyBvbiB0aGUgcmVtb3RlIG9yIHJ1biBgY2xhdWRlIGF1dGggbG9naW5gIHRoZXJlIOKAlCB0aGUgYmluYXJ5IGlzXFxuJyArXG4gICAgICAgICAgICAnZGVwbG95ZWQgb3ZlciBTU0ggYW5kIEFQSSBhdXRoIHR1bm5lbHMgYmFjayB0aHJvdWdoIHlvdXIgbG9jYWwgbWFjaGluZS5cXG4nLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfSlcbiAgfVxuXG4gIC8vIGNsYXVkZSBjb25uZWN0IOKAlCBzdWJjb21tYW5kIG9ubHkgaGFuZGxlcyAtcCAoaGVhZGxlc3MpIG1vZGUuXG4gIC8vIEludGVyYWN0aXZlIG1vZGUgKHdpdGhvdXQgLXApIGlzIGhhbmRsZWQgYnkgZWFybHkgYXJndiByZXdyaXRpbmcgaW4gbWFpbigpXG4gIC8vIHdoaWNoIHJlZGlyZWN0cyB0byB0aGUgbWFpbiBjb21tYW5kIHdpdGggZnVsbCBUVUkgc3VwcG9ydC5cbiAgaWYgKGZlYXR1cmUoJ0RJUkVDVF9DT05ORUNUJykpIHtcbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnb3BlbiA8Y2MtdXJsPicpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdDb25uZWN0IHRvIGEgQ2xhdWRlIENvZGUgc2VydmVyIChpbnRlcm5hbCDigJQgdXNlIGNjOi8vIFVSTHMpJyxcbiAgICAgIClcbiAgICAgIC5vcHRpb24oJy1wLCAtLXByaW50IFtwcm9tcHRdJywgJ1ByaW50IG1vZGUgKGhlYWRsZXNzKScpXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS1vdXRwdXQtZm9ybWF0IDxmb3JtYXQ+JyxcbiAgICAgICAgJ091dHB1dCBmb3JtYXQ6IHRleHQsIGpzb24sIHN0cmVhbS1qc29uJyxcbiAgICAgICAgJ3RleHQnLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihcbiAgICAgICAgYXN5bmMgKFxuICAgICAgICAgIGNjVXJsOiBzdHJpbmcsXG4gICAgICAgICAgb3B0czoge1xuICAgICAgICAgICAgcHJpbnQ/OiBzdHJpbmcgfCBib29sZWFuXG4gICAgICAgICAgICBvdXRwdXRGb3JtYXQ6IHN0cmluZ1xuICAgICAgICAgIH0sXG4gICAgICAgICkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgcGFyc2VDb25uZWN0VXJsIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9zZXJ2ZXIvcGFyc2VDb25uZWN0VXJsLmpzJ1xuICAgICAgICAgIClcbiAgICAgICAgICBjb25zdCB7IHNlcnZlclVybCwgYXV0aFRva2VuIH0gPSBwYXJzZUNvbm5lY3RVcmwoY2NVcmwpXG5cbiAgICAgICAgICBsZXQgY29ubmVjdENvbmZpZ1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gYXdhaXQgY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24oe1xuICAgICAgICAgICAgICBzZXJ2ZXJVcmwsXG4gICAgICAgICAgICAgIGF1dGhUb2tlbixcbiAgICAgICAgICAgICAgY3dkOiBnZXRPcmlnaW5hbEN3ZCgpLFxuICAgICAgICAgICAgICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczpcbiAgICAgICAgICAgICAgICBfcGVuZGluZ0Nvbm5lY3Q/LmRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIGlmIChzZXNzaW9uLndvcmtEaXIpIHtcbiAgICAgICAgICAgICAgc2V0T3JpZ2luYWxDd2Qoc2Vzc2lvbi53b3JrRGlyKVxuICAgICAgICAgICAgICBzZXRDd2RTdGF0ZShzZXNzaW9uLndvcmtEaXIpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXREaXJlY3RDb25uZWN0U2VydmVyVXJsKHNlcnZlclVybClcbiAgICAgICAgICAgIGNvbm5lY3RDb25maWcgPSBzZXNzaW9uLmNvbmZpZ1xuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3VzcGljaW91cy9ub0NvbnNvbGU6IGludGVudGlvbmFsIGVycm9yIG91dHB1dFxuICAgICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRGlyZWN0Q29ubmVjdEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHsgcnVuQ29ubmVjdEhlYWRsZXNzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9zZXJ2ZXIvY29ubmVjdEhlYWRsZXNzLmpzJ1xuICAgICAgICAgIClcblxuICAgICAgICAgIGNvbnN0IHByb21wdCA9IHR5cGVvZiBvcHRzLnByaW50ID09PSAnc3RyaW5nJyA/IG9wdHMucHJpbnQgOiAnJ1xuICAgICAgICAgIGNvbnN0IGludGVyYWN0aXZlID0gb3B0cy5wcmludCA9PT0gdHJ1ZVxuICAgICAgICAgIGF3YWl0IHJ1bkNvbm5lY3RIZWFkbGVzcyhcbiAgICAgICAgICAgIGNvbm5lY3RDb25maWcsXG4gICAgICAgICAgICBwcm9tcHQsXG4gICAgICAgICAgICBvcHRzLm91dHB1dEZvcm1hdCxcbiAgICAgICAgICAgIGludGVyYWN0aXZlLFxuICAgICAgICAgIClcbiAgICAgICAgfSxcbiAgICAgIClcbiAgfVxuXG4gIC8vIGNsYXVkZSBhdXRoXG5cbiAgY29uc3QgYXV0aCA9IHByb2dyYW1cbiAgICAuY29tbWFuZCgnYXV0aCcpXG4gICAgLmRlc2NyaXB0aW9uKCdNYW5hZ2UgYXV0aGVudGljYXRpb24nKVxuICAgIC5jb25maWd1cmVIZWxwKGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKSlcblxuICBhdXRoXG4gICAgLmNvbW1hbmQoJ2xvZ2luJylcbiAgICAuZGVzY3JpcHRpb24oJ1NpZ24gaW4gdG8geW91ciBBbnRocm9waWMgYWNjb3VudCcpXG4gICAgLm9wdGlvbignLS1lbWFpbCA8ZW1haWw+JywgJ1ByZS1wb3B1bGF0ZSBlbWFpbCBhZGRyZXNzIG9uIHRoZSBsb2dpbiBwYWdlJylcbiAgICAub3B0aW9uKCctLXNzbycsICdGb3JjZSBTU08gbG9naW4gZmxvdycpXG4gICAgLm9wdGlvbihcbiAgICAgICctLWNvbnNvbGUnLFxuICAgICAgJ1VzZSBBbnRocm9waWMgQ29uc29sZSAoQVBJIHVzYWdlIGJpbGxpbmcpIGluc3RlYWQgb2YgQ2xhdWRlIHN1YnNjcmlwdGlvbicsXG4gICAgKVxuICAgIC5vcHRpb24oJy0tY2xhdWRlYWknLCAnVXNlIENsYXVkZSBzdWJzY3JpcHRpb24gKGRlZmF1bHQpJylcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKHtcbiAgICAgICAgZW1haWwsXG4gICAgICAgIHNzbyxcbiAgICAgICAgY29uc29sZTogdXNlQ29uc29sZSxcbiAgICAgICAgY2xhdWRlYWksXG4gICAgICB9OiB7XG4gICAgICAgIGVtYWlsPzogc3RyaW5nXG4gICAgICAgIHNzbz86IGJvb2xlYW5cbiAgICAgICAgY29uc29sZT86IGJvb2xlYW5cbiAgICAgICAgY2xhdWRlYWk/OiBib29sZWFuXG4gICAgICB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgYXV0aExvZ2luIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2F1dGguanMnKVxuICAgICAgICBhd2FpdCBhdXRoTG9naW4oeyBlbWFpbCwgc3NvLCBjb25zb2xlOiB1c2VDb25zb2xlLCBjbGF1ZGVhaSB9KVxuICAgICAgfSxcbiAgICApXG5cbiAgYXV0aFxuICAgIC5jb21tYW5kKCdzdGF0dXMnKVxuICAgIC5kZXNjcmlwdGlvbignU2hvdyBhdXRoZW50aWNhdGlvbiBzdGF0dXMnKVxuICAgIC5vcHRpb24oJy0tanNvbicsICdPdXRwdXQgYXMgSlNPTiAoZGVmYXVsdCknKVxuICAgIC5vcHRpb24oJy0tdGV4dCcsICdPdXRwdXQgYXMgaHVtYW4tcmVhZGFibGUgdGV4dCcpXG4gICAgLmFjdGlvbihhc3luYyAob3B0czogeyBqc29uPzogYm9vbGVhbjsgdGV4dD86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgY29uc3QgeyBhdXRoU3RhdHVzIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2F1dGguanMnKVxuICAgICAgYXdhaXQgYXV0aFN0YXR1cyhvcHRzKVxuICAgIH0pXG5cbiAgYXV0aFxuICAgIC5jb21tYW5kKCdsb2dvdXQnKVxuICAgIC5kZXNjcmlwdGlvbignTG9nIG91dCBmcm9tIHlvdXIgQW50aHJvcGljIGFjY291bnQnKVxuICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBhdXRoTG9nb3V0IH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2F1dGguanMnKVxuICAgICAgYXdhaXQgYXV0aExvZ291dCgpXG4gICAgfSlcblxuICAvKipcbiAgICogSGVscGVyIGZ1bmN0aW9uIHRvIGhhbmRsZSBtYXJrZXRwbGFjZSBjb21tYW5kIGVycm9ycyBjb25zaXN0ZW50bHkuXG4gICAqIExvZ3MgdGhlIGVycm9yIGFuZCBleGl0cyB0aGUgcHJvY2VzcyB3aXRoIHN0YXR1cyAxLlxuICAgKiBAcGFyYW0gZXJyb3IgVGhlIGVycm9yIHRoYXQgb2NjdXJyZWRcbiAgICogQHBhcmFtIGFjdGlvbiBEZXNjcmlwdGlvbiBvZiB0aGUgYWN0aW9uIHRoYXQgZmFpbGVkXG4gICAqL1xuICAvLyBIaWRkZW4gZmxhZyBvbiBhbGwgcGx1Z2luL21hcmtldHBsYWNlIHN1YmNvbW1hbmRzIHRvIHRhcmdldCBjb3dvcmtfcGx1Z2lucy5cbiAgY29uc3QgY293b3JrT3B0aW9uID0gKCkgPT5cbiAgICBuZXcgT3B0aW9uKCctLWNvd29yaycsICdVc2UgY293b3JrX3BsdWdpbnMgZGlyZWN0b3J5JykuaGlkZUhlbHAoKVxuXG4gIC8vIFBsdWdpbiB2YWxpZGF0ZSBjb21tYW5kXG4gIGNvbnN0IHBsdWdpbkNtZCA9IHByb2dyYW1cbiAgICAuY29tbWFuZCgncGx1Z2luJylcbiAgICAuYWxpYXMoJ3BsdWdpbnMnKVxuICAgIC5kZXNjcmlwdGlvbignTWFuYWdlIENsYXVkZSBDb2RlIHBsdWdpbnMnKVxuICAgIC5jb25maWd1cmVIZWxwKGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKSlcblxuICBwbHVnaW5DbWRcbiAgICAuY29tbWFuZCgndmFsaWRhdGUgPHBhdGg+JylcbiAgICAuZGVzY3JpcHRpb24oJ1ZhbGlkYXRlIGEgcGx1Z2luIG9yIG1hcmtldHBsYWNlIG1hbmlmZXN0JylcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5hY3Rpb24oYXN5bmMgKG1hbmlmZXN0UGF0aDogc3RyaW5nLCBvcHRpb25zOiB7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgY29uc3QgeyBwbHVnaW5WYWxpZGF0ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICApXG4gICAgICBhd2FpdCBwbHVnaW5WYWxpZGF0ZUhhbmRsZXIobWFuaWZlc3RQYXRoLCBvcHRpb25zKVxuICAgIH0pXG5cbiAgLy8gUGx1Z2luIGxpc3QgY29tbWFuZFxuICBwbHVnaW5DbWRcbiAgICAuY29tbWFuZCgnbGlzdCcpXG4gICAgLmRlc2NyaXB0aW9uKCdMaXN0IGluc3RhbGxlZCBwbHVnaW5zJylcbiAgICAub3B0aW9uKCctLWpzb24nLCAnT3V0cHV0IGFzIEpTT04nKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1hdmFpbGFibGUnLFxuICAgICAgJ0luY2x1ZGUgYXZhaWxhYmxlIHBsdWdpbnMgZnJvbSBtYXJrZXRwbGFjZXMgKHJlcXVpcmVzIC0tanNvbiknLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAob3B0aW9uczoge1xuICAgICAgICBqc29uPzogYm9vbGVhblxuICAgICAgICBhdmFpbGFibGU/OiBib29sZWFuXG4gICAgICAgIGNvd29yaz86IGJvb2xlYW5cbiAgICAgIH0pID0+IHtcbiAgICAgICAgY29uc3QgeyBwbHVnaW5MaXN0SGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9wbHVnaW5zLmpzJylcbiAgICAgICAgYXdhaXQgcGx1Z2luTGlzdEhhbmRsZXIob3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuXG4gIC8vIE1hcmtldHBsYWNlIHN1YmNvbW1hbmRzXG4gIGNvbnN0IG1hcmtldHBsYWNlQ21kID0gcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ21hcmtldHBsYWNlJylcbiAgICAuZGVzY3JpcHRpb24oJ01hbmFnZSBDbGF1ZGUgQ29kZSBtYXJrZXRwbGFjZXMnKVxuICAgIC5jb25maWd1cmVIZWxwKGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKSlcblxuICBtYXJrZXRwbGFjZUNtZFxuICAgIC5jb21tYW5kKCdhZGQgPHNvdXJjZT4nKVxuICAgIC5kZXNjcmlwdGlvbignQWRkIGEgbWFya2V0cGxhY2UgZnJvbSBhIFVSTCwgcGF0aCwgb3IgR2l0SHViIHJlcG8nKVxuICAgIC5hZGRPcHRpb24oY293b3JrT3B0aW9uKCkpXG4gICAgLm9wdGlvbihcbiAgICAgICctLXNwYXJzZSA8cGF0aHMuLi4+JyxcbiAgICAgICdMaW1pdCBjaGVja291dCB0byBzcGVjaWZpYyBkaXJlY3RvcmllcyB2aWEgZ2l0IHNwYXJzZS1jaGVja291dCAoZm9yIG1vbm9yZXBvcykuIEV4YW1wbGU6IC0tc3BhcnNlIC5jbGF1ZGUtcGx1Z2luIHBsdWdpbnMnLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tc2NvcGUgPHNjb3BlPicsXG4gICAgICAnV2hlcmUgdG8gZGVjbGFyZSB0aGUgbWFya2V0cGxhY2U6IHVzZXIgKGRlZmF1bHQpLCBwcm9qZWN0LCBvciBsb2NhbCcsXG4gICAgKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAoXG4gICAgICAgIHNvdXJjZTogc3RyaW5nLFxuICAgICAgICBvcHRpb25zOiB7IGNvd29yaz86IGJvb2xlYW47IHNwYXJzZT86IHN0cmluZ1tdOyBzY29wZT86IHN0cmluZyB9LFxuICAgICAgKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgbWFya2V0cGxhY2VBZGRIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgbWFya2V0cGxhY2VBZGRIYW5kbGVyKHNvdXJjZSwgb3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuXG4gIG1hcmtldHBsYWNlQ21kXG4gICAgLmNvbW1hbmQoJ2xpc3QnKVxuICAgIC5kZXNjcmlwdGlvbignTGlzdCBhbGwgY29uZmlndXJlZCBtYXJrZXRwbGFjZXMnKVxuICAgIC5vcHRpb24oJy0tanNvbicsICdPdXRwdXQgYXMgSlNPTicpXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKGFzeW5jIChvcHRpb25zOiB7IGpzb24/OiBib29sZWFuOyBjb3dvcms/OiBib29sZWFuIH0pID0+IHtcbiAgICAgIGNvbnN0IHsgbWFya2V0cGxhY2VMaXN0SGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgIClcbiAgICAgIGF3YWl0IG1hcmtldHBsYWNlTGlzdEhhbmRsZXIob3B0aW9ucylcbiAgICB9KVxuXG4gIG1hcmtldHBsYWNlQ21kXG4gICAgLmNvbW1hbmQoJ3JlbW92ZSA8bmFtZT4nKVxuICAgIC5hbGlhcygncm0nKVxuICAgIC5kZXNjcmlwdGlvbignUmVtb3ZlIGEgY29uZmlndXJlZCBtYXJrZXRwbGFjZScpXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKGFzeW5jIChuYW1lOiBzdHJpbmcsIG9wdGlvbnM6IHsgY293b3JrPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICBjb25zdCB7IG1hcmtldHBsYWNlUmVtb3ZlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgIClcbiAgICAgIGF3YWl0IG1hcmtldHBsYWNlUmVtb3ZlSGFuZGxlcihuYW1lLCBvcHRpb25zKVxuICAgIH0pXG5cbiAgbWFya2V0cGxhY2VDbWRcbiAgICAuY29tbWFuZCgndXBkYXRlIFtuYW1lXScpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ1VwZGF0ZSBtYXJrZXRwbGFjZShzKSBmcm9tIHRoZWlyIHNvdXJjZSAtIHVwZGF0ZXMgYWxsIGlmIG5vIG5hbWUgc3BlY2lmaWVkJyxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKGFzeW5jIChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdGlvbnM6IHsgY293b3JrPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICBjb25zdCB7IG1hcmtldHBsYWNlVXBkYXRlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgIClcbiAgICAgIGF3YWl0IG1hcmtldHBsYWNlVXBkYXRlSGFuZGxlcihuYW1lLCBvcHRpb25zKVxuICAgIH0pXG5cbiAgLy8gUGx1Z2luIGluc3RhbGwgY29tbWFuZFxuICBwbHVnaW5DbWRcbiAgICAuY29tbWFuZCgnaW5zdGFsbCA8cGx1Z2luPicpXG4gICAgLmFsaWFzKCdpJylcbiAgICAuZGVzY3JpcHRpb24oXG4gICAgICAnSW5zdGFsbCBhIHBsdWdpbiBmcm9tIGF2YWlsYWJsZSBtYXJrZXRwbGFjZXMgKHVzZSBwbHVnaW5AbWFya2V0cGxhY2UgZm9yIHNwZWNpZmljIG1hcmtldHBsYWNlKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICAnSW5zdGFsbGF0aW9uIHNjb3BlOiB1c2VyLCBwcm9qZWN0LCBvciBsb2NhbCcsXG4gICAgICAndXNlcicsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oY293b3JrT3B0aW9uKCkpXG4gICAgLmFjdGlvbihcbiAgICAgIGFzeW5jIChwbHVnaW46IHN0cmluZywgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY293b3JrPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgcGx1Z2luSW5zdGFsbEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgICAgKVxuICAgICAgICBhd2FpdCBwbHVnaW5JbnN0YWxsSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gdW5pbnN0YWxsIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ3VuaW5zdGFsbCA8cGx1Z2luPicpXG4gICAgLmFsaWFzKCdyZW1vdmUnKVxuICAgIC5hbGlhcygncm0nKVxuICAgIC5kZXNjcmlwdGlvbignVW5pbnN0YWxsIGFuIGluc3RhbGxlZCBwbHVnaW4nKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICAnVW5pbnN0YWxsIGZyb20gc2NvcGU6IHVzZXIsIHByb2plY3QsIG9yIGxvY2FsJyxcbiAgICAgICd1c2VyJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWtlZXAtZGF0YScsXG4gICAgICBcIlByZXNlcnZlIHRoZSBwbHVnaW4ncyBwZXJzaXN0ZW50IGRhdGEgZGlyZWN0b3J5ICh+Ly5vcGVuY2xhdWRlL3BsdWdpbnMvZGF0YS97aWR9LylcIixcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBwbHVnaW46IHN0cmluZyxcbiAgICAgICAgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY293b3JrPzogYm9vbGVhbjsga2VlcERhdGE/OiBib29sZWFuIH0sXG4gICAgICApID0+IHtcbiAgICAgICAgY29uc3QgeyBwbHVnaW5Vbmluc3RhbGxIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgcGx1Z2luVW5pbnN0YWxsSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gZW5hYmxlIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ2VuYWJsZSA8cGx1Z2luPicpXG4gICAgLmRlc2NyaXB0aW9uKCdFbmFibGUgYSBkaXNhYmxlZCBwbHVnaW4nKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICBgSW5zdGFsbGF0aW9uIHNjb3BlOiAke1ZBTElEX0lOU1RBTExBQkxFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogYXV0by1kZXRlY3QpYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKHBsdWdpbjogc3RyaW5nLCBvcHRpb25zOiB7IHNjb3BlPzogc3RyaW5nOyBjb3dvcms/OiBib29sZWFuIH0pID0+IHtcbiAgICAgICAgY29uc3QgeyBwbHVnaW5FbmFibGVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgcGx1Z2luRW5hYmxlSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gZGlzYWJsZSBjb21tYW5kXG4gIHBsdWdpbkNtZFxuICAgIC5jb21tYW5kKCdkaXNhYmxlIFtwbHVnaW5dJylcbiAgICAuZGVzY3JpcHRpb24oJ0Rpc2FibGUgYW4gZW5hYmxlZCBwbHVnaW4nKVxuICAgIC5vcHRpb24oJy1hLCAtLWFsbCcsICdEaXNhYmxlIGFsbCBlbmFibGVkIHBsdWdpbnMnKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICBgSW5zdGFsbGF0aW9uIHNjb3BlOiAke1ZBTElEX0lOU1RBTExBQkxFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogYXV0by1kZXRlY3QpYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBwbHVnaW46IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY293b3JrPzogYm9vbGVhbjsgYWxsPzogYm9vbGVhbiB9LFxuICAgICAgKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgcGx1Z2luRGlzYWJsZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgICAgKVxuICAgICAgICBhd2FpdCBwbHVnaW5EaXNhYmxlSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gdXBkYXRlIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ3VwZGF0ZSA8cGx1Z2luPicpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ1VwZGF0ZSBhIHBsdWdpbiB0byB0aGUgbGF0ZXN0IHZlcnNpb24gKHJlc3RhcnQgcmVxdWlyZWQgdG8gYXBwbHkpJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctcywgLS1zY29wZSA8c2NvcGU+JyxcbiAgICAgIGBJbnN0YWxsYXRpb24gc2NvcGU6ICR7VkFMSURfVVBEQVRFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogdXNlcilgLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAocGx1Z2luOiBzdHJpbmcsIG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmc7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgICBjb25zdCB7IHBsdWdpblVwZGF0ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgICAgKVxuICAgICAgICBhd2FpdCBwbHVnaW5VcGRhdGVIYW5kbGVyKHBsdWdpbiwgb3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuICAvLyBFTkQgQU5ULU9OTFlcblxuICAvLyBTZXR1cCB0b2tlbiBjb21tYW5kXG4gIHByb2dyYW1cbiAgICAuY29tbWFuZCgnc2V0dXAtdG9rZW4nKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICdTZXQgdXAgYSBsb25nLWxpdmVkIGF1dGhlbnRpY2F0aW9uIHRva2VuIChyZXF1aXJlcyBDbGF1ZGUgc3Vic2NyaXB0aW9uKScsXG4gICAgKVxuICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgW3sgc2V0dXBUb2tlbkhhbmRsZXIgfSwgeyBjcmVhdGVSb290IH1dID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL3V0aWwuanMnKSxcbiAgICAgICAgaW1wb3J0KCcuL2luay5qcycpLFxuICAgICAgXSlcbiAgICAgIGNvbnN0IHJvb3QgPSBhd2FpdCBjcmVhdGVSb290KGdldEJhc2VSZW5kZXJPcHRpb25zKGZhbHNlKSlcbiAgICAgIGF3YWl0IHNldHVwVG9rZW5IYW5kbGVyKHJvb3QpXG4gICAgfSlcblxuICAvLyBBZ2VudHMgY29tbWFuZCAtIGxpc3QgY29uZmlndXJlZCBhZ2VudHNcbiAgcHJvZ3JhbVxuICAgIC5jb21tYW5kKCdhZ2VudHMnKVxuICAgIC5kZXNjcmlwdGlvbignTGlzdCBjb25maWd1cmVkIGFnZW50cycpXG4gICAgLm9wdGlvbihcbiAgICAgICctLXNldHRpbmctc291cmNlcyA8c291cmNlcz4nLFxuICAgICAgJ0NvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIHNldHRpbmcgc291cmNlcyB0byBsb2FkICh1c2VyLCBwcm9qZWN0LCBsb2NhbCkuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGFnZW50c0hhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYWdlbnRzLmpzJylcbiAgICAgIGF3YWl0IGFnZW50c0hhbmRsZXIoKVxuICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgfSlcblxuICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICAvLyBTa2lwIHdoZW4gdGVuZ3VfYXV0b19tb2RlX2NvbmZpZy5lbmFibGVkID09PSAnZGlzYWJsZWQnIChjaXJjdWl0IGJyZWFrZXIpLlxuICAgIC8vIFJlYWRzIGZyb20gZGlzayBjYWNoZSDigJQgR3Jvd3RoQm9vayBpc24ndCBpbml0aWFsaXplZCBhdCByZWdpc3RyYXRpb24gdGltZS5cbiAgICBpZiAoZ2V0QXV0b01vZGVFbmFibGVkU3RhdGVJZkNhY2hlZCgpICE9PSAnZGlzYWJsZWQnKSB7XG4gICAgICBjb25zdCBhdXRvTW9kZUNtZCA9IHByb2dyYW1cbiAgICAgICAgLmNvbW1hbmQoJ2F1dG8tbW9kZScpXG4gICAgICAgIC5kZXNjcmlwdGlvbignSW5zcGVjdCBhdXRvIG1vZGUgY2xhc3NpZmllciBjb25maWd1cmF0aW9uJylcblxuICAgICAgYXV0b01vZGVDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2RlZmF1bHRzJylcbiAgICAgICAgLmRlc2NyaXB0aW9uKFxuICAgICAgICAgICdQcmludCB0aGUgZGVmYXVsdCBhdXRvIG1vZGUgZW52aXJvbm1lbnQsIGFsbG93LCBhbmQgZGVueSBydWxlcyBhcyBKU09OJyxcbiAgICAgICAgKVxuICAgICAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCB7IGF1dG9Nb2RlRGVmYXVsdHNIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF1dG9Nb2RlRGVmYXVsdHNIYW5kbGVyKClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICAgICAgfSlcblxuICAgICAgYXV0b01vZGVDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2NvbmZpZycpXG4gICAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgICAnUHJpbnQgdGhlIGVmZmVjdGl2ZSBhdXRvIG1vZGUgY29uZmlnIGFzIEpTT046IHlvdXIgc2V0dGluZ3Mgd2hlcmUgc2V0LCBkZWZhdWx0cyBvdGhlcndpc2UnLFxuICAgICAgICApXG4gICAgICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgYXV0b01vZGVDb25maWdIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF1dG9Nb2RlQ29uZmlnSGFuZGxlcigpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgIH0pXG5cbiAgICAgIGF1dG9Nb2RlQ21kXG4gICAgICAgIC5jb21tYW5kKCdjcml0aXF1ZScpXG4gICAgICAgIC5kZXNjcmlwdGlvbignR2V0IEFJIGZlZWRiYWNrIG9uIHlvdXIgY3VzdG9tIGF1dG8gbW9kZSBydWxlcycpXG4gICAgICAgIC5vcHRpb24oJy0tbW9kZWwgPG1vZGVsPicsICdPdmVycmlkZSB3aGljaCBtb2RlbCBpcyB1c2VkJylcbiAgICAgICAgLmFjdGlvbihhc3luYyBvcHRpb25zID0+IHtcbiAgICAgICAgICBjb25zdCB7IGF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF3YWl0IGF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyKG9wdGlvbnMpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KClcbiAgICAgICAgfSlcbiAgICB9XG4gIH1cblxuICAvLyBSZW1vdGUgQ29udHJvbCBjb21tYW5kIOKAlCBjb25uZWN0IGxvY2FsIGVudmlyb25tZW50IHRvIGNsYXVkZS5haS9jb2RlLlxuICAvLyBUaGUgYWN0dWFsIGNvbW1hbmQgaXMgaW50ZXJjZXB0ZWQgYnkgdGhlIGZhc3QtcGF0aCBpbiBjbGkudHN4IGJlZm9yZVxuICAvLyBDb21tYW5kZXIuanMgcnVucywgc28gdGhpcyByZWdpc3RyYXRpb24gZXhpc3RzIG9ubHkgZm9yIGhlbHAgb3V0cHV0LlxuICAvLyBBbHdheXMgaGlkZGVuOiBpc0JyaWRnZUVuYWJsZWQoKSBhdCB0aGlzIHBvaW50IChiZWZvcmUgZW5hYmxlQ29uZmlncylcbiAgLy8gd291bGQgdGhyb3cgaW5zaWRlIGlzQ2xhdWRlQUlTdWJzY3JpYmVyIOKGkiBnZXRHbG9iYWxDb25maWcgYW5kIHJldHVyblxuICAvLyBmYWxzZSB2aWEgdGhlIHRyeS9jYXRjaCDigJQgYnV0IG5vdCBiZWZvcmUgcGF5aW5nIH42NW1zIG9mIHNpZGUgZWZmZWN0c1xuICAvLyAoMjVtcyBzZXR0aW5ncyBab2QgcGFyc2UgKyA0MG1zIHN5bmMgYHNlY3VyaXR5YCBrZXljaGFpbiBzdWJwcm9jZXNzKS5cbiAgLy8gVGhlIGR5bmFtaWMgdmlzaWJpbGl0eSBuZXZlciB3b3JrZWQ7IHRoZSBjb21tYW5kIHdhcyBhbHdheXMgaGlkZGVuLlxuICBpZiAoZmVhdHVyZSgnQlJJREdFX01PREUnKSkge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdyZW1vdGUtY29udHJvbCcsIHsgaGlkZGVuOiB0cnVlIH0pXG4gICAgICAuYWxpYXMoJ3JjJylcbiAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgJ0Nvbm5lY3QgeW91ciBsb2NhbCBlbnZpcm9ubWVudCBmb3IgcmVtb3RlLWNvbnRyb2wgc2Vzc2lvbnMgdmlhIGNsYXVkZS5haS9jb2RlJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBVbnJlYWNoYWJsZSDigJQgY2xpLnRzeCBmYXN0LXBhdGggaGFuZGxlcyB0aGlzIGNvbW1hbmQgYmVmb3JlIG1haW4udHN4IGxvYWRzLlxuICAgICAgICAvLyBJZiBzb21laG93IHJlYWNoZWQsIGRlbGVnYXRlIHRvIGJyaWRnZU1haW4uXG4gICAgICAgIGNvbnN0IHsgYnJpZGdlTWFpbiB9ID0gYXdhaXQgaW1wb3J0KCcuL2JyaWRnZS9icmlkZ2VNYWluLmpzJylcbiAgICAgICAgYXdhaXQgYnJpZGdlTWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMykpXG4gICAgICB9KVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpKSB7XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ2Fzc2lzdGFudCBbc2Vzc2lvbklkXScpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdBdHRhY2ggdGhlIFJFUEwgYXMgYSBjbGllbnQgdG8gYSBydW5uaW5nIGJyaWRnZSBzZXNzaW9uLiBEaXNjb3ZlcnMgc2Vzc2lvbnMgdmlhIEFQSSBpZiBubyBzZXNzaW9uSWQgZ2l2ZW4uJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oKCkgPT4ge1xuICAgICAgICAvLyBBcmd2IHJld3JpdGluZyBhYm92ZSBzaG91bGQgaGF2ZSBjb25zdW1lZCBgYXNzaXN0YW50IFtpZF1gXG4gICAgICAgIC8vIGJlZm9yZSBjb21tYW5kZXIgcnVucy4gUmVhY2hpbmcgaGVyZSBtZWFucyBhIHJvb3QgZmxhZyBjYW1lIGZpcnN0XG4gICAgICAgIC8vIChlLmcuIGAtLWRlYnVnIGFzc2lzdGFudGApIGFuZCB0aGUgcG9zaXRpb24tMCBwcmVkaWNhdGVcbiAgICAgICAgLy8gZGlkbid0IG1hdGNoLiBQcmludCB1c2FnZSBsaWtlIHRoZSBzc2ggc3R1YiBkb2VzLlxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAnVXNhZ2U6IGNsYXVkZSBhc3Npc3RhbnQgW3Nlc3Npb25JZF1cXG5cXG4nICtcbiAgICAgICAgICAgICdBdHRhY2ggdGhlIFJFUEwgYXMgYSB2aWV3ZXIgY2xpZW50IHRvIGEgcnVubmluZyBicmlkZ2Ugc2Vzc2lvbi5cXG4nICtcbiAgICAgICAgICAgICdPbWl0IHNlc3Npb25JZCB0byBkaXNjb3ZlciBhbmQgcGljayBmcm9tIGF2YWlsYWJsZSBzZXNzaW9ucy5cXG4nLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfSlcbiAgfVxuXG4gIC8vIERvY3RvciBjb21tYW5kIC0gY2hlY2sgaW5zdGFsbGF0aW9uIGhlYWx0aFxuICBwcm9ncmFtXG4gICAgLmNvbW1hbmQoJ2RvY3RvcicpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0NoZWNrIHRoZSBoZWFsdGggb2YgeW91ciBDbGF1ZGUgQ29kZSBhdXRvLXVwZGF0ZXIuIE5vdGU6IFRoZSB3b3Jrc3BhY2UgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kIHN0ZGlvIHNlcnZlcnMgZnJvbSAubWNwLmpzb24gYXJlIHNwYXduZWQgZm9yIGhlYWx0aCBjaGVja3MuIE9ubHkgdXNlIHRoaXMgY29tbWFuZCBpbiBkaXJlY3RvcmllcyB5b3UgdHJ1c3QuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBbeyBkb2N0b3JIYW5kbGVyIH0sIHsgY3JlYXRlUm9vdCB9XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy91dGlsLmpzJyksXG4gICAgICAgIGltcG9ydCgnLi9pbmsuanMnKSxcbiAgICAgIF0pXG4gICAgICBjb25zdCByb290ID0gYXdhaXQgY3JlYXRlUm9vdChnZXRCYXNlUmVuZGVyT3B0aW9ucyhmYWxzZSkpXG4gICAgICBhd2FpdCBkb2N0b3JIYW5kbGVyKHJvb3QpXG4gICAgfSlcblxuICAvLyBjbGF1ZGUgdXBkYXRlXG4gIC8vXG4gIC8vIEZvciBTZW1WZXItY29tcGxpYW50IHZlcnNpb25pbmcgd2l0aCBidWlsZCBtZXRhZGF0YSAoWC5YLlgrU0hBKTpcbiAgLy8gLSBXZSBwZXJmb3JtIGV4YWN0IHN0cmluZyBjb21wYXJpc29uIChpbmNsdWRpbmcgU0hBKSB0byBkZXRlY3QgYW55IGNoYW5nZVxuICAvLyAtIFRoaXMgZW5zdXJlcyB1c2VycyBhbHdheXMgZ2V0IHRoZSBsYXRlc3QgYnVpbGQsIGV2ZW4gd2hlbiBvbmx5IHRoZSBTSEEgY2hhbmdlc1xuICAvLyAtIFVJIHNob3dzIGJvdGggdmVyc2lvbnMgaW5jbHVkaW5nIGJ1aWxkIG1ldGFkYXRhIGZvciBjbGFyaXR5XG4gIHByb2dyYW1cbiAgICAuY29tbWFuZCgndXBkYXRlJylcbiAgICAuYWxpYXMoJ3VwZ3JhZGUnKVxuICAgIC5kZXNjcmlwdGlvbignQ2hlY2sgZm9yIHVwZGF0ZXMgYW5kIGluc3RhbGwgaWYgYXZhaWxhYmxlJylcbiAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgdXBkYXRlIH0gPSBhd2FpdCBpbXBvcnQoJ3NyYy9jbGkvdXBkYXRlLmpzJylcbiAgICAgIGF3YWl0IHVwZGF0ZSgpXG4gICAgfSlcblxuICAvLyBjbGF1ZGUgdXAg4oCUIHJ1biB0aGUgcHJvamVjdCdzIENMQVVERS5tZCBcIiMgY2xhdWRlIHVwXCIgc2V0dXAgaW5zdHJ1Y3Rpb25zLlxuICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCd1cCcpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdbQU5ULU9OTFldIEluaXRpYWxpemUgb3IgdXBncmFkZSB0aGUgbG9jYWwgZGV2IGVudmlyb25tZW50IHVzaW5nIHRoZSBcIiMgY2xhdWRlIHVwXCIgc2VjdGlvbiBvZiB0aGUgbmVhcmVzdCBDTEFVREUubWQnLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgdXAgfSA9IGF3YWl0IGltcG9ydCgnc3JjL2NsaS91cC5qcycpXG4gICAgICAgIGF3YWl0IHVwKClcbiAgICAgIH0pXG4gIH1cblxuICAvLyBvcGVuY2xhdWRlIHJvbGxiYWNrIChhbnQtb25seSlcbiAgLy8gUm9sbHMgYmFjayB0byBwcmV2aW91cyByZWxlYXNlc1xuICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdyb2xsYmFjayBbdGFyZ2V0XScpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdbQU5ULU9OTFldIFJvbGwgYmFjayB0byBhIHByZXZpb3VzIHJlbGVhc2VcXG5cXG5FeGFtcGxlczpcXG4gIG9wZW5jbGF1ZGUgcm9sbGJhY2sgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEdvIDEgdmVyc2lvbiBiYWNrIGZyb20gY3VycmVudFxcbiAgb3BlbmNsYXVkZSByb2xsYmFjayAzICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgR28gMyB2ZXJzaW9ucyBiYWNrIGZyb20gY3VycmVudFxcbiAgb3BlbmNsYXVkZSByb2xsYmFjayAyLjAuNzMtZGV2LjIwMjUxMjE3LnQxOTA2NTggICAgUm9sbCBiYWNrIHRvIGEgc3BlY2lmaWMgdmVyc2lvbicsXG4gICAgICApXG4gICAgICAub3B0aW9uKCctbCwgLS1saXN0JywgJ0xpc3QgcmVjZW50IHB1Ymxpc2hlZCB2ZXJzaW9ucyB3aXRoIGFnZXMnKVxuICAgICAgLm9wdGlvbignLS1kcnktcnVuJywgJ1Nob3cgd2hhdCB3b3VsZCBiZSBpbnN0YWxsZWQgd2l0aG91dCBpbnN0YWxsaW5nJylcbiAgICAgIC5vcHRpb24oXG4gICAgICAgICctLXNhZmUnLFxuICAgICAgICAnUm9sbCBiYWNrIHRvIHRoZSBzZXJ2ZXItcGlubmVkIHNhZmUgdmVyc2lvbiAoc2V0IGJ5IG9uY2FsbCBkdXJpbmcgaW5jaWRlbnRzKScsXG4gICAgICApXG4gICAgICAuYWN0aW9uKFxuICAgICAgICBhc3luYyAoXG4gICAgICAgICAgdGFyZ2V0Pzogc3RyaW5nLFxuICAgICAgICAgIG9wdGlvbnM/OiB7IGxpc3Q/OiBib29sZWFuOyBkcnlSdW4/OiBib29sZWFuOyBzYWZlPzogYm9vbGVhbiB9LFxuICAgICAgICApID0+IHtcbiAgICAgICAgICBjb25zdCB7IHJvbGxiYWNrIH0gPSBhd2FpdCBpbXBvcnQoJ3NyYy9jbGkvcm9sbGJhY2suanMnKVxuICAgICAgICAgIGF3YWl0IHJvbGxiYWNrKHRhcmdldCwgb3B0aW9ucylcbiAgICAgICAgfSxcbiAgICAgIClcbiAgfVxuXG4gIC8vIGNsYXVkZSBpbnN0YWxsXG4gIHByb2dyYW1cbiAgICAuY29tbWFuZCgnaW5zdGFsbCBbdGFyZ2V0XScpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0luc3RhbGwgQ2xhdWRlIENvZGUgbmF0aXZlIGJ1aWxkLiBVc2UgW3RhcmdldF0gdG8gc3BlY2lmeSB2ZXJzaW9uIChzdGFibGUsIGxhdGVzdCwgb3Igc3BlY2lmaWMgdmVyc2lvbiknLFxuICAgIClcbiAgICAub3B0aW9uKCctLWZvcmNlJywgJ0ZvcmNlIGluc3RhbGxhdGlvbiBldmVuIGlmIGFscmVhZHkgaW5zdGFsbGVkJylcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRpb25zOiB7IGZvcmNlPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgaW5zdGFsbEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvdXRpbC5qcycpXG4gICAgICAgIGF3YWl0IGluc3RhbGxIYW5kbGVyKHRhcmdldCwgb3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuXG4gIC8vIGFudC1vbmx5IGNvbW1hbmRzXG4gIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgY29uc3QgdmFsaWRhdGVMb2dJZCA9ICh2YWx1ZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBtYXliZVNlc3Npb25JZCA9IHZhbGlkYXRlVXVpZCh2YWx1ZSlcbiAgICAgIGlmIChtYXliZVNlc3Npb25JZCkgcmV0dXJuIG1heWJlU2Vzc2lvbklkXG4gICAgICByZXR1cm4gTnVtYmVyKHZhbHVlKVxuICAgIH1cbiAgICAvLyBjbGF1ZGUgbG9nXG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ2xvZycpXG4gICAgICAuZGVzY3JpcHRpb24oJ1tBTlQtT05MWV0gTWFuYWdlIGNvbnZlcnNhdGlvbiBsb2dzLicpXG4gICAgICAuYXJndW1lbnQoXG4gICAgICAgICdbbnVtYmVyfHNlc3Npb25JZF0nLFxuICAgICAgICAnQSBudW1iZXIgKDAsIDEsIDIsIGV0Yy4pIHRvIGRpc3BsYXkgYSBzcGVjaWZpYyBsb2csIG9yIHRoZSBzZXNzc2lvbiBJRCAodXVpZCkgb2YgYSBsb2cnLFxuICAgICAgICB2YWxpZGF0ZUxvZ0lkLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAobG9nSWQ6IHN0cmluZyB8IG51bWJlciB8IHVuZGVmaW5lZCkgPT4ge1xuICAgICAgICBjb25zdCB7IGxvZ0hhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgYXdhaXQgbG9nSGFuZGxlcihsb2dJZClcbiAgICAgIH0pXG5cbiAgICAvLyBjbGF1ZGUgZXJyb3JcbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnZXJyb3InKVxuICAgICAgLmRlc2NyaXB0aW9uKFxuICAgICAgICAnW0FOVC1PTkxZXSBWaWV3IGVycm9yIGxvZ3MuIE9wdGlvbmFsbHkgcHJvdmlkZSBhIG51bWJlciAoMCwgLTEsIC0yLCBldGMuKSB0byBkaXNwbGF5IGEgc3BlY2lmaWMgbG9nLicsXG4gICAgICApXG4gICAgICAuYXJndW1lbnQoXG4gICAgICAgICdbbnVtYmVyXScsXG4gICAgICAgICdBIG51bWJlciAoMCwgMSwgMiwgZXRjLikgdG8gZGlzcGxheSBhIHNwZWNpZmljIGxvZycsXG4gICAgICAgIHBhcnNlSW50LFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAobnVtYmVyOiBudW1iZXIgfCB1bmRlZmluZWQpID0+IHtcbiAgICAgICAgY29uc3QgeyBlcnJvckhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgYXdhaXQgZXJyb3JIYW5kbGVyKG51bWJlcilcbiAgICAgIH0pXG5cbiAgICAvLyBjbGF1ZGUgZXhwb3J0XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ2V4cG9ydCcpXG4gICAgICAuZGVzY3JpcHRpb24oJ1tBTlQtT05MWV0gRXhwb3J0IGEgY29udmVyc2F0aW9uIHRvIGEgdGV4dCBmaWxlLicpXG4gICAgICAudXNhZ2UoJzxzb3VyY2U+IDxvdXRwdXRGaWxlPicpXG4gICAgICAuYXJndW1lbnQoXG4gICAgICAgICc8c291cmNlPicsXG4gICAgICAgICdTZXNzaW9uIElELCBsb2cgaW5kZXggKDAsIDEsIDIuLi4pLCBvciBwYXRoIHRvIGEgLmpzb24vLmpzb25sIGxvZyBmaWxlJyxcbiAgICAgIClcbiAgICAgIC5hcmd1bWVudCgnPG91dHB1dEZpbGU+JywgJ091dHB1dCBmaWxlIHBhdGggZm9yIHRoZSBleHBvcnRlZCB0ZXh0JylcbiAgICAgIC5hZGRIZWxwVGV4dChcbiAgICAgICAgJ2FmdGVyJyxcbiAgICAgICAgYFxuRXhhbXBsZXM6XG4gICQgY2xhdWRlIGV4cG9ydCAwIGNvbnZlcnNhdGlvbi50eHQgICAgICAgICAgICAgICAgRXhwb3J0IGNvbnZlcnNhdGlvbiBhdCBsb2cgaW5kZXggMFxuICAkIGNsYXVkZSBleHBvcnQgPHV1aWQ+IGNvbnZlcnNhdGlvbi50eHQgICAgICAgICAgIEV4cG9ydCBjb252ZXJzYXRpb24gYnkgc2Vzc2lvbiBJRFxuICAkIGNsYXVkZSBleHBvcnQgaW5wdXQuanNvbiBvdXRwdXQudHh0ICAgICAgICAgICAgIFJlbmRlciBKU09OIGxvZyBmaWxlIHRvIHRleHRcbiAgJCBjbGF1ZGUgZXhwb3J0IDx1dWlkPi5qc29ubCBvdXRwdXQudHh0ICAgICAgICAgICBSZW5kZXIgSlNPTkwgc2Vzc2lvbiBmaWxlIHRvIHRleHRgLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAoc291cmNlOiBzdHJpbmcsIG91dHB1dEZpbGU6IHN0cmluZykgPT4ge1xuICAgICAgICBjb25zdCB7IGV4cG9ydEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgYXdhaXQgZXhwb3J0SGFuZGxlcihzb3VyY2UsIG91dHB1dEZpbGUpXG4gICAgICB9KVxuXG4gICAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICAgIGNvbnN0IHRhc2tDbWQgPSBwcm9ncmFtXG4gICAgICAgIC5jb21tYW5kKCd0YXNrJylcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdbQU5ULU9OTFldIE1hbmFnZSB0YXNrIGxpc3QgdGFza3MnKVxuXG4gICAgICB0YXNrQ21kXG4gICAgICAgIC5jb21tYW5kKCdjcmVhdGUgPHN1YmplY3Q+JylcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdDcmVhdGUgYSBuZXcgdGFzaycpXG4gICAgICAgIC5vcHRpb24oJy1kLCAtLWRlc2NyaXB0aW9uIDx0ZXh0PicsICdUYXNrIGRlc2NyaXB0aW9uJylcbiAgICAgICAgLm9wdGlvbignLWwsIC0tbGlzdCA8aWQ+JywgJ1Rhc2sgbGlzdCBJRCAoZGVmYXVsdHMgdG8gXCJ0YXNrbGlzdFwiKScpXG4gICAgICAgIC5hY3Rpb24oXG4gICAgICAgICAgYXN5bmMgKFxuICAgICAgICAgICAgc3ViamVjdDogc3RyaW5nLFxuICAgICAgICAgICAgb3B0czogeyBkZXNjcmlwdGlvbj86IHN0cmluZzsgbGlzdD86IHN0cmluZyB9LFxuICAgICAgICAgICkgPT4ge1xuICAgICAgICAgICAgY29uc3QgeyB0YXNrQ3JlYXRlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICAgICAgYXdhaXQgdGFza0NyZWF0ZUhhbmRsZXIoc3ViamVjdCwgb3B0cylcbiAgICAgICAgICB9LFxuICAgICAgICApXG5cbiAgICAgIHRhc2tDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2xpc3QnKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ0xpc3QgYWxsIHRhc2tzJylcbiAgICAgICAgLm9wdGlvbignLWwsIC0tbGlzdCA8aWQ+JywgJ1Rhc2sgbGlzdCBJRCAoZGVmYXVsdHMgdG8gXCJ0YXNrbGlzdFwiKScpXG4gICAgICAgIC5vcHRpb24oJy0tcGVuZGluZycsICdTaG93IG9ubHkgcGVuZGluZyB0YXNrcycpXG4gICAgICAgIC5vcHRpb24oJy0tanNvbicsICdPdXRwdXQgYXMgSlNPTicpXG4gICAgICAgIC5hY3Rpb24oXG4gICAgICAgICAgYXN5bmMgKG9wdHM6IHtcbiAgICAgICAgICAgIGxpc3Q/OiBzdHJpbmdcbiAgICAgICAgICAgIHBlbmRpbmc/OiBib29sZWFuXG4gICAgICAgICAgICBqc29uPzogYm9vbGVhblxuICAgICAgICAgIH0pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHsgdGFza0xpc3RIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2FudC5qcycpXG4gICAgICAgICAgICBhd2FpdCB0YXNrTGlzdEhhbmRsZXIob3B0cylcbiAgICAgICAgICB9LFxuICAgICAgICApXG5cbiAgICAgIHRhc2tDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2dldCA8aWQ+JylcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdHZXQgZGV0YWlscyBvZiBhIHRhc2snKVxuICAgICAgICAub3B0aW9uKCctbCwgLS1saXN0IDxpZD4nLCAnVGFzayBsaXN0IElEIChkZWZhdWx0cyB0byBcInRhc2tsaXN0XCIpJylcbiAgICAgICAgLmFjdGlvbihhc3luYyAoaWQ6IHN0cmluZywgb3B0czogeyBsaXN0Pzogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgICBjb25zdCB7IHRhc2tHZXRIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2FudC5qcycpXG4gICAgICAgICAgYXdhaXQgdGFza0dldEhhbmRsZXIoaWQsIG9wdHMpXG4gICAgICAgIH0pXG5cbiAgICAgIHRhc2tDbWRcbiAgICAgICAgLmNvbW1hbmQoJ3VwZGF0ZSA8aWQ+JylcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdVcGRhdGUgYSB0YXNrJylcbiAgICAgICAgLm9wdGlvbignLWwsIC0tbGlzdCA8aWQ+JywgJ1Rhc2sgbGlzdCBJRCAoZGVmYXVsdHMgdG8gXCJ0YXNrbGlzdFwiKScpXG4gICAgICAgIC5vcHRpb24oXG4gICAgICAgICAgJy1zLCAtLXN0YXR1cyA8c3RhdHVzPicsXG4gICAgICAgICAgYFNldCBzdGF0dXMgKCR7VEFTS19TVEFUVVNFUy5qb2luKCcsICcpfSlgLFxuICAgICAgICApXG4gICAgICAgIC5vcHRpb24oJy0tc3ViamVjdCA8dGV4dD4nLCAnVXBkYXRlIHN1YmplY3QnKVxuICAgICAgICAub3B0aW9uKCctZCwgLS1kZXNjcmlwdGlvbiA8dGV4dD4nLCAnVXBkYXRlIGRlc2NyaXB0aW9uJylcbiAgICAgICAgLm9wdGlvbignLS1vd25lciA8YWdlbnRJZD4nLCAnU2V0IG93bmVyJylcbiAgICAgICAgLm9wdGlvbignLS1jbGVhci1vd25lcicsICdDbGVhciBvd25lcicpXG4gICAgICAgIC5hY3Rpb24oXG4gICAgICAgICAgYXN5bmMgKFxuICAgICAgICAgICAgaWQ6IHN0cmluZyxcbiAgICAgICAgICAgIG9wdHM6IHtcbiAgICAgICAgICAgICAgbGlzdD86IHN0cmluZ1xuICAgICAgICAgICAgICBzdGF0dXM/OiBzdHJpbmdcbiAgICAgICAgICAgICAgc3ViamVjdD86IHN0cmluZ1xuICAgICAgICAgICAgICBkZXNjcmlwdGlvbj86IHN0cmluZ1xuICAgICAgICAgICAgICBvd25lcj86IHN0cmluZ1xuICAgICAgICAgICAgICBjbGVhck93bmVyPzogYm9vbGVhblxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHsgdGFza1VwZGF0ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgICAgIGF3YWl0IHRhc2tVcGRhdGVIYW5kbGVyKGlkLCBvcHRzKVxuICAgICAgICAgIH0sXG4gICAgICAgIClcblxuICAgICAgdGFza0NtZFxuICAgICAgICAuY29tbWFuZCgnZGlyJylcbiAgICAgICAgLmRlc2NyaXB0aW9uKCdTaG93IHRoZSB0YXNrcyBkaXJlY3RvcnkgcGF0aCcpXG4gICAgICAgIC5vcHRpb24oJy1sLCAtLWxpc3QgPGlkPicsICdUYXNrIGxpc3QgSUQgKGRlZmF1bHRzIHRvIFwidGFza2xpc3RcIiknKVxuICAgICAgICAuYWN0aW9uKGFzeW5jIChvcHRzOiB7IGxpc3Q/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgdGFza0RpckhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgICBhd2FpdCB0YXNrRGlySGFuZGxlcihvcHRzKVxuICAgICAgICB9KVxuICAgIH1cblxuICAgIC8vIGNsYXVkZSBjb21wbGV0aW9uIDxzaGVsbD5cbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnY29tcGxldGlvbiA8c2hlbGw+JywgeyBoaWRkZW46IHRydWUgfSlcbiAgICAgIC5kZXNjcmlwdGlvbignR2VuZXJhdGUgc2hlbGwgY29tcGxldGlvbiBzY3JpcHQgKGJhc2gsIHpzaCwgb3IgZmlzaCknKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tb3V0cHV0IDxmaWxlPicsXG4gICAgICAgICdXcml0ZSBjb21wbGV0aW9uIHNjcmlwdCBkaXJlY3RseSB0byBhIGZpbGUgaW5zdGVhZCBvZiBzdGRvdXQnLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAoc2hlbGw6IHN0cmluZywgb3B0czogeyBvdXRwdXQ/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgICBjb25zdCB7IGNvbXBsZXRpb25IYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2FudC5qcycpXG4gICAgICAgIGF3YWl0IGNvbXBsZXRpb25IYW5kbGVyKHNoZWxsLCBvcHRzLCBwcm9ncmFtKVxuICAgICAgfSlcbiAgfVxuXG4gIHByb2ZpbGVDaGVja3BvaW50KCdydW5fYmVmb3JlX3BhcnNlJylcbiAgYXdhaXQgcHJvZ3JhbS5wYXJzZUFzeW5jKHByb2Nlc3MuYXJndilcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9hZnRlcl9wYXJzZScpXG5cbiAgLy8gUmVjb3JkIGZpbmFsIGNoZWNrcG9pbnQgZm9yIHRvdGFsX3RpbWUgY2FsY3VsYXRpb25cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fYWZ0ZXJfcnVuJylcblxuICAvLyBMb2cgc3RhcnR1cCBwZXJmIHRvIFN0YXRzaWcgKHNhbXBsZWQpIGFuZCBvdXRwdXQgZGV0YWlsZWQgcmVwb3J0IGlmIGVuYWJsZWRcbiAgcHJvZmlsZVJlcG9ydCgpXG5cbiAgcmV0dXJuIHByb2dyYW1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9nVGVuZ3VJbml0KHtcbiAgaGFzSW5pdGlhbFByb21wdCxcbiAgaGFzU3RkaW4sXG4gIHZlcmJvc2UsXG4gIGRlYnVnLFxuICBkZWJ1Z1RvU3RkZXJyLFxuICBwcmludCxcbiAgb3V0cHV0Rm9ybWF0LFxuICBpbnB1dEZvcm1hdCxcbiAgbnVtQWxsb3dlZFRvb2xzLFxuICBudW1EaXNhbGxvd2VkVG9vbHMsXG4gIG1jcENsaWVudENvdW50LFxuICB3b3JrdHJlZUVuYWJsZWQsXG4gIHNraXBXZWJGZXRjaFByZWZsaWdodCxcbiAgZ2l0aHViQWN0aW9uSW5wdXRzLFxuICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCxcbiAgcGVybWlzc2lvbk1vZGUsXG4gIG1vZGVJc0J5cGFzcyxcbiAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCxcbiAgc3lzdGVtUHJvbXB0RmxhZyxcbiAgYXBwZW5kU3lzdGVtUHJvbXB0RmxhZyxcbiAgdGhpbmtpbmdDb25maWcsXG4gIGFzc2lzdGFudEFjdGl2YXRpb25QYXRoLFxufToge1xuICBoYXNJbml0aWFsUHJvbXB0OiBib29sZWFuXG4gIGhhc1N0ZGluOiBib29sZWFuXG4gIHZlcmJvc2U6IGJvb2xlYW5cbiAgZGVidWc6IGJvb2xlYW5cbiAgZGVidWdUb1N0ZGVycjogYm9vbGVhblxuICBwcmludDogYm9vbGVhblxuICBvdXRwdXRGb3JtYXQ6IHN0cmluZ1xuICBpbnB1dEZvcm1hdDogc3RyaW5nXG4gIG51bUFsbG93ZWRUb29sczogbnVtYmVyXG4gIG51bURpc2FsbG93ZWRUb29sczogbnVtYmVyXG4gIG1jcENsaWVudENvdW50OiBudW1iZXJcbiAgd29ya3RyZWVFbmFibGVkOiBib29sZWFuXG4gIHNraXBXZWJGZXRjaFByZWZsaWdodDogYm9vbGVhbiB8IHVuZGVmaW5lZFxuICBnaXRodWJBY3Rpb25JbnB1dHM6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZDogYm9vbGVhblxuICBwZXJtaXNzaW9uTW9kZTogc3RyaW5nXG4gIG1vZGVJc0J5cGFzczogYm9vbGVhblxuICBhbGxvd0Rhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkOiBib29sZWFuXG4gIHN5c3RlbVByb21wdEZsYWc6ICdmaWxlJyB8ICdmbGFnJyB8IHVuZGVmaW5lZFxuICBhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnOiAnZmlsZScgfCAnZmxhZycgfCB1bmRlZmluZWRcbiAgdGhpbmtpbmdDb25maWc6IFRoaW5raW5nQ29uZmlnXG4gIGFzc2lzdGFudEFjdGl2YXRpb25QYXRoOiBzdHJpbmcgfCB1bmRlZmluZWRcbn0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBsb2dFdmVudCgndGVuZ3VfaW5pdCcsIHtcbiAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICdjbGF1ZGUnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICBoYXNJbml0aWFsUHJvbXB0LFxuICAgICAgaGFzU3RkaW4sXG4gICAgICB2ZXJib3NlLFxuICAgICAgZGVidWcsXG4gICAgICBkZWJ1Z1RvU3RkZXJyLFxuICAgICAgcHJpbnQsXG4gICAgICBvdXRwdXRGb3JtYXQ6XG4gICAgICAgIG91dHB1dEZvcm1hdCBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgaW5wdXRGb3JtYXQ6XG4gICAgICAgIGlucHV0Rm9ybWF0IGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICBudW1BbGxvd2VkVG9vbHMsXG4gICAgICBudW1EaXNhbGxvd2VkVG9vbHMsXG4gICAgICBtY3BDbGllbnRDb3VudCxcbiAgICAgIHdvcmt0cmVlOiB3b3JrdHJlZUVuYWJsZWQsXG4gICAgICBza2lwV2ViRmV0Y2hQcmVmbGlnaHQsXG4gICAgICAuLi4oZ2l0aHViQWN0aW9uSW5wdXRzICYmIHtcbiAgICAgICAgZ2l0aHViQWN0aW9uSW5wdXRzOlxuICAgICAgICAgIGdpdGh1YkFjdGlvbklucHV0cyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgfSksXG4gICAgICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCxcbiAgICAgIHBlcm1pc3Npb25Nb2RlOlxuICAgICAgICBwZXJtaXNzaW9uTW9kZSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgbW9kZUlzQnlwYXNzLFxuICAgICAgaW5Qcm90ZWN0ZWROYW1lc3BhY2U6IGlzSW5Qcm90ZWN0ZWROYW1lc3BhY2UoKSxcbiAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNQYXNzZWQsXG4gICAgICB0aGlua2luZ1R5cGU6XG4gICAgICAgIHRoaW5raW5nQ29uZmlnLnR5cGUgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIC4uLihzeXN0ZW1Qcm9tcHRGbGFnICYmIHtcbiAgICAgICAgc3lzdGVtUHJvbXB0RmxhZzpcbiAgICAgICAgICBzeXN0ZW1Qcm9tcHRGbGFnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KSxcbiAgICAgIC4uLihhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnICYmIHtcbiAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0RmxhZzpcbiAgICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KSxcbiAgICAgIGlzX3NpbXBsZTogaXNCYXJlTW9kZSgpIHx8IHVuZGVmaW5lZCxcbiAgICAgIGlzX2Nvb3JkaW5hdG9yOlxuICAgICAgICBmZWF0dXJlKCdDT09SRElOQVRPUl9NT0RFJykgJiZcbiAgICAgICAgY29vcmRpbmF0b3JNb2RlTW9kdWxlPy5pc0Nvb3JkaW5hdG9yTW9kZSgpXG4gICAgICAgICAgPyB0cnVlXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAuLi4oYXNzaXN0YW50QWN0aXZhdGlvblBhdGggJiYge1xuICAgICAgICBhc3Npc3RhbnRBY3RpdmF0aW9uUGF0aDpcbiAgICAgICAgICBhc3Npc3RhbnRBY3RpdmF0aW9uUGF0aCBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgfSksXG4gICAgICBhdXRvVXBkYXRlc0NoYW5uZWw6IChnZXRJbml0aWFsU2V0dGluZ3MoKS5hdXRvVXBkYXRlc0NoYW5uZWwgPz9cbiAgICAgICAgJ2xhdGVzdCcpIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAuLi4oXCJleHRlcm5hbFwiID09PSAnYW50J1xuICAgICAgICA/ICgoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjd2QgPSBnZXRDd2QoKVxuICAgICAgICAgICAgY29uc3QgZ2l0Um9vdCA9IGZpbmRHaXRSb290KGN3ZClcbiAgICAgICAgICAgIGNvbnN0IHJwID0gZ2l0Um9vdCA/IHJlbGF0aXZlKGdpdFJvb3QsIGN3ZCkgfHwgJy4nIDogdW5kZWZpbmVkXG4gICAgICAgICAgICByZXR1cm4gcnBcbiAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICByZWxhdGl2ZVByb2plY3RQYXRoOlxuICAgICAgICAgICAgICAgICAgICBycCBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgOiB7fVxuICAgICAgICAgIH0pKClcbiAgICAgICAgOiB7fSksXG4gICAgfSlcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2dFcnJvcihlcnJvcilcbiAgfVxufVxuXG5mdW5jdGlvbiBtYXliZUFjdGl2YXRlUHJvYWN0aXZlKG9wdGlvbnM6IHVua25vd24pOiB2b2lkIHtcbiAgaWYgKFxuICAgIChmZWF0dXJlKCdQUk9BQ1RJVkUnKSB8fCBmZWF0dXJlKCdLQUlST1MnKSkgJiZcbiAgICAoKG9wdGlvbnMgYXMgeyBwcm9hY3RpdmU/OiBib29sZWFuIH0pLnByb2FjdGl2ZSB8fFxuICAgICAgaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfUFJPQUNUSVZFKSlcbiAgKSB7XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHNcbiAgICBjb25zdCBwcm9hY3RpdmVNb2R1bGUgPSByZXF1aXJlKCcuL3Byb2FjdGl2ZS9pbmRleC5qcycpXG4gICAgaWYgKCFwcm9hY3RpdmVNb2R1bGUuaXNQcm9hY3RpdmVBY3RpdmUoKSkge1xuICAgICAgcHJvYWN0aXZlTW9kdWxlLmFjdGl2YXRlUHJvYWN0aXZlKCdjb21tYW5kJylcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnM6IHVua25vd24pOiB2b2lkIHtcbiAgaWYgKCEoZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0JSSUVGJykpKSByZXR1cm5cbiAgY29uc3QgYnJpZWZGbGFnID0gKG9wdGlvbnMgYXMgeyBicmllZj86IGJvb2xlYW4gfSkuYnJpZWZcbiAgY29uc3QgYnJpZWZFbnYgPSBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9CUklFRilcbiAgaWYgKCFicmllZkZsYWcgJiYgIWJyaWVmRW52KSByZXR1cm5cbiAgLy8gLS1icmllZiAvIENMQVVERV9DT0RFX0JSSUVGIGFyZSBleHBsaWNpdCBvcHQtaW5zOiBjaGVjayBlbnRpdGxlbWVudCxcbiAgLy8gdGhlbiBzZXQgdXNlck1zZ09wdEluIHRvIGFjdGl2YXRlIHRoZSB0b29sICsgcHJvbXB0IHNlY3Rpb24uIFRoZSBlbnZcbiAgLy8gdmFyIGFsc28gZ3JhbnRzIGVudGl0bGVtZW50IChpc0JyaWVmRW50aXRsZWQoKSByZWFkcyBpdCksIHNvIHNldHRpbmdcbiAgLy8gQ0xBVURFX0NPREVfQlJJRUY9MSBhbG9uZSBmb3JjZS1lbmFibGVzIGZvciBkZXYvdGVzdGluZyDigJQgbm8gR0IgZ2F0ZVxuICAvLyBuZWVkZWQuIGluaXRpYWxJc0JyaWVmT25seSByZWFkcyBnZXRVc2VyTXNnT3B0SW4oKSBkaXJlY3RseS5cbiAgLy8gQ29uZGl0aW9uYWwgcmVxdWlyZTogc3RhdGljIGltcG9ydCB3b3VsZCBsZWFrIHRoZSB0b29sIG5hbWUgc3RyaW5nXG4gIC8vIGludG8gZXh0ZXJuYWwgYnVpbGRzIHZpYSBCcmllZlRvb2wudHMg4oaSIHByb21wdC50cy5cbiAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICBjb25zdCB7IGlzQnJpZWZFbnRpdGxlZCB9ID1cbiAgICByZXF1aXJlKCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKSBhcyB0eXBlb2YgaW1wb3J0KCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKVxuICAvKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbiAgY29uc3QgZW50aXRsZWQgPSBpc0JyaWVmRW50aXRsZWQoKVxuICBpZiAoZW50aXRsZWQpIHtcbiAgICBzZXRVc2VyTXNnT3B0SW4odHJ1ZSlcbiAgfVxuICAvLyBGaXJlIHVuY29uZGl0aW9uYWxseSBvbmNlIGludGVudCBpcyBzZWVuOiBlbmFibGVkPWZhbHNlIGNhcHR1cmVzIHRoZVxuICAvLyBcInVzZXIgdHJpZWQgYnV0IHdhcyBnYXRlZFwiIGZhaWx1cmUgbW9kZSBpbiBEYXRhZG9nLlxuICBsb2dFdmVudCgndGVuZ3VfYnJpZWZfbW9kZV9lbmFibGVkJywge1xuICAgIGVuYWJsZWQ6IGVudGl0bGVkLFxuICAgIGdhdGVkOiAhZW50aXRsZWQsXG4gICAgc291cmNlOiAoYnJpZWZFbnZcbiAgICAgID8gJ2VudidcbiAgICAgIDogJ2ZsYWcnKSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICB9KVxufVxuXG5mdW5jdGlvbiByZXNldEN1cnNvcigpIHtcbiAgY29uc3QgdGVybWluYWwgPSBwcm9jZXNzLnN0ZGVyci5pc1RUWVxuICAgID8gcHJvY2Vzcy5zdGRlcnJcbiAgICA6IHByb2Nlc3Muc3Rkb3V0LmlzVFRZXG4gICAgICA/IHByb2Nlc3Muc3Rkb3V0XG4gICAgICA6IHVuZGVmaW5lZFxuICB0ZXJtaW5hbD8ud3JpdGUoU0hPV19DVVJTT1IpXG59XG5cbnR5cGUgVGVhbW1hdGVPcHRpb25zID0ge1xuICBhZ2VudElkPzogc3RyaW5nXG4gIGFnZW50TmFtZT86IHN0cmluZ1xuICB0ZWFtTmFtZT86IHN0cmluZ1xuICBhZ2VudENvbG9yPzogc3RyaW5nXG4gIHBsYW5Nb2RlUmVxdWlyZWQ/OiBib29sZWFuXG4gIHBhcmVudFNlc3Npb25JZD86IHN0cmluZ1xuICB0ZWFtbWF0ZU1vZGU/OiAnYXV0bycgfCAndG11eCcgfCAnaW4tcHJvY2VzcydcbiAgYWdlbnRUeXBlPzogc3RyaW5nXG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RUZWFtbWF0ZU9wdGlvbnMob3B0aW9uczogdW5rbm93bik6IFRlYW1tYXRlT3B0aW9ucyB7XG4gIGlmICh0eXBlb2Ygb3B0aW9ucyAhPT0gJ29iamVjdCcgfHwgb3B0aW9ucyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7fVxuICB9XG4gIGNvbnN0IG9wdHMgPSBvcHRpb25zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gIGNvbnN0IHRlYW1tYXRlTW9kZSA9IG9wdHMudGVhbW1hdGVNb2RlXG4gIHJldHVybiB7XG4gICAgYWdlbnRJZDogdHlwZW9mIG9wdHMuYWdlbnRJZCA9PT0gJ3N0cmluZycgPyBvcHRzLmFnZW50SWQgOiB1bmRlZmluZWQsXG4gICAgYWdlbnROYW1lOiB0eXBlb2Ygb3B0cy5hZ2VudE5hbWUgPT09ICdzdHJpbmcnID8gb3B0cy5hZ2VudE5hbWUgOiB1bmRlZmluZWQsXG4gICAgdGVhbU5hbWU6IHR5cGVvZiBvcHRzLnRlYW1OYW1lID09PSAnc3RyaW5nJyA/IG9wdHMudGVhbU5hbWUgOiB1bmRlZmluZWQsXG4gICAgYWdlbnRDb2xvcjpcbiAgICAgIHR5cGVvZiBvcHRzLmFnZW50Q29sb3IgPT09ICdzdHJpbmcnID8gb3B0cy5hZ2VudENvbG9yIDogdW5kZWZpbmVkLFxuICAgIHBsYW5Nb2RlUmVxdWlyZWQ6XG4gICAgICB0eXBlb2Ygb3B0cy5wbGFuTW9kZVJlcXVpcmVkID09PSAnYm9vbGVhbidcbiAgICAgICAgPyBvcHRzLnBsYW5Nb2RlUmVxdWlyZWRcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgcGFyZW50U2Vzc2lvbklkOlxuICAgICAgdHlwZW9mIG9wdHMucGFyZW50U2Vzc2lvbklkID09PSAnc3RyaW5nJ1xuICAgICAgICA/IG9wdHMucGFyZW50U2Vzc2lvbklkXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgIHRlYW1tYXRlTW9kZTpcbiAgICAgIHRlYW1tYXRlTW9kZSA9PT0gJ2F1dG8nIHx8XG4gICAgICB0ZWFtbWF0ZU1vZGUgPT09ICd0bXV4JyB8fFxuICAgICAgdGVhbW1hdGVNb2RlID09PSAnaW4tcHJvY2VzcydcbiAgICAgICAgPyB0ZWFtbWF0ZU1vZGVcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgYWdlbnRUeXBlOiB0eXBlb2Ygb3B0cy5hZ2VudFR5cGUgPT09ICdzdHJpbmcnID8gb3B0cy5hZ2VudFR5cGUgOiB1bmRlZmluZWQsXG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVNBLGlCQUFpQixFQUFFQyxhQUFhLFFBQVEsNEJBQTRCOztBQUU3RTtBQUNBRCxpQkFBaUIsQ0FBQyxnQkFBZ0IsQ0FBQztBQUVuQyxTQUFTRSxlQUFlLFFBQVEsaUNBQWlDOztBQUVqRTtBQUNBQSxlQUFlLENBQUMsQ0FBQztBQUVqQixTQUNFQywrQkFBK0IsRUFDL0JDLHFCQUFxQixRQUNoQiwyQ0FBMkM7O0FBRWxEO0FBQ0FBLHFCQUFxQixDQUFDLENBQUM7QUFFdkIsU0FBU0MsT0FBTyxRQUFRLFlBQVk7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