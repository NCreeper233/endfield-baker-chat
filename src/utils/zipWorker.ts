// zipWorker —— 导入导出的序列化 Worker
// ZIP 的 JSON 序列化、JSZip 压缩/解压、base64 转换都放独立线程，避免大历史
// 在低端机上阻塞主线程或 OOM。主线程只收最终结果。

import { exportToZip, importFromZip } from './zipExport'

/** 分片转换，避免单次超长字符串峰值 */
function blobToBase64InWorker(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取导出数据失败'))
    reader.readAsArrayBuffer(blob)
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result as ArrayBuffer)
        let binary = ''
        // 外层按 8MB 分块;内层每次只拼 8K 个字符,
        // 避免 String.fromCharCode.apply 一次传过多参数导致 RangeError(栈溢出)
        const CHUNK = 8 * 1024 * 1024
        const STEP = 8192
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
          for (let j = 0; j < slice.length; j += STEP) {
            const part = slice.subarray(j, Math.min(j + STEP, slice.length))
            binary += String.fromCharCode.apply(null, part as unknown as number[])
          }
        }
        resolve(btoa(binary))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('base64 编码失败'))
      }
    }
  })
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    if (msg.type === 'export') {
      const { blob, filteredImages, totalBytes } = await exportToZip(
        msg.cards,
        msg.myGender,
        msg.stripVariantIndex,
        msg.promptOverrides,
        msg.settingsSnapshot,
      )
      const base64 = await blobToBase64InWorker(blob)
      self.postMessage({
        ok: true,
        seq: msg.seq,
        type: 'export',
        base64,
        filteredImages,
        totalBytes,
      })
    } else if (msg.type === 'import') {
      const payload = await importFromZip(msg.blob)
      self.postMessage({ ok: true, seq: msg.seq, type: 'import', payload })
    } else {
      self.postMessage({ ok: false, seq: msg.seq, type: msg.type, error: '未知消息类型' })
    }
  } catch (err) {
    self.postMessage({
      ok: false,
      seq: msg.seq,
      type: msg.type,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
