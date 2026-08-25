// =============================================================================
// 旧版 JSON 数据集兼容层(jsonCompat)
// -----------------------------------------------------------------------------
// 职责:
//   - exportToJson: 当前工程(卡片+设置+自定义提示词) → 单文件 JSON 字符串
//   - importFromJson: 解析 JSON 文件,识别"新版单文件 / 旧版 data.json 转储 /
//     裸卡片数组"等结构,统一转换并自动补全缺失字段 → ProjectPayload
//   - normalizeCards: 任意来源的卡片数据归一化为当前 Card[] 结构
//   - downloadProjectJson: 按平台(浏览器/EXE/APK)导出 JSON 文件
//
// 设计原则:
//   - JSON 单文件:图片以 dataURL 内联(与 ZIP 的独立图片文件相对)
//   - 兼容层只做"宽容读取 + 补全",不丢弃任何可识别字段
//   - 补全默认值与新建数据一致:
//       · 卡片缺对话 → 丢弃该卡片(空卡无意义;内置角色由 mergeBuiltinCards 补齐)
//       · 对话缺 name → 用"干员N-会话M"兜底;缺 contextHistory → 保持 undefined
//         (getChatHistory 自动回退从 messages 派生,等价于新对话初始状态)
//       · 消息缺 id → 顺序补号;缺 side → 按 role/user=我方,其余=对方;
//         text 缺 → 兼容 content 字段;带图消息缺 imageW/H → CHAT_IMAGE 默认
//   - 结构识别优先级:顶层 cards > characterCards > characters > 裸数组
//   - 顶部聊天条:兼容 stripVariantIndex / stripVariant(数字或数字字符串)
//   - 性别:兼容 myGender / gender('male'|'female'|'m'|'f'|0|1) / isFemale
//   - 设置:读取新版 settings 对象;缺失时不重置(applySettingsSnapshot 保留现值)
// =============================================================================

import type { Card, ChatMessage, Conversation } from '../types/chat'
import { CHAT_IMAGE } from '../constants/design'
import { PROJECT_VERSION, downloadBlob, type ProjectPayload } from './zipExport'

/** JSON 导出文件扩展名 */
export const JSON_EXPORT_EXT = '.json'

/** JSON 导入可接受的文件选择过滤(与 ZIP 扩展名并列) */
export const IMPORT_FILE_ACCEPT = '.zip,.json,application/json'

// ---- 消息归一化 -------------------------------------------------------------

/**
 * 单条消息归一化 + 补全。
 *
 * 兼容旧字段:role(user→mine/assistant→other)、content(代替 text)。
 * 图片缺宽高时补 CHAT_IMAGE 默认;id 由调用方在整段补号。
 */
function normalizeMessage(raw: unknown): ChatMessage {
  if (!raw || typeof raw !== 'object') {
    return { id: 0, side: 'other', text: '' }
  }
  const m = raw as Record<string, unknown>

  // side 优先级:role 映射 > 原始 side
  let side: 'other' | 'mine' = 'other'
  if (m.role === 'user') side = 'mine'
  else if (m.role === 'assistant') side = 'other'
  else if (m.side === 'mine') side = 'mine'
  else if (m.side === 'other') side = 'other'

  const rawText = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : ''
  // 与 store 发送逻辑一致:trim 后空白视为空消息
  const text = rawText.trim()

  const out: ChatMessage = { id: 0, side, text }

  const image = typeof m.image === 'string' && m.image ? m.image : undefined
  if (image) {
    out.image = image
    out.imageW = typeof m.imageW === 'number' && m.imageW > 0 ? m.imageW : CHAT_IMAGE.w
    out.imageH = typeof m.imageH === 'number' && m.imageH > 0 ? m.imageH : CHAT_IMAGE.h
  }
  if (typeof m.speakerName === 'string') out.speakerName = m.speakerName
  if (typeof m.speakerAvatar === 'string') out.speakerAvatar = m.speakerAvatar
  if (typeof m.mood === 'string') out.mood = m.mood
  return out
}

