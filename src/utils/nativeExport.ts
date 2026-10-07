// =============================================================================
// 大数据量导出：分块写入 + 逐块校验（nativeExport.ts）
// -----------------------------------------------------------------------------
// 为什么需要它：
//   工程数据大的时候（30MB+，主要是内联图片），旧的导出流程会把整包内容拼成
//   一个超长 base64 字符串、一次跨 JS→Java 桥交给原生层保存。手机 WebView
//   的内存顶不住这种峰值 → **导出时闪退**（JSON 和 ZIP 都一样，因为都要先
//   在内存里把整包造出来）。
//
// 现在的做法：
//   1. 内容**按块生成**（JSON 逐张卡拼、ZIP 用 JSZip 的流式生成），
//      任意时刻内存里只有一块（默认 512KB）；
//   2. 每块算出 SHA-256 一起交给原生插件，原生侧先校验再落盘；
//   3. 全部写完让原生侧**把文件重新读一遍**，按同样的分块边界再算一次哈希
//      和前端清单比对 —— 这就是"导出后一定要检查一遍"。
//
// 平台：
//   · Android(APK)：走本文件（原生 SaveFile 插件）
//   · 浏览器 / Electron：没有该插件 → hasChunkedWriter() 返回 false，
//     调用方回退原有下载逻辑
// =============================================================================

import { Capacitor, registerPlugin } from '@capacitor/core'
import { isNative, isAndroid } from './platform'
import { Directory, Filesystem } from '@capacitor/filesystem'

/** 原生插件返回 */
export interface NativeWriteHandle {
  id: string
  /** 给人看的路径（应急导出是「Download/BAKER/xxx」） */
  path: string
  uri: string
  /** 落点：public=公共下载目录 / external=应用外部目录 / internal=应用私有 / saf=用户选的 */
  location?: string
  /** 是否落在公共目录（文件管理器直接可见） */
  public?: boolean
}

export interface NativeWriteResult {
  bytes: number
  path: string
  uri?: string
  /** 回读校验是否通过 */
  verified: boolean
  /** 校验失败的块序号 */
  mismatches?: number[]
  /** 文件总长与前端写入量是否一致 */
  sizeOk?: boolean
  reason?: string
}

interface SaveFilePluginLike {
  pluginInfo?: () => Promise<{ ok?: boolean; chunked?: boolean; api?: number; sdk?: number }>
  beginWrite?: (opts: {
    fileName: string
    mime?: string
    emergency?: boolean
    /** 应急导出落点：auto（默认逐级回退）/ public / external / internal */
    location?: 'auto' | 'public' | 'external' | 'internal'
  }) => Promise<NativeWriteHandle>
  appendChunk?: (opts: { id: string; data: string; sha256: string }) => Promise<{ ok: boolean; bytes: number }>
  finishWrite?: (opts: {
    id: string
    chunkSizes: number[]
    chunkHashes: string[]
  }) => Promise<NativeWriteResult>
  abortWrite?: (opts: { id: string; delete?: boolean }) => Promise<unknown>
  saveFile?: (opts: { fileName: string; base64: string; mime?: string }) => Promise<{
    canceled?: boolean
    path?: string
  }>
  share?: (opts: { uri?: string; path?: string; mime?: string }) => Promise<{ ok?: boolean }>
}

/**
 * 原生 SaveFile 插件（静态注册）
 *
 * ⚠ 这里**故意不用** `await import('@capacitor/core')`：
 *   动态 import 在没有网络/资源缺失时可能永远不 settle，表现就是
 *   「一直卡在数据准备中」——2026-09-29 实测确认过这个卡死点，改成静态导入后
 *   插件对象在模块加载时就绪，不存在等待。
 */
// 本句柄是全工程**唯一被验证可用**的 SaveFile 连接点（分块写入 beginWrite/appendWrite
// 就是经它调通的）。zipExport.getNativeSaveFile() 也复用它，避免"二次注册拿到空代理"。
export const SaveFilePlugin = registerPlugin<SaveFilePluginLike>('SaveFile')

