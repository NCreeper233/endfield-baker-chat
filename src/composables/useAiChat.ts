// =============================================================================
// AI 聊天编排 composable(useAiChat)
// -----------------------------------------------------------------------------
// 连接 store(chat) + settings + llm,编排完整的 AI 聊天流程:
//   1. 用户发送消息 → store.sendUserMessage
//   2. 构建 LLM 消息(系统提示词 + 角色提示词 + 历史消息)
//   3. 创建 AI 占位消息 → store.beginAiResponse(loading 动画)
//   4. 流式调用 API,缓冲完整回复(loading 动画持续)
//   5. 回复完成 → 按 \n 分段,逐段顺序显示:
//      - 第一段填入当前 loading 气泡 → finishAiSegment
//      - 后续段:短暂假 loading → 新气泡显示该段 → finishAiSegment
//      - 最后一段:finishAiResponse(结束整体响应)
//
// 【响应上下文】beginAiResponse 会返回本轮独立的 ctx(锁定目标会话 + 说话人),
// 后续所有写入都必须显式传入它。这是修复"串台"的关键:
//   - 等待回复期间切换会话 / 多会话并发请求,回复仍只写回它自己发起的会话
//   - 头像与角色名取自 ctx,不会被其他会话的请求覆盖
//   - 用 isCtxActive(ctx) 判断本轮是否已失效(用户点停止,或同会话又发起了
//     新请求):失效后迟到的内容一律丢弃,不污染新请求
// =============================================================================

import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { streamChat, buildMessages } from '../utils/llm'
import {
  buildBackendRequest,
  fetchBackendReply,
  fetchBackendReplyStream,
  fetchBackendSuggestions,
  BackendStreamUnavailableError,
  BACKEND_HISTORY_LIMIT,
  CHARACTER_ID_MAP,
} from '../utils/backend'
import { EMPHASIS_RULE } from '../constants/prompts'
import { splitAiSegments } from '../utils/aiText'
import { stripImmersive, ImmersiveFilter } from '../utils/immersive'
import {
  customChatCompletion,
  parseSuggestionList,
  SUGGEST_SYSTEM_SINGLE,
} from '../utils/customApi'
import { requestSummary } from '../utils/summary'
import { useUsageStore } from '../stores/usage'
import { useContextCompaction } from './useContextCompaction'
import { useReplyReveal } from './useReplyReveal'
import { estimateEntry, estimateMessages, estimateText } from '../utils/tokenEstimate'
import type { NormalizedUsage } from '../utils/usage'
import { devWarn } from '../utils/logger'

/**
 * 智能总结触发比例（占上下文窗口的比例）
 *
 * 0.8 —— 达到上下文窗口的 80% 就总结掉 80% 以外的历史，
 * **剩下 20% 专门留给 RAG 语料库**（它注入的长度不固定，必须在预算里预留）。
 */
const SUMMARY_TRIGGER_RATIO = 0.8

/**
 * 固定提示词的长度（token）—— **写死在前端**
 *
 * 这是"不参与总结、每轮都原样重发"的那部分：
 * 后端内置世界观 + 角色设定 + 回复风格规则 + 前端固定 system 提示词。
 * 实测前端 FIXED_SYSTEM_PROMPT ≈ 639 token，加上后端角色设定与规则，
 * 取整为 3000 作为保守基线（偏大更安全：会稍早触发总结，不会撑爆窗口）。
 *
 * 用户可在「智能总结 → 上下文总长」里改窗口大小；本基线是常量。
 */
const FIXED_PROMPT_TOKENS = 3000

/**
 * 上下文窗口缺省值（智能总结未单独配置时使用）
 *
 * Agnes 2.5 Flash 官方上下文窗口 = 512K。
 */
const DEFAULT_SUMMARY_CONTEXT_WINDOW = 512_000

/**
 * 从后端返回的 usage 里取"本轮**输出** token"
 *
 * 为什么只累计输出 token：对话历史里逐轮累积增长的就是模型生成的部分；
 * 输入 token 每轮都会把整段历史重新算一遍，累加它无法反映历史长度。
 *
 * 后端统一返回 { prompt_tokens, completion_tokens, total_tokens, model, api_id }。
 */
