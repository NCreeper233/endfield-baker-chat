// zipExport —— ZIP 工程导入导出与卡片白名单净化
// ZIP 内全是可读 JSON/TXT + 独立图片文件。群聊是卡片级属性：project.json 的 cards[]
// 按卡片下标与 cards/NN 对齐写读，漏写会让群聊导出再导入后退化成单聊壳。

import JSZip from 'jszip'
import { isNative as isNativePlatformReal } from './platform'
import { SaveFilePlugin, saveExportFileSmart } from './nativeExport'
import { CHAT_IMAGE } from '../constants/design'
import {
  extractCardGroupMeta,
  resolveCardGroupMeta,
  toCardGroupFields,
} from './groupMeta'
import type { Card, ChatMessage, ContextEntry, Conversation } from '../types/chat'

/** 工程文件版本号(结构变更时升版本) */
export const PROJECT_VERSION = 1
/** 导出文件扩展名 */
export const EXPORT_FILE_EXT = '.zip'

/** 工程文件序列化结构 */
export interface ProjectPayload {
  version: number
  cards: Card[]
  /** 全局管理员性别 */
  myGender: 'male' | 'female'
  /** 顶部聊天条图片下标(0/1/2) */
  stripVariantIndex: number
  /** 用户自定义提示词覆盖(角色名 → 提示词);无覆盖时为 undefined */
  promptOverrides?: Record<string, string>
  /** v6: 完整设置快照(API 配置/think/force_search/智能总结/公告标记等) */
  settings?: Record<string, unknown>
  /**
   * v7：列表人物顺序（最近活跃在前），元素是主卡的稳定标识（`s:干员名` /
   * `g:成员|成员`）而非下标，换设备或增删卡片都不会串号。
   * 覆盖导入应用该顺序；合并导入忽略它、保留本地顺序。
   */
  order?: string[]
}

// 类型守卫（手写校验）

function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    typeof m.id === 'number' &&
    (m.side === 'other' || m.side === 'mine') &&
    typeof m.text === 'string' &&
    (m.image === undefined || typeof m.image === 'string') &&
    (m.imageW === undefined || typeof m.imageW === 'number') &&
    (m.imageH === undefined || typeof m.imageH === 'number') &&
    (m.speakerName === undefined || typeof m.speakerName === 'string')
  )
}

function isConversation(v: unknown): v is Conversation {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.name === 'string' &&
    Array.isArray(c.messages) &&
    c.messages.every(isChatMessage) &&
    (c.contextHistory === undefined || (Array.isArray(c.contextHistory) && c.contextHistory.every(
      (e) => e && typeof e === 'object' &&
        ((e as Record<string, unknown>).side === 'other' || (e as Record<string, unknown>).side === 'mine') &&
        typeof (e as Record<string, unknown>).text === 'string' &&
        ((e as Record<string, unknown>).image === undefined || typeof (e as Record<string, unknown>).image === 'string'),
    )))
  )
}

function isCard(v: unknown): v is Card {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    Array.isArray(c.conversations) &&
    c.conversations.length >= 1 &&
    c.conversations.every(isConversation)
  )
}

/** 校验任意值是否为卡片树 */
export function isCards(v: unknown): v is Card[] {
  return Array.isArray(v) && v.every(isCard)
}

// 白名单净化（重建纯对象，剔除未知字段）

function sanitizeChatMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { id: m.id, side: m.side, text: m.text }
  if (m.image !== undefined) {
    out.image = m.image
    out.imageW = typeof m.imageW === 'number' && m.imageW > 0 ? m.imageW : CHAT_IMAGE.w
    out.imageH = typeof m.imageH === 'number' && m.imageH > 0 ? m.imageH : CHAT_IMAGE.h
  }
  if (m.speakerName !== undefined) {
    out.speakerName = m.speakerName
  }
  // 群聊「新话题」提示行标记:漏掉它会把话题行还原成一条普通消息
  if (m.topic) {
    out.topic = true
  }
  // speakerAvatar 不再导出(头像是应用内置资源,导入时根据角色名自动匹配)
  return out
}

function sanitizeConversation(c: Conversation): Conversation {
  // 错误消息(请求失败占位)不进入持久化/导入清洗结果
  const messages = c.messages.filter((m) => !m.isError).map(sanitizeChatMessage)
  const out: Conversation = { name: c.name, messages }
  if (c.contextHistory !== undefined) {
    out.contextHistory = c.contextHistory.map((e) => {
      const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: e.side, text: e.text }
      if (e.image !== undefined) entry.image = e.image
      return entry
    })
  }
  // AI 推荐回复缓存:必须跟着对话一起持久化,否则每次重开都要重新生成一遍
  const sug = c.suggestions
  if (sug && Array.isArray(sug.items)) {
    const items = sug.items.filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (items.length > 0) {
      out.suggestions = {
        forMessageId: typeof sug.forMessageId === 'number' ? sug.forMessageId : 0,
        items,
        at: typeof sug.at === 'number' ? sug.at : 0,
      }
    }
  }
  return out
}

