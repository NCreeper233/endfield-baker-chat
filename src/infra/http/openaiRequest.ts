// openaiRequest —— 构造 OpenAI 兼容的 /chat/completions 请求
// 只构造、不发请求、不校验配置（报错文案因调用方而异）。

import type { ApiConfig } from '../../stores/settings'
import { LEGACY_API_BASE_URL, LEGACY_API_MODEL } from '../../constants/api'
import { isStreamOptionsUnsupported } from '../../utils/usage'
import { fetchLegacyApiKey } from './legacyKey'

export type LlmRole = 'system' | 'user' | 'assistant'

export type LlmContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

export interface LlmMessage {
  role: LlmRole
  content: LlmContent
}

/** o1 / o3 / o4 等 reasoning 模型：**不支持 temperature**，发其他值会 400（gpt-5 支持） */
export function isOReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return /^o[1-9](-|$)/.test(m)
}

/** reasoning 系列只认 max_completion_tokens，gpt-4 及更早只认 max_tokens */
export function usesMaxCompletionTokens(model: string): boolean {
  const m = model.trim().toLowerCase()
  return /^gpt-5/i.test(m) || isOReasoningModel(m)
}

export interface ChatRequestOptions {
  config: ApiConfig
  messages: LlmMessage[]
  maxTokens: number
  temperature?: number
  stream: boolean
  /** custom 模式透传思考开关；undefined = 不带该字段 */
  think?: boolean
  includeUsage?: boolean
}

export interface ChatRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /** 实际使用的模型名（legacy 模式为内置模型） */
  model: string
}

export async function buildChatRequest(opts: ChatRequestOptions): Promise<ChatRequest> {
  const { config, messages } = opts
  const isLegacy = config.apiMode === 'legacy'

  const url = isLegacy
    ? `${LEGACY_API_BASE_URL}/chat/completions`
    : `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isLegacy) {
    headers['Authorization'] = `Bearer ${await fetchLegacyApiKey()}`
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const model = isLegacy ? LEGACY_API_MODEL : config.model
  const completionParam = usesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens'

  const body: Record<string, unknown> = {
    model,
    messages,
    [completionParam]: opts.maxTokens,
    stream: opts.stream,
  }

  if (opts.temperature !== undefined && !isOReasoningModel(model)) {
    body.temperature = opts.temperature
  }

  // 与 utils/customApi 的 applyThinkMode 保持同一约定：vLLM / SGLang / Qwen 系
  // 认 chat_template_kwargs.enable_thinking，其余服务商一般忽略未知字段。
  // legacy 端点不在该协议内，刻意不发。
  if (!isLegacy && opts.think !== undefined && opts.think) {
    body.chat_template_kwargs = { enable_thinking: true }
  }

  // 不支持该参数的端点直接不发，省掉一次注定失败的往返。
  // 能力记忆按**解析后的完整 URL** 记账：legacy 模式 baseUrl 是空串，
  // 按 baseUrl 记会写不进记忆，每次都白跑一轮重试。
  if (opts.includeUsage && !isStreamOptionsUnsupported(url)) {
    body.stream_options = { include_usage: true }
  }

  return { url, headers, body, model }
}

/** 组装 LLM 消息：system 提示词在前，历史按 other→assistant / mine→user 映射 */
export function buildMessages(
  systemPrompt: string,
  characterPrompt: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
): LlmMessage[] {
  const messages: LlmMessage[] = []

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  if (characterPrompt) {
    messages.push({ role: 'system', content: characterPrompt })
  }

  for (const msg of history) {
    const role = msg.side === 'mine' ? 'user' : 'assistant'
    if (msg.image) {
      // 文字部分不能为空：裸图片会让模型进入「描述图片」模式，忽略人设
      const content: LlmContent = [
        { type: 'text', text: msg.text || '[图片]' },
        { type: 'image_url', image_url: { url: msg.image } },
      ]
      messages.push({ role, content })
    } else {
      messages.push({ role, content: msg.text })
    }
  }

  return messages
}
