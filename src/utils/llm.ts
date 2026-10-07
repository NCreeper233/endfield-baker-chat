// =============================================================================
// LLM API 调用层(llm.ts)
// -----------------------------------------------------------------------------
// OpenAI 兼容 API 的流式调用工具
//   - 支持 SSE(Stream)逐 token 返回
//   - 支持中止(AbortController)
//   - 纯函数,不依赖 Vue 响应式
// =============================================================================

import type { ApiConfig } from '../stores/settings'
import { LEGACY_API_BASE_URL, LEGACY_API_MODEL } from '../stores/settings'
import {
  isStreamOptionsUnsupported,
  looksLikeStreamOptionsError,
  markStreamOptionsUnsupported,
  normalizeUsage,
} from './usage'
import type { NormalizedUsage } from './usage'

// ---- Legacy API Key 运行时获取(不再硬编码到前端源码) ------------------------
let _cachedLegacyKey = ''
let _fetchingLegacyKey: Promise<string> | null = null

/**
 * 获取 Legacy 模式的内置 API Key
 *
 * 首次调用时从 /api/legacy-key 拉取并缓存(服务端从环境变量读取)。
 * 后续调用直接返回缓存值,不重复请求。
 * 同时供 settings.ts 的智能总结模块使用。
 */
export async function fetchLegacyApiKey(): Promise<string> {
  if (_cachedLegacyKey) return _cachedLegacyKey
  if (_fetchingLegacyKey) return _fetchingLegacyKey

  _fetchingLegacyKey = fetch('/api/legacy-key', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d: unknown) => {
      const key = (d as { apiKey?: string })?.apiKey || ''
      if (!key) throw new Error('Legacy API Key 未配置')
      _cachedLegacyKey = key
      return key
    })
    .catch((err) => {
      _fetchingLegacyKey = null
      throw new Error(`获取 Legacy API Key 失败: ${err instanceof Error ? err.message : String(err)}`)
    })

  return _fetchingLegacyKey
}

/** LLM 消息角色 */
type LlmRole = 'system' | 'user' | 'assistant'

/** LLM 消息内容:纯文本或多模态内容数组(含图片) */
type LlmContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

/** LLM 消息结构(OpenAI 格式) */
interface LlmMessage {
  role: LlmRole
  content: LlmContent
}

/** 流式回调:每收到一个文本片段时调用 */
type OnChunk = (text: string) => void

/** 流式完成回调 */
type OnDone = (fullText: string) => void

/** 错误回调 */
type OnError = (error: Error) => void

/** 流式聊天请求参数 */
interface StreamChatParams {
  /** API 配置 */
  config: ApiConfig
  /** 消息列表(含 system / user / assistant) */
  messages: LlmMessage[]
  /** 文本片段回调 */
  onChunk: OnChunk
  /** 完成回调 */
  onDone?: OnDone
  /** 错误回调 */
  onError?: OnError
  /** AbortController(外部传入以便中止) */
  signal?: AbortSignal
  /**
   * 用量回调(可选)
   *
   * 流式响应中 usage 位于最后一个数据块(choices 为空),通常在 [DONE] 之前到达;
   * 服务商未上报时不调用(调用方回退本地估算)。
   */
  onUsage?: (usage: NormalizedUsage) => void
  /**
   * 是否请求流式 usage(默认 true)
   *
   * 开启时会发送 stream_options.include_usage;不支持该参数的端点会自动降级重试,
   * 并记住该端点后续不再发送(见 utils/usage.ts)。
   */
  requestUsage?: boolean
  /**
   * 思考模式开关(可选)
   *
   * 仅在 **custom 模式** 下生效:按 OpenAI 兼容生态的通用约定发送
   * `chat_template_kwargs: { enable_thinking: <bool> }`
   * (vLLM / SGLang / Qwen 系自建端点识别该字段)。
   *
   * 为什么是"可选且 undefined 就不发":legacy 模式走内置 Agnes 端点,
   * 该字段不在其协议内;而其他调用方(如连接测试)也不该被这个开关影响。
   * 缺省 undefined = 请求体与改动前逐字一致。
   */
  think?: boolean
}

/**
 * 是否 OpenAI o 系列 reasoning 模型(o1 / o3 / o4 等)
 *
 * 该系列不支持 temperature 参数(只接受 1 或省略),发送其他值会 400。
 * gpt-5 系列不在其中:它支持 temperature,照常发送。
 */
export function isOReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return /^o[1-9](-|$)/.test(m)
}

/**
 * 是否应使用 max_completion_tokens 参数(而非 max_tokens)
 *
 * OpenAI 的 reasoning 系列模型(gpt-5 / o1 / o3 / o4 等)已不再接受
 * max_tokens,必须发送 max_completion_tokens;gpt-4 及更早模型仍使用
 * max_tokens。本判断只按模型名前缀识别,不影响其他 OpenAI 兼容服务商
 * (如 deepseek、glm 等,模型名不匹配即沿用 max_tokens)。
 */
