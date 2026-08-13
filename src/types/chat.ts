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
  contextHistory?: Array<{ side: 'other' | 'mine'; text: string; image?: string }>
}

/**
 * 主卡(一级卡片)
 *
 * 一张主卡下挂载任意数量(≥1)的子卡(Conversation)。
 * 主卡头像/名称取自其首段子对话的 name。
 */
export interface Card {
  /** 该主卡下的子卡对话列表(长度 ≥ 1) */
  conversations: Conversation[]
}

/** 过渡起始尺寸(px):文字气泡从加载气泡尺寸平滑过渡到自身尺寸 */
export interface RectSize {
  w: number
  h: number
}

/**
 * 单条消息的布局结果(useChatRows 输出,模板直接消费)
 */
export interface ChatRow {
  /** 源消息 */
  msg: ChatMessage
  /** 用于显示和测量的文本(与 msg.text 一致) */
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
  /** 过渡起始尺寸(首屏 / 已渲染过的气泡为 undefined,新追加为上一气泡尺寸) */
  prevRect?: RectSize
  /** 该消息在垂直方向的实际占用底部(相对 chat-area 坐标)
   *  = bubbleTop + box.rectH */
  bottom: number
}