/**
 * 是否处于**真正的**原生平台（android / ios）
 *
 * ⚠️ 为什么不用 `isNativePlatform()`：Capacitor 的 `registerPlugin()` 返回万能代理 ——
 * 对任何属性都返回函数，只有**调用时**才抛
 * `"SaveFile" plugin is not implemented on web`。
 * 因此 `typeof plugin.saveFile === 'function'` 在浏览器里也成立，
 * 会让流程误判"原生保存可用"，最终把这个插件异常报给用户（网页版导出的实际 bug）。
 *
 * 这里用 `getPlatform()` 明确排除 web：只有 android / ios 才走原生分支。
 */
function isCapacitorNative(): boolean {
  // 统一走 utils/platform（内部用 getPlatform()，只有 android/ios 才算原生）
  return isNative()
}

async function getPlugin(): Promise<SaveFilePluginLike | null> {
  if (!isCapacitorNative()) return null
  return SaveFilePlugin
}

/** 插件自检结果（前端用它决定"能不能走分块导出"） */
export interface PluginProbe {
  /** 原生侧是否注册了 SaveFile */
  available: boolean
  /** 是否具备新版分块接口（beginWrite/appendChunk/finishWrite） */
  chunked: boolean
  /** 原生返回的版本信息（排查用） */
  info?: { api?: number; sdk?: number }
  /** 不可用原因 */
  reason?: string
}

let probePromise: Promise<PluginProbe> | null = null

/** 单次原生调用的兜底超时：原生卡住也绝不让界面无限"准备中" */
const BEGIN_TIMEOUT_MS = 12_000
const APPEND_TIMEOUT_MS = 20_000
const FINISH_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 4_000

/**
 * 导出链路的"硬超时"护栏（2026-09-30）
 *
 * 为什么必须每一步都包：安卓 WebView 上 JSZip 压缩 + base64 拼接 + 原生 SAF 保存
 * 这三步都可能长时间不返回（大工程、桥不应答）。只要有一处永久挂起，界面就会
 * 停在「正在准备数据…」且**没有任何报错** —— 这正是用户实际遇到的现象。
 * 这里保证每个 await 都有上限，超时抛可读错误 → 界面必然给出原因。
 */
/**
 * 导出时间线（2026-09-30）：记录每一步的开始/结束，用于"卡住了到底卡在哪"。
 *
 * 用法：
 *   const tl = new ExportTimeline()
 *   tl.step('pack')            // 进入某阶段
 *   tl.done('pack')            // 该阶段完成
 *   tl.report()                // 生成人类可读的进度报告
 */
export class ExportTimeline {
  private t0 = Date.now()
  private marks: string[] = []
  private stage = ''
  private stageAt = 0

  /** 进入某阶段（会记录上一阶段耗时） */
  step(name: string): void {
    const now = Date.now()
    if (this.stage) this.marks.push(`${this.stage} ✓ ${now - this.stageAt}ms`)
    this.stage = name
    this.stageAt = now
  }

  /** 标记当前阶段完成 */
  done(name?: string): void {
    const now = Date.now()
    const cur = name ?? this.stage
    if (cur) this.marks.push(`${cur} ✓ ${now - this.stageAt}ms`)
    this.stage = ''
    this.stageAt = now
  }

  get elapsedMs(): number {
    return Date.now() - this.t0
  }

  get currentStage(): string {
    return this.stage
  }

  /** 人类可读报告：已完成的步骤 + 当前卡在哪一步 */
  report(): string {
    const parts: string[] = []
    if (this.marks.length) parts.push('已完成：' + this.marks.join('，'))
    if (this.stage) parts.push(`当前卡在：${this.stage}（已停留 ${Date.now() - this.stageAt}ms）`)
    parts.push(`总计 ${(this.elapsedMs / 1000).toFixed(1)}s`)
    return parts.join('；')
  }
}

/**
 * **按钮级强制超时**（2026-09-30 用户要求）
 *
 * 点按钮即开始计时；到点无论内部在等什么，都抛出一个带上**完整时间线**的错误。
 * 这样界面必然显示"卡在哪一步、已经走完哪些步骤"，而不是无限"正在准备数据…"。
 */
