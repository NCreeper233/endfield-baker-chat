// useAiChat —— 单聊的 AI 编排（store + settings + llm）
// 两个贯穿全文件的约束：
// 1. 每轮 beginAiResponse 拿到的 ctx 必须一路显式传给所有写入点；ctx 同时锁定
//    token 与会话对象，失效后迟到的内容一律丢弃 —— 这是「串台」的防线。
// 2. 每个入口都在第一个 await 之前抓 { sub, conv }（AiTurnTarget）；中间隔着网络，
//    等 await 回来再读 activeSub 就已经是另一段会话了。

import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import {
  buildBackendRequest,
  fetchBackendReply,
  fetchBackendSuggestions,
  BACKEND_HISTORY_LIMIT,
  CHARACTER_ID_MAP,
} from '../utils/backend'
import { applyLengthPolicy, buildEmphasisRule } from '../constants/prompts'
import { splitAiSegments } from '../utils/aiText'
import type { Conversation } from '../types/chat'
import {
  customChatCompletion,
  parseSuggestionList,
  SUGGEST_SYSTEM_SINGLE,
} from '../utils/customApi'
import { requestSummary } from '../utils/summary'
import { useUsageStore } from '../stores/usage'
import { useContextCompaction } from './useContextCompaction'
import { useReplyReveal } from './useReplyReveal'
import { estimateEntry, estimateText } from '../utils/tokenEstimate'
import type { NormalizedUsage } from '../utils/usage'
import { devWarn } from '../utils/logger'
// 聊天管线的三个专职模块(从本文件拆分出去,行为逐字未改)
import { pickOutputTokens, runBackendStream } from './chat/backendStream'
import { runDirectChat } from './chat/directChat'
import { playSegments } from './chat/segmentPlayback'

/** 达到窗口的 80% 就把 80% 以外的历史总结掉，剩下 20% 留给长度不固定的 RAG 语料 */
const SUMMARY_TRIGGER_RATIO = 0.8

/** 每轮原样重发、不参与总结的那部分提示词的 token 估计（偏大更安全：会稍早触发总结） */
const FIXED_PROMPT_TOKENS = 3000

/** Agnes 2.5 Flash 的官方上下文窗口 */
const DEFAULT_SUMMARY_CONTEXT_WINDOW = 512_000

/** 聊天历史条目，与 chat store 的 contextHistory 同形 */
type ChatHistoryEntry = { side: 'other' | 'mine'; text: string; image?: string }

interface BackendInput {
  message: string
  history: ChatHistoryEntry[]
}

/**
 * 一轮 AI 回复锁定的目标会话
 *
 * 存对象而不只存下标：从读人设到写回回复之间隔着网络，期间可能切走、删卡、导入。
 * 会话对象用于写入前的归属校验。
 */
interface AiTurnTarget {
  sub: number
  conv: Conversation
}

/**
 * 智能总结处理
 *
 * 关闭时保持旧行为：强制截断最近 50 条（25 轮）。
 * 开启时只看 token：固定提示词 + 本会话累计输出 对比 窗口 × 80%，未达则整段上传，
 * 达到则把 80% 以外的历史总结成一条摘要插到最前。失败时降级为不插摘要并记录。
 */