/**
 * 恢复用：逐卡校验清洗。isCards 是全有或全无，坏一条就整个库不恢复，
 * 随后被自动保存覆盖 = 坏一条丢全部；这里坏的跳过计数，好的照常恢复。
 */
export function restoreCardsLoose(raw: unknown[]): { cards: Card[]; dropped: number } {
  const cards: Card[] = []
  let dropped = 0
  for (const item of raw) {
    try {
      if (!item || typeof item !== 'object') { dropped++; continue }
      const one = sanitizeCards([item as Card])
      if (one.length > 0) cards.push(one[0])
      else dropped++
    } catch {
      dropped++
    }
  }
  return { cards, dropped }
}

/**
 * 卡片白名单净化（重建纯对象，剔除未知字段），持久化恢复与 ZIP 导入导出共用。
 * ⚠️ 卡片级字段必须逐个显式带过来，漏一个就会让群聊卡退化成单聊卡；
 * 字段来源统一收敛在 utils/groupMeta。刻意不持久化 groupSessionId（后端 300s 回收）。
 */
export function sanitizeCards(cards: Card[]): Card[] {
  return cards.map((c) => {
    const out: Card = {
      conversations: c.conversations.map(sanitizeConversation),
    }
    // 显式字段优先，缺失时按对话内容推断
    const meta = resolveCardGroupMeta(c, out.conversations)
    if (meta) Object.assign(out, toCardGroupFields(meta))
    return out
  })
}

// 文件名工具

/** 将角色名/对话名净化为安全的文件名片段 */
function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unnamed'
}

// dataURL ↔ 二进制转换

/** dataURL 的 mime → 文件扩展名映射 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
}

/** 文件扩展名 → mime 映射(导入时反向查找) */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

/** dataURL → { 二进制数据, 文件扩展名 };解析失败抛异常 */
function dataURLToBinary(dataURL: string): { data: Uint8Array; ext: string } {
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('无效的 dataURL')
  const mime = match[1]
  const base64 = match[2]
  // 真实字节守卫：base64 为空/解出 0 字节时，写进 ZIP 的会是一个空图片文件
  // （导入后变成坏图），直接当"无效 dataURL"处理更诚实。
  if (!base64) throw new Error('无效的 dataURL(内容为空)')
  const ext = MIME_TO_EXT[mime] ?? 'bin'
  // base64 → Uint8Array
  const binary = atob(base64)
  if (binary.length === 0) throw new Error('无效的 dataURL(解出 0 字节)')
  const data = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i)
  }
  return { data, ext }
}

/** 二进制 → dataURL(分块 base64,避免逐字节拼接导致 Android WebView 内存峰值/OOM) */
function binaryToDataURL(data: Uint8Array, ext: string): string {
  const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream'
  // Uint8Array → base64:按 0x8000 字节分块转换,避免超长字符串拼接与
  // String.fromCharCode.apply 参数栈溢出(Android 上大图极易触发)
  let binary = ''
  // 分片上限 8192 字节:确保任何环境(含 Android WebView)都不会触发
  // String.fromCharCode.apply 参数栈溢出(RangeError)
  const CHUNK = 8192
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.subarray(i, Math.min(i + CHUNK, data.length))
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  const base64 = btoa(binary)
  return `data:${mime};base64,${base64}`
}

// 时间戳

/**
 * 导出文件名用的本地时间戳（YYYYMMDD-HHmmss）。
 * ZIP 与 JSON 必须共用这一个：文件名是给人看的，用 UTC 会与另一个包差 8 小时。
 */
export function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// 统计

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

// ZIP 导出

// 导出预算（Android 大历史数据防 OOM）
/**
 * 软预算：超预算先重编码大图、实在放不下才退占位。不是硬门槛，纯文本略超仍允许导出。
 */
export const EXPORT_BUDGET_BYTES = 40 * 1024 * 1024
/**
 * 硬上限：超过直接拒绝。原生通道要把整包转 base64 再过桥（×1.33），再往上只会
 * 在导出中途 OOM 闪退，连可读的报错都留不下，宁可明确拒绝。
 */
export const EXPORT_HARD_LIMIT_BYTES = 60 * 1024 * 1024
/**
 * 单张图片「值得处理」的阈值：超过它不再静默剔除，而是先尝试重编码，
 * 只有重编码失败且总量仍放不下时，才退回 [图片] 占位。
 */
export const EXPORT_MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
/** 导出重编码的长边上限(px)：聊天里不会按原图看，1600 足够清晰 */
export const EXPORT_IMAGE_MAX_EDGE = 1600
/** 导出重编码质量(webp / jpeg 通用) */
export const EXPORT_IMAGE_QUALITY = 0.8

/** dataURL 估算字节数(base64 长度 × 0.75) */
export function estimateDataUrlBytes(dataURL: string): number {
  if (!dataURL) return 0
  return Math.round(dataURL.length * 0.75)
}

