// useMenuOwner —— 全局「同一时刻只允许一个行动菜单」
//
// 消息、主卡、子卡、群卡、长按打开的菜单全部共用一个占用权：
// 任何一个打开都会顶掉上一个，页面上永远只有一张菜单。
//
// 每个菜单自己持有一个稳定 key（消息是「会话下标:行标识」，卡片是「card:下标」这类），
// 打开时抢占，关闭时只有持有者能释放 —— 避免关掉别人的菜单。

import { ref } from 'vue'

/** 当前持有菜单的 key；null = 没有菜单 */
const activeMenuKey = ref<string | null>(null)

/** 抢占占用权：上一个菜单会立即关闭 */
export function openMenu(key: string): void {
  activeMenuKey.value = key
  document.body.classList.add('action-menu-open')
}

/** 只有持有者有权释放 */
export function closeMenu(key: string): void {
  if (activeMenuKey.value !== key) return
  activeMenuKey.value = null
  document.body.classList.remove('action-menu-open')
}

export { activeMenuKey }
