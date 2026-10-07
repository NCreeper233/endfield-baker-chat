// =============================================================================
// 聊天区消息布局计算(useChatRows)
// -----------------------------------------------------------------------------
// 职责:
//   1. rows: 计算每条消息的布局(left/top/avatarTop/showAvatar/stack)
//      注意:一条消息可能展开成**多行** —— 开启实验性功能「括号描写居中」后,
//      消息里的括号描写会被抽成独立的居中行(见 utils/aiText.splitBracketParts),
//      故 v-for 的 key 必须用 row.key,不能再用 msg.id
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
import type { ComputedRef, Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore, MINE_NAME } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { attributeColorOf, findCharacter } from '../constants/character'
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
import { splitBracketParts, splitLeadingBracketParts, type MessagePart } from '../utils/aiText'
import type { ChatMessage, ChatRow, MessageSpeaker, RectSize } from '../types/chat'

/** 错误消息"重新生成"按钮区域额外高度(px),由布局层预留避免与下一条消息重叠 */
const ERROR_BTN_H = 40

/** useChatRows 输入参数 */
export interface ChatRowsOptions {
  /** 气泡文本测量函数(useBubbleMeasure.measure) */
  measure: (text: string, innerMax?: number, metrics?: import('../utils/measure').BubbleMetrics) => BubbleBox
  /**
   * 末尾附加内容(群聊流程控制条)占用的高度(px)
   *
   * 该内容渲染在"最后一条消息下方",需要计入滚动内容:
   * 末尾装饰与底部留白整体下移,否则会与其重叠。
   * 以 getter 传入,避免让布局层依赖具体组件。
   */
  extraBottomHeight?: () => number
  /**
   * 消息来源(缺省 = 当前会话的全部消息)
   *
   * 只有导出链路会传:导出选中消息时,渲染的必须是"选中的那几条",
   * 而布局管线(pendingAiSpeaker / 分条 / 居中行 …)照旧跑同一套代码 ——
   * 换的只是数据源,不另写一套导出渲染。
   */
  messages?: Ref<ChatMessage[] | undefined> | ComputedRef<ChatMessage[] | undefined>
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
  const settingsStore = useSettingsStore()
  const { playedMessages, isLoading, loadingSide, pendingAiSpeaker } = storeToRefs(chatStore)

  /**
   * 实际参与布局的消息
   *
   * 缺省是当前会话的全部消息;导出选中消息时由调用方传入子集 —— 之后的
   * 分条 / 居中行 / 间距 / 末尾装饰全部照旧走同一套代码。
   */
  const messages = computed<ChatMessage[]>(() => options.messages?.value ?? playedMessages.value)

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
   * 我方在**当前会话**里的署名
   *
   * - 群聊里"扮演某角色" → 该角色名
   * - 管理员 / 旁观 / 私聊 → 「管理员」
   *
   * 与 store 的 currentSelfIdentity 同口径(那边还要算头像,这里只要名字)。
   * 用途:「居中我方括号内容」的历史消息若没写 speakerName,按它取属性颜色。
   */
  const mineSpeakerName = computed(() => {
    const role = chatStore.activeCard?.myRole
    return role && role !== 'admin' && role !== 'observer' ? role : MINE_NAME
  })

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
      // 角色有两张形象时(管理员)按设置里的开关取那张,历史消息也跟着变
      chatStore.altAvatarOf,
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
   * 该消息的头像是否"可以点着切换形象"
   *
   * other 侧:说话人角色有两张形象时(目前只有「管理员」)—— 与字符卡的判据同源
   * (constants/character 的 avatarAlt),所以卡片上能点的头像,聊天区里也能点,
   * 光标也就该一样是手型。
   * mine 侧不在这里判:我方头像的点击规则由 ChatMessageRow 自己按 side 决定
   * (群聊「扮演某角色」的消息点头像不切性别,也就不该是手型)。
   */
  function isAvatarSwitchable(msg: MessageSpeaker): boolean {
    if (msg.side === 'mine') return false
    const name = msg.speakerName ?? activeConvName.value
    return !!findCharacter(name)?.avatarAlt
  }

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
   * 每条消息**首个部件行**首次参与布局时的 prevRect 快照(行键 → prevRect)
   *
   * rows 重算时一律复用首次值,避免已挂载气泡的 prevRect 被后续
   * layoutContext.fresh 翻转改写:
   *   - 若某气泡在 fresh=true 期间首渲染(prevRect=undefined,chat-in 入场),
   *     之后 fresh=false 时重算会把它的 prevRect 推导为 LOADING_RECT,
   *     触发 ChatBubble watch(prevRect) 对已显示气泡重复 triggerTransition
   *     ("脉冲"重播,覆盖"续播已播一半的会话"场景)。
   *
   * 键为**行键**(`消息 id#部件序号`):开启「括号描写居中」后一条消息会有多行,
   * 用消息 id 会互相覆盖。切换对话时清空。
   */
  const frozenPrevRects = new Map<string, RectSize | undefined>()

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
    // 「新话题」提示行专用字号(比气泡小一档,单行 20px)
    const topicMetrics = {
      fontSize: g.topicFontSize,
      lineHeight: g.topicLineHeight,
      padX: 0,
      padY: 0,
      minW: 0,
      minH: g.topicLineHeight,
    }
    // 括号描写居中行:与气泡同字号字族,但内边距 / 最小尺寸全为 0
    // (文本元素自身即内容盒,宽度就是量出来的 rectW,没有 padding 可扣)
    const centerMetrics = {
      fontSize: g.bubbleFontSize,
      lineHeight: g.bubbleLineHeight,
      padX: 0,
      padY: 0,
      minW: 0,
      minH: 0,
    }
    // 居中行可用宽度:左右各内缩 centerTextPadX(与渲染层容器同宽,口径同源)
    const centerInnerMax = Math.max(80, g.scrollW - g.centerTextPadX * 2)
    // 「括号描写居中」开关:纯渲染层,只决定这条消息要不要拆成"气泡行 + 居中行"
    const centerOn = settingsStore.bracketCenter
    // 「居中我方括号内容」开关:我方消息**开头**那一对括号是否也抽成居中行
    const myBracketOn = settingsStore.centerMyBracket
    // 「彩色括号描写」:居中行按说话人属性上色(依赖「括号描写居中」)
    const colorOn = centerOn && settingsStore.bracketColor

