// =============================================================================
// 新后端统一调用层(backend.ts) —— v4
// -----------------------------------------------------------------------------
// 后端模式(apiMode === 'backend')的专属 API 层:
//   - 所有角色统一请求 https://api.peilika.beer/chat(测试版网关,端口 5501),
//     不再使用每角色独立子域名
//   - 请求体用 character_id 替代长提示词,不再发送 system_prompt /
//     global_prompt / character_prompt(除非用户自定义了提示词覆盖)
//   - 角色 ID 列表硬编码在前端(CHARACTER_ID_MAP,29 个干员)
//   - 后端(提示词输出模块)根据 character_id 加载角色提示词与世界观,
//     并完成联网搜索判断与免费搜索,返回 { reply }
//   - 自定义 API 模式(apiMode === 'custom')不经过本模块,由 llm.ts 直连
// =============================================================================

import type { ApiConfig } from '../stores/settings'
import { API_BASES, gatewayUrl } from '../constants/apiRoutes'

/** 后端请求的历史条目(OpenAI 风格 role/content) */
export interface BackendHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  /** v3: 图片 dataURL（识图用；无图片时缺省） */
  image?: string
}

/** 后端请求体(v4 统一网关协议) */
export interface BackendRequest {
  /** 角色 ID(新协议;后端据此加载角色提示词) */
  character_id?: string
  /** 角色中文名(旧字段,后端兼容) */
  character?: string
  /** 旧版兼容:前端直接传入的完整提示词(仅旧前端/未收录角色使用) */
  system_prompt?: string
  /** 用户自定义覆盖的角色提示词(仅存在覆盖时发送) */
  character_prompt?: string
  /** 当前用户输入(不重复出现在 history 中) */
  message: string
  /** 最近 25 轮问答历史(最多 50 条,从旧到新,图片以 "[图片]" 占位) */
  history: BackendHistoryEntry[]
  /** v3: 思考模式开关 */
  think?: boolean
  /** v4: 实验性功能-强制每条搜索(开启时后端强制触发搜索) */
  force_search?: boolean
  /** v7: 实验性功能-沉浸式对话模式(true 或缺省=不显示括号动作,只留台词) */
  immersive_mode?: boolean
  /** 实验性开关:True 使用新版提示词(后端从 characters_v2/ 加载);缺省=旧版提示词 */
  use_new_prompt?: boolean
  /**
   * 知识源（2026-09-30 新增，配合前端「联网搜索（替代 RAG）」开关）
   *
   *   true  → 使用 RAG 语料库
   *   false → 使用联网搜索
   *   缺省  → 由后端默认（当前后端默认走 RAG）
   *
   * 前端默认**不带**该字段（保持与旧版一致），仅在用户打开开关时显式传 false。
   */
  use_rag?: boolean
}

/** 后端上报的 token 用量（后端各服务统一提供的 usage 字段） */
export interface BackendUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  model?: string
  api_id?: string
}

/** 后端响应体 */
export interface BackendReply {
  /** 角色完整回复 */
  reply: string
  /** 可选:角色当前心情表情 token(如 sns_emoji_001),缺失时前端不展示 */
  mood?: string
  /** 本次请求的 token 用量（后端 2026-09-30 起统一返回） */
  usage?: BackendUsage
  /** 本次实际生效的知识源："rag" | "web" | "none" */
  knowledge_source?: string
}

/** fetchBackendReply 的解析结果 */
export interface BackendReplyResult {
  /** 角色完整回复文本 */
  reply: string
  /** 可选:心情表情 token(后端未返回时为 undefined) */
  mood?: string
  /** 本次 token 用量（后端未返回时为 undefined） */
  usage?: BackendUsage
  /** 本次实际生效的知识源（后端未返回时为 undefined） */
  knowledgeSource?: string
}

