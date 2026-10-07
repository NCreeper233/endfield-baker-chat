// =============================================================================
// models.dev 在线模型库(modelsDev)
// -----------------------------------------------------------------------------
// https://models.dev 是一个公开的模型元数据库:GET /api.json 返回全部服务商
// 与模型,含 limit.context(上下文窗口)、limit.output、价格等。
//
// 为什么值得接:
//   1. 覆盖广 —— 7847 个模型 / 222 个服务商,远超手写表能维护的规模
//   2. 够新 —— 手写表必然滞后(实例:表里 deepseek-chat 还是 131072,
//      而 models.dev 上 DeepSeek 已是 deepseek-v4-* / 1,000,000)
//   3. 可跨域 —— 响应带 access-control-allow-origin: * ,浏览器可直连
//
// 体积与缓存:
//   解压后约 4.5 MB,但 brotli 传输只有 ~330 KB。仍然**必须缓存** ——
//   24 小时内复用同一份内存数据,且并发查询共享同一个请求(single-flight)。
//
// 【关键:必须按服务商匹配,不能只按模型名查】
//   裸模型名在不同服务商下冲突严重:2545 个裸名里有 466 个 context 不一致
//   (deepseek-v4-pro 一家一个数,能凑出 8 种取值)。
//   所以先用 baseUrl 的 host 去匹配服务商的 api 字段(deepseek 的 api 就是
//   https://api.deepseek.com),命中后只在该服务商内查;
//   匹配不到服务商时,只在"全库同名模型取值唯一"时才回答 ——
//   有歧义宁可返回 null 交给用户手填,也不猜一个可能错十倍的数字。
// =============================================================================

/** 数据源地址 */
const API_URL = 'https://models.dev/api.json'

/** 缓存有效期(ms):24 小时。模型窗口变动不频繁,一天一拉足够 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 拉取超时(ms):4.5MB 解压后还要解析,给足时间 */
const TIMEOUT_MS = 30000

/**
 * 失败后的重试冷却(ms)
 *
 * 没有它的话,每次换模型/改地址都会重新发起一次注定失败的请求,
 * 而每次都要先等满 30 秒超时 —— 断网时体验会非常糟。
 */
const FAIL_RETRY_MS = 60000

/** 一个服务商的索引 */
interface ProviderIndex {
  id: string
  name: string
  /** 模型 id(小写)→ 上下文窗口 */
  models: Map<string, number>
}

/** 全库索引 */
interface Library {
  providers: Map<string, ProviderIndex>
  /** 服务商 api 的 host(小写)→ providerId */
  byHost: Map<string, string>
  /**
   * 全库裸模型名索引(小写)
   *
   * 值 = 上下文窗口;**null 表示该名字在多个服务商下取值不一致**,
   * 此时拒绝回答(见文件头说明)。
   */
  bare: Map<string, number | null>
}

/** 一次命中的结果 */
export interface LibraryHit {
  contextWindow: number
  /** 命中的服务商(用于在界面上标注"这个数字是谁给的") */
  providerName: string
  /** 命中的模型 id */
  modelId: string
  /** 是否靠 baseUrl 精确匹配到服务商(true)还是退化成全库唯一名匹配(false) */
  providerMatched: boolean
}

/** 抓取状态(界面据此显示"查询中…") */
export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

let library: Library | null = null
let loadedAt = 0
let inflight: Promise<Library | null> | null = null
let status: LibraryStatus = 'idle'
let lastError = ''
/** 最近一次失败时刻(用于退避,避免每次都白等一个超时) */
let failedAt = 0

/** 当前抓取状态 */
export function libraryStatus(): LibraryStatus {
  return status
}

/** 最近一次失败原因(status 为 error 时有效) */
export function libraryError(): string {
  return lastError
}

