// =============================================================================
// importMerge.ts —— 导入数据的「合并」规则（2026-09-30 新增）
// -----------------------------------------------------------------------------
// 为什么单独成文件：合并规则是纯函数（输入 = 本地卡片 + 导入卡片，输出 = 合并后卡片），
// 不依赖 DOM / store，便于单测与复用（DataManagerDialog / 未来的云取回都可能用到）。
//
// 规则（用户口径，逐条落实）：
//   1. 群聊卡（members ≥ 2）：**直接追加**为一张新卡，不做合并匹配。
//   2. 单聊卡（角色卡，用角色名识别）：
//      a. 本地已有该角色的对话（本地卡在该角色名下已有 conversations）
//         → 把导入的每段对话都作为**新的对话卡追加**到该角色名下（不覆盖、不清空）
//      b. 本地已有该角色，但**没有任何对话**
//         → 直接写入导入的对话（不留空对话占位）
//      c. 本地没有该角色
//         → 新建一张该角色的卡并写入导入的对话
//
// 「覆盖」模式不走这里 —— 覆盖 = 直接用导入的卡片替换全部本地卡片（旧行为）。
// =============================================================================
import type { Card, Conversation } from '../types/chat'

/** 群聊卡判定：成员数 ≥ 2（与 stores/chat.ts 的 GROUP_MIN_MEMBERS 一致） */
const GROUP_MIN_MEMBERS = 2

/** 某张主卡是否为群聊卡 */
export function isGroupCard(card: Card): boolean {
  return (card.members ?? []).length >= GROUP_MIN_MEMBERS
}

/** 单聊卡的角色名（取首个子对话的 name；群聊卡不适用） */
function cardCharacterName(card: Card): string {
  return card.conversations[0]?.name ?? ''
}

/**
 * 深拷贝一段对话（只深拷贝 messages / contextHistory 这类可变数组）
 *
 * 合并会把导入的数据挂到本地卡片树上，之后 store 会就地修改这些对象
 * （追加消息、写 contextHistory）。若直接引用导入 payload 里的对象，
 * 会出现"本地与 payload 共享同一个 messages 数组"的隐患（撤销/重导时互相污染）。
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
  /** 新建的角色/群聊卡数 */
  createdCards: number
  /** 导入的群聊卡数（直接追加） */
  groupCards: number
  /** 因本地同名角色为空而直接写入的对话数 */
  filledEmpty: number
}

export interface MergeResult {
  cards: Card[]
  stats: MergeStats
}

/**
 * 把 `incoming` 合并进 `local`，返回新的卡片数组（**不修改**入参）
 *
 * @param local    本地现有卡片
 * @param incoming 导入的卡片
 */
export function mergeCards(local: Card[], incoming: Card[]): MergeResult {
  const base = (local ?? []).map(cloneCard)
  const stats: MergeStats = { appended: 0, createdCards: 0, groupCards: 0, filledEmpty: 0 }

  // 角色名 → 本地卡下标（只记单聊卡；群聊卡不参与按角色合并）
  const singleIndexByName = new Map<string, number>()
  base.forEach((card, i) => {
    if (isGroupCard(card)) return
    const name = cardCharacterName(card)
    if (name && !singleIndexByName.has(name)) singleIndexByName.set(name, i)
  })

  for (const raw of incoming ?? []) {
    const card = cloneCard(raw)
    const convs = card.conversations ?? []

    // ---- 规则 1：群聊卡直接追加 ----
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
      // ---- 规则 2c：本地没有该角色 → 新建卡 ----
      base.push(card)
      singleIndexByName.set(name, base.length - 1)
      stats.createdCards += 1
      continue
    }

    const target = base[hit]
    const hasLocalConv = (target.conversations ?? []).length > 0
    if (!hasLocalConv) {
      // ---- 规则 2b：本地有该角色但没有任何对话 → 直接写入，不留空对话 ----
      target.conversations = convs.map(cloneConversation)
      stats.filledEmpty += convs.length
      continue
    }

    // ---- 规则 2a：本地已有该角色的对话 → 导入的每段作为新对话卡追加 ----
    for (const c of convs) {
      // 导入的对话可能是"空壳"（无消息、无上下文）——不往列表里塞空对话卡
      if ((c.messages ?? []).length === 0 && (c.contextHistory ?? []).length === 0) continue
      target.conversations.push(cloneConversation(c))
      stats.appended += 1
    }
    // 卡片级群聊字段不合并（单聊卡没有这些字段，显式保留本地值）
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
