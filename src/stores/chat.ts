// =============================================================================
// 聊天领域 store(类型化)
// -----------------------------------------------------------------------------
// 数据结构:
//   cards: Card[]                          —— 主卡(一级卡片)
//     └─ conversations: Conversation[]     —— 子卡(二级卡片,每张主卡 ≥ 1 段)
//        └─ messages: ChatMessage[]        —— 消息列表
//
// 派生(扁平化):
//   conversations = cards.flatMap(c => c.conversations)
//   每段子对话在扁平数组中的下标即为"全局子卡索引"(activeSub)
//
// 布局算法(characterCard.ts)按每张主卡的真实子卡数量计算高度,
// 支持"主卡数量任意、每张主卡子卡数量任意(≥1)"。
// =============================================================================

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Card, ChatMessage, Conversation, MessageSpeaker } from '../types/chat'
import {
  findCharacter,
  CHARACTERS,
  DEFAULT_AVATAR_URL,
  MINE_AVATAR_URL,
  MINE_AVATAR_FEMALE_URL,
} from '../constants/character'
import { createInitialCards } from '../constants/initialCards'

/**
 * 按角色名查找头像 URL
 *
 * 查 character.ts 的内置干员表;未找到回退 DEFAULT_AVATAR_URL。
 * 头像已本地托管(src/assets/avatars/,经 Vite import.meta.glob 打包)。
 */
function resolveAvatar(name: string): string {
  return findCharacter(name)?.avatar ?? DEFAULT_AVATAR_URL
}

/** "管理员"角色名(我方固定身份,AI 始终看到此名) */
export const MINE_NAME = '管理员'

// 【已注释停用】角色名称显示功能整体停用,以下状态与开关一并注释保留,便于日后恢复。
// /** 角色名称显示开关的 localStorage key(设置类数据,独立于工程数据) */
// const CHAR_NAMES_STORAGE_KEY = 'endfield-baker-char-names'
//
// /** 读取角色名称显示开关(未记录 / 读取异常回退 false) */
// function readCharacterNamesToggle(): boolean {
//   try {
//     return localStorage.getItem(CHAR_NAMES_STORAGE_KEY) === '1'
//   } catch {
//     return false
//   }
// }

/** 消息 id 自增工厂:取对话内当前最大 id + 1(所有发送入口共用) */
function nextMessageId(conv: Conversation): number {
  return conv.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
}

/**
 * 消息说话人头像解析(聊天区渲染 / 头像选择菜单高亮共用)
 *
 * 优先级:
 * - mine:始终使用 mineUrl(全局 myGender 实时派生),忽略 msg.speakerAvatar
 *   ——管理员性别可随时切换,已有消息的头像必须跟随更新
 * - other:msg.speakerAvatar > findCharacter(msg.speakerName ?? convName) > otherUrl
 *   convName 是会话原始名(旧数据未记录 speakerName 时回退,读对话名查角色);
 *   otherUrl 是会话默认对方头像(不在角色表 → 无黄圈属预期)。
 *
 * @param msg         消息(speakerAvatar/speakerName/侧别)
 * @param convName    会话原始名(activeSub 对应 conversation.name)
 * @param otherUrl    other 侧默认头像(会话角色头像)
 * @param mineUrl     全局管理员头像(根据 myGender 选择男/女,实时跟随切换)
 */
function resolveMessageAvatar(
  msg: MessageSpeaker,
  convName: string,
  otherUrl: string,
  mineUrl: string,
): string {
  if (msg.side === 'mine') {
    return mineUrl
  }
  if (msg.speakerAvatar) return msg.speakerAvatar
  const name = msg.speakerName ?? convName
  if (name) {
    const c = findCharacter(name)
    if (c) return c.avatar
  }
  return otherUrl
}

