// nativeStorage —— 打包环境的文件存储桥接
// 网页端走 IndexedDB；打包端把所有键存进同一个 JSON 文件，读写都是整文件序列化。
// ⚠️ 「读失败 → 空缓存 → 整文件覆盖」曾把手机里的聊天记录整份抹掉，
// 故有损坏检测 + .bak 一代备份 + 拒绝覆盖损坏文件。

import { isElectron, isNative } from './platform'

/** 由 Electron preload / Capacitor 各自提供 */
export interface NativeFileBridge {
  /** 分块写整文件：一次性把 30MB+ 过桥会让手机内存峰值过高而闪退 */
  writeFileChunked?: (path: string, content: string) => Promise<void>
  /** 不存在 / 失败返回 null */
  readFile: (path: string) => Promise<string | null>
  /**
   * 没有它就无法区分「文件不存在」（首次使用，可以写）与「读失败」（可能还在，
   * 绝不能当空库覆盖）。Electron 未实现时退化为 .bak 启发式判断。
   */
  exists?: (path: string) => Promise<boolean>
  /** 覆盖写入，失败抛出 */
  writeFile: (path: string, content: string) => Promise<void>
}

/** 存于应用数据目录 */
export const NATIVE_DATA_FILE = 'endfield-baker-data.json'

/** undefined = 尚未探测；null = 网页端 */
let cachedBridge: NativeFileBridge | null | undefined

/** Electron 的 preload 注入优先，其次 Capacitor Filesystem；都不是返回 null 由调用方回退 IndexedDB */
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
        // 分块写：先写 .tmp 再 rename（原子替换）。安卓被强杀时分块写到一半会留下
        // 半截 JSON，若直接覆盖主文件，重启后整库判损坏。单块 128KB：Java 桥每次要把
        // JS 字符串转 UTF-8，块越小峰值越低。
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
 * 所有键存同一个 JSON 文件；写入经 writeChain 串行化，避免并发 put 互相覆盖
 * （大历史导入导出与聊天自动保存同时发生时尤为关键）。
 *
 * 2026-11-09（真机排查）：以前每个 key 的 put 都**各写一遍整文件**，一次保存要写
 * 8 个 key = 8 次 `JSON.stringify(整库)` + 8 次整文件落盘；而且内容没变也照写
 * （实测空闲时每秒还在重写同样的字节）。现在：
 *   · 合并窗口：同一轮里的多个 put 合起来只写一次
 *   · 内容指纹：序列化结果与上次成功写入完全一样 → 直接跳过，不落盘
 * 落盘内容、时机语义（写后回读校验 / 备份 / 损坏拒写）都不变。
 */
