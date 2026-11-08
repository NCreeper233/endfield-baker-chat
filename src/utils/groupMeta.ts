// groupMeta —— 群聊的卡片级元数据（members / myRole / speakMode / 话题）
// 这些字段不在 conversations 里，早期导入只搬对话，导致导出的群聊再导入变成单聊壳。
// ⚠️ 显式字段永远优先，推断只补空；证据不足宁可认不出；推断失败返回 null，调用方不得丢卡。

import { CHARACTERS } from '../constants/character'
import type { Card, Conversation, GroupMyRole, GroupSpeakMode } from '../types/chat'
// 群聊门槛与我方固定身份名以领域层为准（domain 不引用 utils，不会成环）
import { MINE_NAME } from '../domain/chat/identity'
import { GROUP_MIN_MEMBERS } from '../domain/chat/group'

const SPEAK_MODES: GroupSpeakMode[] = ['round', 'smart', 'assign']

/**
 * 刻意不含 groupSessionId：后端会话有 300s 空闲回收，跨导入/重启的 id 必然失效，
 * 前端会在下一次请求时自动重建。
 */
export interface CardGroupMeta {
  members: string[]
  myRole?: GroupMyRole
  speakMode?: GroupSpeakMode
  assignTarget?: string
  groupRunning?: boolean
  groupTopic?: string
}

type GroupScalars = Omit<CardGroupMeta, 'members'>

// 旧版字段名兼容

/** 成员名单可能出现的字段名（新旧写法） */
const MEMBER_KEYS = ['members', 'groupMembers', 'group_members', 'memberNames', 'memberList']

/** 群聊信息可能被收在哪个子对象里 */
const NESTED_KEYS = ['group', 'groupInfo', 'groupMeta', 'groupConfig']

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 旧数据可能把群聊信息嵌在子对象里，也可能平铺在卡片上；这里返回合并视图（子对象覆盖同名平铺字段） */
function groupScope(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw)
  if (!rec) return null
  for (const key of NESTED_KEYS) {
    const nested = asRecord(rec[key])
    if (nested) return { ...rec, ...nested }
  }
  return rec
}

function pickMembers(scope: Record<string, unknown> | null): string[] {
  if (!scope) return []
  for (const key of MEMBER_KEYS) {
    const raw = scope[key]
    if (!Array.isArray(raw)) continue
    const out: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const name = item.trim()
      if (name && out.indexOf(name) === -1) out.push(name)
    }
    if (out.length > 0) return out
  }
  return []
}

/** 逐个校验类型，非法值一律忽略 */
function readGroupScalars(scope: Record<string, unknown> | null): GroupScalars {
  const out: GroupScalars = {}
  if (!scope) return out

  const myRole = scope.myRole ?? scope.role
  if (typeof myRole === 'string' && myRole.trim()) out.myRole = myRole.trim()

  const mode = scope.speakMode ?? scope.mode
  if (typeof mode === 'string' && (SPEAK_MODES as string[]).includes(mode)) {
    out.speakMode = mode as GroupSpeakMode
  }

  const target = scope.assignTarget ?? scope.target
  if (typeof target === 'string' && target.trim()) out.assignTarget = target.trim()

  const running = scope.groupRunning ?? scope.running
  if (typeof running === 'boolean') out.groupRunning = running

  const topic = scope.groupTopic ?? scope.topic
  if (typeof topic === 'string' && topic.trim()) out.groupTopic = topic.trim()

  return out
}

/** 成员不足 2 人一律作废；assignTarget 必须真在群里（点名不在群里的角色，后端会拿到无效 target） */
function finalizeMeta(members: string[], scalars: GroupScalars): CardGroupMeta | null {
  const list: string[] = []
  for (const m of members) {
    const name = (m ?? '').trim()
    if (name && list.indexOf(name) === -1) list.push(name)
  }
  if (list.length < GROUP_MIN_MEMBERS) return null

  const meta: CardGroupMeta = { members: list }
  if (scalars.myRole !== undefined) meta.myRole = scalars.myRole
  if (scalars.speakMode !== undefined) meta.speakMode = scalars.speakMode
  if (scalars.groupRunning !== undefined) meta.groupRunning = scalars.groupRunning
  if (scalars.groupTopic !== undefined) meta.groupTopic = scalars.groupTopic
  const target = scalars.assignTarget
  if (target !== undefined && list.indexOf(target) !== -1) {
    meta.assignTarget = target
  } else if (scalars.speakMode === 'assign') {
    // 指定模式下 target 丢了 → 回退第一位成员（与 store 默认行为一致）
    meta.assignTarget = list[0]
  }
  return meta
}