function pickOutputTokens(usage?: BackendUsageLike): number {
  if (!usage || typeof usage !== 'object') return 0
  const c = Number(usage.completion_tokens)
  return Number.isFinite(c) && c > 0 ? c : 0
}

/** 后端 usage 的最小形状（避免在此处引入 backend.ts 的类型耦合） */
interface BackendUsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** 聊天历史条目(与 chat store 的 contextHistory 形状一致) */
type ChatHistoryEntry = { side: 'other' | 'mine'; text: string; image?: string }

/** 后端模式输入:当前消息 + 发送前截取的历史(不含当前输入) */
interface BackendInput {
  message: string
  history: ChatHistoryEntry[]
}

/** 延迟工具(ms):分段显示模拟"对方正在输入"的节奏 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 智能总结处理（2026-09-30 按用户要求重写为**纯 token 判据**）
 *
 * 关闭时：完全保持旧行为 —— 强制截断最近 50 条（25 轮）。
 * 开启时：不看条数（可 >50 / <50 / =50），而是比较
 *     「固定提示词长度(FIXED_PROMPT_TOKENS) + 本会话累计输出 token」
 *   与「Agnes 2.5 Flash 上下文窗口 × 80%」：
 *     · 未达 80% → 历史整段上传，一条都不截断
 *     · 达到 80% → 从最早开始把 80% 以外的历史全部总结成一条摘要插到最前
 *   剩下 20% 预算留给 RAG 语料库（其注入长度不固定）。
 *
 * 失败时降级：返回保留段原始消息（不插摘要），并在控制台记录错误。
 */
async function applySmartSummary(
  history: ChatHistoryEntry[],
  settingsStore: ReturnType<typeof useSettingsStore>,
  chatStore: ReturnType<typeof useChatStore>,
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
  // 判据（取两者较大值，避免"估算偏差导致该总结却不动"）：
  //   ① 固定提示词长度 + 本会话累计输出 token（后端 usage.completion_tokens 累加）
  //   ② 固定提示词长度 + 本地估算的待发送历史体积
  // 任一达到「上下文窗口 × 80%」就总结；剩下 20% 留给 RAG 语料库。
  const sessionOutputTokens = chatStore.getSessionOutputTokens()
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

  // 需要总结：从最新往回保留，直到"保留段"塞进 80% 预算；更早的一律总结掉。
  //
  // 为什么要有 fallback：累计输出 token 刚到 80% 的这一刻，本地对历史的估算
  // 有可能还略低于预算（估算器与真实 tokenizer 有偏差）。若此时按估算一条都不
  // 总结，就会出现"已经该总结了却什么都没做"，下一轮立刻又触发。
  // 所以只要判定要总结，**至少**把最后一条之前的历史压成摘要（保留最后一条，
  // 让对话连续性不被打断）。
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
    chatStore.resetSessionOutputTokens()
    return [summaryEntry, ...recent]
  } catch (err) {
    // 总结失败:降级为最近 50 条原始消息,不阻断聊天
    devWarn('[summary] 智能总结失败,降级为最近 50 条:', err)
    return recent
  }
}

/**
 * 按当前模式决定"要传给 triggerAiResponse 的已裁剪历史"
 *
 * @returns 已裁剪的历史;返回 **undefined** 表示不接管 ——
 *          由 triggerAiResponse 在上下文压缩之后再从 store 现取一次。
 *
 * 为什么自定义 API 模式必须返回 undefined(而不是"原样返回一份完整历史"):
 *   压缩会改写 contextHistory,而压缩发生在 triggerAiResponse **内部**。
 *   若在这里就把历史快照取好传进去,压缩的结果永远用不上 ——
 *   请求里发出去的仍是压缩前那一份,历史会一路涨到超预算被服务端拒绝。
 *
 * 为什么自定义模式不能用 applySmartSummary 的 50 条滑动窗口:
 *   每轮从头部丢一两条,req(N) 就不再是 req(N+1) 的前缀,服务端缓存除两条
 *   固定 system 之外全部失效 —— 这正是引入用量/缓存机制要消除的事。
 *   自定义模式的体积控制改由 useContextCompaction 按 token 预算"批次化"
 *   压缩承担(未超预算时一条都不丢)。
 */
