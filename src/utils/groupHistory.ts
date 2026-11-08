// groupHistory —— 把会话消息整理成群聊服务要的历史格式
// 错误气泡必须排掉：字段名是 isError（写成 error 会静默失效，错误提示就会被当
// 角色发言重发给模型）。话题提示行也不进历史 —— 话题由 topic 字段单独传。

import type { ChatMessage } from '../types/chat'
import type { GroupHistoryItem } from './groupBackend'

/** messages 应在回合开始时锁定；me 是我方在该群的显示名 */
export function buildGroupHistory(
  messages: readonly ChatMessage[] | null | undefined,
  me: string,
): GroupHistoryItem[] {
  const out: GroupHistoryItem[] = []
  for (const m of messages ?? []) {
    if (!m) continue
    if (m.isError) continue
    if (m.topic) continue
    const text = (m.text ?? '').trim()
    if (!text && !m.image) continue
    out.push({
      side: m.side === 'mine' ? 'mine' : 'other',
      text,
      speaker: m.side === 'mine' ? me : (m.speakerName || ''),
      image: m.image,
    })
  }
  return out
}
