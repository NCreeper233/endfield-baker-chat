// directChat —— 非后端模式（custom / legacy 直连）的请求准备与流式调用
// 6 个隐含前提都集中在这里：缓存前缀指纹、压缩时机、RAG 插入位置、沉浸式双层过滤、
// 用量口径、中止信号。

import { applyLengthPolicy } from '../../constants/prompts'
import type { AiResponseCtx } from '../../stores/chat'
import type { useChatStore } from '../../stores/chat'
import type { useSettingsStore } from '../../stores/settings'
import type { useUsageStore } from '../../stores/usage'
import { buildMessages, streamChat } from '../../utils/llm'
import type { LlmMessage } from '../../utils/llm'
import { buildRagContext } from '../../utils/rag'
import { estimateMessages } from '../../utils/tokenEstimate'
import { ImmersiveFilter, stripImmersive } from '../../utils/immersive'
import type { NormalizedUsage } from '../../utils/usage'
import type { CompactionOutcome } from '../useContextCompaction'

type ChatStore = ReturnType<typeof useChatStore>
type SettingsStore = ReturnType<typeof useSettingsStore>
type UsageStore = ReturnType<typeof useUsageStore>

/** 与 chat store 的 contextHistory 形状一致 */
export type ChatHistoryEntry = { side: 'other' | 'mine'; text: string; image?: string }

export interface DirectChatDeps {
  chat: ChatStore
  settings: SettingsStore
  usage: UsageStore
  /** 上下文压缩的唯一实现（useContextCompaction） */
  compact: (fixedPrefixText: string, mode: 'auto' | 'manual') => Promise<CompactionOutcome | null>
}

export interface DirectChatParams {
  characterName: string
  sub: number
  ctx: AiResponseCtx
  /**
   * undefined = 不接管，用 store 里的实时历史：custom 模式的压缩发生在本次调用内部，
   * 提前取快照会让压缩结果永远用不上。
   */
  summaryHistory?: ChatHistoryEntry[]
}

export interface DirectChatResult {
  fullText: string
  /** 未上报时为 null */
  capturedUsage: NormalizedUsage | null
  /** 未乘校准比值 */
  estimatedInputTokens: number
  /** 本轮是否真的发生了上下文压缩 */
  compacted: boolean
}

/** 固定前缀指纹：前缀一变，服务端缓存必然全部失效，面板据此提示用户 */
export function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/**
 * 执行一次直连请求(custom / legacy),返回完整回复
 *
 * 错误原样抛出,由调用方统一转成错误气泡。
 */