async function planHistory(
  history: ChatHistoryEntry[],
  settingsStore: ReturnType<typeof useSettingsStore>,
  chatStore: ReturnType<typeof useChatStore>,
): Promise<ChatHistoryEntry[] | undefined> {
  if (settingsStore.apiConfig.apiMode === 'custom') return undefined
  return applySmartSummary(history, settingsStore, chatStore)
}

/** 群聊里"让某个指定角色发言"时的说话人覆盖 */
export interface SpeakerOverride {
  name: string
  avatar: string
}

/**
 * 计算固定前缀指纹(djb2 变体)
 *
 * 用于检测"世界观 / 角色提示词被改动"——前缀一变,服务端缓存必然全部失效,
 * 面板据此显示提示而非让用户误以为是缓存没生效。
 */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/**
 * custom 模式的单聊「AI 推荐回复」(前端本地实现,不走后端网关)
 *
 * 【审计修复 2026-10-04】此前 useAiChat.fetchSuggestions 无论什么模式都调用
 * fetchBackendSuggestions(网关 /chat/suggestions)—— 在 apiMode === 'custom'
 * 时这属于"偷偷走后端"。自定义模式必须全程只用用户自己的 API,
 * 因此这里用 customApi 直连实现同一功能。
 *
 * 提示词口径与后端 prompt_core.build_suggestions 对齐:
 *   【角色】+【角色设定摘要】+【最近对话 12 条】→ 3 条候选(JSON 数组)。
 * 失败时抛错,由调用方降级为"暂无推荐"(推荐只是输入辅助)。
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
  // 角色设定摘要:与单聊请求同一条角色提示词(沉浸式已在其中处理)
  const persona = settingsStore.getCharacterMessage(who).slice(0, 2000)

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

  /**
   * 触发 AI 流式回复(内部公共逻辑)
   *
   * 从当前对话读取角色信息 + 历史消息,构建请求。
   * - 后端模式(传入 backendInput):只传递原始数据(message/history/character),
   *   提示词与处理全部由后端 Python 脚本负责,一次性拿到 { reply } 后分段显示。
   * - 其他模式:沿用原有 system + 角色提示词 + OpenAI 格式流式调用。
   *
   * 流式缓冲完整回复后,按换行分段,逐段创建气泡顺序显示。
   * 每段之间有短暂假 loading 动画,模拟"逐条发送"的聊天节奏。
   *
   * @param backendInput   后端模式输入(非后端模式为 undefined)
   * @param userMsgId      用户消息 id(用于错误重试)
   * @param summaryHistory 经过智能总结的 history(非后端模式使用;为 undefined 时从 store 获取)
   * @param speakerOverride 指定说话人(群聊"让某角色发言一次"用;缺省 = 会话名,
   *                        单聊行为完全不变)
   */
  async function triggerAiResponse(
    backendInput?: BackendInput,
    userMsgId?: number,
    summaryHistory?: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
    speakerOverride?: SpeakerOverride,
    /**
     * 重新生成场景：新回复插到这条消息之后（原位置），而不是追加到末尾
     *
     * 由 regenerate() 传入「被重新生成那一轮的用户消息 id」。
     * 常规发送不传 → 走追加行为，与改动前完全一致。
     */
    insertAfterMessageId?: number,
  ): Promise<void> {
    if (chatStore.activeSub === null) return
    const conv = chatStore.conversations[chatStore.activeSub]
    if (!conv) return
    // 群聊的会话名是群名(如「A、B和C的群聊」),不是角色名;
    // 有 speakerOverride 时必须用被点名的角色,否则会拿群名去查角色人设。
    const characterName = speakerOverride?.name ?? conv.name

    // 构建角色头像/名称
    const meta = chatStore.currentConversationMeta
    const speakerName = characterName
    const speakerAvatar = speakerOverride?.avatar ?? meta?.avatar ?? ''

    // 创建第一个 loading 气泡,并锁定本轮响应上下文:
    // 目标会话与说话人在此刻固定,之后切换会话 / 其他会话并发请求都不会串台
    const ctx = chatStore.beginAiResponse(
      speakerName, speakerAvatar, undefined, insertAfterMessageId)
    if (!ctx) return

    // ---- 请求并缓冲完整回复(loading 动画持续,不实时显示文字) -------------
    let fullText = ''
    // 后端模式可选返回的心情表情 token(如 sns_emoji_001),缺失为 undefined
    let pendingMood: string | undefined
    // 服务商上报的用量(未上报时保持 null → 回退本地估算)
    let capturedUsage: NormalizedUsage | null = null
    // 后端上报的本轮**输出** token（用于"会话累计输出 token"→ 智能总结触发判断）
    let backendOutputTokens = 0
    // 本地估算的输入 token(未乘校准比值,由 usage store 统一校准)
    let estimatedInputTokens = 0
    // 本轮是否发生了上下文压缩(压缩会使服务端缓存前缀失效)
    let compacted = false
    // 本轮回复是否已经通过 SSE **逐字实时**落进气泡(true 时跳过下面的分段播放)
    let streamedLive = false

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
                  const roleWithRule = role
                    ? `${role}\n\n${EMPHASIS_RULE}`
                    : EMPHASIS_RULE
                  return fixed ? `${fixed}\n\n【角色设定】\n${roleWithRule}` : roleWithRule
                })(),
            think: settingsStore.thinkEnabled,
            // v4: 实验性功能-强制每条搜索
            // 只走 RAG 时后端根本不联网 → 此时**不带该字段**，避免无意义参数
            // （该开关现在只是「联网搜索」的子选项，见实验性功能页）
            forceSearch: settingsStore.webSearchEnabled ? settingsStore.forceSearch : undefined,
            // v7: 实验性功能-沉浸式对话模式(2026-10-03 语义修正:true=后端禁止括号动作,只留台词)
            immersiveMode: settingsStore.immersiveMode,
            // 实验性功能-使用新版提示词(后端按 characters_v2/ 加载)
            useNewPrompt: settingsStore.useNewPrompt,
            // 知识源：默认关闭 = 不带该字段（后端走 RAG 语料库）；
            // 打开「联网搜索（替代 RAG）」时显式传 false。
            useRag: settingsStore.webSearchEnabled ? false : undefined,
          },
        )
        // 本轮中止信号(SSE 与一次性请求共用同一个)
        const signal = chatStore.getAiSignal(ctx)

        if (settingsStore.sseStreaming) {
          // ---- 实验性:SSE 逐字流式(分条 + 分拍,"能播就先播") ----------------
          // 为什么不把 delta 原样直出:上游生成很快(实测一封 136 字的回复,95 个
          // 增量段全部在 1.03 秒内到达),直出在视觉上等于"一次性全出",反而丢掉
          // 了关闭 SSE 时逐拍显示的手感。
          // 做法:delta 先进缓冲;一旦缓冲里能切出**完整的一段**(splitAiSegments
          // 返回 ≥2 段 ⇒ 第一段已经定稿,边界不会再变),就立刻用与关闭 SSE 时
          // 完全相同的那套机制播出去(appendStaged + 段间停顿 + "正在输入"),
          // 剩下的段在 done 之后按同一套规则播完 —— 观感一致,只是第一段不必等
          // 整封回复就能出现。
          let revealBuf = ''
          let streamDone = false
          let pacerStop = false
          let playedCount = 0

          /** 播出一段(节奏与关闭 SSE 时的分段播放完全一致) */
          const playSegment = async (text: string, isLast: boolean): Promise<void> => {
            if (!text) return
            if (playedCount === 0) {
              // 首段:填入当前的 loading 气泡(mood 此刻多半还没到,收尾时补写)
              chatStore.setPendingAiMood(pendingMood, ctx)
              await appendStaged(text, ctx)
            } else {
              // 后续段:先停顿,再亮"头像 + 加载气泡",再落字
              await delay(600 + Math.random() * 400)
              if (!chatStore.isCtxActive(ctx)) return
              chatStore.beginAiSegment(ctx)
              await delay(900 + Math.random() * 600)
              if (!chatStore.isCtxActive(ctx)) return
              await appendStaged(text, ctx)
            }
            playedCount++
            if (!chatStore.isCtxActive(ctx)) return
            if (isLast) chatStore.finishAiResponse(ctx)
            else chatStore.finishAiSegment(ctx)
          }

          const pacer = (async () => {
            while (!pacerStop) {
              if (!chatStore.isCtxActive(ctx)) return
              if (revealBuf.length === 0) {
                if (streamDone) return
                await delay(30)
                continue
              }
              // 能切出 ≥2 段 ⇒ 第一段已经定稿(后面还有内容,边界不会再变)
              const segs = splitAiSegments(revealBuf, settingsStore.smartSplit)
              if (segs.length >= 2) {
                const idx = revealBuf.indexOf(segs[1])
                if (idx > 0) {
                  const head = segs[0]
                  revealBuf = revealBuf.slice(idx)
                  await playSegment(head, false)
                  continue
                }
              }
              if (streamDone) return
              await delay(30)
            }
          })()

          try {
            const result = await fetchBackendReplyStream(
              settingsStore.apiConfig,
              request,
              {
                signal,
                onDelta: (text) => {
                  revealBuf += text
                },
              },
            )
            fullText = result.reply
            // 可选 mood 字段(token 形式,如 sns_emoji_001);缺失时为 undefined
            pendingMood = result.mood
            backendOutputTokens = pickOutputTokens(result.usage)
            streamedLive = true
          } catch (err) {
            // 收到任何 delta 之前就失败(旧后端没有 /chat/stream、网络、非 2xx、
            // 响应不是 event-stream):回退到原来的非流式请求一次,用户无感。
            // 此时缓冲仍为空(揭示器一个字都没写过),回退后**照常走下面的分段
            // 播放**,与开关关闭时完全一致。
            if (!(err instanceof BackendStreamUnavailableError)) {
              pacerStop = true
              // 已收到的半截内容照常落进气泡(改造前 delta 是直出的,不能因为
              // 改成"节奏化播出"就把用户已经等到的字丢掉),再抛错交给错误气泡
              if (revealBuf) {
                chatStore.appendAiChunk(revealBuf, ctx)
                revealBuf = ''
              }
              throw err
            }
            const fallback = await fetchBackendReply(
              settingsStore.apiConfig,
              request,
              signal,
            )
            fullText = fallback.reply
            pendingMood = fallback.mood
            backendOutputTokens = pickOutputTokens(fallback.usage)
          } finally {
            streamDone = true
          }
          await pacer

          if (streamedLive) {
            // ---- 收尾:按权威全文补完剩余段 ----------------------------------
            // 已经播过 playedCount 段(它们的文本取自流式缓冲,定稿口径与权威分条
            // 一致);剩下的段一律以 done 帧的权威全文为准,首段气泡补上 mood。
            const finalSegs = splitAiSegments(fullText, settingsStore.smartSplit)
            const rest = finalSegs.slice(playedCount)
            chatStore.setFirstAiMood(pendingMood, ctx)
            for (let i = 0; i < rest.length; i++) {
              if (!chatStore.isCtxActive(ctx)) return
              await playSegment(rest[i], i === rest.length - 1)
            }
            if (chatStore.isCtxActive(ctx)) chatStore.finishAiResponse(ctx)
            return
          }
          // 回退路径(streamedLive 为 false):气泡里没有流式内容 → 落到下面的分段播放
        } else {
          // 开关关闭(默认):行为与改动前完全一致 —— 一次 JSON 请求拿完整回复
          const backendResult = await fetchBackendReply(
            settingsStore.apiConfig,
            request,
            signal,
          )
          fullText = backendResult.reply
          // 可选 mood 字段(token 形式,如 sns_emoji_001);缺失时为 undefined
          pendingMood = backendResult.mood
          backendOutputTokens = pickOutputTokens(backendResult.usage)
        }
      } else {
        // 原有模式:系统提示词 + 全局世界观 + 角色提示词 + 历史消息,SSE 流式调用
        // 两条 system 消息统一由 settings store 产出,保证与用量面板的统计口径一致
        const systemMessage = settingsStore.getSystemMessage()
        const characterMessage = settingsStore.getCharacterMessage(characterName)

        const isCustom = settingsStore.apiConfig.apiMode === 'custom'

        // 固定前缀指纹:用户改了世界观 / 角色提示词 → 缓存必然全部失效,
        // 面板据此给出提示,避免误判成"缓存没生效"。
        usageStore.notePrefix(hashText(`${systemMessage}\u0000${characterMessage}`))

        // custom 模式:预算检查 + 批量压缩,保证"未超预算时一条都不丢"
        // (legacy 沿用它原有的 50 条窗口 + 智能总结策略,由 summaryHistory 传入,不在此处理)
        if (isCustom) {
          compacted = (await compact(`${systemMessage}\n\n${characterMessage}`, 'auto')) !== null
        }

        // 使用经过智能总结的 history(如果提供),否则从 store 取实时历史。
        // custom 模式不传 summaryHistory → 取到的历史已含本轮输入(调用方先落消息),
        // 且顺序恒为 [system, system, ...历史] → 天然满足"前缀只追加"。
        const history = summaryHistory ?? chatStore.getChatHistory()
        const messages = buildMessages(systemMessage, characterMessage, history)

        // 本地估算(未校准),服务商未上报 usage 时由 usage store 乘以校准比值后展示
        estimatedInputTokens = estimateMessages(messages)

        // ---- 沉浸式对话的文本层过滤(custom / legacy 直连没有后端兜底) --------
        // 提示词层已在 getCharacterMessage 里处理(截掉强制括号的规则 + 追加禁止规则);
        // 这里再过一遍文本层:模型不听话时也不会漏出 (动作) / *动作*。
        // 用 ImmersiveFilter 逐增量过滤(跨 delta 保持括号状态),
        // 收尾时用一次性 stripImmersive 以权威全文兜底。
        const immersive = settingsStore.immersiveMode
        const immFilter = immersive ? new ImmersiveFilter(true) : null

        await streamChat({
          config: settingsStore.apiConfig,
          messages,
          signal: chatStore.getAiSignal(ctx),
          requestUsage: settingsStore.apiConfig.requestUsage,
          // 思考模式:仅 custom 模式透传(legacy 内置端点不在该协议内,由 llm.ts 忽略)
          think: isCustom ? settingsStore.thinkEnabled : undefined,
          onUsage: (u) => {
            capturedUsage = u
          },
          onChunk: (chunk) => {
            // 沉浸式:边收边滤(流式场景下真正的"跨增量保持状态")
            fullText += immFilter ? immFilter.feed(chunk) : chunk
          },
          onDone: (full) => {
            // 以权威全文为准再过滤一次(immersive=false 时原样返回)
            fullText = stripImmersive(full, immersive)
          },
        })
      }
    } catch (err) {
      // AbortError:用户主动中止,请求层返回空串而非抛错,此处仅兜底
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // 其他错误:创建错误占位气泡(红底 + "重新生成"按钮)。
      // 关键:错误消息只显示、绝不写入 contextHistory(不污染 AI 上下文,也不持久化)
      const errMsg = err instanceof Error ? err.message : String(err)
      chatStore.appendAiError(errMsg, userMsgId, ctx)
      return
    }

    // ---- 会话累计**输出** token（后端模式：累加后端上报的 completion_tokens） ----
    // 智能总结开启时，「固定提示词长度 + 这个累计值」达到上下文窗口的 80%
    // 就会把 80% 以外的历史全部总结掉，留 20% 给 RAG。
    if (backendInput && backendOutputTokens > 0) {
      chatStore.addSessionOutputTokens(backendOutputTokens)
    }

    // ---- 记录用量(仅非后端模式:后端模式的提示词在服务端,本地估算无意义) ----
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

    // ---- 分段 --------------------------------------------------------------
    // 规则(换行 / 左括号前切断 + 纯括号段合并)的唯一实现处是 utils/aiText,
    // 单聊与群聊共用。此处曾内联一份等价拷贝,改规则要改两处、极易走散,已合并。
    // 是否在左括号前也切,由设置项「智能消息分条」决定(默认开启)。
    const segments = splitAiSegments(fullText, settingsStore.smartSplit)

    if (segments.length === 0) {
      // 无内容:结束响应(空的 loading 气泡会被 abortAiResponse 逻辑清理)
      chatStore.finishAiResponse(ctx)
      return
    }

    // ---- 第一段:填入当前 loading 气泡 -----------------------------------
    // 后端模式的心情表情(token)随首段消息一并写入(缺失时 appendAiChunk 拿到 undefined)
    chatStore.setPendingAiMood(pendingMood, ctx)
    // 分拍写入:开启「括号描写居中」时,居中条与台词之间留出间隔(见 useReplyReveal)
    await appendStaged(segments[0], ctx)
    if (!chatStore.isCtxActive(ctx)) return

    if (segments.length === 1) {
      // 单段:直接结束
      chatStore.finishAiResponse(ctx)
      return
    }

    // 多段:完成第一段(整体响应保持进行中)
    chatStore.finishAiSegment(ctx)

    // ---- 后续段:逐条顺序显示 ---------------------------------------------
    for (let i = 1; i < segments.length; i++) {
      // 本轮已失效检查(用户点停止,或同一会话又发起了新请求)
      if (!chatStore.isCtxActive(ctx)) break

      // 段间延迟(模拟"对方正在输入"的节奏)
      await delay(600 + Math.random() * 400)
      if (!chatStore.isCtxActive(ctx)) break

      // 复用同一上下文重新开启 loading 气泡
      // (不可改用 beginAiResponse:那会生成新上下文并让本轮被判为陈旧)
      chatStore.beginAiSegment(ctx)

      // 假 loading 动画展示(模拟"对方正在输入"的节奏)
      await delay(900 + Math.random() * 600)
      if (!chatStore.isCtxActive(ctx)) break

      // 填入本段文字(同样按部件分拍)
      await appendStaged(segments[i], ctx)
      if (!chatStore.isCtxActive(ctx)) break

      // 最后一段:结束整体响应;中间段:保持响应状态
      if (i < segments.length - 1) {
        chatStore.finishAiSegment(ctx)
      } else {
        chatStore.finishAiResponse(ctx)
      }
    }

    // 如果循环中途 break(用户中止),确保状态清理
    if (chatStore.isCtxActive(ctx)) {
      chatStore.finishAiResponse(ctx)
    }
  }

  /**
   * 发送文本消息并触发 AI 流式回复
   *
   * 完整流程:
   *   1. 检查 API 配置(未配置时抛出错误,由调用方引导用户配置)
   *   2. 获取历史并应用智能总结(超 50 条时)
   *   3. 后端模式:构建 backendInput
   *   4. 其他模式:传递 summaryHistory 给 triggerAiResponse
   *   5. 添加用户消息并触发 AI 响应
   *
   * @param text 用户输入文本
   * @throws API 未配置时抛出错误
   */
  async function sendAndWaitForAi(text: string): Promise<void> {
    if (chatStore.activeSub === null) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 获取历史并按模式决定是否裁剪(custom 模式返回 undefined,见 planHistory)
    const rawHistory = chatStore.getChatHistory()
    const trimmedHistory = await planHistory(rawHistory, settingsStore, chatStore)

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

    // 1. 添加用户消息(含上下文历史同步),记录其 id 供错误重试使用
    const userMsg = chatStore.sendUserMessage(text)

    // 2. 触发 AI 响应
    await triggerAiResponse(backendInput, userMsg?.id ?? undefined, summaryHistory)
  }

  /**
   * 群聊:让「指定发言」里选中的角色单独说一次
   *
   * 与 sendAndWaitForAi 的区别:这里**不追加用户消息** —— 只是在群里催
   * 被点名的角色发一条,所以直接调 triggerAiResponse 并用 speakerOverride
   * 把说话人换成该角色。
   *
   * 说明:群聊的后端协议尚未最终确定,这里复用的是单聊那套请求构造
   * (角色人设 / 历史 / 实验性开关),后端模式下 message 传空串表示
   * "没有新话题,继续"。若后端需要专门的群聊协议,这里是唯一的对接点。
   */
  async function speakAsCharacter(name: string, avatar: string): Promise<void> {
    if (chatStore.activeSub === null) return

    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    const rawHistory = chatStore.getChatHistory()
    const trimmedHistory = await planHistory(rawHistory, settingsStore, chatStore)
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'

    const backendInput: BackendInput | undefined = isBackend
      ? { message: '', history: trimmedHistory ?? rawHistory }
      : undefined
    const summaryHistory = isBackend ? undefined : trimmedHistory

    await triggerAiResponse(backendInput, undefined, summaryHistory, { name, avatar })
  }

  /**
   * 图片发送后触发 AI 流式回复
   *
   * 图片消息已由 store.sendImage 添加(含上下文历史同步),
   * 此方法仅负责触发 AI 响应流程。
   *
   * @throws API 未配置时抛出错误
   */
  async function respondAfterImage(): Promise<void> {
    if (chatStore.activeSub === null) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 获取历史(图片消息已写入 contextHistory)
    const rawHistory = chatStore.getChatHistory()

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
      summaryHistory = await planHistory(rawHistory, settingsStore, chatStore)
    }

    // 图片消息已由 sendImage 添加,直接触发 AI 响应(定位刚发送的图片消息 id)
    const conv2 = chatStore.conversations[chatStore.activeSub]
    const lastMine = conv2 ? [...conv2.messages].reverse().find((m) => m.side === 'mine') : undefined
    await triggerAiResponse(backendInput, lastMine?.id, summaryHistory)
  }

  /**
   * 重新生成(错误气泡按钮 / 长按菜单"重新生成"共用)
   *
   * 以指定的用户消息为"本轮输入",重新触发 AI:
   * - 后端模式:message = 用户消息文本(图片消息为 "[图片]"),
   *   history = 当前 contextHistory 移除该用户消息条目(错误不写历史、AI 回复已由
   *   prepareRegenerate 清理,故此时 history 末尾即该用户消息)
   * - 其他模式:应用智能总结后传递给 triggerAiResponse
   *
   * @param userMsgId 本轮用户消息 id
   */
  async function regenerate(userMsgId: number): Promise<void> {
    if (chatStore.activeSub === null) return
    const conv = chatStore.conversations[chatStore.activeSub]
    const userMsg = conv.messages.find((m) => m.id === userMsgId)
    if (!userMsg) return

    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    const isImage = !!userMsg.image

    if (isBackend) {
      // 后端模式:message 与 history 分离
      let history = chatStore.getChatHistory()
      if (!isImage) {
        // 文字消息:移除末尾的用户消息条目(与正常发送流程一致:message 与 history 分离)
        if (history.length > 0 && history[history.length - 1].side === 'mine') {
          history = history.slice(0, history.length - 1)
        }
      }
      // 图片消息:保留图片条目在 history 中(与 respondAfterImage 行为一致,让后端能识别图片)
      const trimmed = await applySmartSummary(history, settingsStore, chatStore)
      await triggerAiResponse(
        { message: isImage ? '[图片]' : userMsg.text, history: trimmed },
        userMsgId,
        undefined,
        undefined,
        // 关键：新回复插回这条用户消息之后（prepareRegenerate 已删掉旧回复），
        // 否则会 append 到对话末尾 —— 重新生成第 1 条却跑到第 3 条下面。
        userMsgId,
      )
    } else {
      // 非后端模式:用户消息已在 contextHistory 中,按模式裁剪后重新触发
      // (custom 模式返回 undefined → 由内部压缩后现取,否则压缩结果会被盖掉)
      const rawHistory = chatStore.getChatHistory()
      const summaryHistory = await planHistory(rawHistory, settingsStore, chatStore)
      await triggerAiResponse(undefined, userMsgId, summaryHistory, undefined, userMsgId)
    }
  }

  /**
   * 按需拉取单聊「AI 推荐回复」(与群聊 useGroupChat.fetchSuggestions 对齐)
   *
   * **一段对话只生成一次**:推荐随对话一起存进 cards(见
   * chatStore.setConversationSuggestions),只要最后一条消息没变,反复点开面板
   * 都直接复用缓存,不再打 API;重开软件也从对话数据里读回来。
   * 玩家又发了消息(对话状态变了)才会重新生成一次。
   *
   * 拉取失败 / 开关关闭 / 无会话都返回 false —— 推荐只是输入辅助,绝不因此报错,
   * 面板显示"暂无推荐选项"的空状态即可。
   *
   * @param force 忽略缓存强制重新生成(留给"换一批"这类显式操作)
   * @returns 是否拿到了候选
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
    // 与单聊 /chat 请求同一口径的历史(只取有上下文的聊天记录;函数内部再截 50 条)
    const history = chatStore.getChatHistory()
    // custom 模式必须完全绕开后端网关(审计修复,见 requestCustomSuggestions)
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
