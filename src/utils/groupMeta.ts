// =============================================================================
// 群聊卡片级元数据(groupMeta)
// -----------------------------------------------------------------------------
// 背景:群聊的「成员 / 我的身份 / 发言模式 / 话题」是**卡片级**字段
// (Card.members 等,见 types/chat),而对话内容只存在子会话里。
// 早期导入链路只搬运 conversations,于是"导出的群聊再导入回来"就退化成单聊壳:
// 群聊列表空、成员丢失、群名被当成角色名去查人设。本模块把这件事收敛到一处:
//
//   - extractCardGroupMeta: 卡片 → 可写进 project.json / JSON 的群聊元数据
//   - readCardGroupMeta:    任意来源对象 → 元数据(宽容读取旧字段名 / 嵌套写法)
//   - inferCardGroupMeta:   完全没有元数据的旧数据 → 从对话内容反推群聊身份
//   - resolveCardGroupMeta: 显式字段优先,缺失时用推断补齐(导入 / 恢复共用)
//   - repairCardGroups:     就地补齐卡片树里"退化成单聊壳"的群聊卡
//
// ⚠️ 三条铁律(数据安全):
//   1. 显式字段永远优先,推断只用来**补空**,绝不覆盖已有的 members
//   2. 推断必须"证据充分"才敢认定群聊,宁可认不出也不要把单聊认成群聊
//   3. 推断失败不丢数据:返回 null,卡片按原样保留(调用方不得因此丢弃卡片)
//
// 唯一例外:历史遗留的演示群空壳(见 LEGACY_DEMO_GROUP_TITLES)刻意不认回来 ——
// 它是待清理的假数据,认回来会让 App 的清理逻辑失效。
//
// 兼容目标:老版本导出的 JSON / ZIP 里,群聊字段可能整体缺失(旧净化丢字段)
// 或换了名字(isGroup / groupMembers / 嵌套 group 对象)。前者靠推断复原,
// 后者靠别名读取复原 —— 两种老包都必须能被识别成群聊。
// =============================================================================

import { CHARACTERS } from '../constants/character'
import type { Card, Conversation, GroupMyRole, GroupSpeakMode } from '../types/chat'

/**
 * 我方固定身份名
 *
 * 与 stores/chat.ts 的 MINE_NAME 一致。刻意在这里独立定义:
 * groupMeta 被 store 与导入导出工具共同引用,反向 import store 会形成循环依赖。
 */
const MINE_NAME = '管理员'

/** 群聊判定门槛:成员数 ≥2 才算群聊(与 store 的 GROUP_MIN_MEMBERS 一致) */
const GROUP_MIN_MEMBERS = 2

/** 合法发言模式(与 types/chat 的 GroupSpeakMode 一致) */
const SPEAK_MODES: GroupSpeakMode[] = ['round', 'smart', 'assign']

/**
 * 群聊卡片级元数据
 *
 * 刻意**不含 groupSessionId**:后端会话有 300s 空闲回收,跨导入 / 跨重启
 * 的 id 必然失效,前端会在下一次请求时自动重建(见 store 的群聊调度)。
 */
export interface CardGroupMeta {
  members: string[]
  myRole?: GroupMyRole
  speakMode?: GroupSpeakMode
  assignTarget?: string
  groupRunning?: boolean
  groupTopic?: string
}

/** 元数据里除 members 之外的标量字段 */
type GroupScalars = Omit<CardGroupMeta, 'members'>

// ---- 旧版字段名兼容 ---------------------------------------------------------

/** 成员名单可能出现的字段名(新旧写法) */
const MEMBER_KEYS = ['members', 'groupMembers', 'group_members', 'memberNames', 'memberList']

/** 群聊信息可能被收在哪个子对象里 */
const NESTED_KEYS = ['group', 'groupInfo', 'groupMeta', 'groupConfig']

