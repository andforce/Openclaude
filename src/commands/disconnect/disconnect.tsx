import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Login } from '../login/login.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type ConnectedProviderInfo,
} from '../../utils/config.js'
import {
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  getAnthropicCompatibleModelId,
  getCustomAnthropicProviderLabel,
  isCustomAnthropicProviderId,
  parseAnthropicCompatibleModelValue,
} from '../../utils/customAnthropicProviders.js'
import {
  CUSTOM_OPENAI_PROVIDER_ID,
  getCustomOpenAIProviderLabel,
  isCustomOpenAIProviderId,
  parseOpenAICompatibleModelValue,
} from '../../utils/customOpenAIProviders.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  clearUserSpecifiedModelSetting,
  getUserSpecifiedModelSetting,
  type ModelSetting,
} from '../../utils/model/model.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

const PROVIDER_LABELS: Record<string, string> = {
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter Anthropic-compatible API',
  'custom-openai': 'Custom OpenAI-compatible API',
  'custom-anthropic': 'Custom Anthropic-compatible API',
}

type DisconnectableProvider = {
  providerId: string
  label: string
  info: ConnectedProviderInfo
  isActive: boolean
}

type DisconnectStep =
  | { type: 'empty' }
  | { type: 'select-provider' }
  | {
      type: 'confirm'
      provider: DisconnectableProvider
      nextActiveProviderLabel?: string
    }
  | {
      type: 'success'
      providerLabel: string
    }
  | { type: 're-login' }
  | { type: 'error'; error: string }

function getProviderLabel(providerId: string): string {
  if (isCustomOpenAIProviderId(providerId)) {
    return getCustomOpenAIProviderLabel(
      providerId,
      getGlobalConfig().connectedProviders?.[providerId],
    )
  }
  if (isCustomAnthropicProviderId(providerId)) {
    return getCustomAnthropicProviderLabel(
      providerId,
      getGlobalConfig().connectedProviders?.[providerId],
    )
  }

  return PROVIDER_LABELS[providerId] ?? providerId
}

function getDisconnectableProviders(): DisconnectableProvider[] {
  const config = getGlobalConfig()
  const connectedProviders = config.connectedProviders ?? {}

  return Object.entries(connectedProviders).map(([providerId, info]) => ({
    providerId,
    label: getProviderLabel(providerId),
    info,
    isActive: config.activeProvider === providerId,
  }))
}

function isModelOwnedByProvider(
  model: ModelSetting | undefined,
  providerId: string,
  provider: ConnectedProviderInfo,
): boolean {
  if (!model) {
    return false
  }

  const scopedOpenAIModel = parseOpenAICompatibleModelValue(model)
  if (scopedOpenAIModel) {
    return scopedOpenAIModel.providerId === providerId
  }

  const scopedModel = parseAnthropicCompatibleModelValue(model)
  if (scopedModel) {
    return scopedModel.providerId === providerId
  }

  return provider.defaultModel === getAnthropicCompatibleModelId(model)
}

