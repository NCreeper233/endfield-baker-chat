// chat —— 聊天 store
// cards[].conversations[] 扁平化后，下标即「全局子卡索引」（activeSub）。

import { computed, nextTick, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  Card,
  ChatMessage,
  ContextEntry,
  Conversation,
  GroupMyRole,
  GroupSpeakMode,
  PlayerChoice,
} from '../types/chat'
import {
  findCharacter,
  CHARACTERS,
  DEFAULT_AVATAR_URL,
  MINE_AVATAR_URL,
  MINE_AVATAR_FEMALE_URL,
} from '../constants/character'
import { createInitialCards } from '../constants/initialCards'
import { isLegacyDemoGroupShell, repairCardGroups } from '../utils/groupMeta'
import { groupTransportFor } from '../utils/groupTransport'
import { useSettingsStore } from './settings'
// 领域层（纯逻辑，可单测）
import { MINE_NAME, resolveAvatar, resolveMessageAvatar, isRolePlayMessage } from '../domain/chat/identity'
import {
  GROUP_MIN_MEMBERS,
  GROUP_SETTINGS_MIN,
  GROUP_SPEAK_MODES,
  groupSelfName,
  groupTitle,
  isGroupCard,
  resolveCardIdentity,
} from '../domain/chat/group'
import {
  deriveContextEntries,
  nextMessageId,
  removeFromContextHistory,
} from '../domain/chat/conversation'
import {
  activityFromOrder,
  cardActiveKey,
  parseActivity,
  sortKeysByActivity,
} from '../domain/chat/activity'
import { createAiResponseState } from './chat/aiResponse'

// 这些符号历来从 stores/chat 导出，re-export 保住所有既有 import 路径
export {
  MINE_NAME,
  GROUP_MIN_MEMBERS,
  GROUP_SETTINGS_MIN,
  GROUP_SPEAK_MODES,
  groupSelfName,
  groupTitle,
  isRolePlayMessage,
  resolveMessageAvatar,
}

/**
 * 「继续对话」浮窗的出现间隔（条）
 *
 * 只数角色的消息：浮窗管的是角色们自己聊了多少，玩家发言与错误气泡都不计。
 */
export const GROUP_CONTINUE_EVERY = 20

// 响应上下文在 stores/chat/aiResponse.ts，这里 re-export 兼容旧 import
export type { AiResponseCtx } from './chat/aiResponse'