export function withForceTimeout<T>(
  p: Promise<T>,
  ms: number,
  tl: ExportTimeline,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `${what}超过强制上限 ${(ms / 1000).toFixed(0)} 秒仍未完成。${tl.report()}`))
    }, ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export function withHardTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} 超时（${Math.round(ms / 1000)} 秒无响应）`))
    }, ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 给任意 Promise 加超时（超时抛带说明的错误，而不是永远挂着） */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} 超时（${Math.round(ms / 1000)} 秒无响应）`))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 探测原生插件能力（结果缓存）
 *
 * 为什么不能只看 typeof beginWrite === 'function'：
 *   Capacitor 的插件代理对任何属性都返回函数，插件其实没注册时也会"看起来有"，
 *   这时候发出去的调用永远不会有人应答 —— 表现就是界面一直卡在"准备中"。
 *   所以这里真的调一次 pluginInfo 并加超时，拿到原生侧回话才算数。
 */
export async function probePlugin(): Promise<PluginProbe> {
  if (probePromise) return probePromise
  probePromise = (async (): Promise<PluginProbe> => {
    const p = await getPlugin()
    if (!p) return { available: false, chunked: false, reason: '非原生平台或插件未挂载' }
    let declared = true
    try {
      // 关键修复（2026-09-30）：`isPluginAvailable('SaveFile')` 只有在**本页已经调用过
      // registerPlugin('SaveFile')** 之后才为真。冷启动后如果没有任何代码先注册它，
      // 这里会误判成「插件未注册」，而 probe 结果还会被缓存一整个页面生命周期 ——
      // 于是之后每一次导出都走兜底路径（在安卓 WebView 里静默失败）。
      // 所以这里**先注册**（registerPlugin 幂等），再判定。
      if (isCapacitorNative()) {
        const plugin = registerPlugin<SaveFilePluginLike>('SaveFile')
        declared = !!plugin && typeof (plugin as { saveFile?: unknown }).saveFile === 'function'
      } else {
        declared = false
      }
    } catch {
      declared = false
    }
    if (!declared) {
      return { available: false, chunked: false, reason: '原生插件 SaveFile 未注册（旧版本包？）' }
    }
    try {
      const info = await withTimeout<{ ok?: boolean; chunked?: boolean; api?: number; sdk?: number }>(
        p.pluginInfo ? p.pluginInfo() : Promise.resolve({}),
        PROBE_TIMEOUT_MS,
        '原生组件自检',
      )
      return {
        available: true,
        chunked: info?.chunked === true,
        info: { api: info?.api, sdk: info?.sdk },
        reason: info?.chunked === true ? undefined : '插件版本过旧，不支持分块导出',
      }
    } catch (e) {
      return {
        available: false,
        chunked: false,
        reason: e instanceof Error ? e.message : '插件自检失败',
      }
    }
  })()
  return probePromise
}

/** 是否具备"分块写入 + 回读校验"的能力 */
export async function hasChunkedWriter(): Promise<boolean> {
  const probe = await probePlugin()
  return probe.chunked
}

/** 是否安卓打包环境（应急导出按钮只在这里显示） */
export function isNativeAndroid(): boolean {
  // 统一判据：只有真·安卓才显示安卓独有功能（如应急导出）
  return isAndroid()
}

/** 是否具备旧的单次保存接口（老 APK 只有这个） */
export async function hasLegacySave(): Promise<boolean> {
  const p = await getPlugin()
  return !!p && typeof p.saveFile === 'function'
}

// ---- 字节/编码工具 -----------------------------------------------------------

const textEncoder = new TextEncoder()

/** 文本 → UTF-8 字节 */
export function utf8Bytes(text: string): Uint8Array {
  return textEncoder.encode(text)
}

