// importMerge —— 导入数据的合并规则（纯函数）
// 群聊卡直接追加；单聊卡按角色名并入本地同名卡、不覆盖。「覆盖」模式不走这里。
import type { Card, Conversation } from '../types/chat'
// 群聊判定必须用领域层那一份，自己再写 members.length >= 2 迟早走散
import { isGroupCard } from '../domain/chat/group'

export { isGroupCard }

/** 取首个子对话的 name；群聊卡不适用 */
function cardCharacterName(card: Card): string {
  return card.conversations[0]?.name ?? ''
}

/**
 * 只深拷贝 messages / contextHistory 这类可变数组：合并后 store 会就地修改它们，
 * 若与导入 payload 共享同一个数组，撤销/重导时会互相污染。
 */
function cloneConversation(conv: Conversation): Conversation {
  return {
    ...conv,
    messages: (conv.messages ?? []).map((m) => ({ ...m })),
    contextHistory: conv.contextHistory
      ? conv.contextHistory.map((e) => ({ ...e }))
      : conv.contextHistory,
    suggestions: conv.suggestions
      ? { ...conv.suggestions, items: [...conv.suggestions.items] }
      : conv.suggestions,
  }
}

/** 深拷贝一张卡片（含 conversations / members） */
function cloneCard(card: Card): Card {
  return {
    ...card,
    conversations: (card.conversations ?? []).map(cloneConversation),
    members: card.members ? [...card.members] : card.members,
  }
}

/** 统计合并结果，便于给用户提示 */
export interface MergeStats {
  /** 追加到已有角色名下的对话数 */
  appended: number
  createdCards: number
  /** 导入的群聊卡数 */
  groupCards: number
  /** 本地同名角色原本没有对话，直接写入的对话数 */
  filledEmpty: number
}

export interface MergeResult {
  cards: Card[]
  stats: MergeStats
}

/** 返回新的卡片数组，不修改入参 */
export function mergeCards(local: Card[], incoming: Card[]): MergeResult {
  const base = (local ?? []).map(cloneCard)
  const stats: MergeStats = { appended: 0, createdCards: 0, groupCards: 0, filledEmpty: 0 }

  // 角色名 → 本地卡下标（只记单聊卡）
  const singleIndexByName = new Map<string, number>()
  base.forEach((card, i) => {
    if (isGroupCard(card)) return
    const name = cardCharacterName(card)
    if (name && !singleIndexByName.has(name)) singleIndexByName.set(name, i)
  })

  for (const raw of incoming ?? []) {
    const card = cloneCard(raw)
    const convs = card.conversations ?? []

    // 群聊卡直接追加
    if (isGroupCard(card)) {
      base.push(card)
      stats.groupCards += 1
      stats.createdCards += 1
      continue
    }

    const name = cardCharacterName(card)
    // 没有角色名（异常数据）→ 当作新卡追加，避免与任意角色错误合并
    if (!name) {
      base.push(card)
      stats.createdCards += 1
      continue
    }

    const hit = singleIndexByName.get(name)
    if (hit === undefined) {
      // 本地没有该角色 → 新建卡
      base.push(card)
      singleIndexByName.set(name, base.length - 1)
      stats.createdCards += 1
      continue
    }

    const target = base[hit]
    const hasLocalConv = (target.conversations ?? []).length > 0
    if (!hasLocalConv) {
      // 本地有该角色但一条对话都没有 → 直接写入，不留空对话
      target.conversations = convs.map(cloneConversation)
      stats.filledEmpty += convs.length
      continue
    }

    // 本地已有该角色 → 导入的每段作为新对话追加
    for (const c of convs) {
      // 不往列表里塞空对话卡
      if ((c.messages ?? []).length === 0 && (c.contextHistory ?? []).length === 0) continue
      target.conversations.push(cloneConversation(c))
      stats.appended += 1
    }
  }

  return { cards: base, stats }
}

/** 生成给用户看的合并结果文案 */
export function describeMerge(stats: MergeStats): string {
  const parts: string[] = []
  if (stats.appended > 0) parts.push(`为已有角色追加 ${stats.appended} 段对话`)
  if (stats.createdCards > 0) parts.push(`新增 ${stats.createdCards} 张卡`)
  if (stats.filledEmpty > 0) parts.push(`写入 ${stats.filledEmpty} 段对话`)
  if (parts.length === 0) return '没有可合并的新数据（导入内容与本地重复或为空）'
  return `合并完成：${parts.join('，')}。`
}
