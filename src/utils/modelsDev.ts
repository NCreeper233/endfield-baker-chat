// modelsDev —— models.dev 在线模型库（含 limit.context 与价格），缓存 24 小时、并发单飞
// ⚠️ 必须按服务商匹配：裸模型名在不同服务商下取值常不一致，先用 baseUrl 的 host
// 定位服务商；匹配不到时只有「全库同名取值唯一」才回答，有歧义宁可返回 null。

/** 数据源地址 */
const API_URL = 'https://models.dev/api.json'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 4.5MB 解压后还要解析，给足时间 */
const TIMEOUT_MS = 30000

/** 失败冷却：否则每次换模型都要白等一个 30 秒超时 */
const FAIL_RETRY_MS = 60000

interface ProviderIndex {
  id: string
  name: string
  /** 模型 id（小写）→ 上下文窗口 */
  models: Map<string, number>
}

interface Library {
  providers: Map<string, ProviderIndex>
  /** 服务商 api 的 host（小写）→ providerId */
  byHost: Map<string, string>
  /** 全库裸模型名；null 表示同名在多个服务商下取值不一致，拒绝回答 */
  bare: Map<string, number | null>
}

/** 一次命中：providerMatched 为 false 表示退化成全库唯一名匹配 */
export interface LibraryHit {
  contextWindow: number
  providerName: string
  modelId: string
  providerMatched: boolean
}

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

let library: Library | null = null
let loadedAt = 0
let inflight: Promise<Library | null> | null = null
let status: LibraryStatus = 'idle'
let lastError = ''
/** 最近一次失败时刻，用于退避 */
let failedAt = 0

export function libraryError(): string {
  return lastError
}

/** 小写 host，去掉端口与路径；解析失败返回空串 */
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

/** 把 api.json 编译成查询索引（纯函数，便于单独验证） */
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
 * 先按 baseUrl 的 host 定位服务商再查；兜底的全库裸名查询仅在该名字取值唯一时返回。
 * 查不到 / 有歧义 / 拉取失败一律返回 null，由调用方退回本地推断。
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