/**
 * 「流式不可用」专用错误(收到任何 delta **之前**就失败)
 *
 * 出现它意味着流式这条路压根没走通:旧后端没有 /chat/stream(404)、网络失败、
 * 非 2xx、响应不是 event-stream,或流结束了却一个字节都没收到。
 * 调用方据此**回退到非流式 fetchBackendReply 一次**,用户无感。
 *
 * ⚠️ 一旦已经收到过 delta,本函数绝不会抛它(内容已落在气泡里,回退会重复追加);
 * `event: error` 帧是后端明确报错(不是链路失败),同样不抛它。
 */
export class BackendStreamUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendStreamUnavailableError'
  }
}

/**
 * `event: error` 帧对应的错误(后端明确报错,不是链路失败)
 *
 * 内部使用:它不会被包成 BackendStreamUnavailableError,因此调用方不会回退 ——
 * 流本身是通的,重发一次只会再报同样的错、白白多打一次上游。
 */
class BackendStreamEventError extends Error {
  /** 后端给出的错误码(rate_limit / upstream / internal),缺失为空串 */
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'BackendStreamEventError'
    this.code = code
  }
}

/** fetchBackendReplyStream 的回调与中止信号 */
export interface BackendStreamOptions {
  /** 收到一个增量片段(逐字输出);收到后就不可能再回退到非流式 */
  onDelta?: (text: string) => void
  /** 收到阶段事件(judge / lease / generate / search);不关心时不传 */
  onStage?: (stage: string) => void
  /** 外部中止信号(通常来自 chat store 的本轮响应上下文) */
  signal?: AbortSignal
}

/**
 * fetchBackendReplyStream 内部的流式累积状态
 *
 * 用持有对象而非裸 let:赋值发生在解析闭包里,对象属性不受 TypeScript
 * 控制流收窄影响(与 utils/llm.ts 的 usageHolder 同一考虑)。
 */
interface BackendStreamState {
  /** 是否已收到过增量(决定失败时能否回退到非流式) */
  receivedDelta: boolean
  /** 逐帧累积的文本(缺 done 帧时的兜底) */
  accumulated: string
  /** done 帧里的权威全文(未收到为 null) */
  finalReply: string | null
  /** done 帧里的心情表情 token */
  finalMood: string | undefined
  /** 本次 token 用量（来自 `event: usage` 帧或 done 帧） */
  usage: BackendUsage | undefined
  /** 本次实际生效的知识源 */
  knowledgeSource: string | undefined
}

/** 是否为主动中止(fetch / reader 在 abort 时抛出的 DOMException) */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * 统一网关地址(新后端唯一入口)
 * 用户可在设置中配置 backendUrl 覆盖(主要用于本地调试),为空时使用该地址。
 *
 * 【测试版】这里指向**测试版专用网关** api.peilika.beer(:5501),
 * 与正式版 api.peilika.beer(:5500) 是完全独立的两套后端 —— 端口错开、
 * 实例表独立、进程独立。测试版前端绝不可以再指向正式网关。
 */
// ⚠ 已废弃：本常量写死了 primary 域名，不跟随用户在设置里选择的备用域名。
//   实际请求走 resolveBackendUrl()/gatewayUrl()（见下方调用点），保留仅为兼容旧引用。
//   新代码请勿使用这个常量，否则备用域名会失效。
export const GATEWAY_URL = API_BASES.primary + '/chat'

/**
 * 角色中文名 → character_id 映射表(硬编码,29 个干员)
 * 与后端 /perlica_project/characters/{id}.json 一一对应。
 */
export const CHARACTER_ID_MAP: Record<string, string> = {
  伊冯: 'yifeng',
  余烬: 'yujin',
  佩丽卡: 'perlica',
  别礼: 'bieli',
  卡契尔: 'kaqier',
  卡缪: 'camille',
  埃特拉: 'aitela',
  大潘: 'dapan',
  安塔尔: 'antaer',
  庄方宜: 'zhuangfangyi',
  弧光: 'huguang',
  弭弗: 'mifei',
  昼雪: 'zhouxue',
  梨诺: 'linuo',
  汤汤: 'tangtang',
  洁尔佩塔: 'jieerpeita',
  洛茜: 'luoxi',
  狼卫: 'langwei',
  秋栗: 'qiuli',
  艾尔黛拉: 'aierdaila',
  艾维文娜: 'aiweiwena',
  莱万汀: 'laiwanting',
  萤石: 'yingshi',
  诀: 'jue',
  赛希: 'saixi',
  阿列什: 'alieshi',
  陈千语: 'chenqianyu',
  骏卫: 'junwei',
  黎风: 'lifeng',
  聂菲斯: 'niefeisi',
  阿达希尔: 'adaxier',
  提弗洛斯: 'tifuluosi',
  祀: 'si',
  // 新加的角色(整张列表在 character.ts 里也是排最前)
  噗切娜: 'puqiena',
  管理员: 'endministrator',
}