async function applySmartSummary(
  history: ChatHistoryEntry[],
  settingsStore: ReturnType<typeof useSettingsStore>,
  chatStore: ReturnType<typeof useChatStore>,
  /**
   * 目标会话下标(缺省 = 当前会话)
   *
   * 会话累计输出 token 的读写必须落在**这一段**会话上:本函数里的总结请求是
   * 网络 await,期间玩家切走后若仍按 activeSub 记账,就把用量记到了别人头上。
   */
  targetSub?: number,
): Promise<ChatHistoryEntry[]> {
  // 旧版模式不限制历史:直接返回全部历史
  if (settingsStore.legacyUnlimitedHistory && settingsStore.apiConfig.apiMode === 'legacy') {
    return history.slice()
  }

  const cfg = settingsStore.summaryConfig
  // 智能总结**关闭**：行为与改动前完全一致 —— 强制截断最近 50 条（25 轮）
  if (!cfg.enabled) return history.slice(-BACKEND_HISTORY_LIMIT)

  // ---- 智能总结**开启**：完全按 token 判断，不看条数（可 >50 / <50 / =50）----
  //
  // 判据取两者较大值，免得估算偏差导致「该总结却不动」：
  //   ① 固定提示词 + 后端上报的输出 token ② 固定提示词 + 本地估算的历史体积
  const sessionOutputTokens = chatStore.getSessionOutputTokens(targetSub)
  const contextWindow = (cfg.contextWindow ?? 0) > 0
    ? cfg.contextWindow
    : DEFAULT_SUMMARY_CONTEXT_WINDOW
  const budget = contextWindow * SUMMARY_TRIGGER_RATIO

  const historyTokens = history.reduce(
    (sum, e) => sum + estimateEntry({ text: e.text, image: e.image }),
    0,
  )
  const used = Math.max(
    FIXED_PROMPT_TOKENS + sessionOutputTokens,
    FIXED_PROMPT_TOKENS + historyTokens,
  )

  if (used < budget) {
    // 还没到 80%：历史整段上传，一条都不截断（这正是智能总结相对固定截断的价值）
    return history.slice()
  }

  // 从最新往回保留，直到保留段塞进 80% 预算。
  //
  // fallback 的原因：输出 token 刚到 80% 时，本地估算可能还略低于预算（估算器与
  // 真实 tokenizer 有偏差），按估算一条都不总结就会「该总结却没动」，下一轮又触发。
  // 所以只要判定要总结，至少把最后一条之前的历史压成摘要。
  const perEntry = (e: ChatHistoryEntry) => estimateEntry({ text: e.text, image: e.image })
  let tailTokens = 0
  let keepFrom = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    const t = perEntry(history[i])
    if (FIXED_PROMPT_TOKENS + tailTokens + t > budget) break
    tailTokens += t
    keepFrom = i
  }
  if (keepFrom >= history.length) {
    // 估算器认为整段仍在预算内，但累计用量已判定要总结 → 至少留最后一条
    keepFrom = Math.max(0, history.length - 1)
  }
  const excess = history.slice(0, keepFrom)
  const recent = history.slice(keepFrom)

  // 没有任何可总结的内容（只有一条消息）：保持原样，交给后端
  if (excess.length === 0) return history.slice()

  try {
    const api = await settingsStore.getSummaryApi()
    const summary = await requestSummary(
      api.baseUrl,
      api.apiKey,
      api.model,
      excess,
    )
    // 摘要以 user 角色插入最前(避免后端无法处理多条 system)
    const summaryEntry: ChatHistoryEntry = {
      side: 'mine',
      text: `【对话总结】\n${summary}`,
    }
    // 前段历史已被摘要取代 → 会话 token 计数归零，避免下一轮立刻又触发总结
    chatStore.resetSessionOutputTokens(targetSub)
    return [summaryEntry, ...recent]
  } catch (err) {
    // 总结失败:降级为最近 50 条原始消息,不阻断聊天
    devWarn('[summary] 智能总结失败,降级为最近 50 条:', err)
    return recent
  }
}

/**
 * 按当前模式决定传给 triggerAiResponse 的已裁剪历史
 *
 * 返回 undefined = 不接管，由内部在压缩之后再从 store 现取。
 *
 * 自定义模式必须返回 undefined：压缩发生在 triggerAiResponse 内部，这里提前快照
 * 会让压缩结果永远用不上，请求发出去的仍是压缩前那份，历史一路涨到被服务端拒绝。
 * 也不能用 50 条滑动窗口：每轮从头部丢，req(N) 不再是 req(N+1) 的前缀，缓存全失效。
 */
async function planHistory(
  history: ChatHistoryEntry[],
  settingsStore: ReturnType<typeof useSettingsStore>,
  chatStore: ReturnType<typeof useChatStore>,
  /** 目标会话下标(缺省 = 当前会话),见 applySmartSummary 的同名参数 */
  targetSub?: number,
): Promise<ChatHistoryEntry[] | undefined> {
  if (settingsStore.apiConfig.apiMode === 'custom') return undefined
  return applySmartSummary(history, settingsStore, chatStore, targetSub)
}

/** 群聊里"让某个指定角色发言"时的说话人覆盖 */
export interface SpeakerOverride {
  name: string
  avatar: string
}

