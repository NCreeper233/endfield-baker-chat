// =============================================================================
// Google GenAI (Gemini) 原生 API 调用模块 (geminiApi.ts)
// -----------------------------------------------------------------------------
// 职责:
// 1. 直连 Google 原生 REST 端点 (v1beta/models/{model}:generateContent / streamGenerateContent)
// 2. 物理拔除安全过滤器: 显式注入全部 5 项 HARM_CATEGORY 为 BLOCK_NONE
// 3. 原生独立 systemInstruction 支持 (不与 user/model 混淆)
// 4. 适配原生 SSE 流式与标准非流式，支持多模态 base64 图片与用量解析
// =============================================================================

import type { NormalizedUsage } from './usage'
import type { ApiConfig } from '../stores/settings'

/** Google 官方安全过滤放行配置 (全部 5 项设为 BLOCK_NONE) */
export const GEMINI_SAFETY_SETTINGS_BLOCK_NONE = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]

export interface GeminiPartText {
  text: string
}

export interface GeminiPartInlineData {
  inlineData: {
    mimeType: string
    data: string
  }
}

export type GeminiPart = GeminiPartText | GeminiPartInlineData

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiStreamChatParams {
  config: ApiConfig
  systemInstruction?: string
  contents: GeminiContent[]
  signal?: AbortSignal
  temperature?: number
  topP?: number
  maxTokens?: number
  onChunk: (text: string) => void
  onDone?: (fullText: string) => void
  onUsage?: (usage: NormalizedUsage) => void
}

export interface GeminiChatResult {
  text: string
  usage?: NormalizedUsage
}

/** 规范化 Base URL */
function normalizeGeminiBaseUrl(rawBase?: string): string {
  let base = (rawBase || '').trim()
  if (!base) return 'https://generativelanguage.googleapis.com'
  base = base.replace(/\/+$/, '')
  // 如果用户填写的结尾带了 /v1beta，剥离以便统一组装
  if (base.endsWith('/v1beta')) {
    base = base.slice(0, -7)
  }
  return base
}

/** 规范化模型名 (移除多余 models/ 前缀) */
function normalizeGeminiModel(rawModel?: string): string {
  let m = (rawModel || '').trim()
  if (!m) return 'gemini-2.5-flash'
  if (m.startsWith('models/')) m = m.slice(7)
  return m
}

/**
 * 校验是否为合法的 Google Gemini API Key 格式 (同时兼容传统 AIzaSy 与新版 AQ 开头，放宽长度)
 */
export function isGeminiApiKey(key?: string): boolean {
  const trimmed = (key || '').trim()
  return /^(AIzaSy|AQ)[A-Za-z0-9_-]{20,}$/.test(trimmed)
}

/**
 * 判断是否应采用 Gemini 原生协议
 */
export function isGeminiProtocol(config: ApiConfig): boolean {
  // 1. 优先以用户显式选择的 Provider / Protocol 字段为准
  if (config.apiProtocol === 'gemini') return true
  if (config.apiProtocol === 'openai') return false

  // 2. 自动探测：Base URL 包含 googleapis 或模型名带有 gemini
  const url = (config.baseUrl || '').toLowerCase()
  const model = (config.model || '').toLowerCase()
  if (url.includes('googleapis.com') || url.includes('generativelanguage')) return true
  if (model.startsWith('gemini') || model.includes('gemini-')) return true

  // 3. API Key 特征探测：兼容传统 AIzaSy 与新版 AQ 开头，明确归入 Gemini 协议
  if (isGeminiApiKey(config.apiKey)) return true

  return false
}

/**
 * 将通用历史/消息结构转换为 Gemini 原生 contents
 */
export function convertToGeminiContents(
  history: Array<{ side?: 'other' | 'mine'; role?: string; text?: string; content?: string | any[]; image?: string }>,
): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const item of history) {
    // 判定角色: mine / user 为 user，other / assistant / model 为 model
    const isUser = item.side === 'mine' || item.role === 'user'
    const role: 'user' | 'model' = isUser ? 'user' : 'model'

    const parts: GeminiPart[] = []

    // 检查是否有图片
    const rawImg = item.image || (Array.isArray(item.content) ? item.content.find((c: any) => c.type === 'image_url')?.image_url?.url : null)
    if (rawImg && typeof rawImg === 'string') {
      const match = rawImg.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        })
      }
    }

    // 提取文本
    let text = ''
    if (typeof item.text === 'string') {
      text = item.text
    } else if (typeof item.content === 'string') {
      text = item.content
    } else if (Array.isArray(item.content)) {
      const textPart = item.content.find((c: any) => c.type === 'text')
      text = textPart?.text || ''
    }

    if (text || parts.length === 0) {
      parts.push({ text: text || (parts.length > 0 ? '' : '[空白消息]') })
    }

    // 合并相邻且相同角色的条目 (Gemini 规范要求严格的角色交替或规范连续)
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }

  return contents
}