/** 角色 ID 列表(供需要遍历时使用) */
export const CHARACTER_IDS: string[] = Object.values(CHARACTER_ID_MAP)

/**
 * 解析统一后端地址
 *
 * 优先使用用户配置的 backendUrl(本地调试);为空时返回统一网关地址。
 */
export function resolveBackendUrl(character: string, fallback = ''): string {
  return fallback || gatewayUrl()
}

/**
 * 最近保留的问答轮数(1 轮 = 1 条用户 + 1 条 AI 回复)
 *
 * 2026-09-28 由 25 → 15:实测同一批上游调用中，输入 token 越多越慢 ——
 * 输入 ≥10k token 时平均 9.1s / p90 23s，而 6–10k token 时平均 3.3s / p90 7s。
 * 每次请求的固定成本（角色卡 + 世界观）已占约 6k token，历史再带 50 条就会顶到 9–14k，
 * 于是"有时候特别慢"。压到 15 轮（30 条）后输入回到 6–9k 区间，
 * 更早的内容仍由「智能总结」压成前情提要，不影响连贯性。
 */
export const BACKEND_HISTORY_ROUNDS = 15

/** 最近保留的历史条数(15 轮 × 2) */
export const BACKEND_HISTORY_LIMIT = BACKEND_HISTORY_ROUNDS * 2

/**
 * 组装后端请求体(v4)
 *
 * 将前端历史({side, text, image?})映射为后端格式:
 *   - mine → user / other → assistant
 *   - 图片消息:content 用 "[图片]" 占位,不传 base64 dataURL(避免请求膨胀)
 *   - 仅截取最近 25 轮(50 条),从旧到新;不足则全部发送
 *   - 当前输入单独放 message,不在 history 中
 *
 * 提示词策略:
 *   - 映射表内角色:发送 character_id,不发送任何长提示词
 *     (后端按 character_id 加载角色提示词与世界观)
 *   - 仅当用户自定义了该角色提示词覆盖时,额外发送 character_prompt
 *     (尊重用户自定义,覆盖后端内置提示词)
 *   - 映射表外角色(自定义角色):退回发送完整 system_prompt(兼容处理)
 *
 * @param message   当前用户输入
 * @param character 角色中文名
 * @param history   截取前的完整历史(不含当前输入)
 * @param options   { characterId?, characterPromptOverride?, systemPrompt?, think?, forceSearch?, immersiveMode?, useNewPrompt?, useRag? }
 */