    /**
     * 居中行的文字颜色
     *
     *   - 我方:「居中我方括号内容」自带的效果 —— 按身份属性取色
     *           (单人对话 = 管理员 physical;群聊里扮演某角色 = 该角色)
     *   - 对方:仅在「彩色括号描写」开启时按说话人属性取色(群聊逐条取
     *           msg.speakerName,单聊回退会话名)
     *
     * 返回 undefined = 用统一的居中文本颜色(见 ChatMessageRow 的 CENTER_ACTION_COLOR)。
     */
    const centerColorFor = (msg: ChatMessage): string | undefined => {
      if (msg.side === 'mine') {
        return attributeColorOf(msg.speakerName || mineSpeakerName.value)
      }
      return colorOn ? attributeColorOf(msg.speakerName || activeConvName.value) : undefined
    }

    /**
     * 取某行的首屏快照(首次布局时冻结,之后永不再变 —— 见 frozenPrevRects)
     *
     * 气泡行用它当尺寸过渡的起点(居中行没有尺寸过渡,不写入本表)。
     */
    const prevRectOf = (key: string): RectSize | undefined => {
      if (frozenPrevRects.has(key)) return frozenPrevRects.get(key)
      const v = layoutContext.fresh ? undefined : loadingRect
      frozenPrevRects.set(key, v)
      return v
    }

