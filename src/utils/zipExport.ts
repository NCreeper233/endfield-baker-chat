// =============================================================================
// ZIP 工程导入导出(zipExport)
// -----------------------------------------------------------------------------
// 职责:
//   - exportToZip: 卡片树 + 全局设置 → ZIP 压缩包(文本 JSON + 独立图片文件)
//   - importFromZip: ZIP → 校验 → ProjectPayload(含卡片树、提示词覆盖、系统提示词)
//   - 类型守卫 + 白名单净化(导出给 useChatPersistence 的 IndexedDB 恢复复用)
//
// ZIP 结构:
//   project.json                          元数据(version/myGender/stripVariantIndex/stats
//                                         + cards[]:群聊卡片级字段,下标与 cards/NN 对齐)
//   cards/XX/conversations/YY-name.json   每段对话(messages + contextHistory)
//   cards/XX/images/YY-ZZZ.ext            图片消息(从 dataURL 提取为独立二进制文件)
//   prompts/characters/角色名.txt          角色提示词覆盖(仅自定义时存在)
//
// 设计原则:
//   - ZIP 内全部是可读文本(JSON/TXT) + 二进制图片,用户可直接解压编辑
//   - 图片从 dataURL 提取为独立文件,JSON 中只存 ZIP 内路径引用
//   - contextHistory 与 messages 并列存储,AI 上下文完整保留
//   - 仅导出自定义提示词覆盖,内置默认提示词不导出
//   - 仅导出有消息或有 AI 记忆的对话;两者皆空的对话/卡片不导出
//   - 未知图片格式(avif/heic 等)保留 dataURL 内联,不做降级提取
//   - 群聊是**卡片级**属性:project.json 的 cards[] 必须与 cards/NN 同步写读,
//     否则群聊导出去再导回来会退化成单聊壳(见 utils/groupMeta)
// =============================================================================

import JSZip from 'jszip'
import { isNative as isNativePlatformReal } from './platform'
// 只需要"插件句柄"与"导出结果类型"：本文件已恢复为正式版的导出路径
import { SaveFilePlugin, type ExportOutcome, saveExportFileSmart } from './nativeExport'
import { CHAT_IMAGE } from '../constants/design'
import {
  extractCardGroupMeta,
  resolveCardGroupMeta,
  toCardGroupFields,
} from './groupMeta'
import type { Card, ChatMessage, Conversation } from '../types/chat'

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
   * v7: 列表人物顺序（最近活跃在前）
   *
   * 元素是主卡的**稳定标识**（`s:干员名` / `g:成员1|成员2|管理员`），
   * 而不是下标 —— 换设备、增删卡片都不会串号。
   *
   * 导入语义：
   *   · 覆盖导入 → 应用该顺序
   *   · 合并导入 → **忽略**该字段，保留本地已有顺序
   * 旧包没有此字段时，退回"按 cards 数组顺序"作为顺序（见 DataManagerDialog）。
   */
  order?: string[]
}

// ---- 类型守卫(手写校验) -----------------------------------------------------

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

// ---- 白名单净化(重建纯对象,剔除未知字段) -----------------------------------

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
 * 卡片白名单净化(重建纯对象,剔除未知字段)
 *
 * ⚠️ 这里同时被**持久化恢复**(useChatPersistence.loadProject)与**ZIP 导入导出**
 * 复用。早期版本只重建了 conversations,把卡片级字段全部丢掉 ——
 * 后果是每次重启后群聊卡都退化成单聊卡(members 丢失),群聊列表变空,
 * 演示数据播种逻辑又判定"没有群聊"从而反复塞回预设群。
 *
 * 因此卡片级字段必须逐个显式带过来。字段清单与"旧数据推断"统一收敛在
 * utils/groupMeta:显式字段优先,缺失时从对话内容反推(老包也能认出来)。
 *
 * 刻意**不持久化** groupSessionId:后端会话有 300s 空闲回收,
 * 跨重启的 id 必然失效;前端会在下一次请求时自动重建。
 */