export function buildBackendRequest(
  message: string,
  character: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
  options?: {
    characterId?: string
    characterPromptOverride?: string
    systemPrompt?: string
    think?: boolean
    forceSearch?: boolean
    immersiveMode?: boolean
    useNewPrompt?: boolean
    /**
     * 知识源：true = RAG 语料库，false = 联网搜索。
     * undefined（默认）时**不带该字段**，由后端决定（当前后端默认走 RAG）。
     */
    useRag?: boolean
  },
): BackendRequest {
  const entries: BackendHistoryEntry[] = history
    .slice(-BACKEND_HISTORY_LIMIT)
    .map((h) => ({
      role: h.side === 'mine' ? 'user' : 'assistant',
      content: h.image ? '[图片]' : h.text,
      image: h.image || undefined,
    }))

  const characterId = options?.characterId || CHARACTER_ID_MAP[character] || ''

  const req: BackendRequest = {
    message,
    history: entries,
    character,
    think: options?.think ?? false,
    immersive_mode: options?.immersiveMode ?? true,
    use_new_prompt: options?.useNewPrompt ?? false,
  }
  // 知识源：undefined 时**不带该字段**（与旧版请求体逐字一致，后端走默认=RAG）
  if (options?.useRag !== undefined) {
    req.use_rag = options.useRag
  }
  // 强制搜索：只走 RAG 时后端不联网，该字段无意义 → **不带**；
  // 仅在联网搜索开启时按用户设置携带（与 use_rag 同一套"undefined 就不带"的契约）
  if (options?.forceSearch !== undefined) {
    req.force_search = options.forceSearch
  }

  if (characterId) {
    // 新协议:character_id 为主
    req.character_id = characterId
    // 用户自定义覆盖才发送(否则由后端加载内置提示词)
    if (options?.characterPromptOverride) {
      req.character_prompt = options.characterPromptOverride
    }
  } else {
    // 未收录角色(自定义):退回旧协议,发送完整提示词
    if (options?.systemPrompt) {
      req.system_prompt = options.systemPrompt
    }
  }

  return req
}

/**
 * 请求统一网关并返回完整回复文本
 *
 * POST JSON 到网关(https://api.peilika.beer/chat 或用户配置 backendUrl),
 * 解析一次性响应 { reply }。
 *
 * @param config  API 配置(需 apiMode === 'backend')
 * @param request 后端请求体
 * @param signal  AbortController(外部传入以便中止)
 * @returns reply 文本与可选 mood
 */