    for (const msg of messages.value) {
      const displayText = msg.text

      // ---- 群聊「新话题」提示行 ----
      // 无头像、无气泡,只占一行灰字;不参与上一条的 side/speaker 推算,
      // 这样它后面的那条消息仍按它之前的那条真实消息计算间距与头像。
      if (msg.topic) {
        // 测量用的可用宽度**刻意收窄 12px**:canvas/ruler 与真实 DOM 的字形宽度
        // 存在亚像素差异,若按实测宽度精确设置元素宽度("新话题：50" 就只有
        // 那几个字的宽度),末尾字符会被挤到下一行 —— 用户看到的就是"0 换行了"。
        // 收窄测量 → 量出的行数是上限;渲染时再用 max-width 让浏览器自然排版,
        // 实际高度只会小于等于它,不会与下一条重叠。
        const topicMeasureMax = Math.max(120, g.bubbleInnerMaxW - 12)
        const tBox = measure(`新话题：${displayText}`, topicMeasureMax, topicMetrics)
        const gap = list.length === 0
          ? 0
          : computeGap(g, {
              side: 'other',
              prevSide,
              prevSpeakerKey,
              speakerKey: `__topic__${msg.id}`,
            })
        const top = list.length === 0
          ? g.anchorAvatarTop - g.scrollY
          : cursor + gap
        list.push({
          msg,
          key: `${msg.id}#0`,
          displayText,
          box: tBox,
          left: g.otherBubbleX - g.scrollX,
          bubbleTop: top,
          avatarTop: top,
          avatarX: g.otherAvatarX - g.scrollX,
          showAvatar: false,
          // 话题行不画头像,stack 给个占位(渲染时 showAvatar=false 不会用它)
          stack: avatarStack(g.otherAvatarX - g.scrollX, 0, g.avatarBox),
          bottom: top + tBox.rectH,
          isTopic: true,
        })
        cursor = top + tBox.rectH
        continue
      }

      // ---- 渲染部件拆分(括号描写居中 / 居中我方括号内容) ----
      // 对方侧:开启「括号描写居中」后,整条消息按括号拆成"气泡段 + 居中段"。
      // 我方侧:只在开启「居中我方括号内容」时,把**最前面**那一对括号抽成居中段 ——
      //         玩家自己写的正文不切碎,后面再出现的括号原样留在气泡里。
      // 图片消息 / 错误气泡一律不拆。两个开关都关时 parts 恒为单元素,
      // 行为与拆分功能加入之前完全一致。
      const canCenter = centerOn && msg.side === 'other' && !msg.image && !msg.isError
      const canCenterMine = myBracketOn && msg.side === 'mine' && !msg.image && !msg.isError
      const parts: MessagePart[] = canCenter
        ? splitBracketParts(displayText)
        : canCenterMine
          ? splitLeadingBracketParts(displayText)
          : [{ text: displayText, centered: false }]
      // 心情表情是**气泡**角落的装饰,一条消息只挂一个:挂在首条气泡行上。
      // (整条消息都是居中行时没有气泡可挂,渲染层不画 —— 见 ChatMessageRow)
      const firstBubble = parts.findIndex((p) => !p.centered)
      const moodRowIndex = firstBubble === -1 ? 0 : firstBubble
      const speakerKey = speakerKeyOf(msg)

      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi]
        const rowKey = `${msg.id}#${pi}`

        // ---- 居中行:无气泡 / 无头像 / 无左右归属,水平居中 ----
        // 间距取自 maker(endfield-baker-maker)对居中文本的处理:**打断对话流** ——
        // 它自己与它后面的第一条气泡都用 cross 间距(而不是 same),否则居中条会
        // 紧贴上下两条消息,读起来像被吞进气泡里。
        // 流被"打断"还有第二层含义:居中行后面那句台词重新算作**新一组**
        // (无条件带头像),因为中间的旁白已经把它与前一句隔开了。
        if (part.centered) {
          const cBox = measure(part.text, centerInnerMax, centerMetrics)
          const top = list.length === 0
            ? g.anchorAvatarTop - g.scrollY
            : cursor + g.gapCross
          list.push({
            msg,
            key: rowKey,
            displayText: part.text,
            box: cBox,
            left: (g.scrollW - cBox.rectW) / 2,
            bubbleTop: top,
            avatarTop: top,
            avatarX: 0,
            showAvatar: false,
            // 居中行不画头像,stack 给个占位(渲染时 showAvatar=false 不会用它)
            stack: avatarStack(0, 0, g.avatarBox),
            isCentered: true,
            // 「彩色括号描写」/「居中我方括号内容」:按说话人属性取色;undefined = 统一色
            centerColor: centerColorFor(msg),
            moodRow: pi === moodRowIndex,
            bottom: top + cBox.rectH,
          })
          cursor = top + cBox.rectH
          // 打断对话流:后面的气泡按"换侧"起排(cross 间距 + 重新带头像)
          prevSide = null
          prevSpeakerKey = null
          continue
        }

        // ---- 气泡行:逻辑与拆分功能加入之前完全一致,只是文本换成该部件的文本 ----
        const text = part.text
        // 图片消息:不测量文本,用发送时计算的真实显示尺寸(纯图片无气泡)
        const hasImage = !!msg.image
        const measuredBox = hasImage
          ? { rectW: msg.imageW ?? CHAT_IMAGE.w, rectH: msg.imageH ?? CHAT_IMAGE.h, innerW: msg.imageW ?? CHAT_IMAGE.w }
          : measure(text, g.bubbleInnerMaxW, metrics)
        // 错误消息:气泡底部需容纳"重新生成"按钮,额外预留高度,避免按钮与下一条消息重叠
        const box = msg.isError && !hasImage
          ? { ...measuredBox, rectH: measuredBox.rectH + ERROR_BTN_H }
          : measuredBox

        const svgW = bubbleSvgWidth(box.rectW, msg.side)
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

        // prevRect:每行首次布局时冻结快照,之后永不再变。
        const prevRect = prevRectOf(rowKey)

