// useGroupChat —— 群聊的对话调度
// 传输层按 apiMode 二选一（见 utils/groupTransport），两条链路同名同签名，本文件无感。
// 智能模式由前端循环请求到 done；玩家发消息即中止循环（这就是「随时打断」）。
import { effectScope, ref, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { findCharacter } from '../constants/character'
import { splitAiSegments } from '../utils/aiText'
import { buildGroupHistory } from '../utils/groupHistory'
import { useReplyReveal } from './useReplyReveal'
import { requestSummary } from '../utils/summary'
import { BACKEND_HISTORY_LIMIT } from '../utils/backend'
import type { Ref } from 'vue'
import type { Conversation } from '../types/chat'
import {
  type GroupHistoryItem,
  type GroupReplyItem,
  type GroupReplyResult,
} from '../utils/groupBackend'
// 群聊传输层：backend 走后端 /group/*，custom 走前端本地链路（直连用户 API）
import { groupTransportFor } from '../utils/groupTransport'
import { devInfo, devWarn } from '../utils/logger'

/** 每条角色回复前的"正在输入"停顿范围(ms),与单聊节奏一致 */
const TYPING_MIN = 700
const TYPING_MAX = 1500

/** 智能模式两轮之间的间隔(ms) */
const SMART_LOOP_GAP = 800

/** 撞到限速后的等待时间(ms)与重试次数 */
const RATE_LIMIT_WAIT = 6000
const RATE_LIMIT_RETRY = 3
/** 单次退避的上限(秒):避免后端给出过长等待把界面卡住 */
const RATE_LIMIT_MAX_WAIT_S = 30

/**
 * 单次「开启 / 恢复对话」的连续请求上限
 *
 * 这不是对话长度限制，只是失控保护：正常使用永远碰不到（由玩家点暂停结束），
 * 保留上限只为防无人看管的标签页无限烧配额。
 */
const SMART_MAX_ROUNDS = 200

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 群聊卡片的最小必要形状(避免在这里耦合完整 Card 类型) */
interface GroupCardLike {
  members?: string[]
  myRole?: string
  speakMode?: string
  assignTarget?: string
  groupTopic?: string
  groupSessionId?: string
  conversations: { name: string }[]
}

// 回合状态：模块级单例
// ChatInput / GroupFlowControl / ChatMessageRow 各自调用 useGroupChat()，状态若放在
// 函数体内，每个组件会拿到独立一份：发起的回合别人 abort 不到，暂停按钮读到的
// busy 恒为 false。群聊回合同一时刻只应有一个，所以这些状态必须进程内共享。

/** 是否有群聊回合正在进行 */
const busy = ref(false)

/** 需要提示给玩家的一句话(限速 / 失败原因),由界面消费后清空 */
const notice: Ref<string> = ref('')

/** 上面那条提示属于哪个会话(玩家已切走时不再弹给玩家看) */
const noticeSub: Ref<number | null> = ref(null)

/** 当前回合的中止控制器:玩家发新消息 / 点暂停即 abort */
let controller: AbortController | null = null

/**
 * 回合令牌
 *
 * 打断后立刻发起的新回合会被「上一轮迟到的 finally」清掉状态（表现为新回合刚开始
 * 就被判结束、暂停按钮失灵）。每轮递增令牌，只有持有当前令牌的那轮才有权复位。
 */
let runToken = 0

/**
 * 当前回合锁定的会话与卡片
 *
 * 回合可能持续几十秒，期间玩家会切走；切走时要停的是这一个会话、要落回状态的是
 * 这一张卡，所以回合开始时就记住（消费方见 bindSwitchGuard）。
 */
let runningSub: number | null = null
let runningCard: (GroupCardLike & { groupRunning?: boolean }) | null = null

/** 本回合锁定的会话对象：落字前比一次引用，才能认出「位置还在但不是那一段」 */
let runningConv: Conversation | null = null

/** 「切换对话即暂停」的监听是否已注册(模块级:整个应用只注册一次) */
let switchGuardBound = false

export function useGroupChat() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  // 回复逐拍显示(括号描写居中开启时,居中条与台词之间留间隔),单聊群聊共用
  const { appendStaged } = useReplyReveal()

  /**
   * 当前 API 模式对应的群聊传输层
   *
   * 每次现取(不缓存):玩家可以在设置里随时切换模式,
   * custom → 前端本地链路;backend / legacy → 后端群聊服务。
   */
  function transport() {
    return groupTransportFor(settingsStore.apiConfig.apiMode)
  }

  /** 角色头像 */
  function avatarOf(name: string): string {
    return findCharacter(name)?.avatar ?? ''
  }

  /**
   * 切换对话必须暂停正在跑的回合：否则循环仍往**原会话**写消息，玩家看不见但额度在烧，
   * 而 busy 是全局单例，新会话的按钮还会显示成「暂停对话」。
   * 监听挂在独立作用域：这些组件会随移动端视图切换卸载重建。
   */
  function bindSwitchGuard(): void {
    if (switchGuardBound) return
    switchGuardBound = true
    effectScope(true).run(() => {
      watch(
        () => chatStore.activeSub,
        () => {
          // 没有回合在跑 → 无需处理(busy 是这里唯一的"是否还在跑"判据:
          // 回合结束时 finally 不再清 runningSub,由 busy 负责区分)
          if (runningSub === null || !busy.value) return
          // 判据不是"下标变了",而是"当前会话不再是我锁定的那一段":
          //   · 玩家切到别的会话 / 退回列表(activeSub 变 null) → 必须停,
          //     否则回合会在看不见的地方继续往后端要下一位发言人、继续烧额度
          //   · 同一个位置换成了另一段会话(删群 / 建群 / 导入) → 同样必须停
          // 旧判据 `prev === null || next === prev` 会在"退回列表"这条路径上
          // 直接放行,正是"该停的没停"。
          if (chatStore.activeSub === runningSub && lockedConvStillHere()) return
          // abort() 会清空 runningSub/runningCard,卡片先取到手
          const card = runningCard
          abort()
          if (card) card.groupRunning = false
        },
      )
    })
  }

  /** 回合锁定的会话是否还在原下标：删/建/导入会让同一下标指向别的会话，那时落字就是串台 */
  function lockedConvStillHere(): boolean {
    if (runningSub === null) return false
    return chatStore.conversations[runningSub] === runningConv
  }

  bindSwitchGuard()

  /** 玩家在群里的显示名(与 groupSelfName 口径一致) */
  function myDisplayName(card: GroupCardLike): string {
    const role = card.myRole
    if (!role || role === 'admin' || role === 'observer') return '管理员'
    return role
  }

  /**
   * 整理群聊历史：规则在 utils/groupHistory（纯函数），这里只取消息与署名
   *
   * @param sub 回合开始时锁定，不随玩家切换而变
   */
  function buildHistory(card: GroupCardLike, sub?: number): GroupHistoryItem[] {
    const idx = sub ?? chatStore.activeSub
    const msgs = idx === null || idx === undefined
      ? []
      : (chatStore.conversations[idx]?.messages ?? [])
    return buildGroupHistory(msgs, myDisplayName(card))
  }

  /**
   * 确保会话存在：id 失效就自动重建一次，别让用户看到「会话不存在」
   *
   * backend 模式是后端生成的 id（超时回收后自愈），custom 模式是本地 id
   * （重开软件后本地 Map 为空，同样自愈）。
   */
  async function ensureSession(
    card: GroupCardLike,
    signal?: AbortSignal,
    force = false,
  ): Promise<string | null> {
    if (!force && card.groupSessionId) return card.groupSessionId
    const { data, error } = await transport().createGroupSession({
      members: card.members ?? [],
      myRole: card.myRole ?? 'admin',
      speakMode: (card.speakMode as 'round' | 'smart' | 'assign') ?? 'smart',
      assignTarget: card.assignTarget,
      topic: card.groupTopic,
      groupName: card.conversations[0]?.name ?? '',
    }, signal)
    if (!data?.session_id) {
      devWarn('[group] 创建会话失败:', error)
      return null
    }
    card.groupSessionId = data.session_id
    return data.session_id
  }

  /**
   * 让一条角色回复以正确的说话人落到聊天区
   *
   * 多行回复按换行拆成**多条气泡**逐条显示 —— 与单聊完全一致的做法
   * (此前整段塞进一个气泡,多行文本在气泡里的排版是错的)。
   * 分段规则复用 utils/aiText.splitAiSegments:顺带处理转义残留,
   * 并把"只有括号的段落"并进相邻段,避免出现只有动作没有台词的气泡。
   */
  async function showReply(
    item: GroupReplyItem,
    sub: number,
    /**
     * 回合开始时锁定的目标会话对象
     *
     * 传对象而不是"只传下标":下标只是位置。回合中途删掉/新建/导入会话之后,
     * 同一个下标可能已经是另一段会话 —— 只有比对象引用才认得出"位置还在,
     * 但已经不是当初那一段"。null 表示调用方没有锁定(兼容旧调用,此时只按
     * 下标写,行为与改动前一致)。
     */
    convLock: Conversation | null,
  ): Promise<void> {
    // 落字前的第一道归属校验(第二道在 store:ctx 锁定了会话对象)
    if (convLock && chatStore.conversations[sub] !== convLock) return

    // 是否在左括号前也切,与单聊共用同一个设置项「智能消息分条」
    const segments = splitAiSegments(item.text, settingsStore.smartSplit)
    if (segments.length === 0) return

    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        // 段间停顿,模拟"同一个人接着补一句"
        await delay(TYPING_MIN * 0.6 + Math.random() * (TYPING_MAX - TYPING_MIN) * 0.5)
      }
      // 停顿期间可能切走了会话 / 结构变了:每一段落字前都重新校验一次
      if (convLock && chatStore.conversations[sub] !== convLock) return
      // 关键:锁定回合开始时的会话,玩家中途切换也不会写串。
      // 末位传 convLock:store 会把它记为归属,后续 appendAiChunk 继续校验
      const ctx = chatStore.beginAiResponse(
        item.speaker, avatarOf(item.speaker), sub, undefined, convLock ?? undefined)
      if (!ctx) return
      // 这一段是**同一条回复的前端续段**(每段各走一次 begin/finish 才有独立节拍):
      // 显式标记"本轮已开始",使它的加载态保持"头像 + 加载气泡",
      // 只有整条回复的第一段才用居中三点加载态(见 useChatRows.loadingLayout)。
      if (i > 0) chatStore.markAiTurnStarted(ctx)
      // 先让加载气泡顶着该角色的头像停留一下,再落字
      await delay(TYPING_MIN + Math.random() * (TYPING_MAX - TYPING_MIN))
      if (!chatStore.isCtxActive(ctx)) return
      if (convLock && chatStore.conversations[sub] !== convLock) return
      // 分拍写入:开启「括号描写居中」时,居中条与台词之间留出间隔(见 useReplyReveal)
      await appendStaged(segments[i], ctx)
      chatStore.finishAiResponse(ctx)
    }
  }

  /**
   * 写进 store 并持久化到这段对话
   *
   * 只存数据、不展开面板。存的是「针对当前对话状态」的一次性结果，状态没变就复用。
   */
  function applySuggestions(items: string[]): void {
    if (!settingsStore.choicesEnabled) {
      chatStore.setPendingChoices([])
      return
    }
    // 写进对话数据 → 重开软件也还在(见 chatStore.setConversationSuggestions)
    chatStore.setConversationSuggestions(items ?? [], chatStore.tailMessageId())
  }

  /**
   * 玩家打开面板时按需拉取
   *
   * 一段对话只生成一次；回合本身不再顺带生成（want_suggestions 传 false），
   * 否则每轮都白花一次调用 —— 那正是「重复刷新」的来源。
   */
  async function fetchSuggestions(force = false): Promise<boolean> {
    if (!settingsStore.choicesEnabled) return false
    const card = chatStore.activeCard as GroupCardLike | null
    if (!card) return false

    const sub = chatStore.activeSub
    if (sub === null) return false

    // 已有缓存且对话没往前走 → 直接用,不重复生成
    const tail = chatStore.tailMessageId()
    if (!force) {
      const cached = chatStore.getConversationSuggestions()
      if (cached && cached.items.length > 0 && cached.forMessageId === tail) {
        chatStore.setPendingChoices(cached.items.map((label) => ({ label })))
        return true
      }
    }

    // 回合进行中不额外打 API(限速期尤其重要),先用手上已有的
    if (busy.value) return (chatStore.pendingChoices as unknown[]).length > 0

    const sessionId = await ensureSession(card)
    if (!sessionId) return false
    try {
      const items = await transport().requestGroupSuggestions(
        sessionId, buildHistory(card, sub), card.groupTopic ?? '')
      // 等待期间可能切走了会话:以此刻的状态为准
      if (chatStore.activeSub !== sub) return false
      chatStore.setConversationSuggestions(items, tail)
      return items.length > 0
    } catch (e) {
      devWarn('[group] 拉取推荐失败:', e)
      return false
    }
  }

  /**
   * 组装送往群聊服务的历史，含与单聊同一套智能总结
   *
   * 超过 50 条且开启总结时，把超出部分压成一条「前情提要」放最前；未开启则直接截最近 50 条。
   */
  async function historyForRequest(
    card: GroupCardLike,
    sub: number,
  ): Promise<GroupHistoryItem[]> {
    const raw = buildHistory(card, sub)
    if (raw.length <= BACKEND_HISTORY_LIMIT) return raw

    const excessCount = raw.length - BACKEND_HISTORY_LIMIT
    const excess = raw.slice(0, excessCount)
    const recent = raw.slice(excessCount)

    if (!settingsStore.summaryConfig.enabled) return recent

    try {
      const api = await settingsStore.getSummaryApi()
      const summary = await requestSummary(
        api.baseUrl, api.apiKey, api.model,
        excess.map((e) => ({ side: e.side, text: e.text })),
      )
      return [
        {
          side: 'other',
          speaker: '前情提要',
          text: `【对话总结】\n${summary}`,
        },
        ...recent,
      ]
    } catch (e) {
      // 总结失败:降级为最近 50 条,不阻断对话
      devWarn('[group] 智能总结失败,降级为最近 50 条:', e)
      return recent
    }
  }

  /**
   * 请求一步回复
   *
   * 429 限速不算失败：测试版与正式版共用同一批 Key，很容易撞冷却。这里退避重试，
   * 而不是把回合掐掉 —— 之前的表现正是「点开始 → 一会儿没反应 → 自己暂停了」。
   */
  async function pullOnce(
    sessionId: string,
    card: GroupCardLike,
    newTurn: boolean,
    signal: AbortSignal,
    sub: number,
  ): Promise<GroupReplyResult | null> {
    // 历史(含智能总结)在本次请求前只算一次:重试时不必重复调用摘要 API
    const historyPayload = await historyForRequest(card, sub)
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY; attempt++) {
      if (signal.aborted) return null
      const { data, error, retryAfter, sessionExpired } = await transport().requestGroupReply(
        sessionId, historyPayload, {
        topic: card.groupTopic ?? '',
        // 实验性功能:与单聊同一套开关
        // forceSearch 只是「联网搜索」的子选项 → 未开联网时不传（RAG 分支不联网）
        forceSearch: settingsStore.webSearchEnabled ? settingsStore.forceSearch : undefined,
        // 知识源：默认不带（后端走 RAG）；打开开关后显式传 false 走联网搜索
        useRag: settingsStore.webSearchEnabled ? false : undefined,
        think: settingsStore.thinkEnabled,
        immersiveMode: settingsStore.immersiveMode,
        useNewPrompt: settingsStore.useNewPrompt,
        newTurn: newTurn && attempt === 0,
        // 推荐**不再**随每轮回复一起生成:一段对话只生成一次(玩家点开面板时按需
        // 拉取,并随对话持久化),否则每轮白花一次 API 调用 —— 智能模式一轮本来
        // 就有"判断 + 回复"两次调用,再带一次推荐会明显加剧上游限速。
        wantSuggestions: false,
      }, signal)

      if (data) return data
      if (error === 'aborted' || signal.aborted) return null

      // 后端会话被空闲回收(300s):这是**正常**的生命周期事件,
      // 调用方会立刻重建会话并重试。绝不能弹"群聊生成失败:请重新创建群聊"
      // 给玩家 —— 他们什么都没做错,而且我们本来就会自愈。
      if (sessionExpired) {
        devInfo('[group] 会话已过期,自动重建')
        return null
      }

      const rateLimited = /限速|429/.test(error)
      if (rateLimited && attempt < RATE_LIMIT_RETRY) {
        // 优先按后端给的 retry_after 退避(Key 池的冷却时间),拿不到再用默认值
        const waitMs = retryAfter > 0
          ? Math.min(retryAfter, RATE_LIMIT_MAX_WAIT_S) * 1000
          : RATE_LIMIT_WAIT
        // 提示语**保持常量**:watch 只在内容变化时触发,这样重试几次也只提示
        // 一次,不会每隔几秒弹一个模态框出来烦人。
        noticeSub.value = sub
        notice.value = '上游 AI 限速，正在自动重试…'
        await delay(waitMs)
        notice.value = ''
        continue
      }
      // 记录提示所属的会话:玩家已切到别的对话时不该再弹这个提示
      noticeSub.value = sub
      notice.value = rateLimited
        ? '上游 AI 持续限速，对话已暂停。稍后点输入框旁的播放按钮可继续'
        : `群聊生成失败：${error}`
      devWarn('[group] 请求回复失败:', error)
      return null
    }
    return null
  }

  /**
   * 跑一个群聊回合
   *
   * - assign / round:后端一次就把该说的都返回了,一轮结束
   * - smart         :后端每次回一条且 done=false,这里持续请求,直到
   *                   done=true(对话自然收束)或玩家打断(abort)
   *
   * @param opts.newTurn 是否是"玩家刚发完消息"的新回合(重置后端轮转计数)
   * @param opts.once    只取一次(供「指定发言」按钮单点一次用)
   */
  async function runTurn(opts: { newTurn?: boolean; once?: boolean } = {}): Promise<void> {
    const card = chatStore.activeCard as GroupCardLike | null
    if (!card) return
    if (busy.value) return

    // 锁定本次回合的目标会话:整个回合(可能持续几十秒、跨多次 API 调用)
    // 都只往这一个会话写。玩家中途切到单聊或另一个群聊,都不会串台。
    const sub = chatStore.activeSub
    if (sub === null) return
    // 会话对象的引用也一起锁定:index 只是位置,回合中途删/建/导入之后,
    // 同一个下标会指向另一段会话(见 showReply 的 convLock)
    const conv = chatStore.conversations[sub] ?? null
    if (!conv) return
    // 记住本回合的目标:玩家中途切走时,切换守卫据此停掉"该停的那一个"(见 bindSwitchGuard)
    runningSub = sub
    runningConv = conv
    runningCard = card as GroupCardLike & { groupRunning?: boolean }

    const myToken = ++runToken
    busy.value = true
    controller = new AbortController()
    const signal = controller.signal

    try {
      let sessionId = await ensureSession(card, signal)
      if (!sessionId) return

      let newTurn = opts.newTurn ?? false
      const mode = card.speakMode ?? 'smart'
      // smart 才能连续多轮;assign/round 后端一轮即结束
      const maxRounds = opts.once ? 1 : (mode === 'smart' ? SMART_MAX_ROUNDS : 2)

      for (let round = 0; round < maxRounds; round++) {
        if (signal.aborted) break
        // 结构变更后锁定的会话可能已不在原下标:再请求下去只会往别人那里写,
        // 立刻收手(切换守卫覆盖"玩家切走",这里覆盖"结构自己变了")
        if (chatStore.conversations[sub] !== conv) {
          devInfo('[group] 回合锁定的会话已不在原位,结束本回合')
          break
        }

        // 用「本轮开始前」的浮窗状态：浮窗是在第 20 条落下的瞬间弹出的，拿此刻状态判
        // 会立刻被判成「没人点」而暂停，玩家只看到闪一下。按会话隔离，必须带本回合的 sub。
        const nudgeWasOpen = !opts.once && chatStore.isGroupContinueOpen(sub)

        let result = await pullOnce(sessionId, card, newTurn, signal, sub)
        newTurn = false

        // 会话被后端回收:重建一次再试
        if (!result && !signal.aborted) {
          const again = await ensureSession(card, signal, true)
          if (!again) break
          sessionId = again
          result = await pullOnce(sessionId, card, false, signal, sub)
          if (!result) break
        }
        if (!result) break

        for (const item of result.replies) {
          if (signal.aborted) break
          await showReply(item, sub, conv)
        }
        // 推荐:一段对话只生成一次 —— 回合结束(对话状态变了)就把上一轮的推荐
        // 从面板上收掉,避免显示"已经过期的推荐";玩家下次点开面板时按需生成
        // 一次并存进这段对话(重开软件也还在)。
        // 兼容:后端偶尔仍随回复带回推荐时,直接采纳(不再额外打接口)。
        if (result.replies.length > 0) {
          if (result.suggestions.length > 0) {
            applySuggestions(result.suggestions)
          } else {
            // 只清内容、不收起面板:玩家正开着面板读的时候不该被关掉
            chatStore.setPendingChoices([])
          }
        }
        // 记录后端给出的收束原因,便于排查
        if (result.replies.length === 0 && result.done && result.stop_reason) {
          devInfo('[group] 停止:', result.stop_reason)
        }

        // 浮窗本来就挂着、这轮也没人点 → 自动暂停。
        // 必须排在 `if (result.done) break` **之前**：轮流模式与「后端一次就收束」的
        // 轮次 done 恒为 true，排在后面永远执行不到。
        // 指定模式的单次发言（once）不计入：它没有「恢复对话」按钮，一旦被自动暂停
        // 玩家打字就再也等不到回复。
        if (nudgeWasOpen && chatStore.isGroupContinueOpen(sub)) {
          if (runningCard) runningCard.groupRunning = false
          chatStore.resetGroupContinue(sub)
          devInfo('[group] 「继续对话」未确认,已自动暂停对话')
          break
        }

        if (result.done) break

        // 达到本次"开启对话"的轮数上限:后端并没有说结束,是这里的兜底截断
        if (round + 1 >= maxRounds) {
          devInfo(
            `[group] 已达单次连续轮数上限(${maxRounds}),对话暂停。` +
            '点「恢复对话」可继续。')
          break
        }

        // 智能模式:稍作停顿再问下一位,避免刷屏式连发
        await delay(SMART_LOOP_GAP)
      }
    } finally {
      // 只有当前这一轮有权复位：被打断的旧回合并令牌已过期，不能动新回合的状态
      if (myToken === runToken) {
        busy.value = false
        controller = null
        // 刻意不在这里清 runningSub / runningConv / runningCard：切换守卫用 busy 判断
        // 「是否还在跑」，清空会让它的判据失效（「该停的没停」的另一半）。
        // 它们的生命周期归 abort() 与下一次 runTurn。
        //
        // 也刻意不复位 groupRunning：那是「玩家希望这段群聊可恢复」的持久意图，
        // 只有玩家点暂停才置 false。自然收束后仍是 true，按钮就显示「恢复对话」。
      }
    }
  }

  /** 打断当前回合(玩家发新消息 / 点「暂停对话」/ 切换对话) */
  function abort(): void {
    // 令牌先过期,让仍在跑的那一轮的 finally 失去复位权
    runToken++
    controller?.abort()
    controller = null
    busy.value = false
    // 目标一并清掉:回合已不再属于任何会话(切换守卫取卡片时用的是清空前的值)
    runningSub = null
    runningConv = null
    runningCard = null
  }

  /**
   * 玩家在群里发一条消息，然后按发言模式推进
   *
   * 旁观 + 非指定模式不会走到这里（那时底部按钮是「给出话题」）。
   */
  async function sendMessage(text: string, opts: { once?: boolean } = {}): Promise<void> {
    if (chatStore.activeSub === null) return
    abort()
    chatStore.sendUserMessage(text)

    // 暂停期间玩家可以照常发消息，但角色不回复。groupRunning === false 才是主动暂停过；
    // undefined = 从未开始，发消息就应该正常触发回复。
    const card = chatStore.activeCard as (GroupCardLike & { groupRunning?: boolean }) | null
    if (card?.groupRunning === false) return

    await runTurn({ newTurn: true, once: opts.once })
  }

  /**
   * 旁观模式：给出话题（只记录，不触发 AI）
   *
   * 不落成我方气泡，而是渲染成一行「新话题：xxx」提示；同时写进后端会话状态。
   */
  async function giveTopic(text: string): Promise<void> {
    if (chatStore.activeSub === null) return
    chatStore.addTopicLine(text)
    chatStore.setGroupTopic(text)
    const card = chatStore.activeCard as GroupCardLike | null
    if (card?.groupSessionId) {
      await transport().setGroupTopicRemote(card.groupSessionId, text)
    }
  }

  /** 指定模式:点「指定发言」让当前选中的角色单独说一次 */
  async function speakAssigned(): Promise<void> {
    await runTurn({ newTurn: true, once: true })
  }

  /**
   * 点「开启 / 恢复对话」：接着上次的位置往下走
   *
   * newTurn=false 不重置后端轮转计数；暂停期间玩家发的消息已在会话里，会被一并纳入历史。
   */
  async function startConversation(): Promise<void> {
    await runTurn({ newTurn: false })
  }

  /** 换群 / 退出时释放会话(backend 释放后端内存;custom 清掉本地状态) */
  async function disposeSession(card: GroupCardLike): Promise<void> {
    const sid = card.groupSessionId
    if (!sid) return
    card.groupSessionId = undefined
    try {
      await transport().closeGroupSession(sid)
    } catch {
      // 释放失败不影响前端(后端也有空闲回收,本地 Map 也会超时回收)
    }
  }

  return {
    busy,
    notice,
    noticeSub,
    fetchSuggestions,
    sendMessage,
    giveTopic,
    speakAssigned,
    startConversation,
    runTurn,
    abort,
    ensureSession,
    disposeSession,
  }
}
