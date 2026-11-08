// llm —— OpenAI 兼容 API 的流式调用
// 请求构造与 SSE 读取都在 infra/http，这里只保留流式语义：增量回调、usage 采集、
// stream_options 降级重试、中止。纯函数，不依赖 Vue 响应式。

import type { ApiConfig } from '../stores/settings'
import {
  looksLikeStreamOptionsError,
  markStreamOptionsUnsupported,
  normalizeUsage,
} from './usage'
import type { NormalizedUsage } from './usage'
import { buildChatRequest } from '../infra/http/openaiRequest'
import type { LlmMessage } from '../infra/http/openaiRequest'
import { readSseLines } from '../infra/http/sse'

// 兼容既有的 import 路径
export { fetchLegacyApiKey } from '../infra/http/legacyKey'
export {
  buildMessages,
  isOReasoningModel,
  usesMaxCompletionTokens,
} from '../infra/http/openaiRequest'
export type { LlmContent, LlmMessage, LlmRole } from '../infra/http/openaiRequest'

type OnChunk = (text: string) => void
type OnDone = (fullText: string) => void
type OnError = (error: Error) => void

interface StreamChatParams {
  config: ApiConfig
  messages: LlmMessage[]
  onChunk: OnChunk
  onDone?: OnDone
  onError?: OnError
  /** 外部传入以便中止 */
  signal?: AbortSignal
  /** usage 在最后一个数据块（choices 为空），通常在 [DONE] 之前；未上报则不调用 */
  onUsage?: (usage: NormalizedUsage) => void
  /** 默认 true；不支持该参数的端点会自动降级重试并记住（见 utils/usage.ts） */
  requestUsage?: boolean
  /**
   * 仅在 custom 模式生效：按生态惯例发 `chat_template_kwargs.enable_thinking`
   * （vLLM / SGLang / Qwen 系识别）。undefined = 不发，请求体与此前逐字一致。
   */
  think?: boolean
}

/** 返回完整文本（也可只用回调） */
export async function streamChat(params: StreamChatParams): Promise<string> {
  const { config, messages, onChunk, onDone, onError, signal, onUsage } = params

  const isLegacy = config.apiMode === 'legacy'

  if (!isLegacy && (!config.baseUrl || !config.apiKey || !config.model)) {
    throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
  }

  // 刻意放在 try 之外：构造期失败（如 Legacy Key 拉取失败）若走 onError，
  // 调用方会与 onError 重复报告同一个错误。
  const request = await buildChatRequest({
    config,
    messages,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
    think: params.think,
    includeUsage: params.requestUsage !== false,
  })
  /** 决定「降级重试」是否有意义 */
  const hasStreamOptions = 'stream_options' in request.body

  try {
    const send = (bodyText: string): Promise<Response> =>
      fetch(request.url, { method: 'POST', headers: request.headers, body: bodyText, signal })

    let bodyText = JSON.stringify(request.body)
    let response: Response
    try {
      response = await send(bodyText)
    } catch (err) {
      // fetch 抛错说明没拿到 HTTP 响应。若端点因未知参数 stream_options 返回不带
      // CORS 头的错误，浏览器会把它变成不透明的 TypeError，故去掉参数再试一次。
      // 只有这次成功才记为「不支持」，否则会把 CORS 问题误记成参数不支持。
      if (!hasStreamOptions || signal?.aborted === true || !(err instanceof TypeError)) throw err

      const withoutUsage = { ...request.body }
      delete withoutUsage.stream_options
      const retry = await send(JSON.stringify(withoutUsage))
      if (!retry.ok) {
        // 去掉参数仍失败 → 不是它的问题；此时有真实状态码，比不透明的 TypeError 有用
        const retryText = await retry.text().catch(() => retry.statusText)
        throw new Error(`API 请求失败 (${retry.status}): ${retryText}`)
      }
      markStreamOptionsUnsupported(request.url)
      response = retry
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
      // 部分非官方端点直接拒绝未知参数：去掉重试一次并记住该端点
      if (hasStreamOptions && looksLikeStreamOptionsError(errText)) {
        markStreamOptionsUnsupported(request.url)
        delete request.body.stream_options
        bodyText = JSON.stringify(request.body)
        response = await send(bodyText)
        if (!response.ok) {
          const retryText = await response.text().catch(() => response.statusText)
          throw new Error(`API 请求失败 (${response.status}): ${retryText}`)
        }
      } else {
        throw new Error(`API 请求失败 (${response.status}): ${errText}`)
      }
    }

    if (!response.body) {
      throw new Error('API 响应无 body（不支持流式）')
    }

    let fullText = ''

    // 用对象持有而非裸 let：赋值在闭包内，属性不受 TS 控制流收窄影响
    const usageHolder: { value: NormalizedUsage | null } = { value: null }

    /** 返回 true 表示收到 [DONE] */
    const handleData = (data: string): boolean => {
      if (data === '[DONE]') return true
      try {
        const json = JSON.parse(data)
        // usage 块通常 choices 为空，只看 delta.content 会漏掉
        const usage = normalizeUsage(json.usage)
        if (usage) usageHolder.value = usage
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          onChunk(delta)
        }
      } catch {
        // 忽略不完整的 JSON 行
      }
      return false
    }

    await readSseLines(response.body, (line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) return false
      if (!trimmed.startsWith('data:')) return false
      return handleData(trimmed.slice(5).trim())
    })

    if (usageHolder.value) onUsage?.(usageHolder.value)
    onDone?.(fullText)
    return fullText
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // 用户主动中止，不算错误
      return ''
    }
    const error = err instanceof Error ? err : new Error(String(err))
    onError?.(error)
    throw error
  }
}

/** 发一条最小请求，只看 HTTP 状态码：收到响应头即中止，不消耗额外 token */
export async function testApiConnection(
  config: ApiConfig,
): Promise<{ ok: boolean; message: string }> {
  const isLegacy = config.apiMode === 'legacy'

  if (!isLegacy && (!config.baseUrl || !config.apiKey || !config.model)) {
    return { ok: false, message: '请先填写 Base URL、API Key 和模型名' }
  }

  const controller = new AbortController()

  try {
    // 与正式请求共用构造规则：测试能通过 = 正式请求的 URL / 头 / 参数也对
    const request = await buildChatRequest({
      config,
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 5,
      temperature: 0.8,
      stream: true,
    })

    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })

    controller.abort()

    if (response.ok) {
      return { ok: true, message: '连接成功' }
    }
    const errText = await response.text().catch(() => response.statusText)
    return { ok: false, message: `连接失败 (${response.status}): ${errText}` }
  } catch (err) {
    // 主动中止说明响应头已收到 = 连接成功
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: true, message: '连接成功' }
    }
    return { ok: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
