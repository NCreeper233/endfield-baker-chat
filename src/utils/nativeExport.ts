// nativeExport —— 大数据量导出：按块（默认 512KB）生成，每块带 SHA-256 交原生校验后落盘，
// 写完再整文件回读比对。非 Android 无此插件，调用方回退普通下载。

import { registerPlugin } from '@capacitor/core'
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
    uri?: string
    bytes?: number
    public?: boolean
    location?: string
  }>
  /** 保存完成后跳到文件管理器（安卓本地实现；没有就返回 ok:false，不抛错） */
  revealFile?: (opts: { uri?: string; path?: string; mime?: string }) => Promise<{
    ok?: boolean
    via?: string
  }>
  share?: (opts: { uri?: string; path?: string; mime?: string }) => Promise<{ ok?: boolean }>
}

/**
 * 全工程唯一被验证可用的 SaveFile 连接点（zipExport 也复用它）。
 * ⚠️ 用静态注册而非 `await import()`：动态 import 在资源缺失时可能永不 settle，
 * 界面就会一直卡在「正在准备数据中」。
 */
export const SaveFilePlugin = registerPlugin<SaveFilePluginLike>('SaveFile')

/**
 * ⚠️ 不能用 typeof plugin.saveFile 试探：registerPlugin 返回万能代理，任何属性都是函数，
 * 只在调用时才抛 "not implemented on web"，试探法会让网页版误判为原生可用。
 */
function isCapacitorNative(): boolean {
  // 统一走 utils/platform（内部用 getPlatform()，只有 android/ios 才算原生）
  return isNative()
}

/**
 * 拿插件代理（同步！）。
 *
 * ⚠️⚠️ 这个函数**绝不能是 async**，调用处也**绝不能 `await` 它的返回值**。
 * registerPlugin 返回的是 Proxy，它对任何属性（包括 `then`）都返回一个函数 ——
 * 于是 `await plugin` 会被 JS 当成 "thenable" 去调 `SaveFile.then(resolve, reject)`，
 * 原生侧直接抛 `"SaveFile.then()" is not implemented on android`，而那个 await
 * 永远不会 settle：界面就永久停在「导出中…」（2026-11-09 真机抓到的根因，
 * 连 120 秒超时都触发不了，因为根本没走到加超时的那一步）。
 */