export const useChatStore = defineStore('chat', () => {
  /** 主卡数据(每张主卡下挂任意数量子卡对话) */
  // 用 createInitialCards() 的独立副本 seed,绝不直接引用 INITIAL_CARDS 常量:
  // store 增删是原地 push / splice,若与模块常量别名会互相泄漏(见 initialCards.ts)。
  const cards = ref<Card[]>(createInitialCards())

  /** 每张主卡的折叠状态(默认全部收起) */
  const collapsed = ref<boolean[]>(cards.value.map(() => true))

  /**
   * 扁平化后的全部子卡对话(按主卡顺序串联)
   *
   * 全局子卡索引(activeSub 等)均针对此扁平数组。
   */
  const conversations = computed<Conversation[]>(() =>
    cards.value.flatMap((c) => c.conversations),
  )

  /** 当前激活的子卡全局索引(null = 未选中任何对话) */
  const activeSub = ref<number | null>(null)

  // 【已注释停用】角色名称显示功能整体停用,以下状态与开关一并注释保留,便于日后恢复。
  // /**
  //  * 是否显示对话内角色名称(小号灰字悬浮于带头像的气泡上方)
  //  *
  //  * 设置类数据:localStorage 独立 key 持久化(与 useCustomBackground 同类,
  //  * 不随 .baker 导出、不受清空对话影响)。读取异常/写入失败静默降级。
  //  */
  // const showCharacterNames = ref(readCharacterNamesToggle())
  //
  // function toggleShowCharacterNames() {
  //   showCharacterNames.value = !showCharacterNames.value
  //   try {
  //     localStorage.setItem(CHAR_NAMES_STORAGE_KEY, showCharacterNames.value ? '1' : '0')
  //   } catch {
  //     // 存储失败:仅本次会话生效,刷新恢复默认,不影响主流程
  //     console.warn('[store] 角色名称开关保存失败,刷新后将重置')
  //   }
  // }

  /**
   * 顶部聊天条图片下标(三图循环切换)
   *
   * 存于 store:导出模式渲染的独立 ChatArea 实例共享同一份状态,
   * 保证导出的聊天条样式与主界面当前切换到的完全一致。
   */
  const stripVariantIndex = ref(0)

  /**
   * 每张主卡的"起始全局子卡索引"(用于 activeSub → cardIndex 反查)
   *
   * 长度 = 主卡数 + 1(末位追加总和便于区间计算)。
   * 例如主卡下子卡数 [1,2,2,2,2,2],则 starts = [0,1,3,5,7,9,11]。
   */
  const cardSubStarts = computed<number[]>(() => {
    const starts: number[] = [0]
    let acc = 0
    for (const c of cards.value) {
      acc += c.conversations.length
      starts.push(acc)
    }
    return starts
  })

  /**
   * 每张主卡下的全局子卡索引区间 [start, end)
   *
   * 用于 CharacterCardItem 遍历渲染该主卡下的所有子卡。
   */
  const cardSubRanges = computed<{ start: number; count: number }[]>(() =>
    cards.value.map((_, i) => ({
      start: cardSubStarts.value[i],
      count: cardSubStarts.value[i + 1] - cardSubStarts.value[i],
    })),
  )

  /**
   * 当前选中的主卡索引(null = 未选中任何角色)
   *
   * 由用户点击主卡(selectCard)或选中子对话(selectSub)设置:
   * - 点击主卡:仅选中主卡(白色遮罩),不改变 activeSub(可不进入子对话)
   * - 选中子对话:同时同步所属主卡
   * 新建对话以它为准:选中父卡后即使未进入子对话也可新建。
   */
  const activeCardIndex = ref<number | null>(null)

  /** 由子对话索引反查所属主卡(不存在返回 null) */
  function cardIndexOfSub(sub: number): number | null {
    if (sub < 0) return null
    for (let i = cardSubStarts.value.length - 1; i >= 0; i--) {
      if (sub >= cardSubStarts.value[i]) return i
    }
    return null
  }

  /** 同步 activeCardIndex 到 activeSub 所属主卡(activeSub 为 null 时不动,保留用户选中) */
  function syncActiveCardFromSub(): void {
    if (activeSub.value === null) return
    activeCardIndex.value = cardIndexOfSub(activeSub.value)
  }

  /**
   * 选中主卡(父级角色卡片)
   *
   * 仅设置选中态(白色遮罩)并折叠切换由调用方负责;不改变 activeSub,
   * 因此"未进入子对话"时也能选中父卡,用于在其下新建对话。
   *
   * @param index 主卡索引
   */
  function selectCard(index: number): void {
    activeCardIndex.value = index
  }

  /**
   * 每段子对话的派生数据(title/avatar)
   *
   * title = 会话名(角色名),avatar = 角色头像(查内置干员表)。
   */
  const conversationMeta = computed(() =>
    cards.value.flatMap((card) =>
      card.conversations.map((conv) => ({
        title: conv.name || '未命名会话',
        avatar: resolveAvatar(conv.name),
      })),
    ),
  )

  /** 当前对话的派生数据(null = 未选中对话) */
  const currentConversationMeta = computed(() =>
    activeSub.value === null ? null : conversationMeta.value[activeSub.value],
  )

  /** 当前对话的对方姓名(显示在聊天条;未选中时为空串) */
  const counterpartName = computed<string>(() => currentConversationMeta.value?.title ?? '')

  /**
   * 当前对话"对方"默认头像 URL(聊天区用)
   *
   * 私聊:该角色头像;不在角色表:回退默认头像。
   * 切换对话时自动响应式更新。
   */
  const currentOtherAvatarUrl = computed(() => {
    if (activeSub.value === null) return DEFAULT_AVATAR_URL
    return resolveAvatar(conversations.value[activeSub.value].name)
  })

  // ---- 会话创作 -----------------------------------------------------------
  /**
   * 全局管理员性别(仅影响头像,不影响 AI 感知)
   *
   * - 'male'(默认):使用 管理员_男.webp
   * - 'female':使用 管理员_女.webp
   * 全局生效,所有对话共享。AI 始终只看到"管理员",不感知性别。
   */
  const myGender = ref<'male' | 'female'>('male')

  /** 我方管理员头像(根据全局 myGender 选择男/女) */
  const myAvatar = computed(() =>
    myGender.value === 'female' ? MINE_AVATAR_FEMALE_URL : MINE_AVATAR_URL,
  )

  /** 切换全局管理员性别(male ↔ female),仅影响头像显示 */
  function toggleMyGender() {
    myGender.value = myGender.value === 'female' ? 'male' : 'female'
  }

  /** 直接设置全局管理员性别(持久化恢复 / 导入时调用) */
  function setMyGender(g: 'male' | 'female') {
    myGender.value = g
  }

  /**
   * 当前选中的子对话是否可删除
   *
   * 父级卡片仅含一个子对话时不可删除(避免连带删除整张父卡)。
   */
  const canDeleteActiveConversation = computed(() => {
    if (activeSub.value === null) return false
    const cardIndex = cardIndexOfSub(activeSub.value)
    if (cardIndex === null) return false
    return cardSubStarts.value[cardIndex + 1] - cardSubStarts.value[cardIndex] > 1
  })

  /**
   * 新建会话:在选中的主卡下追加子会话
   *
   * 选中来源:点击主卡(selectCard,无需进入子对话)或选中子对话(selectSub)。
   * 新子卡自动选中并进入。若父级卡片处于折叠状态,自动展开以显示新子卡。
   */
  function createChildConversation() {
    if (activeCardIndex.value === null) return
    const idx = activeCardIndex.value
    const card = cards.value[idx]
    // 新子对话继承父卡角色名(与第一张子对话一致),
    // 确保提示词 / 头像 / 预览文本 / 成员推导均正确。
    // 若父卡首对话无角色名(异常情况),回退"未命名会话"。
    const characterName = card.conversations[0]?.name ?? '未命名会话'
    card.conversations.push({ name: characterName, messages: [] })
    // 父级卡片折叠时自动展开,让用户看到新子卡
    if (collapsed.value[idx]) collapsed.value[idx] = false
    activeSub.value = cardSubStarts.value[idx + 1] - 1
  }

  /**
   * 发送图片消息
   *
   * 我方固定为"管理员",side 固定为 mine。
   */
  function sendImage(image: string, width: number, height: number) {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    const nextId = nextMessageId(conv)
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: '',
      image,
      imageW: width,
      imageH: height,
      speakerName: MINE_NAME,
      speakerAvatar: myAvatar.value,
    }
    conv.messages.push(msg)
    // 同步写入 AI 上下文历史(携带图片 dataURL,让 vision API 真正"看到"图片)
    // text 不能为空:裸图片会让模型进入"描述图片"模式而忽略角色人设
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: '[图片]', image })
  }

  /**
   * 删除当前选中的子对话(底部"删除对话"确认后调用)
   *
   * - 父级卡片含多个子对话:只删除当前子对话,选中跳到同卡相邻段
   *   (原位置有后续段取之,否则取新末段)
   * - 父级卡片仅一个子对话:连带删除整张父卡,同时同步 collapsed;
   *   选中跳到下一张卡首段 → 上一张卡末段 → 全部删空为 null
   */
  function deleteActiveConversation() {
    if (activeSub.value === null) return
    const sub = activeSub.value
    const cardIndex = cardIndexOfSub(sub)
    if (cardIndex === null) return
    const start = cardSubStarts.value[cardIndex]
    const count = cardSubStarts.value[cardIndex + 1] - start
    const localIdx = sub - start

    if (count > 1) {
      // 仅删除该子卡(保持父卡展开状态与其余子卡不变)
      cards.value[cardIndex].conversations.splice(localIdx, 1)
      const newCount = count - 1
      activeSub.value = localIdx < newCount ? start + localIdx : start + newCount - 1
      // 选中主卡不变(仍是同一张父卡)
      activeCardIndex.value = cardIndex
      return
    }

    // 唯一子卡:内置角色卡片常驻,删除最后一段对话 = 清空该对话(卡片保留)
    const cardChar = cards.value[cardIndex].conversations[0]?.name
    const isBuiltin = CHARACTERS.some((c) => c.name === cardChar)
    if (isBuiltin) {
      const conv = cards.value[cardIndex].conversations[localIdx]
      conv.messages = []
      conv.contextHistory = []
      return
    }

    // 自定义角色(非内置):仍可连带删除整张父卡
    cards.value.splice(cardIndex, 1)
    collapsed.value.splice(cardIndex, 1)
    if (cards.value.length === 0) {
      activeSub.value = null
      activeCardIndex.value = null
    } else if (cardIndex < cards.value.length) {
      // 下一张主卡的首段
      activeSub.value = cardSubStarts.value[cardIndex]
      syncActiveCardFromSub()
    } else {
      // 删除的是最后一张主卡:取新末张主卡的末段
      activeSub.value = cardSubStarts.value[cards.value.length] - 1
      syncActiveCardFromSub()
    }
  }

  /**
   * 清空全部对话(每个角色保留一个空子对话卡片)
   *
   * 删除所有子对话但每张父卡保留一个空对话(保留角色名),同时清空消息与上下文。
   */
  function clearAllConversations() {
    const next: Card[] = cards.value.map((c) => ({
      ...c,
      conversations: [{
        name: c.conversations[0]?.name ?? '未命名会话',
        messages: [],
        contextHistory: [],
      }],
    }))
    replaceAllCards(next)
  }

  /**
   * 清空当前对话的可见消息(保留 AI 上下文记忆)
   *
   * 将已有消息先同步到 contextHistory(若尚未初始化),再清空 messages。
   * AI 仍可通过 contextHistory 记住之前的对话。
   */
  function clearActiveMessages() {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    if (conv.contextHistory === undefined) {
      conv.contextHistory = conv.messages
        .filter((m) => m.text || m.image)
        .map((m) => {
          const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: m.side, text: m.text }
          if (m.image) entry.image = m.image
          return entry
        })
    }
    conv.messages = []
  }

  /**
   * 清空当前对话的 AI 上下文记忆(保留可见消息)
   *
   * 屏幕上的消息仍然可见,但 AI 不再记得之前的对话。
   */
  function clearActiveContext() {
    if (activeSub.value === null) return
    conversations.value[activeSub.value].contextHistory = []
  }

  /**
   * 清空全部对话的可见消息(保留 AI 上下文记忆)
   *
   * 遍历所有子对话,将已有消息同步到 contextHistory 后清空 messages。
   */
  function clearAllMessages() {
    conversations.value.forEach((conv) => {
      if (conv.contextHistory === undefined) {
        conv.contextHistory = conv.messages
          .filter((m) => m.text || m.image)
          .map((m) => {
            const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: m.side, text: m.text }
            if (m.image) entry.image = m.image
            return entry
          })
      }
      conv.messages = []
    })
  }

  /**
   * 清空全部对话的 AI 上下文记忆(保留可见消息)
   *
   * 屏幕上的消息仍然可见,但所有对话的 AI 都不再记得之前的内容。
   */
  function clearAllContext() {
    conversations.value.forEach((conv) => {
      conv.contextHistory = []
    })
  }

  /**
   * 每张主卡的干员数据(name + avatar URL)
   *
   * 取每张主卡首段子对话的角色名和头像。
   */
  const cardCharacters = computed(() =>
    cards.value.map((c) => {
      const name = c.conversations[0]?.name ?? ''
      return {
        name,
        avatar: resolveAvatar(name),
      }
    }),
  )

  // ---- AI 加载状态 --------------------------------------------------------
  /**
   * 是否处于 loading 阶段(显示 LoadingBubble 的判据)
   *
   * 由 AI 响应时序控制:
   *   - startAiResponse:true(显示 LoadingBubble)
   *   - 首条 chunk 到达 / finishAiSegment / finishAiResponse:false
   */
  const isLoading = ref(false)

  /**
   * 子卡预览文本
   *
   * 直接返回每段对话最后一条消息的文本(空对话返回空串)。
   * 图片消息预览显示 "[图片]"。
   */
  const subPreviewTexts = computed<string[]>(() =>
    conversations.value.map((conv) => {
      const msgs = conv.messages
      if (msgs.length === 0) return ''
      const msg = msgs[msgs.length - 1]
      if (msg.image) return '[图片]'
      return msg.text || ''
    }),
  )

  /**
   * 当前对话的消息列表(供 ChatArea 渲染)
   *
   * AI 聊天模式下消息由用户发送 + AI 流式回复直接追加到对话中。
   */
  const playedMessages = computed<ChatMessage[]>(() => {
    if (activeSub.value === null) return []
    return conversations.value[activeSub.value].messages
  })

  /**
   * 当前 LoadingBubble 应有的朝向
   *
   * 由 AI 响应状态驱动(AI 回复在 other 侧,即左侧)。
   * isLoading 为 true 时返回 'other',否则返回 null。
   */
  const loadingSide = computed<'other' | 'mine' | null>(() => {
    if (!isLoading.value) return null
    return 'other'
  })

  // 切换对话:关闭 loading(LoadingBubble)。
  watch(activeSub, () => {
    isLoading.value = false
  }, { immediate: true })

  /**
   * 切换指定主卡的折叠状态
   *
   * @param index 主卡索引
   */
  function toggleCollapse(index: number) {
    collapsed.value[index] = !collapsed.value[index]
  }

  /**
   * 选中指定子卡(切换当前对话)
   *
   * 同时同步选中其所属主卡(activeCardIndex)。
   *
   * @param index 子卡全局索引(在扁平 conversations 中的下标)
   */
  function selectSub(index: number) {
    activeSub.value = index
    activeCardIndex.value = cardIndexOfSub(index)
  }

  /**
   * 清除全部选中(返回列表等场景)
   *
   * activeSub 与 activeCardIndex 一并置 null:回到"未选中任何对话/角色"的初始状态。
   */
  function clearSelection() {
    activeSub.value = null
    activeCardIndex.value = null
  }

  /**
   * 补齐缺失的内置角色卡片(全角色常驻)
   *
   * 导入 / 恢复 / 清空后保证每个内置角色都至少存在一张卡片,
   * 防止"导出只含部分角色"导致空角色在界面消失。
   * 自定义角色(不在 CHARACTERS 内)原样保留。
   */
  function mergeBuiltinCards(next: Card[]): Card[] {
    const result = next.map((c) => ({ conversations: c.conversations }))
    const known = new Set(result.map((c) => c.conversations[0]?.name))
    for (const c of CHARACTERS) {
      if (!known.has(c.name)) {
        result.push({
          conversations: [{ name: c.name, messages: [] }],
        })
      }
    }
    return result
  }

  /**
   * 整体替换卡片树并重置全部运行时态
   *
   * DataManagerDialog.applyCards(导入/清空)与 useChatPersistence.loadProject
   * (恢复)都需要"替换 cards + 重置运行时态字段"。收敛为统一 action,
   * 保证重置逻辑唯一来源,字段集合只在一处维护。
   *
   * 重置字段:collapsed(全收起)/ activeSub(null)/ activeCardIndex(null)/ isLoading(false)
   *
   * @param next 新的卡片树(调用方负责 sanitize)
   */
  function replaceAllCards(next: Card[]) {
    cards.value = mergeBuiltinCards(next)
    collapsed.value = cards.value.map(() => true)
    activeSub.value = null
    activeCardIndex.value = null
    isLoading.value = false
  }

  /**
   * 循环切换到下一张顶部聊天条图片
   *
   * 同样存于 store:导出模式 ChatArea 实例共享,导出图与主界面样式一致。
   */
  function cycleStrip(): void {
    stripVariantIndex.value = (stripVariantIndex.value + 1) % 3
  }

  /** 直接设置顶部聊天条图片下标(持久化恢复 / 导入时调用) */
  function setStripVariant(idx: number): void {
    stripVariantIndex.value = ((idx % 3) + 3) % 3
  }

  // ---- AI 聊天 ------------------------------------------------------------
  /** AI 是否正在响应(流式输出中) */
  const isAiResponding = ref(false)

  /** 当前 AI 响应的 AbortController(用于中止) */
  let aiAbortController: AbortController | null = null

  /**
   * AI 响应锁定的目标对话下标
   *
   * startAiResponse 时锁定,后续 appendAiChunk / finishAiSegment /
   * finishAiResponse / abortAiResponse 均操作此对话,不受用户切换卡片影响。
   */
  const aiTargetSub = ref<number | null>(null)

  /** 当前 AI 正在回复的消息 id(流式追加的目标消息,null = 无 AI 回复) */
  const aiMessageId = ref<number | null>(null)

  /**
   * 发送用户消息(用户输入后调用)
   *
   * 添加一条 mine 侧消息到当前对话,返回消息对象供调用方构建 LLM 请求。
   */
  function sendUserMessage(text: string): ChatMessage | null {
    if (activeSub.value === null) return null
    const trimmed = text.trim()
    if (!trimmed) return null
    const conv = conversations.value[activeSub.value]
    const nextId = nextMessageId(conv)
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: trimmed,
      speakerName: MINE_NAME,
      speakerAvatar: myAvatar.value,
    }
    conv.messages.push(msg)
    // 同步写入 AI 上下文历史(独立于可见消息,"清空消息"不影响 AI 记忆)
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: trimmed })
    return msg
  }

  /** 待创建的 AI 消息角色信息(startAiResponse 时保存,首条 chunk 时创建消息) */
  const pendingAiSpeaker = ref<{ name: string; avatar: string }>({ name: '', avatar: '' })

  /**
   * 开始 AI 响应:设置 loading 状态(显示 LoadingBubble),不提前创建空消息
   *
   * 消息在首条 chunk 到达时由 appendAiChunk 创建,避免空气泡与 LoadingBubble 同时出现。
   *
   * @param speakerName  AI 角色名
   * @param speakerAvatar AI 角色头像 URL
   */
  function startAiResponse(speakerName: string, speakerAvatar: string): void {
    if (activeSub.value === null) return
    // 锁定目标对话:仅在整体响应首次启动时锁定一次(后续分段不重锁),
    // 保证等待期间切换角色后,分段消息仍写入原对话而非当前对话
    if (aiTargetSub.value === null) {
      aiTargetSub.value = activeSub.value
    }
    pendingAiSpeaker.value = { name: speakerName, avatar: speakerAvatar }
    isAiResponding.value = true
    aiAbortController = new AbortController()
    // 仅当正在查看目标对话时才显示 LoadingBubble,
    // 避免切换到其他角色时在错误的对话中闪现加载气泡
    isLoading.value = activeSub.value === aiTargetSub.value
  }

  /**
   * 追加 AI 流式输出文本
   *
   * 首条 chunk:创建 other 侧消息(含首段文本),关闭 loading(LoadingBubble → 文字气泡过渡)。
   * 后续 chunk:追加文本到已创建的消息。
   */
  function appendAiChunk(chunk: string) {
    const sub = aiTargetSub.value ?? activeSub.value
    if (sub === null) return
    const conv = conversations.value[sub]

    // 首条 chunk:创建 AI 消息,关闭 loading
    if (aiMessageId.value === null) {
      const nextId = nextMessageId(conv)
      conv.messages.push({
        id: nextId,
        side: 'other',
        text: chunk,
        speakerName: pendingAiSpeaker.value.name,
        speakerAvatar: pendingAiSpeaker.value.avatar,
      })
      aiMessageId.value = nextId
      isLoading.value = false
      return
    }

    // 后续 chunk:追加文本
    const msg = conv.messages.find((m) => m.id === aiMessageId.value)
    if (!msg) return
    msg.text += chunk
  }

  /** 完成 AI 响应:关闭 loading + 清理状态 + 写入上下文历史 */
  function finishAiResponse() {
    // 将 AI 回复写入上下文历史(独立于可见消息,"清空消息"不影响 AI 记忆)
    const sub = aiTargetSub.value ?? activeSub.value
    if (sub !== null && aiMessageId.value !== null) {
      const conv = conversations.value[sub]
      const msg = conv.messages.find((m) => m.id === aiMessageId.value)
      if (msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    isLoading.value = false
    isAiResponding.value = false
    aiMessageId.value = null
    aiAbortController = null
    pendingAiSpeaker.value = { name: '', avatar: '' }
    aiTargetSub.value = null
  }

  /**
   * 完成当前 AI 消息段(不结束整体响应)
   *
   * 用于多段消息:每段消息各自写入上下文历史并关闭 loading,
   * 但保持 isAiResponding=true 和 AbortController 不变,
   * 调用方可继续 startAiResponse → appendAiChunk → finishAiSegment 发送下一段。
   */
  function finishAiSegment() {
    const sub = aiTargetSub.value ?? activeSub.value
    if (sub !== null && aiMessageId.value !== null) {
      const conv = conversations.value[sub]
      const msg = conv.messages.find((m) => m.id === aiMessageId.value)
      if (msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    isLoading.value = false
    aiMessageId.value = null
  }

  /**
   * 中止当前 AI 响应
   *
   * 调用 AbortController.abort() 并清理状态。
   * 如果 AI 消息已创建且为空文本,则删除该消息。
   * (消息尚未创建时——首条 chunk 未到达——仅清理状态即可。)
   */
  function abortAiResponse() {
    if (aiAbortController) {
      aiAbortController.abort()
      aiAbortController = null
    }
    const sub = aiTargetSub.value ?? activeSub.value
    if (sub !== null && aiMessageId.value !== null) {
      const conv = conversations.value[sub]
      const msg = conv.messages.find((m) => m.id === aiMessageId.value)
      if (msg && !msg.text) {
        const idx = conv.messages.indexOf(msg)
        if (idx !== -1) conv.messages.splice(idx, 1)
      }
    }
    finishAiResponse()
  }

  /** 获取当前 AI 响应的 AbortSignal(供 LLM 调用传入) */
  function getAiSignal(): AbortSignal | undefined {
    return aiAbortController?.signal
  }

  /**
   * 获取当前对话的聊天历史(用于构建 LLM 请求)
   *
   * 优先使用 contextHistory(独立于可见消息):
   * - contextHistory 已初始化(undefined 以外) → 直接返回它
   * - contextHistory 未初始化(undefined,旧数据) → 从 messages 派生(向后兼容)
   */
  function getChatHistory(): Array<{ side: 'other' | 'mine'; text: string; image?: string }> {
    if (activeSub.value === null) return []
    const conv = conversations.value[activeSub.value]
    if (conv.contextHistory !== undefined) {
      return conv.contextHistory
    }
    return conv.messages
      .filter((m) => m.text || m.image)
      .map((m) => {
        const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: m.side, text: m.text }
        if (m.image) entry.image = m.image
        return entry
      })
  }

  return {
    // 数据
    cards,
    conversations,
    collapsed,
    cardSubRanges,
    activeSub,
    counterpartName,
    currentOtherAvatarUrl,
    myAvatar,
    myGender,
    cardCharacters,
    // 会话创作
    canDeleteActiveConversation,
    createChildConversation,
    sendImage,
    deleteActiveConversation,
    clearAllConversations,
    clearActiveMessages,
    clearActiveContext,
    clearAllMessages,
    clearAllContext,
    toggleMyGender,
    setMyGender,
    // 动态命名
    currentConversationMeta,
    // AI 加载
    subPreviewTexts,
    playedMessages,
    isLoading,
    loadingSide,
    // 玩家选择
    toggleCollapse,
    selectSub,
    selectCard,
    clearSelection,
    activeCardIndex,
    // 角色名称显示开关(localStorage 持久化)【已注释停用】
    // showCharacterNames,
    // toggleShowCharacterNames,
    replaceAllCards,
    cycleStrip,
    setStripVariant,
    stripVariantIndex,
    // 公共头像解析(聊天区渲染共用)
    resolveMessageAvatar,
    // AI 聊天
    isAiResponding,
    pendingAiSpeaker,
    sendUserMessage,
    startAiResponse,
    appendAiChunk,
    finishAiResponse,
    finishAiSegment,
    abortAiResponse,
    getAiSignal,
    getChatHistory,
  }
})
