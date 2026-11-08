// customGroupBackend —— 自定义 API 模式下的前端本地群聊链路
// 把后端 group_chat_service 的调度语义搬到前端，模型调用直连用户的 OpenAI 兼容端点；
// 导出函数与 utils/groupBackend 同名同签名，由 groupTransport 按 apiMode 二选一。
// ⚠️ 纯前端没有知识源与角色关系表，联网/RAG 与关系段整段省略，绝不偷偷打后端。

import { useSettingsStore } from '../stores/settings'
import { customChatCompletion, parseSuggestionList } from './customApi'
import type { CustomChatMessage } from './customApi'
import { applyImmersiveToCharacterPrompt, stripImmersive } from './immersive'
import { buildRagContext } from './rag'
import { devInfo, devWarn } from './logger'
import { applyLengthPolicy } from '../constants/prompts'
import type {
  CreateGroupSessionInput,
  GroupHistoryItem,
  GroupReplyItem,
  GroupReplyResult,
  GroupSessionInfo,
  GroupSpeakMode,
  PostResult,
} from './groupBackend'

// 常量（与后端 group_chat_service 对齐）

/** 会话空闲超时(ms):与后端 SESSION_TTL=300s 一致,超时按"会话已过期"处理 */
const SESSION_TTL_MS = 300_000

/** 单会话最大轮数(硬护栏,与后端 MAX_TURNS 一致) */
const MAX_TURNS = 60

/** 送往模型的历史条数上限(与后端 HISTORY_LIMIT 一致) */
const HISTORY_LIMIT = 50

/**
 * 直接 slice(-HISTORY_LIMIT) 会让窗口每轮滑一条、前缀每轮都变，服务商的前缀缓存
 * 永远不命中。这里超额时一次丢掉一整块，窗口能在接下来的 8 轮里保持一致。
 */
const HISTORY_TRIM_CHUNK = 8

/** 超额部分向上取整到块大小：上限 50、历史 51 条 → 从第 8 条起保留 43 条 */
function windowStart(total: number): number {
  if (total <= HISTORY_LIMIT) return 0
  const excess = total - HISTORY_LIMIT
  return Math.ceil(excess / HISTORY_TRIM_CHUNK) * HISTORY_TRIM_CHUNK
}

/** 渲染成"发言人:内容"文本时的历史条数上限(与后端 build_history_text 一致) */
const HISTORY_TEXT_LIMIT = 40

/** 推荐:条数 / 单条字数上限 */
const SUGGESTION_COUNT = 3
const SUGGESTION_MAX_CHARS = 25

/** 各类请求超时(ms):生成慢、判断/推荐快 */
const REPLY_TIMEOUT_MS = 90_000
const JUDGE_TIMEOUT_MS = 30_000
const SUGGEST_TIMEOUT_MS = 30_000

/** 玩家身份取值(与后端一致) */
const ROLE_OBSERVER = 'observer'
const ROLE_ADMIN = 'admin'

/** 合法发言模式 */
const VALID_SPEAK_MODES: GroupSpeakMode[] = ['round', 'smart', 'assign']

/**
 * 判断模块认为"该收了"时使用的续接指令
 *
 * 需求:对话不再因为"判断模块觉得聊完了"而自动停止 —— 只有玩家点暂停才停。
 * 后端改为把话题自然续上;前端 custom 链路保持一致(逐字取自 group_chat_service.py)。
 */
const NUDGE_CONTINUE = '（群里刚安静了一小会儿。请不要总结、不要道别,自然地接一句把话题续下去:'
  + '可以回应上文某个细节、可以提出一个相关的实际问题、也可以抛出新的引子。'
  + '保持你一贯的语气,像平时在群里那样。）'

