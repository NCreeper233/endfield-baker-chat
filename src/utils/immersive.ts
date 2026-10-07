// =============================================================================
// 沉浸式对话(immersive) —— 提示词层 + 文本层的动作描写消除
// -----------------------------------------------------------------------------
// 全项目统一语义(与后端 chat_service.py / group_chat_service.py 完全一致):
//   immersive_mode === true  → **不显示括号动作/神态描写,只留台词**;
//   immersive_mode === false → 保持原有"有括号描写"的行为(EMPHASIS_RULE)。
//
// 为什么前端必须自己实现这一层:
//   后端模式在服务端做了两层保证(截掉 EMPHASIS_RULE + ImmersiveFilter 文本过滤),
//   而自定义 API 模式是前端直连上游、**没有后端兜底** —— 不在这里补上,
//   "沉浸式对话模式"开关怎么切都没有任何效果(用户报的"沉浸式逻辑反了"
//   实际上就是指自定义链路根本没实现这件事)。
//
// 两层保证(与后端 common.py 的 ImmersiveFilter / strip_immersive 逐条对齐):
//   ① 提示词层:applyImmersiveToCharacterPrompt()
//        - 截掉强制要求括号描写的「### 回复风格规则(强制)」整段;
//        - 追加一段"最高优先级"的禁止括号/星号动作描写规则。
//   ② 文本层:ImmersiveFilter(流式安全)/ stripImmersive(一次性)
//        - 把 （…）/(…) 与 *…* 包裹的内容整段去掉;
//        - 未闭合也丢弃;支持跨增量保持状态(开括号与闭括号落在不同 delta)。
//
// 单聊(utils/llm.ts + composables/useAiChat.ts)与
// 群聊(utils/customGroupBackend.ts)共用本模块,避免两处规则走散。
// =============================================================================

import { EMPHASIS_RULE } from '../constants/prompts'

/** 「回复风格规则」段的起始标记(截断点);后端用同一字符串定位 */
export const EMPHASIS_RULE_MARKER = '### 回复风格规则'

/**
 * 沉浸式最高优先级规则
 *
 * 文本与后端 chat_service.py / group_chat_service.py 内的追加段逐字一致
 * (后端 group_chat_service.py 第 3 条末尾漏了一个换行,这里按 chat_service.py
 *  的版本补上,语义完全相同,只为让规则条目各占一行)。
 */
export const IMMERSIVE_RULE = `【沉浸式对话模式·最高优先级】以下规则优先级高于本提示词中的任何其他规则:
1. 禁止输出任何括号内的动作、神态、情景、内心描写,禁止出现(动作)(神态)(心想:…)等任何括号注释或括号内容。
2. 回复只输出角色说出的对话语句本身,台词之间可用换行分隔,但绝不能附加任何括号说明。
3. 台词仍然要充实饱满,尽量多说几句完整的话,不要用一两个字敷衍。
4. 禁止用 *星号* 包裹动作/神态描写,也禁止任何形式的旁白。`

/** 截掉角色提示词里「### 回复风格规则」及其之后的全部内容 */
export function stripEmphasisRule(prompt: string): string {
  const p = prompt ?? ''
  const idx = p.indexOf(EMPHASIS_RULE_MARKER)
  return (idx === -1 ? p : p.slice(0, idx)).replace(/\s+$/, '')
}

/**
 * 组装"角色提示词"这条 system 消息
 *
 * @param characterPrompt 角色基础提示词(用户覆盖优先,可能为空)
 * @param immersive      是否沉浸式(true = 禁止括号动作描写)
 *
 * - immersive=true : 截掉「### 回复风格规则」+ 追加 IMMERSIVE_RULE;
 * - immersive=false: 与改动前完全一致(空提示词只发 EMPHASIS_RULE,
 *                    非空则在其后追加 EMPHASIS_RULE;已含该段则不重复追加)。
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

// =============================================================================
// 文本层过滤(后端 common.py 的 ImmersiveFilter / strip_immersive 的 TS 移植)
// =============================================================================

/** 开括号:半角与全角都认(中文角色扮演里两种写法都常见) */
const IMM_OPEN = '（('
/** 闭括号:与开括号不要求同型(模型常写出 `(动作）` 这类混用) */
const IMM_CLOSE = '）)'

/**
 * 流式安全的动作描写过滤器:丢弃 （…）/(…) 与 *…* 包裹的内容
 *
 * 状态(depth / star)保存在实例上,因此可以逐增量 feed ——
 * 开括号与闭括号落在不同 delta 时依然能正确过滤(后端同款做法)。
 */
export class ImmersiveFilter {
  /** 是否启用(false 时原样放行) */
  readonly enabled: boolean
  /** 括号嵌套深度:>0 表示正处于括号描写内部 */
  private depth = 0
  /** 是否正处于 *…* 之间 */
  private star = false
  /** 已丢弃的字符数(仅用于排查,不影响输出) */
  dropped = 0

  constructor(enabled = true) {
    this.enabled = !!enabled
  }

  /** 吃进一段增量,返回应该显示出来的部分 */
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
 * 非流式:一次性去掉动作描写,并收拾留下的空行 / 多余空格
 *
 * ⚠️ 只用于"要显示 / 要落库的最终文本";给模型的 assistant 历史仍应按调用方
 * 既有口径处理。文本层过滤是提示词层失败时的兜底(模型不听话也不会漏出括号)。
 */
export function stripImmersive(text: string, enabled = true): string {
  if (!enabled || !text) return text || ''
  let out = new ImmersiveFilter(true).feed(text)
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return out.trim()
}