export function sanitizeCards(cards: Card[]): Card[] {
  return cards.map((c) => {
    const out: Card = {
      conversations: c.conversations.map(sanitizeConversation),
    }
    // ---- 群聊卡片级字段(显式优先,缺失时按对话内容推断) ----
    const meta = resolveCardGroupMeta(c, out.conversations)
    if (meta) Object.assign(out, toCardGroupFields(meta))
    return out
  })
}

// ---- 文件名工具 -------------------------------------------------------------

/** 将角色名/对话名净化为安全的文件名片段 */
function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unnamed'
}

// ---- dataURL ↔ 二进制转换 ---------------------------------------------------

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
  const ext = MIME_TO_EXT[mime] ?? 'bin'
  // base64 → Uint8Array
  const binary = atob(base64)
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

/** base64 → Uint8Array(分块解码,避免逐字节 charCodeAt) */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const data = new Uint8Array(binary.length)
  const CHUNK = 0x8000
  for (let i = 0; i < binary.length; i += CHUNK) {
    const slice = binary.slice(i, Math.min(i + CHUNK, binary.length))
    for (let j = 0; j < slice.length; j++) {
      data[i + j] = slice.charCodeAt(j)
    }
  }
  return data
}

// ---- 时间戳 -----------------------------------------------------------------

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---- 统计 -------------------------------------------------------------------

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

// ---- ZIP 导出 ---------------------------------------------------------------

// ---- 导出预算(Android 大历史数据防 OOM) ------------------------------------
/** 导出数据总预算(字节);超过后自动过滤大图,避免 APK WebView OOM */
export const EXPORT_BUDGET_BYTES = 40 * 1024 * 1024
/** 单张图片上限(字节);超过上限的图片在导出时被过滤(保留 [图片] 占位文本) */
export const EXPORT_MAX_IMAGE_BYTES = 1.5 * 1024 * 1024