/**
 * Gemini 原生 SSE 流式调用
 */
export async function streamGeminiChat(params: GeminiStreamChatParams): Promise<string> {
  const { config, systemInstruction, contents, signal, onChunk, onDone, onUsage } = params

  const baseUrl = normalizeGeminiBaseUrl(config.baseUrl)
  const model = normalizeGeminiModel(config.model)
  const apiKey = (config.apiKey || '').trim()

  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`

  const payload: Record<string, unknown> = {
    contents,
    safetySettings: GEMINI_SAFETY_SETTINGS_BLOCK_NONE,
    generationConfig: {
      temperature: params.temperature ?? config.temperature ?? 0.85,
      topP: params.topP ?? 0.95,
      maxOutputTokens: params.maxTokens ?? config.maxTokens ?? 2048,
    },
  }

  if (systemInstruction && systemInstruction.trim()) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction.trim() }],
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let detail = errText
    try {
      const json = JSON.parse(errText)
      if (json.error?.message) detail = json.error.message
    } catch {
      // 保持原始文本
    }
    throw new Error(`Gemini API 错误 (${response.status}): ${detail}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Gemini API 未返回响应流')

  const decoder = new TextDecoder('utf-8')
  let fullText = ''
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const jsonStr = trimmed.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue

        try {
          const parsed = JSON.parse(jsonStr)
          const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text
          if (textChunk) {
            fullText += textChunk
            onChunk(textChunk)
          }

          // 提取 usageMetadata
          if (parsed.usageMetadata && onUsage) {
            const u = parsed.usageMetadata
            onUsage({
              inputTokens: u.promptTokenCount ?? 0,
              outputTokens: u.candidatesTokenCount ?? 0,
              cachedTokens: 0,
              cacheMissTokens: null,
              source: 'generic',
            })
          }
        } catch {
          // 忽略单帧 JSON 解析错误
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (onDone) {
    onDone(fullText)
  }

  return fullText
}

/**
 * Gemini 原生非流式调用 (供群聊、总结与快速推荐等场景)
 */
export async function geminiChatCompletion(
  config: ApiConfig,
  contents: GeminiContent[],
  systemInstruction?: string,
  options: {
    temperature?: number
    topP?: number
    maxTokens?: number
    signal?: AbortSignal
  } = {},
): Promise<GeminiChatResult> {
  const baseUrl = normalizeGeminiBaseUrl(config.baseUrl)
  const model = normalizeGeminiModel(config.model)
  const apiKey = (config.apiKey || '').trim()

  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

  const payload: Record<string, unknown> = {
    contents,
    safetySettings: GEMINI_SAFETY_SETTINGS_BLOCK_NONE,
    generationConfig: {
      temperature: options.temperature ?? config.temperature ?? 0.85,
      topP: options.topP ?? 0.95,
      maxOutputTokens: options.maxTokens ?? config.maxTokens ?? 2048,
    },
  }

  if (systemInstruction && systemInstruction.trim()) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction.trim() }],
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let detail = errText
    try {
      const json = JSON.parse(errText)
      if (json.error?.message) detail = json.error.message
    } catch {
      // 保持原始
    }
    throw new Error(`Gemini API 错误 (${response.status}): ${detail}`)
  }

  const data = await response.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

  let usage: NormalizedUsage | undefined
  if (data.usageMetadata) {
    const u = data.usageMetadata
    usage = {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      cachedTokens: 0,
      cacheMissTokens: null,
      source: 'generic',
    }
  }

  return { text, usage }
}

/**
 * 测试 Gemini 原生连接
 */
export async function testGeminiConnection(
  config: ApiConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const baseUrl = normalizeGeminiBaseUrl(config.baseUrl)
    const model = normalizeGeminiModel(config.model)
    const apiKey = (config.apiKey || '').trim()

    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
        safetySettings: GEMINI_SAFETY_SETTINGS_BLOCK_NONE,
        generationConfig: { maxOutputTokens: 5 },
      }),
      signal,
    })

    if (res.ok) {
      return { ok: true, status: res.status, message: 'Google GenAI 连接正常' }
    }
    const txt = await res.text().catch(() => '')
    return { ok: false, status: res.status, message: txt || `HTTP ${res.status}` }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