/** 字节 → base64（分片拼接，避免 apply/栈溢出） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** SHA-256 → 十六进制；环境不支持时返回空串（此时原生侧跳过逐块比对，只校验总长） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return ''
    // 传 Uint8Array 的底层 buffer 时要注意 offset/length
    const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
    const digest = await subtle.digest('SHA-256', view as ArrayBuffer)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return ''
  }
}

// ---- 分块写入器 --------------------------------------------------------------

/** 一次导出的结果（JSON / ZIP 共用） */
export interface ExportOutcome {
  /** 保存位置（应急导出为 Download/BAKER/xxx；取消/回退到浏览器下载时为空串） */
  path: string
  /** 实际写入字节 */
  bytes: number
  /** 是否通过回读校验 */
  verified: boolean
  /** 校验失败的块数（0 = 全部通过） */
  mismatchCount: number
  /** 被过滤的超大图片张数 */
  filteredImages: number
  /** 预计导出总字节 */
  totalBytes: number
  /** 是否走了分块通道 */
  chunked: boolean
  /** 原生文件 uri（分享用） */
  uri?: string
  /** 落点：public / external / internal / saf */
  location?: string
  /** 是否落在公共目录（文件管理器直接可见） */
  isPublic?: boolean
}

/** 每块字节数：512KB（桥层与内存压力的折中） */
export const CHUNK_BYTES = 512 * 1024

export interface ExportProgress {
  /** 已写入字节 */
  loaded: number
  /** 预计总字节（不知道时为 0） */
  total: number
  /** 0~100；total 未知时为 -1 */
  percent: number
  /**
   * 当前阶段（2026-09-30 新增）
   *
   *   pack   —— 正在把卡片序列化成 ZIP/JSON（纯 JS，最耗时的一步）
   *   begin  —— 正在让原生侧建立目标文件（安卓会弹"另存为"）
   *   append —— 正在分块写入
   *   finish —— 正在收尾 + 回读校验
   *
   * 有它之后，界面能显示"卡在哪一步"，不再是一个含糊的「正在准备数据…」。
   */
  /**
   * 当前阶段（越细越好定位）：
   *   pack      序列化+压缩（JSZip）
   *   encode    blob → base64 过桥前的编码
   *   getplugin 取原生保存句柄
   *   begin     已调起原生保存（安卓=拉起文件管理器，等用户选位置）
   *   append    分块写入中
   *   finish    收尾/回读校验
   */
  stage?: 'pack' | 'encode' | 'getplugin' | 'begin' | 'append' | 'finish'
}

export interface ChunkWriteSession {
  /** 保存后的可读路径（应急导出为 Download/BAKER/xxx） */
  path: string
  /** 落点：public / external / internal / saf */
  location?: string
  /** 是否落在公共目录（文件管理器直接可见） */
  isPublic?: boolean
  /** 原生文件 uri（分享用） */
  uri?: string
  /** 追加一块原始字节 */
  append(bytes: Uint8Array): Promise<void>
  /** 收尾：关闭文件并回读校验 */
  finish(): Promise<NativeWriteResult>
  /** 中止：删除半截文件 */
  abort(): Promise<void>
}

/**
 * 开始一次分块导出
 *
 * @param fileName  文件名（JSON/ZIP 各自的名字）
 * @param mime      MIME
 * @param emergency true = 应急导出（直接写手机「下载/BAKER」，不弹选择框）
 * @param totalBytes 预计总字节（只用于算进度，可为 0）
 * @param onProgress 进度回调
 */
// =============================================================================
// 兜底写入后端：官方 @capacitor/filesystem
// -----------------------------------------------------------------------------
// 为什么要有它：SaveFile 是自研插件，万一某个安装包里没有（老包/注册失败），
// 应急导出就彻底没救。而 @capacitor/filesystem 是官方依赖、一定在包里，
// 所以拿它当兜底：
//   Documents（公共文档目录，文件管理器可见）→ Data（应用私有目录）
// 代价：这套接口没有"分块回读校验"，只能按总字节长度核对；
//       所以**只要 SaveFile 可用就优先走它**（那条路有逐块 SHA-256 校验）。
// =============================================================================

const EMERGENCY_TEXT_SUBDIR = 'BAKER'