function EmptyState({
  onClose,
}: {
  onClose: () => void
}) {
  useInput((_, key) => {
    if (key.escape || key.return) {
      onClose()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text>No connected providers found.</Text>
      <Text dimColor>Use /connect first, then run /disconnect to remove one.</Text>
    </Box>
  )
}

function ConfirmDialog({
  provider,
  nextActiveProviderLabel,
  onConfirm,
  onCancel,
}: {
  provider: DisconnectableProvider
  nextActiveProviderLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      onConfirm()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        Disconnect <Text bold>{provider.label}</Text>?
      </Text>
      {provider.isActive ? (
        nextActiveProviderLabel ? (
          <Text dimColor>
            Active provider will switch to{' '}
            <Text color="yellow">{nextActiveProviderLabel}</Text>.
          </Text>
        ) : (
          <Text dimColor>This is the active provider. No active provider will remain.</Text>
        )
      ) : (
        <Text dimColor>This provider is currently connected but not active.</Text>
      )}
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text color="red" bold>
          [Enter] Disconnect
        </Text>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  )
}

function ResultDialog({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  useInput((_, key) => {
    if (key.escape || key.return) {
      onClose()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{message}</Text>
      <Text dimColor>Press Enter or Esc to close.</Text>
    </Box>
  )
}

function DisconnectDialog({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}) {
  const providers = React.useMemo(() => getDisconnectableProviders(), [])
  const activeProviderId = React.useMemo(
    () => providers.find(provider => provider.isActive)?.providerId,
    [providers],
  )
  const options = React.useMemo<OptionWithDescription<string>[]>(
    () =>
      providers.map(provider => ({
        value: provider.providerId,
        label: provider.label,
        description: provider.isActive ? 'Currently active' : 'Connected provider',
        dimDescription: true,
      })),
    [providers],
  )
  const [step, setStep] = React.useState<DisconnectStep>(() =>
    providers.length === 0 ? { type: 'empty' } : { type: 'select-provider' },
  )

  const handleCancel = React.useCallback(() => {
    onDone(undefined, { display: 'skip' })
  }, [onDone])

  const handleSelect = React.useCallback(
    (providerId: string) => {
      const provider = providers.find(item => item.providerId === providerId)
      if (!provider) {
        setStep({
          type: 'error',
          error: `Provider not found: ${providerId}`,
        })
        return
      }

      const remainingProviders = providers.filter(
        item => item.providerId !== providerId,
      )

      setStep({
        type: 'confirm',
        provider,
        nextActiveProviderLabel: provider.isActive
          ? remainingProviders[0]?.label
          : undefined,
      })
    },
    [providers],
  )

  const handleConfirm = React.useCallback(() => {
    if (step.type !== 'confirm') {
      return
    }

    try {
      let removed = false
      let hasRemainingProviders = true
      let shouldClearModelSelection = false
      saveGlobalConfig(current => {
        const connectedProviders = current.connectedProviders ?? {}
        if (!(step.provider.providerId in connectedProviders)) {
          return current
        }

        removed = true
        const { [step.provider.providerId]: _removed, ...rest } = connectedProviders
        const remainingProviderIds = Object.keys(rest)
        hasRemainingProviders = remainingProviderIds.length > 0
        const currentModel = getUserSpecifiedModelSetting()
        shouldClearModelSelection =
          !hasRemainingProviders ||
          current.activeProvider === step.provider.providerId ||
          isModelOwnedByProvider(
            currentModel,
            step.provider.providerId,
            step.provider.info,
          )

        let anthropicCustomModelsCaches = current.anthropicCustomModelsCaches
        if (
          isCustomAnthropicProviderId(step.provider.providerId) &&
          current.anthropicCustomModelsCaches
        ) {
          const {
            [step.provider.providerId]: _removedCache,
            ...remainingCaches
          } = current.anthropicCustomModelsCaches
          anthropicCustomModelsCaches =
            Object.keys(remainingCaches).length > 0
              ? remainingCaches
              : undefined
        }

        let openaiCustomModelsCaches = current.openaiCustomModelsCaches
        if (
          isCustomOpenAIProviderId(step.provider.providerId) &&
          current.openaiCustomModelsCaches
        ) {
          const {
            [step.provider.providerId]: _removedOpenAICache,
            ...remainingOpenAICaches
          } = current.openaiCustomModelsCaches
          openaiCustomModelsCaches =
            Object.keys(remainingOpenAICaches).length > 0
              ? remainingOpenAICaches
              : undefined
        }

        return {
          ...current,
          connectedProviders:
            remainingProviderIds.length > 0 ? rest : undefined,
          activeProvider:
            current.activeProvider === step.provider.providerId
              ? remainingProviderIds[0]
              : current.activeProvider,
          ...(step.provider.providerId === 'github-copilot'
            ? { copilotModelsCache: undefined }
            : {}),
          ...(step.provider.providerId === 'openrouter'
            ? { openrouterModelsCache: undefined }
            : {}),
          ...(isCustomOpenAIProviderId(step.provider.providerId)
            ? {
                openaiCustomModelsCaches,
                ...(step.provider.providerId === CUSTOM_OPENAI_PROVIDER_ID
                  ? { openaiCustomModelsCache: undefined }
                  : {}),
              }
            : {}),
          ...(isCustomAnthropicProviderId(step.provider.providerId)
            ? {
                anthropicCustomModelsCaches,
                ...(step.provider.providerId === CUSTOM_ANTHROPIC_PROVIDER_ID
                  ? { anthropicCustomModelsCache: undefined }
                  : {}),
              }
            : {}),
        }
      })

      if (!removed) {
        setStep({
          type: 'error',
          error: `${step.provider.label} is no longer connected.`,
        })
        return
      }

      if (shouldClearModelSelection) {
        clearUserSpecifiedModelSetting()
        context.setAppState(prev => ({
          ...prev,
          mainLoopModel: null,
          mainLoopModelForSession: null,
        }))
      }

      if (!hasRemainingProviders) {
        setStep({ type: 're-login' })
        return
      }

      setStep({
        type: 'success',
        providerLabel: step.provider.label,
      })
    } catch (error) {
      setStep({
        type: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Failed to disconnect provider',
      })
    }
  }, [context, step])

  const handleReloginDone = React.useCallback(
    async (success: boolean) => {
      context.onChangeAPIKey()
      // Signature-bearing blocks are bound to the API key.
      context.setMessages(stripSignatureBlocks)

      if (success) {
        resetCostState()
        void refreshRemoteManagedSettings()
        void refreshPolicyLimits()
        resetUserCache()
        refreshGrowthBookAfterAuthChange()
        clearTrustedDeviceToken()
        void enrollTrustedDevice()
        resetBypassPermissionsCheck()

        const appState = context.getAppState()
        void checkAndDisableBypassPermissionsIfNeeded(
          appState.toolPermissionContext,
          context.setAppState,
        )

        if (feature('TRANSCRIPT_CLASSIFIER')) {
          resetAutoModeGateCheck()
          void checkAndDisableAutoModeIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
            appState.fastMode,
          )
        }

        context.setAppState(prev => ({
          ...prev,
          authVersion: prev.authVersion + 1,
        }))

        onDone('Provider reconnected successfully')
        return
      }

      onDone(undefined, { display: 'skip' })
    },
    [context, onDone],
  )

  const handleSuccessClose = React.useCallback(() => {
    if (step.type !== 'success') {
      return
    }

    onDone(`${step.providerLabel} disconnected successfully`)
  }, [onDone, step])

  const handleErrorClose = React.useCallback(() => {
    if (providers.length === 0) {
      onDone(undefined, { display: 'skip' })
      return
    }

    setStep({ type: 'select-provider' })
  }, [onDone, providers.length])

  if (step.type === 'empty') {
    return (
      <Dialog title="Disconnect Provider" onCancel={handleCancel}>
        <EmptyState onClose={handleCancel} />
      </Dialog>
    )
  }

  if (step.type === 'select-provider') {
    return (
      <Dialog title="Disconnect Provider" onCancel={handleCancel}>
        <Select
          options={options}
          onChange={handleSelect}
          visibleOptionCount={options.length}
          defaultFocusValue={activeProviderId}
          layout="compact-vertical"
        />
      </Dialog>
    )
  }

  if (step.type === 'confirm') {
    return (
      <Dialog title="Confirm Disconnect" onCancel={handleCancel}>
        <ConfirmDialog
          provider={step.provider}
          nextActiveProviderLabel={step.nextActiveProviderLabel}
          onConfirm={handleConfirm}
          onCancel={() => setStep({ type: 'select-provider' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'success') {
    return (
      <Dialog title="Provider Disconnected" onCancel={handleSuccessClose}>
        <ResultDialog
          message={`${step.providerLabel} has been disconnected.`}
          onClose={handleSuccessClose}
        />
      </Dialog>
    )
  }

  if (step.type === 're-login') {
    return (
      <Login
        startingMessage="All providers disconnected. Please connect a new provider."
        onDone={handleReloginDone}
      />
    )
  }

  if (step.type === 'error') {
    return (
      <Dialog title="Error" onCancel={handleErrorClose}>
        <ResultDialog message={step.error} onClose={handleErrorClose} />
      </Dialog>
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <DisconnectDialog onDone={onDone} context={context} />
}

export default call