// 显式读取

/** 只认显式字段，不做推断；成员不足 2 人返回 null，交给 inferCardGroupMeta */
export function readCardGroupMeta(raw: unknown): CardGroupMeta | null {
  const scope = groupScope(raw)
  if (!scope) return null
  const members = pickMembers(scope)
  if (members.length < GROUP_MIN_MEMBERS) return null
  return finalizeMeta(members, readGroupScalars(scope))
}

/**
 * 导出用：写成 project.json 的 cards[] 一项，导入时按**下标**对回卡片，
 * 因此数组里必须为每张卡留位置（单聊卡写 null）。
 */
export function extractCardGroupMeta(card: Card | null | undefined): CardGroupMeta | null {
  if (!card) return null
  const members = pickMembers(asRecord(card))
  if (members.length < GROUP_MIN_MEMBERS) return null
  return finalizeMeta(members, readGroupScalars(asRecord(card)))
}

// 旧数据推断

/**
 * 「A、B和C的群聊」→ [A, B, C]；带「等N人」的折叠标题只能还原点到的成员。
 * 要求每个名字都是内置干员名，否则「我和朋友的群聊」这类自定义群名会被误判。
 */
function parseGroupTitle(name: string, known: Set<string>): string[] {
  const raw = (name ?? '').trim()
  const matched = raw.match(/^(.*)的群聊$/)
  if (!matched) return []
  let head = matched[1]
  const folded = head.match(/^(.*)等(\d+)人$/)
  if (folded) head = folded[1]
  const parts = head
    .split(/[、和]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length < GROUP_MIN_MEMBERS) return []
  if (!parts.every((p) => known.has(p))) return []
  return parts
}

/**
 * 三条证据任一成立即认为是群：对方侧出现过 ≥2 个说话人；出现过「新话题」提示行；
 * 会话名形如「A、B和C的群聊」且名字全是内置干员。
 * 成员按可信度合并：标题点到的 > 真正说过话的 > 我扮演过的。
 */
export function inferCardGroupMeta(conversations: Conversation[]): CardGroupMeta | null {
  if (!Array.isArray(conversations)) return null
  const known = new Set(CHARACTERS.map((c) => c.name))

  const titleNames: string[] = []
  const speakers = new Set<string>()
  const played = new Set<string>()
  let hasTopic = false
  let lastTopic = ''

  for (const conv of conversations) {
    if (!conv) continue
    if (titleNames.length === 0) {
      const parsed = parseGroupTitle(conv.name ?? '', known)
      if (parsed.length > 0) titleNames.push(...parsed)
    }
    for (const msg of conv.messages ?? []) {
      if (!msg) continue
      // 「新话题」提示行：side 只是排版用的 other，不代表有人说话
      if (msg.topic) {
        hasTopic = true
        const text = (msg.text ?? '').trim()
        if (text) lastTopic = text
        continue
      }
      const name = (msg.speakerName ?? '').trim()
      if (!name) continue
      if (msg.side === 'other') speakers.add(name)
      // 我方署名只可能是「管理员」（单聊固定）或被扮演的角色（仅群聊可设）
      else if (name !== MINE_NAME) played.add(name)
    }
  }

  if (speakers.size < GROUP_MIN_MEMBERS && !hasTopic && titleNames.length < GROUP_MIN_MEMBERS) {
    return null
  }

  const members: string[] = []
  const push = (name: string) => {
    if (name && members.indexOf(name) === -1) members.push(name)
  }
  for (const n of titleNames) push(n)
  for (const n of speakers) push(n)
  for (const n of played) if (known.has(n)) push(n)

  if (members.length < GROUP_MIN_MEMBERS) return null

  const scalars: GroupScalars = {}
  if (hasTopic) {
    // 能给出话题 = 旁观模式（只有旁观模式的底部按钮是「给出话题」）
    scalars.myRole = 'observer'
    if (lastTopic) scalars.groupTopic = lastTopic
  }
  // groupRunning 刻意不推断：缺省最安全，不会一导入就自动聊起来
  return finalizeMeta(members, scalars)
}

