// =============================================================================
// zipWorkerClient.ts —— 导入/导出 Worker 客户端封装
// -----------------------------------------------------------------------------
// 优先使用 Web Worker 执行 ZIP 序列化/解压(防主线程卡顿与 OOM);
// Worker 不可用(极老 WebView/SSR)时回退主线程直接执行。
// =============================================================================
import { exportToZip, importFromZip, type ProjectPayload } from './zipExport'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

let worker: Worker | null = null
let workerBroken = false
let seq = 0
const pending = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (worker) return worker
  if (workerBroken) return null
  try {
    // Vite 会将 worker 单独打包;运行时不支持则抛出
    worker = new Worker(new URL('./zipWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as {
        ok: boolean
        seq: number
        error?: string
        [k: string]: unknown
      }
      const p = pending.get(data.seq)
      if (!p) return
      pending.delete(data.seq)
      if (data.ok) {
        p.resolve(data)
      } else {
        p.reject(new Error(data.error || 'Worker 处理失败'))
      }
    }
    worker.onerror = (e) => {
      // Worker 运行崩溃:标记为不可用并终止,在途任务统一以 worker_crashed 拒绝,
      // 由调用方(exportToZipInWorker/importFromZipInWorker)回退主线程执行。
      const err = new Error('worker_crashed')
      const errMsg = e.message || 'Worker 运行错误'
      pending.forEach((p) => p.reject(new Error(errMsg)))
      pending.clear()
      worker?.terminate()
      worker = null
      workerBroken = true
    }
  } catch {
    worker = null
    workerBroken = true
  }
  return worker
}

function callWorker<T>(msg: Record<string, unknown>): Promise<T> {
  const w = getWorker()
  if (!w) throw new Error('worker_unavailable')
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ ...msg, seq: id })
  })
}

export interface WorkerExportResult {
  base64: string
  filteredImages: number
  totalBytes: number
}

/**
 * Worker 内执行 ZIP 导出,返回 base64(打包端直接可用)。
 * Worker 不可用时回退主线程执行。
 */
export async function exportToZipInWorker(
  cards: unknown,
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
): Promise<WorkerExportResult> {
  // 直接在主线程执行(不再走 Web Worker):
  // 跨平台(Android WebView / Electron / 浏览器)下 Worker 的跨线程 Blob/ArrayBuffer
  // 传递存在兼容性问题(如 Chrome 120+ 对不可克隆对象抛 DataCloneError,
  // 表现为 "could not be cloned / could not be closed")。
  // JSZip 3.10 的 generateAsync 本身就是异步 API(内部同步流处理),不会阻塞主线程;
  // base64 转换采用分片(8K 参数)避免栈溢出。稳定性优先。
  const { blob, filteredImages, totalBytes } = await exportToZip(
    cards as never,
    myGender,
    stripVariantIndex,
    promptOverrides,
    settingsSnapshot,
  )
  const base64 = await blobToBase64Fallback(blob)
  return { base64, filteredImages, totalBytes }
}

/** 导入解析:直接在主线程执行(与导出一致,避免跨线程 Blob 兼容问题) */
export async function importFromZipInWorker(blob: Blob): Promise<ProjectPayload> {
  return importFromZip(blob)
}

/** 主线程回退用的分片 base64 转换 */
async function blobToBase64Fallback(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  // 外层按 8MB 分块;内层每次只拼 8K 个字符 ——
  // String.fromCharCode.apply 一次传过多参数会 RangeError(栈溢出),
  // 8MB 直接 apply 会传 800 万参数导致导出失败
  const CHUNK = 8 * 1024 * 1024
  const STEP = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    for (let j = 0; j < slice.length; j += STEP) {
      const part = slice.subarray(j, Math.min(j + STEP, slice.length))
      binary += String.fromCharCode.apply(null, part as unknown as number[])
    }
  }
  return btoa(binary)
}

/** 终止 Worker(应用卸载/设置变更时调用,释放内存) */
export function terminateZipWorker() {
  // 导出/导入已改为直接主线程执行,不再持有 Worker,本函数保留仅为兼容调用方
  if (worker) {
    worker.terminate()
    worker = null
  }
  workerBroken = false
  pending.clear()
}
