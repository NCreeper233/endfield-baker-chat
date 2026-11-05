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
//
// 【2026-10-04 数据保护】损坏检测 + .bak 一代备份 + 拒绝覆盖损坏文件:
//   之前"读失败→空缓存→整文件覆盖"会把手机里的聊天记录整份抹掉(偶发)。
// =============================================================================

import { isElectron, isNative } from './platform'

/** 统一文件读写接口(由 Electron preload / Capacitor 各自提供) */
export interface NativeFileBridge {
  /**
   * 分块写整文件（大数据量用）
   *
   * 工程数据到 30MB+ 时，一次性把整串内容过桥会让手机 WebView/Java 侧
   * 内存峰值过高而闪退；分块写把峰值压到单块大小（2026-09-28 修复导出闪退）。
   */
  writeFileChunked?: (path: string, content: string) => Promise<void>
  /** 读取文本文件,不存在/失败返回 null */
  readFile: (path: string) => Promise<string | null>
  /**
   * 文件是否存在（可选）
   *
   * 【2026-10-04 数据安全】没有它就无法区分「文件不存在」(首次使用,可以写)
   * 与「读失败」(文件可能还在,绝不能当空库覆盖)。Capacitor 端用 Filesystem.stat 实现;
   * Electron 端没实现时退化为 .bak 启发式判断。
   */
  exists?: (path: string) => Promise<boolean>
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

  // 统一走 utils/platform，避免各处自写判定走散
  if (isElectron()) {
    cachedBridge = (window as unknown as { nativeStorage: NativeFileBridge }).nativeStorage
    return cachedBridge
  }

