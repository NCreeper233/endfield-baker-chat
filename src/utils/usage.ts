// usage —— 服务商 usage 的归一化
// 自定义 API 面向任意 OpenAI 兼容服务商，缓存命中字段各不相同：
//   DeepSeek 用 prompt_cache_hit/miss_tokens，OpenAI/Azure 用
//   prompt_tokens_details.cached_tokens，Anthropic 兼容用 cache_read/creation，
//   还有些代理直接给顶层 cached_tokens。
// 另外记住哪些 baseUrl 不支持 stream_options（会直接 400），降级重试后不再发。

/** 缓存命中字段的来源标识(面板据此说明"命中数从哪来") */
export type UsageSource = 'deepseek' | 'openai' | 'anthropic' | 'generic' | 'unknown'

/** 归一化后的用量 */
export interface NormalizedUsage {
  /**
   * 提示词 token 总数，含命中缓存的部分。
   *
   * 口径必须统一：OpenAI / DeepSeek 的 prompt_tokens 已是总数，Anthropic 的
   * input_tokens 不含缓存读写、必须相加。命中率 = cached / inputTokens 只在
   * 分母是总数时成立。
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

/** raw 形状未知，内部逐字段校验；无可用 token 数时返回 null */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  const u = readObject(raw)
  if (!u) return null

  const promptTotal = readNumber(u.prompt_tokens)
  const altInput = readNumber(u.input_tokens)
  const anthropicRead = readNumber(u.cache_read_input_tokens)
  const anthropicCreate = readNumber(u.cache_creation_input_tokens)

  // Anthropic 的坑：input_tokens 是「未从缓存读取、也未用于创建缓存」的数量，
  // 拿它当分母会算出远超 100% 的命中率，还会把估算器的自校准比值带偏。
  let inputTokens: number | null
  if (promptTotal !== null) {
    inputTokens = promptTotal
  } else if (altInput !== null) {
    // Anthropic 风格：补齐缓存读写部分
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

// stream_options 能力记忆
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

// 数据可信度

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
 * 「面板数字能不能信」的唯一判据，抽成纯函数以便单独验证。
 * measured 实测 / partial 有 usage 无缓存字段 / estimated 全本地推 / stale 端点已变 / none 无请求。
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

// 展示格式化

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
