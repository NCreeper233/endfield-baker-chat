// jsonCompat —— 单文件 JSON 导出与旧版数据兼容导入
// 只做「宽容读取 + 补全」，不丢弃任何可识别字段；结构识别优先级
// 顶层 cards > characterCards > characters > 裸数组。
// 图片以 dataURL 内联（ZIP 则用独立图片文件）。

import type { Card, ChatMessage, Conversation } from '../types/chat'
import { CHAT_IMAGE } from '../constants/design'
import { resolveCardGroupMeta, toCardGroupFields } from './groupMeta'
import {
  PROJECT_VERSION,
  applyImageBudget,
  assertExportSizeWithinLimit,
  downloadBlob,
  EXPORT_BUDGET_BYTES,
  estimateExportBytes,
  reencodeOversizedImages,
  timestamp,
  type ProjectPayload,
} from './zipExport'
import type { ExportOutcome } from './nativeExport'

export type { ExportOutcome }

/** JSON 导出文件扩展名 */
export const JSON_EXPORT_EXT = '.json'

/** JSON 导入可接受的文件选择过滤(与 ZIP 扩展名并列) */
export const IMPORT_FILE_ACCEPT = '.zip,.json,application/json'

// 消息归一化

/**
 * 单条消息归一化：兼容旧字段 role（user→mine / assistant→other）与 content（代替 text）；
 * 图片缺宽高时补 CHAT_IMAGE 默认值，id 由调用方统一补号。
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
  // speakerAvatar 不再导出(头像是应用内置资源,导入时根据角色名自动匹配)
  if (typeof m.mood === 'string') out.mood = m.mood
  // 群聊「新话题」提示行标记:漏掉它会把这行灰字还原成一条普通气泡
  if (m.topic) out.topic = true
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

// 对话 / 卡片归一化

/**
 * 兼容旧字段 items（代替 messages）；消息 id 顺序补号以保证 v-for key 唯一；空消息丢弃。
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
  // 会话累计输出 token:导出包里带着它(exportToJson 直接序列化卡片),
  // 但早期导入端没还原 —— 表现为"恢复备份后智能总结的累计量归零",
  // 该触发总结的时候不触发。这里补上读取(非法值忽略,保持"未设置"语义)。
  if (
    typeof c.sessionOutputTokens === 'number' &&
    Number.isFinite(c.sessionOutputTokens) &&
    c.sessionOutputTokens > 0
  ) {
    out.sessionOutputTokens = Math.trunc(c.sessionOutputTokens)
  }
  // AI 推荐回复缓存:导入时一并还原(旧包没有这个字段 → 保持 undefined)
  const sug = c.suggestions
  if (sug && typeof sug === 'object' && Array.isArray((sug as { items?: unknown }).items)) {
    const s = sug as { forMessageId?: unknown; items: unknown[]; at?: unknown }
    const items = s.items.filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (items.length > 0) {
      out.suggestions = {
        forMessageId: typeof s.forMessageId === 'number' ? s.forMessageId : 0,
        items,
        at: typeof s.at === 'number' ? s.at : 0,
      }
    }
  }
  return out
}

/**
 * 兼容旧字段 subs / children（代替 conversations）；无有效对话的卡片丢弃（内置角色由
 * store 的 mergeBuiltinCards 补齐）。群聊卡片级字段统一走 utils/groupMeta。
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
  const card: Card = { conversations }
  // 群聊卡片级字段(groupSessionId 刻意不恢复:后端会话早已回收)
  const meta = resolveCardGroupMeta(c, conversations)
  if (meta) Object.assign(card, toCardGroupFields(meta))
  return card
}

/** 卡片树归一化:任意来源(旧/新/裸数组)统一为当前 Card[] */
export function normalizeCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((c, i) => normalizeCard(c, i))
    .filter((c): c is Card => c !== null)
}

// JSON 导入

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

