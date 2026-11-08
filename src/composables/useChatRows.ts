// useChatRows —— 聊天区的消息布局计算（纯计算，不碰 DOM）
// 一条消息可能展开成多行（括号描写居中），所以 v-for 的 key 用 row.key 而非 msg.id。
// 行对象按 row.key 复用：只有渲染等价的旧对象才复用引用，流式时才能整行跳过 patch。
// freshContext 刻意做成可变对象而非 ref —— 做成响应式会让已挂载气泡「脉冲」一次。

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
  type AvatarStack,
} from '../constants/design'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../constants/chatGeometry'
import { bubbleSvgWidth, type BubbleBox } from '../utils/measure'
import { splitBracketParts, type MessagePart } from '../utils/aiText'
import type { ChatMessage, ChatRow, MessageSpeaker, RectSize } from '../types/chat'

/** 错误消息"重新生成"按钮区域额外高度(px),由布局层预留避免与下一条消息重叠 */
const ERROR_BTN_H = 40

/** useChatRows 输入参数 */
export interface ChatRowsOptions {
  /** 气泡文本测量函数(useBubbleMeasure.measure) */
  measure: (text: string, innerMax?: number, metrics?: import('../utils/measure').BubbleMetrics) => BubbleBox
  /** 末尾附加内容（群聊控制条）占的高度，要把末尾装饰与底部留白一起下移 */
  extraBottomHeight?: () => number
  /** 消息来源，缺省 = 当前会话；只有导出链路会传，管线其余部分照旧 */
  messages?: Ref<ChatMessage[] | undefined> | ComputedRef<ChatMessage[] | undefined>
}

/**
 * 行间距规则（数值来自几何层）
 *
 * 同方向再细分：换说话人用 gapSpeaker（给新头像留位），同人连发用 gapSame；跨方向用 gapCross。
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

// 行对象复用（值比较）
// avatarStack / 错误气泡的 box / 图片消息的 box 每次计算都会新建对象,
// 不能按引用判断"有没有变";这里统一逐字段比值。

/** 头像槽位逐值相等 */
type AvatarSlot = AvatarStack['bg']

function sameSlot(a: AvatarSlot, b: AvatarSlot): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** 头像三层槽位逐值相等 */
function sameStack(a: AvatarStack, b: AvatarStack): boolean {
  return sameSlot(a.bg, b.bg) && sameSlot(a.ring, b.ring) && sameSlot(a.portrait, b.portrait)
}

/** 过渡起始尺寸逐值相等(undefined = 首屏无过渡) */
function sameRect(a?: RectSize, b?: RectSize): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.w === b.w && a.h === b.h
}

/** 测量结果逐值相等(measure 命中缓存时是同一对象,图片/错误气泡则是新对象) */
function sameBox(a: BubbleBox, b: BubbleBox): boolean {
  return a.rectW === b.rectW && a.rectH === b.rectH && a.innerW === b.innerW
}

/**
 * 两行是否**渲染等价**
 *
 * 必须覆盖 ChatRow 的每个字段：复用旧对象时，漏比的字段会永远停在旧值
 * （行对象不是响应式的，就地改不触发更新）。新增字段时这里要同步加。
 */
function sameRow(a: ChatRow, b: ChatRow): boolean {
  return (
    a.msg === b.msg
    && a.key === b.key
    && a.displayText === b.displayText
    && a.left === b.left
    && a.bubbleTop === b.bubbleTop
    && a.avatarTop === b.avatarTop
    && a.avatarX === b.avatarX
    && a.showAvatar === b.showAvatar
    && a.bottom === b.bottom
    && a.isTopic === b.isTopic
    && a.isCentered === b.isCentered
    && a.centerColor === b.centerColor
    && a.moodRow === b.moodRow
    && sameBox(a.box, b.box)
    && sameStack(a.stack, b.stack)
    && sameRect(a.prevRect, b.prevRect)
  )
}

/**
 * 编译期护栏：上面的比较必须覆盖 ChatRow 的全部字段
 *
 * 将来新增字段而没补比较 → `Exclude` 非 never → 赋值处编译报错，逼人回去补。
 * 缺了它，新字段会永远停在旧值，而这种回归在浏览器里极难发现。
 */
type ComparedRowField =
  | 'msg'
  | 'key'
  | 'displayText'
  | 'box'
  | 'left'
  | 'bubbleTop'
  | 'avatarTop'
  | 'avatarX'
  | 'showAvatar'
  | 'stack'
  | 'prevRect'
  | 'bottom'
  | 'isTopic'
  | 'isCentered'
  | 'centerColor'
  | 'moodRow'