/** 上下文历史归一化(兼容 role/content);无有效条目返回 undefined(等价新对话初始态) */
function normalizeContextHistory(
  raw: unknown,
): Array<{ side: 'other' | 'mine'; text: string; image?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries: Array<{ side: 'other' | 'mine'; text: string; image?: string }> = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const en = e as Record<string, unknown>
    let side: 'other' | 'mine' = 'other'
    if (en.role === 'user') side = 'mine'
    else if (en.side === 'mine') side = 'mine'
    const text = typeof en.text === 'string' ? en.text : typeof en.content === 'string' ? en.content : ''
    if (!text) continue
    const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side, text }
    if (typeof en.image === 'string' && en.image) entry.image = en.image
    entries.push(entry)
  }
  return entries.length > 0 ? entries : undefined
}

// ---- 对话/卡片归一化 ---------------------------------------------------------

/**
 * 对话归一化 + 补全。
 *
 * 兼容旧字段:items(代替 messages)。
 * 消息 id 在整段顺序补号(旧数据 id 缺失/重复时保证 v-for key 唯一)。
 * 空消息(无文本无图片)丢弃。
 */
function normalizeConversation(raw: unknown, fallbackName: string): Conversation | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const name = typeof c.name === 'string' && c.name.trim() ? c.name : fallbackName

  const rawMessages = Array.isArray(c.messages) ? c.messages : Array.isArray(c.items) ? c.items : []
  const messages = rawMessages
    .map((m) => normalizeMessage(m))
    .filter((m) => m.text.length > 0 || !!m.image)
  messages.forEach((m, i) => {
    m.id = i + 1
  })

  const out: Conversation = { name, messages }
  const ctx = normalizeContextHistory(c.contextHistory)
  if (ctx !== undefined) out.contextHistory = ctx
  return out
}

/**
 * 卡片归一化 + 补全。
 *
 * 兼容旧字段:subs / children(代替 conversations)。
 * 无任何有效对话的卡片丢弃(内置角色会由 store 的 mergeBuiltinCards 补齐)。
 */
function normalizeCard(raw: unknown, cardIndex: number): Card | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>

  const rawConvs = Array.isArray(c.conversations)
    ? c.conversations
    : Array.isArray(c.subs)
      ? c.subs
      : Array.isArray(c.children)
        ? c.children
        : []

  const conversations = rawConvs
    .map((cv, i) => normalizeConversation(cv, `干员${cardIndex + 1}-会话${i + 1}`))
    .filter((cv): cv is Conversation => cv !== null)

  if (conversations.length === 0) return null
  return { conversations }
}

/** 卡片树归一化:任意来源(旧/新/裸数组)统一为当前 Card[] */
export function normalizeCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((c, i) => normalizeCard(c, i))
    .filter((c): c is Card => c !== null)
}

// ---- JSON 导入 ---------------------------------------------------------------

/**
 * 解析 JSON 文本为当前工程结构(自动识别旧版格式并补全)。
 *
 * 支持:
 *   1. 新版单文件导出(本模块 exportToJson 输出,含 version/cards/settings/promptOverrides)
 *   2. 旧版 data.json / IndexedDB 转储(顶层 cards/myGender/stripVariant/settings)
 *   3. 裸卡片数组(顶层即 Card[])
 * 识别失败 / 无有效卡片时抛 Error(调用方负责提示,不触碰现有数据)。
 */
