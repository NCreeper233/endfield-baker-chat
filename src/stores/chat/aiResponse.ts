// aiResponse —— 一次 AI 回复从发起到收尾的全部运行时状态
// 「串台」防护的核心：token 判失效 + 会话对象判归属。刻意不依赖 Pinia，
// 宿主状态由外部注入，因此可脱离 store 单独驱动与测试。

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ChatMessage, Conversation } from '../../types/chat'
import {
  findAiInsertIndex,
  nextMessageId,
  removeFromContextHistory,
} from '../../domain/chat/conversation'

export interface AiResponseCtx {
  /** 请求序号，用于识别陈旧响应 */
  token: number
  /** 发起时锁定的会话下标 */
  sub: number
  /**
   * 发起时锁定的**会话对象**
   *
   * 下标只是位置不是身份：删一段、建一段、导入恢复都会让同一下标指向别的会话。
   * 只比 token 的话，位移后的旧 ctx 依然「有效」，内容会落进另一个角色的对话。
   */
  lockedConversation?: Conversation
  speaker: { name: string; avatar: string }
  /** 本段正在追加的目标消息 id */
  messageId: number | null
  /** 本轮第一条消息 id：SSE 下首段比 done 帧先落字，mood 要靠它回填 */
  firstMessageId: number | null
  controller: AbortController
  /** 待写入下一条消息的心情表情 token */
  mood?: string
  /**
   * 新回复插到这条消息**之后**，仅重新生成时设置
   *
   * 缺省为追加到末尾。设错的表现是「重新生成第 1 条，新消息却出现在第 3 条下面」。
   */
  insertAfterMessageId?: number
  /** 本轮最后一条已落位的 AI 消息 id，多段回复从它继续往后排 */
  lastInsertedId?: number
}

export interface AiResponseStateDeps {
  /** 扁平化后的全部子对话，下标即全局子卡索引 */
  conversations: ComputedRef<Conversation[]>
  activeSub: Ref<number | null>
  /** 当前会话「我」的署名与头像；群聊扮演角色时署该角色名 */
  selfIdentity: (targetSub?: number) => { name: string; avatar: string }
}

