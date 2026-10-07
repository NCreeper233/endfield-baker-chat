// =============================================================================
// 弹窗数据源与公共定义(popups)
// -----------------------------------------------------------------------------
// 服务端单一 JSON(notice.peilika.beer/notice.json)同时承载三类弹窗的数据,
// 取代原先只放公告的 notice.json:
//
//   { "title": 公告标题, "content": 公告正文,
//     "version": "2.1", "downloads": { "windows": "…", "android": "…" },
//     "alerts": [ { "id": "唯一ID", "title": "标题", "content": "正文" } ] }
//
//   1. 公告(notice) —— title + content,沿用「确定 / 不再提醒」两个按钮
//   2. 提醒(alerts) —— 数组,每条带唯一 id;玩家点确定后按 id 落库,不再重复显示
//   3. 更新(update) —— version 与当前版本比较,downloads 给出蓝奏云下载地址
//
// 三类弹窗统一按「公告 → 提醒 → 更新」排队依次显示,同一时刻只出现一个,
// 因此不会互相遮挡;队列推进见 composables/usePopups.ts。
// 更新弹窗仅在客户端(Windows / 安卓)弹出,网页端不弹。
// =============================================================================

/**
 * 弹窗数据源(经 Cloudflare 隧道托管到本机 /var/www/peilika-notice/)
 *
 * 注意新旧位置的分工:
 *   - notice.json      : 只有 title + content 的【纯公告】,位置不变,
 *                        供尚未支持本机制的旧版本客户端继续使用,格式永不改动
 *   - popup.json       : 含 version / downloads / alerts 的【完整数据】,
 *                        仅新版本客户端读取(本文件所指)
 * 两者中的公告内容由管理脚本同步维护,保证新老客户端看到一致的公告。
 */
export const POPUP_DATA_URL = 'https://notice.peilika.beer/popup.json'

/**
 * 当前应用版本
 *
 * 与 baker/VERSION 保持一致;发新版时同步修改此处,
 * 服务端 JSON 的 version 大于本值才会弹出更新提醒。
 *
 * 2026-09-28：3.0（与安卓包 versionName 3.0 对齐；正式版仍是 2.1）
 */
export const APP_VERSION = '3.0'

/** 单条提醒 */
export interface AlertItem {
  /** 唯一 ID:用于本地记录"已确认",同一条不再重复弹出 */
  id: string
  /** 标题 */
  title: string
  /** 正文(支持 \n 换行) */
  content: string
}

/** 下载地址(蓝奏云) */
export interface DownloadLinks {
  /** 电脑版安装包(exe) */
  windows?: string
  /** 手机版安装包(apk) */
  android?: string
}

/**
 * 服务端弹窗数据
 *
 * 所有字段均可选:只有 title/content 的旧格式依然可用(向后兼容)。
 */
export interface PopupData {
  /** 公告标题 */
  title?: string
  /** 公告正文 */
  content?: string
  /** 最新版本号(大于 APP_VERSION 时弹更新提醒) */
  version?: string
  /** 下载地址 */
  downloads?: DownloadLinks
  /** 提醒列表 */
  alerts?: AlertItem[]
}

/** 已确认提醒 ID 列表的 localStorage key */
export const ALERT_CONFIRMED_KEY = 'endfield-baker-settings-alert-confirmed'

/** 已忽略的更新版本号的 localStorage key */
export const UPDATE_IGNORED_VERSION_KEY = 'endfield-baker-settings-update-ignored-version'

/** 公告正文哈希 key(内容变化时重置"不再提醒") */
export const NOTICE_CONTENT_HASH_KEY = 'endfield-baker-settings-notice-content-hash'

/** 运行平台 */
import { getPlatform } from '../utils/platform'

export type RuntimePlatform = 'web' | 'android' | 'windows'

/**
 * 探测运行平台
 *
 * 与 utils/nativeStorage.ts 的探测方式保持一致:
 *   - Electron:主进程通过 preload 注入 window.nativeStorage
 *   - Capacitor:window.Capacitor.isNativePlatform() 为真(安卓 APK)
 *   - 其余视为网页端(网页端不弹更新弹窗)
 */
export function detectPlatform(): RuntimePlatform {
  if (typeof window === 'undefined') return 'web'
  // 调试开关:URL 携带 ?platform=android|windows 时按对应客户端处理,
  // 便于在浏览器中验证"仅客户端弹出"的更新弹窗。
  // 正常访问不带该参数,不影响真实平台判断。
  try {
    const forced = new URLSearchParams(window.location.search).get('platform')
    if (forced === 'android' || forced === 'windows') return forced
  } catch {
    // URL 解析失败:继续按真实平台判断
  }
  // 统一走 utils/platform；iOS 当前按 web 处理（不弹客户端更新弹窗）
  const p = getPlatform()
  if (p === 'electron') return 'windows'
  if (p === 'android') return 'android'
  return 'web'
}

/**
 * 比较版本号(按 . 分段,段数不同时缺位补 0)
 *
 * @returns a>b 返回正数;a<b 返回负数;相等返回 0
 */
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

/** 读取 localStorage 中的字符串数组(失败返回空数组) */
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

/** 写入 localStorage 中的字符串数组(失败静默:最多下次再弹一次) */
export function writeStringArray(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用:静默降级,不影响主流程
  }
}

/** 读取单值(失败返回空串) */
export function readString(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** 写入单值(失败静默) */
export function writeString(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用:静默降级
  }
}

/**
 * 归一化提醒列表:过滤掉缺 id 或缺正文的脏数据
 *
 * 服务端文件由人工编辑,容错后再进入渲染,避免脏数据导致弹窗空白。
 */
export function normalizeAlerts(raw: unknown): AlertItem[] {
  if (!Array.isArray(raw)) return []
  const out: AlertItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const id = typeof it.id === 'string' ? it.id.trim() : ''
    const content = typeof it.content === 'string' ? it.content.trim() : ''
    // id 与正文缺一不可:id 用于去重,正文用于展示
    if (!id || !content) continue
    const title = typeof it.title === 'string' && it.title.trim() ? it.title.trim() : '提醒'
    out.push({ id, title, content })
  }
  return out
}
