// =============================================================================
// 云同步（临时数据中转）—— utils/cloudData.ts
// -----------------------------------------------------------------------------
// 干什么：
//   · uploadCloudData(json, onProgress)  把导出的 JSON 传到 local.peilika.beer，拿回取件码
//   · fetchCloudData(code, onProgress)   用取件码把那份 JSON 取回来（交给 importFromJson 导入）
//
// 为什么用 XMLHttpRequest 而不是 fetch：
//   fetch **拿不到上传进度**（没有 upload.onprogress）；XHR 两边都能拿到，
//   于是上传/下载都能画出真实进度条与速度。
//
// 服务端策略（见 /run/media/y/游戏/local-data/local_data_service.py）：
//   · 数据**不永久保存**：每天 12:00 检查一次，时间戳超过 24 小时就删除
//     → 实际存活 24~48 小时（多十几个小时 / 少十几个小时都不影响使用）
//   · 取件码 8 位（32 字符表，去掉 0O1I 等易混字符）；/fetch 有限速
//   · 数据落盘前 gzip，单份上限 64MB
// =============================================================================

/** 云同步服务地址（专属子域名；换域名只改这里） */
export const CLOUD_DATA_URL = 'https://local.peilika.beer'

/** 上传成功后的返回 */
export interface CloudUploadResult {
  /** 取件码（给用户在别的设备上输入） */
  code: string
  /** 压缩后存储体积（字节） */
  bytes: number
  /** 上传前原始体积（字节） */
  raw_bytes: number
  /** 服务器记录的上传时间 */
  uploaded_at: string
  /** 下一个清理时刻（到点后如果已超 24 小时就会被删） */
  cleanup_at: string
  /** 保留小时数 */
  keep_hours: number
}

/** 进度回调数据 */
export interface CloudProgress {
  /** 当前阶段：上传 / 下载 */
  phase: 'upload' | 'download'
  /** 已传输字节 */
  loaded: number
  /** 总字节（0 = 服务器没给 Content-Length，无法算百分比） */
  total: number
  /** 百分比 0~100；total 未知时为 -1 */
  percent: number
  /** 瞬时速度（字节/秒，滑动窗口 + 平滑） */
  speedBps: number
  /** 已耗时（毫秒） */
  elapsedMs: number
  /** 预计剩余（毫秒）；算不出来时为 null */
  etaMs: number | null
  /**
   * 字节已传完、正在**等服务器处理**（2026-09-30 新增）
   *
   * 为什么需要：上传的字节跑完后，服务器还要解压/组装/写盘（实测约 1 分钟），
   * 此时旧实现直接报 100%，界面看起来"传完了却卡着不动"，用户以为坏了。
   * 置 true 后 UI 会显示"已上传，正在等待服务器处理…"并走不确定动画。
   */
  waitingServer?: boolean
}

export type CloudProgressFn = (p: CloudProgress) => void

/** 超时：大包上传/取回给 5 分钟（进度条会显示实时速度，卡住一眼能看出来）；轻量接口 60 秒 */
const TIMEOUT_BULK_MS = 300_000
const TIMEOUT_LIGHT_MS = 60_000

/** 字节 → 人类可读（云同步区块显示用） */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 速度 → 人类可读 */
export function formatSpeed(bps: number): string {
  return bps > 0 ? `${formatBytes(bps)}/s` : '—'
}

