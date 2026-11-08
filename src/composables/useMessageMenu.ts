// useMessageMenu —— 消息菜单的「同时只允许一个」
// 每行各管各的显示状态就会同时冒出好几个，故用模块级占用权收敛：持有者一换，
// 上一行的菜单自然关闭。页面级禁用选中（body.msg-menu-open）也归持有者管理。

import { ref } from 'vue'

/**
 * 当前持有菜单的消息标识，形如 `${会话下标}:${row.key}`。
 * 必须带会话下标：行标识只保证会话内唯一，切走后旧菜单的判据自然不成立。
 */
const messageMenuKey = ref<string | null>(null)

/** 抢占占用权，上一行的菜单会立即关闭 */
export function openMessageMenu(key: string): void {
  messageMenuKey.value = key
  document.body.classList.add('msg-menu-open')
}

/** 只有持有者有权释放，避免误关别人的菜单 */
export function closeMessageMenu(key: string): void {
  if (messageMenuKey.value !== key) return
  messageMenuKey.value = null
  document.body.classList.remove('msg-menu-open')
}

export { messageMenuKey }
