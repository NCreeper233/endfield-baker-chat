// chat —— 聊天领域类型
// side 只决定气泡朝向；谁在说话由 speakerName / speakerAvatar 单独表达。

import type { BubbleBox } from '../utils/measure'
import type { AvatarStack } from '../constants/design'

export type MessageSide = 'other' | 'mine'

export interface ChatMessage {
  /** 对话内序号，充当 v-for key（不是全局 id） */
  id: number
  side: MessageSide
  text: string
  /** 图片 dataURL。存在时按纯图渲染，text 通常为空串 */
  image?: string
  imageW?: number
  imageH?: number
  /** 群聊「新话题」提示行：无头像无气泡，也不进 AI 上下文 */
  topic?: boolean
  speakerName?: string
  speakerAvatar?: string
  /** 心情表情 token，如 sns_emoji_001 */
  mood?: string
  /** 请求失败的占位气泡。**绝不写入 contextHistory** —— 错误不是角色说过的话 */
  isError?: boolean
  regenerateUserId?: number
}

/** 说话人身份，收敛自消息的 side + speakerName + speakerAvatar */
export type MessageSpeaker = Pick<
  ChatMessage,
  'side' | 'speakerAvatar' | 'speakerName'
> & { id?: number }

/** 已发送给 AI 的对话历史，与可见消息解耦 */
export interface ContextEntry {
  side: MessageSide
  text: string
  image?: string
}

export interface Conversation {
  /** 干员名，显示在聊天条标题 */
  name: string
  messages: ChatMessage[]
  /**
   * undefined = 旧数据未初始化，读取时从 messages 派生；[] = 显式清空过
   *
   * 「清空消息」只动 messages，「清空上下文」只动这里。
   */
  contextHistory?: ContextEntry[]
  /**
   * 累计**输出** token，智能总结按它算上下文窗口占比
   *
   * 输入每轮都会完整重发，累加没有意义。清空上下文或总结完成后归零。
   */
  sessionOutputTokens?: number
  /** 缓存到对话上的推荐回复，对话状态没变就直接复用，不再请求 API */
  suggestions?: ConversationSuggestions
}

export interface ConversationSuggestions {
  /** 生成时的最后一条消息 id；与当前值不一致即视为过期 */
  forMessageId: number
  items: string[]
  at: number
}

/** 一条 AI 推荐选项，点击后 label 原样作为玩家消息发出 */
export interface PlayerChoice {
  label: string
}

/** admin = 管理员（默认），observer = 旁观，其他字符串 = 扮演该角色 */
export type GroupMyRole = 'admin' | 'observer' | string

export type GroupSpeakMode = 'round' | 'smart' | 'assign'

export interface Card {
  /** 长度 ≥ 1 */
  conversations: Conversation[]
  /** 群聊成员。**卡片级**，同一主卡下所有子对话共享；长度 ≥2 才按群聊处理 */
  members?: string[]
  myRole?: GroupMyRole
  speakMode?: GroupSpeakMode
  assignTarget?: string
  /** 旁观模式的开启 / 暂停；未开启时角色不发话 */
  groupRunning?: boolean
  /** 为空时点「开启对话」会提示先设话题 */
  groupTopic?: string
  /** 测试版群聊后端只存调度状态，历史仍由前端维护并随每次请求上传 */
  groupSessionId?: string
}

/** 文字气泡从加载态过渡到自身尺寸的起始尺寸 */
export interface RectSize {
  w: number
  h: number
}

export interface ChatRow {
  msg: ChatMessage
  /**
   * 行唯一键，同一条消息的多个部件用 `id#序号`
   *
   * 一条消息可能被拆成「气泡行 + 居中行」，所以 v-for key 不能用 msg.id。
   */
  key: string
  displayText: string
  box: BubbleBox
  /** 以下坐标均相对 chat-area */
  left: number
  bubbleTop: number
  avatarTop: number
  avatarX: number
  showAvatar: boolean
  stack: AvatarStack
  /**
   * 过渡起始尺寸，同时充当「这一行是新追加的」标记
   *
   * 首屏已渲染过的行为 undefined，渲染层据此决定要不要播入场动画。
   */
  prevRect?: RectSize
  bottom: number
  isTopic?: boolean
  isCentered?: boolean
  /** 有值 = 按说话人作战属性上色；undefined = 用统一居中色 */
  centerColor?: string
  /** mood 是气泡角落装饰，一条消息只有一个，故仅首条气泡行为 true */
  moodRow?: boolean
}
