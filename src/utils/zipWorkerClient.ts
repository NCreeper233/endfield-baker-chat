// zipWorkerClient —— 导入导出的执行入口
// 实际在主线程直接执行：跨线程传 Blob/ArrayBuffer 在安卓 WebView / Electron 上
// 有兼容问题（DataCloneError）。Worker 通道保留但未启用，失败时同样回退主线程。
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
      // 崩溃后标记不可用，在途任务统一拒绝，由调用方回退主线程
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
/** 被剔除（退回 [图片] 占位）的图片张数 */
  filteredImages: number
  /** 被 canvas 重编码压小的图片张数 */
  reencodedImages: number
  /** 真实字节：浏览器端 = ZIP blob.size；原生分块通道为回读校验过的落盘字节 */
  totalBytes: number
}

/** 仍在主线程执行，理由见文件头 */
export async function exportToZipInWorker(
  cards: unknown,
  myGender: 'male' | 'female',
  stripVariantIndex: number,
  promptOverrides: Record<string, string>,
  settingsSnapshot?: Record<string, unknown> | null,
): Promise<WorkerExportResult> {
  // 不走 Worker：跨平台下 Blob/ArrayBuffer 的跨线程传递有兼容问题。
  // JSZip 的 generateAsync 本身就是异步 API，不会阻塞主线程；base64 分片转换避免栈溢出。
  const { blob, filteredImages, reencodedImages, totalBytes } = await exportToZip(
    cards as never,
    myGender,
    stripVariantIndex,
    promptOverrides,
    settingsSnapshot,
  )
  const base64 = await blobToBase64Fallback(blob)
  return { base64, filteredImages, reencodedImages, totalBytes }
}

/** 导入解析同样在主线程执行 */
export async function importFromZipInWorker(blob: Blob): Promise<ProjectPayload> {
  return importFromZip(blob)
}

/** 分片转换：外层 8MB，内层每次只拼 8K —— apply 传参过多会 RangeError */
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
