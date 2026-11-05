// =============================================================================
// 公告已读状态(useAnnouncementRead)
// -----------------------------------------------------------------------------
// 语义(与站内公告一致的"未读提醒"):
//   · 一条公告**从没被点开过** → 列表里挂 NEW 角标
//   · 只要还有任意一条未读 → 「游戏公告」页签右上角挂橙色菱形
//   · 点开过的那一条立刻变已读,角标消失;全部点过之后菱形也消失
//
// 存储:localStorage 单独一个键(不是设置项,不进设置快照/导出包)。
// 键里存的是**已读 id 列表**:之后新增公告时它的 id 不在表里,天然就是未读,
// 不需要额外维护版本号或时间戳。
//
// 状态用模块级 ref,页面开关多次也共用同一份(不必反复读盘)。
// =============================================================================

import { ref } from 'vue'

/** localStorage 键:已读公告 id 列表(JSON 数组) */
const READ_KEY = 'endfield-baker-announcement-read'

/** 读出已读集合;存储不可用 / 内容损坏时退回空集(全部当未读) */
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

/** 已读 id 集合(模块级单例,全应用共享) */
const readIds = ref<Set<string>>(loadReadIds())

/**
 * 公告未读状态
 *
 * 返回的 `isRead` / `markRead` 是稳定函数,可以直接在模板里调用;
 * `unreadCount` 需要传入当前公告 id 列表(组件自己知道数据来源)。
 */
export function useAnnouncementRead() {
  /** 某条公告是否已读 */
  function isRead(id: string): boolean {
    return readIds.value.has(id)
  }

  /** 标记为已读(幂等;写入失败不影响本次会话内的状态) */
  function markRead(id: string): void {
    if (readIds.value.has(id)) return
    const next = new Set(readIds.value)
    next.add(id)
    readIds.value = next
    try {
      localStorage.setItem(READ_KEY, JSON.stringify([...next]))
    } catch {
      // 存储不可用:仅本次会话内记得已读
    }
  }

  /** 给定 id 列表里还有几条未读 */
  function countUnread(ids: readonly string[]): number {
    return ids.reduce((n, id) => (readIds.value.has(id) ? n : n + 1), 0)
  }

  /** 是否还有未读(页签橙点用) */
  function hasUnreadOf(ids: readonly string[]): boolean {
    return countUnread(ids) > 0
  }

  return { isRead, markRead, countUnread, hasUnreadOf }
}