/** 智能模式判断发言人的 system 提示词(逐字取自后端 JUDGE_SYSTEM) */
const JUDGE_SYSTEM = `你是一个多人聊天群的「主持人」,负责决定下一条消息该由谁发出。

【你的判断依据】
1. 谁最有可能对最近的消息有兴趣、有信息、有立场 —— 优先让他说。
2. 刚刚发过言的人,短期内不要连续发言(除非被点名提问、或被直接反驳)。
3. 不要机械轮转。真实群聊里有人话多有人话少,让合适的角色在合适的时机说话。
4. 玩家(管理员/某个角色)刚发言后,应该有角色接话,不要冷场。
5. 如果最近几条明显在反复追问同一个问题、或者同一个观点被重复表达、
   又或者这个话题已经被充分讨论完了 —— 你就应该让对话自然停下来。
6. 如果某个角色明显被点名("@某某""某某你怎么看"),优先让他回答。

【严格输出 JSON,不要任何多余文字】
{"next": "角色名", "reason": "一句话理由", "search": true 或 false}

- next 只能是成员列表里的名字;若应当停止发言,next 填 "END"。
- search 表示"这位角色发言前是否需要联网搜索最新信息",
  只有当话题涉及现实世界的实时信息、新闻、数据、当前时间等才为 true;
  纯剧情/闲聊/角色设定内的话题一律 false。
`

/** 群聊推荐 system 提示词(逐字取自后端 SUGGEST_SYSTEM) */
const SUGGEST_SYSTEM = `你在一个多人聊天群里帮玩家想"接下来可以说什么"。

要求:
1. 输出 3 条候选,每条都是**玩家自己**会打出去的话(第一人称,直接可发送)。
2. 每条不超过 25 个字,短、口语化,像真的在群里打字。
3. 要贴合当前群聊的上下文:承接最近的话题、回应某个角色、或者推进剧情。
4. 三条要有差异:一条顺着聊、一条换个角度、一条抛出新的引子。
5. 必须符合玩家此刻的身份与说话风格(见下方身份说明)。

严格只输出 JSON 数组,不要任何多余文字:
["候选1", "候选2", "候选3"]
`

// 本地会话状态：后端存在 SQLite，前端存在这个模块级 Map 里。刷新或重启后 Map 为空，
// 旧 session_id 查不到 → 返回 sessionExpired，useGroupChat 会自动重建。

interface LocalGroupSession {
  sessionId: string
  members: string[]
  myRole: string
  speakMode: GroupSpeakMode
  assignTarget: string
  topic: string
  groupName: string
  /** 上一位发言人(智能模式避免连说) */
  lastSpeaker: string
  /** 已推进的轮数(硬护栏用) */
  turns: number
  /** 最近一次活跃时间(空闲回收用) */
  lastActive: number
}

const sessions = new Map<string, LocalGroupSession>()

/** 回收空闲超时的会话(与后端 reaper 同语义) */
function reap(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id)
  }
}

/** 生成一个本地会话 id(前缀 local- 便于与后端 id 区分,排查日志一眼能看出来) */
function newSessionId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 由 AI 接管的成员:玩家扮演某个角色时该角色由玩家输入,AI 停用 */
function aiMembers(s: LocalGroupSession): string[] {
  if (s.myRole && s.myRole !== ROLE_OBSERVER && s.myRole !== ROLE_ADMIN) {
    return s.members.filter((m) => m !== s.myRole)
  }
  return s.members.slice()
}

/** 统一的失败结果(data 恒为 null,可赋给任意 PostResult<T>) */
function fail(error: string, sessionExpired = false): PostResult<never> {
  return { data: null, error, retryAfter: 0, sessionExpired }
}

/** 统一的成功结果 */
function ok(data: GroupReplyResult): PostResult<GroupReplyResult> {
  return { data, error: '', retryAfter: 0, sessionExpired: false }
}

/** 是否为主动中止(AbortError) */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** 是否为"限速"类错误:交由 useGroupChat 的退避重试处理(与后端 429 同口径) */
function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /限速|429/.test(msg)
}

/** 把历史渲染成"发言人:内容"的文本(判断 / 推荐用) */
function buildHistoryText(history: GroupHistoryItem[], limit = HISTORY_TEXT_LIMIT): string {
  const rows: string[] = []
  for (const h of history.slice(-limit)) {
    let text = (h.text ?? '').trim()
    if (!text) {
      if (h.image) text = h.side === 'other' ? '[图片]' : '[玩家发来一张图片]'
      else continue
    }
    let speaker = (h.speaker ?? '').trim()
    if (h.side === 'mine') speaker = speaker || '玩家'
    rows.push(`${speaker || '未知'}：${text}`)
  }
  return rows.join('\n')
}