export const useChatStore = defineStore('chat', () => {
  /** 依赖方向是 chat → settings，settings 不反向依赖 chat */
  const settingsStore = useSettingsStore()

  /** 主卡数据 */
  // 必须用独立副本 seed：store 增删是原地 push / splice，与模块常量别名会互相泄漏
  const cards = ref<Card[]>(createInitialCards())

  /** 每张主卡的折叠状态(默认全部收起) */
  const collapsed = ref<boolean[]>(cards.value.map(() => true))

  /** 扁平化后的全部子对话，全局子卡索引均针对此数组 */
  const conversations = computed<Conversation[]>(() =>
    cards.value.flatMap((c) => c.conversations),
  )

  /** 当前激活的子卡全局索引（null = 未选中） */
  const activeSub = ref<number | null>(null)

  /** 顶部聊天条下标（三图循环）。放 store 是为了导出的 ChatArea 与主界面取同一张 */
  const stripVariantIndex = ref(0)

  /** 每张主卡起始的全局子卡索引，长度 = 主卡数 + 1（末位是总和，便于算区间） */
  const cardSubStarts = computed<number[]>(() => {
    const starts: number[] = [0]
    let acc = 0
    for (const c of cards.value) {
      acc += c.conversations.length
      starts.push(acc)
    }
    return starts
  })

  /** 每张主卡下的全局子卡索引区间 [start, count)，CharacterCardItem 遍历渲染用 */
  const cardSubRanges = computed<{ start: number; count: number }[]>(() =>
    cards.value.map((_, i) => ({
      start: cardSubStarts.value[i],
      count: cardSubStarts.value[i + 1] - cardSubStarts.value[i],
    })),
  )

  /**
   * 当前选中的主卡索引（null = 未选中）
   *
   * 点主卡只设它、不动 activeSub（可以不进子对话）；新建会话以它为准。
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

  /** 只设选中态，不动 activeSub —— 没进子对话时也能选中父卡 */
  function selectCard(index: number): void {
    activeCardIndex.value = index
  }

  /** 选中主卡并进入它的第 subOffset 段子对话（群聊卡是主卡级入口，用它） */
  function selectCardConversation(cardIndex: number, subOffset = 0): void {
    const start = cardSubStarts.value[cardIndex]
    if (start === undefined) return
    activeCardIndex.value = cardIndex
    const idx = start + subOffset
    if (idx >= 0 && idx < conversations.value.length) activeSub.value = idx
  }

  /** 每段子对话的 title / avatar，按主卡顺序扁平排列 */
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

  /**
   * 按显式下标取会话展示信息
   *
   * AI 回合锁定会话后必须取**那段自己的**头像：取「此刻选中的」会在玩家切走后串头像。
   */
  function conversationMetaAt(sub: number): { title: string; avatar: string } | null {
    return conversationMeta.value[sub] ?? null
  }

  /** 当前对话的对方姓名(显示在聊天条;未选中时为空串) */
  const counterpartName = computed<string>(() => currentConversationMeta.value?.title ?? '')

  /**
   * 当前对话「对方」头像
   *
   * 双形象角色（目前只有管理员）切到第二张时取第二张，与角色卡读同一份设置。
   */
  const currentOtherAvatarUrl = computed(() => {
    if (activeSub.value === null) return DEFAULT_AVATAR_URL
    const name = conversations.value[activeSub.value].name
    const character = findCharacter(name)
    if (character?.avatarAlt && settingsStore.isAvatarAltOn(name)) return character.avatarAlt
    return resolveAvatar(name)
  })

  /** 取角色第二张形象的头像，只有双形象角色且已切换时才有值 */
  function altAvatarOf(name: string): string | undefined {
    const character = findCharacter(name)
    if (!character?.avatarAlt) return undefined
    return settingsStore.isAvatarAltOn(name) ? character.avatarAlt : undefined
  }

  /** 点对方头像换形象；没有第二张形象时返回 false，调用方什么都不做 */
  function toggleCounterpartAvatarAlt(): boolean {
    const name = counterpartName.value
    const character = findCharacter(name)
    if (!character?.avatarAlt) return false
    settingsStore.toggleAvatarAlt(name)
    return true
  }

  // ---- 会话创作 -----------------------------------------------------------
  /**
   * 全局管理员性别，只影响头像
   *
   * AI 始终只看到「管理员」这个名字，不感知性别。
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

  /** 在选中的主卡下追加子会话；群聊卡不允许再建子会话 */
  function createChildConversation(): boolean {
    if (activeCardIndex.value === null) return false
    const idx = activeCardIndex.value
    const card = cards.value[idx]
    if (!card) return false
    // 群聊在列表里是一整张卡，建出来的空子会话会以空占位挤进群聊列表
    if (isGroupCardAt(idx)) return false
    // 新会话会插进扁平数组，后面所有下标整体 +1，在途响应必须先作废
    ai.invalidateAllAiCtx()
    // 新子对话继承父卡角色名，保证提示词 / 头像 / 预览 / 成员推导都正确
    const characterName = card.conversations[0]?.name ?? '未命名会话'
    card.conversations.push({ name: characterName, messages: [] })
    // 父级卡片折叠时自动展开,让用户看到新子卡
    if (collapsed.value[idx]) collapsed.value[idx] = false
    activeSub.value = cardSubStarts.value[idx + 1] - 1
    return true
  }

  /** 创建群聊主卡：只往 cards 里插一张卡并选中，不涉及后端；成员去重后少于 2 人拒绝 */
  function createGroupCard(
    members: string[],
    myRole: GroupMyRole = 'admin',
    title?: string,
    speakMode: GroupSpeakMode = 'smart',
  ): number | null {
    // 去重(不再限制人数上限,可选全部角色)
    const list: string[] = []
    for (const m of members) {
      if (m && list.indexOf(m) === -1) list.push(m)
    }
    if (list.length < GROUP_MIN_MEMBERS) return null

    // 建群会往扁平数组尾部追加一段,并切到群聊列表 → 在途 AI 响应不能再往下写
    ai.invalidateAllAiCtx()

    const name = (title ?? '').trim() || groupTitle(list, groupSelfName(myRole))
    const card: Card = {
      members: list,
      myRole,
      speakMode,
      // 指定模式:默认点名第一位成员,之后可在聊天区末尾的胶囊里换人
      assignTarget: speakMode === 'assign' ? list[0] : undefined,
      conversations: [{ name, messages: [] }],
    }
    cards.value.push(card)
    collapsed.value.push(true)
    // 建群后切到群聊列表并选中新建的群聊
    chatMode.value = 'group'
    activeCardIndex.value = cards.value.length - 1
    activeSub.value = conversations.value.length - 1
    return activeSub.value
  }

  // ---- 群聊设置：改名 / 成员增删 / 发言模式 / 删除群聊（落盘由 watch 负责）

  /** 判断某张主卡是不是群聊卡 */
  function isGroupCardAt(cardIndex: number): boolean {
    return isGroupCard(cards.value[cardIndex])
  }

  /** 扮演的角色名；admin / observer / 缺省都算「我本人」出场，返回 null */
  function playedCharacterOf(cardIndex: number): string | null {
    const role = cards.value[cardIndex]?.myRole
    if (!role || role === 'admin' || role === 'observer') return null
    return role
  }

  /** 重命名群聊(空串则回退为按成员推导的默认名) */
  function updateGroupName(cardIndex: number, name: string): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false
    const trimmed = name.trim()
    const next =
      trimmed || groupTitle(card.members ?? [], groupSelfName(card.myRole))
    const conv = card.conversations[0]
    if (!conv || conv.name === next) return false
    conv.name = next
    return true
  }

  /**
   * 更新群聊成员：去重、不设上限；少于 2 人拒绝；扮演的角色不可被移除
   */
  function updateGroupMembers(cardIndex: number, members: string[]): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false

    const list: string[] = []
    for (const m of members) {
      if (m && list.indexOf(m) === -1) list.push(m)
    }
    const locked = playedCharacterOf(cardIndex)
    if (locked && list.indexOf(locked) === -1) return false
    if (list.length < GROUP_SETTINGS_MIN) return false

    // 成员变化后,旧的"指定对象"可能已不在群里 → 顺带清掉
    if (card.assignTarget && list.indexOf(card.assignTarget) === -1) {
      card.assignTarget = list[0]
    }
    card.members = list
    // 成员变了,后端会话里的成员名单就过期了:作废,下一回合自动重建
    card.groupSessionId = undefined
    return true
  }

  /** 更新发言模式(指定模式下未传 target 时默认指向第一个成员) */
  function updateGroupSpeakMode(
    cardIndex: number,
    mode: GroupSpeakMode,
    assignTarget?: string,
  ): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false
    // 后端会话按模式建立调度策略：模式变了就作废，下一回合重建
    if (card.speakMode !== mode) card.groupSessionId = undefined
    else if (mode === 'assign') card.groupSessionId = undefined
    card.speakMode = mode
    if (mode === 'assign') {
      const members = card.members ?? []
      const target =
        assignTarget && members.indexOf(assignTarget) !== -1
          ? assignTarget
          : (card.assignTarget && members.indexOf(card.assignTarget) !== -1
              ? card.assignTarget
              : members[0])
      card.assignTarget = target
    }
    return true
  }

  /** 读取群聊设置(给弹窗做初始值,返回纯数据快照) */
  function getGroupSettings(cardIndex: number): {
    name: string
    members: string[]
    myRole: GroupMyRole
    myRoleLabel: string
    speakMode: GroupSpeakMode
    assignTarget: string
    lockedMember: string | null
  } | null {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return null
    const members = (card.members ?? []).slice()
    const role = card.myRole ?? 'admin'
    const locked = playedCharacterOf(cardIndex)
    return {
      name: card.conversations[0]?.name ?? '',
      members,
      myRole: role,
      myRoleLabel: groupSelfName(role),
      speakMode: card.speakMode ?? 'smart',
      assignTarget: card.assignTarget ?? members[0] ?? '',
      lockedMember: locked,
    }
  }

  /**
   * 当前会话里「我」的署名与头像
   *
   * 必须与消息写入时的 speakerName 同源，否则头像会解析成别人。
   */
  function currentSelfIdentity(targetSub?: number): { name: string; avatar: string } {
    // 显式传 sub 时按该会话所属卡片取身份：否则「锁定会话后发送」会用到另一张卡的身份
    const cardIdx = targetSub === undefined ? activeCardIndex.value : cardIndexOfSub(targetSub)
    const role = cardIdx === null ? undefined : cards.value[cardIdx]?.myRole
    if (role && role !== 'admin' && role !== 'observer') {
      const c = findCharacter(role)
      return { name: role, avatar: c?.avatar || myAvatar.value }
    }
    return { name: MINE_NAME, avatar: myAvatar.value }
  }

  /** 发送图片消息；署名与 sendUserMessage 同一套规则 */
  function sendImage(image: string, width: number, height: number): ChatMessage | null {
    if (activeSub.value === null) return null
    const conv = conversations.value[activeSub.value]
    const nextId = nextMessageId(conv)
    const self = currentSelfIdentity()
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: '',
      image,
      imageW: width,
      imageH: height,
      speakerName: self.name,
      speakerAvatar: self.avatar,
    }
    conv.messages.push(msg)
    // text 不能为空：裸图片会让模型进入「描述图片」模式而忽略人设
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: '[图片]', image })
    return msg
  }

  /**
   * 群聊：插入一条「新话题」提示行
   *
   * 刻意不走 sendUserMessage：话题不是管理员说的话，不进 AI 上下文（后端另有
   * topic 字段）。side 用 'other' 只是让它排在左侧，渲染器不会给它画头像或气泡。
   */
  function addTopicLine(text: string): void {
    const trimmed = (text ?? '').trim()
    if (!trimmed || activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    if (!conv) return
    conv.messages.push({
      id: nextMessageId(conv),
      side: 'other',
      text: trimmed,
      topic: true,
    })
  }

  /** 删除单条消息，同轮其他内容保留；同步清理上下文条目 */
  function deleteMessage(messageId: number) {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const target = conv.messages[idx]
    conv.messages.splice(idx, 1)
    removeFromContextHistory(conv, target)
  }

  /**
   * 删除一轮：长按用户消息则连它后面的第一条回复一起删，长按回复则连它前面的
   * 用户消息一起删；不影响其他轮次，同步清理上下文条目。
   */
  function deleteRound(messageId: number) {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const target = conv.messages[idx]
    const removed: ChatMessage[] = [target]

    if (target.side === 'mine') {
      // 用户消息 → 删除紧随其后的第一条 other 回复
      for (let i = idx + 1; i < conv.messages.length; i++) {
        if (conv.messages[i].side === 'other') {
          removed.push(conv.messages[i])
          break
        }
      }
    } else {
      // AI 回复 → 删除之前的最后一条 mine 消息
      for (let i = idx - 1; i >= 0; i--) {
        if (conv.messages[i].side === 'mine') {
          removed.push(conv.messages[i])
          break
        }
      }
    }

    const ids = new Set(removed.map((m) => m.id))
    conv.messages = conv.messages.filter((m) => !ids.has(m.id))
    for (const m of removed) {
      removeFromContextHistory(conv, m)
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

  /** 清空可见消息，AI 仍记得：先把现有消息固化进上下文，再清空 messages */
  function clearMessagesAt(sub: number) {
    const conv = conversations.value[sub]
    if (!conv) return
    if (conv.contextHistory === undefined) {
      conv.contextHistory = deriveContextEntries(conv.messages)
    }
    conv.messages = []
    // 消息清空后推荐也随之作废,连同持久化缓存一起丢掉(下次点开重新生成)
    delete conv.suggestions
    if (sub === activeSub.value) clearPendingChoices()
  }

  /** 清空 AI 上下文记忆，屏幕上的消息仍可见 */
  function clearContextAt(sub: number) {
    const conv = conversations.value[sub]
    if (conv) {
      conv.contextHistory = []
      // 累计输出 token 必须一起归零，否则智能总结会立刻误触发一次
      conv.sessionOutputTokens = 0
    }
  }

  /** 清空全部对话的可见消息(保留 AI 上下文记忆) */
  function clearAllMessages() {
    conversations.value.forEach((_, i) => clearMessagesAt(i))
  }

  /** 清空全部对话的 AI 上下文记忆(保留可见消息) */
  function clearAllContext() {
    conversations.value.forEach((_, i) => clearContextAt(i))
  }

  // ---- 按主卡聚合的动作（卡片长按菜单用） ----

  /** 某张主卡下所有子对话的全局下标（扁平 conversations 下标） */
  function subIndexesOfCard(cardIndex: number): number[] {
    const range = cardSubRanges.value[cardIndex]
    if (!range || range.count <= 0) return []
    return Array.from({ length: range.count }, (_, i) => range.start + i)
  }

  /**
   * 在指定主卡下新建一段对话
   *
   * 菜单是长按打开的，长按不会选中卡片，所以这里先选中再建 ——
   * createChildConversation 依赖 activeCardIndex，直接调用会建到上次选中的卡上。
   */
  function createChildConversationAt(cardIndex: number): boolean {
    if (cardIndex < 0 || cardIndex >= cards.value.length) return false
    selectCard(cardIndex)
    return createChildConversation()
  }

  /** 清空某张主卡下所有对话的上下文（不动可见消息） */
  function clearContextOfCard(cardIndex: number): void {
    subIndexesOfCard(cardIndex).forEach((sub) => clearContextAt(sub))
  }

  /** 删除某张主卡下的全部对话；内置角色最后一段会按 deleteConversationsAt 的规则退化为清空 */
  function deleteConversationsOfCard(cardIndex: number): number {
    return deleteConversationsAt(subIndexesOfCard(cardIndex))
  }

  /**
   * 摘要必须**冻结**到下一次压缩才更新：两次请求的前缀逐字节一致，缓存才命中。
   * 只改 contextHistory，不动 messages —— 压缩的是发给 AI 的记忆，不是看到的记录。
   * summaryText 为空则只丢弃不插摘要；返回实际丢弃的条目数。
   */
  function applyCompaction(sub: number, dropCount: number, summaryText?: string): number {
    const conv = conversations.value[sub]
    if (!conv) return 0
    const history = conv.contextHistory
    if (!history || history.length === 0) return 0

    const drop = Math.max(0, Math.min(dropCount, history.length))
    const kept = history.slice(drop)
    if (summaryText) {
      const entry: ContextEntry = { side: 'mine', text: summaryText }
      conv.contextHistory = [entry, ...kept]
    } else {
      conv.contextHistory = kept
    }
    return drop
  }

  // ---- 选中消息导出（纯 UI，不持久化）----
  // 这里只管「选哪几条」，排版与出图复用既有实现。

  /** 是否处于"选中消息"模式 */
  const msgSelectMode = ref(false)

  /** 已选消息 id(**当前会话内**) */
  const selectedMsgIds = ref<number[]>([])

  /** 已选条数 */
  const selectedMsgCount = computed(() => selectedMsgIds.value.length)

  /** 某条消息是否已选 */
  function isMsgSelected(id: number): boolean {
    return selectedMsgIds.value.indexOf(id) !== -1
  }

  /** 进入选中消息模式(右键那条默认选中) */
  function startMsgSelect(id?: number): void {
    msgSelectMode.value = true
    selectedMsgIds.value = typeof id === 'number' ? [id] : []
  }

  /** 退出选中消息模式 */
  function exitMsgSelect(): void {
    msgSelectMode.value = false
    selectedMsgIds.value = []
  }

  /** 勾选 / 取消勾选一条消息 */
  function toggleMsgSelect(id: number): void {
    const i = selectedMsgIds.value.indexOf(id)
    if (i === -1) selectedMsgIds.value.push(id)
    else selectedMsgIds.value.splice(i, 1)
  }

  /** 已选消息，**按会话原有顺序**——导出的排版与勾选先后无关 */
  const selectedMessages = computed<ChatMessage[]>(() => {
    if (activeSub.value === null || selectedMsgIds.value.length === 0) return []
    const msgs = conversations.value[activeSub.value]?.messages ?? []
    return msgs.filter((m) => selectedMsgIds.value.indexOf(m.id) !== -1)
  })

  // ---- 批量删除对话 ----

  /** 释放群聊后端会话；失败无妨，传输层会自愈回收 */
  function releaseGroupSession(card: Card): void {
    const sid = card.groupSessionId
    if (!sid) return
    card.groupSessionId = undefined
    // 必须按当前 API 模式选传输层：写死 groupBackend 会让 custom 模式也去打后端
    void groupTransportFor(settingsStore.apiConfig.apiMode)
      .closeGroupSession(sid)
      .catch(() => { /* 忽略 */ })
  }

  /**
   * 批量删除对话（唯一的删除实现，单选就是传一个下标）
   *
   * 内置角色的最后一段不删卡而是清空；一段不剩的卡整张删除。
   */
  function deleteConversationsAt(subs: number[]): number {
    const drop = new Set(subs.filter((s) => s >= 0 && s < conversations.value.length))
    if (drop.size === 0) return 0

    // 删除会让后面的会话整体前移，在途响应以旧下标为 key，必须整体作废
    ai.invalidateAllAiCtx()

    const prevSub = activeSub.value

    // 1) 先算出最终保留哪些子卡（内置角色的「最后一段」在这里变成「清空」）
    const keep = new Set<number>()
    let offset = 0
    for (const card of cards.value) {
      const globals = card.conversations.map((_, li) => offset + li)
      const survivors = globals.filter((g) => !drop.has(g))
      const isBuiltin = CHARACTERS.some((c) => c.name === card.conversations[0]?.name)
      if (survivors.length === 0 && isBuiltin && globals.length > 0) {
        const conv = card.conversations[0]
        conv.messages = []
        conv.contextHistory = []
        keep.add(globals[0])
      } else {
        survivors.forEach((g) => keep.add(g))
      }
      offset += card.conversations.length
    }

    // 2) 落库:倒序处理,边删边算下标不会错位
    let start = conversations.value.length
    for (let ci = cards.value.length - 1; ci >= 0; ci--) {
      const card = cards.value[ci]
      const count = card.conversations.length
      start -= count
      const kept = card.conversations.filter((_, li) => keep.has(start + li))
      if (kept.length === count) continue
      if (kept.length === 0) {
        releaseGroupSession(card)
        cards.value.splice(ci, 1)
        collapsed.value.splice(ci, 1)
        continue
      }
      card.conversations = kept
    }

    // 3) 重选:新下标 = "原选中之前还活着几段"
    const total = keep.size
    const beforePrev = prevSub === null ? 0 : Array.from(keep).filter((g) => g < prevSub).length
    let nextSub: number | null = total === 0 ? null : Math.min(beforePrev, total - 1)

    if (chatMode.value === 'group') {
      // 群聊列表只列群聊：落点不在群聊卡上就挪到最近的一张
      let off = 0
      let firstGroup: number | null = null
      let afterPrev: number | null = null
      for (const card of cards.value) {
        const isGroup = isGroupCard(card)
        if (isGroup) {
          if (firstGroup === null) firstGroup = off
          if (afterPrev === null && prevSub !== null && off >= prevSub) afterPrev = off
        }
        off += card.conversations.length
      }
      if (firstGroup === null) {
        chatMode.value = 'single'
      } else {
        nextSub = afterPrev ?? firstGroup
      }
    }

    activeSub.value = nextSub
    if (nextSub === null) activeCardIndex.value = null
    else syncActiveCardFromSub()

    return drop.size
  }

  /** 每张主卡的展示身份（名称 / 头像 / 是否群聊） */
  const cardCharacters = computed(() =>
    cards.value.map((c) => resolveCardIdentity(c)),
  )

  // ---- AI 响应状态机(独立模块,见 stores/chat/aiResponse.ts) --------------
  // 目标会话锁定、token 失效判定、loading / 中止、分段收尾、错误占位都在那里;
  // 本 store 只把它挂在卡片树状态上,并在结构变更时统一作废在途响应。
  const ai = createAiResponseState({
    conversations,
    activeSub,
    selfIdentity: (targetSub) => currentSelfIdentity(targetSub),
  })
  /** 当前会话是否在等首条内容(LoadingBubble 的判据) */
  const { isLoading } = ai


  /** 子卡预览文本：最后一条消息的内容，图片显示为 [图片] */
  const subPreviewTexts = computed<string[]>(() =>
    conversations.value.map((conv) => {
      const msgs = conv.messages
      if (msgs.length === 0) return ''
      const msg = msgs[msgs.length - 1]
      if (msg.image) return '[图片]'
      return msg.text || ''
    }),
  )

  // ---- 侧边栏模式（单聊 / 群聊）----
  /** single = 只列单聊卡，group = 只列群聊卡 */
  const chatMode = ref<'single' | 'group'>('single')

  /**
   * 切换侧边栏模式
   *
   * 两种模式的会话互不相干，模式真的变了就清空选中态，否则右侧还显示着另一模式的
   * 对话，容易把消息发进「看不见的那张卡」。建群 / 删群直接写 chatMode，不走这里。
   */
  function setChatMode(mode: 'single' | 'group'): void {
    if (chatMode.value === mode) return
    chatMode.value = mode
    clearSelection()
  }

  // ---- 当前会话所属主卡的群聊上下文（供聊天区末尾的控制条使用）----

  /** 当前选中主卡(未选中 / 下标失效时为 null) */
  const activeCard = computed<Card | null>(() => {
    const i = activeCardIndex.value
    if (i === null) return null
    return cards.value[i] ?? null
  })

  /** 当前会话是否为群聊 */
  const activeIsGroup = computed(
    () => isGroupCard(activeCard.value),
  )

  /** 当前群聊的发言模式(非群聊回退 'smart') */
  const activeSpeakMode = computed<GroupSpeakMode>(
    () => activeCard.value?.speakMode ?? 'smart',
  )

  /** 当前群聊里我是否为旁观（缺省视为管理员） */
  const activeIsObserver = computed(() => {
    if (!activeIsGroup.value) return false
    return activeCard.value?.myRole === 'observer'
  })

  /** 当前群聊是否处于"对话进行中" */
  const activeGroupRunning = computed(() => activeCard.value?.groupRunning === true)
  /** 当前群聊最近一次给出的话题(未给出时为空串) */
  const activeGroupTopic = computed(() => activeCard.value?.groupTopic ?? '')

  // ---- 控制条该显示哪些胶囊：**唯一判据** ----
  // GroupFlowControl 用它决定渲染什么，ChatArea 用它决定是否为控制条留滚动高度。
  // 两处各写一份曾导致「组件改了但整块没渲染」。

  /** 是否显示「指定发言」胶囊(指定模式专属:发消息即让被点名者回一条) */
  const activeShowAssign = computed(
    () => activeIsGroup.value && activeSpeakMode.value === 'assign',
  )

  /** 是否显示「开启 / 暂停对话」：非指定模式的群聊一律显示，与身份无关 */
  const activeShowRun = computed(
    () => activeIsGroup.value && activeSpeakMode.value !== 'assign',
  )

  /** 「指定发言」下拉是否展开。不持久化，但 ChatArea 要据此预留滚动高度 */
  const groupPickerOpen = ref(false)

  /** 展开 / 收起角色下拉 */
  function toggleGroupPicker(): void {
    groupPickerOpen.value = !groupPickerOpen.value
  }

  /** 收起角色下拉 */
  function closeGroupPicker(): void {
    groupPickerOpen.value = false
  }

  /** 开启 / 暂停群聊；旁观模式下没设话题则拒绝开启并返回 false */
  function setGroupRunning(running: boolean): boolean {
    const card = activeCard.value
    if (!card || !isGroupCard(card)) return false
    if (running && card.myRole === 'observer' && !(card.groupTopic ?? '').trim()) {
      return false
    }
    card.groupRunning = running
    // 显式开始 / 收尾算一次新回合：「继续对话」的计数与浮窗一并复位
    resetGroupContinue()
    return true
  }

  // ---- 群聊「继续对话」浮窗（每 GROUP_CONTINUE_EVERY 条角色消息一次）----

  /**
   * 浮窗开关，按会话隔离
   *
   * 曾做成全局单例：A 群弹出浮窗后切到 B 群，B 群会把「浮窗还挂着」当成玩家没确认，
   * 于是把 B 群正在跑的回合掐停 —— 表现为「聊着聊着自己暂停了」。
   */
  const groupContinueOpenBySub = ref<Record<number, boolean>>({})

  /** 上次确认时的角色消息条数；用「当前条数 − 基线」现算，避免删消息后对不上 */
  const groupAckBases = ref<Record<number, number>>({})

  /** 某会话里角色们(非我方)说过的消息条数 */
  function countGroupMessages(sub: number): number {
    const msgs = conversations.value[sub]?.messages ?? []
    return msgs.filter((m) => m.side === 'other' && !m.isError && !m.topic).length
  }

  /**
   * 保证某会话有计数基线：首次见到时以「此刻条数」为起点
   *
   * 否则已有 40 条的老群聊一进来就被判成「该确认了」。
   */
  function ensureGroupAckBase(sub: number): number {
    const bases = groupAckBases.value
    const known = bases[sub]
    if (known !== undefined) return known
    const base = countGroupMessages(sub)
    groupAckBases.value = { ...bases, [sub]: base }
    return base
  }

  /** 某会话的浮窗是否挂着(缺省 = 当前会话) */
  function isGroupContinueOpen(sub?: number): boolean {
    const key = sub ?? activeSub.value
    return key === null ? false : groupContinueOpenBySub.value[key] === true
  }

  /** 当前会话的浮窗是否挂着(供组件:GroupContinueNudge 的 visible) */
  const groupContinueOpen = computed(() => isGroupContinueOpen())

  /** 自上次确认以来角色又说了几条（浮窗文案里的数字） */
  const groupMessagesSinceAck = computed(() => {
    const sub = activeSub.value
    if (sub === null) return 0
    const base = groupAckBases.value[sub]
    // 基线未知时按 0 条新增算，不要虚报历史条数
    return base === undefined ? 0 : Math.max(0, countGroupMessages(sub) - base)
  })

  /** 关掉浮窗并把计数基线挪到此刻；targetSub 传 null 表示全部复位 */
  function resetGroupContinue(targetSub?: number): void {
    const sub = targetSub === undefined ? activeSub.value : targetSub
    if (sub === null) {
      groupContinueOpenBySub.value = {}
      groupAckBases.value = {}
      return
    }
    if (groupContinueOpenBySub.value[sub]) {
      const open = { ...groupContinueOpenBySub.value }
      delete open[sub]
      groupContinueOpenBySub.value = open
    }
    groupAckBases.value = { ...groupAckBases.value, [sub]: countGroupMessages(sub) }
  }

  /** 当前会话里角色消息的条数；非群聊恒为 0，免得单聊消息一多就误弹浮窗 */
  const activeGroupCharCount = computed(() => {
    const sub = activeSub.value
    const card = activeCard.value
    if (sub === null || !isGroupCard(card)) return 0
    return countGroupMessages(sub)
  })

  /**
   * 浮窗只看「当前会话的角色消息条数」，不写在回合循环里
   *
   * 写进回合循环时它排在 `if (result.done) break` 之后，轮流模式 done 恒为 true，
   * 那句永远执行不到，于是一直不弹窗。改成盯条数后与发言模式、循环结构无关。
   * 切换会话时计数会突变，那不是「又说了几条」，不能据此弹窗。
   */
  let nudgeProbe: { sub: number | null; count: number } = { sub: null, count: 0 }
  watch(activeGroupCharCount, (next) => {
    const sub = activeSub.value
    if (sub === null) return
    const prev = nudgeProbe.sub === sub ? nudgeProbe.count : next
    nudgeProbe = { sub, count: next }
    if (next <= prev) return
    if (isGroupContinueOpen(sub)) return
    if (next - ensureGroupAckBase(sub) >= GROUP_CONTINUE_EVERY) {
      groupContinueOpenBySub.value = { ...groupContinueOpenBySub.value, [sub]: true }
    }
  })

  /** 玩家点了浮窗里的「继续对话」:关窗 + 重新计数,对话照常往下走 */
  function ackGroupContinue(): void {
    resetGroupContinue()
  }

  /** 记录旁观模式下给出的话题 */
  function setGroupTopic(topic: string): void {
    const card = activeCard.value
    if (!card) return
    card.groupTopic = topic
  }

  /** 指定模式下换人：只接受群内成员，并顺带把模式固定为 assign */
  function setActiveAssignTarget(name: string): boolean {
    const card = activeCard.value
    if (!card || !name) return false
    if ((card.members ?? []).indexOf(name) === -1) return false
    card.speakMode = 'assign'
    card.assignTarget = name
    if (card.groupSessionId) card.groupSessionId = undefined
    return true
  }

  // ---- AI 推荐选项（纯 UI，内容由 AI 逻辑写入）----
  /** 当前待选推荐项；空数组表示无选项 */
  const pendingChoices = ref<PlayerChoice[]>([])

  /** 推荐面板是否展开 */
  const choicesOpen = ref(false)

  /** 写入推荐项；**刻意不自动展开面板**，否则群聊里每回一条都会打断阅读 */
  function setPendingChoices(list: PlayerChoice[]): void {
    pendingChoices.value = Array.isArray(list) ? list.filter((c) => c && c.label) : []
  }

  /** 玩家在本次对话里主动关过推荐面板；切换会话时复位，不持久化 */
  const choicesSuppressed = ref(false)

  function setChoicesSuppressed(v: boolean): void {
    choicesSuppressed.value = v
  }

  // 切换会话：复位抑制态，换上**这段对话自己**缓存过的推荐项，并收掉浮窗
  watch(activeSub, () => {
    choicesSuppressed.value = false
    pendingChoices.value = cachedChoicesOf(activeSub.value)
    choicesOpen.value = false
    // 选中消息只在当前会话内有效:切走后勾选失去意义,直接退出该模式
    msgSelectMode.value = false
    selectedMsgIds.value = []
    // 「继续对话」浮窗属于"这一段对话"的节奏:换会话就收掉并重新计数
    resetGroupContinue()
  })

  // ---- AI 推荐回复的读写（持久化在对话数据里）----
  function cachedChoicesOf(sub: number | null): PlayerChoice[] {
    if (sub === null) return []
    const conv = conversations.value[sub]
    const items = conv?.suggestions?.items
    return Array.isArray(items) ? items.map((label) => ({ label })) : []
  }

  /** 当前这段对话最后一条消息的 id(没有消息 → 0);推荐以此判断是否过期 */
  function tailMessageId(): number {
    const sub = activeSub.value
    if (sub === null) return 0
    const msgs = conversations.value[sub]?.messages
    if (!msgs || msgs.length === 0) return 0
    return msgs[msgs.length - 1]?.id ?? 0
  }

  /** 读当前对话缓存的推荐，调用方据 forMessageId 判断是否已过期 */
  function getConversationSuggestions(): { forMessageId: number; items: string[]; at: number } | null {
    const sub = activeSub.value
    if (sub === null) return null
    const sug = conversations.value[sub]?.suggestions
    if (!sug || sug.items.length === 0) return null
    return { forMessageId: sug.forMessageId, items: [...sug.items], at: sug.at }
  }

  /**
   * 把推荐写进当前对话的持久化数据，同时刷新面板
   *
   * 空数组不写：失败结果不能被缓存成「已验证」。
   */
  function setConversationSuggestions(items: string[], forMessageId: number): void {
    const clean = Array.isArray(items) ? items.filter((t) => typeof t === 'string' && t.length > 0) : []
    if (clean.length === 0) return
    const sub = activeSub.value
    if (sub === null) return
    const conv = conversations.value[sub]
    if (!conv) return
    conv.suggestions = { forMessageId, items: clean, at: Date.now() }
    pendingChoices.value = clean.map((label) => ({ label }))
  }

  /** 清空当前对话缓存的推荐(对话被清空/换人时用) */
  function clearConversationSuggestions(sub: number | null = activeSub.value): void {
    if (sub === null) return
    const conv = conversations.value[sub]
    if (conv?.suggestions) delete conv.suggestions
  }

  /** 清空推荐项并收起面板 */
  function clearPendingChoices(): void {
    pendingChoices.value = []
    choicesOpen.value = false
  }
  /** 切换推荐面板展开状态(空列表也允许展开,便于展示空状态) */
  function toggleChoices(): void {
    // 玩家主动点了按钮 = 明确要看:解除"本次对话不再自动弹出"的抑制
    choicesSuppressed.value = false
    choicesOpen.value = !choicesOpen.value
  }
  /** 仅收起面板、保留推荐项(点击面板外部时调用) */
  function clearChoicesVisibility(): void {
    choicesOpen.value = false
  }

  const playedMessages = computed<ChatMessage[]>(() => {
    if (activeSub.value === null) return []
    return conversations.value[activeSub.value].messages
  })

  /** 加载气泡的朝向；isLoading 按会话算，切走自然为 false，不用手动关 */
  const loadingSide = computed<'other' | 'mine' | null>(() => {
    if (!isLoading.value) return null
    return 'other'
  })

  function toggleCollapse(index: number) {
    collapsed.value[index] = !collapsed.value[index]
  }

  /** 切换当前对话，同时同步所属主卡 */
  function selectSub(index: number) {
    activeSub.value = index
    activeCardIndex.value = cardIndexOfSub(index)
  }

  /** 回到「未选中任何对话 / 角色」的初始状态 */
  function clearSelection() {
    activeSub.value = null
    activeCardIndex.value = null
  }

  /** 补齐缺失的内置角色卡：导入 / 恢复 / 清空后保证每个内置角色都还在 */
  function mergeBuiltinCards(next: Card[]): Card[] {
    const validNames = new Set(CHARACTERS.map((c) => c.name))
    const isGroup = (c: Card) => isGroupCard(c)

    const result: Card[] = []
    for (const c of next) {
      // ⚠️ 群聊卡的子对话名是群名，不在干员表里。早期按名字统一过滤，群聊卡在恢复时
      // 被整张删掉。名字认不出、也认不出是群聊时，只有完全空壳才丢弃 —— 有内容的一律留。
      if (!isGroup(c) && !validNames.has(c.conversations[0]?.name ?? '')) {
        const hasContent = c.conversations.some(
          (cv) => cv.messages.length > 0 || (cv.contextHistory?.length ?? 0) > 0,
        )
        if (!hasContent || isLegacyDemoGroupShell(c)) continue
      }
      // ⚠️ 必须用展开保留卡片级字段（members / myRole / speakMode…），
      // 只重建 conversations 会让群聊卡一恢复就退化成单聊卡
      result.push({ ...c })
    }

    // ⚠️ 补到最前面并按 CHARACTERS 顺序：追加到末尾的话，老玩家永远看不到新角色
    const known = new Set(
      result.filter((c) => !isGroup(c)).map((c) => c.conversations[0]?.name),
    )
    const missing: Card[] = []
    for (const c of CHARACTERS) {
      if (!known.has(c.name)) {
        missing.push({
          conversations: [{ name: c.name, messages: [] }],
        })
      }
    }
    result.unshift(...missing)
    return result
  }

  // 列表动态排序：键的算法与排序规则在 domain/chat/activity.ts，这里只管时间章状态
  /**
   * 消息本身没有时间戳，故侧记：哪张卡的消息条数变多，就盖一个当前时间章。
   * 键是稳定标识，可安全落盘，刷新后顺序照旧。
   */
  const cardActiveAt = ref<Record<string, number>>({})

  /** 各主卡当前的消息总条数(侦测"哪张卡刚来了消息"用) */
  const cardMsgCounts = computed(() =>
    cards.value.map((c) => c.conversations.reduce((n, cv) => n + cv.messages.length, 0)),
  )

  /**
   * 整体替换卡片树期间不打时间章
   *
   * 导入 / 清空会让所有卡的消息数同时变化，时间章会几乎同一刻盖下，列表顺序变随机。
   */
  let activitySealed = false

  // 侦测覆盖所有追加路径（发言 / AI 回复 / 轮流 / 预置消息），新增入口自动生效
  watch(cardMsgCounts, (next, prev) => {
    if (activitySealed || !prev || prev.length !== next.length) return
    const touched = next
      .map((n, i) => (n > (prev[i] ?? 0) ? cards.value[i] : null))
      .filter((c): c is Card => !!c)
    if (touched.length === 0) return
    const now = Date.now()
    const map: Record<string, number> = { ...cardActiveAt.value }
    for (const c of touched) map[cardActiveKey(c)] = now
    // 顺手清掉已经不存在的卡留下的记录(删卡 / 换数据集),别让表无限长
    const live = new Set(cards.value.map(cardActiveKey))
    for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    cardActiveAt.value = map
  })

  /** 用落盘的排序记录覆盖内存态；传入的不是对象时保持原状 */
  function applyCardActivity(raw: unknown): void {
    const next = parseActivity(raw)
    if (next) cardActiveAt.value = next
  }

  /** 导出当前列表顺序为稳定标识数组（换设备 / 增删卡片都不会串号） */
  function exportCardOrder(): string[] {
    return sortKeysByActivity(cards.value.map(cardActiveKey), cardActiveAt.value)
  }

  /** 应用一份顺序（导入时用）：排在前面的时间更大，未列出的压到末尾 */
  function applyCardOrder(order: unknown): void {
    const live = new Set(cards.value.map(cardActiveKey))
    const next = activityFromOrder(order, cardActiveAt.value, live, Date.now())
    if (next) cardActiveAt.value = next
  }

  /**
   * 子对话（主卡下面的子卡）的最后活跃时刻
   *
   * 主卡能按卡片身份记账；子对话没有稳定 id（同一张卡下的多段对话常常同名），
   * 所以键用「卡片身份 + 子对话在该卡内的下标」。它**只决定渲染顺序**，不动
   * conversations 数组 —— activeSub / 全局子卡下标完全不变，运行期不会串位。
   */
  const subActiveAt = ref<Record<string, number>>({})

  /** 扁平化后每段子对话的消息条数（侦测"哪段子对话刚来了消息"） */
  const subMsgCounts = computed(() =>
    cards.value.flatMap((c) => c.conversations.map((cv) => cv.messages.length)),
  )

  // 与主卡同一套判据：只看「条数变多」，新增/删除子对话（长度变化）不盖章
  watch(subMsgCounts, (next, prev) => {
    if (activitySealed || !prev || prev.length !== next.length) return
    const now = Date.now()
    const map: Record<string, number> = { ...subActiveAt.value }
    const live = new Set<string>()
    let off = 0
    for (const card of cards.value) {
      const key = cardActiveKey(card)
      for (let k = 0; k < card.conversations.length; k++) {
        const id = `${key}#${k}`
        live.add(id)
        if ((next[off + k] ?? 0) > (prev[off + k] ?? 0)) map[id] = now
      }
      off += card.conversations.length
    }
    // 删掉的子对话留下的记录顺手清掉，别让表无限长
    for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    subActiveAt.value = map
  })

  /** 用落盘的子对话活跃记录覆盖内存态；传入的不是对象时保持原状 */
  function applySubActivity(raw: unknown): void {
    const next = parseActivity(raw)
    if (next) subActiveAt.value = next
  }

  /**
   * 整体替换卡片树并重置全部运行时态（导入 / 清空 / 恢复共用的唯一入口）
   *
   * @param next 新卡片树，调用方负责 sanitize
   */
  function replaceAllCards(next: Card[]) {
    // 关掉时间章并清空旧记录：否则整列表会被「同一时刻」重排成随机顺序
    activitySealed = true
    cardActiveAt.value = {}
    // 子对话下标整体失效，旧记录只会把顺序搅乱
    subActiveAt.value = {}
    // 补齐退化成单聊壳的群聊卡（旧数据里 members 整体缺失）：导入与恢复的公共收口
    cards.value = mergeBuiltinCards(repairCardGroups(next))
    collapsed.value = cards.value.map(() => true)
    activeSub.value = null
    activeCardIndex.value = null
    // 旧会话下标全部失效：作废在途响应（除清状态外还要 abort，别让它们继续花钱）
    ai.invalidateAllAiCtx()
    void nextTick(() => {
      activitySealed = false
    })
  }

  /** 循环切到下一张顶部聊天条图片（放 store 是为了导出的图与主界面一致） */
  function cycleStrip(): void {
    stripVariantIndex.value = (stripVariantIndex.value + 1) % 3
  }

  /** 直接设置聊天条下标（恢复 / 导入时用） */
  function setStripVariant(idx: number): void {
    stripVariantIndex.value = ((idx % 3) + 3) % 3
  }

  /**
   * 取当前对话的聊天历史，用于构建 LLM 请求
   *
   * 优先 contextHistory；未初始化的旧数据从 messages 派生。
   *
   * @param targetSub 锁定回合的调用方必须显式传入，否则等待期间玩家切走会拿到
   *                  另一段对话的历史（人设与历史错配）
   */
  function getChatHistory(targetSub?: number): Array<{ side: 'other' | 'mine'; text: string; image?: string }> {
    const sub = targetSub ?? activeSub.value
    if (sub === null) return []
    const conv = conversations.value[sub]
    if (!conv) return []
    if (conv.contextHistory !== undefined) {
      return conv.contextHistory
    }
    return deriveContextEntries(conv.messages)
  }

  /**
   * 当前会话累计的输出 token（后端 completion_tokens）
   *
   * 智能总结用它加固定提示词长度，判断是否触及上下文窗口的 80%。锁定回合的
   * 调用方必须显式传 targetSub，否则等待期间切走会把计数记到别人头上。
   */
  function getSessionOutputTokens(targetSub?: number): number {
    const sub = targetSub ?? activeSub.value
    if (sub === null) return 0
    return conversations.value[sub]?.sessionOutputTokens ?? 0
  }

  /** 累加某会话的输出 token（后端上报的 completion_tokens；targetSub 缺省 = 当前会话） */
  function addSessionOutputTokens(delta: number, targetSub?: number): void {
    const sub = targetSub ?? activeSub.value
    if (sub === null) return
    if (!Number.isFinite(delta) || delta <= 0) return
    const conv = conversations.value[sub]
    if (!conv) return
    conv.sessionOutputTokens = (conv.sessionOutputTokens ?? 0) + delta
  }

  /**
   * 输出 token 计数归零（总结完成后调用）
   *
   * 摘要已替代被总结的那段历史，继续累加会让计数虚高，每轮都触发总结。
   */
  function resetSessionOutputTokens(targetSub?: number): void {
    const sub = targetSub ?? activeSub.value
    if (sub === null) return
    const conv = conversations.value[sub]
    if (conv) conv.sessionOutputTokens = 0
  }

  return {
    // 数据
    cards,
    conversations,
    collapsed,
    cardSubRanges,
    /** 主卡标识 → 最后一次来消息的时刻(列表按它动态排序,见 CharacterCardList) */
    cardActiveAt,
    /** 取某张主卡的排序标识(CharacterCardList 查 cardActiveAt 用) */
    cardActiveKey,
    exportCardOrder,
    applyCardOrder,
    /** 恢复排序记录(持久化层调用) */
    applyCardActivity,
    /** 子对话活跃时刻（只影响卡内的渲染顺序） */
    subActiveAt,
    applySubActivity,
    activeSub,    counterpartName,
    currentOtherAvatarUrl,
    myAvatar,
    myGender,
    cardCharacters,
    // 会话创作
    selectCardConversation,
    createChildConversation,
    createGroupCard,
    activeCard,
    activeIsGroup,
    activeSpeakMode,
    activeIsObserver,
    activeGroupRunning,
    activeGroupTopic,
    activeShowAssign,
    activeShowRun,
    setGroupRunning,
    setGroupTopic,
    // 群聊「继续对话」浮窗(每 GROUP_CONTINUE_EVERY 条角色消息一次)
    groupMessagesSinceAck,
    groupContinueOpen,
    /** 某段会话的「继续对话」浮窗是否挂着(群聊回合判定"本回合锁定的那段") */
    isGroupContinueOpen,
    ackGroupContinue,
    resetGroupContinue,
    setActiveAssignTarget,
    groupPickerOpen,
    toggleGroupPicker,
    closeGroupPicker,
    updateGroupName,
    updateGroupMembers,
    updateGroupSpeakMode,
    getGroupSettings,
    // 侧边栏模式(单聊 / 群聊)
    chatMode,
    setChatMode,
    // 推荐选项(纯 UI 能力;内容由对接的 AI 逻辑写入)
    pendingChoices,
    choicesOpen,
    choicesSuppressed,
    setChoicesSuppressed,
    setPendingChoices,
    clearPendingChoices,
    toggleChoices,
    clearChoicesVisibility,
    // 推荐回复的持久化读写(存在对话数据里,重开软件不丢)
    tailMessageId,
    getConversationSuggestions,
    setConversationSuggestions,
    clearConversationSuggestions,
    sendImage,
    addTopicLine,
    deleteConversationsAt,
    // 选中消息导出(纯 UI)
    msgSelectMode,
    selectedMsgIds,
    selectedMsgCount,
    selectedMessages,
    isMsgSelected,
    startMsgSelect,
    exitMsgSelect,
    toggleMsgSelect,
    clearAllConversations,
    clearMessagesAt,
    clearContextAt,
    // 按主卡聚合（卡片长按菜单）
    subIndexesOfCard,
    createChildConversationAt,
    clearContextOfCard,
    deleteConversationsOfCard,
    applyCompaction,
    clearAllMessages,
    clearAllContext,
    toggleMyGender,
    setMyGender,
    // 动态命名
    currentConversationMeta,
    /** 按显式下标取会话展示信息(锁定的 AI 回合取自己那段的名字/头像) */
    conversationMetaAt,
    // AI 响应状态机(上下文 / loading / 中止 / 分段收尾,见 stores/chat/aiResponse.ts)
    ...ai,
    subPreviewTexts,
    playedMessages,
    loadingSide,
    /** 点聊天区"对方"头像:该角色有两张形象就换一张(目前只有「管理员」) */
    toggleCounterpartAvatarAlt,
    /** 取某角色第二张形象的 URL(设置里切过才有值;消息头像解析用它) */
    altAvatarOf,
    // 玩家选择
    toggleCollapse,
    selectSub,
    selectCard,
    clearSelection,
    activeCardIndex,
    replaceAllCards,
    cycleStrip,
    setStripVariant,
    stripVariantIndex,
    // 公共头像解析(聊天区渲染共用)
    resolveMessageAvatar,
    // 群聊「扮演某角色」发出的消息判别(头像点击切换性别时排除)
    isRolePlayMessage,
    // 上下文与用量计数(仍在 store:它们读写的是会话数据,不是响应状态)
    getChatHistory,
    getSessionOutputTokens,
    addSessionOutputTokens,
    resetSessionOutputTokens,
    // 长按删除(单条 / 整轮)
    deleteMessage,
    deleteRound,
  }
})
