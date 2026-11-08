// activity —— 主卡活跃时间（列表按「最后一次来消息」倒序）

import type { Card } from '../../types/chat'

/**
 * 主卡的稳定标识
 *
 * **不能用卡片下标**：增删卡片或导入数据后，同一下标会换人，时间章就串到别人头上。
 * 单聊用干员名，群聊用排序后的成员集合（与加入顺序无关）。
 */
export function cardActiveKey(c: Card): string {
  const members = c.members ?? []
  if (members.length >= 2) return `g:${[...members].sort().join('|')}`
  return `s:${c.conversations[0]?.name ?? ''}`
}

/** 从没来过消息的卡（t=0）排在后面，并保持它们在卡片数组里的原有先后 */
export function sortKeysByActivity(keys: string[], at: Record<string, number>): string[] {
  return keys
    .map((k, i) => ({ k, i, t: at[k] ?? 0 }))    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((x) => x.k)
}

/** 校验落盘的活跃时间表：只收普通对象 + 有限数字，导入包里的脏数据不该污染排序 */
export function parseActivity(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const map: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) map[k] = v
  }
  return map
}

/**
 * 把一份顺序换算成活跃时间：排在前面的时间更大
 *
 * 这样只依赖既有排序机制，不必新增「显式序号」字段，也不会被之后的消息活动
 * 侦测覆盖（新消息照样把该卡顶到最前）。未列出的现存卡保留原值但压到末尾。
 */
export function activityFromOrder(
  order: unknown,
  existing: Record<string, number>,
  liveKeys: Set<string>,
  now: number,
): Record<string, number> | null {
  if (!Array.isArray(order)) return null
  const map: Record<string, number> = {}
  const n = order.length
  order.forEach((k, i) => {
    if (typeof k !== 'string' || !k) return
    map[k] = now - i
  })
  for (const [k, v] of Object.entries(existing)) {
    if (liveKeys.has(k) && !(k in map)) map[k] = Math.min(v, now - n - 1)
  }
  return map
}

/**
 * 子对话的活跃键
 *
 * 子对话没有稳定 id（同一张卡下的多段对话常常同名），只能用「卡片身份 + 卡内下标」。
 * 顺序只影响渲染，不动 conversations 数组，所以下标不会因为排序而漂移。
 */
export function subActiveKey(cardKey: string, subIndexInCard: number): string {
  return `${cardKey}#${subIndexInCard}`
}

/**
 * 卡内子卡的渲染顺序：最近来过消息的排最前
 *
 * @param start 该卡第一段子对话的全局下标
 * @param count 该卡子对话数量
 * @returns 按活跃时间倒序的全局下标数组；没有记录的按原顺序（sort 稳定）
 */
export function sortSubIndices(
  start: number,
  count: number,
  cardKey: string,
  at: Record<string, number>,
): number[] {
  const list: number[] = []
  for (let k = 0; k < count; k++) list.push(start + k)
  const stamp = (idx: number): number => at[subActiveKey(cardKey, idx - start)] ?? 0
  return list.sort((a, b) => stamp(b) - stamp(a))
}
