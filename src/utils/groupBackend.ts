// groupBackend —— 测试版群聊服务客户端（与单聊网关分开）
// 不用 SSE：群聊沿用单聊「一次 POST → 分段播放」的管线，智能模式的持续进行由前端
// 循环实现，随时打断 = 停止循环。

import { groupBaseUrl } from '../constants/apiRoutes'

/** 与后端 VALID_SPEAK_MODES 一致 */
export type GroupSpeakMode = 'round' | 'smart' | 'assign'

/** 每次请求都带上，由前端维护 */
export interface GroupHistoryItem {
  side: 'mine' | 'other'
  text: string
  /** 群聊必须带，否则无法分辨谁说过什么 */
  speaker?: string
  /** 图片 dataURL，仅玩家可发 */
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

/** 失败时 data 为 null，error 为可读原因 */
export interface PostResult<T> {
  data: T | null
  error: string
  /** 限速时后端建议的等待秒数，0 表示没给 */
  retryAfter: number
  /** 后端标记会话已过期：需静默重建，不该弹错误给玩家 */
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
    // 主动打断不算错误
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

/** 身份与发言模式在创建时确定，之后不可切换 */
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

export async function requestGroupReply(
  sessionId: string,
  history: GroupHistoryItem[],
  opts: {
    topic?: string
    forceSearch?: boolean
    think?: boolean
    immersiveMode?: boolean
    newTurn?: boolean
    /** 默认 false：推荐改为玩家点开面板时按需拉取 */
    wantSuggestions?: boolean
    /** 实验性开关：使用新版提示词 */
    useNewPrompt?: boolean
    /** true = RAG 语料库，false = 联网搜索；undefined 时由后端决定 */
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
    // 以下两项仅在显式指定时携带，保持旧请求体不变
    ...(opts.useRag !== undefined ? { use_rag: opts.useRag } : {}),
    ...(opts.forceSearch !== undefined ? { force_search: opts.forceSearch } : {}),
  }, signal)
}

/**
 * 推荐改为玩家点开面板时才拉取：智能模式每轮原本要 3 次调用（判断 + 回复 + 推荐），
 * 而玩家多数时候并不看推荐 —— 与正式版共用 Key 时这 1/3 流量会明显加剧限速。
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

/** 写入后端会话调度状态，后续发言都会带上 */
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

/** 释放后端会话内存 */
export async function closeGroupSession(sessionId: string): Promise<void> {
  await postJson<{ ok: boolean }>('/session/close', { session_id: sessionId })
}

/**
 * 群聊有两条实现的公共签名：backend 模式走本模块，custom 模式走
 * utils/customGroupBackend.ts。用 `typeof` 而非另写一份，协议加字段时两边不会走散。
 */
export interface GroupTransport {
  createGroupSession: typeof createGroupSession
  requestGroupReply: typeof requestGroupReply
  requestGroupSuggestions: typeof requestGroupSuggestions
  setGroupTopicRemote: typeof setGroupTopicRemote
  closeGroupSession: typeof closeGroupSession
}
