import { feature } from 'bun:bundle'
import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { Select, OptionWithDescription } from '../../components/CustomSelect/index.js'
import { fetchCopilotModels } from '../../services/api/copilotClient.js'
import {
  fetchOpenAICompatibleModelIds,
  fetchAnthropicCompatibleModelIds,
  fetchOpenRouterAnthropicModelIds,
} from '../../services/api/customOpenAIClient.js'
import { Spinner } from '../../components/Spinner.js'
import { SearchableModelSelect } from '../../components/SearchableModelSelect.js'
import {
  getCustomAnthropicProviderLabel,
  isCustomAnthropicProviderId,
  resolveCustomAnthropicProviderId,
} from '../../utils/customAnthropicProviders.js'

const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const COPILOT_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

const PROVIDERS: OptionWithDescription<string>[] = [
  {
    value: 'custom-anthropic',
    label: 'Custom Anthropic-compatible API',
    hint: 'Self-hosted or LAN · base URL + optional key · pick model from /v1/models',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter Anthropic-compatible API',
    hint: 'Unified API for multiple models',
  },
]

const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'

const PROVIDER_CONFIG: Record<string, { name: string; apiKeyUrl: string; keyPlaceholder: string }> = {
  'kimi-for-coding': {
    name: 'Kimi For Coding',
    apiKeyUrl: 'https://platform.moonshot.cn/',
    keyPlaceholder: 'sk-...',
  },
  openrouter: {
    name: 'OpenRouter Anthropic-compatible API',
    apiKeyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-...',
  },
}

type ConnectStep =
  | { type: 'select-provider' }
  | { type: 'enter-api-key'; providerId: string }
  | { type: 'confirm'; providerId: string; apiKey: string }
  | { type: 'success'; providerId: string }
  | { type: 'error'; error: string }
  | { type: 'copilot-oauth'; userCode: string; verificationUri: string; deviceCode: string; interval: number }
  | { type: 'copilot-polling'; userCode: string; verificationUri: string; deviceCode: string; interval: number }
  | {
      type: 'openrouter'
      step: 'key' | 'fetching' | 'models-fetch-error' | 'manual-models' | 'select'
      apiKey?: string
      models?: string[]
      fetchError?: string
    }
  | {
      type: 'custom-openai'
      step: 'base' | 'key' | 'fetching' | 'models-fetch-error' | 'manual-models' | 'select'
      baseUrl?: string
      apiKey?: string
      models?: string[]
      fetchError?: string
    }
  | {
      type: 'custom-anthropic'
      step: 'base' | 'key' | 'fetching' | 'models-fetch-error' | 'manual-models' | 'select'
      baseUrl?: string
      apiKey?: string
      models?: string[]
      fetchError?: string
    }

function ApiKeyInput({
  providerId,
  onSubmit,
  onCancel,
}: {
  providerId: string
  onSubmit: (apiKey: string) => void
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const provider = PROVIDER_CONFIG[providerId]

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      if (apiKey.trim()) {
        onSubmit(apiKey.trim())
      }
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = apiKey.slice(0, cursorOffset - 1) + apiKey.slice(cursorOffset)
        setApiKey(newValue)
        setCursorOffset(cursorOffset - 1)
      }
      return
    }
    if (input) {
      const newValue = apiKey.slice(0, cursorOffset) + input + apiKey.slice(cursorOffset)
      setApiKey(newValue)
      setCursorOffset(cursorOffset + input.length)
    }
  })

  const displayValue = apiKey ? '*'.repeat(apiKey.length) : ''
  const cursorChar = cursorOffset < displayValue.length ? displayValue[cursorOffset] : ' '
  const beforeCursor = displayValue.slice(0, cursorOffset)
  const afterCursor = displayValue.slice(cursorOffset + 1)

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{provider.name}</Text>
      <Text dimColor>
        Get your API key from:{' '}
        <Text color="cyan" underline>
          {provider.apiKeyUrl}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>API Key:</Text>
        <Box>
          <Text>{beforeCursor}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{afterCursor}</Text>
        </Box>
      </Box>
      <Text dimColor>Press Enter to continue, Esc to cancel</Text>
    </Box>
  )
}