/** 估算一次导出的总字节数(文本 + 图片 dataURL) */
export function estimateExportBytes(cards: Card[]): number {
  let total = 0
  for (const card of cards) {
    for (const conv of card.conversations) {
      for (const msg of conv.messages) {
        total += msg.text.length * 2
        if (msg.image) total += estimateDataUrlBytes(msg.image)
      }
      for (const entry of conv.contextHistory ?? []) {
        total += entry.text.length * 2
        if (entry.image) total += estimateDataUrlBytes(entry.image)
      }
    }
  }
  return total
}

/**
 * 超限就抛可执行提示，绝不「硬压」后继续：提示要说清下一步做什么（清理 / 分批），
 * 否则只是换了个地方报「导出失败」。
 */
export function assertExportSizeWithinLimit(bytes: number, kind = '导出内容'): void {
  if (bytes <= EXPORT_HARD_LIMIT_BYTES) return
  const mb = (bytes / 1024 / 1024).toFixed(1)
  const limitMb = Math.round(EXPORT_HARD_LIMIT_BYTES / 1024 / 1024)
  throw new Error(
    `${kind} 约 ${mb}MB，超过单次导出上限 ${limitMb}MB（再大在手机上会内存溢出、导出失败）。` +
    '请先在「数据管理」里清理不需要的历史消息或大图；数据确实要保留的话，' +
    '请分批处理（例如先导出并清理一部分会话，再导出剩下的）。',
  )
}

/** 预算是"先大后小"剔除时用的图片位置（只记位置与体积，不改数据） */
interface ImageBudgetRef {
  bytes: number
  key: string
}

/**
 * 按「先大后小」剔除图片，每剔一张重新估算：只删到刚好放得下为止，能保住更多图。
 * 原始数据不被修改，只惰性复制被改动的那一层（不对整棵树做深拷贝）。
 * 调用方应先试过 reencodeOversizedImages，走到这里的是重编码也救不回来的图。
 */
export function applyImageBudget(
  cards: Card[],
  budgetBytes = EXPORT_BUDGET_BYTES,
): { cards: Card[]; dropped: number } {
  let estimate = estimateExportBytes(cards)
  if (estimate <= budgetBytes) return { cards, dropped: 0 }

  // 1. 收集候选：只有单张就超过阈值的图才值得删；删小图救不了总量，只会白丢
  const candidates: ImageBudgetRef[] = []
  cards.forEach((card, ci) => {
    card.conversations.forEach((conv, vi) => {
      conv.messages.forEach((msg, mi) => {
        const bytes = msg.image ? estimateDataUrlBytes(msg.image) : 0
        if (bytes > EXPORT_MAX_IMAGE_BYTES) candidates.push({ bytes, key: `${ci}/${vi}/m${mi}` })
      })
      ;(conv.contextHistory ?? []).forEach((entry, ei) => {
        const bytes = entry.image ? estimateDataUrlBytes(entry.image) : 0
        if (bytes > EXPORT_MAX_IMAGE_BYTES) candidates.push({ bytes, key: `${ci}/${vi}/c${ei}` })
      })
    })
  })
  if (candidates.length === 0) return { cards, dropped: 0 }

  // 2. 先大后小地删，直到估算落回预算内（estimate 每步都在减 = 重新估算）
  candidates.sort((a, b) => b.bytes - a.bytes)
  const dropKeys = new Set<string>()
  for (const cand of candidates) {
    if (estimate <= budgetBytes) break
    dropKeys.add(cand.key)
    estimate -= cand.bytes
  }

  // 3. 惰性复制：只重建真的被剔图的那条链
  let out: Card[] | null = null
  cards.forEach((card, ci) => {
    let cardCopy: Card | null = null
    card.conversations.forEach((conv, vi) => {
      let messages: ChatMessage[] | null = null
      conv.messages.forEach((msg, mi) => {
        if (!dropKeys.has(`${ci}/${vi}/m${mi}`)) return
        if (!messages) messages = conv.messages.slice()
        const placed: ChatMessage = { ...msg, text: msg.text || '[图片]' }
        delete placed.image
        delete placed.imageW
        delete placed.imageH
        messages[mi] = placed
      })
      let contextHistory = conv.contextHistory
      if (contextHistory) {
        let ctxCopy: ContextEntry[] | null = null
        contextHistory.forEach((entry, ei) => {
          if (!dropKeys.has(`${ci}/${vi}/c${ei}`)) return
          if (!ctxCopy) ctxCopy = contextHistory!.slice()
          // 上下文条目只有 side/text/image，保留文本、去掉图（与旧行为一致）
          ctxCopy[ei] = { side: entry.side, text: entry.text || '[图片]' }
        })
        if (ctxCopy) contextHistory = ctxCopy
      }
      if (!messages && contextHistory === conv.contextHistory) return

      let thisCard: Card | null = cardCopy
      if (!thisCard) {
        thisCard = { ...card, conversations: card.conversations.slice() }
        let root = out
        if (!root) root = cards.slice()
        root[ci] = thisCard
        out = root
      }
      const convCopy: Conversation = { ...conv, messages: messages ?? conv.messages }
      if (contextHistory !== conv.contextHistory) convCopy.contextHistory = contextHistory
      thisCard.conversations[vi] = convCopy
      cardCopy = thisCard
    })
  })
  return { cards: out ?? cards, dropped: dropKeys.size }
}

