// rag —— 后端 RAG 检索（自定义 API / 旧版直连）
// 默认 API 的检索由网关完成；另外两种模式在这里直连检索服务，把命中语料拼成
// system 上下文。接口：POST /retrieve，body 是纯文本查询。失败一律静默降级。

/** 检索服务地址 */
export const RAG_RETRIEVE_URL = 'https://rag.peilika.beer/retrieve'

/** 服务端最多返回的条数 */
export const RAG_MAX_TOP_K = 5

export const DEFAULT_RAG_TOP_K = 3

/** 检索是锦上添花，不值得让用户等太久 */
const RAG_TIMEOUT_MS = 6000

export interface RagHit {
  rank?: number
  score?: number
  title?: string
  category?: string
  text?: string
}

interface RagResponse {
  results?: RagHit[]
}

/** 语料正文混着 `<@nar.quote>` 这类前端排版标记，直接给模型会被念出来 */
function cleanRagText(raw: string): string {
  return raw
    .replace(/<@[^>]*>/g, '')
    .replace(/<\/>/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 查询为空、超时、网络错误一律返回空数组；signal 用于玩家点停止 / 切会话 */
export async function retrieveRag(query: string, signal?: AbortSignal): Promise<RagHit[]> {
  const text = query.trim()
  if (!text) return []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS)
  // 外部中止 → 一并中止本次检索
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    const res = await fetch(RAG_RETRIEVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as RagResponse
    return Array.isArray(data.results) ? data.results : []
  } catch {
    // 超时 / 中断 / 网络失败 / 非 JSON:都当作"这次没有检索结果"
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** hits 已按 score 排序；topK 越界会夹到 1~RAG_MAX_TOP_K；无有效内容返回空串 */
export function formatRagContext(hits: RagHit[], topK = RAG_MAX_TOP_K): string {
  const lines: string[] = []
  const limit = Math.min(RAG_MAX_TOP_K, Math.max(1, Math.round(Number(topK) || RAG_MAX_TOP_K)))

  for (const hit of hits.slice(0, limit)) {
    const body = cleanRagText(hit.text ?? '')
    if (!body) continue
    const tag = [hit.category, hit.title].map((s) => (s ?? '').trim()).filter(Boolean).join(' · ')
    lines.push(tag ? `· ${tag}：${body}` : `· ${body}`)
  }

  if (!lines.length) return ''

  return [
    '【设定检索结果】',
    '以下资料与玩家这句话相关，回答时可以自然引用其中的设定、名词与细节；',
    '不必逐条复述，也不要提及"检索""资料"这类字眼。',
    '',
    ...lines,
  ].join('\n')
}

/** 一步到位:检索 + 拼装(失败时返回空串) */
export async function buildRagContext(
  query: string,
  signal?: AbortSignal,
  topK = RAG_MAX_TOP_K,
): Promise<string> {
  const hits = await retrieveRag(query, signal)
  return formatRagContext(hits, topK)
}