/** 安全取对象 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * 展平"群聊字段所在的作用域"
 *
 * 旧数据可能把群聊信息嵌在子对象里({ group: { members, myRole } }),
 * 也可能直接平铺在卡片上。这里返回一个合并视图(子对象覆盖同名平铺字段)。
 */
function groupScope(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw)
  if (!rec) return null
  for (const key of NESTED_KEYS) {
    const nested = asRecord(rec[key])
    if (nested) return { ...rec, ...nested }
  }
  return rec
}

/** 读取成员名单(去重、去空、trim);找不到返回空数组 */
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

/** 读取群聊标量字段(逐个校验类型,非法值一律忽略 —— 不把脏数据带进来) */
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

/**
 * 收尾校验:成员不足 2 人一律作废;assignTarget 必须真在群里
 *
 * (「指定模式」点名一个不在群里的角色,后端会拿到无效 target。)
 */
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
    // 指定模式下 target 丢了 → 回退第一位成员(与 store 的默认行为一致)
    meta.assignTarget = list[0]
  }
  return meta
}

// ---- 显式读取 ---------------------------------------------------------------

/**
 * 从任意对象读取群聊元数据(只认显式字段,不做推断)
 *
 * 成员不足 2 人时返回 null —— 此时交给 inferCardGroupMeta 去旧数据里找证据。
 */
export function readCardGroupMeta(raw: unknown): CardGroupMeta | null {
  const scope = groupScope(raw)
  if (!scope) return null
  const members = pickMembers(scope)
  if (members.length < GROUP_MIN_MEMBERS) return null
  return finalizeMeta(members, readGroupScalars(scope))
}

/**
 * 提取卡片的群聊元数据(导出用)
 *
 * 非群聊卡返回 null;导出时写成 project.json 的 cards[] 一项,
 * 导入时按**下标**对回卡片 —— 因此数组里必须为每张卡留位置(单聊卡写 null)。
 */
export function extractCardGroupMeta(card: Card | null | undefined): CardGroupMeta | null {
  if (!card) return null
  const members = pickMembers(asRecord(card))
  if (members.length < GROUP_MIN_MEMBERS) return null
  return finalizeMeta(members, readGroupScalars(asRecord(card)))
}

// ---- 旧数据推断 -------------------------------------------------------------

/**
 * 解析群聊默认标题,还原被点到的成员名
 *
 *   「A、B和C的群聊」        → [A, B, C]
 *   「A、B和C等5人的群聊」   → [A, B, C](折叠掉的成员无法从标题还原)
 *
 * 要求每个名字都是内置干员名:否则「我和朋友的群聊」这类自定义群名会被误判成群。
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
 * 从对话内容反推群聊身份(旧数据复原用)
 *
 * 三条证据,任一条成立即认为"这确实是个群":
 *   1. 对方侧出现过 ≥2 个不同的说话人 —— 单聊里 AI 的署名恒为同一个角色名,
 *      只有群聊才会在一段会话里换人说话
 *   2. 出现过「新话题」提示行(topic:true)—— 该行只有群聊旁观模式才会写入
 *   3. 会话名形如「A、B和C的群聊」且名字全是内置干员
 *
 * 成员名单按可信度排序合并:标题里点到的 > 真正说过话的 > 我扮演过的角色。
 * 证据不足(<2 人)返回 null,调用方必须原样保留卡片。
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
      // 「新话题」提示行:side 只是排版用的 other,不代表有人说话
      if (msg.topic) {
        hasTopic = true
        const text = (msg.text ?? '').trim()
        if (text) lastTopic = text
        continue
      }
      const name = (msg.speakerName ?? '').trim()
      if (!name) continue
      if (msg.side === 'other') speakers.add(name)
      // 我方署名只可能是「管理员」(单聊固定)或"被扮演的角色"(仅群聊能设置)
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
    // 能给出话题 = 旁观模式(只有旁观模式的底部按钮是「给出话题」)
    scalars.myRole = 'observer'
    if (lastTopic) scalars.groupTopic = lastTopic
  }
  // groupRunning 刻意不推断:旧数据无从判断"当时是否正在推进",
  // 缺省(undefined = 从未开始)最安全 —— 不会一导入就自动聊起来。
  return finalizeMeta(members, scalars)
}

/**
 * 会话是否为"历史遗留演示群空壳"(按首个子对话名精确匹配)
 *
 * 这类卡片**刻意不认回来**:App.vue 的清理逻辑正是靠"没有 members"这个特征
 * 识别并删除它,若在推断阶段给它补上 members,清理就再也命中不了,
 * 三个废弃的演示群会一直留在玩家的群聊列表里。
 */
