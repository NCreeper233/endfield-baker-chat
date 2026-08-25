// =============================================================================
// 打包环境文件存储桥接(nativeStorage)
// -----------------------------------------------------------------------------
// 网页端(浏览器)沿用 IndexedDB(见 useChatPersistence)。
// 打包端(EXE/APK WebView)改用本地 JSON 文件持久化:
//   - Electron(EXE):preload 通过 contextBridge 暴露 window.nativeStorage
//   - Capacitor(APK):@capacitor/filesystem 插件(应用数据目录)
//
// 统一抽象为一个"键值文件仓库":所有键存进同一个 JSON 文件
// endfield-baker-data.json,读写都是整文件序列化,失败静默降级。
// =============================================================================

/** 统一文件读写接口(由 Electron preload / Capacitor 各自提供) */
export interface NativeFileBridge {
  /** 读取文本文件,不存在/失败返回 null */
  readFile: (path: string) => Promise<string | null>
  /** 写入文本文件(覆盖),失败抛出 */
  writeFile: (path: string, content: string) => Promise<void>
}

/** 持久化 JSON 文件名(存于应用数据目录) */
export const NATIVE_DATA_FILE = 'endfield-baker-data.json'

/** 模块级缓存:null=未检测 / undefined=尚未检测 / bridge=可用 */
let cachedBridge: NativeFileBridge | null | undefined

/**
 * 获取打包环境的文件读写桥。
 *
 * 依次探测:
 *   1. Electron 的 window.nativeStorage(preload 注入)
 *   2. Capacitor 的 @capacitor/filesystem(原生平台)
 * 都不是则返回 null(网页端,由调用方回退 IndexedDB)。
 */
export async function getNativeFileBridge(): Promise<NativeFileBridge | null> {
  if (cachedBridge !== undefined) return cachedBridge

  const w = window as unknown as {
    nativeStorage?: NativeFileBridge
    Capacitor?: { isNativePlatform?: () => boolean }
  }

  // Electron
  if (w.nativeStorage) {
    cachedBridge = w.nativeStorage
    return cachedBridge
  }

  // Capacitor
  const cap = w.Capacitor
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      cachedBridge = {
        readFile: async (path) => {
          try {
            const r = await Filesystem.readFile({
              path,
              directory: Directory.Data,
              encoding: Encoding.UTF8,
            })
            return typeof r.data === 'string' ? r.data : null
          } catch {
            return null
          }
        },
        writeFile: async (path, content) => {
          await Filesystem.writeFile({
            path,
            data: content,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
            recursive: true,
          })
        },
      }
      return cachedBridge
    } catch {
      // @capacitor/filesystem 未安装或不可用:回退 null
    }
  }

  cachedBridge = null
  return cachedBridge
}

/**
 * 打包环境的键值文件仓库。
 *
 * 所有键保存在同一个 JSON 文件里,读写前先整文件读取到内存缓存,
 * 写时整文件序列化落盘。JSON 解析/写入失败静默降级(不阻塞主流程)。
 */
export function createNativeStore(bridge: NativeFileBridge) {
  let cache: Record<string, unknown> | null = null

  async function loadCache(): Promise<Record<string, unknown>> {
    if (cache !== null) return cache
    const text = await bridge.readFile(NATIVE_DATA_FILE)
    if (!text) {
      cache = {}
      return cache
    }
    try {
      cache = JSON.parse(text) as Record<string, unknown>
    } catch {
      cache = {}
    }
    return cache
  }

  return {
    async get(key: string): Promise<unknown> {
      const obj = await loadCache()
      return obj[key]
    },
    async put(key: string, value: unknown): Promise<void> {
      const obj = await loadCache()
      obj[key] = value
      await bridge.writeFile(NATIVE_DATA_FILE, JSON.stringify(obj))
    },
  }
}