export function usesMaxCompletionTokens(model: string): boolean {
  const m = model.trim().toLowerCase()
  return /^gpt-5/i.test(m) || isOReasoningModel(m)
}

/**
 * 流式聊天请求(SSE)
 *
 * 使用 fetch + ReadableStream 读取 SSE 数据,
 * 逐 token 调用 onChunk 回调,最终调用 onDone。
 *
 * @returns 完整文本(可通过 await 获取,也可仅用回调)
 */
export async function streamChat(params: StreamChatParams): Promise<string> {
  const { config, messages, onChunk, onDone, onError, signal, onUsage } = params

  // ---- 根据模式确定 URL / 请求头 / 模型名 ---------------------------------
  const isLegacy = config.apiMode === 'legacy'

  if (!isLegacy && (!config.baseUrl || !config.apiKey || !config.model)) {
    throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
  }

  // legacy 模式:直连 Agnes API(从服务端获取内置 API Key)
  // custom 模式:直接请求用户配置的 API(带 Authorization 头)
  const url = isLegacy
    ? `${LEGACY_API_BASE_URL}/chat/completions`
    : `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (!isLegacy) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  } else {
    // legacy 模式:从服务端获取内置 API Key(环境变量存储,不硬编码到前端)
    const legacyKey = await fetchLegacyApiKey()
    headers['Authorization'] = `Bearer ${legacyKey}`
  }

  const model = isLegacy ? LEGACY_API_MODEL : config.model

  // OpenAI reasoning 模型(gpt-5 / o1 系列)必须用 max_completion_tokens 参数
  const completionParam = usesMaxCompletionTokens(model)
    ? 'max_completion_tokens'
    : 'max_tokens'

  // o 系列 reasoning 模型(o1/o3/o4)不支持 temperature,直接省略该参数;
  // gpt-5 系列与 gpt-4 等老模型支持 temperature,照常发送
  const requestBody: Record<string, unknown> = {
    model,
    messages,
    [completionParam]: config.maxTokens,
    stream: true,
  }
  if (!isOReasoningModel(model)) {
    requestBody.temperature = config.temperature
  }

  // 思考模式(2026-10-04 新增):custom 模式下把"思考模式"开关透传给上游。
  // 约定与 utils/customApi.ts 的 applyThinkMode 一致 —— OpenAI 兼容生态里
  // 自建 / 第三方端点(vLLM、SGLang、Qwen 系)普遍识别
  // chat_template_kwargs.enable_thinking;不识别的服务商一般会忽略未知字段。
  // legacy 端点不在该协议内,刻意不发送(保持原行为)。
  if (!isLegacy && params.think !== undefined) {
    requestBody.chat_template_kwargs = { enable_thinking: !!params.think }
  }

  // 流式 usage:OpenAI 系需显式 include_usage 才会在最后一个数据块返回 usage。
  // 已确认不支持该参数的端点直接不发,省掉一次注定失败的往返。
  // 能力记忆按**解析后的完整 URL** 记账:legacy 模式的 baseUrl 为空串,
  // 若按 baseUrl 记账会写不进记忆,每次都白跑一轮失败重试。
  const wantUsage = params.requestUsage !== false && !isStreamOptionsUnsupported(url)
  if (wantUsage) {
    requestBody.stream_options = { include_usage: true }
  }

  try {
    /** 发起一次请求(便于在 stream_options 疑似被拒时原样重放) */
    const send = (bodyText: string): Promise<Response> =>
      fetch(url, { method: 'POST', headers, body: bodyText, signal })

    let bodyText = JSON.stringify(requestBody)
    let response: Response
    try {
      response = await send(bodyText)
    } catch (err) {
      // fetch 自身抛错 = 网络层失败,压根没拿到 HTTP 响应(不是 4xx/5xx)。
      // 另有一种由本应用引入的可能:我们主动加了 stream_options,若端点因这个
      // 未知参数返回**不带 CORS 头**的错误响应,浏览器会把它变成 TypeError,
      // 于是路径变成不透明的 "Failed to fetch"。
      // 因此再试一次(去掉该参数),但**只有这次成功**才判定"该端点不支持
      // stream_options"——否则绝不写记忆:免得把 CORS 问题误记成参数不支持,
      // 把用量统计永久关掉。
      if (!wantUsage || signal?.aborted === true || !(err instanceof TypeError)) throw err

      const withoutUsage = { ...requestBody }
      delete withoutUsage.stream_options
      const retry = await send(JSON.stringify(withoutUsage))
      if (!retry.ok) {
        // 去掉 stream_options 仍然失败 → 不是它的问题。
        // 此时重试拿到了真实 HTTP 响应,比原始那个不透明的 TypeError 有价值得多。
        const retryText = await retry.text().catch(() => retry.statusText)
        throw new Error(`API 请求失败 (${retry.status}): ${retryText}`)
      }
      markStreamOptionsUnsupported(url)
      response = retry
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
      // 自动降级:部分非官方端点直接拒绝未知参数 stream_options。
      // 去掉该参数重试一次,并记住该端点,后续请求不再发送。
      if (wantUsage && looksLikeStreamOptionsError(errText)) {
        markStreamOptionsUnsupported(url)
        delete requestBody.stream_options
        bodyText = JSON.stringify(requestBody)
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    // usage 用持有对象而非裸 let:赋值发生在闭包内,
    // 对象属性不受 TypeScript 控制流收窄影响。
    const usageHolder: { value: NormalizedUsage | null } = { value: null }

    /**
     * 处理一行 SSE data 负载
     * @returns true 表示收到 [DONE],流已结束
     */
    const handleData = (data: string): boolean => {
      if (data === '[DONE]') return true
      try {
        const json = JSON.parse(data)
        // usage 块通常 choices 为空,必须独立捕获(只看 delta.content 会漏掉)
        const usage = normalizeUsage(json.usage)
        if (usage) usageHolder.value = usage
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          fullText += delta
          onChunk(delta)
        }
      } catch {
        // 忽略解析错误的行(可能是不完整的 JSON)
      }
      return false
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 数据以 \n\n 分隔事件
      const lines = buffer.split('\n')
      // 保留最后不完整的行
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue // 空行或注释
        if (!trimmed.startsWith('data:')) continue

        if (handleData(trimmed.slice(5).trim())) {
          if (usageHolder.value) onUsage?.(usageHolder.value)
          onDone?.(fullText)
          return fullText
        }
      }
    }

    // 处理 buffer 中剩余的数据
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        handleData(trimmed.slice(5).trim())
      }
    }

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

/**
 * 构建聊天消息列表
 *
 * 将系统提示词 + 角色提示词 + 历史消息组合成 LLM 消息数组。
 * 角色提示词作为 system 消息的第一条，历史消息按 other→assistant / mine→user 映射。
 * 含图片的历史消息使用 content array 格式(OpenAI Vision API)。
 *
 * @param systemPrompt  全局系统提示词
 * @param characterPrompt 角色专属提示词
 * @param history       聊天历史(可含图片 dataURL)
 */
export function buildMessages(
  systemPrompt: string,
  characterPrompt: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
): LlmMessage[] {
  const messages: LlmMessage[] = []

  // 系统提示词
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }

  // 角色提示词
  if (characterPrompt) {
    messages.push({ role: 'system', content: characterPrompt })
  }

  // 历史消息
  for (const msg of history) {
    const role = msg.side === 'mine' ? 'user' : 'assistant'
    if (msg.image) {
      // 含图片:使用 content array 格式(vision API)
      // 文字部分不能为空:裸图片会让模型进入"描述模式"而忽略角色人设
      const textContent = msg.text || '[图片]'
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [
        { type: 'text', text: textContent },
        { type: 'image_url', image_url: { url: msg.image } },
      ]
      messages.push({ role, content })
    } else {
      messages.push({ role, content: msg.text })
    }
  }

  return messages
}

/**
 * 测试 API 连接
 *
 * 发送一条最小请求,仅检查 HTTP 状态码判断连接是否成功。
 * 使用 AbortController 在收到响应头后立即中止,不消耗额外 token。
 *
 * @param config API 配置(custom 或 legacy 模式)
 * @returns { ok, message } 测试结果
 */
export async function testApiConnection(
  config: ApiConfig,
): Promise<{ ok: boolean; message: string }> {
  const isLegacy = config.apiMode === 'legacy'

  if (!isLegacy && (!config.baseUrl || !config.apiKey || !config.model)) {
    return { ok: false, message: '请先填写 Base URL、API Key 和模型名' }
  }

  // legacy 模式:直连 Agnes API(从服务端获取内置 API Key)
  // custom 模式:直接请求用户配置的 API(带 Authorization 头)
  const url = isLegacy
    ? `${LEGACY_API_BASE_URL}/chat/completions`
    : `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (!isLegacy) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  } else {
    // legacy 模式:从服务端获取内置 API Key(环境变量存储,不硬编码到前端)
    const legacyKey = await fetchLegacyApiKey()
    headers['Authorization'] = `Bearer ${legacyKey}`
  }

  const model = isLegacy ? LEGACY_API_MODEL : config.model

  // OpenAI reasoning 模型(gpt-5 / o1 系列)必须用 max_completion_tokens 参数
  const completionParam = usesMaxCompletionTokens(model)
    ? 'max_completion_tokens'
    : 'max_tokens'

  // o 系列 reasoning 模型不支持 temperature,省略该参数
  const requestBody: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    [completionParam]: 5,
    stream: true,
  }
  if (!isOReasoningModel(model)) {
    requestBody.temperature = 0.8
  }

  const controller = new AbortController()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    // 收到响应头后立即中止,不读取 body
    controller.abort()

    if (response.ok) {
      return { ok: true, message: '连接成功' }
    }
    const errText = await response.text().catch(() => response.statusText)
    return { ok: false, message: `连接失败 (${response.status}): ${errText}` }
  } catch (err) {
    // AbortError 是我们主动中止,说明响应头已收到 = 连接成功
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: true, message: '连接成功' }
    }
    return { ok: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
