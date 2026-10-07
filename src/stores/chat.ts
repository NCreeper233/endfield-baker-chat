// =============================================================================
// 聊天领域 store(类型化)
// -----------------------------------------------------------------------------
// 数据结构:
//   cards: Card[]                          —— 主卡(一级卡片)
//     └─ conversations: Conversation[]     —— 子卡(二级卡片,每张主卡 ≥ 1 段)
//        └─ messages: ChatMessage[]        —— 消息列表
//
// 派生(扁平化):
//   conversations = cards.flatMap(c => c.conversations)
//   每段子对话在扁平数组中的下标即为"全局子卡索引"(activeSub)
//
// 布局算法(characterCard.ts)按每张主卡的真实子卡数量计算高度,
// 支持"主卡数量任意、每张主卡子卡数量任意(≥1)"。
// =============================================================================

import { computed, nextTick, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  Card,
  ChatMessage,
  ContextEntry,
  Conversation,
  GroupMyRole,
  GroupSpeakMode,
  MessageSpeaker,
  PlayerChoice,
} from '../types/chat'
import {
  findCharacter,
  CHARACTERS,
  DEFAULT_AVATAR_URL,
  MINE_AVATAR_URL,
  MINE_AVATAR_FEMALE_URL,
} from '../constants/character'
import { createInitialCards } from '../constants/initialCards'
import { MATERIALS } from '../constants/materials'
import { isLegacyDemoGroupShell, repairCardGroups } from '../utils/groupMeta'
import { groupTransportFor } from '../utils/groupTransport'
import { useSettingsStore } from './settings'

/**
 * 按角色名查找头像 URL
 *
 * 查 character.ts 的内置干员表;未找到回退 DEFAULT_AVATAR_URL。
 * 头像已本地托管(src/assets/avatars/,经 Vite import.meta.glob 打包)。
 */
function resolveAvatar(name: string): string {
  return findCharacter(name)?.avatar ?? DEFAULT_AVATAR_URL
}

/** "管理员"角色名(我方固定身份,AI 始终看到此名) */
export const MINE_NAME = '管理员'

/** 群聊判定门槛:成员数 ≥2 才算群聊 */
export const GROUP_MIN_MEMBERS = 2

/**
 * 群聊「继续对话」浮窗的出现间隔(条)
 *
 * 群聊里**所有角色加起来**说过这么多条消息,就浮出一个小窗问一句"还继续吗":
 *   - 点了 → 关窗、重新计数,再攒够这么多条才又出现
 *   - 没点 → 再多聊一轮就自动暂停对话(见 noteGroupRound)
 * 只数角色(非我方)的消息:玩家自己说的话不算 —— 这个浮窗管的是
 * "角色们自己聊了多少",与玩家发言无关。错误占位气泡与话题提示行也不计。
 */
export const GROUP_CONTINUE_EVERY = 20

/**
 * 群聊成员上限
 *
 * 现已**不再限制人数**(可按需求勾选全部角色),保留此常量仅为兼容引用;
 * createGroupCard 不再据此截断。
 */
export const GROUP_MAX_MEMBERS = Number.MAX_SAFE_INTEGER

/**
 * 群聊成员数量的下限
 *
 * 少于 2 个人就不成为"群"。上限已取消:创建群聊与设置界面都不再限制人数,
 * 用户要求删掉设置里「n / 5」与「群聊人数限制 2~5 人」两处字样后,
 * 上限本身也一并去掉,避免出现"没有提示却加不进人"的死角。
 */
export const GROUP_SETTINGS_MIN = 2

/**
 * 三种群聊发言模式(创建弹窗与群聊设置弹窗共用同一份文案)
 *
 *   round  轮流模式:我发言后,成员按顺序依次回复
 *   smart  智能模式:由系统判断下一个发言的成员(默认)
 *   assign 指定模式:我指定成员,被点名者单独回复
 */
export const GROUP_SPEAK_MODES: {
  key: GroupSpeakMode
  label: string
  desc: string
}[] = [
  { key: 'round', label: '轮流模式', desc: '我发言后，成员按顺序依次回复' },
  { key: 'smart', label: '智能模式', desc: '由系统判断下一个发言的成员' },
  { key: 'assign', label: '指定模式', desc: '我指定成员，被点名者单独回复' },
]

/**
 * 群聊标题里"我"的显示名
 *
 * - 旁观(observer)      → 管理员
 * - 扮演某个角色(角色名) → 该角色名
 *
 * 于是群聊名会呈现为「A、B和佩丽卡的群聊」这种"成员…和某人"的形态。
 */
export function groupSelfName(myRole?: string): string {
  // 'admin' = 我以管理员身份参与;'observer' = 旁观;其余 = 扮演该角色名
  if (!myRole || myRole === 'admin' || myRole === 'observer') return MINE_NAME
  return myRole
}

/** 群聊标题里最多展开的成员名个数(超出后折叠为「等 N 人」) */
export const GROUP_TITLE_HEAD = 3

/**
 * 用「、」和「和」连接名字:最后一个用"和"
 *   ['A']        → A
 *   ['A','B']    → A和B
 *   ['A','B','C']→ A、B和C
 */
