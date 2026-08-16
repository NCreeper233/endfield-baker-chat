// =============================================================================
// Python 后端调用层(backend.ts)
// -----------------------------------------------------------------------------
// 后端模式(apiMode === 'backend')的专属 API 层:
//   - 前端不拼接任何提示词,只负责传递原始数据:
//     当前输入(message) + 最近 10 轮问答历史(history) + 角色中文名(character)
//   - 后端运行 Python 脚本处理后返回 { reply: "完整回复" }(一次性 JSON)
//   - 前端收到 reply 后交由 useAiChat 复用现有"按 \n 分段 + 假打字"展示节奏
//
// 契约说明见 docs/backend-contract.md
// =============================================================================

import type { ApiConfig } from '../stores/settings'

/** 后端请求的历史条目(OpenAI 风格 role/content) */
export interface BackendHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

/** 后端请求体(与 docs/backend-contract.md 保持一致) */
export interface BackendRequest {
  /** 当前用户输入(不重复出现在 history 中) */
  message: string
  /** 最近 10 轮问答历史(最多 20 条,从旧到新,图片以 "[图片]" 占位) */
  history: BackendHistoryEntry[]
  /** 角色中文名(后端自行映射英文 ID) */
  character: string
}

/** 后端响应体 */
export interface BackendReply {
  /** 角色完整回复 */
  reply: string
}

/** 最近保留的问答轮数(1 轮 = 1 条用户 + 1 条 AI 回复) */
export const BACKEND_HISTORY_ROUNDS = 10

/** 最近保留的历史条数(10 轮 × 2) */
export const BACKEND_HISTORY_LIMIT = BACKEND_HISTORY_ROUNDS * 2

/**
 * 组装后端请求体
 *
 * 将前端历史({side, text, image?})映射为后端格式:
 *   - mine → user / other → assistant
 *   - 图片消息:content 用 "[图片]" 占位,不传 base64 dataURL(避免请求膨胀)
 *   - 仅截取最近 10 轮(20 条),从旧到新;不足则全部发送
 *   - 当前输入单独放 message,不在 history 中
 *     (调用方负责传入"发送前"截取的历史,不含当前输入)
 *
 * @param message   当前用户输入
 * @param character 角色中文名(对话名,后端自行映射)
 * @param history   截取前的完整历史(不含当前输入)
 */
export function buildBackendRequest(
  message: string,
  character: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
): BackendRequest {
  const entries: BackendHistoryEntry[] = history
    .slice(-BACKEND_HISTORY_LIMIT)
    .map((h) => ({
      role: h.side === 'mine' ? 'user' : 'assistant',
      content: h.image ? '[图片]' : h.text,
    }))
  return { message, history: entries, character }
}

/**
 * 请求后端并返回完整回复文本
 *
 * POST JSON 到配置的后端地址,解析一次性响应 { reply }。
 * 与 streamChat 保持一致的语义:
 *   - 用户中止(AbortError):返回空串,不算错误
 *   - 非 2xx / 响应体非 JSON / 缺少 reply:抛出错误(由调用方显示)
 *
 * @param config  API 配置(需 apiMode === 'backend' 且 backendUrl 非空)
 * @param request 后端请求体
 * @param signal  AbortController(外部传入以便中止)
 * @returns reply 文本
 */
export async function fetchBackendReply(
  config: ApiConfig,
  request: BackendRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.backendUrl) {
    throw new Error('后端地址未配置：请先在设置中填写后端 URL')
  }

  let response: Response
  try {
    response = await fetch(config.backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return ''
    }
    throw new Error(`后端请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`后端请求失败 (${response.status}): ${errText}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('后端响应不是有效的 JSON')
  }

  const reply = (data as BackendReply | null)?.reply
  if (typeof reply !== 'string') {
    throw new Error('后端响应缺少 reply 字段')
  }
  return reply
}

/**
 * 测试后端连接(设置弹窗"连接测试"按钮)
 *
 * 按真实契约发送一条最小请求(空历史 + 空角色),2xx 即视为连接成功;
 * 若后端对字段有强校验,错误信息会原样透出便于排查。
 */
export async function testBackendConnection(
  config: ApiConfig,
): Promise<{ ok: boolean; message: string }> {
  if (!config.backendUrl) {
    return { ok: false, message: '请先填写后端 URL' }
  }

  try {
    const response = await fetch(config.backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '连接测试',
        history: [],
        character: '',
      } satisfies BackendRequest),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
      return { ok: false, message: `连接失败 (${response.status}): ${errText}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (err) {
    return { ok: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