/** dataURL 估算字节数(base64 长度 × 0.75) */
function estimateDataUrlBytes(dataURL: string): number {
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
 * 序列化卡片树 + 全局设置 + 自定义提示词为 ZIP Blob。
 *
 * 图片从 dataURL 提取为独立二进制文件,JSON 中只存 ZIP 内路径引用;
 * 未知格式(avif/heic 等)保留 dataURL 内联,不做降级提取。
 * 仅导出自定义提示词覆盖和自定义世界观设定,内置默认不导出。
 * 仅导出有消息或有 AI 记忆的对话;两者皆空时抛错,不生成空包。
 *
 * 防 OOM:导出前按 EXPORT_BUDGET_BYTES 预算检查,超预算时自动过滤
 * 超大图片(EXPORT_MAX_IMAGE_BYTES 以上),保留 "[图片]" 占位文本,
 * 通过返回值 filteredImages 告知调用方,避免 Android 大历史导出闪退。
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

  // 预算检查:超预算 → 过滤超大图片
  const totalBytes = estimateExportBytes(exportableCards)
  const overBudget = totalBytes > EXPORT_BUDGET_BYTES
  let filteredImages = 0

  // 深拷贝(过滤时修改副本,不影响原数据)
  const exportableCardsCopy: Card[] = JSON.parse(JSON.stringify(exportableCards))

  if (overBudget) {
    for (const card of exportableCardsCopy) {
      for (const conv of card.conversations) {
        for (const msg of conv.messages) {
          if (msg.image && estimateDataUrlBytes(msg.image) > EXPORT_MAX_IMAGE_BYTES) {
            delete msg.image
            delete msg.imageW
            delete msg.imageH
            // 保留占位文本(与后端契约一致),让 AI 上下文仍知道"发过图片"
            if (!msg.text) msg.text = '[图片]'
            filteredImages++
          }
        }
        for (const entry of conv.contextHistory ?? []) {
          if (entry.image && estimateDataUrlBytes(entry.image) > EXPORT_MAX_IMAGE_BYTES) {
            delete entry.image
            if (!entry.text) entry.text = '[图片]'
            filteredImages++
          }
        }
      }
    }
  }

  const stats = countStats(exportableCardsCopy)

  /**
   * 群聊卡片级元数据(按卡片下标对齐)
   *
   * ⚠️ 群聊的 members / myRole / speakMode 是**卡片级**字段,子会话 JSON 里
   * 装不下它们。早期导出只写了 conversations,于是"群聊导出去再导回来"
   * 就变成一张单聊壳(成员丢失、群聊列表空)。这里为每张卡写一项,
   * 单聊卡写 null —— 下标必须与 cards/NN 严格对齐。
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

      // 提取图片消息的 dataURL → 独立文件
      // 仅提取 mime 在 MIME_TO_EXT 表内的格式;未知格式(avif/heic 等)
      // 保留原始 dataURL 内联,避免 re-import 时被降级为损坏的 octet-stream
      let hasImages = false
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
            hasImages = true
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
  return { zip, filteredImages, totalBytes }
}

/**
 * 生成 ZIP Blob（内存版：会同时持有整个压缩包）
 *
 * ⚠️ 大工程（30MB+）不要走这里 —— Android 上会因内存峰值闪退。
 * 分块导出走 saveZipExport()（流式生成 + 分块落盘）。
 */
export async function exportToZip(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Promise<{ blob: Blob; filteredImages: number; totalBytes: number }> {
  const { zip, filteredImages, totalBytes } = buildProjectZip(
    cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  // JSZip 3.10 的 generateAsync 为异步 API(内部同步流处理),不会阻塞主线程
  const blob = await zip.generateAsync({ type: 'blob' })
  return { blob, filteredImages, totalBytes }
}

/**
 * 打包环境(EXE/APK)的"另存为"能力探测。
 *
 * 返回可用的保存函数(用户选择位置后写入 base64),无则 null(浏览器环境):
 *   - Electron(EXE):window.nativeStorage.saveFileDialog(系统另存为对话框)
 *   - Capacitor(APK):SaveFile 原生插件(SAF ACTION_CREATE_DOCUMENT)
 */
export type SaveFileFn = (options: { fileName: string; base64: string })
  => Promise<{ canceled?: boolean; path?: string }>

/**
 * 是否处于**真正的**原生平台（android / ios）
 *
 * ⚠️ 这里必须用 `getPlatform()` 而不是 `isNativePlatform()` 的布尔结果去猜：
 * Capacitor 的 `registerPlugin()` 返回的是**万能代理** —— 对任何属性都返回一个函数，
 * 只有真正调用时才抛 `"X" plugin is not implemented on web`。
 * 于是 `typeof plugin.saveFile === 'function'` 在浏览器里**也成立**，
 * 会让我们误判"原生保存可用"，最终把 Capacitor 的
 * “SaveFile plugin is not implemented on web” 报给用户（实测就是这个 bug）。
 */
export async function getNativeSaveFile(): Promise<SaveFileFn | null> {
  const w = window as unknown as {
    nativeStorage?: { saveFileDialog?: SaveFileFn }
  }

  // Electron(EXE)
  if (typeof w.nativeStorage?.saveFileDialog === 'function') {
    return w.nativeStorage.saveFileDialog
  }

  // Capacitor(APK)
  //
  // ⚠ 官方版这里读的是 `Capacitor.Plugins?.SaveFile?.saveFile`，但在本工程使用的
  // @capacitor/core 8.x 下那个命名空间是空的 → 恒为 null。这里改用静态
  // registerPlugin('SaveFile') 拿到的**同一个句柄**（与 nativeExport 内的分块调用同源），
  // 这是本工程唯一能真正接上原生桥的取法。
  //
  // 行为保持与官方一致：拿不到就返回 null（由调用方走兜底/报错），**不抛错**。
  //
  // 平台守卫：浏览器（platform=web）直接返回 null → 走 <a download> 兜底，
  // 绝不把"Web 上未实现的插件"当成可用保存通道（这就是网页版导出报插件错的原因）。
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

/**
 * Blob → base64(打包环境 IPC/插件只传字符串,不传 Blob)
 *
 * 分片读取:逐 8MB 分片转 base64 后拼接,避免一次性读入整包导致
 * Android WebView 内存峰值(FileReader.readAsDataURL 一次性读整包)。
 */
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

/**
 * 按平台下载任意 Blob 文件(ZIP / JSON 共用):
 *   - Electron(EXE):弹系统"另存为"对话框
 *   - Capacitor(APK):SAF 原生保存插件
 *   - 浏览器:<a download> 直接下载
 */
export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  // 打包环境:弹系统"另存为"对话框,用户选择导出位置
  //
  // 2026-10-04 修复「大数据导出 0 字节」：改走 saveExportFileSmart ——
  // 小文件仍走 saveFile；大文件改为分块写入(桥层不会截断)+回读校验；
  // 内容为空则直接报错，绝不落一个空文件让用户以为数据丢了。
  const mime = blob.type || 'application/octet-stream'
  if (await getNativeSaveFile()) {
    const base64 = await blobToBase64(blob)
    await saveExportFileSmart({ fileName, base64, mime })
    return
  }

  // Capacitor 原生平台但未探测到 SaveFile 插件:明确报错,避免静默走
  // 浏览器 <a download>(Android WebView 中无效,表现"点击无反应")
  //
  // 2026-09-30：判定改用 isNativePlatformNoSave()（同步、不依赖 window.Capacitor 形状），
  // 并给出可执行的提示。这条守卫很重要 —— 它把"静默什么都没发生"
  // 变成"界面明确告诉你原因"。
  if (isNativePlatformNoSave()) {
    throw new Error(
      '导出功能初始化失败：未取得系统保存组件（SaveFile 插件未注册）。' +
      '请确认安装的是最新安装包，或改用「导出 JSON」。')
  }

  // 浏览器:沿用 <a download> 直接下载
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 下载 ZIP 文件(按平台:安装版弹系统保存框 / 浏览器直接下载) */
export async function downloadProject(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
  cardOrder?: string[] | null,
): Promise<{ filteredImages: number; totalBytes: number }> {
  const { blob, filteredImages, totalBytes } = await exportToZip(
    cards, myGender, stripVariantIndex, promptOverrides, settingsSnapshot, cardOrder,
  )
  const fileName = `BAKER-${timestamp()}${EXPORT_FILE_EXT}`
  await downloadBlob(blob, fileName)
  return { filteredImages, totalBytes }
}

// ---- ZIP 导入 ---------------------------------------------------------------

/** 导入包体积上限(超过则拒绝,避免一次性解压超大文件导致 OOM) */
export const IMPORT_MAX_BYTES = 200 * 1024 * 1024

/**
 * 从 ZIP Blob 解压并校验工程文件。
 *
 * 校验失败抛出 Error(调用方负责提示,不触碰现有数据)。
 * 图片路径引用还原为 dataURL,contextHistory 完整恢复。
 * 群聊卡片级字段(project.json 的 cards[])按下标还原;
 * 旧包没有该字段(本次修复之前导出)时,从对话内容反推群聊身份,
 * 认不出来的卡片也原样保留 —— 绝不因为识别失败丢用户数据。
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

  /**
   * 群聊卡片级元数据(新版导出会写;旧包没有这个字段 → undefined)
   *
   * 旧包(本次修复之前导出的 ZIP)里群聊字段整体缺失,那时只能靠
   * resolveCardGroupMeta 从对话内容反推群聊身份,尽量把群聊认回来。
   */
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