export function createNativeStore(bridge: NativeFileBridge) {
  let cache: Record<string, unknown> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  /** 合并窗口：一次保存会连着 put 多个 key，窗口内的写入合并成一次 */
  const COALESCE_MS = 50

  interface PendingPut {
    key: string
    value: unknown
    resolve: () => void
    reject: (err: unknown) => void
  }

  /** 等落盘的写入（按提交顺序） */
  let pendingPuts: PendingPut[] = []
  /** 合并窗口的定时器（null = 没有排队的写入） */
  let coalesceTimer: number | null = null

  // 数据保护：主文件解析失败先从 .bak 恢复；两个都坏则标记 corrupt 并拒绝写入，
  // 给用户留出抢救机会；每次写前留一代备份。
  const BAK_FILE = NATIVE_DATA_FILE + '.bak'
  const BAK_MIN_INTERVAL_MS = 5 * 60 * 1000
  let loadedStatus: 'ok' | 'empty' | 'recovered' | 'corrupt' | 'unreadable' = 'empty'
  let lastGoodText: string | null = null
  let lastBakAt = 0

  /**
   * 最后写进每个文件的字节（按路径）。
   *
   * 兜底去重：不管从哪条路进来，只要内容和上次写进这个文件的完全一样就直接跳过。
   * 真机实测会有一条"内容不变还在写"的路径（合并窗口之外），这里从最底层堵住它，
   * 代价只是每个文件多留一份字符串引用（写的是刚序列化出来的同一份，不额外拷贝）。
   */
  const lastWrittenByPath = new Map<string, string>()

  /** 带去重的写文件：内容没变就不落盘，返回 true 表示"已经是这个内容了" */
  const dedupWriteFile = async (path: string, content: string): Promise<boolean | void> => {
    if (lastWrittenByPath.get(path) === content) return true
    const wrote = await (bridge.writeFile as unknown as
      (p: string, c: string) => Promise<boolean | void>)(path, content)
    if (wrote !== false) lastWrittenByPath.set(path, content)
    return wrote
  }

  function parseOrNull(text: string | null): Record<string, unknown> | null {
    if (!text || !text.trim()) return null
    try {
      const v: unknown = JSON.parse(text)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  // 单飞：冷启动时 useChatPersistence 会并发发起 7 个 get()，否则会并发读 7 次整文件
  // （30MB 库在低端机上直接 OOM，而 readFile 的 catch 会把 OOM 吞成 null → 整库被覆盖）。
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
      // 记下磁盘上的内容：接下去写"一模一样的字节"时直接跳过
      if (text) lastWrittenByPath.set(NATIVE_DATA_FILE, text)
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
      void dedupWriteFile(NATIVE_DATA_FILE, bak as string).catch(() => {})
      return cache
    }

    cache = {}
    // 主文件"有内容但解析不了" = 损坏 → 拒绝后续写入
    if (text && text.trim()) {
      loadedStatus = 'corrupt'
      return cache
    }
    // 读出来是 null/空：可能是真的没有文件，也可能是读失败（文件还在）。
    // 有 .bak 或 stat 得到文件时就按读失败处理，绝不当空库写入。
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

  /**
   * 把等落盘的写入合并成一次：应用所有脏 key → 序列化一次 → 写盘一次。
   * 与 writeChain 串行，多个批次按顺序执行，互不覆盖。
   */
  function flushPendingPuts(): Promise<void> {
    if (coalesceTimer !== null) {
      window.clearTimeout(coalesceTimer)
      coalesceTimer = null
    }
    if (pendingPuts.length === 0) return Promise.resolve()
    const batch = pendingPuts
    pendingPuts = []

    const task = writeChain.then(async () => {
      try {
        const obj = await loadCache()
        if (loadedStatus === 'corrupt' || loadedStatus === 'unreadable') {
          throw new Error(
            loadedStatus === 'corrupt'
              ? `本地数据文件已损坏(${NATIVE_DATA_FILE}),已拒绝写入以免覆盖:请先备份/导出该文件再重试`
              : `本地数据文件读取失败(${NATIVE_DATA_FILE}),已暂停保存以免覆盖现有数据:请重启应用或导出备份`,
          )
        }
        for (const p of batch) obj[p.key] = p.value
        const text = JSON.stringify(obj)

        // 内容指纹：和上次成功写入的完全一样 → 不写盘。
        // 真机实测：watcher 空转时每秒都会走到这里，以前每次都重写同样的字节。
        if (text === lastGoodText) {
          for (const p of batch) p.resolve()
          return
        }

        // 写前留一代备份(限频,避免每次保存都双倍写入)
        if (lastGoodText && Date.now() - lastBakAt > BAK_MIN_INTERVAL_MS) {
          try {
            await dedupWriteFile(BAK_FILE, lastGoodText)
            lastBakAt = Date.now()
          } catch {
            /* 备份失败不影响主写入 */
          }
        }
        // 大工程用分块写：一次性整串过桥是历史闪退点
        if (text.length > 512 * 1024 && bridge.writeFileChunked) {
          await bridge.writeFileChunked(NATIVE_DATA_FILE, text)
          lastWrittenByPath.set(NATIVE_DATA_FILE, text)
        } else {
          // Electron 的 write-file 会带**回读校验**并返回布尔；返回 false 代表没落盘
          // （磁盘满/被占用/回读不一致）。以前这里丢弃返回值 → 界面正常、重启回旧数据。
          const wrote = await dedupWriteFile(NATIVE_DATA_FILE, text)
          if (wrote === false) {
            throw new Error('本地数据写入未通过回读校验（磁盘空间/权限异常），本次修改没有保存')
          }
        }
        lastGoodText = text
        loadedStatus = 'ok'
        for (const p of batch) p.resolve()
      } catch (err) {
        // 一个批次失败 → 本批次的所有写入都失败（调用方据此提示"没保存成功"）
        for (const p of batch) p.reject(err)
        throw err
      }
    })
    // 链上追加(失败也不阻塞后续任务)，调用方各自拿到自己的结果
    writeChain = task.catch(() => {})
    return task.catch(() => {})
  }

  /** 排一次合并窗口（已经排了就不重复排） */
  function scheduleCoalesce(): void {
    if (coalesceTimer !== null) return
    coalesceTimer = window.setTimeout(() => {
      coalesceTimer = null
      void flushPendingPuts()
    }, COALESCE_MS)
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
    /**
     * 写一个键。
     *
     * 不再"每个键写一次整文件"：先进待写队列，50ms 合并窗口内一起序列化、一次落盘。
     * 返回的 Promise 在**真正写盘（或确认内容没变）之后**才 settle，调用方语义不变。
     */
    put(key: string, value: unknown): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        // 缓存已就绪时立刻反映到内存：写盘前再 get 同一个键也能读到新值
        if (cache !== null) cache[key] = value
        pendingPuts.push({ key, value, resolve, reject })
        scheduleCoalesce()
      })
    },
    /** 立刻把合并窗口里的写入落盘（切后台 / 关窗 / 导入导出后调用） */
    flushNow(): Promise<void> {
      return flushPendingPuts()
    },
  }
}
