// customApi —— 自定义 API 的 OpenAI 兼容直连（非流式 POST）
// 不复用 llm.ts 是因为它只有流式分支；这里补非流式调用，并统一处理思考模式
// `chat_template_kwargs.enable_thinking`（vLLM / SGLang / Qwen 系识别，其余忽略）。

import type { ApiConfig } from '../stores/settings'
import { normalizeUsage } from './usage'
import type { NormalizedUsage } from './usage'
import { isOReasoningModel, usesMaxCompletionTokens } from './llm'

/** 仅文本：群聊与推荐都不需要多模态 */
export interface CustomChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CustomChatOptions {
  /** o 系列 reasoning 模型会自动省略，与 llm.ts 同口径 */
  temperature?: number
  maxTokens?: number
  /** 缺省 = 不带该字段，由服务商默认 */
  think?: boolean
  signal?: AbortSignal
  /** 与 signal 取「先到先中止」，缺省 60000 */
  timeoutMs?: number
}

export interface CustomChatResult {
  /** 已去首尾空白 */
  text: string
  usage?: NormalizedUsage
}

export function customChatUrl(config: ApiConfig): string {
  return `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
}

export function isCustomApiConfigured(config: ApiConfig): boolean {
  return !!config.baseUrl && !!config.apiKey && !!config.model
}

/** 缺省不调用本函数 = 请求体不带该字段，行为与此前完全一致 */
export function applyThinkMode(body: Record<string, unknown>, think: boolean): void {
  // 只在开启思考时发送：不少兼容服务端会拒绝未知字段（400 unrecognized_keys）
  if (!think) return
  const prev = body.chat_template_kwargs
  const merged = prev && typeof prev === 'object' ? { ...(prev as object) } : {}
  body.chat_template_kwargs = { ...merged, enable_thinking: !!think }
}

/** 配置缺失 / 非 2xx / 内容为空时抛 Error，消息为中文可读文案 */
export async function customChatCompletion(
  config: ApiConfig,
  messages: CustomChatMessage[],
  opts: CustomChatOptions = {},
): Promise<CustomChatResult> {
  if (!isCustomApiConfigured(config)) {
    throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
  }

  const model = config.model
  const completionParam = usesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens'
  const body: Record<string, unknown> = {
    model,
    messages,
    [completionParam]: opts.maxTokens ?? config.maxTokens,
    // 群聊/推荐都不需要流式:一次拿到完整文本即可
    stream: false,
  }
  // o 系列 reasoning 模型不接受 temperature(与 llm.ts 同口径)
  if (opts.temperature !== undefined && !isOReasoningModel(model)) {
    body.temperature = opts.temperature
  }
  if (opts.think !== undefined) applyThinkMode(body, opts.think)

  // 超时与外部中止信号合并:任一触发即中止本次请求
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onAbort)
  }
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)

  try {
    const url = customChatUrl(config)
    const send = async (payload: Record<string, unknown>) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const errText = r.ok ? '' : await r.text().catch(() => r.statusText)
      return { r, errText }
    }
    let sent = await send(body as Record<string, unknown>)
    // 思考模式是可选扩展：若服务端明确拒绝这个字段，去掉它重试一次，
    // 而不是让整条对话直接失败（用户看到的是"API 请求失败 (400)"）。
    if (
      !sent.r.ok &&
      sent.r.status === 400 &&
      /chat_template_kwargs/i.test(sent.errText) &&
      'chat_template_kwargs' in (body as Record<string, unknown>)
    ) {
      delete (body as Record<string, unknown>).chat_template_kwargs
      sent = await send(body as Record<string, unknown>)
    }
    const { r: response, errText } = sent
    if (!response.ok) {
      // 保留 HTTP 状态码:调用方(useGroupChat)按 /限速|429/ 判定退避重试
      throw new Error(`API 请求失败 (${response.status}): ${errText}`)
    }
    const data: unknown = await response.json().catch(() => null)
    const payload = data as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
      usage?: unknown
    } | null
    const content = payload?.choices?.[0]?.message?.content
    const text = typeof content === 'string'
      ? content
      : (typeof payload?.choices?.[0]?.text === 'string' ? payload.choices[0].text : '')
    if (!text.trim()) throw new Error('API 返回内容为空')
    return {
      text: text.trim(),
      usage: normalizeUsage(payload?.usage) ?? undefined,
    }
  } finally {
    window.clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

// 推荐回复的解析：后端 parse_suggestions_text 的 TS 移植

/** 容忍 JSON 数组 / ```json 围栏 / 编号列表 / 项目符号列表；与后端同口径去重、截断 */
export function parseSuggestionList(
  rawText: string,
  count = 3,
  maxChars = 25,
): string[] {
  const text = (rawText ?? '')
    .trim()
    .replace(/^```(?:json)?/gm, '')
    .replace(/```$/gm, '')
    .trim()

  let items: string[] = []
  const candidates: string[] = [text]
  const mArr = text.match(/\[[\s\S]*\]/)
  if (mArr) candidates.push(mArr[0])
  for (const candidate of candidates) {
    try {
      const arr: unknown = JSON.parse(candidate)
      if (Array.isArray(arr)) {
        items = arr.map((x) => String(x))
        break
      }
    } catch {
      // 解析失败 → 试下一个候选
    }
  }
  if (items.length === 0) {
    // 退回逐行解析,并剥掉 "1." "-" "•" 之类的序号 / 符号
    for (const rawLine of text.split('\n')) {
      let ln = rawLine.trim()
      if (!ln || ln === '[' || ln === ']' || ln === '```') continue
      ln = ln.replace(/^\s*(?:\d+\s*[.、)]|[-*•])\s*/, '')
      items.push(ln)
    }
  }

  const out: string[] = []
  for (let it of items) {
    it = it.trim().replace(/^["']/, '').replace(/["']$/, '').trim().replace(/,$/, '').trim()
    if (!it) continue
    const chars = Array.from(it)
    if (chars.length > maxChars) it = chars.slice(0, maxChars).join('')
    if (!out.includes(it)) out.push(it)
    if (out.length >= count) break
  }
  return out
}

// 单聊「AI 推荐回复」在 custom 模式下的提示词
// 与后端 SUGGEST_SYSTEM_SINGLE 逐字一致，两种模式的推荐风格才不会有差异。

export const SUGGEST_SYSTEM_SINGLE = `你在帮用户想"接下来可以跟这个角色说什么"。

要求:
1. 输出 3 条候选,每条都是**用户自己**会打出去的话(第一人称,直接可发送)。
2. 每条不超过 25 个字,短、口语化,像真的在聊天框里打字。
3. 要贴合当前对话的上下文:承接最近的话题、回应角色的最后一句话、或者推进剧情。
4. 三条要有差异:一条顺着聊、一条换个角度、一条抛出新的引子。
5. 不要替角色说话,不要写角色的台词、动作描写或括号旁白。

严格只输出 JSON 数组,不要任何多余文字:
["候选1", "候选2", "候选3"]
`