export function importFromJson(text: string): ProjectPayload {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON 解析失败:文件不是有效的 JSON')
  }

  // 裸卡片数组(最宽松的旧格式)
  if (Array.isArray(data)) {
    const cards = normalizeCards(data)
    if (cards.length === 0) throw new Error('未找到有效卡片数据')
    return { version: PROJECT_VERSION, cards, myGender: 'male', stripVariantIndex: 0 }
  }

  if (!data || typeof data !== 'object') {
    throw new Error('无法识别的数据格式:顶层既不是对象也不是数组')
  }
  const root = data as Record<string, unknown>

  // 卡片来源:cards > characterCards > characters
  const rawCards = Array.isArray(root.cards)
    ? root.cards
    : Array.isArray(root.characterCards)
      ? root.characterCards
      : Array.isArray(root.characters)
        ? root.characters
        : null
  if (!rawCards) throw new Error('未找到卡片数据(cards/characterCards/characters)')

  const cards = normalizeCards(rawCards)
  if (cards.length === 0) throw new Error('未找到有效卡片数据')

  // 性别:myGender / gender('male'|'female'|'m'|'f'|0|1) / isFemale 布尔
  let myGender: 'male' | 'female' = 'male'
  const genderRaw = root.myGender ?? root.gender
  if (genderRaw === 'female' || genderRaw === 'f' || genderRaw === 1 || genderRaw === true) {
    myGender = 'female'
  } else if (genderRaw === 'male' || genderRaw === 'm' || genderRaw === 0 || genderRaw === false) {
    myGender = 'male'
  }
  if (typeof root.isFemale === 'boolean') myGender = root.isFemale ? 'female' : 'male'

  // 顶部聊天条下标:stripVariantIndex / stripVariant(数字或数字字符串,归一化到 0-2)
  const stripRaw = root.stripVariantIndex ?? root.stripVariant
  let stripVariantIndex = 0
  if (typeof stripRaw === 'number') {
    stripVariantIndex = ((Math.trunc(stripRaw) % 3) + 3) % 3
  } else if (typeof stripRaw === 'string') {
    const n = parseInt(stripRaw, 10)
    if (!Number.isNaN(n)) stripVariantIndex = ((n % 3) + 3) % 3
  }

  // 版本:旧数据可能缺失,不强制校验(仅记录)
  let version = PROJECT_VERSION
  if (typeof root.version === 'number' && root.version > 0) {
    version = Math.trunc(root.version)
  } else if (typeof root.version === 'string') {
    const n = parseInt(root.version, 10)
    if (!Number.isNaN(n) && n > 0) version = n
  }

  // 设置快照(新版字段;缺失时返回 undefined → applySettingsSnapshot 保留现值)
  let settings: Record<string, unknown> | undefined
  if (root.settings && typeof root.settings === 'object') {
    settings = root.settings as Record<string, unknown>
  }

  // 自定义提示词覆盖:promptOverrides / prompts 对象
  let promptOverrides: Record<string, string> | undefined
  const ovRaw = root.promptOverrides ?? root.prompts
  if (ovRaw && typeof ovRaw === 'object' && !Array.isArray(ovRaw)) {
    const collected: Record<string, string> = {}
    for (const [k, v] of Object.entries(ovRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && v) collected[k] = v
    }
    if (Object.keys(collected).length > 0) promptOverrides = collected
  }

  return {
    version,
    cards,
    myGender,
    stripVariantIndex,
    promptOverrides,
    settings,
  }
}

// ---- JSON 导出 ---------------------------------------------------------------

/** 统计导出内容(与 ZIP 导出一致) */
function countStats(cards: Card[]) {
  let convCount = 0
  let msgCount = 0
  for (const card of cards) {
    convCount += card.conversations.length
    for (const conv of card.conversations) {
      msgCount += conv.messages.length
    }
  }
  return { cardCount: cards.length, convCount, msgCount }
}

/**
 * 序列化工程为单文件 JSON 字符串。
 *
 * 图片以 dataURL 内联(与 ZIP 的独立图片文件相对);
 * 仅导出有消息或有 AI 记忆的对话;设置快照与自定义提示词一并内嵌。
 */
export function exportToJson(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
): string {
  // 仅导出有内容(消息或 AI 记忆)的对话;两者皆空的对话与整卡跳过
  const exportableCards: Card[] = cards
    .map((card) => ({
      conversations: card.conversations.filter(
        (conv) => conv.messages.length > 0 || (conv.contextHistory?.length ?? 0) > 0,
      ),
    }))
    .filter((card) => card.conversations.length > 0)

  if (exportableCards.length === 0) {
    throw new Error('没有可导出的对话数据')
  }

  const hasOverrides = Object.keys(promptOverrides).length > 0

  const payload = {
    version: PROJECT_VERSION,
    myGender,
    stripVariantIndex,
    exportedAt: new Date().toISOString(),
    stats: countStats(exportableCards),
    settings: settingsSnapshot || undefined,
    promptOverrides: hasOverrides ? promptOverrides : undefined,
    cards: exportableCards,
  }
  return JSON.stringify(payload, null, 2)
}

/** JSON 导出文件名(BAKER-JSON-时间戳.json) */
export function jsonExportFileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `BAKER-JSON-${ts}${JSON_EXPORT_EXT}`
}

/**
 * 导出 JSON 工程文件(按平台:安装版弹系统保存框 / 浏览器直接下载)。
 * 复用 zipExport 的跨平台下载逻辑(EXE 系统另存为 / APK SAF / 浏览器 <a download>)。
 */
export async function downloadProjectJson(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
): Promise<void> {
  const json = exportToJson(cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  await downloadBlob(blob, jsonExportFileName())
}
