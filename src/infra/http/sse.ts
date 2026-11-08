// sse —— 逐行读取 SSE 响应流（llm.ts 与 backend.ts 共用）
// 回调返回 true 表示提前停止；此时会 cancel 底层连接，不把它挂到 GC。

/** 返回 true 表示到此为止 */
export type SseLineHandler = (line: string) => boolean | void

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 逐行读取，行尾换行符不给回调；流结束时残留的半行也会交出去
 *
 * 读取失败或回调抛错都原样抛出，抛出前先释放连接。
 */
export async function readSseLines(
  body: ReadableStream<Uint8Array>,
  onLine: SseLineHandler,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  /** 尚未按行切分的残留文本 */
  let buffer = ''
  let stopped = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 最后一段可能不完整，等下一个 chunk 补齐
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        if (onLine(stripCr(raw)) === true) {
          stopped = true
          break
        }
      }
      if (stopped) break
    }
    if (!stopped && buffer !== '') onLine(stripCr(buffer))
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    if (stopped) await reader.cancel().catch(() => {})
  }
}