export async function fetchBackendReply(
  config: ApiConfig,
  request: BackendRequest,
  signal?: AbortSignal,
): Promise<BackendReplyResult> {
  // 自动重试:后端/网络在冷启动窗口(服务刚重启、实例尚未就绪)或瞬时抖动时,
  // 首次请求可能失败而紧接着的第二次会成功。此处对可恢复错误自动重试,
  // 用户无感知(不必手动"重新生成")。
  const MAX_ATTEMPTS = 3
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchBackendReplyOnce(config, request, signal)
    } catch (err) {
      // 用户主动中止:不重试
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      // 配置类错误(未配置后端地址)重试无意义
      if (msg.includes('后端地址未配置')) throw err
      if (attempt < MAX_ATTEMPTS - 1) {
        // 限速(429)等待更久;其余错误短退避后重试
        const waitMs = msg.includes('繁忙') ? 1500 * (attempt + 1) : 700 * (attempt + 1)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 单次请求(不含重试);重试与错误归类见 fetchBackendReply */
async function fetchBackendReplyOnce(
  config: ApiConfig,
  request: BackendRequest,
  signal?: AbortSignal,
): Promise<BackendReplyResult> {
  const url = resolveBackendUrl(request.character || '', config.backendUrl)
  if (!url) {
    throw new Error(`后端地址未配置：未找到角色「${request.character}」的固定后端地址`)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { reply: '' }
    }
    // 网络层失败(TypeError "Failed to fetch" 等):给出友好中文提示
    if (err instanceof TypeError) {
      throw new Error('网络连接失败:无法连接到服务器,请检查网络后重试')
    }
    throw new Error(`后端请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    // 上游限速(429)单独提示,便于用户理解
    if (response.status === 429) {
      throw new Error('服务繁忙(上游限速),请稍后重试')
    }
    throw new Error(`后端请求失败 (${response.status}): ${errText}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('后端响应不是有效的 JSON')
  }

  const payload = data as BackendReply | null
  const reply = payload?.reply
  if (typeof reply !== 'string') {
    throw new Error('后端响应缺少 reply 字段')
  }
  const mood = typeof payload?.mood === 'string' ? payload.mood : undefined
  return {
    reply,
    mood,
    usage: payload?.usage,
    knowledgeSource: typeof payload?.knowledge_source === 'string'
      ? payload.knowledge_source
      : undefined,
  }
}

/**
 * 请求统一网关的 SSE 流式接口(/chat/stream)
 *
 * POST 到 `gatewayUrl() + '/stream'`(即 /chat/stream);请求体与 /chat **完全一致**,
 * 额外带 `Accept: text/event-stream`。事件协议(事件名固定,data 均为 JSON):
 *   - `event: delta` → {"text":"增量片段"}                        → options.onDelta(text)
 *   - `event: done`  → {"reply":"完整文本","mood":…}              → 以 reply 为最终权威文本
 *   - `event: error` → {"error":"中文提示","code":"rate_limit…"}   → 抛 Error(error 字段)
 *   - `event: stage` → {"stage":"judge|lease|generate|search"}    → options.onStage(stage)
 *   - `: ping` 形式的注释行(心跳)                                 → 忽略
 * 帧与帧之间用空行分隔(与 llm.ts 的 SSE 读取同一套写法:fetch + getReader + 文本解码,
 * 不引入任何新依赖)。
 *
 * 失败语义(与调用方的回退策略一一对应):
 *   - **收到任何 delta 之前**失败(网络 / 非 2xx / 响应不是 event-stream / 流里什么都没有)
 *     → 抛 BackendStreamUnavailableError,调用方回退到 fetchBackendReply 一次
 *   - 已经收到 delta 之后再出错 → 原样抛出(绝不静默吞掉,也不再回退)
 *   - `event: error` 帧 → 始终原样抛出(后端明确报错,不是链路失败)
 *
 * @param config  API 配置(按任务约定,本接口地址固定为网关 /chat/stream,
 *                与非流式接口的 resolveBackendUrl 不同 —— 不读用户自填 backendUrl)
 * @param request 后端请求体(与 fetchBackendReply 完全同构)
 * @param options 增量 / 阶段回调与中止信号
 * @returns 权威 reply 文本与可选 mood
 */
export async function fetchBackendReplyStream(
  config: ApiConfig,
  request: BackendRequest,
  options: BackendStreamOptions = {},
): Promise<BackendReplyResult> {
  const { onDelta, onStage, signal } = options
  // 地址固定为网关 + /stream(见上方 @param config 说明)
  const url = `${gatewayUrl()}/stream`

  // ---- 1. 建立连接(这一段的失败都属于"流式不可用",可回退) -----------------
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 明确要求 SSE:后端/中间层据此走流式分支
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(request),
      signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    // 网络层失败(TypeError "Failed to fetch" 等):给出友好中文提示
    throw new BackendStreamUnavailableError(
      err instanceof TypeError
        ? '网络连接失败:无法连接到服务器,请检查网络后重试'
        : `后端流式请求失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new BackendStreamUnavailableError(
      response.status === 429
        ? '服务繁忙(上游限速),请稍后重试'
        : `后端流式请求失败 (${response.status}): ${errText}`,
    )
  }

  // 响应不是 event-stream(旧后端把 /stream 当普通接口返回 JSON)= 流式不可用 → 可回退
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    throw new BackendStreamUnavailableError(
      `后端 /stream 未返回 SSE(Content-Type: ${contentType || '未知'})`,
    )
  }
  if (!response.body) {
    throw new BackendStreamUnavailableError('后端流式响应无 body(不支持流式)')
  }

  // ---- 2. 逐帧读取 ---------------------------------------------------------
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  /** 尚未按行切分的残留文本 */
  let buffer = ''
  /** 当前帧累积的 event 名与 data 行(SSE 允许一个帧带多行 data) */
  let frameEvent = ''
  let frameData: string[] = []

  const st: BackendStreamState = {
    receivedDelta: false,
    accumulated: '',
    finalReply: null,
    finalMood: undefined,
    usage: undefined,
    knowledgeSource: undefined,
  }

  /** 处理一帧(event 名 + 已拼好的 data) */
  const handleFrame = (event: string, data: string): void => {
    if (!data) return
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (!parsed || typeof parsed !== 'object') return
      payload = parsed as Record<string, unknown>
    } catch {
      // 无法解析的帧直接忽略(可能是不完整的 JSON,与 llm.ts 对脏行的容忍一致)
      return
    }

    if (event === 'delta') {
      const text = payload.text
      if (typeof text === 'string' && text) {
        st.receivedDelta = true
        st.accumulated += text
        onDelta?.(text)
      }
      return
    }
    if (event === 'done') {
      // done 是权威结果:reply 覆盖逐帧累积(可能丢帧),mood 一并带出
      if (typeof payload.reply === 'string') {
        st.finalReply = payload.reply
        st.finalMood = typeof payload.mood === 'string' ? payload.mood : undefined
      }
      // 用量与知识源：done 帧里可能带（后端两种都发，取到即用）
      if (payload.usage && typeof payload.usage === 'object') {
        st.usage = payload.usage as BackendUsage
      }
      if (typeof payload.knowledge_source === 'string') {
        st.knowledgeSource = payload.knowledge_source
      }
      return
    }
    if (event === 'usage') {
      // 后端在 done 之前单独发的用量帧（未知该事件的旧客户端会安全忽略）
      if (payload && typeof payload === 'object') {
        st.usage = payload as BackendUsage
      }
      return
    }
    if (event === 'stage') {
      if (typeof payload.stage === 'string') onStage?.(payload.stage)
      return
    }
    if (event === 'error') {
      const msg =
        typeof payload.error === 'string' && payload.error
          ? payload.error
          : '后端流式返回错误'
      throw new BackendStreamEventError(
        msg,
        typeof payload.code === 'string' ? payload.code : '',
      )
    }
    // 未知事件:忽略(后端将来新增事件不应打断本次回复)
  }

  /** 派发当前已累积的帧(没有内容的空帧无事发生) */
  const flushFrame = (): void => {
    const event = frameEvent
    const data = frameData.join('\n')
    frameEvent = ''
    frameData = []
    if (!data && !event) return
    handleFrame(event, data)
  }

  /** 消费一行 SSE 文本(空行 = 一帧结束) */
  const consumeLine = (raw: string): void => {
    // 兼容 CRLF:行尾的 \r 不属于内容
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      flushFrame()
      return
    }
    // 以 ':' 开头的是注释行(心跳 ": ping")→ 忽略
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // SSE 规范:冒号后紧跟的一个空格不属于值
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') frameEvent = value
    else if (field === 'data') frameData.push(value)
    // id / retry 等其它字段:与本协议无关,忽略
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后不完整的一行,等下一个 chunk 补齐
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
    // 流结束时:补处理最后一行(可能没有换行符),并派发可能残留的半帧
    if (buffer !== '') consumeLine(buffer)
    flushFrame()
  } catch (err) {
    // 提前退出(报错 / 中止)时主动关掉底层连接,不给后端留一个没人读的流
    reader.cancel().catch(() => {})
    if (isAbortError(err)) throw err
    // 后端明确报错(rate_limit / upstream / internal):原样抛出,不回退
    if (err instanceof BackendStreamEventError) throw err
    // 收到过 delta:字已经落在气泡里,回退只会重复追加 → 原样抛出
    if (st.receivedDelta) throw err instanceof Error ? err : new Error(String(err))
    // 一个增量都没有:统一归为"流式不可用",交给调用方回退到非流式
    throw new BackendStreamUnavailableError(
      err instanceof Error ? err.message : String(err),
    )
  }

  // ---- 3. 收尾 -------------------------------------------------------------
  // done 帧的 reply 是最终权威文本(丢帧也能被纠正)
  if (st.finalReply !== null) {
    return {
      reply: st.finalReply,
      mood: st.finalMood,
      usage: st.usage,
      knowledgeSource: st.knowledgeSource,
    }
  }
  // 没有 done 帧但已收到增量(连接被中途截断):退回已累积的文本,别丢掉已显示的内容
  if (st.receivedDelta) {
    return {
      reply: st.accumulated,
      mood: st.finalMood,
      usage: st.usage,
      knowledgeSource: st.knowledgeSource,
    }
  }
  // 一个字节都没有:回退到非流式
  throw new BackendStreamUnavailableError('后端流式响应未返回任何内容')
}

/** fetchBackendSuggestions 的输入(前端形状,内部转成后端协议字段) */
export interface BackendSuggestionInput {
  /** 角色 ID(新协议主字段;未收录角色留空) */
  characterId?: string
  /** 角色中文名(旧字段,后端兼容) */
  character?: string
  /** 玩家当前输入(可选;不传时后端只依据 history 生成候选) */
  message?: string
  /** 前端聊天历史(内部按 /chat 同一口径映射并截取最近 50 条) */
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>
  /** 实验性开关:使用新版提示词(后端按 characters_v2/ 加载) */
  useNewPrompt?: boolean
  /** 实验性开关:沉浸式对话模式(true 时后端禁止括号描写) */
  immersiveMode?: boolean
}

/**
 * 按需拉取单聊「AI 推荐回复」(与群聊 requestGroupSuggestions 对齐)
 *
 * POST 到 `gatewayUrl() + '/suggestions'`(即 /chat/suggestions),返回若干条候选文本。
 * 与 /chat 一样按 character_id 让后端加载角色提示词;自定义角色退回 character 字段。
 * 地址与 SSE 一致固定为网关(与后端约定一致,不读用户自填 backendUrl)。
 *
 * 拉取失败一律抛错,由调用方降级为"暂无推荐" —— 推荐只是输入辅助,
 * 绝不能因为它失败而影响正常聊天。
 *
 * @param input  角色信息 + 历史(前端形状)
 * @param signal 中止信号(切换会话 / 关闭面板时可不传,失败也只是一次无效请求)
 */
export async function fetchBackendSuggestions(
  input: BackendSuggestionInput,
  signal?: AbortSignal,
): Promise<string[]> {
  // 历史口径与 buildBackendRequest 完全一致:图片以 "[图片]" 占位,只取最近 50 条
  const history: BackendHistoryEntry[] = input.history
    .slice(-BACKEND_HISTORY_LIMIT)
    .map((h) => ({
      role: h.side === 'mine' ? 'user' : 'assistant',
      content: h.image ? '[图片]' : h.text,
      image: h.image || undefined,
    }))

  const body: {
    character_id?: string
    character?: string
    message?: string
    history: BackendHistoryEntry[]
    use_new_prompt: boolean
    immersive_mode: boolean
  } = {
    history,
    use_new_prompt: input.useNewPrompt ?? false,
    immersive_mode: input.immersiveMode ?? true,
  }
  if (input.characterId) body.character_id = input.characterId
  if (input.character) body.character = input.character
  // message 只有明确传了才发(不传 = 后端仅依据 history 生成)
  if (input.message) body.message = input.message

  let response: Response
  try {
    response = await fetch(`${gatewayUrl()}/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    if (err instanceof TypeError) {
      throw new Error('网络连接失败:无法连接到服务器,请检查网络后重试')
    }
    throw new Error(`推荐请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    if (response.status === 429) {
      throw new Error('服务繁忙(上游限速),请稍后重试')
    }
    throw new Error(`推荐请求失败 (${response.status}): ${errText}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('推荐响应不是有效的 JSON')
  }

  const list = (data as { suggestions?: unknown } | null)?.suggestions
  if (!Array.isArray(list)) return []
  // 只保留非空字符串,过滤后端可能的脏数据
  return list.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
}

/**
 * 测试后端连接(设置弹窗"连接测试"按钮)
 * 向统一网关发送一条最小请求,2xx 即视为连接成功。
 */
export async function testBackendConnection(
  config: ApiConfig,
  character = '',
): Promise<{ ok: boolean; message: string }> {
  const url = resolveBackendUrl(character, config.backendUrl)
  if (!url) {
    return {
      ok: false,
      message: '未找到可测试的后端地址（请选中一个对话后再测试）',
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '连接测试',
        history: [],
        character: character || '佩丽卡',
        character_id: CHARACTER_ID_MAP[character] || 'perlica',
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
