// =============================================================================
// 聊天领域类型定义
// -----------------------------------------------------------------------------
// 设计原则:布局方向(side)与说话人身份(speakerName/speakerAvatar)解耦。
//   - side 只决定气泡朝向 / 头像位置,只有 'other' | 'mine' 两个值
//   - speakerName / speakerAvatar 决定显示谁在说话
//
// 扩展兼容性:
//   - 1v1 对话:不传 speakerName/speakerAvatar,默认取 conversation.name / character 查询
// =============================================================================

import type { BubbleBox } from '../utils/measure'
import type { AvatarStack } from '../constants/design'

/** 消息方向:other=对方(左侧气泡) / mine=我方(右侧气泡) */
export type MessageSide = 'other' | 'mine'

/**
 * 聊天消息
 *
 * 核心字段(id/side/text)必填,扩展字段全部可选:
 *   - speakerName / speakerAvatar:说话人身份
 */
export interface ChatMessage {
  /** 消息在当前对话内的序号(用作 v-for key) */
  id: number
  /** 发送方向,决定气泡朝向与头像 */
  side: MessageSide
  /** 消息文本(支持 \n 换行) */
  text: string
  /**
   * 图片消息(dataURL)
   *
   * 存在时渲染为纯图片(无气泡),text 通常为空串。
   */
  image?: string
  /** 图片显示宽度(px,按自然尺寸等比计算,不超过 CHAT_IMAGE 上限) */
  imageW?: number
  /** 图片显示高度(px,同 imageW) */
  imageH?: number
  /**
   * 群聊「新话题」提示行
   *
   * 玩家在旁观模式下投喂的话题不当作"管理员说的话"落成气泡,
   * 而是渲染成一条半透明小字提示行。此标记为 true 时:
   *   - 不画头像、不画气泡,只画一行灰字「新话题:xxx」
   *   - 不进入 AI 上下文(话题另行通过 topic 字段单独传给后端)
   */
  topic?: boolean
  /**
   * 说话人显示名
   *
   * - other 侧:不传则取 conversation.name
   * - mine  侧:通常不传(我方固定身份)
   */
  speakerName?: string
  /**
   * 说话人头像 URL
   *
   * - other 侧:不传则按 speakerName / conversation.name 查 character.ts
   * - mine  侧:不传则取我方默认头像
   */
  speakerAvatar?: string
  /**
   * 心情表情 token(如 sns_emoji_001,不带方括号)
   *
   * 后端回复 JSON 可选字段 mood 的透传值;缺失时不在气泡上渲染任何表情。
   */
  mood?: string
  /**
   * 错误消息标记(请求失败时的占位气泡)
   *
   * - 仅存在于可见消息列表,绝不写入 contextHistory(不会污染 AI 上下文)
   * - 渲染为红色错误气泡 + "重新生成"按钮
   */
  isError?: boolean
  /**
   * 错误消息对应的用户消息 id(点击"重新生成"时定位要重发的用户消息)
   */
  regenerateUserId?: number
}

/**
 * 说话人身份信息(布局/渲染层解析出的"谁在说话")
 *
 * 收敛自消息的 side + speakerName/speakerAvatar 三元组,
 * 供 store 解析链 / useChatRows / ChatMessageRow 共用同一形状。
 */
export type MessageSpeaker = Pick<
  ChatMessage,
  'side' | 'speakerAvatar' | 'speakerName'
> & { id?: number }

/**
 * AI 上下文历史条目
 *
 * 与可见消息(ChatMessage)解耦:contextHistory 记录"已发给 AI 的对话",
 * 而 messages 记录"屏幕上显示的对话",两者可各自清空。
 */
export interface ContextEntry {
  side: MessageSide
  text: string
  /** 图片消息的 dataURL(存在时该条目按 Vision 内容数组发送) */
  image?: string
}