/** 从模型输出里抠出第一个 JSON 对象(容忍 ```json 包裹与前后废话) */
function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const s = text.trim().replace(/^```(?:json)?|```$/gm, '').trim()
  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(raw)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(s)
  if (direct) return direct
  const m = s.match(/\{[\s\S]*\}/)
  return m ? tryParse(m[0]) : null
}

/** 转义正则里的字面量(用于剥离"角色名:"前缀) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 提示词组装（对应后端五段提示词）

/**
 * 后端顺序：世界观 / 角色提示词（单独一条 system）/ 搜索情报 / 角色关系 / 话题。
 * 前端第 3、4 段没有数据源，整段省略（见文件头）；第 1 段与单聊 custom 链路同源。
 */
function buildGroupSystemPrompt(s: LocalGroupSession): string {
  const store = useSettingsStore()
  // 第 1 段:世界观(与单聊 custom 用的同一条 system 文本)
  const worldview = store.getSystemMessage()

  const membersLine = s.members.join('、')
  const roleLine = s.myRole === ROLE_OBSERVER
    ? '玩家正在旁观,不参与对话。'
    : s.myRole === ROLE_ADMIN || !s.myRole
      ? '玩家以「管理员」身份参与对话,管理员发言由玩家自己输入。'
      : `玩家扮演「${s.myRole}」,该角色的发言由玩家自己输入。`

  // ⚠️ 首条 system 是**所有角色共享的缓存前缀**:这里只能写与"这一轮谁发言"
  // 无关的内容。一旦把「你正在扮演 X」写进来,群聊里换个角色发言整段前缀就作废。
  // 角色身份 / 本轮话题 / 催促语统一放进 buildSpeakerBriefing,贴在本轮最后
  // 一条 user 之前(与 RAG 语料同一位置)。
  const groupRules = [
    '【群聊场景】',
    `这是一个多人聊天群,群名「${s.groupName || '群聊'}」,成员:${membersLine}。`,
    roleLine,
    '规则:',
    '1. 只输出你自己这一个角色的发言,绝对不要替别人说话,也不要写任何旁白式的第三人称叙述。',
    '2. 这是群聊,不是一对一。语气要像在群里说话:短、口语化、可以点名回应某个人(用「@某某」或直接叫名字),不要长篇大论。',
    '3. 发言要接得住上文,针对最近几条消息里最值得回应的点,不要自说自话,也不要把之前说过的话重复一遍。',
    '4. 与在场成员的亲疏、称呼、态度严格遵照你在原作设定中与他们的关系。',
  ].join('\n')

  return [worldview, groupRules].filter((p) => p && p.trim()).join('\n\n')
}

/**
 * 每轮都会变的内容，故放在本轮最后一条 user 之前（与 RAG 语料同一位置），
 * 让前面的固定前缀保持一致 —— 换人发言也能命中前缀缓存。
 */
function buildSpeakerBriefing(speaker: string, topic: string, nudge: string): string {
  const parts = [`【本轮发言】你正在扮演「${speaker}」,只输出这一个角色的发言。`]
  if (topic) {
    parts.push(
      `【玩家刚刚抛出的话题】\n${topic}\n请自然地接住这个话题,不要生硬地宣布「话题切换」。`,
    )
  }
  if (nudge) parts.push(nudge)
  return parts.filter((p) => p && p.trim()).join('\n\n')
}

/** 一条角色发言的生成结果(内部用) */
interface GeneratedReply {
  item: GroupReplyItem
  /** true = 该角色由玩家本人扮演,AI 不生成(调用方需要改选下一位) */
  skippedPlayerRole?: boolean
}

/**
 * 历史两轨：自己的发言 = assistant，其余（含玩家与其他角色）= user 并带「某某:」前缀；
 * 沉浸式开启时再过一遍文本层过滤。
 */
