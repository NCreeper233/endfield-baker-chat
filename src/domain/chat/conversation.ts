// conversation —— 会话与消息的纯逻辑（消息 id、上下文条目、AI 消息插入位置）

import type { ChatMessage, ContextEntry, Conversation } from '../../types/chat'

/** 取对话内当前最大 id + 1 */
export function nextMessageId(conv: Pick<Conversation, 'messages'>): number {
  return conv.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
}

export function toContextEntry(msg: ChatMessage): ContextEntry {
  const entry: ContextEntry = { side: msg.side, text: msg.text }
  if (msg.image) entry.image = msg.image
  return entry
}

/** 从可见消息派生上下文历史，供旧数据（contextHistory 未初始化）回退 */
export function deriveContextEntries(messages: ChatMessage[]): ContextEntry[] {
  // 必须排除错误气泡：否则一条「网络连接失败」会被当成角色发言重发给模型
  return messages
    .filter((m) => !m.isError && (m.text || m.image))
    .map(toContextEntry)
}

/** 条目没有 id，只能按内容匹配：图片比 image，文字比 side + text */
export function matchContextEntry(entry: ContextEntry, msg: ChatMessage): boolean {
  if (entry.side !== msg.side) return false
  if (msg.image) return entry.image === msg.image
  return entry.text === msg.text && !entry.image
}

/** 从后往前删，避免误删更早的同内容条目 */
export function removeFromContextHistory(conv: Conversation, msg: ChatMessage): boolean {
  const ch = conv.contextHistory
  if (!ch) return false
  for (let i = ch.length - 1; i >= 0; i--) {
    if (matchContextEntry(ch[i], msg)) {
      ch.splice(i, 1)
      return true
    }
  }
  return false
}

/**
 * 算出新 AI 消息该插入的下标；-1 表示锚点已不存在，调用方退化为追加
 *
 * 重新生成时要从「本轮已落位的最后一条」继续往后排，保证多段回复不倒挂；
 * 只跨过连续的 other，遇到用户消息就停 —— 那已经是下一轮了。
 *
 * @param anchorId 被重新生成那一轮的用户消息 id
 * @param lastInsertedId 本轮最后一条已落位的 AI 消息 id
 */
export function findAiInsertIndex(
  messages: ChatMessage[],
  anchorId: number | undefined,
  lastInsertedId?: number,
): number {
  if (anchorId === undefined) return messages.length

  const baseIdx = messages.findIndex((m) => m.id === (lastInsertedId ?? anchorId))
  const anchorIdx = baseIdx !== -1 ? baseIdx : messages.findIndex((m) => m.id === anchorId)
  if (anchorIdx === -1) return -1

  let at = anchorIdx
  while (at + 1 < messages.length && messages[at + 1].side === 'other') at++
  return at + 1
}