// JSON 导出

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
 * 挑出"可导出"的卡片/对话（只读遍历，不复制消息体）
 *
 * 性能要点：这里只做**浅层筛选**，绝不
 * `JSON.parse(JSON.stringify(cards))` —— 30MB 的数据集深拷贝一次就是
 * 又一个 30MB 常驻内存，手机 WebView 直接崩。
 */
function pickExportableCards(cards: Card[]): Card[] {
  const out: Card[] = []
  for (const card of cards) {
    const conversations = card.conversations.filter(
      (conv) => conv.messages.length > 0 || (conv.contextHistory?.length ?? 0) > 0,
    )
    if (conversations.length === 0) continue
    // 只重建卡片与对话的外壳，消息数组按引用带走
    const copy: Card = { ...card, conversations }
    // 后端群聊会话有 300s 空闲回收，导出这份 id 没有意义（导入端会重建）
    delete copy.groupSessionId
    out.push(copy)
  }
  return out
}

/**
 * 字符串的 UTF-8 真实字节数
 *
 * 落盘的是 UTF-8：一个汉字 3 字节，用 `text.length`（UTF-16 码元数）冒充
 * 体积会低估一半以上。这里逐码元计算，避免为了量体积再造一份 60MB 的
 * TextEncoder 数组或 Blob 副本。
 */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // 代理对（emoji 等）→ 4 字节，并吞掉下一个码元
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** 组装导出用的顶层字段（cards 单独处理，便于流式写出） */
function buildJsonHead(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Array<[string, unknown]> {
  const hasOverrides = Object.keys(promptOverrides).length > 0
  const head: Array<[string, unknown]> = [
    ['version', PROJECT_VERSION],
    ['myGender', myGender],
    ['stripVariantIndex', stripVariantIndex],
    ['exportedAt', new Date().toISOString()],
    ['stats', countStats(cards)],
  ]
  if (settingsSnapshot) head.push(['settings', settingsSnapshot])
  if (hasOverrides) head.push(['promptOverrides', promptOverrides])
  // v7: 列表人物顺序(稳定标识;覆盖导入时应用,合并导入时忽略)
  if (cardOrder && cardOrder.length) head.push(['order', cardOrder])
  return head
}

/**
 * 图片以 dataURL 内联（ZIP 则是独立文件）；只导出有消息或有 AI 记忆的对话。
 * 防 OOM：超预算按「先大后小」剔除并重估，仍超硬上限就抛错。
 * 本函数是同步的、做不了 canvas，异步调用方应先调 reencodeOversizedImages。
 */
export function exportToJson(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): { json: string; filteredImages: number; reencodedImages: number; totalBytes: number } {
  const exportableCards = pickExportableCards(cards)
  if (exportableCards.length === 0) {
    throw new Error('没有可导出的对话数据')
  }

  const totalBytes = estimateExportBytes(exportableCards)
  let workCards = exportableCards
  let filteredImages = 0
  // 只有真的超预算才过滤：常规导出一次深拷贝都不做（闪退主因之一）
  if (totalBytes > EXPORT_BUDGET_BYTES) {
    const budgeted = applyImageBudget(exportableCards)
    workCards = budgeted.cards
    filteredImages = budgeted.dropped
  }
  // 剔除后重新估算：纯文本超限时没有图可删，只能明确拒绝
  assertExportSizeWithinLimit(estimateExportBytes(workCards), '导出 JSON')

  const head = buildJsonHead(
    workCards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  const payload = Object.fromEntries(head)
  Object.defineProperty(payload, 'cards', { value: workCards, enumerable: true })
  // 紧凑输出：美化缩进会让 30MB 的包再胖 ~25%，导入端只认 JSON 语义不受影响
  const json = JSON.stringify(payload)
  // 真实字节：以 UTF-8 落盘长度为准，不回估算值
  const realBytes = utf8ByteLength(json)
  assertExportSizeWithinLimit(realBytes, '导出 JSON')
  // 同步路径没有 canvas，重编码张数恒为 0；调用方自行重编码后再合并计数
  return { json, filteredImages, reencodedImages: 0, totalBytes: realBytes }
}

/**
 * 流式生成导出 JSON 的文本片段（内存友好版，Android 分块导出用）
 *
 * 逐张卡片 `JSON.stringify` 后拼进缓冲区，缓冲区到 chunkChars 就 yield 出去，
 * 任意时刻内存里只有"一张卡 + 一个缓冲块"，而不是整个 30MB 字符串。
 *
 * @param chunkChars 每片的目标字符数（默认 512KB）
 */
export async function* exportToJsonChunks(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
  chunkChars = 512 * 1024,
): AsyncGenerator<string, { filteredImages: number; totalBytes: number }, void> {
  const exportableCards = pickExportableCards(cards)
  if (exportableCards.length === 0) {
    throw new Error('没有可导出的对话数据')
  }
  const totalBytes = estimateExportBytes(exportableCards)
  let workCards = exportableCards
  let filteredImages = 0
  if (totalBytes > EXPORT_BUDGET_BYTES) {
    const budgeted = applyImageBudget(exportableCards)
    workCards = budgeted.cards
    filteredImages = budgeted.dropped
  }
  // 剔除后重新估算，再看硬上限
  assertExportSizeWithinLimit(estimateExportBytes(workCards), '导出 JSON')

  const head = buildJsonHead(
    workCards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )

  let emittedBytes = 0
  const emit = (chunk: string): string => {
    emittedBytes += utf8ByteLength(chunk)
    return chunk
  }
  let buf = '{'
  let first = true
  for (const [k, v] of head) {
    if (v === undefined || v === null) continue
    buf += (first ? '' : ',') + JSON.stringify(k) + ':' + JSON.stringify(v)
    first = false
    if (buf.length >= chunkChars) {
      yield emit(buf)
      buf = ''
    }
  }
  buf += (first ? '' : ',') + '"cards":['
  for (let i = 0; i < workCards.length; i++) {
    if (i > 0) buf += ','
    buf += JSON.stringify(workCards[i])
    if (buf.length >= chunkChars) {
      yield emit(buf)
      buf = ''
    }
  }
  buf += ']}'
  yield emit(buf)

  // 真实字节总量：逐片累计 UTF-8 长度，与最终文件同一口径
  return { filteredImages, totalBytes: emittedBytes }
}

/** JSON 导出文件名 —— 与 ZIP 共用 timestamp()，时区一致 */
export function jsonExportFileName(): string {
  return `BAKER-JSON-${timestamp()}${JSON_EXPORT_EXT}`
}

/**
 * 导出 JSON 工程文件（安装版弹系统保存框 / 浏览器直接下载）。
 *
 * 大图重编码只在会触发预算处理的超大导出里做：`exportToJson` 是同步的、做不了 canvas，
 * 所以放在序列化之前。常规导出保留原图，reencodedImages 恒为 0。
 */
export async function downloadProjectJson(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Promise<{
  filteredImages: number
  reencodedImages: number
  totalBytes: number
  path: string
  uri: string
  revealed: boolean
}> {
  // 与 ZIP 同口径：平时不动图片，只有超大导出才先压图（避免剔除/超限）
  const prepared = estimateExportBytes(cards) > EXPORT_BUDGET_BYTES
    ? await reencodeOversizedImages(cards)
    : { cards, reencodedImages: 0 }
  const { json, filteredImages } = exportToJson(
    prepared.cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  // 真实字节：浏览器端是 blob.size；原生端是回读校验过的落盘字节
  const saved = await downloadBlob(blob, jsonExportFileName())
  return {
    filteredImages,
    reencodedImages: prepared.reencodedImages,
    totalBytes: saved.bytes || blob.size,
    path: saved.path,
    uri: saved.uri,
    revealed: saved.revealed,
  }
}