/**
 * custom 模式的单聊推荐回复（前端本地实现）
 *
 * 自定义模式必须全程只用用户自己的 API，不能偷偷打网关的 /chat/suggestions。
 * 提示词口径与后端一致：【角色】+【设定摘要】+【最近 12 条】→ 3 条候选。
 * 失败抛错，由调用方降级为「暂无推荐」。
 */
async function requestCustomSuggestions(
  settingsStore: ReturnType<typeof useSettingsStore>,
  characterName: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
): Promise<string[]> {
  const who = characterName || '角色'

  // 最近 12 条渲染成"我 / 角色:内容"(与后端同一口径;单条超 120 字截断)
  const lines: string[] = []
  for (const m of history.slice(-12)) {
    let content = (m.text ?? '').trim()
    if (!content) {
      if (!m.image) continue
      content = '[图片]'
    }
    const chars = Array.from(content)
    if (chars.length > 120) content = `${chars.slice(0, 120).join('')}…`
    lines.push(`${m.side === 'mine' ? '我' : who}：${content}`)
  }
  const convo = lines.join('\n') || '(暂无对话)'
  // 角色设定摘要：与单聊请求同一条角色提示词，长度占位符也要填掉
  const persona = applyLengthPolicy(settingsStore.getCharacterMessage(who), who).slice(0, 2000)

  const user = `【角色】${who}\n`
    + `【角色设定摘要】\n${persona || '(无)'}\n\n`
    + `【最近对话】\n${convo}\n\n`
    + '请给出我接下来可以说的 3 句话。'

  const ask = async (extra = ''): Promise<string> => {
    const { text } = await customChatCompletion(settingsStore.apiConfig, [
      { role: 'system', content: SUGGEST_SYSTEM_SINGLE },
      { role: 'user', content: user + extra },
    ], {
      temperature: 0.9,
      maxTokens: 512,
      // 思考模式与单聊请求保持一致(此处无外部中止信号,超时自兜底)
      think: settingsStore.thinkEnabled,
      timeoutMs: 30_000,
    })
    return text
  }

  const out = parseSuggestionList(await ask(), 3, 25)
  // 模型偶发只给 1~2 条:补问一次(与后端 build_suggestions 一致)
  if (out.length < 3) {
    try {
      const extra = `\n\n注意:上一次只给了 ${out.length} 条,这次务必给出 3 条互不重复的。`
      for (const it of parseSuggestionList(await ask(extra), 3, 25)) {
        if (!out.includes(it)) out.push(it)
        if (out.length >= 3) break
      }
    } catch {
      // 补生成失败就用已有结果
    }
  }
  return out.slice(0, 3)
}