function getPlugin(): SaveFilePluginLike | null {
  // 统一走 utils/platform（内部用 getPlatform()，只有 android/ios 才算原生）
  return isCapacitorNative() ? SaveFilePlugin : null
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
/** 整包保存（≤2MB）的兜底超时：写盘 + 校验，120 秒还没回话一定是出问题了 */
const SAVE_FILE_TIMEOUT_MS = 120_000
/** 跳文件管理器的兜底超时：只是个 startActivity，8 秒没回话就当失败 */
const REVEAL_TIMEOUT_MS = 8_000

/**
 * 每一步 await 都必须有上限：安卓 WebView 上压缩、base64 拼接、SAF 保存都可能不返回，
 * 一处永久挂起就会停在「正在准备数据…」且没有任何报错。
 */
/** 导出时间线：记录每步开始/结束，用于定位「卡住了到底卡在哪」 */
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
 * 不能只看 typeof beginWrite：插件代理对任何属性都返回函数，未注册时调用永远不会有人应答。
 * 这里真调一次 pluginInfo 并加超时，拿到原生回话才算数。
 */
export async function probePlugin(): Promise<PluginProbe> {
  if (probePromise) return probePromise
  probePromise = (async (): Promise<PluginProbe> => {
    const p = getPlugin()
    if (!p) return { available: false, chunked: false, reason: '非原生平台或插件未挂载' }
    let declared = true
    try {
      // isPluginAvailable 只在**本页调用过 registerPlugin** 之后才为真，而 probe 结果会
      // 缓存整个页面生命周期；冷启动时不先注册，就会一直走兜底路径并静默失败。
      // 故先注册（幂等）再判定。
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
  const p = getPlugin()
  return !!p && typeof p.saveFile === 'function'
}

// 字节 / 编码工具

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

// 分块写入器

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
  /** 当前阶段，界面据此显示「卡在哪一步」 */
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
 * 兜底写入后端：官方 @capacitor/filesystem（老包或 SaveFile 注册失败时用），
 * 顺序 Documents → Data。它没有逐块回读校验，只能核对总长，故 SaveFile 可用时优先。
 */
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

// 统一导出保存：小文件走 saveFile（弹系统「保存到」），大文件走分块写入
// （逐块 SHA-256 + 回读校验）。整串 base64 过桥时字符串过大会被桥层截断、落盘成
// 0 字节空文件；内容为空或校验失败一律报错，绝不当成「导出成功」。

/**
 * 整串 base64 过桥的安全上限：桥层会把整串序列化成一个巨大 JSON 传给 Java，
 * 峰值内存约原文的 3~4 倍，低端机上 6MB 就可能闪退。取 2MB，峰值砍掉 2/3。
 */
export const BRIDGE_SAFE_BASE64 = 2 * 1024 * 1024
/** 分块保存时的单块字节数（原生侧上限 4MB；取 256KB 降低桥层峰值） */
const SAVE_CHUNK_BYTES = 256 * 1024

/** base64 → Uint8Array（WebView 内 atob 可用；非法字符直接抛错，不静默产出空数据） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 一次保存的落地信息（界面用它显示「已保存到 …」并再打开文件夹） */
export interface SavedFileInfo {
  /** 给人看的落点（「下载/Baker AI/xxx.zip」）；浏览器端为空串 */
  path: string
  /** 原生 uri（再次打开用） */
  uri: string
  /** 是否落在公共目录（文件管理器直接可见） */
  isPublic: boolean
  /** 真实落盘字节 */
  bytes: number
  /** 保存后是否成功跳到了文件管理器 */
  revealed: boolean
}

/**
 * 保存完成后自动跳到文件管理器（安卓）。
 *
 * 不抛错：界面已经显示了落点，用户还能点「打开所在文件夹」再试一次；
 * 这里抛错只会把一次成功的导出变成一次失败提示。
 */
export async function revealSavedFile(opts: {
  path?: string
  uri?: string
  mime?: string
}): Promise<boolean> {
  const plugin = getPlugin()
  if (!plugin) return false
  try {
    const res = await withTimeout(
      plugin.revealFile
        ? plugin.revealFile({ uri: opts.uri ?? '', path: opts.path ?? '', mime: opts.mime })
        : Promise.resolve({ ok: false }),
      REVEAL_TIMEOUT_MS,
      '打开文件管理器',
    )
    return res?.ok === true
  } catch {
    return false
  }
}

/** 统一保存导出文件（ZIP / JSON / 截图共用）；via 区分整包过桥与分块写入 */
export async function saveExportFileSmart(opts: {
  fileName: string
  base64: string
  mime?: string
  /** 保存成功后是否自动跳文件管理器（默认 true；安卓以外无效） */
  autoReveal?: boolean
  onProgress?: (p: ExportProgress) => void
}): Promise<SavedFileInfo & { via: 'legacy' | 'chunked' }> {
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
    // Electron(EXE)：必须走 preload 的「另存为」对话框。
    // 它和 Capacitor 插件是两套东西 —— 直接用 getPlugin() 在 Electron 上恒为 null，
    // 会把 Windows 的导出变成"未找到系统保存组件"（本次修的就是这个回归）。
    const electronSave = (window as unknown as {
      nativeStorage?: { saveFileDialog?: (o: { fileName: string; base64: string }) =>
        Promise<{ canceled?: boolean } | void> }
    }).nativeStorage?.saveFileDialog
    if (electronSave) {
      const r = await electronSave({ fileName: opts.fileName, base64: b64 })
      if (r && r.canceled) throw new Error('已取消导出')
      return { via: 'legacy', bytes: estBytes, path: '', uri: '', isPublic: false, revealed: false }
    }
    const plugin = getPlugin() as unknown as {
      saveFile?: (o: { fileName: string; base64: string; mime?: string }) =>
        Promise<{
          canceled?: boolean
          path?: string
          uri?: string
          bytes?: number
          public?: boolean
        } | void>
    } | null
    if (!plugin || typeof plugin.saveFile !== 'function') {
      throw new Error('未找到系统保存组件（SaveFile）')
    }
    // ⚠️ 必须带超时：插件方法没应答时 Promise 永不 settle，按钮就永远停在「保存中…」
    const res = await withTimeout(
      plugin.saveFile({ fileName: opts.fileName, base64: b64, mime }),
      SAVE_FILE_TIMEOUT_MS,
      '保存文件',
    )
    if (res && res.canceled) throw new Error('已取消导出')
    const bytes = Number(res?.bytes ?? 0) || estBytes
    const path = res?.path ?? ''
    const uri = res?.uri ?? ''
    const revealed = opts.autoReveal !== false
      ? await revealSavedFile({ path, uri, mime })
      : false
    return {
      via: 'legacy',
      bytes,
      path,
      uri,
      isPublic: res?.public === true,
      revealed,
    }
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
    const path = result?.path || session.path || ''
    const uri = result?.uri || session.uri || ''
    const revealed = opts.autoReveal !== false
      ? await revealSavedFile({ path, uri, mime })
      : false
    return {
      via: 'chunked',
      bytes: written,
      path,
      uri,
      isPublic: session.isPublic === true,
      revealed,
    }
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
  const plugin = getPlugin()
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
   * 应急导出逐级换落点：公共下载目录 → 应用外部目录 → 私有目录。
   * 每步都有超时：某些机型 MediaStore 一卡就是几分钟。
   */
  const order: Array<'auto' | 'external' | 'internal'> = opts.emergency
    ? ['auto', 'external', 'internal']
    : ['auto']
  let handle: NativeWriteHandle | null = null
  const failures: string[] = []
  // Capacitor 的插件代理对**任意属性都返回函数**：原生侧没有应答时
  // `plugin.beginWrite(...)` 这个 Promise 永远不会 settle，界面就永久停在
  // 「正在准备数据…」。这里给一个足够长（够用户选目录）、但**有限**的上限；
  // 到点明确报错并带上原生自检信息，绝不无限等。
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

/** 攒够一块就写出：逐块转 UTF-8，任意时刻只有一块在内存里，不必把 30MB 拼成整串 */
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
 * for-await 会丢掉生成器的 return 值，而它常带「过滤了几张图 / 总字节」这类统计，
 * 所以这里手工迭代并把返回值原样传出。
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
 * 任何一步卡住超过 stallMs 没进展就中止并抛错：原生/桥层某些调用会让 Promise 永不
 * settle（插件未注册、MediaStore 卡死），单次调用超时覆盖不全。
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
      if (stalled) throw new Error('导出已中止（上一步超时未应答）')
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