function ConfirmDialog({
  providerId,
  apiKey,
  onConfirm,
  onCancel,
}: {
  providerId: string
  apiKey: string
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
      return
    }
  })

  const provider = PROVIDER_CONFIG[providerId]
  const maskedKey = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        Connect to <Text bold>{provider.name}</Text>?
      </Text>
      <Text dimColor>
        API Key: <Text color="yellow">{maskedKey}</Text>
      </Text>
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text color="green" bold>
          [Enter] Connect
        </Text>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  )
}

function CopilotOAuthDialog({
  userCode,
  verificationUri,
  onPollingStart,
  onCancel,
}: {
  userCode: string
  verificationUri: string
  onPollingStart: () => void
  onCancel: () => void
}) {
  React.useEffect(() => {
    const timer = setTimeout(() => {
      onPollingStart()
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">GitHub Copilot Authorization</Text>
      <Text>
        1. Open: <Text color="cyan" underline>{verificationUri}</Text>
      </Text>
      <Text>
        2. Enter code: <Text bold color="yellow">{userCode}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Waiting for authorization... (Press Esc to cancel)</Text>
      </Box>
    </Box>
  )
}

function CopilotPollingDialog({
  userCode,
  verificationUri,
  deviceCode,
  interval,
  onSuccess,
  onError,
  onCancel,
}: {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  onSuccess: (token: string) => void
  onError: (error: string) => void
  onCancel: () => void
}) {
  const [status, setStatus] = React.useState('Waiting for authorization...')
  const cancelledRef = React.useRef(false)

  React.useEffect(() => {
    let stopped = false

    async function poll() {
      let currentInterval = interval
      while (!stopped && !cancelledRef.current) {
        await new Promise(resolve => setTimeout(resolve, currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
        if (stopped || cancelledRef.current) return

        try {
          const response = await fetch(COPILOT_ACCESS_TOKEN_URL, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              client_id: COPILOT_CLIENT_ID,
              device_code: deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
          })

          if (!response.ok) {
            onError('Failed to get access token')
            return
          }

          const data = await response.json() as {
            access_token?: string
            error?: string
            interval?: number
          }

          if (data.access_token) {
            onSuccess(data.access_token)
            return
          }

          if (data.error === 'authorization_pending') {
            setStatus('Waiting for authorization...')
            continue
          }

          if (data.error === 'slow_down') {
            currentInterval = (data.interval ?? currentInterval + 5)
            setStatus('Rate limited, slowing down...')
            continue
          }

          if (data.error === 'expired_token') {
            onError('Authorization expired, please try again')
            return
          }

          if (data.error === 'access_denied') {
            onError('Authorization was denied')
            return
          }

          if (data.error) {
            onError(`OAuth error: ${data.error}`)
            return
          }
        } catch (err) {
          onError(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
          return
        }
      }
    }

    void poll()

    return () => {
      stopped = true
    }
  }, [deviceCode, interval])

  useInput((_, key) => {
    if (key.escape) {
      cancelledRef.current = true
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">GitHub Copilot Authorization</Text>
      <Text>
        1. Open: <Text color="cyan" underline>{verificationUri}</Text>
      </Text>
      <Text>
        2. Enter code: <Text bold color="yellow">{userCode}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{status}</Text>
      </Box>
      <Text dimColor>Press Esc to cancel</Text>
    </Box>
  )
}

function SuccessDialog({
  providerId,
  onClose,
}: {
  providerId: string
  onClose: () => void
}) {
  useInput(() => {
    onClose()
  })

  const providerName =
    providerId === 'github-copilot'
      ? 'GitHub Copilot'
      : providerId === 'custom-openai'
        ? 'Custom OpenAI-compatible API'
        : isCustomAnthropicProviderId(providerId)
          ? getCustomAnthropicProviderLabel(
              providerId,
              getGlobalConfig().connectedProviders?.[providerId],
            )
          : PROVIDER_CONFIG[providerId]?.name ?? providerId

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">
        Successfully connected to <Text bold>{providerName}</Text>
      </Text>
      <Text dimColor>
        You can now use models from {providerName} with the /model command.
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    </Box>
  )
}

function ErrorDialog({ error, onClose }: { error: string; onClose: () => void }) {
  useInput(() => {
    onClose()
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Failed to connect provider:</Text>
      <Text>{error}</Text>
      <Box marginTop={1}>
        <Text dimColor>Press any key to go back</Text>
      </Box>
    </Box>
  )
}

function parseManualModelIds(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map(model => model.trim())
        .filter(Boolean),
    ),
  ]
}

function ModelsFetchErrorChoice({
  title,
  baseUrl,
  fetchError,
  onEditBaseUrl,
  onEditApiKey,
  onManualModels,
  onRetry,
  onCancel,
}: {
  title: string
  baseUrl?: string
  fetchError?: string
  onEditBaseUrl: () => void
  onEditApiKey: () => void
  onManualModels: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Base URL: {baseUrl || '(not set)'}</Text>
      {fetchError ? <Text color="red">{fetchError}</Text> : null}
      <Box flexDirection="column" gap={1}>
        <Text bold>{title} could not fetch models from GET /v1/models.</Text>
        <Text dimColor>
          First check whether the Base URL or API Key is wrong. If both are correct, this provider likely does not implement /v1/models.
        </Text>
      </Box>
      <Select
        options={[
          {
            label: <Text>Edit Base URL</Text>,
            value: 'base',
            hint: 'Use this if the endpoint path or host may be wrong',
          },
          {
            label: <Text>Re-enter API Key</Text>,
            value: 'key',
            hint: 'Use this if the server may require a different key',
          },
          {
            label: <Text>Retry /v1/models</Text>,
            value: 'retry',
            hint: 'Try the same Base URL and API Key again',
          },
          {
            label: <Text>Base URL and API Key are correct</Text>,
            value: 'manual',
            hint: 'Continue by entering supported model IDs manually',
          },
        ]}
        onChange={value => {
          if (value === 'base') {
            onEditBaseUrl()
            return
          }
          if (value === 'key') {
            onEditApiKey()
            return
          }
          if (value === 'retry') {
            onRetry()
            return
          }
          onManualModels()
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}

/** Single-line visible input (e.g. base URL). Empty Enter calls onEmptySubmit if set, else onCancel. */
function VisibleLineInput({
  title,
  hint,
  onSubmit,
  onCancel,
  onEmptySubmit,
}: {
  title: string
  hint: string
  onSubmit: (line: string) => void
  onCancel: () => void
  onEmptySubmit?: () => void
}) {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const v = value.trim()
      if (!v) {
        if (onEmptySubmit) {
          onEmptySubmit()
        } else {
          onCancel()
        }
        return
      }
      onSubmit(v)
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
        setValue(newValue)
        setCursorOffset(cursorOffset - 1)
      }
      return
    }
    if (input) {
      const newValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset)
      setValue(newValue)
      setCursorOffset(cursorOffset + input.length)
    }
  })

  const cursorChar = cursorOffset < value.length ? value[cursorOffset] : ' '
  const beforeCursor = value.slice(0, cursorOffset)
  const afterCursor = value.slice(cursorOffset + 1)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Value:</Text>
        <Box>
          <Text>{beforeCursor}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{afterCursor}</Text>
        </Box>
      </Box>
      <Text dimColor>[Enter] continue · empty [Enter] go back · [Esc] cancel</Text>
    </Box>
  )
}

/** Optional API key (masked). Empty Enter submits empty string. */
function OptionalMaskedKeyInput({
  title,
  hint,
  onSubmit,
  onCancel,
}: {
  title: string
  hint: string
  onSubmit: (apiKey: string) => void
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      onSubmit(apiKey.trim())
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = apiKey.slice(0, cursorOffset - 1) + apiKey.slice(cursorOffset)
        setApiKey(newValue)
        setCursorOffset(cursorOffset - 1)
      }
      return
    }
    if (input) {
      const newValue = apiKey.slice(0, cursorOffset) + input + apiKey.slice(cursorOffset)
      setApiKey(newValue)
      setCursorOffset(cursorOffset + input.length)
    }
  })

  const displayValue = apiKey ? '*'.repeat(apiKey.length) : ''
  const cursorChar = cursorOffset < displayValue.length ? displayValue[cursorOffset] : ' '
  const beforeCursor = displayValue.slice(0, cursorOffset)
  const afterCursor = displayValue.slice(cursorOffset + 1)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>API Key:</Text>
        <Box>
          <Text>{beforeCursor}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{afterCursor}</Text>
        </Box>
      </Box>
      <Text dimColor>[Enter] fetch models (empty = no key) · [Esc] cancel</Text>
    </Box>
  )
}