/** 毫秒 → "12s" / "1分23秒" */
export function formatDuration(ms: number | null): string {
  if (ms === null || !isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`
}

/**
 * 速度计：滑动窗口（默认最近 1 秒）+ 指数平滑，避免数字乱跳。
 */
function makeSpeedMeter(windowMs = 1000) {
  const samples: Array<[number, number]> = []
  let smoothed = 0
  return (loaded: number, now: number): number => {
    samples.push([now, loaded])
    while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift()
    const [t0, l0] = samples[0]
    const dt = now - t0
    if (dt < 120) return smoothed                    // 样本太少先沿用上次
    const inst = ((loaded - l0) * 1000) / dt
    smoothed = smoothed > 0 ? smoothed * 0.35 + inst * 0.65 : inst
    return smoothed
  }
}

/** 统一的 XHR 请求；onProgress 会持续回调 */
function request(
  url: string,
  method: 'GET' | 'POST',
  body: string | null,
  phase: 'upload' | 'download',
  onProgress?: CloudProgressFn,
  timeoutMs: number = TIMEOUT_BULK_MS,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const t0 = Date.now()
    const meter = makeSpeedMeter()
    const needUploadBytes = (body ? new Blob([body]).size : 0)

    const emit = (loaded: number, total: number) => {
      if (!onProgress) return
      const now = Date.now()
      const elapsed = now - t0
      const speed = meter(loaded, now)
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : -1
      let eta: number | null = null
      if (total > 0 && speed > 0 && loaded < total) eta = ((total - loaded) / speed) * 1000
      onProgress({ phase, loaded, total, percent, speedBps: speed, elapsedMs: elapsed, etaMs: eta })
    }

    xhr.open(method, url, true)
    xhr.timeout = timeoutMs
    if (body !== null) xhr.setRequestHeader('Content-Type', 'application/json')

    if (phase === 'upload' && xhr.upload) {
      // 上传阶段：进度**最多到 99%**，不用 100% —— 100% 留给"服务器确认收妥"。
      // 原因见 CloudProgress.waitingServer 注释：字节传完 ≠ 服务端处理完。
      xhr.upload.onprogress = (e) => {
        const total = e.lengthComputable ? e.total : needUploadBytes
        const capped = total > 0 ? Math.min(e.loaded, total - 1) : e.loaded
        emit(capped, total)
      }
      xhr.upload.onload = () => {
        // 字节已发完，等服务端响应（可能几十秒）：明确告知用户，别让进度条假装 100%
        if (!onProgress) return
        const now = Date.now()
        onProgress({
          phase: 'upload',
          loaded: needUploadBytes,
          total: needUploadBytes,
          percent: 99,
          speedBps: 0,
          elapsedMs: now - t0,
          etaMs: null,
          waitingServer: true,
        })
      }
      // 一些浏览器在 body 很小/被缓冲时不给 upload 事件，这里先发一个 0%
      emit(0, needUploadBytes)
    }
    xhr.onprogress = (e) => emit(e.loaded, e.lengthComputable ? e.total : 0)

    xhr.onload = () => {
      // 传输收尾：知道总量就补一个 100%，否则保持上一帧（UI 由调用方收尾）
      if (phase === 'download' && xhr.responseText) {
        const len = xhr.getResponseHeader('Content-Length')
        const total = len ? parseInt(len, 10) : 0
        if (total > 0) emit(total, total)
      }
      resolve({ status: xhr.status, text: xhr.responseText ?? '' })
    }
    xhr.onerror = () => reject(new Error('NETWORK'))
    xhr.ontimeout = () => reject(new Error('TIMEOUT'))
    xhr.onabort = () => reject(new Error('ABORT'))
    xhr.send(body)
  })
}

/** 把导出好的 JSON 原文上传到云端，返回取件码 */
export async function uploadCloudData(
  json: string,
  onProgress?: CloudProgressFn,
): Promise<CloudUploadResult> {
  if (!json) throw new Error('没有可上传的数据')
  let res: { status: number; text: string }
  try {
    res = await request(`${CLOUD_DATA_URL}/upload`, 'POST', json, 'upload', onProgress)
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    if (code === 'TIMEOUT') throw new Error('上传超时：数据可能过大或网络较慢，请稍后重试')
    if (code === 'ABORT') throw new Error('上传已取消')
    throw new Error('上传失败：无法连接云同步服务（请检查网络）')
  }
  if (res.status === 413) throw new Error('数据过大，服务器拒绝（上限 64MB）；请缩减图片后再上传')
  if (res.status !== 200) {
    throw new Error(`上传失败 (${res.status})${res.text ? '：' + res.text.slice(0, 120) : ''}`)
  }
  let data: (CloudUploadResult & { ok?: boolean; error?: string }) | null = null
  try {
    data = JSON.parse(res.text)
  } catch {
    throw new Error('上传失败：服务器返回了无法解析的内容')
  }
  if (!data?.code) throw new Error(data?.error || '上传失败：服务器未返回取件码')
  return data
}

/** 用取件码把数据取回来（返回 JSON 原文，交给 importFromJson 解析） */
export async function fetchCloudData(
  code: string,
  onProgress?: CloudProgressFn,
): Promise<string> {
  const clean = (code || '').trim().toUpperCase()
  if (!clean) throw new Error('请输入取件码')
  let res: { status: number; text: string }
  try {
    res = await request(
      `${CLOUD_DATA_URL}/fetch`,
      'POST',
      JSON.stringify({ code: clean }),
      'download',
      onProgress,
    )
  } catch (err) {
    const c = err instanceof Error ? err.message : ''
    if (c === 'TIMEOUT') throw new Error('取回超时：请稍后重试')
    if (c === 'ABORT') throw new Error('取回已取消')
    throw new Error('取回失败：无法连接云同步服务（请检查网络）')
  }
  if (res.status === 404) throw new Error('取件码不存在，或数据已被清理（只保留 24~48 小时）')
  if (res.status === 429) throw new Error('尝试过于频繁，请稍等一分钟再试')
  if (res.status !== 200) throw new Error(`取回失败 (${res.status})`)
  return res.text
}

/** 云端当前存放情况（可选） */
export async function cloudStats(): Promise<{ items: number; bytes: number; max_age_hours: number | null } | null> {
  try {
    const res = await request(`${CLOUD_DATA_URL}/stats`, 'GET', null, 'download', undefined, TIMEOUT_LIGHT_MS)
    if (res.status !== 200) return null
    return JSON.parse(res.text)
  } catch {
    return null
  }
}
