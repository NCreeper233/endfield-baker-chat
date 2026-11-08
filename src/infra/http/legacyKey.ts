// legacyKey —— Legacy 模式内置 Key 的运行时获取（首次拉取后缓存）
// 放在 infra 而非 llm.ts：请求构造器要用它，而 llm.ts 会 import 请求构造器，留在一起就是循环依赖。

let cachedKey = ''
let fetching: Promise<string> | null = null

/** 服务端从环境变量读取，前端不硬编码 */
export async function fetchLegacyApiKey(): Promise<string> {
  if (cachedKey) return cachedKey
  if (fetching) return fetching

  fetching = fetch('/api/legacy-key', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d: unknown) => {
      const key = (d as { apiKey?: string })?.apiKey || ''
      if (!key) throw new Error('Legacy API Key 未配置')
      cachedKey = key
      return key
    })
    .catch((err) => {
      // 失败要清空，否则后续调用会一直复用这个 rejected promise
      fetching = null
      throw new Error(`获取 Legacy API Key 失败: ${err instanceof Error ? err.message : String(err)}`)
    })

  return fetching
}