function joinWithAnd(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join('、')}和${names[names.length - 1]}`
}

/**
 * 群聊默认名称
 *
 * 成员一多,逐个列出会把标题撑爆(列表项只有一行、聊天条也很窄),
 * 因此只展开前 3 个成员名,其余折叠成人数:
 *
 *   - 成员 ≤ 3:`A、B和C的群聊`
 *   - 成员 > 3:`A、B和C等N人的群聊`
 *
 * 人数 N = **成员数(members.length)**,与创建弹窗「已选 N 人」、
 * 设置里「2~5 人」的计数保持同一口径。
 *
 * 注意:标题只列成员名 —— "我"不再单独作为「和某某」后缀出现
 * (否则 3 人组会变成「A、B、C和管理员的群聊」4 个名字,比 4 人组的
 * 「A、B和C等4人的群聊」还长,与"最多显示 3 个名字"的规则自相矛盾)。
 * 当"我"扮演的是某个成员时,该成员本来就在 members 里,照常出现。
 *
 * @param members  成员名列表
 * @param selfName 仅在成员为空时的兜底名(保留形参以兼容既有调用方)
 */
export function groupTitle(members: string[], selfName: string = MINE_NAME): string {
  if (members.length === 0) return `${selfName}的群聊`

  const total = members.length
  if (total <= GROUP_TITLE_HEAD) return `${joinWithAnd(members)}的群聊`

  return `${joinWithAnd(members.slice(0, GROUP_TITLE_HEAD))}等${total}人的群聊`
}

/**
 * 主卡的展示身份(名称 + 头像 + 是否群聊)
 *
 * 两条分支:
 *   - 群聊(members ≥2):名称按成员推导、头像固定群聊图
 *   - 单聊:名称取首个子对话的角色名,头像查内置干员表
 *
 * `avatarAlt` 是第二张头像(目前只有「管理员」有):主卡头像可点击切换形象,
 * 由 CharacterCardItem 消费;群聊卡没有这个概念,不出这个字段。
 */
export function resolveCardIdentity(card: Card): {
  name: string
  avatar: string
  isGroup: boolean
  avatarAlt?: string
} {
  const members = card.members ?? []
  if (members.length >= GROUP_MIN_MEMBERS) {
    return {
      name: groupTitle(members, groupSelfName(card.myRole)),
      // 群聊主卡的头像由 GroupCardItem 用成员头像拼九宫格自绘,
    // 这里只给中性占位,避免空 src(该字段目前没有消费方)
      avatar: DEFAULT_AVATAR_URL,
      isGroup: true,
    }
  }
  const name = card.conversations[0]?.name ?? ''
  return {
    name,
    avatar: resolveAvatar(name),
    isGroup: false,
    // 有第二张形象的角色才能点着切换(见 CharacterCardItem)
    avatarAlt: findCharacter(name)?.avatarAlt,
  }
}

// 【已注释停用】角色名称显示功能整体停用,以下状态与开关一并注释保留,便于日后恢复。
// /** 角色名称显示开关的 localStorage key(设置类数据,独立于工程数据) */
// const CHAR_NAMES_STORAGE_KEY = 'endfield-baker-char-names'
//
// /** 读取角色名称显示开关(未记录 / 读取异常回退 false) */
// function readCharacterNamesToggle(): boolean {
//   try {
//     return localStorage.getItem(CHAR_NAMES_STORAGE_KEY) === '1'
//   } catch {
//     return false
//   }
// }

/** 消息 id 自增工厂:取对话内当前最大 id + 1(所有发送入口共用) */
function nextMessageId(conv: Conversation): number {
  return conv.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
}

/**
 * 消息说话人头像解析(聊天区渲染 / 头像选择菜单高亮共用)
 *
 * 优先级:
 * - mine:署名为「管理员」时用 mineUrl(全局 myGender 实时派生,性别切换后
 *   已有消息头像必须跟随更新);署名为某个角色名时(群聊中玩家「扮演某角色」)
 *   用该角色的头像,且不随管理员性别变化 —— 扮演谁就显示谁的头像。
 * - other:msg.speakerAvatar > findCharacter(msg.speakerName ?? convName) > otherUrl
 *   convName 是会话原始名(旧数据未记录 speakerName 时回退,读对话名查角色);
 *   otherUrl 是会话默认对方头像(不在角色表 → 无黄圈属预期)。
 *
 * @param msg         消息(speakerAvatar/speakerName/侧别)
 * @param convName    会话原始名(activeSub 对应 conversation.name)
 * @param otherUrl    other 侧默认头像(会话角色头像)
 * @param mineUrl     全局管理员头像(根据 myGender 选择男/女,实时跟随切换)
 */
function resolveMessageAvatar(
  msg: MessageSpeaker,
  convName: string,
  otherUrl: string,
  mineUrl: string,
  /**
   * 取某角色"第二张形象"的头像 URL(没有第二张 / 未切换到那张时返回 undefined)
   *
   * 由 store 侧注入(需要读设置里的形象开关),这样这个纯函数仍然只认参数。
   */
  altAvatarOf?: (name: string) => string | undefined,
): string {
  if (msg.side === 'mine') {
    // 群聊「扮演某角色」时发出的消息:保留该角色头像,不随管理员性别切换
    const selfName = msg.speakerName
    if (selfName && selfName !== MINE_NAME) {
      const c = findCharacter(selfName)
      if (c?.avatar) return altAvatarOf?.(selfName) ?? c.avatar
      if (msg.speakerAvatar) return msg.speakerAvatar
    }
    return mineUrl
  }
  // other 侧:角色表里查得到就取**实时**头像 —— 不看消息里存的那份快照。
  // 这样"管理员换形象"能立刻反映到**历史消息**上(与 mine 侧跟随 myGender 同一逻辑);
  // 查不到时再退回消息存的 speakerAvatar(群聊里未收录成员),最后退回会话默认头像。
  const name = msg.speakerName ?? convName
  if (name) {
    const c = findCharacter(name)
    if (c) return altAvatarOf?.(name) ?? c.avatar
  }
  if (msg.speakerAvatar) return msg.speakerAvatar
  return otherUrl
}

/**
 * mine 侧消息是否由「我扮演的角色」发出(群聊角色扮演),而非管理员身份
 *
 * 头像解析与头像点击(切换管理员性别)都以此判别,避免"扮演角色时点头像
 * 却切换了管理员性别"。
 */
export function isRolePlayMessage(msg: MessageSpeaker): boolean {
  return msg.side === 'mine' && !!msg.speakerName && msg.speakerName !== MINE_NAME
}

/**
 * 单个 AI 响应请求的上下文
 *
 * 【为什么需要】原实现把"目标会话 / 说话人 / 消息 id / AbortController"
 * 放在一组全局单例状态里,同一时刻只能描述一个响应。当用户在会话 A 的回复
 * 还没到达就切到会话 B 发消息时,B 的请求会覆盖这组状态,于是 A 的回复被写进
 * B(反之亦然),并带上 B 的角色头像与语气——即玩家反馈的"串台"。
 *
 * 【现在】每次响应持有独立上下文,按会话下标存放:
 *   - 目标会话在发起时锁定,之后切换会话不影响写入位置
 *   - 说话人(名称/头像)在发起时捕获,不会被其他请求覆盖
 *   - token 用于识别陈旧响应:同一会话若又发起了新请求,
 *     旧请求返回时 token 已失效,其内容直接丢弃,不再串入
 *
 * 定义在 store 之外并导出:回复的分段 / 分拍显示(useAiChat / useGroupChat /
 * useReplyReveal)都要显式传递它。
 */
export interface AiResponseCtx {
  /** 请求序号(识别陈旧响应) */
  token: number
  /** 目标会话下标(发起时锁定,不受之后切换会话影响) */
  sub: number
  /** 本轮 AI 说话人(发起时捕获,不会被其他请求覆盖) */
  speaker: { name: string; avatar: string }
  /** 本段正在追加的目标消息 id */
  messageId: number | null
  /**
   * 本轮回复的**第一条**消息 id
   *
   * 单聊 SSE 流式下第一段可能比 done 帧先落字,而 mood 是随 done 一起到的 ——
   * setPendingAiMood 只在"创建消息这一刻"被消费,那时 mood 还没到,
   * 于是靠这个记住首条消息,收尾时把 mood 补写上去(见 setFirstAiMood)。
   */
  firstMessageId: number | null
  /** 中止控制器(每个响应独立,互不干扰) */
  controller: AbortController
  /** 待写入下一条消息的心情表情 token */
  mood?: string
  /**
   * 本条 AI 回复应插入到哪条消息**之后**（消息 id）
   *
   * 只在「重新生成某一轮」时设置：该轮旧 AI 回复已被 prepareRegenerate 删除，
   * 新回复必须插回**原来的位置**（那条用户消息之后），否则会 append 到对话末尾 ——
   * 症状就是「重新生成第 1 条，新消息却出现在第 3 条下面」。
   *
   * undefined = 正常追加到末尾（所有常规发送路径）。
   */
  insertAfterMessageId?: number
  /**
   * 本轮**最后一条已落位**的 AI 消息 id（内部记账）
   *
   * 插入时从它继续往后排，保证"重新生成一轮里的多段回复"顺序不倒挂。
   * 与 insertAfterMessageId 不同：后者是固定锚点（用户消息），本字段随之滚动。
   */
  lastInsertedId?: number
}

/**
 * 删除模式下"删什么"
 *
 *   conversation 整段对话(连同消息与上下文;内置角色的最后一段改为清空)
 *   history      只清可见的聊天历史(AI 上下文记忆保留)
 *   context      只清 AI 的上下文记忆(聊天记录保留)
 */
export type DeleteKind = 'conversation' | 'history' | 'context'

export const useChatStore = defineStore('chat', () => {
  /**
   * 设置 store(角色形象开关等显示偏好在这里)
   *
   * 依赖方向是 chat → settings(settings 不反向依赖 chat),pinia 的 setup store
   * 允许在 setup 内直接取用另一个 store。
   */
  const settingsStore = useSettingsStore()

  /** 主卡数据(每张主卡下挂任意数量子卡对话) */
  // 用 createInitialCards() 的独立副本 seed,绝不直接引用 INITIAL_CARDS 常量:
  // store 增删是原地 push / splice,若与模块常量别名会互相泄漏(见 initialCards.ts)。
  const cards = ref<Card[]>(createInitialCards())

  /** 每张主卡的折叠状态(默认全部收起) */
  const collapsed = ref<boolean[]>(cards.value.map(() => true))

  /**
   * 扁平化后的全部子卡对话(按主卡顺序串联)
   *
   * 全局子卡索引(activeSub 等)均针对此扁平数组。
   */
  const conversations = computed<Conversation[]>(() =>
    cards.value.flatMap((c) => c.conversations),
  )

  /** 当前激活的子卡全局索引(null = 未选中任何对话) */
  const activeSub = ref<number | null>(null)

  // 【已注释停用】角色名称显示功能整体停用,以下状态与开关一并注释保留,便于日后恢复。
  // /**
  //  * 是否显示对话内角色名称(小号灰字悬浮于带头像的气泡上方)
  //  *
  //  * 设置类数据:localStorage 独立 key 持久化(与 useCustomBackground 同类,
  //  * 不随 .baker 导出、不受清空对话影响)。读取异常/写入失败静默降级。
  //  */
  // const showCharacterNames = ref(readCharacterNamesToggle())
  //
  // function toggleShowCharacterNames() {
  //   showCharacterNames.value = !showCharacterNames.value
  //   try {
  //     localStorage.setItem(CHAR_NAMES_STORAGE_KEY, showCharacterNames.value ? '1' : '0')
  //   } catch {
  //     // 存储失败:仅本次会话生效,刷新恢复默认,不影响主流程
  //     console.warn('[store] 角色名称开关保存失败,刷新后将重置')
  //   }
  // }

  /**
   * 顶部聊天条图片下标(三图循环切换)
   *
   * 存于 store:导出模式渲染的独立 ChatArea 实例共享同一份状态,
   * 保证导出的聊天条样式与主界面当前切换到的完全一致。
   */
  const stripVariantIndex = ref(0)

  /**
   * 每张主卡的"起始全局子卡索引"(用于 activeSub → cardIndex 反查)
   *
   * 长度 = 主卡数 + 1(末位追加总和便于区间计算)。
   * 例如主卡下子卡数 [1,2,2,2,2,2],则 starts = [0,1,3,5,7,9,11]。
   */
  const cardSubStarts = computed<number[]>(() => {
    const starts: number[] = [0]
    let acc = 0
    for (const c of cards.value) {
      acc += c.conversations.length
      starts.push(acc)
    }
    return starts
  })

  /**
   * 每张主卡下的全局子卡索引区间 [start, end)
   *
   * 用于 CharacterCardItem 遍历渲染该主卡下的所有子卡。
   */
  const cardSubRanges = computed<{ start: number; count: number }[]>(() =>
    cards.value.map((_, i) => ({
      start: cardSubStarts.value[i],
      count: cardSubStarts.value[i + 1] - cardSubStarts.value[i],
    })),
  )

  /**
   * 当前选中的主卡索引(null = 未选中任何角色)
   *
   * 由用户点击主卡(selectCard)或选中子对话(selectSub)设置:
   * - 点击主卡:仅选中主卡(白色遮罩),不改变 activeSub(可不进入子对话)
   * - 选中子对话:同时同步所属主卡
   * 新建对话以它为准:选中父卡后即使未进入子对话也可新建。
   */
  const activeCardIndex = ref<number | null>(null)

  /** 由子对话索引反查所属主卡(不存在返回 null) */
  function cardIndexOfSub(sub: number): number | null {
    if (sub < 0) return null
    for (let i = cardSubStarts.value.length - 1; i >= 0; i--) {
      if (sub >= cardSubStarts.value[i]) return i
    }
    return null
  }

  /** 同步 activeCardIndex 到 activeSub 所属主卡(activeSub 为 null 时不动,保留用户选中) */
  function syncActiveCardFromSub(): void {
    if (activeSub.value === null) return
    activeCardIndex.value = cardIndexOfSub(activeSub.value)
  }

  /**
   * 选中主卡(父级角色卡片)
   *
   * 仅设置选中态(白色遮罩)并折叠切换由调用方负责;不改变 activeSub,
   * 因此"未进入子对话"时也能选中父卡,用于在其下新建对话。
   *
   * @param index 主卡索引
   */
  function selectCard(index: number): void {
    activeCardIndex.value = index
  }

  /**
   * 选中某张主卡,并进入它的第 subOffset 个子对话
   *
   * 群聊卡（主卡级、无独立子卡入口）点击时用它：既高亮主卡，也让右侧切到该群聊。
   *
   * @param cardIndex 主卡下标
   * @param subOffset 该主卡下第几段子对话（默认第一段）
   */
  function selectCardConversation(cardIndex: number, subOffset = 0): void {
    const start = cardSubStarts.value[cardIndex]
    if (start === undefined) return
    activeCardIndex.value = cardIndex
    const idx = start + subOffset
    if (idx >= 0 && idx < conversations.value.length) activeSub.value = idx
  }

  /**
   * 每段子对话的派生数据(title/avatar)
   *
   * title = 会话名(角色名),avatar = 角色头像(查内置干员表)。
   */
  const conversationMeta = computed(() =>
    cards.value.flatMap((card) =>
      card.conversations.map((conv) => ({
        title: conv.name || '未命名会话',
        avatar: resolveAvatar(conv.name),
      })),
    ),
  )

  /** 当前对话的派生数据(null = 未选中对话) */
  const currentConversationMeta = computed(() =>
    activeSub.value === null ? null : conversationMeta.value[activeSub.value],
  )

  /** 当前对话的对方姓名(显示在聊天条;未选中时为空串) */
  const counterpartName = computed<string>(() => currentConversationMeta.value?.title ?? '')

  /**
   * 当前对话"对方"头像 URL(聊天区用)
   *
   * 私聊:该角色头像;不在角色表:回退默认头像。
   * 若该角色有两张形象(目前只有「管理员」)且玩家切换过,这里跟着取第二张 ——
   * 与角色卡读的是**同一份**设置状态(settings.avatarAltOn),两处永远一致。
   */
  const currentOtherAvatarUrl = computed(() => {
    if (activeSub.value === null) return DEFAULT_AVATAR_URL
    const name = conversations.value[activeSub.value].name
    const character = findCharacter(name)
    if (character?.avatarAlt && settingsStore.isAvatarAltOn(name)) return character.avatarAlt
    return resolveAvatar(name)
  })

  /**
   * 取某角色"第二张形象"的头像 URL
   *
   * 只有双形象角色(目前「管理员」)且玩家切到了第二张时才返回 ——
   * 供 currentOtherAvatarUrl 与消息头像解析(resolveMessageAvatar)共用。
   */
  function altAvatarOf(name: string): string | undefined {
    const character = findCharacter(name)
    if (!character?.avatarAlt) return undefined
    return settingsStore.isAvatarAltOn(name) ? character.avatarAlt : undefined
  }

  /**
   * 点聊天区"对方"头像:该角色若有两张形象就换一张
   *
   * (目前只有「管理员」。没有第二张形象的角色返回 false,调用方什么都不做 ——
   *  与改动前的行为一致。)
   *
   * @returns 是否真的切换了
   */
  function toggleCounterpartAvatarAlt(): boolean {
    const name = counterpartName.value
    const character = findCharacter(name)
    if (!character?.avatarAlt) return false
    settingsStore.toggleAvatarAlt(name)
    return true
  }

  // ---- 会话创作 -----------------------------------------------------------
  /**
   * 全局管理员性别(仅影响头像,不影响 AI 感知)
   *
   * - 'male'(默认):使用 管理员_男.webp
   * - 'female':使用 管理员_女.webp
   * 全局生效,所有对话共享。AI 始终只看到"管理员",不感知性别。
   */
  const myGender = ref<'male' | 'female'>('male')

  /** 我方管理员头像(根据全局 myGender 选择男/女) */
  const myAvatar = computed(() =>
    myGender.value === 'female' ? MINE_AVATAR_FEMALE_URL : MINE_AVATAR_URL,
  )

  /** 切换全局管理员性别(male ↔ female),仅影响头像显示 */
  function toggleMyGender() {
    myGender.value = myGender.value === 'female' ? 'male' : 'female'
  }

  /** 直接设置全局管理员性别(持久化恢复 / 导入时调用) */
  function setMyGender(g: 'male' | 'female') {
    myGender.value = g
  }

  /**
   * 新建会话:在选中的主卡下追加子会话
   *
   * 选中来源:点击主卡(selectCard,无需进入子对话)或选中子对话(selectSub)。
   * 新子卡自动选中并进入。若父级卡片处于折叠状态,自动展开以显示新子卡。
   */
  function createChildConversation(): boolean {
    if (activeCardIndex.value === null) return false
    const idx = activeCardIndex.value
    const card = cards.value[idx]
    if (!card) return false
    // 群聊主卡不支持"再建一个子会话":群聊在列表里就是一整张卡,
    // 建出来的空子会话会以空占位形式挤进群聊列表(无名字、无内容)。
    if (isGroupCardAt(idx)) return false
    // 新子对话继承父卡角色名(与第一张子对话一致),
    // 确保提示词 / 头像 / 预览文本 / 成员推导均正确。
    // 若父卡首对话无角色名(异常情况),回退"未命名会话"。
    const characterName = card.conversations[0]?.name ?? '未命名会话'
    card.conversations.push({ name: characterName, messages: [] })
    // 父级卡片折叠时自动展开,让用户看到新子卡
    if (collapsed.value[idx]) collapsed.value[idx] = false
    activeSub.value = cardSubStarts.value[idx + 1] - 1
    return true
  }

  /**
   * 创建群聊主卡
   *
   * 纯 UI 能力:只负责往 cards 里插入一张群聊主卡并选中它,不涉及任何后端。
   *
   * @param members 成员名列表(去重后取前 5 个;少于 2 个则拒绝创建)
   * @param myRole  我在群里的身份:admin = 管理员(默认);observer = 旁观;
   *                字符串 = 扮演该角色的名字
   * @param title   自定义群聊名(缺省按 groupTitle 推导)
   * @param speakMode 聊天形式(缺省 'smart' 智能模式)
   * @returns       新建群聊所在的子卡下标;创建失败返回 null
   */
  function createGroupCard(
    members: string[],
    myRole: GroupMyRole = 'admin',
    title?: string,
    speakMode: GroupSpeakMode = 'smart',
  ): number | null {
    // 去重(不再限制人数上限,可选全部角色)
    const list: string[] = []
    for (const m of members) {
      if (m && list.indexOf(m) === -1) list.push(m)
    }
    if (list.length < GROUP_MIN_MEMBERS) return null

    const name = (title ?? '').trim() || groupTitle(list, groupSelfName(myRole))
    const card: Card = {
      members: list,
      myRole,
      speakMode,
      // 指定模式:默认点名第一位成员,之后可在聊天区末尾的胶囊里换人
      assignTarget: speakMode === 'assign' ? list[0] : undefined,
      conversations: [{ name, messages: [] }],
    }
    cards.value.push(card)
    collapsed.value.push(true)
    // 建群后切到群聊列表并选中新建的群聊
    chatMode.value = 'group'
    activeCardIndex.value = cards.value.length - 1
    activeSub.value = conversations.value.length - 1
    return activeSub.value
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  群聊设置:改名 / 成员增删 / 发言模式 / 删除群聊
  //  (纯前端,改动经 useChatPersistence 的 watch 自动落盘到本地 JSON)
  // ═══════════════════════════════════════════════════════════════════════

  /** 判断某张主卡是不是群聊卡 */
  function isGroupCardAt(cardIndex: number): boolean {
    const card = cards.value[cardIndex]
    return !!card && (card.members ?? []).length >= GROUP_MIN_MEMBERS
  }

  /**
   * 「我的身份」是否为扮演某个角色
   *
   * admin / observer(以及缺省)都是"我本人"出场,只有扮演 X 时 X 才是被锁定成员。
   */
  function playedCharacterOf(cardIndex: number): string | null {
    const role = cards.value[cardIndex]?.myRole
    if (!role || role === 'admin' || role === 'observer') return null
    return role
  }

  /** 重命名群聊(空串则回退为按成员推导的默认名) */
  function updateGroupName(cardIndex: number, name: string): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false
    const trimmed = name.trim()
    const next =
      trimmed || groupTitle(card.members ?? [], groupSelfName(card.myRole))
    const conv = card.conversations[0]
    if (!conv || conv.name === next) return false
    conv.name = next
    return true
  }

  /**
   * 更新群聊成员
   *
   * 规则:
   *   - 去重;少于 2 人一律拒绝(返回 false,不改动数据)
   *   - 不设上限(与创建群聊一致)
   *   - 「我的身份」为扮演某角色时,该角色不可被移除
   */
  function updateGroupMembers(cardIndex: number, members: string[]): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false

    const list: string[] = []
    for (const m of members) {
      if (m && list.indexOf(m) === -1) list.push(m)
    }
    const locked = playedCharacterOf(cardIndex)
    if (locked && list.indexOf(locked) === -1) return false
    if (list.length < GROUP_SETTINGS_MIN) return false

    // 成员变化后,旧的"指定对象"可能已不在群里 → 顺带清掉
    if (card.assignTarget && list.indexOf(card.assignTarget) === -1) {
      card.assignTarget = list[0]
    }
    card.members = list
    // 成员变了,后端会话里的成员名单就过期了:作废,下一回合自动重建
    card.groupSessionId = undefined
    return true
  }

  /** 更新发言模式(指定模式下未传 target 时默认指向第一个成员) */
  function updateGroupSpeakMode(
    cardIndex: number,
    mode: GroupSpeakMode,
    assignTarget?: string,
  ): boolean {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return false
    // 发言模式在群聊创建时就确定了,后端会话据此建立调度策略。
    // 设置里改了模式 → 旧会话作废,下一回合按新模式重建。
    if (card.speakMode !== mode) card.groupSessionId = undefined
    else if (mode === 'assign') card.groupSessionId = undefined
    card.speakMode = mode
    if (mode === 'assign') {
      const members = card.members ?? []
      const target =
        assignTarget && members.indexOf(assignTarget) !== -1
          ? assignTarget
          : (card.assignTarget && members.indexOf(card.assignTarget) !== -1
              ? card.assignTarget
              : members[0])
      card.assignTarget = target
    }
    return true
  }

  /** 读取群聊设置(给弹窗做初始值,返回纯数据快照) */
  function getGroupSettings(cardIndex: number): {
    name: string
    members: string[]
    myRole: GroupMyRole
    myRoleLabel: string
    speakMode: GroupSpeakMode
    assignTarget: string
    lockedMember: string | null
  } | null {
    const card = cards.value[cardIndex]
    if (!card || !isGroupCardAt(cardIndex)) return null
    const members = (card.members ?? []).slice()
    const role = card.myRole ?? 'admin'
    const locked = playedCharacterOf(cardIndex)
    return {
      name: card.conversations[0]?.name ?? '',
      members,
      myRole: role,
      myRoleLabel: groupSelfName(role),
      speakMode: card.speakMode ?? 'smart',
      assignTarget: card.assignTarget ?? members[0] ?? '',
      lockedMember: locked,
    }
  }

  /**
   * 当前会话里「我」的身份(署名 + 头像)
   *
   * - 群聊中玩家「扮演某角色」→ 署名该角色名,头像用该角色头像
   * - 管理员 / 旁观 / 私聊        → 署名「管理员」,头像跟随全局管理员性别
   *
   * 头像解析(resolveMessageAvatar)按此署名决定显示谁的头像,因此这里必须
   * 与消息写入时的 speakerName 保持一致。
   */
  function currentSelfIdentity(): { name: string; avatar: string } {
    const role = activeCard.value?.myRole
    if (role && role !== 'admin' && role !== 'observer') {
      const c = findCharacter(role)
      return { name: role, avatar: c?.avatar || myAvatar.value }
    }
    return { name: MINE_NAME, avatar: myAvatar.value }
  }

  /**
   * 发送图片消息
   *
   * 署名取 currentSelfIdentity:私聊 / 管理员身份为「管理员」,
   * 群聊中扮演角色时为该角色名(头像随之变为该角色)。
   */
  function sendImage(image: string, width: number, height: number): ChatMessage | null {
    if (activeSub.value === null) return null
    const conv = conversations.value[activeSub.value]
    const nextId = nextMessageId(conv)
    const self = currentSelfIdentity()
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: '',
      image,
      imageW: width,
      imageH: height,
      speakerName: self.name,
      speakerAvatar: self.avatar,
    }
    conv.messages.push(msg)
    // 同步写入 AI 上下文历史(携带图片 dataURL,让 vision API 真正"看到"图片)
    // text 不能为空:裸图片会让模型进入"描述图片"模式而忽略角色人设
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: '[图片]', image })
    return msg
  }

  /**
   * 删除当前选中的子对话
   *
   * 【已并入 deleteConversationsAt】原实现只处理一段,现已改为
   * `deleteConversationsAt([activeSub])` —— 删除逻辑只有一份,
   * 单选与多选走同一条路径(见删除模式那一节)。
   */

  /**
   * contextHistory 条目匹配(删除用)
   *
   * contextHistory 条目无 id,只能按内容匹配:
   *   - 图片消息:messages 中 text 为空,contextHistory 存 "[图片]" 占位,
   *     因此按 image 匹配(忽略 text)
   *   - 文字消息:按 side + text 匹配,且条目本身无图片
   */
  function matchContextEntry(
    entry: { side: 'other' | 'mine'; text: string; image?: string },
    msg: ChatMessage,
  ): boolean {
    if (entry.side !== msg.side) return false
    if (msg.image) return entry.image === msg.image
    return entry.text === msg.text && !entry.image
  }

  /**
   * 从 contextHistory 中移除与消息匹配的条目(从后往前,避免误删更早的同内容条目)
   *
   * contextHistory 为 undefined(旧数据)时无需处理——getChatHistory 会从 messages 派生。
   */
  function removeFromContextHistory(conv: Conversation, msg: ChatMessage) {
    if (!conv.contextHistory) return
    const ch = conv.contextHistory
    for (let i = ch.length - 1; i >= 0; i--) {
      if (matchContextEntry(ch[i], msg)) {
        ch.splice(i, 1)
        return
      }
    }
  }

  /**
   * 删除单条消息(长按操作菜单 → "删除此条对话")
   *
   * 仅删除长按的那一条消息,同轮其他内容保留;
   * 同步清理 contextHistory 中对应条目,并自动触发持久化(deep watch)。
   */
  /**
   * 群聊:插入一条「新话题」提示行
   *
   * 刻意不走 sendUserMessage:话题不是"管理员说的话",不该以我方气泡出现,
   * 也不该写进 AI 上下文(后端另有 topic 字段单独接收)。
   * side 用 'other' 只是为了让它按左侧排布,行渲染器不会给它画头像/气泡。
   */
  function addTopicLine(text: string): void {
    const trimmed = (text ?? '').trim()
    if (!trimmed || activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    if (!conv) return
    conv.messages.push({
      id: nextMessageId(conv),
      side: 'other',
      text: trimmed,
      topic: true,
    })
  }

  function deleteMessage(messageId: number) {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const target = conv.messages[idx]
    conv.messages.splice(idx, 1)
    removeFromContextHistory(conv, target)
  }

  /**
   * 删除一轮对话(长按操作菜单 → "删除此轮对话")
   *
   * - 长按用户消息:删除它 + 紧随其后的第一条 AI 回复(如存在)
   * - 长按 AI 回复:删除它 + 之前的最后一条用户消息(如存在)
   * 不影响其他轮次;同步清理 contextHistory 对应条目。
   */
  function deleteRound(messageId: number) {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return
    const target = conv.messages[idx]
    const removed: ChatMessage[] = [target]

    if (target.side === 'mine') {
      // 用户消息 → 删除紧随其后的第一条 other 回复
      for (let i = idx + 1; i < conv.messages.length; i++) {
        if (conv.messages[i].side === 'other') {
          removed.push(conv.messages[i])
          break
        }
      }
    } else {
      // AI 回复 → 删除之前的最后一条 mine 消息
      for (let i = idx - 1; i >= 0; i--) {
        if (conv.messages[i].side === 'mine') {
          removed.push(conv.messages[i])
          break
        }
      }
    }

    const ids = new Set(removed.map((m) => m.id))
    conv.messages = conv.messages.filter((m) => !ids.has(m.id))
    for (const m of removed) {
      removeFromContextHistory(conv, m)
    }
  }

  /**
   * 清空全部对话(每个角色保留一个空子对话卡片)
   *
   * 删除所有子对话但每张父卡保留一个空对话(保留角色名),同时清空消息与上下文。
   */
  function clearAllConversations() {
    const next: Card[] = cards.value.map((c) => ({
      ...c,
      conversations: [{
        name: c.conversations[0]?.name ?? '未命名会话',
        messages: [],
        contextHistory: [],
      }],
    }))
    replaceAllCards(next)
  }

  /**
   * 清空某一段对话的可见消息(保留 AI 上下文记忆)
   *
   * 将已有消息先同步到 contextHistory(若尚未初始化),再清空 messages。
   * AI 仍可通过 contextHistory 记住之前的对话。
   */
  function clearMessagesAt(sub: number) {
    const conv = conversations.value[sub]
    if (!conv) return
    if (conv.contextHistory === undefined) {
      conv.contextHistory = conv.messages
        .filter((m) => m.text || m.image)
        .map((m) => {
          const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: m.side, text: m.text }
          if (m.image) entry.image = m.image
          return entry
        })
    }
    conv.messages = []
    // 消息清空后推荐也随之作废,连同持久化缓存一起丢掉(下次点开重新生成)
    delete conv.suggestions
    if (sub === activeSub.value) clearPendingChoices()
  }

  /**
   * 清空某一段对话的 AI 上下文记忆(保留可见消息)
   *
   * 屏幕上的消息仍然可见,但 AI 不再记得之前的对话。
   */
  function clearContextAt(sub: number) {
    const conv = conversations.value[sub]
    if (conv) {
      conv.contextHistory = []
      // 上下文已清空 → 累计输出 token 归零（否则智能总结会立刻误触发一次）
      conv.sessionOutputTokens = 0
    }
  }

  /** 清空全部对话的可见消息(保留 AI 上下文记忆) */
  function clearAllMessages() {
    conversations.value.forEach((_, i) => clearMessagesAt(i))
  }

  /** 清空全部对话的 AI 上下文记忆(保留可见消息) */
  function clearAllContext() {
    conversations.value.forEach((_, i) => clearContextAt(i))
  }

  /**
   * 应用一次上下文压缩(压缩的唯一写入口)
   *
   * 丢弃最旧的 dropCount 条历史,并可选地在头部插入一条"冻结摘要"。
   *
   * "冻结"是关键:该摘要条目在下一次压缩发生前不再变化,从而保证相邻两次
   * 请求的消息前缀逐字节一致 —— 这是缓存命中的前提
   * (依据 DeepSeek Context Caching:缓存前缀必须被完整匹配)。
   * 因此禁止每轮重新生成摘要。
   *
   * 注意:这里刻意**不动 messages**(屏幕上的气泡不受影响),
   * 只改 contextHistory —— 压缩的是"发给 AI 的记忆",不是"用户看到的聊天记录"。
   *
   * @param sub         目标对话的全局子卡索引
   * @param dropCount   从历史头部丢弃的条目数
   * @param summaryText 冻结摘要正文(调用方带上【对话总结】前缀);为空则只丢弃不插摘要
   * @returns 实际丢弃的条目数
   */
  function applyCompaction(sub: number, dropCount: number, summaryText?: string): number {
    const conv = conversations.value[sub]
    if (!conv) return 0
    const history = conv.contextHistory
    if (!history || history.length === 0) return 0

    const drop = Math.max(0, Math.min(dropCount, history.length))
    const kept = history.slice(drop)
    if (summaryText) {
      const entry: ContextEntry = { side: 'mine', text: summaryText }
      conv.contextHistory = [entry, ...kept]
    } else {
      conv.contextHistory = kept
    }
    return drop
  }

  // ---- 删除模式(纯 UI,不持久化) ---------------------------------------------
  // 由操作带的删除按钮进入:列表里多选若干段对话,底部条选删除对象并执行。
  // 放在 store 而不是某个组件里:勾选态要被三处读取 —— 列表项(要不要画黄条)、
  // 底部条(已选数量)、以及点击分流(删除模式下点卡片是勾选,不是切会话)。

  /** 是否处于删除模式 */
  const deleteMode = ref(false)

  /** 已勾选的子卡(全局下标) */
  const deleteSelection = ref<number[]>([])

  /** 删除对象:整段对话 / 可见历史 / AI 上下文 */
  const deleteKind = ref<DeleteKind>('conversation')

  /**
   * 删除历史 / 上下文时的「连带清除」勾选(默认不勾)
   *
   * 只对 history / context 两种删除对象有意义:
   *   history + 勾选 → 清聊天记录的同时也清掉 AI 记忆
   *   context + 勾选 → 清 AI 记忆的同时也清掉聊天记录
   * 两者都勾上时,效果等价于"只保留对话本身,内容全清"。
   * 「删除对话」是整段连根拔除,不存在连带项,故勾选态对它无效。
   */
  const deleteLinked = ref(false)

  /** 已勾选数量(底部条显示"已选 N 段") */
  const deleteCount = computed(() => deleteSelection.value.length)

  /** 某一段对话是否已勾选(列表项据此画悬浮黄条) */
  function isDeleteSelected(sub: number): boolean {
    return deleteSelection.value.indexOf(sub) !== -1
  }

  /**
   * 进入 / 退出删除模式
   *
   * 进入时**默认勾上当前选中的那段对话** —— 玩家点删除多半就是想删它,
   * 少点一次;退出时清空勾选,下次进来是干净状态。
   *
   * 删除对象也一并复位为「删除对话」:它是破坏性操作,若沿用上一次的选择
   * (比如上次选了"删除上下文"),这次点删除就会去清 AI 记忆而不是删对话 ——
   * 与玩家看到的按钮名不符,是很容易误操作的。
   */
  function toggleDeleteMode(): void {
    if (deleteMode.value) {
      exitDeleteMode()
      return
    }
    deleteMode.value = true
    deleteKind.value = 'conversation'
    deleteLinked.value = false
    deleteSelection.value = activeSub.value === null ? [] : [activeSub.value]
  }

  /** 退出删除模式并清空勾选 */
  function exitDeleteMode(): void {
    deleteMode.value = false
    deleteSelection.value = []
    deleteLinked.value = false
  }

  /** 勾选 / 取消勾选一段对话 */
  function toggleDeleteSelect(sub: number): void {
    const i = deleteSelection.value.indexOf(sub)
    if (i === -1) deleteSelection.value.push(sub)
    else deleteSelection.value.splice(i, 1)
  }

  /**
   * 切换删除对象(整段对话 / 历史 / 上下文)
   *
   * 切走时把「连带清除」复位 —— 这个勾选框只对历史 / 上下文有意义,
   * 留着上一次的勾选会让下次切回来时"没点过却已经是勾上的",容易被误删。
   */
  function setDeleteKind(kind: DeleteKind): void {
    deleteKind.value = kind
    deleteLinked.value = false
  }

  /** 勾选 / 取消「连带清除」 */
  function setDeleteLinked(value: boolean): void {
    deleteLinked.value = value
  }

  /**
   * 执行删除(底部条的「删除」按钮)
   *
   * @returns 实际处理了几段对话(用于提示)
   */
  function runDelete(): number {
    const subs = deleteSelection.value.slice()
    if (subs.length === 0) return 0
    const linked = deleteLinked.value
    let done = subs.length
    if (deleteKind.value === 'conversation') {
      done = deleteConversationsAt(subs)
    } else if (deleteKind.value === 'history') {
      subs.forEach((s) => clearMessagesAt(s))
      // 连带:同时清掉 AI 记忆
      if (linked) subs.forEach((s) => clearContextAt(s))
    } else {
      subs.forEach((s) => clearContextAt(s))
      // 连带:同时清掉聊天记录
      if (linked) subs.forEach((s) => clearMessagesAt(s))
    }
    exitDeleteMode()
    return done
  }

  // ---- 选中消息导出(纯 UI,不持久化) -----------------------------------------
  // 消息右键菜单点「导出选中消息」进入:勾选若干条消息,导出为一张长图。
  // 导出本身复用整套既有实现(离屏画布 / 裁剪 / 下载),这里只负责"选哪几条";
  // 与删除模式同一套做法:状态放 store,列表项(要不要高亮)与底部条都要读。

  /** 是否处于"选中消息"模式 */
  const msgSelectMode = ref(false)

  /** 已选消息 id(**当前会话内**) */
  const selectedMsgIds = ref<number[]>([])

  /** 已选条数 */
  const selectedMsgCount = computed(() => selectedMsgIds.value.length)

  /** 某条消息是否已选 */
  function isMsgSelected(id: number): boolean {
    return selectedMsgIds.value.indexOf(id) !== -1
  }

  /** 进入选中消息模式(右键那条默认选中) */
  function startMsgSelect(id?: number): void {
    msgSelectMode.value = true
    selectedMsgIds.value = typeof id === 'number' ? [id] : []
  }

  /** 退出选中消息模式 */
  function exitMsgSelect(): void {
    msgSelectMode.value = false
    selectedMsgIds.value = []
  }

  /** 勾选 / 取消勾选一条消息 */
  function toggleMsgSelect(id: number): void {
    const i = selectedMsgIds.value.indexOf(id)
    if (i === -1) selectedMsgIds.value.push(id)
    else selectedMsgIds.value.splice(i, 1)
  }

  /**
   * 已选消息(按会话内原有顺序)
   *
   * 顺序必须按 messages 的原始次序取:导出的排版沿用 useChatRows,
   * 与勾选先后无关 —— 否则导出的图里消息顺序会是乱的。
   */
  const selectedMessages = computed<ChatMessage[]>(() => {
    if (activeSub.value === null || selectedMsgIds.value.length === 0) return []
    const msgs = conversations.value[activeSub.value]?.messages ?? []
    return msgs.filter((m) => selectedMsgIds.value.indexOf(m.id) !== -1)
  })

  // --- 批量删除对话的实现 -----------------------------------------------------

  /** 释放某张群聊卡的会话(删除卡片时调用;失败也无妨,传输层都有自愈回收) */
  function releaseGroupSession(card: Card): void {
    const sid = card.groupSessionId
    if (!sid) return
    card.groupSessionId = undefined
    // 按当前 API 模式选择传输层:
    //   backend → 通知后端释放会话;custom → 清掉前端本地会话状态。
    // (此前写死 import groupBackend:custom 模式下也会打后端 /group/session/close)
    void groupTransportFor(settingsStore.apiConfig.apiMode)
      .closeGroupSession(sid)
      .catch(() => { /* 忽略 */ })
  }

  /**
   * 批量删除若干段对话(唯一的删除实现;单选删除 = 传一个下标)
   *
   * 规则(沿用旧版单选删除的语义,只是可一次传多段):
   *   - 内置角色的**最后一段**对话不删卡:改为清空它(消息 + 上下文),
   *     因为内置角色卡片常驻,没有"删掉整张卡"的说法;
   *   - 其余情况从卡上摘掉;某张卡一段不剩 → 整张卡删除(同步 collapsed),
   *     群聊卡顺带释放后端会话;
   *   - 删完重选:原选中还在就留在原地,否则落到"被删位置处的下一段",
   *     全删空则清空选中;群聊模式下选中必须落在剩下的某张群聊卡上,
   *     一张不剩就退回单聊列表。
   *
   * @returns 实际删掉的对话段数
   */
  function deleteConversationsAt(subs: number[]): number {
    const drop = new Set(subs.filter((s) => s >= 0 && s < conversations.value.length))
    if (drop.size === 0) return 0

    const prevSub = activeSub.value

    // 1) 先算出最终保留哪些全局子卡(内置角色的"最后一段"在这里被改成"清空")
    const keep = new Set<number>()
    let offset = 0
    for (const card of cards.value) {
      const globals = card.conversations.map((_, li) => offset + li)
      const survivors = globals.filter((g) => !drop.has(g))
      const isBuiltin = CHARACTERS.some((c) => c.name === card.conversations[0]?.name)
      if (survivors.length === 0 && isBuiltin && globals.length > 0) {
        const conv = card.conversations[0]
        conv.messages = []
        conv.contextHistory = []
        keep.add(globals[0])
      } else {
        survivors.forEach((g) => keep.add(g))
      }
      offset += card.conversations.length
    }

    // 2) 落库:倒序处理,边删边算下标不会错位
    let start = conversations.value.length
    for (let ci = cards.value.length - 1; ci >= 0; ci--) {
      const card = cards.value[ci]
      const count = card.conversations.length
      start -= count
      const kept = card.conversations.filter((_, li) => keep.has(start + li))
      if (kept.length === count) continue
      if (kept.length === 0) {
        releaseGroupSession(card)
        cards.value.splice(ci, 1)
        collapsed.value.splice(ci, 1)
        continue
      }
      card.conversations = kept
    }

    // 3) 重选:新下标 = "原选中之前还活着几段"
    const total = keep.size
    const beforePrev = prevSub === null ? 0 : Array.from(keep).filter((g) => g < prevSub).length
    let nextSub: number | null = total === 0 ? null : Math.min(beforePrev, total - 1)

    if (chatMode.value === 'group') {
      // 群聊列表里只列群聊:落点若不在群聊卡上,挪到最近的一张(优先原位置之后)
      let off = 0
      let firstGroup: number | null = null
      let afterPrev: number | null = null
      for (const card of cards.value) {
        const isGroup = (card.members ?? []).length >= GROUP_MIN_MEMBERS
        if (isGroup) {
          if (firstGroup === null) firstGroup = off
          if (afterPrev === null && prevSub !== null && off >= prevSub) afterPrev = off
        }
        off += card.conversations.length
      }
      if (firstGroup === null) {
        chatMode.value = 'single'
      } else {
        nextSub = afterPrev ?? firstGroup
      }
    }

    activeSub.value = nextSub
    if (nextSub === null) activeCardIndex.value = null
    else syncActiveCardFromSub()

    return drop.size
  }

  /**
   * 每张主卡的干员数据(name + avatar URL)
   *
   * 取每张主卡首段子对话的角色名和头像。
   */
  const cardCharacters = computed(() =>
    cards.value.map((c) => resolveCardIdentity(c)),
  )

  // ---- AI 响应上下文(按会话隔离,支持跨会话并发) --------------------------
  /** AI 请求自增序号(生成 token) */
  let aiReqSeq = 0

  /** 各会话当前活跃的 AI 响应上下文(key = 会话下标;内部机制,无需响应式) */
  const aiCtxBySub = new Map<number, AiResponseCtx>()

  /** 正在显示 LoadingBubble 的会话下标(响应式) */
  const aiLoadingSubs = ref<number[]>([])

  /** 正在响应中(可中止)的会话下标(响应式) */
  const aiRespondingSubs = ref<number[]>([])

  /**
   * 本轮回复**已经落过内容**的会话下标(响应式)
   *
   * 用途:区分"本轮回复刚开始、还不知道首条长什么样"与"本轮已经出过内容、
   * 这只是前端分条后的下一段" —— 只有前者才该用居中三点加载态
   * (见 useChatRows.loadingLayout 与 LoadingBubble 文件头)。
   *
   * 生命周期与本轮响应一致:beginAiResponse 时清除、首次 appendAiChunk 时加入、
   * 响应结束/中止时随 clearCtxState 清掉。
   */
  const aiEmittedSubs = ref<number[]>([])

  /** 各会话当前 AI 说话人(响应式,供加载气泡显示头像/名称) */
  const aiSpeakers = ref<Record<number, { name: string; avatar: string }>>({})

  /** 数组去重插入 */
  function addSub(arr: number[], sub: number) {
    if (!arr.includes(sub)) arr.push(sub)
  }

  /** 数组移除 */
  function removeSub(arr: number[], sub: number) {
    const i = arr.indexOf(sub)
    if (i !== -1) arr.splice(i, 1)
  }

  /** 设置某会话的说话人(null 表示清除);对象整体替换以触发响应式 */
  function setAiSpeaker(sub: number, speaker: { name: string; avatar: string } | null) {
    const next = { ...aiSpeakers.value }
    if (speaker) next[sub] = speaker
    else delete next[sub]
    aiSpeakers.value = next
  }

  /** 读取当前会话的 AI 响应上下文 */
  function currentAiCtx(): AiResponseCtx | undefined {
    const sub = activeSub.value
    if (sub === null) return undefined
    return aiCtxBySub.get(sub)
  }

  /** 解析目标上下文:显式传入优先,缺省取当前会话 */
  function resolveCtx(ctx?: AiResponseCtx | null): AiResponseCtx | undefined {
    return ctx ?? currentAiCtx()
  }

  /**
   * 上下文是否仍然有效
   *
   * 同一会话若已发起更新的请求,旧上下文的 token 不再匹配 → 返回 false,
   * 其迟到内容会被各处写入方法直接丢弃(防串台的关键)。
   */
  function isCtxActive(ctx?: AiResponseCtx | null): boolean {
    if (!ctx) return false
    return aiCtxBySub.get(ctx.sub)?.token === ctx.token
  }

  /** 清理某会话的全部响应态(loading / responding / 说话人 / 本轮已落内容标记) */
  function clearCtxState(sub: number) {
    removeSub(aiLoadingSubs.value, sub)
    removeSub(aiRespondingSubs.value, sub)
    removeSub(aiEmittedSubs.value, sub)
    setAiSpeaker(sub, null)
  }

  /**
   * 标记"本轮回复已经开始"(用于加载态选择)
   *
   * 正常单聊不需要调用:beginAiResponse 起新一轮、appendAiChunk 首次落内容时自动维护。
   * 群聊例外 —— 同一段后端回复被前端拆成多段,而**每段都走一次**
   * beginAiResponse → appendAiChunk → finishAiResponse(每段要有自己的加载节拍),
   * 于是第 2 段起会被误判成"新一轮刚开始"。调用方对这些续段显式标记一次,
   * 它们就会照旧使用"头像 + 加载气泡",而不是首拍专用的居中三点加载态。
   */
  function markAiTurnStarted(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (c) addSub(aiEmittedSubs.value, c.sub)
  }

  /**
   * 是否处于 loading 阶段(显示 LoadingBubble 的判据)
   *
   * 按会话计算:只有"正在响应的那个会话"才显示加载气泡。
   * 切到其他会话时自然为 false,不再需要"切换即强制关闭 loading"。
   */
  const isLoading = computed(
    () => activeSub.value !== null && aiLoadingSubs.value.includes(activeSub.value),
  )

  /**
   * 当前会话本轮回复是否已经落过内容(前端分条后的"这只是下一段")
   *
   * false = 本轮回复刚开始,首条还没出现(可能是居中条 → 用居中三点加载态);
   * true  = 已经出过内容,后面这些加载都是同一轮回复的分条续段
   *         (说话人已经建立 → 照旧用头像 + 加载气泡)。
   */
  const aiTurnHasContent = computed(
    () => activeSub.value !== null && aiEmittedSubs.value.includes(activeSub.value),
  )

  /**
   * 子卡预览文本
   *
   * 直接返回每段对话最后一条消息的文本(空对话返回空串)。
   * 图片消息预览显示 "[图片]"。
   */
  const subPreviewTexts = computed<string[]>(() =>
    conversations.value.map((conv) => {
      const msgs = conv.messages
      if (msgs.length === 0) return ''
      const msg = msgs[msgs.length - 1]
      if (msg.image) return '[图片]'
      return msg.text || ''
    }),
  )

  /**
   * 当前对话的消息列表(供 ChatArea 渲染)
   *
   * AI 聊天模式下消息由用户发送 + AI 流式回复直接追加到对话中。
   */
  // ---- 侧边栏模式(单聊 / 群聊) ----------------------------------------------
  /**
   * 侧边栏列表模式
   *
   * - single:显示单聊列表(非群聊主卡)
   * - group :显示群聊列表(成员 ≥2 的主卡)
   */
  const chatMode = ref<'single' | 'group'>('single')

  /**
   * 切换侧边栏模式(单聊 / 群聊)
   *
   * 两种模式的会话互不相干,所以**模式真的变了就清空选中态**,让右侧聊天区
   * 回到起始页("请选择会话")。否则切到另一种模式时,聊天区还显示着上一个
   * 模式的对话 —— 与左侧列表对不上,还容易把消息发进"看不见的那张卡"里。
   *
   * 只在模式变化时清:同模式重复点击(理论上不会发生)不该误伤当前会话。
   * 注意 createGroupCard / deleteGroupCard 是直接写 chatMode.value 的,
   * 它们需要连同选中态一起安排(建群后选中新群、删群后切到剩余群),
   * 因此不走这里 —— 那里的选中态不会被本函数清掉。
   */
  function setChatMode(mode: 'single' | 'group'): void {
    if (chatMode.value === mode) return
    chatMode.value = mode
    clearSelection()
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  当前会话所属主卡的"群聊上下文"(供聊天区末尾的流程控制条使用)
  // ═══════════════════════════════════════════════════════════════════════

  /** 当前选中主卡(未选中 / 下标失效时为 null) */
  const activeCard = computed<Card | null>(() => {
    const i = activeCardIndex.value
    if (i === null) return null
    return cards.value[i] ?? null
  })

  /** 当前会话是否为群聊 */
  const activeIsGroup = computed(
    () => (activeCard.value?.members ?? []).length >= GROUP_MIN_MEMBERS,
  )

  /** 当前群聊的发言模式(非群聊回退 'smart') */
  const activeSpeakMode = computed<GroupSpeakMode>(
    () => activeCard.value?.speakMode ?? 'smart',
  )

  /**
   * 当前群聊里"我"的身份是否为旁观
   *
   * 缺省视为管理员(与 groupSelfName 的口径一致)。
   */
  const activeIsObserver = computed(() => {
    if (!activeIsGroup.value) return false
    return activeCard.value?.myRole === 'observer'
  })

  /** 当前群聊是否处于"对话进行中" */
  const activeGroupRunning = computed(() => activeCard.value?.groupRunning === true)
  /** 当前群聊最近一次给出的话题(未给出时为空串) */
  const activeGroupTopic = computed(() => activeCard.value?.groupTopic ?? '')

  // ═══════════════════════════════════════════════════════════════════════
  //  群聊流程控制条的"该显示哪些胶囊"—— **唯一判据**
  // -----------------------------------------------------------------------
  // 这里必须只有一处定义:
  //   · GroupFlowControl 用它决定渲染哪些胶囊
  //   · ChatArea 用它决定是否为控制条预留滚动高度(决定 .chat-flow 是否存在)
  // 曾因两处各写一份、改了一处漏了另一处,导致"组件改了但整块根本没渲染"。
  // ═══════════════════════════════════════════════════════════════════════

  /** 是否显示「指定发言」胶囊(指定模式专属:发消息即让被点名者回一条) */
  const activeShowAssign = computed(
    () => activeIsGroup.value && activeSpeakMode.value === 'assign',
  )

  /**
   * 是否显示「开启 / 暂停 / 恢复对话」按钮
   *
   * 非指定模式的群聊**一律显示**,与"我的身份"无关 —— 与旁观模式同一套逻辑。
   * 玩家借此"想聊就聊、想停就停":暂停期间仍可发消息,但 AI 不回复。
   *
   * 渲染位置只有一处:底部输入面板里的圆形按钮(ChatInput,与单聊"停止"同款)。
   * 聊天区末尾的旧胶囊已删除,故这里不再需要与任何设置项做互斥判断。
   */
  const activeShowRun = computed(
    () => activeIsGroup.value && activeSpeakMode.value !== 'assign',
  )

  /**
   * 聊天区「指定发言」的角色下拉是否展开
   *
   * 纯运行时 UI 状态(**不持久化**);放在 store 里是因为聊天区的布局管线
   * (ChatArea 的 extraBottomHeight)也要知道它,好为下拉菜单预留滚动高度。
   */
  const groupPickerOpen = ref(false)

  /** 展开 / 收起角色下拉 */
  function toggleGroupPicker(): void {
    groupPickerOpen.value = !groupPickerOpen.value
  }

  /** 收起角色下拉 */
  function closeGroupPicker(): void {
    groupPickerOpen.value = false
  }

  /**
   * 开始 / 暂停群聊对话
   *
   * @returns 是否发生了改变;旁观模式下"未设置话题"时返回 false 且不改变状态
   */
  function setGroupRunning(running: boolean): boolean {
    const card = activeCard.value
    if (!card || (card.members ?? []).length < GROUP_MIN_MEMBERS) return false
    // 旁观模式:必须先用「给出话题」设定话题,否则不允许开启
    if (running && card.myRole === 'observer' && !(card.groupTopic ?? '').trim()) {
      return false
    }
    card.groupRunning = running
    // 玩家显式改变进行状态 = 一次新的开始/收尾:「继续对话」的计数与浮窗一并复位,
    // 否则恢复对话后可能刚聊一句就又弹出"该确认了"
    resetGroupContinue()
    return true
  }

  // ---- 群聊「继续对话」浮窗(每 GROUP_CONTINUE_EVERY 条角色消息一次) ----------

  /**
   * 上一次确认时,该会话里角色消息的总条数(计数基线)
   *
   * 不自己累加计数,而是"当前条数 − 基线"现算:消息可以被删除/清空,
   * 累加出来的数字迟早与聊天区里真实存在的消息对不上。
   */
  const groupAckBase = ref(0)

  /** 「继续对话」浮窗是否挂着 */
  const groupContinueOpen = ref(false)

  /** 某会话里角色们(非我方)说过的消息条数 */
  function countGroupMessages(sub: number): number {
    const msgs = conversations.value[sub]?.messages ?? []
    return msgs.filter((m) => m.side === 'other' && !m.isError && !m.topic).length
  }

  /** 自上次确认以来,角色们一共又说了多少条(浮窗文案里的数字) */
  const groupMessagesSinceAck = computed(() => {
    const sub = activeSub.value
    if (sub === null) return 0
    return Math.max(0, countGroupMessages(sub) - groupAckBase.value)
  })

  /** 关掉浮窗,并把计数基线挪到"此刻"(玩家点了继续 / 显式开始暂停 / 切换会话) */
  function resetGroupContinue(): void {
    groupContinueOpen.value = false
    groupAckBase.value = activeSub.value === null ? 0 : countGroupMessages(activeSub.value)
  }

  /**
   * 当前会话里角色消息的条数(仅群聊会话参与判定)
   *
   * 非群聊会话恒为 0,免得单聊里消息一多就误弹群聊浮窗。
   */
  const activeGroupCharCount = computed(() => {
    const sub = activeSub.value
    const card = activeCard.value
    if (sub === null || !card || (card.members ?? []).length < GROUP_MIN_MEMBERS) return 0
    return countGroupMessages(sub)
  })

  /**
   * 浮窗的出现判定:**侦听消息条数**,而不是在回合循环里判
   *
   * 早先这判定写在 useGroupChat.runTurn 的循环里,且排在一句
   * `if (result.done) break` 之后 —— 轮流模式(以及任何后端一次就收束的轮次)
   * done 恒为 true,那一句永远执行不到,于是"攒够 20 条也毫无反应"。
   * 现在改成盯着条数:第 20 条一落进聊天区就浮窗,与发言模式、与循环结构都无关。
   */
  watch(activeGroupCharCount, (next, prev) => {
    if (next <= prev) return
    if (groupContinueOpen.value) return
    if (next - groupAckBase.value >= GROUP_CONTINUE_EVERY) groupContinueOpen.value = true
  })

  /** 玩家点了浮窗里的「继续对话」:关窗 + 重新计数,对话照常往下走 */
  function ackGroupContinue(): void {
    resetGroupContinue()
  }

  /** 记录旁观模式下给出的话题 */
  function setGroupTopic(topic: string): void {
    const card = activeCard.value
    if (!card) return
    card.groupTopic = topic
  }

  /**
   * 切换「指定模式」下被点名的成员
   *
   * 只接受群内成员;同时把发言模式固定为 assign(聊天区里改名即等于
   * "我在用指定模式")。
   */
  function setActiveAssignTarget(name: string): boolean {
    const card = activeCard.value
    if (!card || !name) return false
    if ((card.members ?? []).indexOf(name) === -1) return false
    card.speakMode = 'assign'
    card.assignTarget = name
    if (card.groupSessionId) card.groupSessionId = undefined
    return true
  }

  // ---- AI 推荐选项(纯 UI 能力,内容由对接的 AI 逻辑写入) --------------------
  /**
   * 当前待选推荐项
   *
   * 空数组 = 无选项;面板可打开但显示空状态。
   */
  const pendingChoices = ref<PlayerChoice[]>([])

  /** 推荐面板是否展开 */
  const choicesOpen = ref(false)

  /** 写入推荐项(空数组视为清空);有内容时自动展开面板 */
  function setPendingChoices(list: PlayerChoice[]): void {
    pendingChoices.value = Array.isArray(list) ? list.filter((c) => c && c.label) : []
    // 刻意**不**自动展开。群聊里角色每回一条都会带推荐,自动弹出会不停打断阅读;
    // 面板改为只由玩家点「推荐」按钮打开(见 ChatInput 的 toggleChoicesPop)。
    // 面板此刻若已被玩家主动打开,内容自然刷新即可。
  }

  /**
   * 玩家是否在"本次对话"里主动关过推荐面板
   *
   * 关过之后本次对话不再自动弹出;切换会话(其他选项卡)时复位,
   * 退出软件重开自然也复位(刻意不持久化)。
   */
  const choicesSuppressed = ref(false)

  /** 标记/清除"本次对话已关闭推荐" */
  function setChoicesSuppressed(v: boolean): void {
    choicesSuppressed.value = v
  }

  // 切换会话(切换选项卡)→ 视为新一轮"本次对话":
  //   1. 复位"已关闭推荐"的抑制状态
  //   2. 换上**这段对话自己**缓存过的推荐项(持久化在 cards 里,重开软件也还在);
  //      没缓存过就是空,等玩家点开面板再按需生成一次。
  // 用 watch 而不是逐个改动 selectSub/selectCardConversation,覆盖所有切换路径。
  watch(activeSub, () => {
    choicesSuppressed.value = false
    pendingChoices.value = cachedChoicesOf(activeSub.value)
    choicesOpen.value = false
    // 选中消息只在当前会话内有效:切走后勾选失去意义,直接退出该模式
    msgSelectMode.value = false
    selectedMsgIds.value = []
    // 「继续对话」浮窗属于"这一段对话"的节奏:换会话就收掉并重新计数
    resetGroupContinue()
  })

  // ---- AI 推荐回复的读写(持久化在对话数据里) --------------------------------
  /** 读某段对话缓存过的推荐项(返回 UI 用的 PlayerChoice[]) */
  function cachedChoicesOf(sub: number | null): PlayerChoice[] {
    if (sub === null) return []
    const conv = conversations.value[sub]
    const items = conv?.suggestions?.items
    return Array.isArray(items) ? items.map((label) => ({ label })) : []
  }

  /** 当前这段对话最后一条消息的 id(没有消息 → 0);推荐以此判断是否过期 */
  function tailMessageId(): number {
    const sub = activeSub.value
    if (sub === null) return 0
    const msgs = conversations.value[sub]?.messages
    if (!msgs || msgs.length === 0) return 0
    return msgs[msgs.length - 1]?.id ?? 0
  }

  /**
   * 读取当前对话缓存的推荐(含生成依据),供调用方判断是否需要重新生成
   */
  function getConversationSuggestions(): { forMessageId: number; items: string[]; at: number } | null {
    const sub = activeSub.value
    if (sub === null) return null
    const sug = conversations.value[sub]?.suggestions
    if (!sug || sug.items.length === 0) return null
    return { forMessageId: sug.forMessageId, items: [...sug.items], at: sug.at }
  }

  /**
   * 把推荐写进**当前这段对话**的持久化数据,同时更新面板内容
   *
   * @param items        候选文本(空数组视为不写,避免把失败结果缓存成"已验证")
   * @param forMessageId 生成依据的最后一条消息 id(用 tailMessageId() 取)
   */
  function setConversationSuggestions(items: string[], forMessageId: number): void {
    const clean = Array.isArray(items) ? items.filter((t) => typeof t === 'string' && t.length > 0) : []
    if (clean.length === 0) return
    const sub = activeSub.value
    if (sub === null) return
    const conv = conversations.value[sub]
    if (!conv) return
    conv.suggestions = { forMessageId, items: clean, at: Date.now() }
    pendingChoices.value = clean.map((label) => ({ label }))
  }

  /** 清空当前对话缓存的推荐(对话被清空/换人时用) */
  function clearConversationSuggestions(sub: number | null = activeSub.value): void {
    if (sub === null) return
    const conv = conversations.value[sub]
    if (conv?.suggestions) delete conv.suggestions
  }

  /** 清空推荐项并收起面板 */
  function clearPendingChoices(): void {
    pendingChoices.value = []
    choicesOpen.value = false
  }
  /** 切换推荐面板展开状态(空列表也允许展开,便于展示空状态) */
  function toggleChoices(): void {
    // 玩家主动点了按钮 = 明确要看:解除"本次对话不再自动弹出"的抑制
    choicesSuppressed.value = false
    choicesOpen.value = !choicesOpen.value
  }
  /** 仅收起面板、保留推荐项(点击面板外部时调用) */
  function clearChoicesVisibility(): void {
    choicesOpen.value = false
  }

  const playedMessages = computed<ChatMessage[]>(() => {
    if (activeSub.value === null) return []
    return conversations.value[activeSub.value].messages
  })

  /**
   * 当前 LoadingBubble 应有的朝向
   *
   * 由 AI 响应状态驱动(AI 回复在 other 侧,即左侧)。
   * isLoading 为 true 时返回 'other',否则返回 null。
   */
  const loadingSide = computed<'other' | 'mine' | null>(() => {
    if (!isLoading.value) return null
    return 'other'
  })

  // 说明:切换对话不再需要手动关闭 loading —— isLoading 已按会话计算,
  // 切到没有进行中响应的会话时自然为 false,切回时若仍在响应则恢复显示。

  /**
   * 切换指定主卡的折叠状态
   *
   * @param index 主卡索引
   */
  function toggleCollapse(index: number) {
    collapsed.value[index] = !collapsed.value[index]
  }

  /**
   * 选中指定子卡(切换当前对话)
   *
   * 同时同步选中其所属主卡(activeCardIndex)。
   *
   * @param index 子卡全局索引(在扁平 conversations 中的下标)
   */
  function selectSub(index: number) {
    activeSub.value = index
    activeCardIndex.value = cardIndexOfSub(index)
  }

  /**
   * 清除全部选中(返回列表等场景)
   *
   * activeSub 与 activeCardIndex 一并置 null:回到"未选中任何对话/角色"的初始状态。
   */
  function clearSelection() {
    activeSub.value = null
    activeCardIndex.value = null
  }

  /**
   * 补齐缺失的内置角色卡片(全角色常驻)
   *
   * 导入 / 恢复 / 清空后保证每个内置角色都至少存在一张卡片,
   * 防止"导出只含部分角色"导致空角色在界面消失。
   */
  function mergeBuiltinCards(next: Card[]): Card[] {
    const validNames = new Set(CHARACTERS.map((c) => c.name))
    const isGroup = (c: Card) => (c.members ?? []).length >= 2

    const result: Card[] = []
    for (const c of next) {
      // ⚠️ 群聊卡的第一个子对话名是**群名**(如「A、B和C的群聊」),不在干员表里。
      // 早期这里统一用"名字必须是内置干员"来过滤,结果群聊卡在恢复时被整张删除 ——
      // 表现为"刷新后群聊消失、群聊列表空、连暂停胶囊都不出现"。
      if (!isGroup(c) && !validNames.has(c.conversations[0]?.name ?? '')) {
        // 名字不认识、也认不出是群聊:只有**完全空壳**才丢弃。
        // 老数据里"群聊退化成单聊壳"的卡(比如玩家自定义过群名、又只有一个角色
        // 说过话)会落到这里 —— 直接把有内容的卡删掉就是静默丢数据,绝不允许;
        // 演示群空壳例外,交给 App 的历史遗留清理逻辑处理。
        const hasContent = c.conversations.some(
          (cv) => cv.messages.length > 0 || (cv.contextHistory?.length ?? 0) > 0,
        )
        if (!hasContent || isLegacyDemoGroupShell(c)) continue
      }
      // ⚠️ 必须用展开保留**卡片级字段**(members / myRole / speakMode /
      // assignTarget / groupRunning / groupTopic …)。早期这里只重建了
      // conversations,群聊卡一恢复就退化成单聊卡。
      result.push({ ...c })
    }

    // 补齐缺失的内置干员卡(只按"单聊卡"的名字比对,别把群聊算进去)
    //
    // ⚠️ 补到**最前面**(按 CHARACTERS 的顺序),不是追加到末尾:
    // 新加的角色要出现在列表最上方,而老工程里并没有它们 —— 追加到末尾的话,
    // 已经用过一段时间的玩家永远看不到新角色排在前面。
    // 用 unshift(...missing) 一次插完:missing 已按 CHARACTERS 顺序,
    // 整体插到头部后,它们之间的相对顺序仍然是 CHARACTERS 的顺序。
    const known = new Set(
      result.filter((c) => !isGroup(c)).map((c) => c.conversations[0]?.name),
    )
    const missing: Card[] = []
    for (const c of CHARACTERS) {
      if (!known.has(c.name)) {
        missing.push({
          conversations: [{ name: c.name, messages: [] }],
        })
      }
    }
    result.unshift(...missing)
    return result
  }

  // ---- 列表动态排序(最近来过消息的主卡排最前) ------------------------------

  /**
   * 主卡的稳定标识(排序记录用它当键,**不能用卡片下标**)
   *
   * 下标会被增删卡片 / 导入数据打乱:今天第 3 张是提弗洛斯,删掉一张之后
   * 第 3 张就换人了,时间章会串到别人头上。改用卡片自身的身份:
   *   - 单聊卡:干员名        → `s:提弗洛斯`
   *   - 群聊卡:成员集合(排序后)→ `g:甲|乙|管理员`(与成员加入顺序无关)
   */
  function cardActiveKey(c: Card): string {
    const members = c.members ?? []
    if (members.length >= GROUP_MIN_MEMBERS) return `g:${[...members].sort().join('|')}`
    return `s:${c.conversations[0]?.name ?? ''}`
  }

  /**
   * 每张主卡"最后一次来消息"的时刻(列表排序用)
   *
   * 消息本身没有时间戳字段(见 types/chat 的 ChatMessage),所以在这里侧记:
   * 哪张卡的消息条数**变多**了,就给它盖一个当前时间章。
   * 键是上面那个稳定标识,因此可以安全落盘(见 useChatPersistence 的
   * KEY_CARD_ACTIVITY),刷新后顺序照旧。
   */
  const cardActiveAt = ref<Record<string, number>>({})

  /** 各主卡当前的消息总条数(侦测"哪张卡刚来了消息"用) */
  const cardMsgCounts = computed(() =>
    cards.value.map((c) => c.conversations.reduce((n, cv) => n + cv.messages.length, 0)),
  )

  /**
   * 整体替换卡片树期间不打时间章
   *
   * 导入 / 清空 / 恢复会把每张卡的消息数一次性改掉,那一刻所有卡都会"看起来
   * 刚来过消息",时间章几乎同一时刻盖下 → 列表顺序变成随机。这些批量路径
   * 期间关掉盖章,替换完了再打开(见 replaceAllCards)。
   */
  let activitySealed = false

  // 一处侦测覆盖所有追加路径(用户发言 / AI 回复 / 群聊轮流 / 预置消息播放),
  // 不必在每个 push 点重复埋点 —— 以后新增的追加点也自动被覆盖。
  watch(cardMsgCounts, (next, prev) => {
    if (activitySealed || !prev || prev.length !== next.length) return
    const touched = next
      .map((n, i) => (n > (prev[i] ?? 0) ? cards.value[i] : null))
      .filter((c): c is Card => !!c)
    if (touched.length === 0) return
    const now = Date.now()
    const map: Record<string, number> = { ...cardActiveAt.value }
    for (const c of touched) map[cardActiveKey(c)] = now
    // 顺手清掉已经不存在的卡留下的记录(删卡 / 换数据集),别让表无限长
    const live = new Set(cards.value.map(cardActiveKey))
    for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    cardActiveAt.value = map
  })

  /** 用落盘的排序记录覆盖内存态(启动恢复时调用,见 useChatPersistence.loadProject) */
  function applyCardActivity(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const map: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) map[k] = v
    }
    cardActiveAt.value = map
  }

  /**
   * 导出当前列表顺序（最近活跃在前）为稳定标识数组
   *
   * 顺序就是列表展示顺序：活跃时间倒序；从没来过消息的卡排在后面，
   * 保持它们在卡片数组里的原有先后（与 CharacterCardList 的排序规则一致）。
   *
   * 用稳定标识（cardActiveKey）而不是下标 —— 换设备 / 增删卡片都不会串号。
   */
  function exportCardOrder(): string[] {
    const keys = cards.value.map((c) => cardActiveKey(c))
    const at = cardActiveAt.value
    // 带下标一起排，利用 Array#sort 的稳定性保证"没时间章的卡"保持原有先后
    return keys
      .map((k, i) => ({ k, i, t: at[k] ?? 0 }))
      .sort((a, b) => (b.t - a.t) || (a.i - b.i))
      .map((x) => x.k)
  }

  /**
   * 应用一份"顺序"（导入时用）
   *
   * 把给定的稳定标识序列换算成时间章：排在前面的时间更大。
   * 这样只依赖既有的排序机制，不需要新增"显式序号"字段，
   * 也不会被之后的消息活动侦测逻辑覆盖（新消息照样把该卡顶到最前）。
   *
   * 未出现在 order 里的卡保持 0（排在已排序的卡之后）。
   */
  function applyCardOrder(order: unknown): void {
    if (!Array.isArray(order)) return
    const now = Date.now()
    const map: Record<string, number> = {}
    const n = order.length
    order.forEach((k, i) => {
      if (typeof k !== 'string' || !k) return
      // 第一名最大，依次递减；间隔 1ms 足够区分且不会溢出
      map[k] = now - i
    })
    // 保留原有记录里"本次没提到"的卡：它们本就该排在后面
    const live = new Set(cards.value.map(cardActiveKey))
    for (const [k, v] of Object.entries(cardActiveAt.value)) {
      if (live.has(k) && !(k in map)) map[k] = Math.min(v, now - n - 1)
    }
    cardActiveAt.value = map
  }

  /**
   * 整体替换卡片树并重置全部运行时态
   *
   * DataManagerDialog.applyCards(导入/清空)与 useChatPersistence.loadProject
   * (恢复)都需要"替换 cards + 重置运行时态字段"。收敛为统一 action,
   * 保证重置逻辑唯一来源,字段集合只在一处维护。
   *
   * 重置字段:collapsed(全收起)/ activeSub(null)/ activeCardIndex(null)/ isLoading(false)
   *
   * @param next 新的卡片树(调用方负责 sanitize)
   */
  function replaceAllCards(next: Card[]) {
    // 批量替换:关掉时间章 + 清空旧记录(旧下标与新卡片树无关了),
    // 等这次替换的侦测跑完再打开 —— 否则整列表会被"同一时刻"重排成随机顺序。
    activitySealed = true
    cardActiveAt.value = {}
    // 补齐"退化成单聊壳"的群聊卡(旧数据 / 老导出包里 members 整体缺失):
    // 这是导入与恢复的公共收口,放在这里能覆盖所有替换路径。
    cards.value = mergeBuiltinCards(repairCardGroups(next))
    collapsed.value = cards.value.map(() => true)
    activeSub.value = null
    activeCardIndex.value = null
    // 整个卡片集被替换,旧会话下标全部失效:丢弃所有进行中的 AI 响应上下文
    aiCtxBySub.clear()
    aiLoadingSubs.value = []
    aiRespondingSubs.value = []
    aiEmittedSubs.value = []
    aiSpeakers.value = {}
    void nextTick(() => {
      activitySealed = false
    })
  }

  /**
   * 循环切换到下一张顶部聊天条图片
   *
   * 同样存于 store:导出模式 ChatArea 实例共享,导出图与主界面样式一致。
   */
  function cycleStrip(): void {
    stripVariantIndex.value = (stripVariantIndex.value + 1) % 3
  }

  /** 直接设置顶部聊天条图片下标(持久化恢复 / 导入时调用) */
  function setStripVariant(idx: number): void {
    stripVariantIndex.value = ((idx % 3) + 3) % 3
  }

  // ---- AI 聊天 ------------------------------------------------------------
  /** AI 是否正在响应(流式输出中) */
  /**
   * 当前会话是否正在响应中(可中止,用于显示"停止生成"按钮)
   *
   * 与 isLoading 的区别:isLoading 覆盖到首条内容到达为止(控制加载气泡),
   * isAiResponding 覆盖整个响应周期(含多段之间的等待间隔)。
   */
  const isAiResponding = computed(
    () => activeSub.value !== null && aiRespondingSubs.value.includes(activeSub.value),
  )

  /**
   * 发送用户消息(用户输入后调用)
   *
   * 添加一条 mine 侧消息到当前对话,返回消息对象供调用方构建 LLM 请求。
   * 署名取 currentSelfIdentity:群聊中扮演角色时署该角色名(头像随之变为该角色)。
   */
  function sendUserMessage(text: string): ChatMessage | null {
    if (activeSub.value === null) return null
    const trimmed = text.trim()
    if (!trimmed) return null
    const conv = conversations.value[activeSub.value]
    const nextId = nextMessageId(conv)
    const self = currentSelfIdentity()
    const msg: ChatMessage = {
      id: nextId,
      side: 'mine',
      text: trimmed,
      speakerName: self.name,
      speakerAvatar: self.avatar,
    }
    conv.messages.push(msg)
    // 同步写入 AI 上下文历史(独立于可见消息,"清空消息"不影响 AI 记忆)
    if (!conv.contextHistory) conv.contextHistory = []
    conv.contextHistory.push({ side: 'mine', text: trimmed })
    return msg
  }

  /**
   * 当前会话待创建的 AI 消息说话人(供加载气泡显示头像/名称)
   *
   * 按会话读取:切到别的会话时返回空说话人,
   * 不会把其他角色/其他请求的头像显示过来。
   */
  const pendingAiSpeaker = computed<{ name: string; avatar: string }>(() => {
    const sub = activeSub.value
    if (sub === null) return { name: '', avatar: '' }
    return aiSpeakers.value[sub] ?? { name: '', avatar: '' }
  })

  /**
   * 设置下一条 AI 消息的心情表情 token(如 sns_emoji_001)
   *
   * 由 useAiChat 在拿到后端 { reply, mood } 后、分段显示前设置;
   * 首条 chunk 创建消息时消费并清空(仅第一条气泡展示心情表情)。
   *
   * @param mood 后端 mood 字段;undefined 表示无
   * @param ctx  目标响应上下文(缺省取当前会话)
   */
  function setPendingAiMood(mood?: string, ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (c) c.mood = mood
  }

  /**
   * 把心情表情补写到本轮**第一条** AI 消息上
   *
   * 用于单聊 SSE 流式:首段在 done 帧之前就已落字,那时 mood 还没到,
   * 而 setPendingAiMood 只对"尚未创建的消息"生效 —— 这里按 firstMessageId 回填。
   * 已有 mood 的消息不覆盖(与 replaceAiText 的补写口径一致)。
   */
  function setFirstAiMood(mood?: string, ctx?: AiResponseCtx | null): void {
    if (!mood) return
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv || c.firstMessageId === null) return
    const msg = conv.messages.find((m) => m.id === c.firstMessageId)
    if (msg && !msg.mood) msg.mood = mood
  }

  /**
   * 开始一次 AI 响应,返回本轮独立上下文
   *
   * 目标会话与说话人在此刻锁定,后续所有写入都基于该上下文,
   * 因此等待期间切换会话不会让回复落到别的对话,也不会换错头像。
   *
   * 同一会话若已有进行中的响应,会先中止它,避免同会话内两个请求交错写入。
   *
   * @param speakerName   AI 角色名
   * @param speakerAvatar AI 角色头像 URL
   * @returns 本轮响应上下文;无活跃会话时为 null
   */
  function beginAiResponse(
    speakerName: string,
    speakerAvatar: string,
    /**
     * 显式指定目标会话(缺省 = 当前选中会话)
     *
     * 长异步回合(群聊尤其明显)必须在开始时**锁定**目标会话,否则玩家中途
     * 切到别的对话,后续回复会落到新会话里 —— 这就是"群聊的消息发进了单聊"。
     */
    targetSub?: number,
    /**
     * 重新生成场景：新 AI 回复插到这条消息之后（而不是追加到末尾）
     *
     * 传入的通常是「被重新生成那一轮的用户消息 id」。
     */
    insertAfterMessageId?: number,
  ): AiResponseCtx | null {
    const sub = targetSub ?? activeSub.value
    if (sub === null || sub === undefined) return null
    if (!conversations.value[sub]) return null

    // 同一会话的旧响应:中止并释放,防止两个请求交替写入同一对话
    const old = aiCtxBySub.get(sub)
    if (old) {
      try {
        old.controller.abort()
      } catch {
        // 忽略:abort 异常不应影响新请求
      }
    }

    const ctx: AiResponseCtx = {
      token: ++aiReqSeq,
      sub,
      speaker: { name: speakerName, avatar: speakerAvatar },
      messageId: null,
      firstMessageId: null,
      controller: new AbortController(),
      insertAfterMessageId,
      // 首条从锚点之后开始排
      lastInsertedId: insertAfterMessageId,
    }
    aiCtxBySub.set(sub, ctx)
    setAiSpeaker(sub, ctx.speaker)
    addSub(aiRespondingSubs.value, sub)
    addSub(aiLoadingSubs.value, sub)
    // 新一轮回复:清掉"本轮已落内容"标记(居中三点加载态只用于本轮刚开始时)
    removeSub(aiEmittedSubs.value, sub)
    return ctx
  }

  /**
   * 开始 AI 响应(兼容旧调用名,等价于 beginAiResponse)
   *
   * 新代码请优先使用 beginAiResponse 拿到上下文并显式向后传递。
   */
  function startAiResponse(speakerName: string, speakerAvatar: string): AiResponseCtx | null {
    return beginAiResponse(speakerName, speakerAvatar)
  }

  /**
   * 为已有上下文重新开启 LoadingBubble
   *
   * 多段回复的段间等待用它显示"正在输入";不可改用 beginAiResponse,
   * 否则会生成新上下文并把当前请求误判为陈旧。
   */
  function beginAiSegment(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    addSub(aiLoadingSubs.value, c.sub)
  }

  /**
   * 收起 LoadingBubble(不结束本段)
   *
   * 与 beginAiSegment 配对,用于**同一条消息内部**的分拍显示:拍与拍之间先亮一下
   * 加载气泡(带动画),文字落下时随即收起。
   *
   * 与 finishAiSegment 的区别:后者是"一段结束",会写上下文历史并把 messageId 置空;
   * 这里两者都不做 —— 分拍只是同一条消息的显示节奏,绝不能因此多写一条历史。
   */
  function endAiSegmentLoading(ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c) return
    removeSub(aiLoadingSubs.value, c.sub)
  }

  /**
   * 追加 AI 流式输出文本
   *
   * 首条 chunk:创建 other 侧消息(含首段文本),关闭 loading(LoadingBubble → 文字气泡过渡)。
   * 后续 chunk:追加文本到已创建的消息。
   *
   * 内容只写入上下文锁定的会话,并使用该上下文捕获的说话人;
   * 若上下文已失效(同一会话又发起了新请求),迟到内容直接丢弃,不再串台。
   *
   * @param chunk 文本片段
   * @param ctx   目标响应上下文(缺省取当前会话)
   */
  /**
   * 把一条新产生的 AI 消息放进对话里
   *
   * - 常规发送：追加到末尾（保持既有行为）
   * - 重新生成：插到 ctx.insertAfterMessageId 之后（原位置）
   *
   * 多段回复（分组播放）时，后续段依次紧随前一段之后，顺序不会乱。
   * 锚点消息已被删除（例如那一轮又被删了）时退回追加，避免丢消息。
   */
  function insertAiMessage(conv: { messages: ChatMessage[] }, msg: ChatMessage,
                           ctx: AiResponseCtx): void {
    const anchor = ctx.insertAfterMessageId
    if (anchor === undefined) {
      conv.messages.push(msg)
      return
    }
    // 从"本轮已落位的最后一条"继续往后排；
    // 若本轮还没落过（引用本身或已被清），就从锚点消息开始。
    const baseIdx = conv.messages.findIndex((m) => m.id === (ctx.lastInsertedId ?? anchor))
    const anchorIdx = baseIdx !== -1 ? baseIdx : conv.messages.findIndex((m) => m.id === anchor)
    if (anchorIdx === -1) {
      // 锚点不在了（例如那一轮又被删了）：退化为追加，至少不丢这条回复
      conv.messages.push(msg)
      return
    }
    // 跨过"该轮已经排好的连续 AI 消息"，保证多段回复顺序不倒挂。
    // 注意只跨过连续的 other：一旦遇到用户消息就停 —— 那已经是下一轮了。
    let at = anchorIdx
    while (at + 1 < conv.messages.length && conv.messages[at + 1].side === 'other') {
      at++
    }
    conv.messages.splice(at + 1, 0, msg)
    ctx.lastInsertedId = msg.id
  }

  function appendAiChunk(chunk: string, ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv) return

    // 本轮回复已落内容:后续加载(前端分条的下一段)不再用居中三点加载态
    addSub(aiEmittedSubs.value, c.sub)

    // 首条 chunk:创建 AI 消息,关闭 loading
    if (c.messageId === null) {
      const nextId = nextMessageId(conv)
      insertAiMessage(conv, {
        id: nextId,
        side: 'other',
        text: chunk,
        speakerName: c.speaker.name,
        speakerAvatar: c.speaker.avatar,
        // 心情表情 token:仅首条气泡消费并清空
        mood: c.mood,
      }, c)
      c.mood = undefined
      c.messageId = nextId
      if (c.firstMessageId === null) c.firstMessageId = nextId
      removeSub(aiLoadingSubs.value, c.sub)
      return
    }

    // 后续 chunk:追加文本
    const msg = conv.messages.find((m) => m.id === c.messageId)
    if (!msg) return
    msg.text += chunk
  }

  /**
   * 用权威全文覆盖「正在生成的那条 AI 消息」(SSE 逐字流式收尾)
   *
   * 为什么需要:SSE 的 delta 是逐帧追加的,而 `event: done` 里的 reply 才是后端
   * 认定的完整文本 —— 丢帧 / 重复帧会让"逐帧拼出来的那份"与权威文本不一致,
   * 所以收尾时必须用它覆盖。
   *
   * 只写这一条消息的 text / mood,**不改任何状态机**:上下文历史仍由
   * finishAiResponse 统一写入,保证流式与非流式两条路径的落库口径完全一致。
   *
   * mood 由 done 帧才送达,而消息在首个 delta 时就已经创建 —— 此时不能再走
   * setPendingAiMood(它只在"创建消息"这一刻被消费),所以这里直接补写。
   *
   * @param text 权威全文
   * @param mood 后端 mood 字段(token 形式);undefined / 空表示无
   * @param ctx  目标响应上下文(缺省取当前会话)
   */
  function replaceAiText(text: string, mood?: string, ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (!conv) return

    // 消息尚未创建(整段没有 delta,只有 done 帧;或回退路径):按首条 chunk 的规则补建。
    // 空文本不建消息(与非流式路径"无内容则结束响应"一致,不留空气泡)
    if (c.messageId === null) {
      if (!text) return
      c.mood = mood
      appendAiChunk(text, c)
      return
    }

    const msg = conv.messages.find((m) => m.id === c.messageId)
    if (!msg) return
    msg.text = text
    // mood 补写:仅当消息上还没有(首条 delta 建立时通常为空)
    if (mood && !msg.mood) msg.mood = mood
  }

  /**
   * 完成 AI 响应:写入上下文历史 + 释放本轮上下文
   *
   * 仅当上下文仍有效时才写历史,避免陈旧响应把内容写进已被新请求接管的对话。
   *
   * @param ctx 目标响应上下文(缺省取当前会话)
   */
  function finishAiResponse(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c) return
    // 陈旧响应(同会话已发起更新的请求):完全忽略,
    // 绝不能删除/清除新请求的上下文与状态
    if (!isCtxActive(c)) return
    if (c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    aiCtxBySub.delete(c.sub)
    clearCtxState(c.sub)
  }

  /**
   * 完成当前 AI 消息段(不结束整体响应)
   *
   * 用于多段消息:每段消息各自写入上下文历史并关闭 loading,
   * 但保持整体响应状态与 AbortController 不变,
   * 调用方可继续 beginAiSegment → appendAiChunk → finishAiSegment 发送下一段。
   *
   * @param ctx 目标响应上下文(缺省取当前会话)
   */
  function finishAiSegment(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c || !isCtxActive(c)) return
    if (c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && msg.text) {
        if (!conv.contextHistory) conv.contextHistory = []
        conv.contextHistory.push({ side: 'other', text: msg.text })
      }
    }
    c.messageId = null
    removeSub(aiLoadingSubs.value, c.sub)
  }

  /**
   * 中止当前 AI 响应
   *
   * 调用本轮上下文自己的 AbortController.abort() 并释放上下文。
   * 如果 AI 消息已创建且为空文本,则删除该消息。
   * (消息尚未创建时——首条 chunk 未到达——仅清理状态即可。)
   *
   * @param ctx 目标响应上下文(缺省取当前会话)
   */
  function abortAiResponse(ctx?: AiResponseCtx | null) {
    const c = resolveCtx(ctx)
    if (!c) return
    try {
      c.controller.abort()
    } catch {
      // 忽略:重复 abort 不应抛错
    }
    if (isCtxActive(c) && c.messageId !== null) {
      const conv = conversations.value[c.sub]
      const msg = conv?.messages.find((m) => m.id === c.messageId)
      if (conv && msg && !msg.text) {
        const idx = conv.messages.indexOf(msg)
        if (idx !== -1) conv.messages.splice(idx, 1)
      }
    }
    // 复用 finishAiResponse:已生成的文本仍写入上下文历史,并释放本轮上下文
    finishAiResponse(c)
  }

  /**
   * 追加错误消息(请求失败占位气泡)
   *
   * - 创建 other 侧消息,标记 isError + regenerateUserId
   * - 绝不写入 contextHistory(错误不进入 AI 上下文记忆,也不进入持久化历史)
   * - 清理 AI 响应状态(等同 finishAiResponse,但不写历史)
   *
   * @param errMsg            错误信息文本
   * @param regenerateUserId  本轮用户消息 id(点击"重新生成"时定位重发目标)
   */
  function appendAiError(errMsg: string, regenerateUserId?: number,
                         ctx?: AiResponseCtx | null): void {
    const c = resolveCtx(ctx)
    if (!c) return
    // 陈旧响应:直接忽略,不能把错误气泡写进已被新请求接管的对话,
    // 也不能清除新请求的状态
    if (!isCtxActive(c)) return
    const conv = conversations.value[c.sub]
    if (conv) {
      const nextId = nextMessageId(conv)
      insertAiMessage(conv, {
        id: nextId,
        side: 'other',
        text: errMsg,
        speakerName: c.speaker.name,
        speakerAvatar: c.speaker.avatar,
        isError: true,
        regenerateUserId,
      }, c)
    }
    aiCtxBySub.delete(c.sub)
    clearCtxState(c.sub)
  }

  /**
   * 重新生成前的准备(长按 AI 回复 → "重新生成";错误气泡的"重新生成"同样适用)
   *
   * 删除该轮的所有 AI 回复(该用户消息之后、下一条用户消息之前的 other 消息),
   * 保留用户消息;同步清理 contextHistory 中对应条目。
   * 返回被保留的用户消息 { id, text, isImage } 供调用方重新触发 AI;失败返回 null。
   *
   * @param messageId 长按的 AI 回复 / 错误消息 id
   */
  function prepareRegenerate(
    messageId: number,
  ): { id: number; text: string; isImage: boolean } | null {
    if (activeSub.value === null) return null
    const conv = conversations.value[activeSub.value]
    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return null
    const target = conv.messages[idx]
    if (target.side !== 'other') return null // 仅对 AI 回复 / 错误气泡

    // 找到之前的最后一条用户消息
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].side === 'mine') {
        userIdx = i
        break
      }
    }
    if (userIdx === -1) return null
    const userMsg = conv.messages[userIdx]

    // 删除该轮所有 AI 回复(用户消息之后连续的 other 消息,直到下一条用户消息)
    const removed: ChatMessage[] = []
    let j = userIdx + 1
    while (j < conv.messages.length && conv.messages[j].side === 'other') {
      removed.push(conv.messages[j])
      j++
    }
    if (removed.length > 0) {
      conv.messages.splice(userIdx + 1, removed.length)
      for (const m of removed) {
        removeFromContextHistory(conv, m)
      }
    }

    return { id: userMsg.id, text: userMsg.text, isImage: !!userMsg.image }
  }

  /**
   * 获取 AI 响应的 AbortSignal(供 LLM 调用传入)
   *
   * @param ctx 目标响应上下文(缺省取当前会话)
   */
  function getAiSignal(ctx?: AiResponseCtx | null): AbortSignal | undefined {
    return resolveCtx(ctx)?.controller.signal
  }

  /**
   * 获取当前对话的聊天历史(用于构建 LLM 请求)
   *
   * 优先使用 contextHistory(独立于可见消息):
   * - contextHistory 已初始化(undefined 以外) → 直接返回它
   * - contextHistory 未初始化(undefined,旧数据) → 从 messages 派生(向后兼容)
   */
  function getChatHistory(): Array<{ side: 'other' | 'mine'; text: string; image?: string }> {
    if (activeSub.value === null) return []
    const conv = conversations.value[activeSub.value]
    if (conv.contextHistory !== undefined) {
      return conv.contextHistory
    }
    return conv.messages
      .filter((m) => m.text || m.image)
      .map((m) => {
        const entry: { side: 'other' | 'mine'; text: string; image?: string } = { side: m.side, text: m.text }
        if (m.image) entry.image = m.image
        return entry
      })
  }

  /**
   * 当前会话累计的**输出 token**（后端 usage.completion_tokens 累加）
   *
   * 与 getChatHistory 用同一套定位（activeSub → conversations[i]）。
   * 智能总结用它 + 固定提示词长度，判断是否触及上下文窗口的 80%。
   */
  function getSessionOutputTokens(): number {
    if (activeSub.value === null) return 0
    return conversations.value[activeSub.value]?.sessionOutputTokens ?? 0
  }

  /** 累加当前会话的输出 token（后端上报的 completion_tokens） */
  function addSessionOutputTokens(delta: number): void {
    if (activeSub.value === null) return
    if (!Number.isFinite(delta) || delta <= 0) return
    const conv = conversations.value[activeSub.value]
    if (!conv) return
    conv.sessionOutputTokens = (conv.sessionOutputTokens ?? 0) + delta
  }

  /**
   * 会话输出 token 计数归零（智能总结把前段历史压成摘要后调用）
   *
   * 归零是必要的：摘要已替代被总结的那部分历史，继续累加会让计数虚高，
   * 导致每轮都触发总结。
   */
  function resetSessionOutputTokens(): void {
    if (activeSub.value === null) return
    const conv = conversations.value[activeSub.value]
    if (conv) conv.sessionOutputTokens = 0
  }

  return {
    // 数据
    cards,
    conversations,
    collapsed,
    cardSubRanges,
    /** 主卡标识 → 最后一次来消息的时刻(列表按它动态排序,见 CharacterCardList) */
    cardActiveAt,
    /** 取某张主卡的排序标识(CharacterCardList 查 cardActiveAt 用) */
    cardActiveKey,
    exportCardOrder,
    applyCardOrder,
    /** 恢复排序记录(持久化层调用) */
    applyCardActivity,
    activeSub,    counterpartName,
    currentOtherAvatarUrl,
    myAvatar,
    myGender,
    cardCharacters,
    // 会话创作
    selectCardConversation,
    createChildConversation,
    createGroupCard,
    activeCard,
    activeIsGroup,
    activeSpeakMode,
    activeIsObserver,
    activeGroupRunning,
    activeGroupTopic,
    activeShowAssign,
    activeShowRun,
    setGroupRunning,
    setGroupTopic,
    // 群聊「继续对话」浮窗(每 GROUP_CONTINUE_EVERY 条角色消息一次)
    groupMessagesSinceAck,
    groupContinueOpen,
    ackGroupContinue,
    resetGroupContinue,
    setActiveAssignTarget,
    groupPickerOpen,
    toggleGroupPicker,
    closeGroupPicker,
    updateGroupName,
    updateGroupMembers,
    updateGroupSpeakMode,
    getGroupSettings,
    // 侧边栏模式(单聊 / 群聊)
    chatMode,
    setChatMode,
    // 推荐选项(纯 UI 能力;内容由对接的 AI 逻辑写入)
    pendingChoices,
    choicesOpen,
    choicesSuppressed,
    setChoicesSuppressed,
    setPendingChoices,
    clearPendingChoices,
    toggleChoices,
    clearChoicesVisibility,
    // 推荐回复的持久化读写(存在对话数据里,重开软件不丢)
    tailMessageId,
    getConversationSuggestions,
    setConversationSuggestions,
    clearConversationSuggestions,
    sendImage,
    addTopicLine,
    // 删除模式(多选 + 批量删除 / 清空)
    deleteMode,
    deleteSelection,
    deleteKind,
    deleteCount,
    // 删除历史/上下文时的「连带清除」勾选
    deleteLinked,
    isDeleteSelected,
    toggleDeleteMode,
    exitDeleteMode,
    toggleDeleteSelect,
    setDeleteKind,
    setDeleteLinked,
    runDelete,
    deleteConversationsAt,
    // 选中消息导出(纯 UI)
    msgSelectMode,
    selectedMsgIds,
    selectedMsgCount,
    selectedMessages,
    isMsgSelected,
    startMsgSelect,
    exitMsgSelect,
    toggleMsgSelect,
    clearAllConversations,
    clearMessagesAt,
    clearContextAt,
    applyCompaction,
    clearAllMessages,
    clearAllContext,
    toggleMyGender,
    setMyGender,
    // 动态命名
    currentConversationMeta,
    // AI 加载
    subPreviewTexts,
    playedMessages,
    isLoading,
    loadingSide,
    aiTurnHasContent,
    /** 点聊天区"对方"头像:该角色有两张形象就换一张(目前只有「管理员」) */
    toggleCounterpartAvatarAlt,
    /** 取某角色第二张形象的 URL(设置里切过才有值;消息头像解析用它) */
    altAvatarOf,
    // 玩家选择
    toggleCollapse,
    selectSub,
    selectCard,
    clearSelection,
    activeCardIndex,
    // 角色名称显示开关(localStorage 持久化)【已注释停用】
    // showCharacterNames,
    // toggleShowCharacterNames,
    replaceAllCards,
    cycleStrip,
    setStripVariant,
    stripVariantIndex,
    // 公共头像解析(聊天区渲染共用)
    resolveMessageAvatar,
    // 群聊「扮演某角色」发出的消息判别(头像点击切换性别时排除)
    isRolePlayMessage,
    // AI 聊天
    isAiResponding,
    pendingAiSpeaker,
    markAiTurnStarted,
    sendUserMessage,
    beginAiResponse,
    beginAiSegment,
    endAiSegmentLoading,
    isCtxActive,
    startAiResponse,
    appendAiChunk,
    /** SSE 逐字流式收尾:用 done 帧的权威全文覆盖当前 AI 消息 */
    replaceAiText,
    finishAiResponse,
    finishAiSegment,
    abortAiResponse,
    appendAiError,
    prepareRegenerate,
    getAiSignal,
    getChatHistory,
    getSessionOutputTokens,
    addSessionOutputTokens,
    resetSessionOutputTokens,
    setPendingAiMood,
    /** SSE 流式:done 帧的 mood 补写到首条气泡 */
    setFirstAiMood,
    // 长按删除(单条 / 整轮)
    deleteMessage,
    deleteRound,
  }
})