async function generateReply(
  s: LocalGroupSession,
  speaker: string,
  history: GroupHistoryItem[],
  opts: { topic: string; think: boolean; immersive: boolean; signal?: AbortSignal; nudge?: string },
): Promise<GeneratedReply> {
  // 防御性检查:speaker 是玩家本人扮演的角色时,AI 不生成(由玩家输入控制)
  if (s.myRole && s.myRole !== ROLE_OBSERVER && s.myRole !== ROLE_ADMIN
      && speaker === s.myRole) {
    devInfo(`[group:custom] 跳过 AI 生成:${speaker} 由玩家本人扮演`)
    return { item: { speaker, text: '', need_search: false }, skippedPlayerRole: true }
  }

  const store = useSettingsStore()
  const system = buildGroupSystemPrompt(s)
  const messages: CustomChatMessage[] = [{ role: 'system', content: system }]

  // 沉浸式以本次请求的 opts 为准，不读全局开关，避免提示词层与文本层分叉
  // 长度策略：角色卡里的 {LENGTH_TARGET} 必须在这里按角色填掉
  const character = applyLengthPolicy(
    applyImmersiveToCharacterPrompt(store.getCharacterPrompt(speaker), opts.immersive), speaker)
  if (character) messages.push({ role: 'system', content: character })

  // ---- 历史:按"块"裁剪,不是每轮滑一条 --------------------------------
  // 逐条滑动会让**每一轮的前缀都不一样**(开头少一条),等于永远缓存不命中;
  // 改成超额时一次丢一整块,前缀在接下来的若干轮里保持完全一致。
  for (const h of history.slice(windowStart(history.length))) {
    let text = (h.text ?? '').trim()
    if (!text) {
      if (h.image) text = h.side === 'other' ? '[图片]' : '[玩家发来一张图片]'
      else continue
    }
    const spk = (h.speaker ?? '').trim()
    if (spk === speaker) {
      messages.push({ role: 'assistant', content: text })
    } else {
      const label = spk || (h.side === 'mine' ? '玩家' : '某人')
      messages.push({ role: 'user', content: `${label}：${text}` })
    }
  }

  // ---- 本轮简报:谁在说话 + 话题 + 催促语 -------------------------------
  // 这些每轮都变,所以贴在本轮最后一条 user 之前(与语料同一位置),
  // 不污染前面的固定前缀。
  messages.push({
    role: 'user',
    content: buildSpeakerBriefing(speaker, opts.topic, opts.nudge ?? ''),
  })
  messages.push({
    role: 'user',
    content: `（现在轮到你「${speaker}」在群里发言。只输出你要说的内容,`
      + `不要加引号、不要写'${speaker}：'这样的前缀。）`,
  })

  // ---- 后端 RAG 检索(群聊) ----------------------------------------------
  // 语料插在**本轮最后一条 user 之前**(也就是那句「轮到你发言」之前),而不是
  // 提示词之后:这样固定前缀(两段提示词 + 之前的历史)每轮完全一致,服务商的
  // 前缀缓存能一路命中,只有新检索到的语料与本轮指令需要重新计费。
  // 检索失败静默跳过;开关关闭时完全不发请求。
  if (store.ragEnabled) {
    const lastMine = [...history].reverse().find((h) => h.side === 'mine' && (h.text ?? '').trim())
    const query = ((lastMine?.text ?? '') || opts.topic || '').trim()
    const ragBlock = query ? await buildRagContext(query, opts.signal, store.ragTopK) : ''
    if (ragBlock) {
      let insertAt = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          insertAt = i
          break
        }
      }
      messages.splice(insertAt, 0, { role: 'system', content: ragBlock })
    }
  }

  const { text: raw } = await customChatCompletion(store.apiConfig, messages, {
    temperature: 0.85,
    maxTokens: 1024,
    think: opts.think,
    signal: opts.signal,
    timeoutMs: REPLY_TIMEOUT_MS,
  })

  // 去掉模型偶尔自带的前缀
  let text = raw.replace(new RegExp(`^\\s*${escapeRegExp(speaker)}\\s*[:：]\\s*`), '')
  if (opts.immersive) text = stripImmersive(text, true)
  return { item: { speaker, text, need_search: false } }
}

