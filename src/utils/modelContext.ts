// modelContext —— 从模型名推断上下文窗口（纯推断，不联网）
// 标准 OpenAI 兼容的 GET /models 不含窗口长度，只有部分服务商扩展了该字段，
// 因此按 endpoint > 模型名后缀 > models.dev 三级推断；都拿不到就返回 0，
// 留空让用户自己填 —— 猜出来的数字会让占用率与压缩时机都失真。

export type ContextSource = 'endpoint' | 'suffix' | 'library' | 'none'

export interface ContextGuess {
  /** source 为 none 时是 0，表示没获取到 */
  contextWindow: number
  source: ContextSource
}

/** 外部已探到的值；推断层自己不联网 */
export interface ContextSources {
  /** 服务商 /models 返回的真实值，优先级最高 */
  fromApi?: number
  /** models.dev 在线模型库的值 */
  fromLibrary?: number
}

/**
 * 从 128k / 32K / 1m 后缀解析窗口。
 * 区间过滤是必须的，否则 `gpt-4-0613`、`qwen2.5-7b` 里的数字会被当成窗口大小。
 */
export function parseContextSuffix(modelId: string): number | undefined {
  const m = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)\s*([km])/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = m[2]
  const value = unit === 'm' ? n * 1048576 : n * 1024
  // 合理区间：8K ~ 10M
  if (value < 8192 || value > 10485760) return undefined
  return Math.floor(value)
}

/**
 * 优先级 endpoint > suffix > library。
 * 都拿不到就返回 0 —— 刻意不预置默认值，否则占用率与压缩时机都会失真。
 */
export function guessContextWindow(modelId: string, sources: ContextSources = {}): ContextGuess {
  const id = (modelId || '').trim()
  const { fromApi, fromLibrary } = sources

  if (fromApi !== undefined && fromApi > 0) {
    return { contextWindow: fromApi, source: 'endpoint' }
  }
  if (!id) {
    return { contextWindow: 0, source: 'none' }
  }
  const suffix = parseContextSuffix(id)
  if (suffix !== undefined) {
    return { contextWindow: suffix, source: 'suffix' }
  }
  if (fromLibrary !== undefined && fromLibrary > 0) {
    return { contextWindow: fromLibrary, source: 'library' }
  }
  return { contextWindow: 0, source: 'none' }
}