  // Capacitor（Android / iOS）
  if (isNative()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      cachedBridge = {
        exists: async (path) => {
          try {
            await Filesystem.stat({ path, directory: Directory.Data })
            return true
          } catch {
            return false
          }
        },
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
        // 分块写：先写 .tmp 再 rename（原子替换）。
        //
        // 为什么必须原子：安卓被系统回收/用户强杀时，分块写到一半会留下
        // 半截 JSON；旧文件已被覆盖 → 重启后整库判损坏 → 聊天记录消失。
        // 改成写 .tmp 后，最坏情况只是丢掉本次改动，原文件完好。
        //
        // 单块 128KB：Java 桥每次要收一个 JS 字符串并转 UTF-8，
        // 块越小峰值越低（大数据集自动保存闪退的根因之一）。
        writeFileChunked: async (path, content) => {
          const CHUNK = 128 * 1024
          const tmp = path + '.tmp'

          // 小文件：同样走 tmp + rename，保证原子
          if (content.length <= CHUNK) {
            await Filesystem.writeFile({
              path: tmp, data: content, directory: Directory.Data,
              encoding: Encoding.UTF8, recursive: true,
            })
            await Filesystem.rename({
              from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data,
            })
            return
          }

          await Filesystem.writeFile({
            path: tmp, data: content.slice(0, CHUNK), directory: Directory.Data,
            encoding: Encoding.UTF8, recursive: true,
          })
          for (let i = CHUNK; i < content.length; i += CHUNK) {
            let end = Math.min(i + CHUNK, content.length)
            // 不要把 UTF-16 代理对劈成两半（emoji / 生僻字）
            const last = content.charCodeAt(end - 1)
            if (end < content.length && last >= 0xd800 && last <= 0xdbff) end -= 1
            await Filesystem.appendFile({
              path: tmp, data: content.slice(i, end), directory: Directory.Data,
              encoding: Encoding.UTF8,
            })
            i = end - CHUNK   // 补偿被回退的那一个字符（循环再 +CHUNK）
          }
          await Filesystem.rename({
            from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data,
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
 *
 * 防竞态:写入串行化(writeChain),避免并发 put 时整文件覆盖互相
 * 覆盖丢失数据(大历史导入/导出 + 聊天自动保存同时发生时尤为关键)。
 */
export function createNativeStore(bridge: NativeFileBridge) {
  let cache: Record<string, unknown> | null = null
  // 写入串行链:前一个 put 完成后才执行下一个,防止并发覆盖丢数据
  let writeChain: Promise<void> = Promise.resolve()

  // ---- 数据保护(2026-10-04) -------------------------------------------------
  // 历史 bug:主文件读失败/JSON 解析失败时这里会把 cache 置成 {},而下一次 put
  // 就拿这个空对象**整文件覆盖** —— 手机被系统杀掉时正好在分块写中间的话,
  // 文件会留下半截 JSON,重启后就是这样把整份聊天记录抹掉的。
  // 现在:① 解析失败先尝试从 .bak 恢复;② 两个都坏则标记 corrupt 并**拒绝写入**,
  //       绝不覆盖,给用户留出手工/工具抢救的机会;③ 每次写前留一代备份。
  const BAK_FILE = NATIVE_DATA_FILE + '.bak'
  const BAK_MIN_INTERVAL_MS = 5 * 60 * 1000
  let loadedStatus: 'ok' | 'empty' | 'recovered' | 'corrupt' | 'unreadable' = 'empty'
  let lastGoodText: string | null = null
  let lastBakAt = 0

  function parseOrNull(text: string | null): Record<string, unknown> | null {
    if (!text || !text.trim()) return null
    try {
      const v: unknown = JSON.parse(text)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  // 单飞：冷启动时 useChatPersistence 会**并发**发起 7 个 get()，
  // 没有它就会并发读 7 次整文件（30MB 库在低端机上直接 OOM，
  // 而 readFile 的 catch 会把 OOM 吞成 null → 被判成"没有数据" → 整库被覆盖）。
  let loading: Promise<Record<string, unknown>> | null = null

  function loadCache(): Promise<Record<string, unknown>> {
    if (cache !== null) return Promise.resolve(cache)
    if (loading) return loading
    loading = loadCacheOnce().finally(() => { loading = null })
    return loading
  }

  async function loadCacheOnce(): Promise<Record<string, unknown>> {
    const text = await bridge.readFile(NATIVE_DATA_FILE)

    const main = parseOrNull(text)
    if (main) {
      cache = main
      loadedStatus = 'ok'
      lastGoodText = text
      return cache
    }

    // 主文件缺失 / 空 / 损坏 → 尝试备份
    const bak = await bridge.readFile(BAK_FILE)
    const fromBak = parseOrNull(bak)
    if (fromBak) {
      cache = fromBak
      loadedStatus = 'recovered'
      lastGoodText = bak
      // 立刻用备份把主文件修复回去(失败不影响本次使用)
      void bridge.writeFile(NATIVE_DATA_FILE, bak as string).catch(() => {})
      return cache
    }

    cache = {}
    // 主文件"有内容但解析不了" = 损坏 → 拒绝后续写入
    if (text && text.trim()) {
      loadedStatus = 'corrupt'
      return cache
    }
    // 读出来是 null/空：可能是"真的没有文件"(首次使用)，也可能是"读失败"(文件还在)。
    // 能 stat 就 stat；不能 stat 时：有 .bak/其它证据说明数据曾存在过 → 按读失败处理，
    // **绝不当空库写入**，避免把用户数据覆盖掉。
    if (bridge.exists) {
      const present = await bridge.exists(NATIVE_DATA_FILE).catch(() => false)
      if (present) {
        loadedStatus = 'unreadable'
        return cache
      }
    } else if (bak !== null) {
      loadedStatus = 'unreadable'
      return cache
    }
    loadedStatus = 'empty'
    return cache
  }

  return {
    async get(key: string): Promise<unknown> {
      const obj = await loadCache()
      return obj[key]
    },
    /** 数据文件是否不可安全写入(损坏/读不出来时 put 会拒绝,避免覆盖用户数据) */
    isCorrupt(): boolean {
      return loadedStatus === 'corrupt' || loadedStatus === 'unreadable'
    },
    /** 载入状态，供 UI 显示"已暂停保存"提示 */
    loadStatus(): string {
      return loadedStatus
    },
    put(key: string, value: unknown): Promise<void> {
      // 串行化:每个 put 排队执行,避免并发写覆盖
      const task = writeChain.then(async () => {
        const obj = await loadCache()
        if (loadedStatus === 'corrupt' || loadedStatus === 'unreadable') {
          throw new Error(
            loadedStatus === 'corrupt'
              ? `本地数据文件已损坏(${NATIVE_DATA_FILE}),已拒绝写入以免覆盖:请先备份/导出该文件再重试`
              : `本地数据文件读取失败(${NATIVE_DATA_FILE}),已暂停保存以免覆盖现有数据:请重启应用或导出备份`,
          )
        }
        obj[key] = value
        const text = JSON.stringify(obj)
        // 写前留一代备份(限频,避免每次保存都双倍写入)
        if (lastGoodText && Date.now() - lastBakAt > BAK_MIN_INTERVAL_MS) {
          try {
            await bridge.writeFile(BAK_FILE, lastGoodText)
            lastBakAt = Date.now()
          } catch {
            /* 备份失败不影响主写入 */
          }
        }
        // 大工程用分块写：一次性整串过桥是历史闪退点
        if (text.length > 512 * 1024 && bridge.writeFileChunked) {
          await bridge.writeFileChunked(NATIVE_DATA_FILE, text)
        } else {
          // Electron 的 write-file 会带**回读校验**并返回布尔；返回 false 代表没落盘
          // （磁盘满/被占用/回读不一致）。以前这里丢弃返回值 → 界面正常、重启回旧数据。
          const wrote = await (bridge.writeFile as unknown as
            (p: string, c: string) => Promise<boolean | void>)(NATIVE_DATA_FILE, text)
          if (wrote === false) {
            throw new Error('本地数据写入未通过回读校验（磁盘空间/权限异常），本次修改没有保存')
          }
        }
        lastGoodText = text
        loadedStatus = 'ok'
      })
      // 链上追加(失败也不阻塞后续任务)
      writeChain = task.catch(() => {})
      return task
    },
  }
}