/** 对话数据:一个干员子卡对应一段对话 */
export interface Conversation {
  /** 干员名(当前 UI 固定显示在聊天条标题) */
  name: string
  /** 消息列表 */
  messages: ChatMessage[]
  /**
   * AI 上下文历史(独立于可见消息列表)
   *
   * - undefined:旧数据未初始化,getChatHistory 回退到从 messages 派生
   * - []:已显式清空(清空上下文),AI 不记得任何历史
   * - 非空:记录已发送给 AI 的对话历史(用户消息 + AI 回复)
   *
   * "清空消息"只清空 messages,contextHistory 保留(AI 仍记得历史);
   * "清空上下文"只清空 contextHistory,messages 保留(屏幕仍有消息)。
   */
  contextHistory?: ContextEntry[]
  /**
   * 本会话累计的**输出 token**（后端 usage.completion_tokens 累加，2026-09-30）
   *
   * 用途：智能总结开启时，前端用
   *   「固定提示词长度 + 本字段」
   * 与 Agnes 2.5 Flash 上下文窗口的 80% 比较，达到就总结掉 80% 以外的历史，
   * 剩下 20% 留给 RAG 语料库（这部分长度不固定）。
   *
   * 注意：累计的是输出 token（对话历史里累积增长的就是这部分），
   * 输入 token 每轮都会被完整重发，累加它没有意义。
   *
   * 随对话一起持久化；清空上下文 / 总结完成后归零。
   */
  sessionOutputTokens?: number
  /**
   * AI 推荐回复缓存(随对话一起写进本地数据,重开软件也还在)
   *
   * 语义:推荐是"针对某个对话状态"生成的一次性结果 —— 只要对话没往前走
   * (最后一条消息没变),反复点开推荐面板都直接复用,不再重复请求 API;
   * 玩家又发了消息(对话状态变了)才会重新生成一次。
   */
  suggestions?: ConversationSuggestions
}

/**
 * 一段对话里缓存的 AI 推荐回复
 *
 * 由 useAiChat / useGroupChat 在拿到候选后写入,
 * 只存文本,点击即作为玩家消息发出(与 PlayerChoice 同构)。
 */
export interface ConversationSuggestions {
  /**
   * 生成依据:当时这段对话**最后一条消息的 id**
   *
   * 与当前最后一条消息不一致 = 推荐已过期(对话往前走过了),需要重新生成。
   */
  forMessageId: number
  /** 候选文本(最多几条,由后端决定) */
  items: string[]
  /** 生成时间(ms 时间戳),仅用于排查/展示 */
  at: number
}

/**
 * 主卡(一级卡片)
 *
 * 一张主卡下挂载任意数量(≥1)的子卡(Conversation)。
 * 主卡头像/名称取自其首段子对话的 name。
 */
/**
 * 一条 AI 推荐选项
 *
 * 由对接的 AI 逻辑在回复后写入 chat store 的 pendingChoices;
 * UI 只负责渲染,点击后把 label 作为用户消息原样发出。
 */
export interface PlayerChoice {
  /** 按钮文字(点击即作为用户消息发送) */
  label: string
}

/** 群聊中"我的身份":admin = 管理员(默认) / observer = 旁观 / 字符串 = 扮演该角色的名字 */
export type GroupMyRole = 'admin' | 'observer' | string

/**
 * 群聊发言模式
 *
 *   round  —— 轮流模式:玩家说一条,所有角色按顺序各回复一条
 *   smart  —— 智能模式:后端判断下一个该谁说话,玩家可随时打断
 *   assign —— 指定模式:玩家指定某个角色,只回复一条
 */
export type GroupSpeakMode = 'round' | 'smart' | 'assign'

export interface Card {
  /** 该主卡下的子卡对话列表(长度 ≥ 1) */
  conversations: Conversation[]
  /**
   * 群聊成员名列表
   *
   * - undefined / 长度 < 2:普通单聊主卡,名称与头像按首个子对话的角色推导
   * - 长度 ≥ 2:群聊主卡,名称为「成员1、成员2和管理员的群聊」
   *
   * 成员是**卡片级**数据(同一主卡下所有子对话共享),不是子对话级。
   */
  members?: string[]
  /** 群聊中我的身份(仅群聊主卡有意义;缺省视为管理员) */
  myRole?: GroupMyRole
  /** 群聊发言模式(仅群聊主卡有意义;缺省视为智能模式) */
  speakMode?: GroupSpeakMode
  /** 「指定模式」下被指定的角色名(仅 speakMode === 'assign' 时有意义) */
  assignTarget?: string
  /**
   * 群聊对话是否"进行中"(旁观模式的「开启对话 / 暂停对话」开关)
   *
   * 仅旁观模式有意义:未开始时角色不发话,开启后角色按发言模式推进。
   */
  groupRunning?: boolean
  /**
   * 旁观模式下最近一次给出的话题
   *
   * 未设置话题时点「开启对话」会提示「请先设置话题」。
   */
  groupTopic?: string
  /**
   * 测试版群聊后端的会话 id(由后端生成,前端保存)
   *
   * 后端会话只存"调度状态"(轮转游标 / 上一位发言人 / 话题 / 生成任务),
   * 历史仍由前端维护并随每次请求上传。
   */
  groupSessionId?: string
}