/**
 * 这类卡片刻意不认回来：App.vue 的清理逻辑正靠「没有 members」识别并删除它，
 * 补上 members 就再也命中不了，废弃的演示群会一直留在列表里。
 */
function isLegacyDemoShellConversations(conversations: Conversation[]): boolean {
  const name = conversations?.[0]?.name ?? ''
  return LEGACY_DEMO_GROUP_TITLES.includes(name)
}

/** JSON 导入 / ZIP 导入 / 本地恢复三条链路的公共入口 */
export function resolveCardGroupMeta(
  raw: unknown,
  conversations: Conversation[],
): CardGroupMeta | null {
  const scope = groupScope(raw)
  const explicitMembers = pickMembers(scope)
  const explicitScalars = readGroupScalars(scope)

  if (explicitMembers.length >= GROUP_MIN_MEMBERS) {
    return finalizeMeta(explicitMembers, explicitScalars)
  }

  // 走到这里的同名卡只可能是演示群空壳 → 不推断，交给清理逻辑删除
  if (isLegacyDemoShellConversations(conversations)) return null

  const inferred = inferCardGroupMeta(conversations)
  if (!inferred) return null
  // 显式标量覆盖推断结果：玩家真的设置过就以它为准
  return finalizeMeta(inferred.members, { ...scalarsOf(inferred), ...explicitScalars })
}

/** 丢弃 members */
function scalarsOf(meta: CardGroupMeta): GroupScalars {
  const out: GroupScalars = {}
  if (meta.myRole !== undefined) out.myRole = meta.myRole
  if (meta.speakMode !== undefined) out.speakMode = meta.speakMode
  if (meta.assignTarget !== undefined) out.assignTarget = meta.assignTarget
  if (meta.groupRunning !== undefined) out.groupRunning = meta.groupRunning
  if (meta.groupTopic !== undefined) out.groupTopic = meta.groupTopic
  return out
}

/** 可直接 Object.assign 到卡片上的字段集合 */
export function toCardGroupFields(meta: CardGroupMeta): Partial<Card> & { members: string[] } {
  const fields: Partial<Card> & { members: string[] } = { members: meta.members.slice() }
  Object.assign(fields, scalarsOf(meta))
  return fields
}

// 历史遗留演示群

/**
 * 早期为确认 UI 播种过的演示群（现已不再播种）。App 的清理逻辑与「空壳」判定
 * 共用这一份，否则新增的群聊识别会把空壳一起救活，清理就失效了。
 */
export const LEGACY_DEMO_GROUP_TITLES = [
  '佩丽卡、陈千语和卡缪的群聊',
  '伊冯和别礼的群聊',
  '佩丽卡、陈千语和卡缪等5人的群聊',
]

/** 只认「没有 members + 首个子对话名恰好等于演示标题」，玩家自建的群不会被误判 */
export function isLegacyDemoGroupShell(card: Card | null | undefined): boolean {
  if (!card) return false
  if (pickMembers(asRecord(card)).length >= GROUP_MIN_MEMBERS) return false
  const name = card.conversations?.[0]?.name ?? ''
  return LEGACY_DEMO_GROUP_TITLES.includes(name)
}

/**
 * 已有 members 的卡原样返回（对象引用不变，不触发无意义重渲染）；
 * 演示群空壳交给 App 的清理逻辑，这里不救。
 */
export function repairCardGroups(cards: Card[]): Card[] {
  if (!Array.isArray(cards)) return cards
  let changed = false
  const next = cards.map((card) => {
    if (!card) return card
    if (pickMembers(asRecord(card)).length >= GROUP_MIN_MEMBERS) return card
    if (isLegacyDemoGroupShell(card)) return card
    const meta = resolveCardGroupMeta(card, card.conversations ?? [])
    if (!meta) return card
    changed = true
    return { ...card, ...toCardGroupFields(meta) }
  })
  return changed ? next : cards
}
