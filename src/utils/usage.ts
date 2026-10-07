// =============================================================================
// 服务商 usage 归一化(usage)
// -----------------------------------------------------------------------------
// 自定义 API 面向任意 OpenAI 兼容服务商,缓存命中字段各不相同:
//   - DeepSeek   : usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
//                  (官方文档:Context Caching,命中数直接给出,无需额外参数)
//   - OpenAI/Azure: usage.prompt_tokens_details.cached_tokens
//                  (需 stream_options.include_usage 才在流式响应中返回)
//   - Anthropic 兼容: usage.cache_read_input_tokens / cache_creation_input_tokens
//   - 其他代理   : usage.cached_tokens(顶层,非标准)
//
// 另外记录"哪些 baseUrl 不支持 stream_options"——部分非官方端点会直接
// 400 Unknown parameter: stream_options(实证见 Cherry Studio issue #11652),
// 需要降级重试并记住,避免每次都先失败一轮。
// =============================================================================

/** 缓存命中字段的来源标识(面板据此说明"命中数从哪来") */
export type UsageSource = 'deepseek' | 'openai' | 'anthropic' | 'generic' | 'unknown'

/** 归一化后的用量 */
export interface NormalizedUsage {
  /**
   * 提示词(prompt)token **总数**,含命中缓存的部分
   *
   * 口径统一在此处完成,因为各厂商对"输入 token"的定义并不一致:
   *   - OpenAI / DeepSeek / 多数代理:prompt_tokens 已是总数
   *   - Anthropic:input_tokens **不含**缓存读取与写入部分,必须相加
   * 命中率 = cachedTokens / inputTokens,只有分母是总数时才成立。
   */
  inputTokens: number
  /** 输出(completion)token 总数 */
  outputTokens: number
  /** 其中命中缓存的输入 token 数 */
  cachedTokens: number
  /** 未命中缓存的输入 token 数(服务商未上报时为 null) */
  cacheMissTokens: number | null
  /** 命中字段来源 */
  source: UsageSource
}

/** 读取一个非负有限数字,否则返回 null */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 读取一个对象字段,非对象返回 null */
function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * 把服务商返回的 usage 原始对象归一化为统一形状
 *
 * @param raw SSE 数据块中的 usage 字段(未知形状,内部逐字段校验)
 * @returns   归一化结果;无可用 token 数时返回 null
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  const u = readObject(raw)
  if (!u) return null

  const promptTotal = readNumber(u.prompt_tokens)
  const altInput = readNumber(u.input_tokens)
  const anthropicRead = readNumber(u.cache_read_input_tokens)
  const anthropicCreate = readNumber(u.cache_creation_input_tokens)

  // 把"输入 token"统一成提示词总数(见 NormalizedUsage.inputTokens 的说明)。
  //
  // Anthropic 的口径是坑:官方文档明确 input_tokens 是
  // "Number of input tokens which were not read from or used to create a cache",
  // 即**不含**缓存部分。若拿它当分母,cache_read / input_tokens 会算出
  // 远超 100% 的荒谬命中率,同时还会把估算器的自校准比值带偏。
  let inputTokens: number | null
  if (promptTotal !== null) {
    // OpenAI / DeepSeek / 多数代理:prompt_tokens 本身即总数(含命中部分)
    inputTokens = promptTotal
  } else if (altInput !== null) {
    // Anthropic 风格:input_tokens 只是"未走缓存"的那部分,需补齐总数
    inputTokens = altInput + (anthropicRead ?? 0) + (anthropicCreate ?? 0)
  } else {
    inputTokens = null
  }

  const outputTokens = readNumber(u.completion_tokens) ?? readNumber(u.output_tokens)
  // 两个都没有 → 这个 usage 没有价值,当作没上报
  if (inputTokens === null && outputTokens === null) return null

  const details = readObject(u.prompt_tokens_details)

  // 按"字段专属性"从强到弱探测,避免把别家的 0 误判成本家的命中数
  const deepseekHit = readNumber(u.prompt_cache_hit_tokens)
  const openaiCached = details ? readNumber(details.cached_tokens) : null
  const genericCached = readNumber(u.cached_tokens)

  let cachedTokens = 0
  let source: UsageSource = 'unknown'
  if (deepseekHit !== null) {
    cachedTokens = deepseekHit
    source = 'deepseek'
  } else if (openaiCached !== null) {
    cachedTokens = openaiCached
    source = 'openai'
  } else if (anthropicRead !== null) {
    cachedTokens = anthropicRead
    source = 'anthropic'
  } else if (genericCached !== null) {
    cachedTokens = genericCached
    source = 'generic'
  }

  const cacheMissTokens = readNumber(u.prompt_cache_miss_tokens) ?? anthropicCreate

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens,
    cacheMissTokens,
    source,
  }
}

// ---- stream_options 能力记忆 -------------------------------------------------
// 记录明确拒绝 stream_options 的端点,后续请求不再发送该参数(省掉一次失败往返)。

/** 记忆用的 localStorage key(与设置 store 的 STORAGE_PREFIX 无关,独立命名空间) */
const UNSUPPORTED_KEY = 'endfield-baker-usage-no-stream-options'

