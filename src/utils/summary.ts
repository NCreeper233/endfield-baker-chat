// summary —— 智能总结：历史超 50 条时把超出部分压成摘要插到最前
// OpenAI 兼容格式；默认走内置 Agnes，自定义模式用用户填的配置。
// 请求失败静默降级：不插摘要、不阻断聊天。url 完全由调用方传入的 baseUrl 决定。

/** 智能总结固定 system 提示词(前端内置,用户无需配置) */
export const SUMMARY_SYSTEM_PROMPT =
  '你是对话总结助手。请用简洁的中文总结以下对话内容，包括用户主要聊了什么、角色如何回应、关键事件或情绪变化。控制在300字以内。'

/** 总结请求超时(ms) */
const SUMMARY_TIMEOUT_MS = 20000

/** 总结输入长度上限(超出截断,避免请求体过大) */
const SUMMARY_INPUT_MAX = 6000

/** 超出上限时截掉开头，保留最近的对话 */
export function formatHistoryForSummary(
  history: Array<{ side: 'other' | 'mine'; text: string }>,
): string {
  const lines = history.map((h) => {
    const who = h.side === 'mine' ? '用户' : '角色'
    const content = h.text || '[图片]'
    return `${who}：${content}`
  })
  let text = lines.join('\n')
  if (text.length > SUMMARY_INPUT_MAX) {
    text = text.slice(-SUMMARY_INPUT_MAX)
  }
  return text
}

/** 失败时抛异常，由调用方降级 */
export async function requestSummary(
  baseUrl: string,
  apiKey: string,
  model: string,
  history: Array<{ side: 'other' | 'mine'; text: string }>,
): Promise<string> {
  // 直接抛错而不拼 "undefined/chat/completions"：custom 模式下用户可能没填自定义
  // API，而该模式又禁止回退到后端 key 接口（见 stores/settings.ts）。
  if (!baseUrl || !apiKey || !model) {
    throw new Error('总结 API 未配置（自定义模式下请先在设置中填写 Base URL / API Key / 模型名）')
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const userContent = `以下是要总结的对话内容：\n\n${formatHistoryForSummary(history)}`

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`总结 API 请求失败 (${response.status})`)
    }
    const data = await response.json()
    const summary =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error('总结 API 返回内容为空')
    }
    return summary.trim()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('总结请求超时')
    }
    throw err
  } finally {
    window.clearTimeout(timer)
  }
}