/**
 * 智能模式:判断下一个该谁说话(对应后端 judge_next_speaker)
 *
 * 返回 { next: 角色名 | 'END', reason }。判断失败时降级为候选名单第一位
 * (与后端 except 分支一致),绝不因此打断整轮对话。
 */
async function judgeNextSpeaker(
  s: LocalGroupSession,
  history: GroupHistoryItem[],
  signal?: AbortSignal,
): Promise<{ next: string; reason: string }> {
  const candidates = aiMembers(s)
  if (candidates.length === 0) {
    return { next: 'END', reason: '没有可由 AI 接管的成员' }
  }

  const convo = buildHistoryText(history, HISTORY_LIMIT) || '(暂无对话)'
  const roleDesc = s.myRole === ROLE_OBSERVER
    ? '旁观(不发言)'
    : s.myRole === ROLE_ADMIN || !s.myRole
      ? '管理员(玩家本人)'
      : `${s.myRole}(玩家本人)`

  const skipped = s.lastSpeaker && candidates.length > 1
    ? candidates.filter((c) => c === s.lastSpeaker)
    : []

  const user = `【群聊信息】
群名:${s.groupName || '群聊'}
全部成员:${s.members.join('、')}
玩家身份:${roleDesc}
话题:${s.topic || '(未指定,自由发挥)'}
上一位发言者:${s.lastSpeaker || '(还没有人发言)'}
可由 AI 接管的成员:${candidates.join('、')}
刚发过言、建议跳过的人:${skipped.join('、') || '(无)'}

【最近的群聊记录】
${convo}

请判断下一条消息该由谁发出。`

  const store = useSettingsStore()
  try {
    const { text: raw } = await customChatCompletion(store.apiConfig, [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: user },
    ], {
      // 判断只需一个短决策:不启用思考,省时省 token(与后端 judge 的 think=False 一致)
      temperature: 0.4,
      maxTokens: 512,
      think: false,
      signal,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })

    const data = extractJson(raw) ?? {}
    let next = String(data.next ?? '').trim()
    const reason = String(data.reason ?? '').trim()

    if (next.toUpperCase() === 'END') {
      devInfo(`[group:custom] 判断 → END (${reason || '对话自然结束'})`)
      return { next: 'END', reason: reason || '对话自然结束' }
    }
    // 合法性校验:模型偶尔会编出不在群里的名字(或把玩家角色混进来)
    if (!candidates.includes(next)) {
      const fallback = candidates[0]
      devWarn(`[group:custom] 模型给出的发言人「${next}」不在 AI 接管名单,降级为 ${fallback}`)
      next = fallback
    }
    devInfo(`[group:custom] 判断 → ${next} ${reason ? `(${reason})` : ''}`)
    return { next, reason }
  } catch (e) {
    // 限速要抛给调用方(走退避重试);其余异常降级为轮转,不打断对话
    if (isRateLimited(e) || isAbort(e)) throw e
    const fallback = candidates[0]
    devWarn(`[group:custom] 判断失败,退回轮转: ${e instanceof Error ? e.message : String(e)}`)
    return { next: fallback, reason: `判断失败降级(${e instanceof Error ? e.message : String(e)})` }
  }
}

/** 玩家身份的说话风格说明(推荐要模拟该身份,对应后端 build_player_identity_prompt) */
function buildPlayerIdentityPrompt(s: LocalGroupSession): string {
  const store = useSettingsStore()
  if (s.myRole === ROLE_ADMIN || !s.myRole) {
    return '玩家身份:管理员。你是这群干员的指挥者,说话简明、务实、'
      + '带一点上位者的从容;偶尔关心下属,但不啰嗦。'
  }
  if (s.myRole === ROLE_OBSERVER) return '玩家身份:旁观者,不参与对话。'
  // 玩家扮演群内某角色:取该角色的提示词摘要(与单聊 custom 同源)
  const prompt = store.getCharacterPrompt(s.myRole).trim()
  if (prompt) {
    return `玩家正在扮演「${s.myRole}」,请完全用该角色的口吻说话。\n`
      + `角色设定摘要:\n${prompt.slice(0, 1200)}`
  }
  return `玩家正在扮演「${s.myRole}」,请用符合该角色气质的口吻说话。`
}

