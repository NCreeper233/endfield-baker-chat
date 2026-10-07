// =============================================================================
// platform.ts —— 运行平台的**唯一判定来源**
// -----------------------------------------------------------------------------
// 为什么必须收敛到一处：
//   项目早期在 5 个文件里各写了一份"是不是原生平台"的判断，用的都是
//   `Capacitor.isNativePlatform()`。这个判据表面上没问题，实际有两个坑：
//
//   1. **Capacitor 的插件代理是"万能假函数"**：`registerPlugin('X')` 返回的代理
//      对任何属性都返回一个函数，只有**调用时**才抛
//      `"X" plugin is not implemented on web`。
//      所以不能用"某个方法是不是函数"来推断插件可用 —— 必须先判平台。
//      （网页版导出曾因此报出 SaveFile 插件未实现的错误。）
//   2. **判定语义要显式**：区分 android / ios / web / electron 四种环境时，
//      一个 boolean 不够用；iOS 与 Android 的某些行为（如返回键、分享）也不同。
//
// 因此这里提供唯一入口，其余模块一律从这里取。
// =============================================================================

/** 归一化后的运行环境 */
export type Platform = 'android' | 'ios' | 'electron' | 'web'

/**
 * 读取 Capacitor 的平台标识
 *
 * 优先用 `getPlatform()`（Capacitor 官方 API，web 下返回 'web'）；
 * 取不到时退回检查原生注入的 bridge 特征。
 */
function capacitorPlatform(): string {
  try {
    const cap = (globalThis as unknown as {
      Capacitor?: { getPlatform?: () => string }
    }).Capacitor
    if (typeof cap?.getPlatform === 'function') return String(cap.getPlatform() || 'web')
  } catch {
    // 忽略：按 web 处理
  }
  try {
    const w = globalThis as unknown as {
      androidBridge?: unknown
      webkit?: { messageHandlers?: { bridge?: unknown } }
    }
    if (w.androidBridge) return 'android'
    if (w.webkit?.messageHandlers?.bridge) return 'ios'
  } catch {
    // 忽略
  }
  return 'web'
}

/**
 * Electron(EXE) 判定
 *
 * 主进程通过 preload 的 contextBridge 把 `window.nativeStorage` 注入渲染进程；
 * 浏览器与 Capacitor 环境都不会有它。
 */
function hasElectronBridge(): boolean {
  try {
    const ns = (globalThis as unknown as { nativeStorage?: unknown }).nativeStorage
    return !!ns && typeof ns === 'object'
  } catch {
    return false
  }
}

/** 当前运行平台（每次读取都重新判定，便于测试与 URL 覆盖） */
export function getPlatform(): Platform {
  // Electron 优先：它的 getPlatform() 也是 'web'，只能靠注入的桥识别
  if (hasElectronBridge()) return 'electron'
  const p = capacitorPlatform()
  if (p === 'android') return 'android'
  if (p === 'ios') return 'ios'
  return 'web'
}

/** 是否为真原生（Android / iOS）—— 需要原生插件能力时用它把关 */
export function isNative(): boolean {
  const p = getPlatform()
  return p === 'android' || p === 'ios'
}

export function isAndroid(): boolean {
  return getPlatform() === 'android'
}

export function isIOS(): boolean {
  return getPlatform() === 'ios'
}

export function isElectron(): boolean {
  return getPlatform() === 'electron'
}

/**
 * 是否为纯浏览器（网页版）
 *
 * 注意：网页版**可能跑在手机浏览器上**（Android Chrome / iOS Safari），
 * 所以这里只表示"没有原生壳"，不代表是桌面浏览器。
 */
export function isWeb(): boolean {
  return getPlatform() === 'web'
}

/**
 * 是否为触屏/窄屏运行环境（用于布局，不代表平台）
 *
 * 与平台解耦：手机浏览器也是触屏，桌面浏览器也可能窄窗口。
 */
export function isTouchLike(): boolean {
  try {
    return typeof window !== 'undefined'
      && (('ontouchstart' in window) || (navigator?.maxTouchPoints ?? 0) > 0)
  } catch {
    return false
  }
}
