// =============================================================================
// 模型列表获取(modelList)
// -----------------------------------------------------------------------------
// 从用户填写的 Base URL 拉取该端点提供的全部模型(GET {baseUrl}/models),
// 供设置里的"模型名"直接选,省得手敲 —— 模型名敲错是最常见的 404 来源。
//
// 这是 OpenAI 兼容端点的事实标准接口,但各家返回形状不一致,故做了归一化:
//   - { data: [{ id }] }              OpenAI / DeepSeek / 多数代理(标准)
//   - { models: [{ name }] }          Ollama 风格网关
//   - { models: ["a", "b"] }          部分自建网关
//   - ["a", "b"]                      裸数组
//
// 成功与失败**都**按 (url, apiKey) 缓存:设置弹窗每次打开都会自动拉一次,
// 没有缓存的话同一个坏端点会被反复打,每次都白等一个超时。
// =============================================================================

/** 拉取超时(ms):/models 只是列表接口,不该让用户干等 */
const FETCH_TIMEOUT_MS = 12000

/** 缓存有效期(ms):模型列表变动不频繁,这段时间内不重复请求 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 错误正文截断长度(端点可能返回整页 HTML,原样塞进提示框会撑爆面板) */
const ERROR_TEXT_MAX = 160

/**
 * 服务商可能用来表达"上下文窗口"的字段名(顶层)
 *
 * 标准 OpenAI 形状**不含**该字段(DeepSeek 就只有 id/object/owned_by),
 * 但部分服务商/网关扩展了它:
 *   OpenRouter  context_length        vLLM       max_model_len
 *   聚合站      max_context_length    models.dev limit.context(嵌套)
 * 这些名字都足够专门,不会误命中无关字段,故顶层即可放心探测。
 */
const CONTEXT_FIELD_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
] as const

/**
 * 嵌套容器内的候选字段
 *
 * 额外接受裸 `context`:models.dev 的形状是 limit:{context, input, output}。
 * 只在已确认的容器对象内查,避免顶层 `context` 这种过于宽泛的名字误命中。
 */
const NESTED_CONTEXT_FIELD_KEYS = ['context', ...CONTEXT_FIELD_KEYS] as const

/** 嵌套容器字段:这些对象里也可能放上下文字段 */
const CONTEXT_NESTED_KEYS = ['top_provider', 'limits', 'limit', 'architecture'] as const

/** 远端模型条目 */
export interface RemoteModel {
  /** 模型 id(填入请求体 model 字段的那个) */
  id: string
  /** 服务商给出的上下文窗口(未提供为 undefined,由 modelContext 本地推断兜底) */
  contextLength?: number
}

/** 一次拉取的结果 */
export interface ModelListResult {
  /** 是否成功拿到列表 */
  ok: boolean
  /** 模型条目(已去重排序);ok=false 时为空数组 */
  models: RemoteModel[]
  /** 失败原因(ok=true 时为 '') */
  error: string
}

interface CacheEntry {
  at: number
  result: ModelListResult
}

/** 模块级缓存:key = `${endpoint}\u0000${apiKey}` */
const cache = new Map<string, CacheEntry>()

/** 截断过长的错误正文(压缩空白,便于单行展示) */
function shorten(text: string): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > ERROR_TEXT_MAX ? `${flat.slice(0, ERROR_TEXT_MAX)}…` : flat
}

/**
 * 鉴权类失败(401 / 403)的补充说明
 *
 * 为什么要补:服务商对"没带 Key"和"Key 不对"往往返回**同一句** 401 原文
 * (DeepSeek 就是一句 "Authentication Fails (governor)"),用户看到后第一反应
 * 是去查 Base URL —— 而地址通常是对的。这里把"这次到底带没带 Key"讲清楚,
 * 把排查方向直接指到 Key 上。
 */
function authHint(status: number, apiKey: string): string {
  if (status !== 401 && status !== 403) return ''
  return apiKey
    ? ' (已携带 API Key:请确认它属于此端点、未失效,且账户余额充足)'
    : ' (本次请求未携带 API Key —— 上方「API Key」输入框是空的,请先填写)'
}

/**
 * 由 Base URL 推出 /models 地址
 *
 * 容忍两种常见的填写方式:
 *   - `https://api.deepseek.com/v1`        → …/v1/models
 *   - `https://api.deepseek.com/v1/`       → 末尾斜杠去掉
 *   - `https://…/v1/chat/completions`      → 用户直接粘了完整对话地址,把尾巴剥掉
 *     (llm.ts 会自行追加 /chat/completions,粘贴完整地址是很自然的误操作)
 *
 * @returns 完整地址;baseUrl 为空时返回空串
 */