type MissingRowField = Exclude<keyof ChatRow, ComparedRowField>
const _rowFieldsAllCompared: MissingRowField extends never ? true : MissingRowField = true
void _rowFieldsAllCompared

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
   * 我方在该会话的署名：扮演角色时用角色名，否则用管理员
   *
   * 与 store 的 currentSelfIdentity 同口径（那边还要算头像）。用于给没写 speakerName
   * 的历史消息取属性颜色。
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

  /** other 侧头像能否点击换形象（与角色卡的判据同源）；mine 侧由 ChatMessageRow 自己判 */
  function isAvatarSwitchable(msg: MessageSpeaker): boolean {
    if (msg.side === 'mine') return false
    const name = msg.speakerName ?? activeConvName.value
    return !!findCharacter(name)?.avatarAlt
  }

  /** 身份键用解析后的头像：不同 → 视为换了说话人，需要重新显示头像 */
  function speakerKeyOf(msg: MessageSpeaker): string {
    return resolveSpeakerAvatar(msg)
  }

  /**
   * 尺寸过渡上下文，**刻意非响应式**：做成 ref 后翻转本身会触发重算，
   * 已挂载气泡的 prevRect 会从 undefined 变成 LOADING_RECT，整屏「脉冲」一次。
   */
  const layoutContext = { fresh: true }

  /**
   * 复用首次快照，避免 fresh 翻转后对已挂载气泡重播一次过渡。键用行键 ——
   * 一条消息拆成多行时用消息 id 会互相覆盖。切会话时清空。
   */
  const frozenPrevRects = new Map<string, RectSize | undefined>()

  /**
   * 流式每个 chunk 都会全量重算：渲染等价时返回缓存对象，引用不变让 patch 整行跳过。
   * 不能就地改缓存对象的字段（行对象非响应式，改了不触发更新，界面停在旧值）。
   * 切会话时清空 —— 消息 id 会话内自增，跨会话会撞键。
   */
  const rowCache = new Map<string, ChatRow>()

  /** 提交一行:与上次等价则复用旧引用,否则用新对象覆盖缓存 */
  const commitRow = (next: ChatRow): ChatRow => {
    const prev = rowCache.get(next.key)
    const row = prev && sameRow(prev, next) ? prev : next
    rowCache.set(next.key, row)
    return row
  }

  /**
   * 测量结果按「消息对象 + 槽位」缓存
   *
   * rows 每次重算都要遍历全部消息，其中绝大多数文本一个字都没变。measure 内部虽有
   * LRU，但它的键把**整段文本**拼进字符串 —— 1000 条消息每帧都要重新拼接并哈希一遍
   * 全文，这是流式时最主要的一笔无谓分配。
   *
   * 这里用消息对象作弱键：几何对象没换、文本还是同一个引用，就直接复用，完全不进
   * measure。流式时只有正在增长的那一条会 miss。
   */
  interface BoxMemo {
    /** 出结果时的几何对象；几何层换新对象 = 布局变了，必须重算 */
    geom: ChatGeometry
    text: string
    box: BubbleBox
  }
  const boxMemo = new WeakMap<ChatMessage, Map<number, BoxMemo>>()

  /**
   * 取某条消息某一槽位的测量结果
   *
   * @param slot 同一条消息可能拆成多个部件，各占一格（话题行用 TOPIC_SLOT）
   */
  function memoBox(
    g: ChatGeometry,
    msg: ChatMessage,
    slot: number,
    text: string,
    run: () => BubbleBox,
  ): BubbleBox {
    let m = boxMemo.get(msg)
    if (!m) {
      m = new Map()
      boxMemo.set(msg, m)
    }
    const hit = m.get(slot)
    if (hit && hit.geom === g && hit.text === text) return hit.box
    const box = run()
    m.set(slot, { geom: g, text, box })
    return box
  }

  /** 话题行的缓存槽位（不与任何部件下标冲突） */
  const TOPIC_SLOT = 99

  watch(
    () => chatStore.activeSub,
    () => {
      frozenPrevRects.clear()
      rowCache.clear()
    },
    { immediate: true },
  )

  /**
   * chat-scroll 实际高度(几何层:桌面 831,移动端视口推导)
   */
  const chatScrollHeight = computed(() => geom.value.scrollH)

  // ---- 消息行布局 ------------------------------------------------------------
  /**
   * 计算所有消息的布局（输出滚动容器相对坐标）
   *
   * 首条以 anchorAvatarTop 起算，后续按 gap 累加 cursor。prevRect 只在非首屏时
   * 给 LOADING_RECT，让新气泡从加载尺寸过渡入场。
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
    // 「居中我方括号内容」开关:我方消息里的括号是否也抽成居中行(不分位置)
    const myBracketOn = settingsStore.centerMyBracket
    // 「彩色括号描写」:居中行按说话人属性上色(依赖「括号描写居中」)
    const colorOn = centerOn && settingsStore.bracketColor

    /**
     * 居中行的文字颜色
     *
     * 我方按身份属性取色（单人 = 管理员，群聊扮演 = 该角色）；对方仅在「彩色括号描写」
     * 开启时按说话人取色。返回 undefined 表示用统一的居中色。
     */
    const centerColorFor = (msg: ChatMessage): string | undefined => {
      if (msg.side === 'mine') {
        return attributeColorOf(msg.speakerName || mineSpeakerName.value)
      }
      return colorOn ? attributeColorOf(msg.speakerName || activeConvName.value) : undefined
    }

    /**
     * 取某行的首屏快照，首次布局时冻结后不再变（见 frozenPrevRects）
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
      // 不参与上一条的 side / speaker 推算，它后面的消息仍按真实消息计算间距
      if (msg.topic) {
        // 可用宽度刻意收窄 12px：canvas 测量与真实 DOM 有亚像素差异，按实测宽度精确
        // 设置会把末尾字符挤到下一行（「0 换行了」）。收窄后量出的行数是上限，
        // 渲染时再用 max-width 让浏览器自然排版，实际高度只会更小。
        const topicMeasureMax = Math.max(120, g.bubbleInnerMaxW - 12)
        const topicText = `新话题：${displayText}`
        const tBox = memoBox(g, msg, TOPIC_SLOT, topicText, () =>
          measure(topicText, topicMeasureMax, topicMetrics))
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
        list.push(commitRow({
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
        }))
        cursor = top + tBox.rectH
        continue
      }

      // ---- 渲染部件拆分(括号描写居中 / 居中我方括号内容) ----
      // 对方侧开启「括号描写居中」、我方侧开启「居中我方括号内容」后,整条消息按括号
      // 拆成"气泡段 + 居中段"。括号在**哪个位置都算**:开头、中间插入的、末尾收的,
      // 一律抽成居中行(两侧共用 aiText.splitBracketParts,只有一份判断)。
      // 图片消息 / 错误气泡一律不拆。两个开关都关时 parts 恒为单元素,
      // 行为与拆分功能加入之前完全一致。
      const canCenter = centerOn && msg.side === 'other' && !msg.image && !msg.isError
      const canCenterMine = myBracketOn && msg.side === 'mine' && !msg.image && !msg.isError
      const parts: MessagePart[] = canCenter || canCenterMine
        ? splitBracketParts(displayText)
        : [{ text: displayText, centered: false }]
      // 心情表情是气泡角落装饰，一条消息只挂一个：挂在首条气泡行上
      const firstBubble = parts.findIndex((p) => !p.centered)
      const moodRowIndex = firstBubble === -1 ? 0 : firstBubble
      const speakerKey = speakerKeyOf(msg)

      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi]
        const rowKey = `${msg.id}#${pi}`

        // ---- 居中行：无气泡、无头像、水平居中 ----
        // 间距按「打断对话流」处理：自己与它后面的第一条气泡都用 cross 间距，否则会
        // 紧贴上下两条消息。居中行后面那句台词也因此重新带头像。
        if (part.centered) {
          const cBox = memoBox(g, msg, pi * 2 + 1, part.text, () =>
            measure(part.text, centerInnerMax, centerMetrics))
          const top = list.length === 0
            ? g.anchorAvatarTop - g.scrollY
            : cursor + g.gapCross
          list.push(commitRow({
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
          }))
          cursor = top + cBox.rectH
          // 打断对话流:后面的气泡按"换侧"起排(cross 间距 + 重新带头像)
          prevSide = null
          prevSpeakerKey = null
          continue
        }

        // ---- 气泡行：逻辑不变，只是文本换成该部件的文本 ----
        const text = part.text
        // 图片消息不测量文本，用发送时算好的真实显示尺寸
        const hasImage = !!msg.image
        const measuredBox = hasImage
          ? { rectW: msg.imageW ?? CHAT_IMAGE.w, rectH: msg.imageH ?? CHAT_IMAGE.h, innerW: msg.imageW ?? CHAT_IMAGE.w }
          : memoBox(g, msg, pi * 2, text, () => measure(text, g.bubbleInnerMaxW, metrics))
        // 错误气泡要把「重新生成」按钮算进高度，否则会压住下一条
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

        list.push(commitRow({
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
        }))
        cursor = bubbleTop + box.rectH
        prevSide = msg.side
        prevSpeakerKey = speakerKey
      }
    }
    // 行数变少时清掉不再出现的键，避免缓存一直持有已删消息的行对象
    if (rowCache.size !== list.length) {
      const aliveKeys = new Set(list.map((row) => row.key))
      for (const key of rowCache.keys()) {
        if (!aliveKeys.has(key)) rowCache.delete(key)
      }
    }
    return list
  })

  /** 末行(用于推算 LoadingBubble 起点与内容底部) */
  const lastRow = computed(() => rows.value[rows.value.length - 1])

  /**
   * LoadingBubble 的布局（滚动容器相对坐标）
   *
   * 起点是末行底部 + 跨方向间距；还没有末行时锚定到首条气泡顶部。
   *
   * 开启括号居中后，**本轮第一拍**的加载换成居中态：只显示三点、不带气泡与头像，
   * 位置就是居中条将出现的地方。首条是不是动作描写在请求返回前无从得知，
   * 不能先冒出「头像 + 气泡」再被居中条顶掉。落过内容后（分条续段）照旧带头像。
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
  }
}
