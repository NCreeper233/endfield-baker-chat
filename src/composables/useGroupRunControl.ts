// useGroupRunControl —— 群聊「开启 / 暂停 / 恢复对话」，唯一入口是底部面板的圆形按钮
// 暂停 = 立即中止本轮并把 groupRunning 持久化为 false，暂停期间仍可发消息、只是 AI 不回复。
// 状态存在 Card.groupRunning 上：重开后 busy 为 false 而 groupRunning 保留，按钮显示「恢复对话」。

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../stores/chat'
import { useGroupChat } from '../composables/useGroupChat'
import { devWarn } from '../utils/logger'

/** @param hint 需要提示用户时的回调，缺省静默 */
export function useGroupRunControl(hint: (text: string) => void = () => {}) {
  const chatStore = useChatStore()
  const groupChat = useGroupChat()
  const { activeGroupRunning } = storeToRefs(chatStore)

  /** 正在生成时点击 = 暂停 */
  const running = computed(() => groupChat.busy.value)

  /** 历史里已有角色发言（话题提示行不算）→ 文案用「恢复对话」 */
  const hasStarted = computed(() => {
    const sub = chatStore.activeSub
    if (sub === null) return false
    const msgs = chatStore.conversations[sub]?.messages ?? []
    return msgs.some((m) => m.side === 'other' && !(m as { topic?: boolean }).topic)
  })

  /** 正在生成 → 暂停；聊过或进行中 → 恢复；从未开始 → 开启 */
  const runLabel = computed(() => {
    if (running.value) return '暂停对话'
    if (activeGroupRunning.value || hasStarted.value) return '恢复对话'
    return '开启对话'
  })

  async function onToggleRun(): Promise<void> {
    if (groupChat.busy.value) {
      groupChat.abort()
      chatStore.setGroupRunning(false)
      return
    }
    // 旁观模式没设话题时 setGroupRunning(true) 会拒绝
    if (!chatStore.setGroupRunning(true)) {
      hint('请先设置话题')
      return
    }
    try {
      await groupChat.startConversation()
    } catch (e) {
      devWarn('[group] 开启对话失败:', e)
      hint('群聊推进失败,请稍后重试')
    }
  }

  return { running, hasStarted, runLabel, onToggleRun }
}
