// =============================================================================
// groupBackend —— 测试版群聊服务客户端
// -----------------------------------------------------------------------------
// 群聊走独立服务(测试版 :5810,经 api.peilika.beer/group 暴露),
// 与单聊网关(:5501)完全分开。
//
// 交互协议(与 group_chat_service.py 约定):
//   POST /group/session        创建会话 → session_id(后端生成,前端保存)
//   POST /group/reply          取"下一步"回复 → {replies[], suggestions[], done}
//   POST /group/topic          插入新话题
//   POST /group/session/close  结束会话
//
// 为什么是"每次请求取一步"而不是 SSE:
//   单聊链路本来就是"一次 POST 拿完整回复 → 按行分段播放",前端已有成熟的
//   "加载气泡 + 逐条显示"管线。群聊沿用同一形态,智能模式的"持续进行"由前端
//   循环请求实现,而"玩家随时打断"天然等于停止循环 —— 不必为此引入 SSE
//   和一整套新的前端状态机。
// =============================================================================

/** 群聊服务基址 */
import { API_BASES, groupBaseUrl } from '../constants/apiRoutes'

// ⚠ 已废弃：本常量写死了 primary 域名，不跟随用户在设置里选择的备用域名。
//   实际请求走 groupBaseUrl()（见下方调用点），保留仅为兼容旧引用。
//   新代码请勿使用这个常量，否则备用域名会失效。
export const GROUP_BASE_URL = API_BASES.primary + '/group'

/** 群聊发言模式(与后端 VALID_SPEAK_MODES 一致) */
export type GroupSpeakMode = 'round' | 'smart' | 'assign'

/** 一条群聊历史(前端维护,每次请求带上) */
export interface GroupHistoryItem {
  side: 'mine' | 'other'
  text: string
  /** 说话人中文名(群聊必须:否则无法分辨谁说过什么) */
  speaker?: string
  /** 图片 dataURL(仅玩家可发) */
  image?: string
}

export interface GroupReplyItem {
  speaker: string
  text: string
  need_search: boolean
}

export interface GroupSessionInfo {
  session_id: string
  members: string[]
  my_role: string
  speak_mode: GroupSpeakMode
  assign_target: string
  topic: string
  group_name: string
  ttl: number
}

export interface GroupReplyResult {
  replies: GroupReplyItem[]
  suggestions: string[]
  done: boolean
  last_speaker: string
  stop_reason: string
}

export interface CreateGroupSessionInput {
  members: string[]
  myRole: string
  speakMode: GroupSpeakMode
  assignTarget?: string
  topic?: string
  groupName?: string
}

/** 统一 POST,失败返回 null 并带上可读原因 */
export interface PostResult<T> {
  data: T | null
  error: string
  /** 后端建议的等待秒数(限速时返回;0 表示没给) */
  retryAfter: number
  /** 后端标记的"会话已过期"(需静默重建,不该弹错误给玩家) */
  sessionExpired: boolean
}

async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<PostResult<T>> {
  try {
    const resp = await fetch(groupBaseUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = (json && (json.error as string)) || `HTTP ${resp.status}`
      const retryAfter = Number(json?.retry_after) || 0
      const sessionExpired = json?.session_expired === true
      return { data: null, error: msg, retryAfter, sessionExpired }
    }
    return { data: json as T, error: '', retryAfter: 0, sessionExpired: false }
  } catch (e) {
    // AbortError 是主动打断,不算错误
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { data: null, error: 'aborted', retryAfter: 0, sessionExpired: false }
    }
    return {
      data: null,
      error: e instanceof Error ? e.message : String(e),
      retryAfter: 0,
      sessionExpired: false,
    }
  }
}

/** 创建群聊会话(身份与发言模式在这一刻确定,之后不可切换) */
export async function createGroupSession(
  input: CreateGroupSessionInput,
  signal?: AbortSignal,
): Promise<{ data: GroupSessionInfo | null; error: string }> {
  return postJson<GroupSessionInfo>('/session', {
    members: input.members,
    my_role: input.myRole,
    speak_mode: input.speakMode,
    assign_target: input.assignTarget ?? '',
    topic: input.topic ?? '',
    group_name: input.groupName ?? '',
  }, signal)
}