/**
 * 生成 3 条输入推荐(对应后端 generate_suggestions)
 *
 * 旁观身份不生成(需求:旁观不显示输入推荐)。
 * 模型偶发只给 1~2 条时补问一次(与后端一致)。
 */
async function generateSuggestions(
  s: LocalGroupSession,
  history: GroupHistoryItem[],
  topic: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (s.myRole === ROLE_OBSERVER) return []

  const convo = buildHistoryText(history, HISTORY_LIMIT) || '(暂无对话)'
  const user = (
    `${buildPlayerIdentityPrompt(s)}\n\n`
    + `【群聊成员】${s.members.join('、')}\n`
    + `【当前话题】${topic || '(无)'}\n`
    + `【最近对话】\n${convo}\n\n`
    + `请给出玩家接下来可以说的 ${SUGGESTION_COUNT} 句话。`
  )

  const store = useSettingsStore()
  const ask = async (extra = ''): Promise<string> => {
    const { text } = await customChatCompletion(store.apiConfig, [
      { role: 'system', content: SUGGEST_SYSTEM },
      { role: 'user', content: user + extra },
    ], {
      temperature: 0.9,
      maxTokens: 512,
      // 推荐是"想三句台词"的短任务:不启用思考,省时省 token
      // (后端 suggest_completion 同样不传 think)
      think: false,
      signal,
      timeoutMs: SUGGEST_TIMEOUT_MS,
    })
    return text
  }

  const out = parseSuggestionList(await ask(), SUGGESTION_COUNT, SUGGESTION_MAX_CHARS)

  if (out.length < SUGGESTION_COUNT) {
    try {
      const extra = `\n\n注意:上一次只给了 ${out.length} 条,`
        + `这次务必给出 ${SUGGESTION_COUNT} 条互不重复的。`
      for (const it of parseSuggestionList(await ask(extra), SUGGESTION_COUNT, SUGGESTION_MAX_CHARS)) {
        if (!out.includes(it)) out.push(it)
        if (out.length >= SUGGESTION_COUNT) break
      }
    } catch (e) {
      if (isRateLimited(e) || isAbort(e)) throw e
      devWarn(`[group:custom] 推荐补生成失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return out.slice(0, SUGGESTION_COUNT)
}

// 对外接口（与 utils/groupBackend 同名同签名）

/** 创建群聊会话(身份与发言模式在这一刻确定,之后不可切换) */
export async function createGroupSession(
  input: CreateGroupSessionInput,
  signal?: AbortSignal,
): Promise<{ data: GroupSessionInfo | null; error: string }> {
  if (signal?.aborted) return { data: null, error: 'aborted' }

  // 成员去重 / 去空(与后端 create_session 一致)
  const members: string[] = []
  for (const m of input.members ?? []) {
    const name = (m ?? '').trim()
    if (name && !members.includes(name)) members.push(name)
  }
  if (members.length < 2) {
    return { data: null, error: '群聊至少需要 2 名成员' }
  }
  const speakMode = VALID_SPEAK_MODES.includes(input.speakMode) ? input.speakMode : 'smart'

  let myRole = (input.myRole || ROLE_ADMIN).trim()
  if (myRole !== ROLE_OBSERVER && myRole !== ROLE_ADMIN && !members.includes(myRole)) {
    // 身份校验失败:回退管理员(后端此处返回 400;前端本地链路选择更温和的自愈)
    devWarn(`[group:custom] my_role「${myRole}」不合法,回退为管理员`)
    myRole = ROLE_ADMIN
  }

  let assignTarget = (input.assignTarget ?? '').trim()
  if (speakMode === 'assign' && !members.includes(assignTarget)) {
    assignTarget = members[0]
  }

  reap()
  const sid = newSessionId()
  sessions.set(sid, {
    sessionId: sid,
    members,
    myRole,
    speakMode,
    assignTarget,
    topic: (input.topic ?? '').trim(),
    groupName: (input.groupName ?? '').trim(),
    lastSpeaker: '',
    turns: 0,
    lastActive: Date.now(),
  })
  devInfo(`[group:custom] 新建本地会话 ${sid} members=${members.join('、')} `
    + `role=${myRole} mode=${speakMode}`)

  return {
    data: {
      session_id: sid,
      members,
      my_role: myRole,
      speak_mode: speakMode,
      assign_target: assignTarget,
      topic: (input.topic ?? '').trim(),
      group_name: (input.groupName ?? '').trim(),
      ttl: SESSION_TTL_MS / 1000,
    },
    error: '',
  }
}

/**
 * round 一次返回 AI 成员各一条（done=true）；assign 只返回指定角色（done=true）；
 * smart 只返回一条且 done=false，由前端循环请求实现「持续进行」。
 */
export async function requestGroupReply(
  sessionId: string,
  history: GroupHistoryItem[],
  opts: {
    topic?: string
    forceSearch?: boolean
    think?: boolean
    immersiveMode?: boolean
    newTurn?: boolean
    wantSuggestions?: boolean
    useNewPrompt?: boolean
    useRag?: boolean
  } = {},
  signal?: AbortSignal,
): Promise<PostResult<GroupReplyResult>> {
  reap()
  const s = sessions.get(sessionId)
  if (!s) {
    // 前端刷新 / 300s 空闲回收后必然走到这里 → 交给 useGroupChat 自动重建
    return fail('会话不存在或已超时,请重新创建群聊', true)
  }
  if (signal?.aborted) return fail('aborted')

  if (opts.topic?.trim()) s.topic = opts.topic.trim()
  s.lastActive = Date.now()
  s.turns += 1

  const think = opts.think ?? false
  const immersive = opts.immersiveMode ?? true
  const wantSuggestions = opts.wantSuggestions ?? false
  // ⚠ 明确降级:前端没有 RAG / 联网检索服务,useRag / forceSearch 无法实现,
  //   因此不参与任何提示词组装(后端会走 do_prepare 注入第三段情报)。
  void opts.forceSearch
  void opts.useRag
  void opts.useNewPrompt

  const replies: GroupReplyItem[] = []
  let done = true
  let stopReason = ''

  try {
    if (s.speakMode === 'assign') {
      // ---- 指定模式:玩家点名的角色只回一条 ----
      let target = s.assignTarget || s.members[0]
      if (!s.members.includes(target)) target = s.members[0]
      if (!aiMembers(s).includes(target)) {
        stopReason = `「${target}」由玩家本人扮演,请直接输入该角色的发言`
      } else {
        const r = await generateReply(s, target, history, {
          topic: s.topic, think, immersive, signal,
        })
        if (!r.skippedPlayerRole) {
          replies.push(r.item)
          s.lastSpeaker = target
        }
      }
    } else if (s.speakMode === 'round') {
      // ---- 轮流模式:所有【由 AI 接管】的成员按顺序各回一条 ----
      // 逐成员独立容错:单个成员失败只跳过该成员,其余照常返回
      // (与后端 round 模式的容错口径一致)。
      let acc = history
      for (const name of aiMembers(s)) {
        if (signal?.aborted) return fail('aborted')
        try {
          const r = await generateReply(s, name, acc, {
            topic: s.topic, think, immersive, signal,
          })
          if (r.skippedPlayerRole) continue
          replies.push(r.item)
          // 后续角色应当能看到前面刚说的话
          if (r.item.text) {
            acc = acc.concat([{ side: 'other', speaker: name, text: r.item.text }])
          }
          s.lastSpeaker = name
        } catch (e) {
          if (isRateLimited(e) || isAbort(e)) throw e
          devWarn(`[group:custom] round 模式 ${name} 生成失败,跳过该成员: `
            + `${e instanceof Error ? e.message : String(e)}`)
          replies.push({ speaker: name, text: '', need_search: false })
        }
      }
    } else {
      // ---- 智能模式:判断下一个该谁说话 ----
      const verdict = await judgeNextSpeaker(s, history, signal)
      let next = verdict.next
      let nudge = ''
      if (next === 'END' || !next) {
        // 需求:不因"判断觉得聊完了"自动结束 → 换下一位把话题续上
        const members = aiMembers(s)
        if (members.length === 0) {
          return ok({
            replies: [], suggestions: [], done: true,
            last_speaker: s.lastSpeaker, stop_reason: '没有可由 AI 接管的成员',
          })
        }
        const at = members.indexOf(s.lastSpeaker)
        next = members[(at + 1) % members.length]
        nudge = NUDGE_CONTINUE
        devInfo(`[group:custom] 判断为 END,按需求改为续接:轮到 ${next}`)
      }

      let r = await generateReply(s, next, history, {
        topic: s.topic, think, immersive, signal, nudge,
      })
      if (r.skippedPlayerRole) {
        // 保险:点到的是玩家自己扮演的角色 → 改选下一位 AI 成员
        const aiM = aiMembers(s)
        if (aiM.length === 0) {
          return ok({
            replies: [], suggestions: [], done: true,
            last_speaker: s.lastSpeaker, stop_reason: '没有可由 AI 接管的成员',
          })
        }
        const alt = aiM.includes(next) ? next : aiM[0]
        devInfo(`[group:custom] ${next} 是玩家角色,改由 ${alt} 接话`)
        r = await generateReply(s, alt, history, {
          topic: s.topic, think, immersive, signal, nudge,
        })
        next = alt
      }
      replies.push(r.item)
      s.lastSpeaker = next
      // 智能模式"持续进行":done=false 交给前端循环;达到硬上限才强制收尾
      done = false
      if (s.turns >= MAX_TURNS) {
        done = true
        stopReason = `已达到最大轮数 ${MAX_TURNS}`
        devWarn(`[group:custom] 会话 ${sessionId} 达到最大轮数,强制结束本次循环`)
      }
    }

    // ---- 输入推荐(与后端一致:随回复生成时才生成) ----
    let suggestions: string[] = []
    if (wantSuggestions) {
      suggestions = await generateSuggestions(s, history, s.topic, signal)
    }

    s.lastActive = Date.now()
    return ok({
      replies,
      suggestions,
      done,
      last_speaker: s.lastSpeaker,
      stop_reason: stopReason,
    })
  } catch (e) {
    if (isAbort(e)) return fail('aborted')
    const msg = e instanceof Error ? e.message : String(e)
    devWarn(`[group:custom] 请求回复失败: ${msg}`)
    // error 里保留 429/限速字面量,useGroupChat 据此退避重试
    return fail(msg)
  }
}

/**
 * 按需生成输入推荐(与 groupBackend.requestGroupSuggestions 同签名)
 *
 * 失败一律返回空数组 —— 推荐只是输入辅助,绝不影响正常聊天。
 */
export async function requestGroupSuggestions(
  sessionId: string,
  history: GroupHistoryItem[],
  topic = '',
  signal?: AbortSignal,
): Promise<string[]> {
  reap()
  const s = sessions.get(sessionId)
  if (!s) return []
  if (topic.trim()) s.topic = topic.trim()
  s.lastActive = Date.now()
  try {
    return await generateSuggestions(s, history, s.topic, signal)
  } catch (e) {
    devWarn(`[group:custom] 拉取推荐失败: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** 插入新话题(写入本地会话调度状态,后续发言都会带上) */
export async function setGroupTopicRemote(
  sessionId: string,
  topic: string,
): Promise<boolean> {
  reap()
  const s = sessions.get(sessionId)
  if (!s) return false
  s.topic = (topic ?? '').trim()
  s.lastActive = Date.now()
  return true
}

/** 结束会话(释放本地内存) */
export async function closeGroupSession(sessionId: string): Promise<void> {
  sessions.delete(sessionId)
}