/** 取出 URL 的 host(小写,去掉端口与路径);解析失败返回空串 */
function hostOf(rawUrl: string): string {
  const s = String(rawUrl || '').trim()
  if (!s) return ''
  try {
    return new URL(s).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 模型 id 归一化(小写去空白) */
function norm(id: string): string {
  return String(id || '').trim().toLowerCase()
}

/** 取模型名的裸名部分(去掉 `provider/` 前缀) */
function bareOf(id: string): string {
  const i = id.lastIndexOf('/')
  return i === -1 ? id : id.slice(i + 1)
}

/** 读取一个正整数,否则 undefined */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * 把 api.json 编译成查询索引(纯函数,便于单独验证)
 *
 * @param payload /api.json 的解析结果
 */
export function buildLibrary(payload: unknown): Library {
  const providers = new Map<string, ProviderIndex>()
  const byHost = new Map<string, string>()
  const bare = new Map<string, number | null>()

  const root = asObject(payload)
  if (!root) return { providers, byHost, bare }

  for (const key of Object.keys(root)) {
    const p = asObject(root[key])
    if (!p) continue
    const id = typeof p.id === 'string' && p.id ? p.id : key
    const name = typeof p.name === 'string' && p.name ? p.name : id

    const host = hostOf(typeof p.api === 'string' ? p.api : '')
    // host 冲突时先到先得:两家服务商共用一个网关的情况极少,不值得为它加复杂度
    if (host && !byHost.has(host)) byHost.set(host, id)

    const models = new Map<string, number>()
    const rawModels = asObject(p.models)
    if (rawModels) {
      for (const mKey of Object.keys(rawModels)) {
        const m = asObject(rawModels[mKey])
        if (!m) continue
        const limit = asObject(m.limit)
        const ctx = positiveInt(limit ? limit.context : undefined)
        if (ctx === undefined) continue

        const mid = typeof m.id === 'string' && m.id ? m.id : mKey
        const full = norm(mid)
        const bareId = bareOf(full)
        // 服务商内部两种写法都登记:带前缀的 id 与裸名
        models.set(full, ctx)
        if (!models.has(bareId)) models.set(bareId, ctx)

        // 全库裸名:同名同值才可用,出现分歧就标记为"歧义"
        if (bare.has(bareId)) {
          if (bare.get(bareId) !== ctx) bare.set(bareId, null)
        } else {
          bare.set(bareId, ctx)
        }
      }
    }

    providers.set(id, { id, name, models })
  }

  return { providers, byHost, bare }
}

/** 拉取并编译(单飞:并发调用共享同一个请求) */
async function loadLibrary(force = false): Promise<Library | null> {
  if (!force && library && Date.now() - loadedAt < CACHE_TTL_MS) return library
  // 刚失败过:冷却期内直接放弃,不再打网络(否则每次换模型都要白等一次超时)
  if (!force && status === 'error' && Date.now() - failedAt < FAIL_RETRY_MS) return null
  if (inflight) return inflight

  status = 'loading'
  lastError = ''
  inflight = (async (): Promise<Library | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(API_URL, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: unknown = await response.json()
      const built = buildLibrary(payload)
      if (built.providers.size === 0) throw new Error('返回内容为空或格式无法识别')
      library = built
      loadedAt = Date.now()
      status = 'ready'
      return built
    } catch (err) {
      status = 'error'
      failedAt = Date.now()
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = `请求超时（${TIMEOUT_MS / 1000} 秒）`
      } else if (err instanceof TypeError) {
        // fetch 自身抛 TypeError = 没拿到 HTTP 响应:断网 / 被代理或广告拦截器拦下
        lastError = '无法连接，可能网络不通或被拦截'
      } else {
        lastError = err instanceof Error ? err.message : String(err)
      }
      return null
    } finally {
      clearTimeout(timer)
      inflight = null
    }
  })()

  return inflight
}

/**
 * 在模型库里查上下文窗口
 *
 * 匹配顺序:
 *   1. baseUrl 的 host → 服务商 → 该服务商下的模型(full id / 裸名)
 *   2. 兜底:全库裸名 —— **仅当该名字全库取值唯一**时才返回
 *
 * @param modelId 用户填写的模型名
 * @param baseUrl 用户填写的 Base URL(用于精确匹配服务商)
 * @param force   true 时忽略缓存重新拉取
 * @returns 命中结果;查不到 / 有歧义 / 拉取失败一律返回 null(由调用方退回本地推断)
 */
export async function lookupModelContext(
  modelId: string,
  baseUrl: string,
  force = false,
): Promise<LibraryHit | null> {
  const target = norm(modelId)
  if (!target) return null

  const lib = await loadLibrary(force)
  if (!lib) return null

  const bareId = bareOf(target)
  const host = hostOf(baseUrl)
  const providerId = host ? lib.byHost.get(host) : undefined

  if (providerId) {
    const provider = lib.providers.get(providerId)
    if (provider) {
      const hit =
        provider.models.get(target) ??
        provider.models.get(bareId) ??
        provider.models.get(norm(`${providerId}/${bareId}`))
      if (hit !== undefined) {
        return {
          contextWindow: hit,
          providerName: provider.name,
          modelId: target,
          providerMatched: true,
        }
      }
    }
  }

  // 兜底:全库唯一名(null 表示有歧义 → 拒绝回答,交回用户手填)
  const fallback = lib.bare.get(bareId)
  if (typeof fallback === 'number') {
    return { contextWindow: fallback, providerName: 'models.dev 全库', modelId: bareId, providerMatched: false }
  }
  return null
}