/** 最多记住多少个端点,避免无限增长 */
const UNSUPPORTED_MAX = 10

/** 读取已记录的不支持端点列表 */
function readUnsupported(): string[] {
  try {
    const raw = localStorage.getItem(UNSUPPORTED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** 判断该端点是否已被记录为"不支持 stream_options" */
export function isStreamOptionsUnsupported(baseUrl: string): boolean {
  if (!baseUrl) return false
  return readUnsupported().indexOf(baseUrl) !== -1
}

/** 记录该端点不支持 stream_options */
export function markStreamOptionsUnsupported(baseUrl: string): void {
  if (!baseUrl) return
  try {
    const list = readUnsupported().filter((v) => v !== baseUrl)
    list.push(baseUrl)
    // 只保留最近 UNSUPPORTED_MAX 个
    localStorage.setItem(UNSUPPORTED_KEY, JSON.stringify(list.slice(-UNSUPPORTED_MAX)))
  } catch {
    // 静默失败:记忆丢失只是多一次失败往返,不影响功能
  }
}

/**
 * 判断错误正文是否表示"不认识 stream_options 参数"
 *
 * 覆盖常见措辞:OpenAI 官方 `Unrecognized request argument`,
 * 部分网关 `Unknown parameter`,以及更宽泛的 invalid/unsupported 组合。
 */
export function looksLikeStreamOptionsError(errText: string): boolean {
  if (!errText) return false
  const t = errText.toLowerCase()
  if (t.indexOf('stream_options') === -1) return false
  return (
    t.indexOf('unknown') !== -1 ||
    t.indexOf('unrecognized') !== -1 ||
    t.indexOf('unsupported') !== -1 ||
    t.indexOf('invalid') !== -1 ||
    t.indexOf('not supported') !== -1 ||
    t.indexOf('extra') !== -1
  )
}

// ---- 数据可信度 -------------------------------------------------------------

/** 数据可信度档位 */
export type DataStatusLevel = 'measured' | 'partial' | 'estimated' | 'stale' | 'none'

/** 数据可信度描述 */
export interface DataStatus {
  level: DataStatusLevel
  /** 短标签(面板标题行) */
  label: string
  /** 一句话说明(告诉用户这些数字到底能不能信) */
  detail: string
}

/** 缓存字段来源 → 可读名称 */
const SOURCE_LABEL: Record<UsageSource, string> = {
  deepseek: 'DeepSeek 的 prompt_cache_hit_tokens',
  openai: 'OpenAI 的 prompt_tokens_details.cached_tokens',
  anthropic: 'Anthropic 的 cache_read_input_tokens',
  generic: '通用 cached_tokens',
  unknown: '无缓存字段',
}

/**
 * 描述一次请求数据的可信度
 *
 * 抽成纯函数的原因:这是"面板数字能不能信"的唯一判据,必须能被单独验证。
 *
 * 五个档位:
 *   measured  实测      —— 命中数来自服务商上报,是计费口径,可直接采信
 *   partial   部分实测  —— usage 有、缓存字段没有:输入输出实测,命中情况未知
 *   estimated 本地估算  —— 连 usage 都没有,全部为本地推算
 *   stale     端点已变更 —— 已有数据来自旧端点,不代表当前配置
 *   none      尚无请求
 *
 * @param record         最近一次请求记录(可为 null)
 * @param currentBaseUrl 当前配置的 baseUrl(端点变了旧数据就失效)
 */
export function describeDataStatus(
  record: { estimated: boolean; source: UsageSource; endpoint?: string } | null,
  currentBaseUrl: string,
): DataStatus {
  if (!record) {
    return { level: 'none', label: '尚无请求', detail: '发一条消息后即可看到实测用量与缓存命中' }
  }
  // 端点换了但还没发新请求:旧数据回答不了"当前端点会不会上报缓存"
  if (record.endpoint && currentBaseUrl && record.endpoint !== currentBaseUrl) {
    return {
      level: 'stale',
      label: '端点已变更',
      detail: '下方数据来自之前的端点,发一条消息后会按新端点重新统计',
    }
  }
  if (record.estimated) {
    return {
      level: 'estimated',
      label: '本地估算',
      detail: '该端点未返回 usage,输入/输出为本地推算,命中率不可知',
    }
  }
  if (record.source === 'unknown') {
    return {
      level: 'partial',
      label: '部分实测',
      detail: '端点返回了 usage 但不含缓存字段:输入/输出实测,命中情况未知',
    }
  }
  return { level: 'measured', label: '实测', detail: `命中数来自 ${SOURCE_LABEL[record.source]}` }
}

// ---- 展示格式化 -------------------------------------------------------------

/** 千分位格式化 token 数(非法值回退 0) */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  return Math.round(n).toLocaleString('en-US')
}

/** 格式化百分比(0-100,保留一位小数;0 与 100 不带小数) */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  const clamped = Math.min(100, Math.max(0, value))
  // 端点值取整,避免出现 "0.0%" / "100.0%" 这类噪声
  if (clamped >= 100 || clamped === 0) return `${Math.round(clamped)}%`
  return `${clamped.toFixed(1)}%`
}
