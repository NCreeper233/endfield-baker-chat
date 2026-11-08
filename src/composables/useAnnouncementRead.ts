// useAnnouncementRead —— 公告已读状态
// 一条从没点开过 → 列表挂 NEW 角标；还有任意未读 → 页签挂橙点。
// localStorage 里存**已读 id 列表**：新增公告的 id 不在表里就天然未读，
// 不必维护版本号或时间戳。键是独立的一个，不进设置快照与导出包。

import { ref } from 'vue'

const READ_KEY = 'endfield-baker-announcement-read'

/** 存储不可用或内容损坏时退回空集（全部当未读） */
function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

/** 模块级单例：页面开关多次共用，不必反复读盘 */
const readIds = ref<Set<string>>(loadReadIds())

export function useAnnouncementRead() {
  function isRead(id: string): boolean {
    return readIds.value.has(id)
  }

  /** 幂等；写入失败只影响下次启动 */
  function markRead(id: string): void {
    if (readIds.value.has(id)) return
    const next = new Set(readIds.value)
    next.add(id)
    readIds.value = next
    try {
      localStorage.setItem(READ_KEY, JSON.stringify([...next]))
    } catch {
      // 存储不可用：仅本次会话内记得已读
    }
  }

  function countUnread(ids: readonly string[]): number {
    return ids.reduce((n, id) => (readIds.value.has(id) ? n : n + 1), 0)
  }

  function hasUnreadOf(ids: readonly string[]): boolean {
    return countUnread(ids) > 0
  }

  return { isRead, markRead, countUnread, hasUnreadOf }
}