function isLegacyDemoShellConversations(conversations: Conversation[]): boolean {
  const name = conversations?.[0]?.name ?? ''
  return LEGACY_DEMO_GROUP_TITLES.includes(name)
}

/**
 * 解析卡片的群聊元数据:显式字段优先,缺失时用对话内容推断补齐
 *
 * 这是 JSON 导入 / ZIP 导入 / 本地恢复三条链路的公共入口。
 */
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

  // 玩家自己建的同名群一定带 members(上面已经返回);走到这里的同名卡
  // 只可能是历史遗留的演示群空壳 → 不推断,交给清理逻辑删除。
  if (isLegacyDemoShellConversations(conversations)) return null

  const inferred = inferCardGroupMeta(conversations)
  if (!inferred) return null
  // 推断出的成员 + 两种来源的标量(显式覆盖推断:玩家真的设置过就以它为准)
  return finalizeMeta(inferred.members, { ...scalarsOf(inferred), ...explicitScalars })
}

/** 元数据 → 标量字段(丢弃 members) */
function scalarsOf(meta: CardGroupMeta): GroupScalars {
  const out: GroupScalars = {}
  if (meta.myRole !== undefined) out.myRole = meta.myRole
  if (meta.speakMode !== undefined) out.speakMode = meta.speakMode
  if (meta.assignTarget !== undefined) out.assignTarget = meta.assignTarget
  if (meta.groupRunning !== undefined) out.groupRunning = meta.groupRunning
  if (meta.groupTopic !== undefined) out.groupTopic = meta.groupTopic
  return out
}

/** 元数据 → 可直接 Object.assign 到卡片上的字段集合 */
export function toCardGroupFields(meta: CardGroupMeta): Partial<Card> & { members: string[] } {
  const fields: Partial<Card> & { members: string[] } = { members: meta.members.slice() }
  Object.assign(fields, scalarsOf(meta))
  return fields
}

// ---- 历史遗留演示群 ---------------------------------------------------------

/**
 * 早期为确认 UI 播种过的三个演示群(现已不再播种)
 *
 * 导出成常量供两处共用:App.vue 的清理逻辑,以及下面的"空壳"判定 ——
 * 否则本次新增的群聊识别会把演示群空壳一起"救活",清理逻辑就失效了。
 */
export const LEGACY_DEMO_GROUP_TITLES = [
  '佩丽卡、陈千语和卡缪的群聊',
  '伊冯和别礼的群聊',
  '佩丽卡、陈千语和卡缪等5人的群聊',
]

/**
 * 是否为"历史遗留演示群空壳"
 *
 * 只认「没有 members + 首个子对话名恰好等于演示标题」的卡:
 * 玩家自己建的群都带 members,名字也不会与演示标题重合,不会被误判。
 */
export function isLegacyDemoGroupShell(card: Card | null | undefined): boolean {
  if (!card) return false
  if (pickMembers(asRecord(card)).length >= GROUP_MIN_MEMBERS) return false
  const name = card.conversations?.[0]?.name ?? ''
  return LEGACY_DEMO_GROUP_TITLES.includes(name)
}

/**
 * 就地补齐卡片树里"退化成单聊壳"的群聊卡
 *
 * 已有 members 的卡原样返回(对象引用不变,不触发无意义的重渲染);
 * 演示群空壳交给 App 的清理逻辑处理,这里不救。
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