export async function runDirectChat(
  deps: DirectChatDeps,
  params: DirectChatParams,
): Promise<DirectChatResult> {
  const { chat, settings, usage, compact } = deps
  const { characterName, sub, ctx, summaryHistory } = params

  // 原有模式:系统提示词 + 全局世界观 + 角色提示词 + 历史消息,SSE 流式调用
  // 两条 system 消息统一由 settings store 产出,保证与用量面板的统计口径一致
  const systemMessage = settings.getSystemMessage()
  // 通用回复规则(EMPHASIS_RULE)由 settings 拼在角色提示词末尾,里面带着
  // 长度占位符 {LENGTH_TARGET}:必须在此按角色填好,否则模型收到的是一串
  // 模板痕迹。custom / legacy 直连没有后端兜底,这里是最后一道。
  const characterMessage = applyLengthPolicy(settings.getCharacterMessage(characterName), characterName)

  const isCustom = settings.apiConfig.apiMode === 'custom'

  // 固定前缀指纹:用户改了世界观 / 角色提示词 → 缓存必然全部失效,
  // 面板据此给出提示,避免误判成"缓存没生效"。
  usage.notePrefix(hashText(`${systemMessage}\u0000${characterMessage}`))

  // custom 模式：预算检查 + 批量压缩（未超预算一条不丢）。
  // ⚠️ 压缩器只认 activeSub，玩家已切走时不能压，否则会截短**另一段**对话的历史。
  let compacted = false
  if (isCustom && chat.activeSub === sub) {
    compacted = (await compact(`${systemMessage}\n\n${characterMessage}`, 'auto')) !== null
  }

  // 不传 summaryHistory 时取实时历史：custom 模式下顺序恒为 [system, system, ...历史]，
  // 天然满足「前缀只追加」；必须按**锁定**的会话下标取，人设与历史才来自同一段对话
  const history = summaryHistory ?? chat.getChatHistory(sub)
  const messages: LlmMessage[] = buildMessages(systemMessage, characterMessage, history)

  // ---- 后端 RAG 检索（仅自定义 API 模式；默认 API 在网关里做，旧版无此能力）----
  // ⚠️ 语料必须插在**本轮 user 之前**：它每轮都变，放在历史之前会让整段历史落在
  // 变动区、每轮全量重新计费；放在本轮提问之前，固定前缀才能一路命中缓存。
  if (isCustom && settings.ragEnabled) {
    const lastMine = [...history].reverse().find((m) => m.side === 'mine')
    const ragBlock = lastMine?.text
      ? await buildRagContext(lastMine.text, chat.getAiSignal(ctx), settings.ragTopK)
      : ''
    if (ragBlock) {
      // 从后往前找最后一条 user(= 本轮提问),插在它前面;
      // 一条 user 都没有(例如重新生成时历史只剩 assistant)就接在末尾。
      let insertAt = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          insertAt = i
          break
        }
      }
      messages.splice(insertAt, 0, { role: 'system', content: ragBlock })
    }
  }

  // 本地估算(未校准),服务商未上报 usage 时由 usage store 乘以校准比值后展示
  const estimatedInputTokens = estimateMessages(messages)

  // ---- 沉浸式对话的文本层过滤(custom / legacy 直连没有后端兜底) --------
  // 提示词层已在 getCharacterMessage 里处理(截掉强制括号的规则 + 追加禁止规则);
  // 这里再过一遍文本层:模型不听话时也不会漏出 (动作) / *动作*。
  // 用 ImmersiveFilter 逐增量过滤(跨 delta 保持括号状态),
  // 收尾时用一次性 stripImmersive 以权威全文兜底。
  //
  // 两道闸:immersiveMode 决定"要不要只留台词"(连提示词一起换),
  //         immersiveStrip 只决定"文本层要不要真的裁掉括号描写"。
  // 后者关掉时提示词照发,但模型硬写出来的括号会原样显示 —— 排查用得上。
  const immersive = settings.immersiveMode
  const strip = immersive && settings.immersiveStrip
  const immFilter = strip ? new ImmersiveFilter(true) : null
  const usageHolder: { value: NormalizedUsage | null } = { value: null }
  let fullText = ''

  await streamChat({
    config: settings.apiConfig,
    messages,
    signal: chat.getAiSignal(ctx),
    requestUsage: settings.apiConfig.requestUsage,
    // 思考模式:仅 custom 模式透传(legacy 内置端点不在该协议内,由 llm.ts 忽略)
    think: isCustom ? settings.thinkEnabled : undefined,
    onUsage: (u) => {
      usageHolder.value = u
    },
    onChunk: (chunk) => {
      // 沉浸式:边收边滤(流式场景下真正的"跨增量保持状态")
      fullText += immFilter ? immFilter.feed(chunk) : chunk
    },
    onDone: (full) => {
      // 以权威全文为准再过滤一次(过滤关掉时原样返回)
      const filtered = stripImmersive(full, strip)
      // 过滤成空时回退原文:沉浸式把整条回复都判定成"动作描写"时,
      // 玩家看到空气泡等于"对方没说话",比看到带括号的原文更糟。
      fullText = filtered || full
    },
  })

  return {
    fullText,
    capturedUsage: usageHolder.value,
    estimatedInputTokens,
    compacted,
  }
}
