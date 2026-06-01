/**
 * Probe: feed MiMo's real SSE stream through convertOpenAIStreamToAnthropic and
 * inspect the emitted Anthropic events for usage. Run: npx bun test-mimo-stream.ts
 */
import { convertOpenAIStreamToAnthropic } from './src/services/api/copilotClient.ts'

async function run(name: string, lines: string[]) {
  const sse = [...lines, ''].join('\n\n')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse))
      controller.close()
    },
  })
  let onUsageCalled: unknown = null
  const out = convertOpenAIStreamToAnthropic(body, 'mimo-v2.5-pro', u => {
    onUsageCalled = u
  })
  const reader = out.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  let stop: string | undefined
  let finalUsage: unknown
  let stops = 0
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const ev = JSON.parse(line.slice(5).trim())
      if (ev.type === 'message_delta') {
        stop = ev.delta?.stop_reason
        finalUsage = ev.usage
      }
      if (ev.type === 'content_block_stop') stops++
    } catch { /* ignore */ }
  }
  console.log(`\n[${name}]`)
  console.log('  stop_reason:', stop, '| content_block_stop count:', stops)
  console.log('  final usage:', JSON.stringify(finalUsage))
  console.log('  onUsage:', JSON.stringify(onUsageCalled))
}

// 1) MiMo: usage in a trailing chunk AFTER finish_reason (the reported bug)
await run('MiMo trailing usage', [
  `data: {"choices":[{"delta":{"content":"Hi","role":"assistant"},"finish_reason":null,"index":0}],"usage":null}`,
  `data: {"choices":[{"delta":{"content":null},"finish_reason":"stop","index":0}],"usage":null}`,
  `data: {"choices":[],"usage":{"completion_tokens":19,"prompt_tokens":256,"total_tokens":275,"prompt_tokens_details":{"cached_tokens":192}}}`,
  `data: [DONE]`,
])

// 2) DeepSeek-style: usage in the SAME chunk as finish_reason (must still work)
await run('usage in finish chunk', [
  `data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null,"index":0}],"usage":null}`,
  `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"completion_tokens":5,"prompt_tokens":100,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}`,
  `data: [DONE]`,
])

// 3) Tool call then trailing usage (verify tool_use stop_reason + blocks close)
await run('tool call + trailing usage', [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{}"}}]},"finish_reason":null,"index":0}],"usage":null}`,
  `data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":null}`,
  `data: {"choices":[],"usage":{"completion_tokens":7,"prompt_tokens":50,"prompt_tokens_details":{"cached_tokens":0}}}`,
  `data: [DONE]`,
])

// 4) No [DONE], stream just ends after trailing usage chunk
await run('no DONE, stream end', [
  `data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null,"index":0}],"usage":null}`,
  `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":null}`,
  `data: {"choices":[],"usage":{"completion_tokens":3,"prompt_tokens":40,"prompt_tokens_details":{"cached_tokens":10}}}`,
])
