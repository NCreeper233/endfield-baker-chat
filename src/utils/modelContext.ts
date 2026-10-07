// =============================================================================
// 模型浏览器上下文窗口推断(modelContext)
// -----------------------------------------------------------------------------
// 纯推断层:**不做任何网络请求**,只根据"模型名 + 服务商可能给出的字段值"给答案。
// (拉取 /models 的唯一实现处是 utils/modelList.ts,避免两处各打一遍同一个接口)
//
// 为什么接口探测靠不住:
//   标准 OpenAI 兼容的 GET /models 只返回 { id, object, owned_by } ——
//   DeepSeek 官方文档的 List Models 响应就是这个形状,**不含上下文长度**
//   (已核对 https://api-docs.deepseek.com/api/list-models)。
//   只有部分服务商扩展了该接口,例如 OpenRouter 的 data[].context_length
//   与 data[].top_provider.context_length,vLLM 的 max_model_len。
//
// 因此采用三级推断,按可信度从高到低:
//   1. endpoint —— 服务商在 /models 里给出的真实字段(由 modelList 解析后传进来)
//   2. suffix   —— 从模型名里的 128k / 32k / 1m 等后缀解析(与厂商无关)
//   3. library  —— models.dev 在线模型库
//   都拿不到时返回 none:**留空交给用户自己填**,不猜、也不预置任何默认数字。
//
// (本项目曾内置一张手写模型窗口表兜底,已移除:它必然滞后 —— 表里
//  deepseek-chat 还写着 131072,而线上早已是 deepseek-v4-* / 1,000,000。
//  一个会过期的数字比没有数字更糟,因为它看起来像是可信的。)
// =============================================================================

/** 推断来源 */
export type ContextSource = 'endpoint' | 'suffix' | 'library' | 'none'

/** 推断结果 */
export interface ContextGuess {
  /** 推断出的上下文窗口;source 为 none 时是 0(表示"没获取到,交给用户填") */
  contextWindow: number
  source: ContextSource
}

/**
 * 外部已探到的值(由调用方喂进来,推断层自己不联网)
 */
export interface ContextSources {
  /** 服务商在 /models 里给出的真实值(优先级最高) */
  fromApi?: number
  /** models.dev 在线模型库给出的值 */
  fromLibrary?: number
}


/**
 * 从模型名后缀解析窗口大小
 *
 * 匹配 128k / 32K / 1m 这类写法(厂商普遍用它标注窗口档位)。
 * 1m = 1,048,576(二进制兆),与厂商口径一致。
 *
 * 合理区间过滤是必须的:否则 "gpt-4-0613"、"qwen2.5-7b" 里的数字会被
 * 当成窗口大小。
 */
export function parseContextSuffix(modelId: string): number | undefined {
  const m = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)\s*([km])/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const unit = m[2]
  const value = unit === 'm' ? n * 1048576 : n * 1024
  // 合理区间:8K ~ 10M
  if (value < 8192 || value > 10485760) return undefined
  return Math.floor(value)
}

/**
 * 推断上下文窗口(endpoint > suffix > library)
 *
 * 优先级的依据是"谁更可信":
 *   endpoint —— 该端点自己报的,就是它真实的限制
 *   suffix   —— 模型名里写着 32k,这是厂商的明确标注
 *   library  —— models.dev 在线模型库,覆盖广且持续更新
 *
 * 三者都拿不到就返回 none(contextWindow = 0):**留空让用户自己填**。
 * 这里刻意不预置任何默认数字 —— 一个猜出来的窗口值会让用量面板的占用率
 * 与自动压缩时机都失真,而用户还以为那是模型真实的限制。
 *
 * @param modelId 模型名
 * @param sources 外部已探到的值(接口值 / 在线库值)
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
