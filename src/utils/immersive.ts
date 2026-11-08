// immersive —— 沉浸式对话的提示词层 + 文本层动作描写消除
// 语义：true = 不显示括号动作/神态，只留台词；false = 保留（EMPHASIS_RULE）。
// 自定义 API 是前端直连上游、没有后端兜底，所以这一层必须在前端实现。
// 两层保证：提示词层截掉「回复风格规则」并追加禁令；文本层丢弃 （…）/(…) 与 *…*。

import { EMPHASIS_RULE } from '../constants/prompts'

/** 「回复风格规则」段的起始标记（截断点），与后端用同一字符串 */
export const EMPHASIS_RULE_MARKER = '### 回复风格规则'

/** 沉浸式最高优先级规则，与后端追加段逐字一致 */
export const IMMERSIVE_RULE = `【沉浸式对话模式·最高优先级】以下规则优先级高于本提示词中的任何其他规则:
1. 禁止输出任何括号内的动作、神态、情景、内心描写,禁止出现(动作)(神态)(心想:…)等任何括号注释或括号内容。
2. 回复只输出角色说出的对话语句本身,台词之间可用换行分隔,但绝不能附加任何括号说明。
3. 台词仍然要充实饱满,尽量多说几句完整的话,不要用一两个字敷衍。
4. 禁止用 *星号* 包裹动作/神态描写,也禁止任何形式的旁白。`

/** 截掉「### 回复风格规则」及其之后的全部内容 */
export function stripEmphasisRule(prompt: string): string {
  const p = prompt ?? ''
  const idx = p.indexOf(EMPHASIS_RULE_MARKER)
  return (idx === -1 ? p : p.slice(0, idx)).replace(/\s+$/, '')
}

/**
 * 非沉浸式：空提示词只发 EMPHASIS_RULE；已含该段则不重复追加。
 * 沉浸式：截掉「回复风格规则」并追加禁令。
 */
export function applyImmersiveToCharacterPrompt(
  characterPrompt: string,
  immersive: boolean,
): string {
  const prompt = (characterPrompt ?? '').trim()
  if (immersive) {
    const base = stripEmphasisRule(prompt)
    return base ? `${base}\n\n${IMMERSIVE_RULE}` : IMMERSIVE_RULE
  }
  if (!prompt) return EMPHASIS_RULE
  return prompt.includes(EMPHASIS_RULE_MARKER) ? prompt : `${prompt}\n\n${EMPHASIS_RULE}`
}

// 文本层过滤

/** 开括号：半角全角都认 */
const IMM_OPEN = '（('
/** 闭括号与开括号**不要求同型**：模型常写出 `(动作）` */
const IMM_CLOSE = '）)'

/** 状态存在实例上，可逐增量 feed：开闭括号落在不同 delta 时依然正确 */
export class ImmersiveFilter {
  readonly enabled: boolean
  /** >0 表示正处于括号描写内部 */
  private depth = 0
  private star = false
  /** 已丢弃字符数，仅用于排查 */
  dropped = 0

  constructor(enabled = true) {
    this.enabled = !!enabled
  }

  /** 吃进一段增量，返回应当显示的部分 */
  feed(text: string): string {
    if (!this.enabled || !text) return text || ''
    const out: string[] = []
    for (const ch of text) {
      if (this.depth > 0) {
        if (IMM_CLOSE.includes(ch)) this.depth -= 1
        else if (IMM_OPEN.includes(ch)) this.depth += 1
        else this.dropped += 1
        continue
      }
      if (this.star) {
        if (ch === '*') this.star = false
        else this.dropped += 1
        continue
      }
      if (IMM_OPEN.includes(ch)) {
        this.depth = 1
        this.dropped += 1
        continue
      }
      if (ch === '*') {
        this.star = true
        this.dropped += 1
        continue
      }
      out.push(ch)
    }
    return out.join('')
  }
}

/**
 * ⚠️ 只用于最终显示 / 落库的文本：文本层是提示词层的兜底，模型不听话也不会漏出括号。
 */
export function stripImmersive(text: string, enabled = true): string {
  if (!enabled || !text) return text || ''
  let out = new ImmersiveFilter(true).feed(text)
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return out.trim()
}