export function useAiChat() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  const usageStore = useUsageStore()
  // 压缩逻辑的唯一实现处(自动 / 手动共用),见 composables/useContextCompaction.ts
  const { compact } = useContextCompaction()
  // 回复逐拍显示(括号描写居中开启时,居中条与台词之间留间隔),单聊群聊共用
  const { appendStaged } = useReplyReveal()

  /** 把此刻这段会话抓成锁定目标，必须在第一个 await 之前调用 */
  function lockTarget(): AiTurnTarget | null {
    const sub = chatStore.activeSub
    if (sub === null) return null
    const conv = chatStore.conversations[sub]
    if (!conv) return null
    return { sub, conv }
  }

  /**
   * 找回锁定会话**现在**的下标
   *
   * 删一段 / 新建 / 导入会让下标整体位移；锁的是对象，按对象找回位置，
   * 回复才能仍写回同一段对话。
   *
   * @returns null = 这段会话已被删除或替换，整轮放弃
   */
  function resolveTargetSub(target: AiTurnTarget): number | null {
    const list = chatStore.conversations
    if (list[target.sub] === target.conv) return target.sub
    const idx = list.indexOf(target.conv)
    return idx === -1 ? null : idx
  }

  /**
   * 单聊公共入口。后端模式只上交原始数据（提示词与处理都在后端），其余模式走
   * system + 角色提示词。target 是调用方在 await 之前锁定的会话，缺省取当前会话。
   */
  async function triggerAiResponse(
    backendInput?: BackendInput,
    userMsgId?: number,
    summaryHistory?: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
    speakerOverride?: SpeakerOverride,
    /** 重新生成：插到这条消息之后（通常是那一轮的用户消息 id） */
    insertAfterMessageId?: number,
    target?: AiTurnTarget,
  ): Promise<void> {
    // 读取身份与写入位置必须是同一段会话：先按锁定对象找回下标，再验归属
    const sub = target ? resolveTargetSub(target) : chatStore.activeSub
    if (sub === null) return
    const conv = target?.conv ?? chatStore.conversations[sub]
    if (!conv) return
    // 锁定的会话已被删除 / 替换（不是位移，位移会被 resolveTargetSub 找回来）→ 整轮作废
    if (chatStore.conversations[sub] !== conv) return
    // 群聊的会话名是群名，有 speakerOverride 时必须用被点名的角色去查人设
    const characterName = speakerOverride?.name ?? conv.name

    // 头像按目标会话取：等待期间玩家切走后，回复仍写回原会话，头像也该是原会话的
    const meta = chatStore.conversationMetaAt(sub)
    const speakerName = characterName
    const speakerAvatar = speakerOverride?.avatar ?? meta?.avatar ?? ''

    // 创建第一个 loading 气泡,并锁定本轮响应上下文:
    // 目标会话与说话人在此刻固定,之后切换会话 / 其他会话并发请求都不会串台。
    // 末位传 conv:store 会把它记为归属,后续每次写入都要求"还是这段会话"
    const ctx = chatStore.beginAiResponse(
      speakerName, speakerAvatar, sub, insertAfterMessageId, conv)
    if (!ctx) return

    // ---- 本轮状态(被下面的守卫与收尾共用) -------------------------------
    /** 完整回复文本(流式过程中持续累积) */
    let fullText = ''
    /** 后端模式可选返回的心情表情 token(如 sns_emoji_001),缺失为 undefined */
    let pendingMood: string | undefined
    /** 服务商上报的用量(未上报时保持 null → 回退本地估算) */
    let capturedUsage: NormalizedUsage | null = null
    /** 后端上报的本轮**输出** token(用于"会话累计输出 token"→ 智能总结触发判断) */
    let backendOutputTokens = 0
    /** 本地估算的输入 token(未乘校准比值,由 usage store 统一校准) */
    let estimatedInputTokens = 0
    /** 本轮是否发生了上下文压缩(压缩会使服务端缓存前缀失效) */
    let compacted = false

    /** 落字前拦「彻底空白」：上游返回空，或被沉浸式过滤器整条吃掉 */
    const rejectIfUnplayable = (): boolean => {
      if (fullText.trim()) return false
      chatStore.appendAiError(
        '回复内容为空(可能被沉浸式过滤掉或上游返回空),可点「重新生成」重试',
        userMsgId,
        ctx,
      )
      return true
    }

    // ---- 请求并缓冲完整回复(loading 动画持续,不实时显示文字) -------------
    try {
      if (backendInput) {
        // 后端模式 v4:统一网关 + character_id(不再发送长提示词)
        const characterId = CHARACTER_ID_MAP[characterName] || ''
        // 用户自定义提示词覆盖:仅存在覆盖时发送(后端优先使用覆盖)
        const hasOverride = !!settingsStore.promptOverrides[characterName]
        const request = buildBackendRequest(
          backendInput.message,
          characterName,
          backendInput.history,
          {
            characterId,
            // 用户覆盖才发送;内置提示词由后端按 character_id 加载
            characterPromptOverride: hasOverride
              ? settingsStore.getCharacterPrompt(characterName)
              : undefined,
            // 未收录角色(自定义):退回旧协议发送完整提示词
            systemPrompt: characterId
              ? undefined
              : (() => {
                  const fixed = settingsStore.getFullSystemPrompt()
                  const role = settingsStore.getCharacterPrompt(characterName)
                  // 通用规则里的长度占位符必须按角色填好再发(见 constants/prompts)
                  const rule = buildEmphasisRule(characterName)
                  const roleWithRule = role ? `${role}\n\n${rule}` : rule
                  return fixed ? `${fixed}\n\n【角色设定】\n${roleWithRule}` : roleWithRule
                })(),
            think: settingsStore.thinkEnabled,
            // 只走 RAG 时后端根本不联网，此时不带该字段（该开关是「联网搜索」的子选项）
            forceSearch: settingsStore.webSearchEnabled ? settingsStore.forceSearch : undefined,
            // true = 后端禁止括号动作，只留台词
            immersiveMode: settingsStore.immersiveMode,
            useNewPrompt: settingsStore.useNewPrompt,
            // 默认不带 = 后端走 RAG；打开「联网搜索」时显式传 false
            useRag: settingsStore.webSearchEnabled ? false : undefined,
          },
        )
        // SSE 与一次性请求共用同一个中止信号
        const signal = chatStore.getAiSignal(ctx)

        if (settingsStore.sseStreaming) {
          // 逐字播出的细节在 composables/chat/backendStream：节奏、权威全文补完、
          // 以及「收到 delta 前失败就回退非流式」
          const outcome = await runBackendStream(
            { chat: chatStore, appendStaged, onUnplayable: rejectIfUnplayable },
            {
              apiConfig: settingsStore.apiConfig,
              request,
              signal,
              ctx,
              smartSplit: settingsStore.smartSplit,
            },
          )
          // 已实时播完并收尾，或已按「空回复」写过错误气泡
          if (outcome.kind === 'finalized') return
          fullText = outcome.fullText
          pendingMood = outcome.mood
          backendOutputTokens = outcome.outputTokens
        } else {
          // 默认路径：一次 JSON 请求拿完整回复
          const backendResult = await fetchBackendReply(
            settingsStore.apiConfig,
            request,
            signal,
          )
          fullText = backendResult.reply
          pendingMood = backendResult.mood
          backendOutputTokens = pickOutputTokens(backendResult.usage)
        }
      } else {
        // 直连模式(custom / legacy):提示词拼装、按预算压缩、RAG 注入、沉浸式
        // 过滤、流式调用全部在 composables/chat/directChat,这里只接收结果。
        const direct = await runDirectChat(
          { chat: chatStore, settings: settingsStore, usage: usageStore, compact },
          { characterName, sub, ctx, summaryHistory },
        )
        fullText = direct.fullText
        capturedUsage = direct.capturedUsage
        estimatedInputTokens = direct.estimatedInputTokens
        compacted = direct.compacted
      }
    } catch (err) {
      // 用户主动中止时请求层返回空串，这里仅兜底
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // 错误只显示、绝不写入 contextHistory（不污染上下文，也不持久化）
      const errMsg = err instanceof Error ? err.message : String(err)
      chatStore.appendAiError(errMsg, userMsgId, ctx)
      return
    }

    // 后端模式累加输出 token：智能总结据此判断是否达到窗口 80%
    if (backendInput && backendOutputTokens > 0) {
      chatStore.addSessionOutputTokens(backendOutputTokens)
    }

    // 只在直连模式记用量：后端模式的提示词在服务端，本地估算没有意义
    if (!backendInput) {
      usageStore.record({
        usage: capturedUsage,
        estimatedInput: estimatedInputTokens,
        estimatedOutput: estimateText(fullText),
        compacted,
        endpoint: settingsStore.apiConfig.baseUrl,
      })
    }

    // 本轮响应已失效(用户点停止,或同一会话又发起了新请求):不继续分段显示
    if (!chatStore.isCtxActive(ctx)) return

    // ---- "空回复"守卫:分段落字之前拦一次 ------------------------------------
    if (rejectIfUnplayable()) return

    // 分段与播放：规则在 utils/aiText，节奏在 composables/chat/segmentPlayback
    const segments = splitAiSegments(fullText, settingsStore.smartSplit)
    await playSegments({ chat: chatStore, appendStaged }, ctx, segments, pendingMood)
  }

  /**
   * 发送文本消息并触发 AI 回复
   *
   * 先锁会话，再取历史（可能触发智能总结，最长几十秒），最后才落用户消息。
   *
   * @throws API 未配置时抛出，由调用方引导用户去设置
   */
  async function sendAndWaitForAi(text: string): Promise<void> {
    // 第一个 await 之前锁定：总结期间玩家切走，人设 / 历史 / 写入位置仍须是这一段
    const target = lockTarget()
    if (!target) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 获取历史并按模式决定是否裁剪(custom 模式返回 undefined,见 planHistory)
    const rawHistory = chatStore.getChatHistory(target.sub)
    const trimmedHistory = await planHistory(rawHistory, settingsStore, chatStore, target.sub)

    // 根据模式构建请求参数
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    let backendInput: BackendInput | undefined
    let summaryHistory: Array<{ side: 'other' | 'mine'; text: string; image?: string }> | undefined

    if (isBackend) {
      // 后端模式:构建 backendInput(历史必须实打实给出,后端不读本地 store)
      backendInput = { message: text, history: trimmedHistory ?? rawHistory }
    } else {
      // 非后端模式:传递裁剪结果(custom 模式为 undefined → 由内部压缩后现取)
      summaryHistory = trimmedHistory
    }

    // 等待期间那段会话可能已位移(删了别的对话)或被删掉:按对象找回它现在的位置。
    // 找不回来 = 这段对话已经没了,什么都不写(总好过写进别人的对话)
    const sub = resolveTargetSub(target)
    if (sub === null) return

    // 1. 添加用户消息(含上下文历史同步),记录其 id 供错误重试使用
    const userMsg = chatStore.sendUserMessage(text, sub)

    // 2. 触发 AI 响应(目标仍锁定同一个会话对象,由 triggerAiResponse 再解析一次)
    await triggerAiResponse(backendInput, userMsg?.id ?? undefined, summaryHistory,
      undefined, undefined, { sub, conv: target.conv })
  }

  /**
   * 群聊「指定发言」：让被点名的角色单独说一次
   *
   * 不追加用户消息，只把说话人换成该角色。后端模式下 message 传空串表示「没有新话题，
   * 继续」；若将来后端要专门的群聊协议，这里是唯一对接点。
   */
  async function speakAsCharacter(name: string, avatar: string): Promise<void> {
    const target = lockTarget()
    if (!target) return

    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    const rawHistory = chatStore.getChatHistory(target.sub)
    const trimmedHistory = await planHistory(rawHistory, settingsStore, chatStore, target.sub)
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'

    const backendInput: BackendInput | undefined = isBackend
      ? { message: '', history: trimmedHistory ?? rawHistory }
      : undefined
    const summaryHistory = isBackend ? undefined : trimmedHistory

    await triggerAiResponse(backendInput, undefined, summaryHistory, { name, avatar },
      undefined, target)
  }

  /**
   * 图片消息发出后触发 AI 回复
   *
   * 图片由 store.sendImage 落库（含上下文同步），这里只负责触发。
   */
  async function respondAfterImage(): Promise<void> {
    // 先锁会话：非后端模式下还要等智能总结，期间切走会拿错历史
    const target = lockTarget()
    if (!target) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 获取历史(图片消息已写入 contextHistory)
    const rawHistory = chatStore.getChatHistory(target.sub)

    // 根据模式构建请求参数
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    let backendInput: BackendInput | undefined
    let summaryHistory: Array<{ side: 'other' | 'mine'; text: string; image?: string }> | undefined

    if (isBackend) {
      // 后端模式:图片消息保留在 history 中(让后端能识别图片),仅截取最近 50 条
      const trimmed = rawHistory.slice(-BACKEND_HISTORY_LIMIT)
      backendInput = {
        message: '[图片]',
        history: trimmed,
      }
    } else {
      // 非后端模式:按模式裁剪(custom 模式返回 undefined → 由内部压缩后现取)
      summaryHistory = await planHistory(rawHistory, settingsStore, chatStore, target.sub)
    }

    // 图片消息已由 sendImage 添加,直接触发 AI 响应(定位刚发送的图片消息 id)
    const lastMine = [...target.conv.messages].reverse().find((m) => m.side === 'mine')
    await triggerAiResponse(backendInput, lastMine?.id, summaryHistory, undefined, undefined, target)
  }

  /**
   * 重新生成（错误气泡按钮与长按菜单共用）
   *
   * 后端模式把 message 与 history 分开传，图片消息则保留条目在 history 里让后端能识别。
   */
  async function regenerate(userMsgId: number): Promise<void> {
    // 重新生成同样要等总结 API：期间切走会让「重生成某条」落到别的会话（那边没这个 id）
    const target = lockTarget()
    if (!target) return
    const userMsg = target.conv.messages.find((m) => m.id === userMsgId)
    if (!userMsg) return

    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    const isImage = !!userMsg.image

    if (isBackend) {
      // 后端模式:message 与 history 分离
      let history = chatStore.getChatHistory(target.sub)
      if (!isImage) {
        // 文字消息:移除末尾的用户消息条目(与正常发送流程一致:message 与 history 分离)
        if (history.length > 0 && history[history.length - 1].side === 'mine') {
          history = history.slice(0, history.length - 1)
        }
      }
      // 图片消息:保留图片条目在 history 中(与 respondAfterImage 行为一致,让后端能识别图片)
      const trimmed = await applySmartSummary(history, settingsStore, chatStore, target.sub)
      await triggerAiResponse(
        { message: isImage ? '[图片]' : userMsg.text, history: trimmed },
        userMsgId,
        undefined,
        undefined,
        // 关键：新回复插回这条用户消息之后（prepareRegenerate 已删掉旧回复），
        // 否则会 append 到对话末尾 —— 重新生成第 1 条却跑到第 3 条下面。
        userMsgId,
        target,
      )
    } else {
      // 非后端模式:用户消息已在 contextHistory 中,按模式裁剪后重新触发
      // (custom 模式返回 undefined → 由内部压缩后现取,否则压缩结果会被盖掉)
      const rawHistory = chatStore.getChatHistory(target.sub)
      const summaryHistory = await planHistory(rawHistory, settingsStore, chatStore, target.sub)
      await triggerAiResponse(undefined, userMsgId, summaryHistory, undefined, userMsgId, target)
    }
  }

  /**
   * 按需拉取单聊推荐回复
   *
   * 一段对话只生成一次：结果随对话存进 cards，最后一条消息没变就不再打 API。
   * 失败 / 开关关闭 / 无会话都返回 false —— 推荐只是输入辅助，不因此报错。
   *
   * @param force 忽略缓存强制重生成（「换一批」这类显式操作用）
   */
  async function fetchSuggestions(force = false): Promise<boolean> {
    // 「AI 推荐回复」实验性开关关闭时按钮本就不渲染,这里再兜一层
    if (!settingsStore.choicesEnabled) return false
    const sub = chatStore.activeSub
    if (sub === null) return false
    const conv = chatStore.conversations[sub]
    if (!conv) return false

    // 已有缓存且对话没往前走 → 直接用,不重复生成
    const tail = chatStore.tailMessageId()
    if (!force) {
      const cached = chatStore.getConversationSuggestions()
      if (cached && cached.items.length > 0 && cached.forMessageId === tail) {
        chatStore.setPendingChoices(cached.items.map((label) => ({ label })))
        return true
      }
    }

    const characterName = conv.name
    const history = chatStore.getChatHistory()
    // custom 模式必须完全绕开后端网关
    const isCustom = settingsStore.apiConfig.apiMode === 'custom'
    try {
      const items = isCustom
        ? await requestCustomSuggestions(settingsStore, characterName, history)
        : await fetchBackendSuggestions({
            characterId: CHARACTER_ID_MAP[characterName] || '',
            character: characterName,
            history,
            useNewPrompt: settingsStore.useNewPrompt,
            immersiveMode: settingsStore.immersiveMode,
          })
      // 等待期间开关可能被关掉 / 会话可能被切换:以此刻的状态为准。
      // 必须比一次 sub:store 的 activeSub watch 只在"切换那一刻"换过一次列表,
      // 迟到的结果若直接写入,会把别的会话的推荐显示到当前会话的面板里。
      if (!settingsStore.choicesEnabled) return false
      if (chatStore.activeSub !== sub) return false
      // 写入这段对话的持久化数据(空结果不写,下次打开还能重试)
      chatStore.setConversationSuggestions(items, tail)
      return items.length > 0
    } catch (e) {
      // 推荐失败只记日志,不弹错误、不影响聊天
      devWarn('[chat] 拉取推荐失败:', e)
      return false
    }
  }

  /** 中止当前 AI 响应(中止流式请求 + 停止后续分段显示) */
  function abort() {
    chatStore.abortAiResponse()
  }

  return {
    sendAndWaitForAi,
    speakAsCharacter,
    respondAfterImage,
    regenerate,
    fetchSuggestions,
    abort,
  }
}
