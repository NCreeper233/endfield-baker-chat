// =============================================================================
// 群聊「开启 / 暂停 / 恢复对话」(useGroupRunControl)
// -----------------------------------------------------------------------------
// 唯一的渲染位置:底部输入面板里的圆形按钮(ChatInput,与单聊"停止"同款)。
// (聊天区末尾那颗旧胶囊已删除,不再有第二个位置。)
//
// 语义(与 store 的 activeShowRun / groupRunning 配套):
//   暂停 = 立即中止当前回合,并把"进行中"持久化为 false(写进工程数据);
//          暂停期间玩家**可以照常发消息**,只是 AI 不回复
//   恢复 = 从当前进度继续(智能模式继续判断下一位并产出,直到玩家再次暂停)
//   开启 = 从未聊起来过时的第一下(旁观模式必须先给出话题)
//
// 状态存在 Card.groupRunning 上,随工程数据持久化;页面重开后 busy 必为 false、
// groupRunning 保留,因此按钮显示「恢复对话」,玩家一点就接着聊。
//
// 【另一处自动暂停】切换对话时会自动执行同一套暂停语义(见 useGroupChat 的
// bindSwitchGuard):否则回合会在玩家看不见的会话里继续烧额度。
// =============================================================================

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../stores/chat'
import { useGroupChat } from '../composables/useGroupChat'
import { devWarn } from '../utils/logger'

/**
 * @param hint 需要提示用户时的回调(由调用方弹提示框;缺省静默)
 */
export function useGroupRunControl(hint: (text: string) => void = () => {}) {
  const chatStore = useChatStore()
  const groupChat = useGroupChat()
  const { activeGroupRunning } = storeToRefs(chatStore)

  /** 当前是否正在生成(此时点击 = 暂停) */
  const running = computed(() => groupChat.busy.value)

  /**
   * 这段群聊是否已经"聊起来过"(历史里已有角色发言)
   *
   * 用于区分按钮文案:没聊过 → 「开启对话」;聊过 → 「恢复对话」。
   * 「新话题」提示行(topic)不算角色发言。
   */
  const hasStarted = computed(() => {
    const sub = chatStore.activeSub
    if (sub === null) return false
    const msgs = chatStore.conversations[sub]?.messages ?? []
    return msgs.some((m) => m.side === 'other' && !(m as { topic?: boolean }).topic)
  })

  /**
   * 推进按钮的文案
   *
   *   正在生成       → 暂停对话
   *   已开始过/进行中 → 恢复对话(含"页面重开后从上次状态继续")
   *   从未开始       → 开启对话
   */
  const runLabel = computed(() => {
    if (running.value) return '暂停对话'
    if (activeGroupRunning.value || hasStarted.value) return '恢复对话'
    return '开启对话'
  })

  /** 点击:暂停 / 开始·恢复 */
  async function onToggleRun(): Promise<void> {
    // ---- 暂停 ----
    if (groupChat.busy.value) {
      groupChat.abort()
      chatStore.setGroupRunning(false)
      return
    }
    // ---- 开始 / 恢复 ----
    // 旁观模式必须先给出话题:setGroupRunning(true) 会在无话题时拒绝
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
