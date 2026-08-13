// =============================================================================
// LLM API 调用层(llm.ts)
// -----------------------------------------------------------------------------
// OpenAI 兼容 API 的流式调用工具
//   - 支持 SSE(Stream)逐 token 返回
//   - 支持中止(AbortController)
//   - 纯函数,不依赖 Vue 响应式
// =============================================================================

import type { ApiConfig } from '../stores/settings'
import { SHARED_API_BASE_URL, SHARED_API_MODEL } from '../stores/settings'

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
  const { config, messages, onChunk, onDone, onError, signal } = params

  // ---- 根据模式确定 URL / 请求头 / 模型名 ---------------------------------
  const isShared = config.apiMode === 'shared'

  if (!isShared && (!config.baseUrl || !config.apiKey || !config.model)) {
    throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
  }

  // shared 模式:请求 Vercel Serverless 代理(相对路径,无需密钥)
  // custom 模式:直接请求用户配置的 API(带 Authorization 头)
  const url = isShared
    ? SHARED_API_BASE_URL
    : `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (!isShared) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const model = isShared ? SHARED_API_MODEL : config.model

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
      }),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
      throw new Error(`API 请求失败 (${response.status}): ${errText}`)
    }

    if (!response.body) {
      throw new Error('API 响应无 body（不支持流式）')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

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

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          onDone?.(fullText)
          return fullText
        }

        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            fullText += delta
            onChunk(delta)
          }
        } catch {
          // 忽略解析错误的行(可能是不完整的 JSON)
        }
      }
    }

    // 处理 buffer 中剩余的数据
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim()
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data)
            const delta = json.choices?.[0]?.delta?.content
            if (delta) {
              fullText += delta
              onChunk(delta)
            }
          } catch {
            // 忽略
          }
        }
      }
    }

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
 * @param config API 配置(shared 或 custom 模式)
 * @returns { ok, message } 测试结果
 */
export async function testApiConnection(
  config: ApiConfig,
): Promise<{ ok: boolean; message: string }> {
  const isShared = config.apiMode === 'shared'

  if (!isShared && (!config.baseUrl || !config.apiKey || !config.model)) {
    return { ok: false, message: '请先填写 Base URL、API Key 和模型名' }
  }

  const url = isShared
    ? SHARED_API_BASE_URL
    : `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (!isShared) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const model = isShared ? SHARED_API_MODEL : config.model

  const controller = new AbortController()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        temperature: 0.8,
        stream: true,
      }),
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
