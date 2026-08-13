// =============================================================================
// ZIP 工程导入导出(zipExport)
// -----------------------------------------------------------------------------
// 职责:
//   - exportToZip: 卡片树 + 全局设置 → ZIP 压缩包(文本 JSON + 独立图片文件)
//   - importFromZip: ZIP → 校验 → ProjectPayload(含卡片树、提示词覆盖、系统提示词)
//   - 类型守卫 + 白名单净化(导出给 useChatPersistence 的 IndexedDB 恢复复用)
//
// ZIP 结构:
//   project.json                          元数据(version/myGender/stripVariantIndex/stats)
//   cards/XX/conversations/YY-name.json   每段对话(messages + contextHistory)
//   cards/XX/images/YY-ZZZ.ext            图片消息(从 dataURL 提取为独立二进制文件)
//   prompts/world-setting.txt            世界设定(仅自定义时存在)
//   prompts/characters/角色名.txt          角色提示词覆盖(仅自定义时存在)
//
// 设计原则:
//   - ZIP 内全部是可读文本(JSON/TXT) + 二进制图片,用户可直接解压编辑
//   - 图片从 dataURL 提取为独立文件,JSON 中只存 ZIP 内路径引用
//   - contextHistory 与 messages 并列存储,AI 上下文完整保留
//   - 仅导出自定义提示词覆盖,内置默认提示词不导出
//   - 仅导出有消息或有 AI 记忆的对话;两者皆空的对话/卡片不导出
//   - 未知图片格式(avif/heic 等)保留 dataURL 内联,不做降级提取
// =============================================================================

import JSZip from 'jszip'
import { CHAT_IMAGE } from '../constants/design'
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
  /** 自定义世界观设定;未自定义时为 undefined */
  worldSetting?: string
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
  if (m.speakerAvatar !== undefined) {
    out.speakerAvatar = m.speakerAvatar
  }
  return out
}

function sanitizeConversation(c: Conversation): Conversation {
  const out: Conversation = { name: c.name, messages: c.messages.map(sanitizeChatMessage) }
  if (c.contextHistory !== undefined) {
    out.contextHistory = c.contextHistory.map((e) => {
      const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: e.side, text: e.text }
      if (e.image !== undefined) entry.image = e.image
      return entry
    })
  }
  return out
}

export function sanitizeCards(cards: Card[]): Card[] {
  return cards.map((c) => ({
    conversations: c.conversations.map(sanitizeConversation),
  }))
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

/** 二进制 → dataURL */
function binaryToDataURL(data: Uint8Array, ext: string): string {
  const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream'
  // Uint8Array → base64
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  const base64 = btoa(binary)
  return `data:${mime};base64,${base64}`
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

/**
 * 序列化卡片树 + 全局设置 + 自定义提示词为 ZIP Blob。
 *
 * 图片从 dataURL 提取为独立二进制文件,JSON 中只存 ZIP 内路径引用;
 * 未知格式(avif/heic 等)保留 dataURL 内联,不做降级提取。
 * 仅导出自定义提示词覆盖和自定义世界观设定,内置默认不导出。
 * 仅导出有消息或有 AI 记忆的对话;两者皆空时抛错,不生成空包。
 */
export async function exportToZip(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  worldSetting: string,
  defaultWorldSetting: string,
): Promise<Blob> {
  const zip = new JSZip()

  // 仅导出有消息或有 AI 记忆(contextHistory)的对话;
  // 两者皆空的对话与整卡一并跳过
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

  const stats = countStats(exportableCards)

  // 1. project.json — 元数据
  const projectMeta = {
    version: PROJECT_VERSION,
    myGender,
    stripVariantIndex,
    exportedAt: new Date().toISOString(),
    stats,
  }
  zip.file('project.json', JSON.stringify(projectMeta, null, 2))

  // 2. cards/ — 每张卡片的对话 JSON + 图片文件
  exportableCards.forEach((card, cardIdx) => {
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
  const hasCustomWorldSetting = worldSetting && worldSetting !== defaultWorldSetting

  if (hasOverrides) {
    for (const [name, prompt] of Object.entries(promptOverrides)) {
      if (prompt) {
        const fileName = sanitizeFileName(name)
        zip.file(`prompts/characters/${fileName}.txt`, prompt)
      }
    }
  }

  if (hasCustomWorldSetting) {
    zip.file('prompts/world-setting.txt', worldSetting)
  }

  // 4. 生成 ZIP Blob
  return zip.generateAsync({ type: 'blob' })
}

/** 下载 ZIP 文件 */
export async function downloadProject(
  cards: Card[],
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  worldSetting: string,
  defaultWorldSetting: string,
): Promise<void> {
  const blob = await exportToZip(cards, myGender, stripVariantIndex, promptOverrides, worldSetting, defaultWorldSetting)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `BAKER-${timestamp()}${EXPORT_FILE_EXT}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ---- ZIP 导入 ---------------------------------------------------------------

/**
 * 从 ZIP Blob 解压并校验工程文件。
 *
 * 校验失败抛出 Error(调用方负责提示,不触碰现有数据)。
 * 图片路径引用还原为 dataURL,contextHistory 完整恢复。
 */
export async function importFromZip(blob: Blob): Promise<ProjectPayload> {
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

    cards.push({ conversations })
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

  // 4. 读取自定义世界观设定(如果存在)
  let worldSetting: string | undefined
  const worldSettingFile = zip.file('prompts/world-setting.txt')
  if (worldSettingFile) {
    worldSetting = await worldSettingFile.async('string')
    if (!worldSetting) worldSetting = undefined
  }

  // 5. 白名单净化后返回
  return {
    version: PROJECT_VERSION,
    cards: sanitizeCards(cards),
    myGender,
    stripVariantIndex,
    promptOverrides,
    worldSetting,
  }
}