        list.push({
          msg,
          key: rowKey,
          displayText: text,
          box,
          left,
          bubbleTop,
          avatarTop,
          avatarX,
          showAvatar,
          stack: avatarStack(avatarX, avatarTop, g.avatarBox),
          prevRect,
          moodRow: pi === moodRowIndex,
          bottom: bubbleTop + box.rectH,
        })
        cursor = bubbleTop + box.rectH
        prevSide = msg.side
        prevSpeakerKey = speakerKey
      }
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
   *
   * 开启「括号描写居中」时,**本轮回复刚开始的那一次**加载换成居中态
   * (centered=true):只显示三点、不带气泡与头像,位置就是居中条将出现的位置
   * (左右内缩 centerTextPadX、上方留 gapCross)。原因见 LoadingBubble 文件头:
   * 回复首条是不是动作描写,请求返回前无从得知,不能先冒出"头像 + 气泡"再被居中条顶掉。
   *
   * 一旦本轮落过内容(aiTurnHasContent),后面的加载都只是**前端分条的续段** ——
   * 说话人已经建立、也不会再出现"首条就是居中条"的问题,故照旧用头像 + 加载气泡。
   */
  const loadingLayout = computed(() => {
    const g = geom.value
    const side = loadingSide.value
    if (!side || !isLoading.value) return null

    // 居中态仅用于本轮回复的第一拍(见上方注释)
    const centered = settingsStore.bracketCenter && !chatStore.aiTurnHasContent

    const loadingRectW = g.loadingRectW
    const loadSvgW = bubbleSvgWidth(loadingRectW, side)
    const left = centered
      ? g.centerTextPadX
      : (side === 'other' ? g.otherBubbleX : g.mineBubbleRight - loadSvgW) - g.scrollX
    let bubbleTop: number
    if (lastRow.value) {
      // 用 lastRow.box(已缓存),避免重复 measure 触发重排
      // 间距取决于末行与下一条(loadingSide)的关系:
      //   末行是居中行 → cross(它打断对话流,见 rows 内注释)
      //   跨方向 cross / 同方向换说话人 speaker / 同人连发 same
      const lastKey = speakerKeyOf(lastRow.value.msg)
      // AI 流式回复时下一条消息尚未创建,用 pendingAiSpeaker 推导说话人键,
      // 避免与 lastKey 比较时恒不等 → 误判为换说话人 → 多余头像 & 错误间距
      const fallbackKey = pendingAiSpeaker.value.avatar
        ? pendingAiSpeaker.value.avatar
        : (side === 'other' ? otherAvatarUrl.value : mineAvatarUrl.value)
      const gap = (centered || lastRow.value.isCentered)
        ? g.gapCross
        : lastRow.value.msg.side === side
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
    // 居中态预留"一行居中文本"的高度(三点就那么大)。
    const loadH = centered ? g.bubbleLineHeight : g.bubbleSingleLineH

    return {
      centered,
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

  /**
   * 是否显示 LoadingBubble 头像(空流首条 / 与末行方向不同 / 换说话人 / 末行是居中行)
   *
   * 居中态恒不显示:那一刻还不知道回复首条是不是居中条,而居中条无头像无归属
   * (先冒出头像再被顶掉就是用户反馈的闪烁)。
   */
  const showLoadingAvatar = computed(() => {
    if (!loadingLayout.value) return false
    if (loadingLayout.value.centered) return false
    if (!lastRow.value) return true
    // 末行是居中行 → 对话流被打断,下一条无条件重新带头像(与 rows 内规则一致)
    return !!lastRow.value.isCentered
      || lastRow.value.msg.side !== loadingLayout.value.side
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

  /** 末尾附加内容(群聊流程控制条)占用高度,容错为非负有限数 */
  const extraBottom = computed(() => {
    const v = options.extraBottomHeight?.() ?? 0
    return Number.isFinite(v) && v > 0 ? v : 0
  })

  /** 流程控制条的 top(滚动容器相对坐标):紧贴最后一条消息下方 */
  const flowTop = computed(() => contentBottom.value + geom.value.endDecoGap)

  /** 末尾装饰 top(滚动容器相对坐标;让开流程控制条) */
  const endDecoTop = computed(
    () => contentBottom.value + geom.value.endDecoGap + extraBottom.value,
  )

  /** 尾部留白 top(滚动容器相对坐标) */
  const padTop = computed(() => endDecoTop.value + geom.value.endDecoH + geom.value.endDecoGap)

  return {
    layoutContext,
    rows,
    lastRow,
    loadingLayout,
    showLoadingAvatar,
    contentBottom,
    flowTop,
    extraBottom,
    endDecoTop,
    padTop,
    chatScrollHeight,
    resolveSpeakerAvatar,
    /** 该行头像能否点击切换形象(决定聊天区头像是否显示手型光标) */
    isAvatarSwitchable,
    // resolveSpeakerName, // 【已注释停用】角色名称显示功能整体停用
  }
}