// 导出前图片重编码：大图先压，而不是静默删

/** 能被 canvas 重编码的格式（动图/矢量/未知格式重编码会丢信息，一律不碰） */
const REENCODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** 当前环境能否做 canvas 编解码（Web Worker 里没有 document → 跳过重编码） */
function canUseCanvas(): boolean {
  return typeof document !== 'undefined'
    && typeof Image !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
}

/** dataURL → 已解码的图片元素（失败抛错，由调用方降级） */
function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/**
 * 把一张大图重编码为 webp（不支持时退回 jpeg）。
 * 无法处理或结果没变小就返回 null（保留原图）；q0.8 + 长边 1600 通常能把 2~5MB 压到 100~300KB。
 */
async function reencodeImageDataUrl(dataUrl: string): Promise<string | null> {
  const mime = dataUrl.match(/^data:([^;]+);base64,/)?.[1] ?? ''
  if (!REENCODABLE_MIME.has(mime)) return null
  if (!canUseCanvas()) return null

  let img: HTMLImageElement
  try {
    img = await loadImageElement(dataUrl)
  } catch {
    return null
  }
  const sw = img.naturalWidth || img.width
  const sh = img.naturalHeight || img.height
  if (!sw || !sh) return null

  const scale = Math.min(1, EXPORT_IMAGE_MAX_EDGE / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)
    let out = ''
    try {
      out = canvas.toDataURL('image/webp', EXPORT_IMAGE_QUALITY)
    } catch {
      out = ''
    }
    if (!out.startsWith('data:image/webp')) {
      // 不支持 webp 编码：jpeg 没有透明通道，必须先补白底再重画，
      // 否则透明区域会变成黑块（导出图看着像坏了）。
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      try {
        out = canvas.toDataURL('image/jpeg', EXPORT_IMAGE_QUALITY)
      } catch {
        return null
      }
    }
    if (!out.startsWith('data:image/')) return null
    // 只有真的变小才替换：小图/已高度压缩的图重编码可能反而更大、画质还降
    return out.length < dataUrl.length ? out : null
  } finally {
    // 立即释放画布后备存储，避免连续处理多张图时内存叠高
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * 把超阈值的图片重编码压小（长边 1600 / q0.8）；失败或无法处理的原样保留，
 * 是否退回占位交给 applyImageBudget。只在估算超预算时调用；Worker 环境原样返回。
 */
export async function reencodeOversizedImages(
  cards: Card[],
): Promise<{ cards: Card[]; reencodedImages: number }> {
  if (!canUseCanvas()) return { cards, reencodedImages: 0 }

  // 同一张图可能在 messages 与 contextHistory 各存一份，用 dataURL 本身做键避免重复解码
  const cache = new Map<string, string | null>()
  const reencodeOnce = async (url: string): Promise<string | null> => {
    if (!cache.has(url)) cache.set(url, await reencodeImageDataUrl(url))
    return cache.get(url) ?? null
  }

  let out: Card[] | null = null
  let count = 0
  const cardsCopy = cards.slice()
  for (let ci = 0; ci < cardsCopy.length; ci++) {
    const card = cardsCopy[ci]
    let cardCopy: Card | null = null
    for (let vi = 0; vi < card.conversations.length; vi++) {
      const conv = card.conversations[vi]
      let messages: ChatMessage[] | null = null

      for (let mi = 0; mi < conv.messages.length; mi++) {
        const msg = conv.messages[mi]
        if (!msg.image || estimateDataUrlBytes(msg.image) <= EXPORT_MAX_IMAGE_BYTES) continue
        const next = await reencodeOnce(msg.image)
        if (!next) continue
        if (!messages) messages = conv.messages.slice()
        messages[mi] = { ...msg, image: next }
        count++
      }

      let ctxCopy: ContextEntry[] | null = null
      const ctx = conv.contextHistory
      if (ctx) {
        for (let ei = 0; ei < ctx.length; ei++) {
          const entry = ctx[ei]
          if (!entry.image || estimateDataUrlBytes(entry.image) <= EXPORT_MAX_IMAGE_BYTES) continue
          const next = await reencodeOnce(entry.image)
          if (!next) continue
          if (!ctxCopy) ctxCopy = ctx.slice()
          ctxCopy[ei] = { ...entry, image: next }
          count++
        }
      }

      if (!messages && !ctxCopy) continue
      const convCopy: Conversation = { ...conv, messages: messages ?? conv.messages }
      if (ctxCopy) convCopy.contextHistory = ctxCopy

      let thisCard: Card | null = cardCopy
      if (!thisCard) {
        thisCard = { ...card, conversations: card.conversations.slice() }
        cardsCopy[ci] = thisCard
      }
      thisCard.conversations[vi] = convCopy
      cardCopy = thisCard
      out = cardsCopy
    }
  }
  return { cards: out ?? cards, reencodedImages: count }
}

/**
 * 序列化卡片树 + 全局设置 + 提示词覆盖为 ZIP Blob；图片提取为独立文件，JSON 里只存
 * ZIP 内路径（未知格式如 avif/heic 保留内联）。只导出自定义提示词，内置默认不导出。
 * 防 OOM：超预算先重编码再按「先大后小」剔除（留 [图片] 占位），仍超硬上限就抛错。
 */
export function buildProjectZip(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): { zip: JSZip; filteredImages: number; totalBytes: number } {
  const zip = new JSZip()

  // 仅导出有消息或有 AI 记忆(contextHistory)的对话;
  // 错误消息(请求失败占位)不进入导出文件
  const exportableCards: Card[] = cards
    .map((card) => ({
      // 同上:保留卡片级字段(members / myRole / speakMode …)
      ...card,
      conversations: card.conversations
        .map((conv) => ({
          ...conv,
          messages: conv.messages.filter((m) => !m.isError),
        }))
        .filter(
          (conv) => conv.messages.length > 0 || (conv.contextHistory?.length ?? 0) > 0,
        ),
    }))
    .filter((card) => card.conversations.length > 0)

  if (exportableCards.length === 0) {
    throw new Error('没有可导出的对话数据')
  }

  // 预算检查:超预算 → 按"先大后小"剔除图片，每删一张都重新估算
  //
  // 刻意不再 JSON.parse(JSON.stringify()) 整棵树：30MB 数据深拷贝一次就是
  // 又一个常驻副本，低端机正是死在导出这一步；applyImageBudget 走惰性复制。
  const totalBytes = estimateExportBytes(exportableCards)
  const budgeted = totalBytes > EXPORT_BUDGET_BYTES
    ? applyImageBudget(exportableCards)
    : { cards: exportableCards, dropped: 0 }
  const filteredImages = budgeted.dropped
  const exportableCardsCopy: Card[] = budgeted.cards

  // 纯文本超限时已无图可删，与其硬压到 OOM，不如明确拒绝并提示清理 / 分批
  assertExportSizeWithinLimit(estimateExportBytes(exportableCardsCopy))

  const stats = countStats(exportableCardsCopy)

  /**
   * 群聊卡片级元数据，按卡片下标与 cards/NN 对齐；单聊卡写 null。
   * ⚠️ members / myRole / speakMode 装不进子会话 JSON，漏写就会变成单聊壳。
   */
  const cardMetas = exportableCardsCopy.map((card) => extractCardGroupMeta(card))

  // 1. project.json — 元数据(含 v6 设置快照: apiConfig/提示词覆盖/开关等)
  const projectMeta = {
    version: PROJECT_VERSION,
    myGender,
    stripVariantIndex,
    exportedAt: new Date().toISOString(),
    stats,
    // 群聊卡片级字段(下标与 cards/NN 对齐;全为单聊时写空数组)
    cards: cardMetas.some((m) => m !== null) ? cardMetas : [],
    // v6: 完整设置快照(API 配置/自定义提示词/think/force_search/智能总结/公告标记)
    settings: settingsSnapshot || undefined,
    // v7: 列表人物顺序(稳定标识;覆盖导入时应用,合并导入时忽略)
    order: cardOrder && cardOrder.length ? cardOrder : undefined,
  }
  zip.file('project.json', JSON.stringify(projectMeta, null, 2))

  // 2. cards/ — 每张卡片的对话 JSON + 图片文件
  exportableCardsCopy.forEach((card, cardIdx) => {
    const cardDir = `cards/${String(cardIdx).padStart(2, '0')}`
    const conversationsDir = `${cardDir}/conversations`
    const imagesDir = `${cardDir}/images`

    card.conversations.forEach((conv, convIdx) => {
      const convIdxStr = String(convIdx).padStart(2, '0')
      const namePart = sanitizeFileName(conv.name)

      // 深拷贝对话数据(不修改原始对象)
      const convData: Conversation = JSON.parse(JSON.stringify(conv))

      // 只提取 MIME_TO_EXT 表内的格式；未知格式（avif/heic）保留 dataURL 内联，
      // 否则重新导入时会变成损坏的 octet-stream。
      for (const msg of convData.messages) {
        if (msg.image && msg.image.startsWith('data:')) {
          const mime = msg.image.match(/^data:([^;]+);base64,/)?.[1]
          if (!mime || !(mime in MIME_TO_EXT)) continue
          try {
            const { data, ext } = dataURLToBinary(msg.image)
            const imgFileName = `${convIdxStr}-${msg.id}.${ext}`
            zip.file(`${imagesDir}/${imgFileName}`, data)
            // JSON 中存 ZIP 内完整路径
            msg.image = `${imagesDir}/${imgFileName}`
          } catch {
            // dataURL 解析失败,保留原始 dataURL(不提取)
          }
        }
      }

      // 写入对话 JSON(含 messages + contextHistory)
      const convFileName = `${convIdxStr}-${namePart}.json`
      zip.file(`${conversationsDir}/${convFileName}`, JSON.stringify(convData, null, 2))
    })
  })

  // 3. prompts/ — 自定义提示词(仅导出有内容的)
  const hasOverrides = Object.keys(promptOverrides).length > 0

  if (hasOverrides) {
    for (const [name, prompt] of Object.entries(promptOverrides)) {
      if (prompt) {
        const fileName = sanitizeFileName(name)
        zip.file(`prompts/characters/${fileName}.txt`, prompt)
      }
    }
  }

  // 4. 生成 ZIP Blob
  //
  // totalBytes 只是压缩前的估算；真实体积由 exportToZip 用 blob.size 返回。
  return { zip, filteredImages, totalBytes }
}

/**
 * 生成 ZIP Blob（内存版，会同时持有整个压缩包）。大工程应走
 * downloadBlob → saveExportFileSmart 的分块落盘通道，别再整包转 base64。
 * totalBytes 是 blob.size 而非估算值，成功提示的 MB 数才与落盘文件对得上。
 */
export async function exportToZip(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Promise<{ blob: Blob; filteredImages: number; reencodedImages: number; totalBytes: number }> {
  // 平时导出是备份：原图原样进包。只有会触发预算处理的超大导出才先压大图，
  // 用画质换「不剔除、不超限」，而不是把用户的照片悄悄换成缩略图。
  const prepared = estimateExportBytes(cards) > EXPORT_BUDGET_BYTES
    ? await reencodeOversizedImages(cards)
    : { cards, reencodedImages: 0 }
  const { zip, filteredImages } = buildProjectZip(
    prepared.cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  // JSZip 3.10 的 generateAsync 为异步 API(内部同步流处理),不会阻塞主线程
  const blob = await zip.generateAsync({ type: 'blob' })
  // 真实体积守卫：估算终究是估算（中文 3 字节/字、压缩率未知），落盘前再拦一次
  assertExportSizeWithinLimit(blob.size)
  return {
    blob,
    filteredImages,
    reencodedImages: prepared.reencodedImages,
    totalBytes: blob.size,
  }
}

/** 与 JSON 文件名共用 timestamp()，同一时刻导出的两个包时间一致 */
export function projectExportFileName(): string {
  return `BAKER-${timestamp()}${EXPORT_FILE_EXT}`
}

/**
 * 打包环境的「另存为」能力探测：Electron 用 saveFileDialog，APK 用 SaveFile 插件（SAF）。
 * 不可用返回 null，浏览器走 <a download>。
 */
export type SaveFileFn = (options: { fileName: string; base64: string })
  => Promise<{ canceled?: boolean; path?: string }>

/**
 * ⚠️ 必须用 getPlatform() 而不是试探插件方法：Capacitor 的 registerPlugin 返回万能代理，
 * 对任何属性都返回函数，只在调用时抛 "plugin is not implemented on web"，
 * 试探法会在浏览器里误判「原生保存可用」。
 */
export async function getNativeSaveFile(): Promise<SaveFileFn | null> {
  const w = window as unknown as {
    nativeStorage?: { saveFileDialog?: SaveFileFn }
  }

  // Electron(EXE)
  if (typeof w.nativeStorage?.saveFileDialog === 'function') {
    return w.nativeStorage.saveFileDialog
  }

  // ⚠️ 官方版读 Capacitor.Plugins.SaveFile，但在 @capacitor/core 8.x 下该命名空间是空的，
  // 恒为 null；这里改用 registerPlugin('SaveFile') 的同一个句柄（与 nativeExport 同源）。
  // 拿不到就返回 null，不抛错；platform=web 时直接返回 null 走 <a download>。
  if (!isNativePlatformReal()) return null

  try {
    const plugin = SaveFilePlugin as unknown as { saveFile?: SaveFileFn }
    if (typeof plugin?.saveFile === 'function') {
      return (opts) => {
        const fn = (SaveFilePlugin as unknown as { saveFile: SaveFileFn }).saveFile
        return fn.call(SaveFilePlugin, opts)
      }
    }
  } catch {
    // 忽略：按无原生保存能力处理
  }

  return null
}

/** 分片转 base64：逐 8MB 转换后拼接，避免一次性读入整包撑爆 WebView 内存 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取导出数据失败'))
    reader.readAsArrayBuffer(blob)
    reader.onload = () => {
      try {
        const buf = reader.result as ArrayBuffer
        const bytes = new Uint8Array(buf)
        let binary = ''
        // 双层分片:外层 8MB,内层每次只拼 8K 个字符,
        // 避免 String.fromCharCode.apply 一次传过多参数导致 RangeError(栈溢出)
        const CHUNK = 8 * 1024 * 1024
        const STEP = 8192
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
          for (let j = 0; j < slice.length; j += STEP) {
            const part = slice.subarray(j, Math.min(j + STEP, slice.length))
            binary += String.fromCharCode.apply(null, part as unknown as number[])
          }
        }
        resolve(btoa(binary))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('base64 编码失败'))
      }
    }
  })
}

/**
 * 是否处于 Capacitor 原生平台（用于"拿不到保存通道就明确报错"的安全网）
 *
 * 同步判定：window.Capacitor 由原生注入的 bridge 脚本提供，模块加载时即存在。
 */
function isNativePlatformNoSave(): boolean {
  // 统一走 utils/platform：只有 android / ios 才算原生。
  // 否则浏览器会被误判成原生平台，走到"未取得系统保存组件"那条报错分支。
  return isNativePlatformReal()
}

/** base64 字符串解码后应有的字节数（用于核对编码结果有没有被截断） */
function base64ByteLength(b64: string): number {
  if (!b64) return 0
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/**
 * ZIP / JSON / 截图共用的下载入口：原生端走系统保存框（大文件分块写入），
 * 浏览器走 <a download>。返回实际交给平台的字节数。
 */
export async function downloadBlob(blob: Blob, fileName: string): Promise<number> {
  // 空内容守卫必须看真实字节：base64 少几个字符仍然「非空」，但文件已经废了
  if (!blob || blob.size === 0) {
    throw new Error('导出内容为空（0 字节），已中止以免生成空文件。请确认当前确实有可导出的数据。')
  }
  const mime = blob.type || 'application/octet-stream'

  // 打包环境:统一走 saveExportFileSmart —— 小文件走系统保存框,
  // 大文件改为分块写入(桥层不会截断)+回读校验;内容为空直接报错,
  // 绝不落一个空文件让用户以为数据丢了。
  if (await getNativeSaveFile()) {
    const base64 = await blobToBase64(blob)
    const decodedBytes = base64ByteLength(base64)
    if (decodedBytes !== blob.size) {
      throw new Error(
        `导出数据编码异常（原始 ${blob.size} 字节，编码后 ${decodedBytes} 字节），` +
        '已中止以免生成损坏文件。请重试；若反复出现，请先减少数据量再导出。')
    }
    const saved = await saveExportFileSmart({ fileName, base64, mime })
    return saved.bytes || decodedBytes
  }

  // Capacitor 原生平台但未探测到 SaveFile 插件:明确报错,避免静默走
  // 浏览器 <a download>(Android WebView 中无效,表现"点击无反应")。
  // 这条守卫把"静默什么都没发生"变成"界面明确告诉你原因"。
  if (isNativePlatformNoSave()) {
    throw new Error(
      '导出功能初始化失败：未取得系统保存组件（SaveFile 插件未注册）。' +
      '请确认安装的是最新安装包，或改用「导出 JSON」。')
  }

  // revoke 不能是 0ms：部分浏览器（移动端 WebView / Firefox）会在下载真正开始前
  // 就丢掉 Blob URL，表现成「点了没反应」。延迟 60s 回收，并用 pagehide 兜底。
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    URL.revokeObjectURL(url)
    window.removeEventListener('pagehide', revoke)
  }
  window.addEventListener('pagehide', revoke)
  window.setTimeout(revoke, 60_000)
  return blob.size
}

/** 下载 ZIP 文件(按平台:安装版弹系统保存框 / 浏览器直接下载) */
export async function downloadProject(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Promise<{ filteredImages: number; reencodedImages: number; totalBytes: number }> {
  const { blob, filteredImages, reencodedImages, totalBytes } = await exportToZip(
    cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  const fileName = projectExportFileName()
  // 原生端返回真实落盘字节，浏览器端返回 blob.size；都比估算值更贴近用户拿到的文件
  const written = await downloadBlob(blob, fileName)
  return { filteredImages, reencodedImages, totalBytes: written || totalBytes }
}

// ZIP 导入

/** 导入包体积上限(超过则拒绝,避免一次性解压超大文件导致 OOM) */
export const IMPORT_MAX_BYTES = 200 * 1024 * 1024

/**
 * 解压并校验工程文件；失败抛错，调用方负责提示，不触碰现有数据。
 * 图片路径还原为 dataURL；群聊卡片级字段按下标还原，旧包缺该字段时从对话内容反推，
 * 认不出来也原样保留卡片 —— 绝不因识别失败丢用户数据。
 */
export async function importFromZip(blob: Blob): Promise<ProjectPayload> {
  // 体积预检:超大文件拒绝,避免一次性解析完整大文件导致 Android WebView OOM
  if (blob.size > IMPORT_MAX_BYTES) {
    throw new Error(
      `导入文件过大(${(blob.size / 1024 / 1024).toFixed(1)}MB),超过上限 ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)}MB。` +
      '请导出时保留更少的大图,或联系开发者。',
    )
  }
  const zip = await JSZip.loadAsync(blob)

  // 1. 读取 project.json
  const projectFile = zip.file('project.json')
  if (!projectFile) throw new Error('缺少 project.json 文件')

  let projectMeta: Record<string, unknown>
  try {
    projectMeta = JSON.parse(await projectFile.async('string'))
  } catch {
    throw new Error('project.json 解析失败')
  }

  const fileVersion = projectMeta.version
  if (typeof fileVersion !== 'number') throw new Error('文件版本无效')
  if (fileVersion !== PROJECT_VERSION) {
    throw new Error(`文件版本不匹配:期望 ${PROJECT_VERSION},实际 ${fileVersion}`)
  }

  const myGender: 'male' | 'female' = projectMeta.myGender === 'female' ? 'female' : 'male'
  const stripVariantIndex = typeof projectMeta.stripVariantIndex === 'number'
    ? ((projectMeta.stripVariantIndex % 3) + 3) % 3
    : 0

  /** 群聊卡片级元数据；旧包没有该字段，只能靠 resolveCardGroupMeta 从对话内容反推 */
  const cardMetas: unknown[] = Array.isArray(projectMeta.cards) ? projectMeta.cards : []

  // 2. 读取卡片数据
  const cards: Card[] = []
  let cardIdx = 0
  while (true) {
    const cardDir = `cards/${String(cardIdx).padStart(2, '0')}`
    const convFiles = Object.keys(zip.files)
      .filter((path) => path.startsWith(`${cardDir}/conversations/`) && path.endsWith('.json'))
      .sort()

    if (convFiles.length === 0) break

    const conversations: Conversation[] = []
    for (const convPath of convFiles) {
      const file = zip.file(convPath)
      if (!file) continue

      let convRaw: unknown
      try {
        convRaw = JSON.parse(await file.async('string'))
      } catch {
        throw new Error(`对话文件解析失败: ${convPath}`)
      }
      if (!isConversation(convRaw)) {
        throw new Error(`对话数据无效: ${convPath}`)
      }

      // 还原图片路径 → dataURL
      for (const msg of convRaw.messages) {
        if (msg.image && !msg.image.startsWith('data:')) {
          // 是 ZIP 内路径引用
          const imgFile = zip.file(msg.image)
          if (imgFile) {
            const ext = msg.image.split('.').pop() ?? 'bin'
            const imgData = await imgFile.async('uint8array')
            msg.image = binaryToDataURL(imgData, ext)
          } else {
            // 图片文件缺失,移除引用避免显示损坏链接
            delete msg.image
            delete msg.imageW
            delete msg.imageH
          }
        }
      }

      // 同样处理 contextHistory 中的图片
      if (convRaw.contextHistory) {
        for (const entry of convRaw.contextHistory) {
          if (entry.image && !entry.image.startsWith('data:')) {
            const imgFile = zip.file(entry.image)
            if (imgFile) {
              const ext = entry.image.split('.').pop() ?? 'bin'
              const imgData = await imgFile.async('uint8array')
              entry.image = binaryToDataURL(imgData, ext)
            } else {
              delete entry.image
            }
          }
        }
      }

      conversations.push(convRaw)
    }

    if (conversations.length === 0) {
      throw new Error(`卡片 ${cardIdx} 没有有效对话`)
    }

    // 群聊卡片级字段:新包按下标读;旧包没有 → 由 resolveCardGroupMeta 反推
    const card: Card = { conversations }
    const meta = resolveCardGroupMeta(cardMetas[cardIdx], conversations)
    if (meta) Object.assign(card, toCardGroupFields(meta))
    cards.push(card)
    cardIdx++
  }

  if (cards.length === 0) throw new Error('未找到任何卡片数据')

  // 3. 读取自定义提示词(如果存在)
  let promptOverrides: Record<string, string> | undefined
  const promptCharDir = zip.folder('prompts/characters')
  if (promptCharDir) {
    const promptFiles = Object.keys(zip.files)
      .filter((path) => path.startsWith('prompts/characters/') && path.endsWith('.txt'))

    if (promptFiles.length > 0) {
      promptOverrides = {}
      for (const promptPath of promptFiles) {
        const file = zip.file(promptPath)
        if (!file) continue
        // 从文件名还原角色名:prompts/characters/伊冯.txt → 伊冯
        const fileName = promptPath.split('/').pop() ?? ''
        const charName = fileName.replace(/\.txt$/, '')
        const content = await file.async('string')
        if (content) {
          promptOverrides[charName] = content
        }
      }
      if (Object.keys(promptOverrides).length === 0) {
        promptOverrides = undefined
      }
    }
  }

  // 4. 读取设置快照(project.json 中的 settings 字段;缺失时 undefined)
  let settingsSnapshot: Record<string, unknown> | undefined
  if (projectMeta.settings && typeof projectMeta.settings === 'object') {
    settingsSnapshot = projectMeta.settings as Record<string, unknown>
  }

  // 5. 列表人物顺序(v7;旧包没有 → undefined)
  let order: string[] | undefined
  if (Array.isArray(projectMeta.order)) {
    order = (projectMeta.order as unknown[]).filter((k): k is string => typeof k === 'string' && !!k)
    if (order.length === 0) order = undefined
  }

  // 6. 白名单净化后返回
  return {
    version: PROJECT_VERSION,
    cards: sanitizeCards(cards),
    myGender,
    stripVariantIndex,
    promptOverrides,
    settings: settingsSnapshot,
    order,
  }
}
