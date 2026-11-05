// =============================================================================
// 后端 RAG 检索(自定义 API / 旧版直连)
// -----------------------------------------------------------------------------
// 默认 API 模式下,检索由后端网关完成(请求体里的 use_rag 字段)。自定义 /
// 旧版直连不经过网关,于是这里直接调用后端的检索服务,把命中的语料拼成一段
// system 上下文注入请求 —— 两种模式吃的是同一套语料库。
//
// 接口契约(后端固定):
//   POST https://rag.peilika.beer/retrieve
//   Content-Type: text/plain
//   body: 查询文本(纯文本,不包 JSON)
//   返回: { query, count, elapsed_ms, results: [{ rank, score, title, category, text }] }
//
// 检索失败一律**静默降级**:拿不到语料就当作没有,绝不让它拖垮整条回复。
// =============================================================================

/** 后端检索服务地址 */
export const RAG_RETRIEVE_URL = 'https://rag.peilika.beer/retrieve'

/** 检索服务单次最多返回几条(超出该值没有意义:服务端就只给这么多) */
export const RAG_MAX_TOP_K = 5

/** 默认带几条语料进请求 */
export const DEFAULT_RAG_TOP_K = 3

/** 单次检索的超时(毫秒):检索是锦上添花,不值得让用户等太久 */
const RAG_TIMEOUT_MS = 6000

/** 一条命中结果 */
export interface RagHit {
  rank?: number
  score?: number
  title?: string
  category?: string
  text?: string
}

/** 检索返回体 */
interface RagResponse {
  results?: RagHit[]
}

/**
 * 清掉语料里的标记
 *
 * 语料正文里混着 `<@nar.quote>…</>`、`<@nar.center>…</>` 这类排版标记,
 * 那是前端渲染用的,直接丢给自定义 API 的模型会被当成奇怪的内容念出来。
 */
function cleanRagText(raw: string): string {
  return raw
    .replace(/<@[^>]*>/g, '')
    .replace(/<\/>/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 调用后端检索
 *
 * @param query 查询文本(一般是玩家这一句)
 * @param signal 外部中止信号(玩家点了停止 / 切换会话)
 * @returns 命中结果数组;查询为空、超时、网络错误一律返回空数组
 */
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

/**
 * 把命中结果拼成一段可直接塞进 system 的上下文
 *
 * @param hits  检索结果(已按 score 从高到低)
 * @param topK  最多取几条(默认 5 = 服务端返回的全部);越界值会被夹到 1~RAG_MAX_TOP_K
 * @returns 拼好的文本;没有有效内容时返回空串(调用方据此跳过注入)
 */
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