/** 取"下一步"回复 */
export async function requestGroupReply(
  sessionId: string,
  history: GroupHistoryItem[],
  opts: {
    topic?: string
    forceSearch?: boolean
    think?: boolean
    immersiveMode?: boolean
    newTurn?: boolean
    /** 是否顺带让后端生成推荐(默认 false:推荐改为玩家点开面板时按需拉取) */
    wantSuggestions?: boolean
    /** 实验性开关:使用新版提示词(characters_v2/) */
    useNewPrompt?: boolean
    /**
     * 知识源：true = RAG 语料库，false = 联网搜索。
     * undefined（默认）时不带该字段，由后端决定（当前默认走 RAG）。
     */
    useRag?: boolean
  } = {},
  signal?: AbortSignal,
): Promise<PostResult<GroupReplyResult>> {
  return postJson<GroupReplyResult>('/reply', {
    session_id: sessionId,
    history,
    topic: opts.topic ?? '',
    think: opts.think ?? false,
    immersive_mode: opts.immersiveMode ?? true,
    new_turn: opts.newTurn ?? false,
    want_suggestions: opts.wantSuggestions ?? false,
    use_new_prompt: opts.useNewPrompt ?? false,
    // 知识源：仅在显式指定时携带（undefined 时保持旧请求体不变）
    ...(opts.useRag !== undefined ? { use_rag: opts.useRag } : {}),
    // 强制搜索：同上，只在联网搜索开启时携带
    ...(opts.forceSearch !== undefined ? { force_search: opts.forceSearch } : {}),
  }, signal)
}

/**
 * 按需生成输入推荐
 *
 * 推荐从"每轮顺带生成"改为"玩家点开推荐面板时才拉取":
 * 智能模式每轮原本要 3 次 API 调用(判断 + 回复 + 推荐),而玩家多数时候并不看
 * 推荐 —— 与正式版共用同一批 Key 时,这 1/3 的流量会明显加剧限速。
 */
export async function requestGroupSuggestions(
  sessionId: string,
  history: GroupHistoryItem[],
  topic = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const { data } = await postJson<{ suggestions: string[] }>('/suggestions', {
    session_id: sessionId,
    history,
    topic,
  }, signal)
  return data?.suggestions ?? []
}

/** 插入新话题(写入后端会话调度状态,后续发言都会带上) */
export async function setGroupTopicRemote(
  sessionId: string,
  topic: string,
): Promise<boolean> {
  const { data } = await postJson<{ ok: boolean }>('/topic', {
    session_id: sessionId,
    topic,
  })
  return !!data?.ok
}

/** 结束会话(释放后端内存) */
export async function closeGroupSession(sessionId: string): Promise<void> {
  await postJson<{ ok: boolean }>('/session/close', { session_id: sessionId })
}

// =============================================================================
// 传输层抽象(2026-10-04 新增)
// -----------------------------------------------------------------------------
// 群聊有两条互相独立的实现:
//   - backend 模式 → 本模块(后端群聊服务 /group/*)
//   - custom  模式 → utils/customGroupBackend.ts
//                    (前端本地链路:本地会话状态 + 直连用户自定义 API)
// 两者导出**同名同签名**的函数。useGroupChat / stores/chat 按 apiMode 取其中一套,
// UI 层与调度逻辑完全不需要知道底下走的是哪一条链路。
//
// 之所以用 `typeof 函数` 而不是重新写一份签名:签名只有一处定义,
// 将来协议加字段时两边不会走散。
// =============================================================================
export interface GroupTransport {
  createGroupSession: typeof createGroupSession
  requestGroupReply: typeof requestGroupReply
  requestGroupSuggestions: typeof requestGroupSuggestions
  setGroupTopicRemote: typeof setGroupTopicRemote
  closeGroupSession: typeof closeGroupSession
}
