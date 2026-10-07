// =============================================================================
// customApi —— 自定义 API(OpenAI 兼容 /chat/completions)直连助手
// -----------------------------------------------------------------------------
// 定位:为"自定义 API 模式(apiMode === 'custom')"下所有**非单聊流式**的调用
// 提供统一入口。目前有两类使用方:
//   1. utils/customGroupBackend.ts —— 群聊的"判断下一位发言人 / 生成发言 / 推荐"
//   2. composables/useAiChat.ts    —— 单聊「AI 推荐回复」在 custom 模式下的降级实现
//      (原先无论什么模式都打后端网关 /chat/suggestions,这是审计出的问题之一)
//
// 为什么不复用 utils/llm.ts 的 streamChat:
//   群聊链路的形态是"一次 POST 拿完整文本"(与后端群聊服务一致),不需要 SSE;
//   而 llm.ts 只实现了流式分支。这里补一个**非流式**的 OpenAI 兼容调用,
//   思考模式(think)参数也在这里统一处理。
//
// 思考模式约定:
//   src/utils/llm.ts 现有直连**没有**传任何思考参数 —— 也就是说 custom 模式下
//   "思考模式"开关原本是失效的。这里按 OpenAI 兼容生态里最常见的做法传
//   `chat_template_kwargs: { enable_thinking: <bool> }`
//   (vLLM / SGLang / Qwen 系自建端点均识别该字段;不识别的服务商通常会忽略)。
//   单聊流式分支用同一约定,见 utils/llm.ts 的 StreamChatParams.think。
// =============================================================================

import type { ApiConfig } from '../stores/settings'
import { normalizeUsage } from './usage'
import type { NormalizedUsage } from './usage'
import { isOReasoningModel, usesMaxCompletionTokens } from './llm'

/** OpenAI 兼容消息(仅文本;群聊/推荐都不需要多模态) */
export interface CustomChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 非流式调用参数 */
export interface CustomChatOptions {
  /** 温度;o 系列 reasoning 模型会自动省略(与 llm.ts 同口径) */
  temperature?: number
  /** 最大输出 token;按模型自动选择 max_tokens / max_completion_tokens */
  maxTokens?: number
  /** 思考模式开关(enable_thinking);缺省 = 不带该字段,由服务商默认 */
  think?: boolean
  /** 外部中止信号(群聊回合的 controller.signal) */
  signal?: AbortSignal
  /** 超时(ms);缺省 60000。与外部 signal 取"先到先中止" */
  timeoutMs?: number
}

/** 非流式调用结果 */
export interface CustomChatResult {
  /** 回复文本(已去首尾空白) */
  text: string
  /** 服务商上报的用量;未上报为 undefined */
  usage?: NormalizedUsage
}

/** 自定义 API 的 chat/completions 地址 */
export function customChatUrl(config: ApiConfig): string {
  return `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** custom 模式是否已配置完整(baseUrl / apiKey / model 三件套) */
export function isCustomApiConfigured(config: ApiConfig): boolean {
  return !!config.baseUrl && !!config.apiKey && !!config.model
}

/**
 * 写入思考模式参数(OpenAI 兼容约定:chat_template_kwargs.enable_thinking)
 *
 * 直接改传入的 body 对象;缺省不调用本函数 = 请求体里不带该字段,
 * 行为与改动前完全一致。
 */
export function applyThinkMode(body: Record<string, unknown>, think: boolean): void {
  const prev = body.chat_template_kwargs
  const merged = prev && typeof prev === 'object' ? { ...(prev as object) } : {}
  body.chat_template_kwargs = { ...merged, enable_thinking: !!think }
}

/**
 * 单次非流式调用(自定义 API)
 *
 * @throws 配置缺失 / HTTP 非 2xx / 响应缺少内容时抛 Error(消息为中文可读文案)
 */
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
    const response = await fetch(customChatUrl(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
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

// =============================================================================
// 推荐回复的解析(后端 common.py parse_suggestions_text 的 TS 移植)
// =============================================================================

/**
 * 从模型输出里解析推荐候选句
 *
 * 容忍:JSON 数组 / ```json 代码围栏 / 编号列表 / 项目符号列表。
 * 与后端口径一致:去重、截断到 maxChars、最多 count 条。
 */
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

// =============================================================================
// 单聊「AI 推荐回复」在 custom 模式下使用的提示词
// -----------------------------------------------------------------------------
// 与后端 prompt_core.py 的 SUGGEST_SYSTEM_SINGLE 逐字一致 ——
// 这样 custom 模式的推荐风格与后端模式不会出现明显差异。
// =============================================================================

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
