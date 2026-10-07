// =============================================================================
// useMessageMenu:消息操作菜单的"同时只允许一个"
// -----------------------------------------------------------------------------
// 菜单挂在每一行消息上(右键 / 长按打开),若各行各管各的显示状态,就会同时
// 冒出好几个 —— 玩家右键另一条消息时,前一个还留在屏幕上。
//
// 故用一个模块级"占用权"收敛:谁最后打开,谁持有;持有者一换,上一行的菜单
// 自动关闭(它的显示判据就是"自己是不是持有者")。
//
// 占用权同时接管页面级状态(禁止文本选择):长按消息时浏览器会顺手选中文字,
// 这个 class 由持有者加、持有者摘 —— 交给同一处管理,才不会出现"别人的菜单
// 还开着,这条却被摘掉了 class"。
// =============================================================================

import { ref } from 'vue'

/**
 * 当前持有菜单的消息标识
 *
 * 形如 `${会话下标}:${row.key}` —— 带上会话下标是必要的:行标识只保证
 * 同一会话内唯一(消息 id 是会话内自增),切会话后会出现同名的行;
 * 带上会话后,切换对话时旧菜单的判据自然不再成立,菜单随之关闭。
 */
const messageMenuKey = ref<string | null>(null)

/** 打开菜单:抢占占用权(上一行的菜单会因此立即关闭) */
export function openMessageMenu(key: string): void {
  messageMenuKey.value = key
  document.body.classList.add('msg-menu-open')
}

/** 关闭菜单:仅持有者有权释放,避免误关别人的菜单 */
export function closeMessageMenu(key: string): void {
  if (messageMenuKey.value !== key) return
  messageMenuKey.value = null
  document.body.classList.remove('msg-menu-open')
}

export { messageMenuKey }
