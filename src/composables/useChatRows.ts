// =============================================================================
// 聊天区消息布局计算(useChatRows)
// -----------------------------------------------------------------------------
// 职责:
//   1. rows: 计算每条消息的布局(left/top/avatarTop/showAvatar/stack)
//   2. lastRow / loadingLayout / showLoadingAvatar: AI 加载 LoadingBubble 布局
//   3. endDecoTop / padTop: 滚动内容底部与尾部空间
//   4. resolveSpeakerAvatar / speakerKeyOf: 消息说话人头像解析(模板共用)
//
// 设计理由:
//   - 纯计算 + store 驱动,无 DOM 操作,可独立测试
//   - freshContext 以可变对象注入(非响应式),由 ChatArea 的 watcher 翻转,
//     避免将布局上下文做成响应式导致 rows 额外重算
//   - 几何(chatGeometryKey)由注入提供:桌面 = 设计稿常量,移动端 = 视口推导;
//     导出模式(ChatExportStage)注入桌面几何,行坐标始终为"滚动容器相对坐标",
//     模板直接用,不再各自减 scrollX/scrollY
// =============================================================================

import { computed, inject, toValue, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../stores/chat'
import {
  CHAT_IMAGE,
  avatarBubbleTop,
  avatarStack,
  avatarTopToBubble,
} from '../constants/design'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../constants/chatGeometry'
import { bubbleSvgWidth, type BubbleBox } from '../utils/measure'
import type { ChatRow, MessageSpeaker, RectSize } from '../types/chat'

/** useChatRows 输入参数 */
export interface ChatRowsOptions {
  /** 气泡文本测量函数(useBubbleMeasure.measure) */
  measure: (text: string, innerMax?: number, metrics?: import('../utils/measure').BubbleMetrics) => BubbleBox
}

/**
 * 计算消息行间距
 *
 * 间距规则(数值来自几何层,桌面 = 设计稿值):
 *   1. 同方向:再细分——
 *      a. 同方向换说话人:gapSpeaker(给新头像留位)
 *      b. 同人连发:gapSame
 *   2. 跨方向:gapCross
 */
function computeGap(
  geom: ChatGeometry,
  ctx: {
    side: 'other' | 'mine'
    prevSide: 'other' | 'mine' | null
    prevSpeakerKey: string | null
    speakerKey: string
  },
): number {
  // 1. 同方向
  if (ctx.side === ctx.prevSide) {
    // 1a. 同方向换说话人:speaker 间距(给新头像留位)
    if (ctx.prevSpeakerKey !== null && ctx.prevSpeakerKey !== ctx.speakerKey) {
      return geom.gapSpeaker
    }
    // 1b. 同人连发:same 间距
    return geom.gapSame
  }
  // 2. 跨方向:cross 间距
  return geom.gapCross
}

/**
 * 聊天区消息布局管线
 *
 * @param options 测量函数
 * @returns       布局 computed 集合 + 尺寸过渡上下文(layoutContext)
 */
export function useChatRows(options: ChatRowsOptions) {
  const { measure } = options
  const chatStore = useChatStore()
  const { playedMessages, isLoading, loadingSide, pendingAiSpeaker } = storeToRefs(chatStore)

  /** 注入几何(默认全局;导出模式由 ChatExportStage 覆盖为桌面几何)。
   * 注意:必须在 setup 期间立即 inject(此时 currentInstance 必然存在)。
   * 若在 computed getter 内惰性调用 inject,当 getter 在组件上下文之外
   * (调度 flush 边缘/异步回调)求值时,inject 返回 undefined 且默认值被忽略,
   * 会导致 geom 为 undefined → 渲染期抛异常 → ChatArea 子树崩溃(移动端
   * 键盘弹出/收起触发重渲染时必现,表现为主界面消失只剩背景)。 */
  const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
  const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

  /** 当前对话的对话名(旧数据消息无 speakerName 时的身份回退,未选中时为空串) */
  const activeConvName = computed(() =>
    chatStore.activeSub === null ? '' : chatStore.conversations[chatStore.activeSub]?.name ?? '',
  )

  /** 当前对话的对方/我方默认头像 URL(群聊 per-message 可覆盖) */
  const otherAvatarUrl = computed(() => chatStore.currentOtherAvatarUrl)
  /** 我方默认头像 = 全局管理员头像(根据 myGender 选择男/女) */
  const mineAvatarUrl = computed(() => chatStore.myAvatar)

  /**
   * 解析单条消息的说话人头像 URL(支持群聊 per-message 覆盖)
   *
   * 直接走 store 导出的公共 resolveMessageAvatar,与构建消息时写入的
   * speakerAvatar 同源,避免两处解析链差异导致头像不一致。
   */
  function resolveSpeakerAvatar(msg: MessageSpeaker): string {
    return chatStore.resolveMessageAvatar(
      msg,
      activeConvName.value,
      otherAvatarUrl.value,
      mineAvatarUrl.value,
    )
  }

  /**
   * 单条消息的说话人显示名(角色名称悬浮气泡用)
   *
   * 【已注释停用】角色名称显示功能整体停用,该解析函数一并注释保留,便于日后恢复。
   */
  // function resolveSpeakerName(msg: MessageSpeaker): string {
  //   if (msg.side === 'mine') {
  //     // mine 侧:管理员(我方),speakerName 始终为"管理员"
  //     return msg.speakerName ?? '管理员'
  //   }
  //   // other 侧:显式 speakerName,否则回退会话名
  //   return msg.speakerName ?? activeConvName.value
  // }

  /**
   * 说话人身份键:该消息实际渲染的头像 URL(与 resolveSpeakerAvatar 完全一致)
   *
   * 用于判断"同方向是否换了说话人":身份键不同 → 视为新说话人开口,
   * 需要重新显示头像(群聊多角色场景)。
   */
  function speakerKeyOf(msg: MessageSpeaker): string {
    return resolveSpeakerAvatar(msg)
  }

  /**
   * 尺寸过渡上下文(非响应式)
   *
   * fresh=true  表示处于 chat-in 入场期(无 LoadingBubble,无文字气泡过渡)
   * fresh=false 表示入场结束(文字气泡 prevRect = LOADING_RECT)
   * 由 ChatArea 的 watcher 翻转:activeSub 变化 → true;首条 LoadingBubble
   * 显示(post flush)→ false。
   *
   * 刻意不做成 ref:
   *   1. fresh=true 在 activeSub watcher 内同步翻转,早于 playedMessages 重算,
   *      rows 首次计算时读到的一定是 true。
   *   2. fresh=false 在 isLoading watcher(flush:post)内翻转,此时 rows 已完成
   *      首次计算(fresh=true 生效)。下次 rows 重算(playedCount++ 时)读到 false,
   *      新增行 prevRect=LOADING_RECT,正确触发尺寸过渡。
   *   3. 若做成 ref,fresh 翻转会触发 rows 重算,导致已渲染的行 prevRect 从
   *      undefined 变为 LOADING_RECT,触发 ChatBubble watch(prevRect) 重新执行
   *      triggerTransition,所有已显示气泡"脉冲"一次(先缩到加载尺寸再弹回)。
   *      非响应式设计正是为了避免这个副作用。
   */
  const layoutContext = { fresh: true }

  /**
   * 每条消息首次参与布局时的 prevRect 快照(消息 id → prevRect)
   *
   * rows 重算时一律复用首次值,避免已挂载气泡的 prevRect 被后续
   * layoutContext.fresh 翻转改写:
   *   - 若某气泡在 fresh=true 期间首渲染(prevRect=undefined,chat-in 入场),
   *     之后 fresh=false 时重算会把它的 prevRect 推导为 LOADING_RECT,
   *     触发 ChatBubble watch(prevRect) 对已显示气泡重复 triggerTransition
   *     ("脉冲"重播,覆盖"续播已播一半的会话"场景)。
   *
   * 键为消息 id(各对话内从 1 自增、非全局唯一),切换对话时清空。
   */
  const frozenPrevRects = new Map<number, RectSize | undefined>()

  watch(
    () => chatStore.activeSub,
    () => frozenPrevRects.clear(),
    { immediate: true },
  )

  /**
   * chat-scroll 实际高度(几何层:桌面 831,移动端视口推导)
   */
  const chatScrollHeight = computed(() => geom.value.scrollH)

  // ---- 消息行布局 ------------------------------------------------------------
  /**
   * 计算所有消息的布局(输出为"滚动容器相对坐标")
   *
   * 算法要点:
   * - 首条消息:avatarTop = anchorAvatarTop - scrollY(滚动相对),
   *   bubbleTop = avatarBubbleTop(avatarTop, side, avatarBox)
   * - 后续消息:bubbleTop = cursor + (同方向 same / 跨方向 cross),
   *   avatarTop = bubbleTop - avatarTopToBubble[side]
   * - showAvatar:与上一条消息方向不同时显示头像
   *
   * prevRect 规则:
   * - 首屏(layoutContext.fresh):全部 undefined(走整体 chat-in)
   * - 非首屏:每条消息 prevRect=LOADING_RECT(从加载气泡尺寸过渡到真实尺寸)
   */
  const rows = computed<ChatRow[]>(() => {
    const g = geom.value
    const list: ChatRow[] = []
    let prevSide: 'other' | 'mine' | null = null
    let prevSpeakerKey: string | null = null
    let cursor = 0
    const avatarTopToBubbleOfSide = avatarTopToBubble(g.avatarBox)
    // 气泡测量参数(移动端字号/边距更小)
    const metrics = {
      fontSize: g.bubbleFontSize,
      lineHeight: g.bubbleLineHeight,
      padX: g.bubblePadX,
      padY: g.bubblePadY,
      minW: g.bubbleMinW,
      minH: g.bubbleMinH,
    }
    // 加载气泡尺寸(移动端更小)
    const loadingRect = { w: g.loadingRectW, h: g.bubbleSingleLineH }
    for (const msg of playedMessages.value) {
      const displayText = msg.text
      // 图片消息:不测量文本,用发送时计算的真实显示尺寸(纯图片无气泡)
      const hasImage = !!msg.image
      const box = hasImage
        ? { rectW: msg.imageW ?? CHAT_IMAGE.w, rectH: msg.imageH ?? CHAT_IMAGE.h, innerW: msg.imageW ?? CHAT_IMAGE.w }
        : measure(displayText, g.bubbleInnerMaxW, metrics)

      const svgW = bubbleSvgWidth(box.rectW, msg.side)
      const speakerKey = speakerKeyOf(msg)
      // 方向改变 或 同方向换了说话人 → 显示头像(群聊换人各自带头像)
      const showAvatar = prevSide !== msg.side || prevSpeakerKey !== speakerKey
      let avatarTop: number
      let bubbleTop: number
      if (list.length === 0) {
        avatarTop = g.anchorAvatarTop - g.scrollY
        bubbleTop = avatarBubbleTop(avatarTop, msg.side, g.avatarBox)
      } else {
        const gap = computeGap(g, {
          side: msg.side,
          prevSide,
          prevSpeakerKey,
          speakerKey,
        })
        bubbleTop = cursor + gap
        avatarTop = bubbleTop - avatarTopToBubbleOfSide[msg.side]
      }
      const avatarX = (msg.side === 'other' ? g.otherAvatarX : g.mineAvatarX) - g.scrollX
      const left = (msg.side === 'other' ? g.otherBubbleX : g.mineBubbleRight - svgW) - g.scrollX

      // prevRect:每消息首次布局时冻结快照,之后永不再变。
      let prevRect: RectSize | undefined
      if (frozenPrevRects.has(msg.id)) {
        prevRect = frozenPrevRects.get(msg.id)
      } else {
        prevRect = layoutContext.fresh ? undefined : loadingRect
        frozenPrevRects.set(msg.id, prevRect)
      }

      list.push({
        msg,
        displayText,
        box,
        left,
        bubbleTop,
        avatarTop,
        avatarX,
        showAvatar,
        stack: avatarStack(avatarX, avatarTop, g.avatarBox),
        prevRect,
        bottom: bubbleTop + box.rectH,
      })
      cursor = bubbleTop + box.rectH
      prevSide = msg.side
      prevSpeakerKey = speakerKey
    }
    return list
  })

  /** 末行(用于推算 LoadingBubble 起点与内容底部) */
  const lastRow = computed(() => rows.value[rows.value.length - 1])

  /**
   * LoadingBubble 布局(滚动容器相对坐标)
   *
   * - top: 末行底部 + 跨方向间距(模拟下一条消息起点)
   * - 首条消息尚无末行时,锚定到首条消息气泡顶部
   * - left: other 侧取 otherBubbleX,mine 侧取右边界减加载气泡 svgW
   * - 加载气泡自身从 width=0 展开到 100,无需 prevRect
   */
  const loadingLayout = computed(() => {
    const g = geom.value
    const side = loadingSide.value
    if (!side || !isLoading.value) return null

    const loadingRectW = g.loadingRectW
    const loadSvgW = bubbleSvgWidth(loadingRectW, side)
    const left = (side === 'other' ? g.otherBubbleX : g.mineBubbleRight - loadSvgW) - g.scrollX
    let bubbleTop: number
    if (lastRow.value) {
      // 用 lastRow.box(已缓存),避免重复 measure 触发重排
      // 间距取决于末行与下一条(loadingSide)的关系:
      //   跨方向 cross / 同方向换说话人 speaker / 同人连发 same
      const lastKey = speakerKeyOf(lastRow.value.msg)
      // AI 流式回复时下一条消息尚未创建,用 pendingAiSpeaker 推导说话人键,
      // 避免与 lastKey 比较时恒不等 → 误判为换说话人 → 多余头像 & 错误间距
      const fallbackKey = pendingAiSpeaker.value.avatar
        ? pendingAiSpeaker.value.avatar
        : (side === 'other' ? otherAvatarUrl.value : mineAvatarUrl.value)
      const gap = lastRow.value.msg.side === side
        ? (lastKey !== fallbackKey ? g.gapSpeaker : g.gapSame)
        : g.gapCross
      bubbleTop = lastRow.value.bottom + gap
    } else {
      bubbleTop = avatarBubbleTop(g.anchorAvatarTop - g.scrollY, side, g.avatarBox)
    }
    const avatarTop = bubbleTop - avatarTopToBubble(g.avatarBox)[side]
    const avatarX = (side === 'other' ? g.otherAvatarX : g.mineAvatarX) - g.scrollX
    // 加载气泡头像:AI 流式回复时下一条消息尚未创建,用 pendingAiSpeaker 的头像
    const portraitUrl = pendingAiSpeaker.value.avatar
      ? pendingAiSpeaker.value.avatar
      : (side === 'other' ? otherAvatarUrl.value : mineAvatarUrl.value)

    // 加载气泡占用的布局高度:加载阶段下一条消息未创建,预留单行加载气泡高度,
    // AI 首条 chunk 创建消息后由 LoadingBubble → 文字气泡过渡接管尺寸。
    const loadH = g.bubbleSingleLineH

    return {
      left,
      top: bubbleTop,
      loadW: loadSvgW,
      loadH,
      avatarTop,
      avatarX,
      stack: avatarStack(avatarX, avatarTop, g.avatarBox),
      side,
      portraitUrl,
      // 已注释停用:speakerName 仅用于加载气泡上方的角色名称悬浮,该功能整体停用。
      // speakerName: isLoading.value ? pendingAiSpeaker.value.name : '',
      speakerKey: pendingAiSpeaker.value.avatar
        ? pendingAiSpeaker.value.avatar
        : (side === 'other' ? otherAvatarUrl.value : mineAvatarUrl.value),
    }
  })

  /** 是否显示 LoadingBubble 头像(空流首条 / 与末行方向不同 / 换说话人) */
  const showLoadingAvatar = computed(() => {
    if (!loadingLayout.value) return false
    if (!lastRow.value) return true
    return lastRow.value.msg.side !== loadingLayout.value.side
      || speakerKeyOf(lastRow.value.msg) !== loadingLayout.value.speakerKey
  })

  /**
   * 滚动内容底部 y(滚动容器相对坐标):
   * LoadingBubble 存在时以其为末行(高度取下一条消息的真实测量高度,
   * 使滚动高度在"加载 → 真实气泡"之间保持不变),否则取已发消息末行
   */
  const contentBottom = computed(() => {
    if (loadingLayout.value) {
      return loadingLayout.value.top + loadingLayout.value.loadH
    }
    if (!lastRow.value) return 0
    return lastRow.value.bottom
  })

  /** 末尾装饰 top(滚动容器相对坐标) */
  const endDecoTop = computed(() => contentBottom.value + geom.value.endDecoGap)

  /** 尾部留白 top(滚动容器相对坐标) */
  const padTop = computed(() => endDecoTop.value + geom.value.endDecoH + geom.value.endDecoGap)

  return {
    layoutContext,
    rows,
    lastRow,
    loadingLayout,
    showLoadingAvatar,
    endDecoTop,
    padTop,
    chatScrollHeight,
    resolveSpeakerAvatar,
    // resolveSpeakerName, // 【已注释停用】角色名称显示功能整体停用
  }
}