/** 过渡起始尺寸(px):文字气泡从加载气泡尺寸平滑过渡到自身尺寸 */
export interface RectSize {
  w: number
  h: number
}

/**
 * 单条消息的布局结果(useChatRows 输出,模板直接消费)
 *
 * 注意:一条消息**不一定只有一行** —— 开启「括号描写居中」后,一条消息会被
 * 拆成"气泡行 + 居中行"若干行(见 aiText.splitBracketParts),因此:
 *   - v-for 的 key 必须用 row.key(不能再用 msg.id,会重复)
 *   - row.msg 仍是同一条消息(删除/重新生成等操作仍按 msg.id 走)
 */
export interface ChatRow {
  /** 源消息 */
  msg: ChatMessage
  /** 该行的唯一键(同一条消息的多个部件用 `id#序号` 区分) */
  key: string
  /** 用于显示和测量的文本(与 msg.text 一致;居中行为去括号后的括号内容) */
  displayText: string
  /** 气泡测量结果(传给 ChatBubble,避免 ChatBubble 重复 measure 触发重排) */
  box: BubbleBox
  /** 气泡盒左边缘(相对 chat-area 坐标) */
  left: number
  /** 气泡顶部(相对 chat-area 坐标) */
  bubbleTop: number
  /** 头像顶部(相对 chat-area 坐标) */
  avatarTop: number
  /** 头像容器左边缘(相对 chat-area 坐标) */
  avatarX: number
  /** 是否显示头像(方向改变 / 同方向换说话人时为 true) */
  showAvatar: boolean
  /** 头像三层槽位(传入 ChatAvatar) */
  stack: AvatarStack
  /**
   * 过渡起始尺寸(首屏 / 已渲染过的气泡为 undefined,新追加为上一气泡尺寸)
   *
   * 居中行没有尺寸过渡,该字段只当"这一行是首屏渲染还是后来追加的"标记用
   * (渲染层据此决定要不要播入场动画,与图片消息同一判据)。
   */
  prevRect?: RectSize
  /** 该消息在垂直方向的实际占用底部(相对 chat-area 坐标)
   *  = bubbleTop + box.rectH */
  bottom: number
  /** 是否为群聊「新话题」提示行(渲染为一条小字灰线,无头像、无气泡) */
  isTopic?: boolean
  /**
   * 是否为「括号描写居中」行
   *
   * 无气泡 / 无头像 / 无左右归属,渲染为一行居中文本(左右各一段细线)。
   * 该行的 displayText 已去掉最外层括号。
   */
  isCentered?: boolean
  /**
   * 居中行的文字颜色(「彩色括号描写」/「居中我方括号内容」)
   *
   * - 有值:该行按说话人的作战属性上色(见 constants/character 的 ATTRIBUTE_COLORS)
   * - undefined:用统一的居中文本颜色(对应设置关闭 / 该角色查不到属性)
   *
   * 由 useChatRows 生成行时算好,渲染层(ChatMessageRow)只负责取用。
   */
  centerColor?: string
  /**
   * 心情表情是否挂在这一行
   *
   * 心情(mood)是**气泡**角落的装饰,一条消息只有一个;消息被拆成多行后,
   * 只有首条气泡行为 true。整条消息都是居中行时,该行为 true 的是首行,
   * 但居中行没有气泡可挂,渲染层不再画表情(消息本身仍然完整保留)。
   */
  moodRow?: boolean
}
