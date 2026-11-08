// platform —— 运行平台的唯一判定来源
// 不能靠「插件方法是不是函数」推断可用性：Capacitor 的插件代理对任何属性都返回函数，
// 调用时才抛 not implemented —— 网页版导出曾因此报 SaveFile 错误。

/** 归一化后的运行环境 */
export type Platform = 'android' | 'ios' | 'electron' | 'web'

/** 优先用 Capacitor 官方 getPlatform()（web 下返回 'web'），取不到再查原生注入的 bridge */
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

/** 主进程经 preload 注入 window.nativeStorage；浏览器与 Capacitor 都没有 */
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

export function isElectron(): boolean {
  return getPlatform() === 'electron'
}