function ConnectDialog({
  onDone,
  onChangeAPIKey,
}: {
  onDone: LocalJSXCommandOnDone
  onChangeAPIKey: () => void
}) {
  const [step, setStep] = React.useState<ConnectStep>({ type: 'select-provider' })

  const handleProviderSelect = async (providerId: string) => {
    if (providerId === 'github-copilot') {
      try {
        const response = await fetch(COPILOT_DEVICE_CODE_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: COPILOT_CLIENT_ID,
            scope: 'read:user',
          }),
        })

        if (!response.ok) {
          setStep({ type: 'error', error: 'Failed to initiate GitHub device authorization' })
          return
        }

        const data = await response.json() as {
          verification_uri: string
          user_code: string
          device_code: string
          interval: number
        }

        setStep({
          type: 'copilot-oauth',
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          deviceCode: data.device_code,
          interval: data.interval,
        })
      } catch (err) {
        setStep({
          type: 'error',
          error: `Failed to connect: ${err instanceof Error ? err.message : 'unknown error'}`,
        })
      }
      return
    }

    if (providerId === 'custom-openai') {
      setStep({ type: 'custom-openai', step: 'base' })
      return
    }
    if (providerId === 'custom-anthropic') {
      setStep({ type: 'custom-anthropic', step: 'base' })
      return
    }
    if (providerId === 'openrouter') {
      setStep({ type: 'openrouter', step: 'key' })
      return
    }

    if (!PROVIDER_CONFIG[providerId]) {
      setStep({ type: 'error', error: `Unknown provider: ${providerId}` })
      return
    }
    setStep({ type: 'enter-api-key', providerId })
  }

  const handleApiKeySubmit = (apiKey: string) => {
    if (step.type !== 'enter-api-key') return
    setStep({ type: 'confirm', providerId: step.providerId, apiKey })
  }

  const handleConfirm = async () => {
    if (step.type !== 'confirm') return

    const { providerId, apiKey } = step

    try {
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          [providerId]: {
            apiKey,
            ...(providerId === 'openrouter'
              ? { baseUrl: OPENROUTER_ANTHROPIC_BASE_URL }
              : {}),
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || providerId,
      }))

      onChangeAPIKey()
      setStep({ type: 'success', providerId })
    } catch (error) {
      setStep({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  const handleCopilotSuccess = (token: string) => {
    try {
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          'github-copilot': {
            oauthToken: token,
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || 'github-copilot',
      }))

      onChangeAPIKey()
      // Pre-fetch and cache the model list in background
      fetchCopilotModels().then(models => {
        saveGlobalConfig(current => ({
          ...current,
          copilotModelsCache: { models, fetchedAt: Date.now() },
        }))
      }).catch(() => {})

      setStep({ type: 'success', providerId: 'github-copilot' })
    } catch (error) {
      setStep({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to save OAuth token',
      })
    }
  }

  const handleCancel = () => {
    onDone(undefined, { display: 'skip' })
  }

  const handleSuccessClose = () => {
    onDone('Provider connected successfully')
  }

  const handleErrorClose = () => {
    setStep({ type: 'select-provider' })
  }

  React.useEffect(() => {
    if (step.type !== 'openrouter' || step.step !== 'fetching') {
      return
    }
    const apiKey = step.apiKey
    if (!apiKey) {
      return
    }
    let cancelled = false
    void fetchOpenRouterAnthropicModelIds(apiKey).then(ids => {
      if (cancelled) {
        return
      }
      if (ids.length === 0) {
        setStep({
          type: 'openrouter',
          step: 'manual-models',
          apiKey,
          fetchError: 'No models returned from /v1/models. You can enter model IDs manually.',
        })
        return
      }
      setStep({
        type: 'openrouter',
        step: 'select',
        apiKey,
        models: ids,
      })
    }).catch(err => {
      if (cancelled) {
        return
      }
      setStep({
        type: 'openrouter',
        step: 'models-fetch-error',
        apiKey,
        fetchError: err instanceof Error ? err.message : 'Failed to fetch models',
      })
    })
    return () => {
      cancelled = true
    }
  }, [step])

  React.useEffect(() => {
    if (step.type !== 'custom-openai' || step.step !== 'fetching') {
      return
    }
    const baseUrl = step.baseUrl
    const apiKey = step.apiKey
    if (!baseUrl) {
      return
    }
    let cancelled = false
    void fetchOpenAICompatibleModelIds(baseUrl, apiKey).then(ids => {
      if (cancelled) {
        return
      }
      if (ids.length === 0) {
        setStep({
          type: 'custom-openai',
          step: 'manual-models',
          baseUrl,
          apiKey,
          fetchError: 'No models returned from /v1/models. You can enter model IDs manually.',
        })
        return
      }
      setStep({
        type: 'custom-openai',
        step: 'select',
        baseUrl,
        apiKey,
        models: ids,
      })
    }).catch(err => {
      if (cancelled) {
        return
      }
      setStep({
        type: 'custom-openai',
        step: 'models-fetch-error',
        baseUrl,
        apiKey,
        fetchError: err instanceof Error ? err.message : 'Failed to fetch models',
      })
    })
    return () => {
      cancelled = true
    }
  }, [step])

  React.useEffect(() => {
    if (step.type !== 'custom-anthropic' || step.step !== 'fetching') {
      return
    }
    const baseUrl = step.baseUrl
    const apiKey = step.apiKey
    if (!baseUrl) {
      return
    }
    let cancelled = false
    void fetchAnthropicCompatibleModelIds(baseUrl, apiKey).then(ids => {
      if (cancelled) {
        return
      }
      if (ids.length === 0) {
        setStep({
          type: 'custom-anthropic',
          step: 'manual-models',
          baseUrl,
          apiKey,
          fetchError: 'No models returned from /v1/models. You can enter model IDs manually.',
        })
        return
      }
      setStep({
        type: 'custom-anthropic',
        step: 'select',
        baseUrl,
        apiKey,
        models: ids,
      })
    }).catch(err => {
      if (cancelled) {
        return
      }
      setStep({
        type: 'custom-anthropic',
        step: 'models-fetch-error',
        baseUrl,
        apiKey,
        fetchError: err instanceof Error ? err.message : 'Failed to fetch models',
      })
    })
    return () => {
      cancelled = true
    }
  }, [step])

  if (step.type === 'select-provider') {
    return (
      <Dialog title="Connect a Provider" onCancel={handleCancel}>
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Select a provider to connect:</Text>
          <Select
            options={PROVIDERS}
            onChange={value => handleProviderSelect(value)}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (step.type === 'enter-api-key') {
    return (
      <Dialog title={`Connect ${PROVIDER_CONFIG[step.providerId].name}`} onCancel={handleCancel}>
        <ApiKeyInput
          providerId={step.providerId}
          onSubmit={handleApiKeySubmit}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'confirm') {
    return (
      <Dialog title="Confirm Connection" onCancel={handleCancel}>
        <ConfirmDialog
          providerId={step.providerId}
          apiKey={step.apiKey}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'copilot-oauth') {
    return (
      <Dialog title="GitHub Copilot" onCancel={handleCancel}>
        <CopilotOAuthDialog
          userCode={step.userCode}
          verificationUri={step.verificationUri}
          onPollingStart={() => {
            setStep({
              type: 'copilot-polling',
              userCode: step.userCode,
              verificationUri: step.verificationUri,
              deviceCode: step.deviceCode,
              interval: step.interval,
            })
          }}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'copilot-polling') {
    return (
      <Dialog title="GitHub Copilot" onCancel={handleCancel}>
        <CopilotPollingDialog
          userCode={step.userCode}
          verificationUri={step.verificationUri}
          deviceCode={step.deviceCode}
          interval={step.interval}
          onSuccess={handleCopilotSuccess}
          onError={(error) => setStep({ type: 'error', error })}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'openrouter') {
    if (step.step === 'key') {
      return (
        <Dialog title="OpenRouter Anthropic-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            {step.fetchError ? <Text color="red">{step.fetchError}</Text> : null}
            <OptionalMaskedKeyInput
              title="API Key"
              hint="Used for /v1/models and Messages."
              onSubmit={apiKey => {
                if (!apiKey) {
                  setStep({
                    type: 'openrouter',
                    step: 'key',
                    fetchError: 'API Key is required.',
                  })
                  return
                }
                setStep({
                  type: 'openrouter',
                  step: 'fetching',
                  apiKey,
                })
              }}
              onCancel={handleCancel}
            />
          </Box>
        </Dialog>
      )
    }
    if (step.step === 'fetching') {
      return (
        <Dialog title="OpenRouter Anthropic-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            <Box>
              <Spinner />
              <Text> Fetching models from GET /v1/models…</Text>
            </Box>
            <Text dimColor>Base URL: {OPENROUTER_ANTHROPIC_BASE_URL}</Text>
            <Text dimColor>[Esc] cancel</Text>
          </Box>
        </Dialog>
      )
    }
    if (step.step === 'models-fetch-error') {
      const st = step
      return (
        <Dialog title="OpenRouter Anthropic-compatible API" onCancel={handleCancel}>
          <ModelsFetchErrorChoice
            title="OpenRouter Anthropic-compatible API"
            baseUrl={OPENROUTER_ANTHROPIC_BASE_URL}
            fetchError={st.fetchError}
            onEditBaseUrl={() => {
              setStep({ type: 'openrouter', step: 'key', apiKey: st.apiKey })
            }}
            onEditApiKey={() => {
              setStep({ type: 'openrouter', step: 'key', apiKey: st.apiKey })
            }}
            onRetry={() => {
              setStep({
                type: 'openrouter',
                step: 'fetching',
                apiKey: st.apiKey,
              })
            }}
            onManualModels={() => {
              setStep({
                type: 'openrouter',
                step: 'manual-models',
                apiKey: st.apiKey,
                fetchError: 'Provider does not expose /v1/models. Enter supported model IDs manually.',
              })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'select' && step.models && step.models.length > 0) {
      const st = step
      return (
        <Dialog title="OpenRouter Anthropic-compatible API" onCancel={handleCancel}>
          <SearchableModelSelect
            providerLabel="Anthropic-compatible"
            baseUrl={OPENROUTER_ANTHROPIC_BASE_URL}
            models={st.models}
            onSelect={modelId => {
              saveGlobalConfig(current => ({
                ...current,
                connectedProviders: {
                  ...(current.connectedProviders || {}),
                  openrouter: {
                    apiKey: st.apiKey || '',
                    baseUrl: OPENROUTER_ANTHROPIC_BASE_URL,
                    defaultModel: modelId,
                    connectedAt: new Date().toISOString(),
                  },
                },
                activeProvider: 'openrouter',
                openrouterModelsCache: st.models.map(id => ({ id })),
              }))
              onChangeAPIKey()
              setStep({ type: 'success', providerId: 'openrouter' })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'manual-models') {
      const st = step
      return (
        <Dialog title="OpenRouter Anthropic-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            {st.fetchError ? <Text color="red">{st.fetchError}</Text> : null}
            <VisibleLineInput
              title="Model IDs"
              hint="Enter one or more model IDs separated by commas or spaces (e.g. anthropic/claude-sonnet-4)"
              onSubmit={line => {
                const models = parseManualModelIds(line)
                if (models.length === 0) {
                  setStep({
                    ...st,
                    fetchError: 'Enter at least one model ID.',
                  })
                  return
                }
                setStep({
                  type: 'openrouter',
                  step: 'select',
                  apiKey: st.apiKey,
                  models,
                })
              }}
              onCancel={handleCancel}
              onEmptySubmit={() => {
                setStep({
                  ...st,
                  fetchError: 'Enter at least one model ID.',
                })
              }}
            />
          </Box>
        </Dialog>
      )
    }
  }

  if (step.type === 'custom-openai') {
    if (step.step === 'base') {
      return (
        <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
          <VisibleLineInput
            title="Base URL"
            hint="Include /v1 if your server uses it (e.g. https://api.openai.com/v1 or http://localhost:11434/v1)"
            onSubmit={url => {
              setStep({ type: 'custom-openai', step: 'key', baseUrl: url })
            }}
            onCancel={handleCancel}
            onEmptySubmit={() => setStep({ type: 'select-provider' })}
          />
        </Dialog>
      )
    }
    if (step.step === 'fetching') {
      return (
        <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            <Box>
              <Spinner />
              <Text> Fetching models from GET /v1/models…</Text>
            </Box>
            <Text dimColor>[Esc] cancel</Text>
          </Box>
        </Dialog>
      )
    }
    if (step.step === 'models-fetch-error') {
      const st = step
      return (
        <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
          <ModelsFetchErrorChoice
            title="Custom OpenAI-compatible API"
            baseUrl={st.baseUrl}
            fetchError={st.fetchError}
            onEditBaseUrl={() => {
              setStep({ type: 'custom-openai', step: 'base' })
            }}
            onEditApiKey={() => {
              setStep({ type: 'custom-openai', step: 'key', baseUrl: st.baseUrl })
            }}
            onRetry={() => {
              setStep({
                type: 'custom-openai',
                step: 'fetching',
                baseUrl: st.baseUrl,
                apiKey: st.apiKey,
              })
            }}
            onManualModels={() => {
              setStep({
                type: 'custom-openai',
                step: 'manual-models',
                baseUrl: st.baseUrl,
                apiKey: st.apiKey,
                fetchError: 'Provider does not expose /v1/models. Enter supported model IDs manually.',
              })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'select' && step.models && step.models.length > 0) {
      const st = step
      return (
        <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
          <SearchableModelSelect
            providerLabel="OpenAI-compatible"
            baseUrl={st.baseUrl}
            models={st.models}
            onSelect={modelId => {
              saveGlobalConfig(current => ({
                ...current,
                connectedProviders: {
                  ...(current.connectedProviders || {}),
                  'custom-openai': {
                    baseUrl: st.baseUrl || '',
                    defaultModel: modelId,
                    ...(st.apiKey ? { apiKey: st.apiKey } : {}),
                    connectedAt: new Date().toISOString(),
                  },
                },
                activeProvider: 'custom-openai',
                openaiCustomModelsCache: st.models.map(id => ({ id })),
              }))
              onChangeAPIKey()
              setStep({ type: 'success', providerId: 'custom-openai' })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'manual-models') {
      const st = step
      return (
        <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            {st.fetchError ? <Text color="red">{st.fetchError}</Text> : null}
            <VisibleLineInput
              title="Model IDs"
              hint="Enter one or more model IDs separated by commas or spaces (e.g. gpt-4o-mini, qwen2.5-coder)"
              onSubmit={line => {
                const models = parseManualModelIds(line)
                if (models.length === 0) {
                  setStep({
                    ...st,
                    fetchError: 'Enter at least one model ID.',
                  })
                  return
                }
                setStep({
                  type: 'custom-openai',
                  step: 'select',
                  baseUrl: st.baseUrl,
                  apiKey: st.apiKey,
                  models,
                })
              }}
              onCancel={handleCancel}
              onEmptySubmit={() => {
                setStep({
                  ...st,
                  fetchError: 'Enter at least one model ID.',
                })
              }}
            />
          </Box>
        </Dialog>
      )
    }
    return (
      <Dialog title="Custom OpenAI-compatible API" onCancel={handleCancel}>
        <Box flexDirection="column" gap={1}>
          {step.fetchError ? <Text color="red">{step.fetchError}</Text> : null}
          <OptionalMaskedKeyInput
            title="API Key (optional)"
            hint="Used for /v1/models and chat. Leave empty for local / no-auth."
            onSubmit={apiKey => {
              setStep({
                type: 'custom-openai',
                step: 'fetching',
                baseUrl: step.baseUrl,
                apiKey: apiKey || undefined,
              })
            }}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (step.type === 'custom-anthropic') {
    if (step.step === 'base') {
      return (
        <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
          <VisibleLineInput
            title="Base URL"
            hint="Messages API root (e.g. https://api.anthropic.com or http://localhost:8080)"
            onSubmit={url => {
              setStep({ type: 'custom-anthropic', step: 'key', baseUrl: url })
            }}
            onCancel={handleCancel}
            onEmptySubmit={() => setStep({ type: 'select-provider' })}
          />
        </Dialog>
      )
    }
    if (step.step === 'fetching') {
      return (
        <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            <Box>
              <Spinner />
              <Text> Fetching models from GET /v1/models…</Text>
            </Box>
            <Text dimColor>[Esc] cancel</Text>
          </Box>
        </Dialog>
      )
    }
    if (step.step === 'models-fetch-error') {
      const st = step
      return (
        <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
          <ModelsFetchErrorChoice
            title="Custom Anthropic-compatible API"
            baseUrl={st.baseUrl}
            fetchError={st.fetchError}
            onEditBaseUrl={() => {
              setStep({ type: 'custom-anthropic', step: 'base' })
            }}
            onEditApiKey={() => {
              setStep({ type: 'custom-anthropic', step: 'key', baseUrl: st.baseUrl })
            }}
            onRetry={() => {
              setStep({
                type: 'custom-anthropic',
                step: 'fetching',
                baseUrl: st.baseUrl,
                apiKey: st.apiKey,
              })
            }}
            onManualModels={() => {
              setStep({
                type: 'custom-anthropic',
                step: 'manual-models',
                baseUrl: st.baseUrl,
                apiKey: st.apiKey,
                fetchError: 'Provider does not expose /v1/models. Enter supported model IDs manually.',
              })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'select' && step.models && step.models.length > 0) {
      const st = step
      return (
        <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
          <SearchableModelSelect
            providerLabel="Anthropic-compatible"
            baseUrl={st.baseUrl}
            models={st.models}
            onSelect={modelId => {
              saveGlobalConfig(current => ({
                ...current,
                ...(() => {
                  const providerId = resolveCustomAnthropicProviderId(
                    current,
                    st.baseUrl || '',
                  )
                  return {
                    connectedProviders: {
                      ...(current.connectedProviders || {}),
                      [providerId]: {
                        baseUrl: st.baseUrl || '',
                        defaultModel: modelId,
                        ...(st.apiKey ? { apiKey: st.apiKey } : {}),
                        connectedAt: new Date().toISOString(),
                      },
                    },
                    activeProvider: providerId,
                    anthropicCustomModelsCaches: {
                      ...(current.anthropicCustomModelsCaches || {}),
                      [providerId]: st.models.map(id => ({ id })),
                    },
                    ...(providerId === 'custom-anthropic'
                      ? {
                          anthropicCustomModelsCache: st.models.map(id => ({
                            id,
                          })),
                        }
                      : {}),
                  }
                })(),
              }))
              onChangeAPIKey()
              const providerId = resolveCustomAnthropicProviderId(
                getGlobalConfig(),
                st.baseUrl || '',
              )
              setStep({
                type: 'success',
                providerId,
              })
            }}
            onCancel={handleCancel}
          />
        </Dialog>
      )
    }
    if (step.step === 'manual-models') {
      const st = step
      return (
        <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
          <Box flexDirection="column" gap={1}>
            {st.fetchError ? <Text color="red">{st.fetchError}</Text> : null}
            <VisibleLineInput
              title="Model IDs"
              hint="Enter one or more model IDs separated by commas or spaces (e.g. claude-sonnet-4-6, my-local-model)"
              onSubmit={line => {
                const models = parseManualModelIds(line)
                if (models.length === 0) {
                  setStep({
                    ...st,
                    fetchError: 'Enter at least one model ID.',
                  })
                  return
                }
                setStep({
                  type: 'custom-anthropic',
                  step: 'select',
                  baseUrl: st.baseUrl,
                  apiKey: st.apiKey,
                  models,
                })
              }}
              onCancel={handleCancel}
              onEmptySubmit={() => {
                setStep({
                  ...st,
                  fetchError: 'Enter at least one model ID.',
                })
              }}
            />
          </Box>
        </Dialog>
      )
    }
    return (
      <Dialog title="Custom Anthropic-compatible API" onCancel={handleCancel}>
        <Box flexDirection="column" gap={1}>
          {step.fetchError ? <Text color="red">{step.fetchError}</Text> : null}
          <OptionalMaskedKeyInput
            title="API Key (optional)"
            hint="Used for /v1/models and Messages. Leave empty for local / no-auth."
            onSubmit={apiKey => {
              setStep({
                type: 'custom-anthropic',
                step: 'fetching',
                baseUrl: step.baseUrl,
                apiKey: apiKey || undefined,
              })
            }}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (step.type === 'success') {
    return (
      <Dialog title="Success!" onCancel={handleSuccessClose}>
        <SuccessDialog providerId={step.providerId} onClose={handleSuccessClose} />
      </Dialog>
    )
  }

  if (step.type === 'error') {
    return (
      <Dialog title="Error" onCancel={handleErrorClose}>
        <ErrorDialog error={step.error} onClose={handleErrorClose} />
      </Dialog>
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <ConnectDialog
      onDone={onDone}
      onChangeAPIKey={context.onChangeAPIKey}
    />
  )
}

export default call