/** 每次调用产生独立的 token 序列与上下文表，可并存多份互不干扰 */
export function createAiResponseState(deps: AiResponseStateDeps) {
  const { conversations, activeSub } = deps

  let aiReqSeq = 0
  /** 各会话当前活跃的响应上下文（内部机制，无需响应式） */
  const aiCtxBySub = new Map<number, AiResponseCtx>()
  const aiLoadingSubs = ref<number[]>([])
  const aiRespondingSubs = ref<number[]>([])
  /** 本轮已落过内容的会话：区分「首条未到」与「分条续段」的加载态 */
  const aiEmittedSubs = ref<number[]>([])
  const aiSpeakers = ref<Record<number, { name: string; avatar: string }>>({})

  function addSub(arr: number[], sub: number) {
    if (!arr.includes(sub)) arr.push(sub)
  }

  function removeSub(arr: number[], sub: number) {
    const i = arr.indexOf(sub)
    if (i !== -1) arr.splice(i, 1)
  }

  /** 整体替换对象以触发响应式 */
  function setAiSpeaker(sub: number, speaker: { name: string; avatar: string } | null) {
    const next = { ...aiSpeakers.value }
    if (speaker) next[sub] = speaker
    else delete next[sub]
    aiSpeakers.value = next
  }

  function currentAiCtx(): AiResponseCtx | undefined {
    const sub = activeSub.value
    if (sub === null) return undefined
    return aiCtxBySub.get(sub)
  }

  /** 显式传入优先，缺省取当前会话 */
  function resolveCtx(ctx?: AiResponseCtx | null): AiResponseCtx | undefined {
    return ctx ?? currentAiCtx()
  }

  /** 上下文是否仍有效：同会话已发起新请求，或该下标已换成另一段会话 → false */
  function isCtxActive(ctx?: AiResponseCtx | null): boolean {
    if (!ctx) return false
    if (aiCtxBySub.get(ctx.sub)?.token !== ctx.token) return false
    if (ctx.lockedConversation && conversations.value[ctx.sub] !== ctx.lockedConversation) {
      return false
    }
    return true
  }

  /**
   * 作废所有在途响应
   *
   * 任何改变扁平数组结构的操作（删对话、新建子对话、建群、删群、导入恢复）都必须
   * 调用：下标含义会整体位移，不清掉的话迟到的 chunk 会写进别人的会话，
   * finish 时还会把这段写进别人的 contextHistory。先 abort 再清态。
   */
  function invalidateAllAiCtx(): void {
    aiCtxBySub.forEach((ctx) => {
      try {
        ctx.controller.abort()
      } catch {
        // abort 抛错不该影响结构变更本身
      }
    })
    aiCtxBySub.clear()
    aiLoadingSubs.value = []
    aiRespondingSubs.value = []
    aiEmittedSubs.value = []
    aiSpeakers.value = {}
  }

  function clearCtxState(sub: number) {
    removeSub(aiLoadingSubs.value, sub)
    removeSub(aiRespondingSubs.value, sub)
    removeSub(aiEmittedSubs.value, sub)
    setAiSpeaker(sub, null)
  }

  /**
   * 标记本轮已出过内容
   *
   * 群聊续段每段都会重开一次响应，不标记就会被当成「首拍」而用居中三点加载态。
   */
  function markAiTurnStarted(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (c) addSub(aiEmittedSubs.value, c.sub)
  }

  /** 当前会话是否在等首条内容（LoadingBubble 判据） */
  const isLoading = computed(
    () => activeSub.value !== null && aiLoadingSubs.value.includes(activeSub.value),
  )

  /** 当前会话本轮是否已落过内容（false = 首条还没到，用居中三点加载态） */
  const aiTurnHasContent = computed(
    () => activeSub.value !== null && aiEmittedSubs.value.includes(activeSub.value),
  )

  /** 当前会话是否在整轮响应周期内（含段间等待；控制「停止」按钮） */
  const isAiResponding = computed(
    () => activeSub.value !== null && aiRespondingSubs.value.includes(activeSub.value),
  )

  /**
   * 追加一条我方消息，并同步写入 AI 上下文历史
   *
   * @param targetSub 调用方已锁定会话时必须显式传入，否则等待期间玩家切走会落进别的对话
   */
  function sendUserMessage(text: string, targetSub?: number): ChatMessage | null {
    const sub = targetSub ?? activeSub.value
    if (sub === null) return null
    const trimmed = text.trim()
    if (!trimmed) return null
    const conv = conversations.value[sub]
    if (!conv) return null
    const nextId = nextMessageId(conv)
    const self = deps.selfIdentity(targetSub)
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: trimmed,
      speakerName: self.name,
      speakerAvatar: self.avatar,
    }
    conv.messages.push(msg)
    // 上下文历史独立于可见消息：「清空消息」不影响 AI 记忆
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: trimmed })
    return msg
  }

  /** 当前会话待创建的 AI 消息说话人（加载气泡显示用） */
  const pendingAiSpeaker = computed<{ name: string; avatar: string }>(() => {
    const sub = activeSub.value
    if (sub === null) return { name: '', avatar: '' }
    return aiSpeakers.value[sub] ?? { name: '', avatar: '' }
  })

  /** 设置下一条 AI 消息的心情表情 token，仅首条气泡消费并清空 */
  function setPendingAiMood(mood?: string, ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (c) c.mood = mood
  }

  /** 把 mood 补写到本轮第一条消息上（SSE 下 mood 比首段晚到），已有值不覆盖 */
  function setFirstAiMood(mood?: string, ctx?: AiResponseCtx | null): void {
    if (!mood) return
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv || c.firstMessageId === null) return
    const msg = conv.messages.find((m) => m.id === c.firstMessageId)
    if (msg && !msg.mood) msg.mood = mood
  }

  /**
   * 开始一轮响应，锁定目标会话与说话人
   *
   * 同会话已有在途请求会先中止，避免两个请求交错写入同一段对话。
   */
  function beginAiResponse(
    speakerName: string,
    speakerAvatar: string,
    /** 目标会话，缺省取当前选中。长异步回合必须在发起前锁定 */
    targetSub?: number,
    /** 重新生成：插到这条消息之后（通常是那一轮的用户消息 id） */
    insertAfterMessageId?: number,
    /** 期望的会话对象：与下标所指不符时放弃本轮（防串台） */
    expectedConversation?: Conversation,
  ): AiResponseCtx | null {
    const sub = targetSub ?? activeSub.value
    if (sub === null || sub === undefined) return null
    const conv = conversations.value[sub]
    if (!conv) return null
    if (expectedConversation && conv !== expectedConversation) return null

    const old = aiCtxBySub.get(sub)
    if (old) {
      try {
        old.controller.abort()
      } catch {
        // abort 异常不应影响新请求
      }
    }

    const ctx: AiResponseCtx = {
      token: ++aiReqSeq,
      sub,
      speaker: { name: speakerName, avatar: speakerAvatar },
      messageId: null,
      firstMessageId: null,
      controller: new AbortController(),
      insertAfterMessageId,
      // 首条从锚点之后开始排
      lastInsertedId: insertAfterMessageId,
      lockedConversation: expectedConversation ?? conv,
    }
    aiCtxBySub.set(sub, ctx)
    setAiSpeaker(sub, ctx.speaker)
    addSub(aiRespondingSubs.value, sub)
    addSub(aiLoadingSubs.value, sub)
    removeSub(aiEmittedSubs.value, sub)
    return ctx
  }

  /** 兼容旧调用名，等价于 beginAiResponse */
  function startAiResponse(speakerName: string, speakerAvatar: string): AiResponseCtx | null {
    return beginAiResponse(speakerName, speakerAvatar)
  }

  /** 重开加载气泡（段间等待用）。不能用 beginAiResponse，否则本轮会被判陈旧 */
  function beginAiSegment(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    addSub(aiLoadingSubs.value, c.sub)
  }

  /** 收起加载气泡（不结束本段）。分拍只是显示节奏，不能因此多写一条历史 */
  function endAiSegmentLoading(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c) return
    removeSub(aiLoadingSubs.value, c.sub)
  }

  /** 把一条新 AI 消息放进对话（位置由领域层算，锚点没了就追加） */
  function insertAiMessage(conv: { messages: ChatMessage[] }, msg: ChatMessage,
                           ctx: AiResponseCtx): void {
    const at = findAiInsertIndex(conv.messages, ctx.insertAfterMessageId, ctx.lastInsertedId)
    if (at === -1) {
      conv.messages.push(msg)
      return
    }
    conv.messages.splice(at, 0, msg)
    ctx.lastInsertedId = msg.id
  }

  /** 追加流式文本：首条建气泡并收起 loading，后续追加到同一条 */
  function appendAiChunk(chunk: string, ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv) return

    addSub(aiEmittedSubs.value, c.sub)

    if (c.messageId === null) {
      const nextId = nextMessageId(conv)
      insertAiMessage(conv, {
        id: nextId,
        side: 'other',
        text: chunk,
        speakerName: c.speaker.name,
        speakerAvatar: c.speaker.avatar,
        mood: c.mood,
      }, c)
      c.mood = undefined
      c.messageId = nextId
      if (c.firstMessageId === null) c.firstMessageId = nextId
      removeSub(aiLoadingSubs.value, c.sub)
      return
    }

    const msg = conv.messages.find((m) => m.id === c.messageId)
    if (!msg) return
    msg.text += chunk
  }

  /**
   * 用 done 帧的权威全文覆盖当前气泡
   *
   * 逐帧拼接可能丢帧或重复帧。只改 text / mood，不动状态机 —— 历史仍由
   * finishAiResponse 统一写入，保证流式与非流式两条路径的落库口径一致。
   */
  function replaceAiText(text: string, mood?: string, ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv) return

    // 整段没有 delta 只有 done 帧：按首条 chunk 的规则补建；空文本不建空气泡
    if (c.messageId === null) {
      if (!text) return
      c.mood = mood
      appendAiChunk(text, c)
      return
    }

    const msg = conv.messages.find((m) => m.id === c.messageId)
    if (!msg) return
    msg.text = text
    if (mood && !msg.mood) msg.mood = mood
  }

  /** 结束整轮：写上下文历史并释放上下文；陈旧响应直接忽略 */
  function finishAiResponse(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c) return
    if (!isCtxActive(c)) return
    if (c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    aiCtxBySub.delete(c.sub)
    clearCtxState(c.sub)
  }

  /** 结束当前这一段（写历史、收 loading），整体响应与 AbortController 保持不变 */
  function finishAiSegment(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    if (c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    c.messageId = null
    removeSub(aiLoadingSubs.value, c.sub)
  }

  /** 中止本轮：abort 请求、删掉空气泡，已生成的文本仍写进历史 */
  function abortAiResponse(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c) return
    try {
      c.controller.abort()
    } catch {
      // 重复 abort 不应抛错
    }
    if (isCtxActive(c) && c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && !msg.text) {
        const idx = conv.messages.indexOf(msg)
        if (idx !== -1) conv.messages.splice(idx, 1)
      }
    }
    finishAiResponse(c)
  }

  /**
   * 追加错误占位气泡
   *
   * **绝不写入 contextHistory** —— 错误不是角色说过的话，写进去会被当成范例
   * 重发给模型。清理响应态等同 finishAiResponse，但不写历史。
   */
  function appendAiError(errMsg: string, regenerateUserId?: number,
                         ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c) return
    if (!isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (conv) {
      const nextId = nextMessageId(conv)
      insertAiMessage(conv, {
        id: nextId,
        side: 'other',
        text: errMsg,
        speakerName: c.speaker.name,
        speakerAvatar: c.speaker.avatar,
        isError: true,
        regenerateUserId,
      }, c)
    }
    aiCtxBySub.delete(c.sub)
    clearCtxState(c.sub)
  }

  /**
   * 重新生成前的准备：删掉该轮所有 AI 回复，返回被保留的用户消息
   *
   * 该轮 = 那条用户消息之后、下一条用户消息之前的连续 other 消息。
   *
   * @param messageId 长按的 AI 回复 / 错误气泡 id
   */
  function prepareRegenerate(
    messageId: number,
  ): { id: number; text: string; isImage: boolean } | null {
    if (activeSub.value === null) return null
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return null
    const target = conv.messages[idx]
    if (target.side !== 'other') return null

    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].side === 'mine') {
        userIdx = i
        break
      }
    }
    if (userIdx === -1) return null
    const userMsg = conv.messages[userIdx]

    const removed: ChatMessage[] = []
    let j = userIdx + 1
    while (j < conv.messages.length && conv.messages[j].side === 'other') {
      removed.push(conv.messages[j])
      j++
    }
    if (removed.length > 0) {
      conv.messages.splice(userIdx + 1, removed.length)
      for (const m of removed) {
        removeFromContextHistory(conv, m)
      }
    }

    return { id: userMsg.id, text: userMsg.text, isImage: !!userMsg.image }
  }

  function getAiSignal(ctx?: AiResponseCtx | null): AbortSignal | undefined {
    return resolveCtx(ctx)?.controller.signal
  }

  return {
    // 选中会话的响应态（渲染层直接读）
    isLoading,
    aiTurnHasContent,
    isAiResponding,
    pendingAiSpeaker,
    // 上下文生命周期
    beginAiResponse,
    startAiResponse,
    isCtxActive,
    invalidateAllAiCtx,
    finishAiResponse,
    finishAiSegment,
    abortAiResponse,
    appendAiError,
    // 写入
    appendAiChunk,
    replaceAiText,
    setPendingAiMood,
    setFirstAiMood,
    markAiTurnStarted,
    beginAiSegment,
    endAiSegmentLoading,
    // 消息与重生成
    sendUserMessage,
    prepareRegenerate,
    getAiSignal,
  }
}