async function beginFilesystemSession(opts: {
  fileName: string
  totalBytes?: number
  onProgress?: (p: ExportProgress) => void
}): Promise<ChunkWriteSession> {
  const rel = `${EMERGENCY_TEXT_SUBDIR}/${opts.fileName}`
  const tried: string[] = []
  let dir: Directory | null = null
  for (const candidate of [Directory.Documents, Directory.Data]) {
    try {
      await withTimeout(
        Filesystem.writeFile({
          path: rel,
          data: '',
          directory: candidate,
          recursive: true,
        }),
        8_000,
        '建立导出文件（filesystem）',
      )
      dir = candidate
      break
    } catch (e) {
      tried.push(`${candidate}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!dir) {
    throw new Error(`备用写入通道也失败：${tried.join('；')}`)
  }
  const activeDir = dir
  let loaded = 0
  let done = false
  return {
    path: `${
      activeDir === Directory.Documents ? '文档' : '应用目录'
    }/${rel}`,
    location: activeDir === Directory.Documents ? 'fs-documents' : 'fs-data',
    isPublic: activeDir === Directory.Documents,
    uri: '',
    async append(bytes: Uint8Array) {
      // Filesystem 的 data 默认按 base64 处理 → 二进制/文本都统一走 base64
      await withTimeout(
        Filesystem.appendFile({
          path: rel,
          data: bytesToBase64(bytes),
          directory: activeDir,
        }),
        APPEND_TIMEOUT_MS,
        '写入数据块（filesystem）',
      )
      loaded += bytes.length
      opts.onProgress?.({
        loaded,
        total: opts.totalBytes ?? 0,
        percent: opts.totalBytes ? Math.min(100, Math.round((loaded / opts.totalBytes) * 100)) : -1,
        stage: 'append',
      })
    },
    async finish() {
      done = true
      let sizeOk = false
      let size = -1
      try {
        const st = await withTimeout(
          Filesystem.stat({ path: rel, directory: activeDir }),
          15_000,
          '核对文件大小',
        )
        size = Number((st as { size?: number }).size ?? -1)
        sizeOk = size === loaded
      } catch {
        // 拿不到大小就只报告写入量
      }
      return {
        bytes: loaded,
        path: `${
          activeDir === Directory.Documents ? '文档' : '应用目录'
        }/${rel}`,
        verified: sizeOk,
        sizeOk,
        reason: sizeOk ? undefined : `文件大小 ${size} 与写入量 ${loaded} 不一致（或无法核对）`,
      }
    },
    async abort() {
      if (done) return
      try {
        await Filesystem.deleteFile({ path: rel, directory: activeDir })
      } catch {
        // 清理失败不影响主流程
      }
    },
  }
}

// ============================================================================
// 统一导出保存（2026-10-04 修复「导出 0 字节空文件」）
// ----------------------------------------------------------------------------
// 背景：v2.2 起导出走的是「整包 base64 一次性过 Capacitor 桥」的老路。
// 聊天记录一多（尤其带图片），base64 字符串过大时桥层会**静默丢弃/截断**，
// 原生侧 Base64.decode 拿到空串 → 落盘就是一个 0 字节空文件
// —— 就是用户看到的"导出数据得到一个空数据集"。
//
// 因此这里按体积分流：
//   · 小文件 → 继续走 saveFile（简单、弹系统"保存到"框）
//   · 大文件 → 走 beginWrite/appendChunk/finishWrite
//             （分块过桥 + 逐块 SHA-256 + 收尾回读校验，桥层不可能吞掉内容）
// 并且：内容为空直接报错（绝不生成空文件）；分块写入回读校验失败也报错，
// 而不是当成"导出成功"糊弄过去。
// ============================================================================

/** 整串 base64 过桥的安全上限：超过它就必须分块写入 */
export const BRIDGE_SAFE_BASE64 = 6 * 1024 * 1024
/** 分块保存时的单块字节数（原生侧上限 4MB） */
const SAVE_CHUNK_BYTES = 512 * 1024

/** base64 → Uint8Array（WebView 内 atob 可用；非法字符直接抛错，不静默产出空数据） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 统一保存导出文件（ZIP / JSON 共用）
 *
 * @returns via: 'legacy' = 整包过桥（小文件）; 'chunked' = 分块写入（大文件，带回读校验）
 */
export async function saveExportFileSmart(opts: {
  fileName: string
  base64: string
  mime?: string
  onProgress?: (p: ExportProgress) => void
}): Promise<{ via: 'legacy' | 'chunked'; bytes: number }> {
  const mime = opts.mime ?? 'application/octet-stream'
  const b64 = opts.base64 ?? ''
  // 空内容守卫：以前这种情况会"成功"导出一个 0 字节文件，用户以为数据丢了
  if (b64.length < 256) {
    throw new Error('导出内容为空（0 字节），已中止以免生成空文件。请确认当前确实有可导出的数据。')
  }
  const estBytes = Math.floor((b64.length * 3) / 4)

  // ---- 小文件：沿用原有 saveFile 通道（直接用本文件已注册的插件句柄，
  //      不 import zipExport 的 getNativeSaveFile —— 那会造成模块循环依赖）----
  if (b64.length <= BRIDGE_SAFE_BASE64) {
    const plugin = (await getPlugin()) as unknown as {
      saveFile?: (o: { fileName: string; base64: string; mime?: string }) =>
        Promise<{ canceled?: boolean } | void>
    } | null
    if (!plugin || typeof plugin.saveFile !== 'function') {
      throw new Error('未找到系统保存组件（SaveFile）')
    }
    const res = await plugin.saveFile({ fileName: opts.fileName, base64: b64, mime })
    if (res && res.canceled) throw new Error('已取消导出')
    return { via: 'legacy', bytes: estBytes }
  }

  // ---- 大文件：分块写入 ----
  const probe = await probePlugin()
  if (!probe.chunked) {
    const mb = (estBytes / 1048576).toFixed(1)
    throw new Error(
      `数据过大（约 ${mb}MB），当前安装包不支持分块写入；整包导出会被桥层截断（表现为 0 字节）。
请更新到最新安装包后重试，或先删除部分聊天记录再导出。`,
    )
  }
  const session = await beginExportWrite({
    fileName: opts.fileName,
    mime,
    emergency: false,
    totalBytes: estBytes,
    onProgress: opts.onProgress,
    probe,
  })
  try {
    const bytes = base64ToBytes(b64)
    for (let i = 0; i < bytes.length; i += SAVE_CHUNK_BYTES) {
      await session.append(bytes.subarray(i, i + SAVE_CHUNK_BYTES))
    }
    const result = await session.finish()
    const written = Number(result?.bytes ?? 0)
    if (result?.sizeOk === false || written <= 0) {
      throw new Error(`分块写入校验失败（写入 ${written} 字节），已保留中间文件供排查`)
    }
    return { via: 'chunked', bytes: written }
  } catch (err) {
    // 失败时删掉半截文件，避免用户拿到一个"看着有、其实不完整"的包
    try { await session.abort() } catch { /* 忽略 */ }
    throw err
  }
}

export async function beginExportWrite(opts: {
  fileName: string
  mime: string
  emergency: boolean
  totalBytes?: number
  onProgress?: (p: ExportProgress) => void
  /** 原生自检信息（失败时写进错误里，方便用户/开发者定位） */
  probe?: PluginProbe
}): Promise<ChunkWriteSession> {
  const probe = opts.probe ?? (await probePlugin())
  const plugin = await getPlugin()
  const canNative = !!plugin && typeof plugin.beginWrite === 'function' && probe.chunked

  // 应急导出：自研插件不可用（老包/注册失败/自检超时）就直接走官方 filesystem 兜底，
  // 保证这个"救命按钮"在任何情况下都有输出，而不是报个错就结束。
  if (!canNative) {
    if (opts.emergency) {
      return beginFilesystemSession({
        fileName: opts.fileName,
        totalBytes: opts.totalBytes,
        onProgress: opts.onProgress,
      })
    }
    throw new Error(
      '该安装包不支持分块导出：' +
        (probe.reason || '原生组件未就绪') +
        '。请更新到最新版安装包；或先用「导出 JSON」走系统另存为。',
    )
  }

  /**
   * 应急导出：逐级换落点重试
   *   auto（公共下载目录，失败自动往下退）→ external（应用外部目录）→ internal（私有目录）
   * 每次都有超时：某些机型 MediaStore 一卡就是几分钟，绝不能干等。
   */
  const order: Array<'auto' | 'external' | 'internal'> = opts.emergency
    ? ['auto', 'external', 'internal']
    : ['auto']
  let handle: NativeWriteHandle | null = null
  const failures: string[] = []
  // 2026-09-30：非应急导出原先这一档超时是 30 分钟（"用户挑目录可能很久"）。
  // 但 Capacitor 的插件代理对**任意属性都返回函数**，当原生侧没有应答时
  // `plugin.beginWrite(...)` 这个 Promise 永远不会 settle —— 界面就永久停在
  // 「正在准备数据…」，这正是用户反馈的现象。这里给一个足够长（够用户选目录）、
  // 但**有限**的上限；到点明确报错并带上原生自检信息，绝不无限等。
  const PICK_LOCATION_TIMEOUT_MS = 180_000
  for (const loc of order) {
    try {
      handle = await withTimeout(
        plugin.beginWrite!({
          fileName: opts.fileName,
          mime: opts.mime,
          emergency: opts.emergency,
          location: loc,
        }),
        opts.emergency ? BEGIN_TIMEOUT_MS : PICK_LOCATION_TIMEOUT_MS,
        opts.emergency ? `建立导出文件（${loc}）` : '选择保存位置',
      )
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failures.push(`${loc}: ${msg}`)
      if (!opts.emergency) throw e
    }
  }
  if (!handle?.id) {
    const probe = opts.probe
    const diag = probe
      ? `（原生组件：${probe.available ? '可用' : '不可用'}${probe.reason ? ' - ' + probe.reason : ''}）`
      : ''
    throw new Error(`建立导出文件失败${diag}：${failures.join('；')}`)
  }
  const id = handle.id

  // 通知调用方"文件已建立，开始写入"（UI 借此从「打包」切到「写入」阶段）
  opts.onProgress?.({ loaded: 0, total: opts.totalBytes ?? 0, percent: -1, stage: 'begin' })

  let loaded = 0
  const sizes: number[] = []
  const hashes: string[] = []
  let closed = false

  return {
    path: handle.path || '',
    location: handle.location,
    isPublic: handle.public === true,
    uri: handle.uri || '',
    async append(bytes: Uint8Array) {
      const sha = await sha256Hex(bytes)
      await withTimeout(
        plugin.appendChunk!({ id, data: bytesToBase64(bytes), sha256: sha }),
        APPEND_TIMEOUT_MS,
        '写入数据块',
      )
      loaded += bytes.length
      sizes.push(bytes.length)
      hashes.push(sha)
      opts.onProgress?.({
        loaded,
        total: opts.totalBytes ?? 0,
        percent: opts.totalBytes ? Math.min(100, Math.round((loaded / opts.totalBytes) * 100)) : -1,
        stage: 'append',
      })
    },
    async finish() {
      const res = await withTimeout(
        plugin.finishWrite!({ id, chunkSizes: sizes, chunkHashes: hashes }),
        FINISH_TIMEOUT_MS,
        '收尾并回读校验',
      )
      closed = true
      return { ...res, bytes: res?.bytes ?? loaded, path: res?.path || handle.path || '' }
    },
    async abort() {
      if (closed) return
      try {
        await plugin.abortWrite?.({ id, delete: true })
      } catch {
        // 清理失败不重要
      }
    },
  }
}

/**
 * 文本分块打包器：攒够一块就交给会话写出去
 *
 * 逐块把文本转成 UTF-8 字节，任意时刻只有一块在内存里 ——
 * 这是"不再把 30MB 整包拼成一个字符串"的关键。
 */
export class TextChunkPacker {
  private buf = ''

  constructor(
    private readonly session: ChunkWriteSession,
    private readonly chunkBytes: number = CHUNK_BYTES,
  ) {}

  async push(text: string): Promise<void> {
    this.buf += text
    await this.drain(false)
  }

  async flush(): Promise<void> {
    await this.drain(true)
  }

  private async drain(force: boolean): Promise<void> {
    while (this.buf.length >= this.chunkBytes || (force && this.buf.length > 0)) {
      const take = Math.min(this.buf.length, this.chunkBytes)
      let piece = this.buf.slice(0, take)
      // 不要把一个 UTF-16 代理对劈成两半（emoji / 生僻字）
      if (take < this.buf.length) {
        const code = piece.charCodeAt(piece.length - 1)
        if (code >= 0xd800 && code <= 0xdbff) piece = piece.slice(0, -1)
      }
      this.buf = this.buf.slice(piece.length)
      if (piece.length > 0) await this.session.append(utf8Bytes(piece))
    }
  }
}

/**
 * 把一个（异步）字符串生成器写出去，并把生成器的 return 值原样返回
 *
 * 生成器常用 `return {过滤了几张图, 总字节}` 这类统计，for-await 会把它丢掉，
 * 所以这里手工迭代。
 */
export async function packAsyncGenerator<T>(
  source: AsyncGenerator<string, T, void>,
  session: ChunkWriteSession,
): Promise<T> {
  const packer = new TextChunkPacker(session)
  const it = source[Symbol.asyncIterator]()
  for (;;) {
    const { value, done } = await it.next()
    if (done) {
      await packer.flush()
      return value as T
    }
    await packer.push(value as string)
  }
}

/** 把 Blob 分块写出去（ZIP 流式生成、或已有 Blob 时用） */
export async function writeBlobChunks(session: ChunkWriteSession, blob: Blob): Promise<void> {
  for (let off = 0; off < blob.size; off += CHUNK_BYTES) {
    const slice = blob.slice(off, Math.min(off + CHUNK_BYTES, blob.size))
    const buf = await slice.arrayBuffer()
    await session.append(new Uint8Array(buf))
  }
}

/**
 * 给写入会话套一层"看门狗"
 *
 * 作用：**任何一步卡住超过 stallMs 没进展，立刻中止并抛错**。
 * 为什么必须要有：原生/桥层某些调用会让 Promise 永远不 settle（插件没注册、
 * MediaStore 卡死等），光靠单次调用超时覆盖不全 —— 之前"一直数据准备中"
 * 就是这么来的。这里把 append 与"卡死信号"赛跑，卡住就一定有人先醒。
 */
export function withWatchdog(session: ChunkWriteSession, stallMs = 30_000): ChunkWriteSession {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  let rejectStall: ((e: Error) => void) | null = null
  const stallPromise = new Promise<never>((_, reject) => {
    rejectStall = reject
  })

  const clear = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const kick = () => {
    clear()
    if (stalled) return
    timer = setTimeout(() => {
      stalled = true
      rejectStall?.(new Error(`导出卡住：${Math.round(stallMs / 1000)} 秒没有进展，已中止`))
      void session.abort()
    }, stallMs)
  }

  return {
    path: session.path,
    location: session.location,
    isPublic: session.isPublic,
    uri: session.uri,
    async append(bytes: Uint8Array) {
      if (stalled) throw new Error('导出已中止（此前卡住过）')
      kick()
      await Promise.race([session.append(bytes), stallPromise])
      kick()
    },
    async finish() {
      clear()
      try {
        return await Promise.race([session.finish(), stallPromise])
      } finally {
        stalled = true
      }
    },
    async abort() {
      clear()
      stalled = true
      await session.abort()
    },
  }
}

/**
 * 把已导出的文件交给系统"分享"（微信/QQ/邮件/网盘…）
 *
 * 兜底落点（应用外部/私有目录）在部分机型上文件管理器看不到，
 * 这时"分享出去"就是用户把数据拿出来的唯一办法。
 */
export async function shareExportedFile(opts: {
  uri?: string
  path?: string
  mime?: string
}): Promise<void> {
  const plugin = await getPlugin()
  if (!plugin?.share) throw new Error('当前版本不支持分享，请更新应用')
  await withTimeout(
    plugin.share({ uri: opts.uri, path: opts.path, mime: opts.mime }),
    30_000,
    '调起系统分享',
  )
}
