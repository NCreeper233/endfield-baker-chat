// =============================================================================
// Vercel Edge Function: AI 聊天流式代理
// -----------------------------------------------------------------------------
// 作为前端与 AI API 之间的中间层:
//   - 前端 POST /api/chat(无需 API Key)
//   - 本函数从环境变量读取 AGNES_API_KEY,转发请求到 AI API
//   - 流式(SSE)响应原样透传回前端
//
// 部署:Vercel 自动识别 api/ 目录为 Serverless Function
// 配置:在 Vercel 后台 Settings → Environment Variables 添加 AGNES_API_KEY
//
// 使用 Edge Runtime:无超时限制,适合流式响应
// =============================================================================

export const config = {
  runtime: 'edge',
}

/** 上游 AI API 地址(不含 /chat/completions,由本函数拼接) */
const UPSTREAM_BASE_URL = 'https://api.agnes-ai.cn/v1'

/** 默认模型(前端未指定时使用) */
const DEFAULT_MODEL = 'agnes-2.5-flash'

/** 允许的跨域来源(* 表示任意,生产环境可改为具体域名) */
const CORS_ORIGIN = '*'

export default async function handler(req: Request): Promise<Response> {
  // ---- CORS 预检 ----------------------------------------------------------
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    })
  }

  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed')
  }

  // ---- 读取环境变量 -------------------------------------------------------
  const apiKey = process.env.AGNES_API_KEY
  if (!apiKey) {
    return jsonError(500, 'AGNES_API_KEY 环境变量未配置,请在 Vercel 后台设置')
  }

  // ---- 解析请求体 ---------------------------------------------------------
  let body: {
    messages: unknown
    temperature?: number
    max_tokens?: number
    model?: string
  }

  try {
    body = await req.json()
  } catch {
    return jsonError(400, '请求体不是有效的 JSON')
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonError(400, 'messages 字段缺失或非数组')
  }

  // ---- 转发到上游 AI API --------------------------------------------------
  const upstreamUrl = `${UPSTREAM_BASE_URL.replace(/\/+$/, '')}/chat/completions`

  const upstreamResponse = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: body.model || DEFAULT_MODEL,
      messages: body.messages,
      temperature: body.temperature ?? 0.8,
      max_tokens: body.max_tokens ?? 2048,
      stream: true,
    }),
  })

  // ---- 上游错误处理 -------------------------------------------------------
  if (!upstreamResponse.ok) {
    const errText = await upstreamResponse.text().catch(() => upstreamResponse.statusText)
    return jsonError(upstreamResponse.status, `AI API 请求失败: ${errText}`)
  }

  if (!upstreamResponse.body) {
    return jsonError(502, 'AI API 响应无 body(不支持流式)')
  }

  // ---- 流式透传:SSE 响应原样传回前端 -------------------------------------
  return new Response(upstreamResponse.body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/** CORS 响应头 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

/** 返回 JSON 错误响应 */
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
    },
  })
}
