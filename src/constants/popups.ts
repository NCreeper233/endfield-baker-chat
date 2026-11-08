// popups —— 弹窗数据源与公共定义（公告 / 提醒 / 更新）
// 三类弹窗按此顺序排队、同一时刻只出现一个；更新弹窗仅在客户端弹，网页端不弹。

/**
 * 新版本客户端读这个完整数据源；老客户端仍读 notice.json（仅 title + content，
 * 格式永不变动），两者由管理脚本同步，保证新老客户端看到一致的公告。
 */
export const POPUP_DATA_URL = 'https://notice.peilika.beer/popup.json'

/** 服务端 version 大于本值才提示更新；发版时同步修改 */
export const APP_VERSION = '3.1'

export interface AlertItem {
  /** 用于记录「已确认」，同一条不再重复弹出 */
  id: string
  title: string
  /** 支持 \n 换行 */
  content: string
}

export interface DownloadLinks {
  windows?: string
  android?: string
}

/** 所有字段均可选：只有 title / content 的旧格式依然可用 */
export interface PopupData {
  title?: string
  content?: string
  version?: string
  downloads?: DownloadLinks
  alerts?: AlertItem[]
}

/** 已确认提醒 ID 列表 */
export const ALERT_CONFIRMED_KEY = 'endfield-baker-settings-alert-confirmed'

/** 已忽略的更新版本号 */
export const UPDATE_IGNORED_VERSION_KEY = 'endfield-baker-settings-update-ignored-version'

/** 公告正文哈希：内容变化时重置「不再提醒」 */
export const NOTICE_CONTENT_HASH_KEY = 'endfield-baker-settings-notice-content-hash'

import { getPlatform } from '../utils/platform'

export type RuntimePlatform = 'web' | 'android' | 'windows'

/** 平台判定与 nativeStorage 一致；?platform=android|windows 可在浏览器里验证客户端弹窗 */
export function detectPlatform(): RuntimePlatform {
  if (typeof window === 'undefined') return 'web'
  try {
    const forced = new URLSearchParams(window.location.search).get('platform')
    if (forced === 'android' || forced === 'windows') return forced
  } catch {
    // URL 解析失败：按真实平台判断
  }
  // iOS 当前按 web 处理
  const p = getPlatform()
  if (p === 'electron') return 'windows'
  if (p === 'android') return 'android'
  return 'web'
}

/** 按 . 分段比较，缺位补 0；a > b 返回正数 */
export function compareVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((s) => parseInt(s, 10) || 0)
  const pb = String(b).split('.').map((s) => parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export function readStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 写入失败静默：最多下次再弹一次 */
export function writeStringArray(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用
  }
}

export function readString(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeString(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用
  }
}

/** 过滤缺 id 或缺正文的条目：服务端 JSON 由人工编辑，脏数据会让弹窗空白 */
export function normalizeAlerts(raw: unknown): AlertItem[] {
  if (!Array.isArray(raw)) return []
  const out: AlertItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const id = typeof it.id === 'string' ? it.id.trim() : ''
    const content = typeof it.content === 'string' ? it.content.trim() : ''
    if (!id || !content) continue
    const title = typeof it.title === 'string' && it.title.trim() ? it.title.trim() : '提醒'
    out.push({ id, title, content })
  }
  return out
}