export function modelsEndpoint(baseUrl: string): string {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
  return base ? `${base}/models` : ''
}

/** 读取一个正整数,否则返回 undefined */
function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * 从一个模型条目里挖出上下文长度
 *
 * 逐层探测:先看顶层候选字段,再看嵌套容器;取第一个正整数。
 * 挖不到返回 undefined —— 由 utils/modelContext 用后缀/内置表兜底。
 */
export function extractContextLength(entry: unknown): number | undefined {
  const obj = readObject(entry)
  if (!obj) return undefined

  for (const key of CONTEXT_FIELD_KEYS) {
    const v = readPositiveInt(obj[key])
    if (v !== undefined) return v
  }

  for (const container of CONTEXT_NESTED_KEYS) {
    const nested = readObject(obj[container])
    if (!nested) continue
    for (const key of NESTED_CONTEXT_FIELD_KEYS) {
      const v = readPositiveInt(nested[key])
      if (v !== undefined) return v
    }
  }

  return undefined
}

/**
 * 把各家的返回形状归一化成模型条目数组
 *
 * 纯函数,便于单独验证:拿真实端点的返回体直接喂进来即可。
 */
export function extractModels(payload: unknown): RemoteModel[] {
  const byId = new Map<string, RemoteModel>()

  const pushEntry = (id: unknown, raw: unknown): void => {
    if (typeof id !== 'string') return
    const trimmed = id.trim()
    if (!trimmed || byId.has(trimmed)) return
    const entry: RemoteModel = { id: trimmed }
    // 只有条目是对象时才可能带上下文字段(裸字符串数组没有)
    const ctx = extractContextLength(raw)
    if (ctx !== undefined) entry.contextLength = ctx
    byId.set(trimmed, entry)
  }

  const readList = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (typeof item === 'string') {
        pushEntry(item, null)
      } else if (item !== null && typeof item === 'object') {
        const o = item as Record<string, unknown>
        // id 优先,兼容 Ollama 风格的 name 与少数网关的 model 字段
        pushEntry(o.id ?? o.name ?? o.model, item)
      }
    }
  }

  if (Array.isArray(payload)) {
    readList(payload)
  } else if (payload !== null && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    readList(p.data)
    // data 为空时才看 models:有的网关两者都有,data 才是权威的
    if (byId.size === 0) readList(p.models)
  }

  // 排序:端点返回顺序各家不同,排好序在下拉里好找
  return Array.from(byId.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 真正发一次请求(不碰缓存) */
async function requestModels(url: string, apiKey: string): Promise<ModelListResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    // 部分端点(本地 Ollama / 内网网关)不需要 Key,带了也不冲突
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      const tail = shorten(detail)
      const head = tail ? `HTTP ${response.status}：${tail}` : `HTTP ${response.status}`
      return { ok: false, models: [], error: head + authHint(response.status, apiKey) }
    }

    const payload: unknown = await response.json()
    const models = extractModels(payload)
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        error: '端点返回里没有模型，请确认地址指向的是 OpenAI 兼容接口（应以 /v1 结尾）',
      }
    }
    return { ok: true, models, error: '' }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, models: [], error: `请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）` }
    }
    // fetch 自身抛 TypeError = 没拿到 HTTP 响应:地址写错 / CORS 预检被拒 / https 页面调 http 接口
    if (err instanceof TypeError) {
      return {
        ok: false,
        models: [],
        error: '无法连接：地址可能有误，或该端点未开放跨域（CORS）',
      }
    }
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取端点提供的模型列表(带缓存)
 *
 * @param baseUrl 用户填写的 Base URL
 * @param apiKey  API Key
 * @param force   true 忽略缓存(用户手动点"获取模型列表"时用)
 */
export async function fetchModelList(
  baseUrl: string,
  apiKey: string,
  force = false,
): Promise<ModelListResult> {
  const url = modelsEndpoint(baseUrl)
  if (!url) return { ok: false, models: [], error: '请先填写 Base URL' }

  const key = `${url}\u0000${apiKey}`
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result

  const result = await requestModels(url, apiKey)
  cache.set(key, { at: Date.now(), result })
  return result
}
