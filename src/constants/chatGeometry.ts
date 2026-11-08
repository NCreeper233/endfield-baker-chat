// chatGeometry —— 聊天区几何的唯一出口
// 桌面端直接映射 design / panel 的常量；移动端按视口推导。组件通过
// chatGeometryKey 注入取几何，ChatExportStage 覆盖为 DESKTOP_GEOM 以保证导出仍按设计稿排版。

import { computed, type ComputedRef, type InjectionKey } from 'vue'
import {
  chatLayoutHeight,
  isMobileView,
  viewportWidth,
} from '../composables/useMobile'
import {
  CHAT,
  CHAT_BOTTOM_DECO,
  CHAT_DOTS_SIZE,
  CHAT_END_DECO,
  CHAT_FRAME,
  CHAT_GAP,
  CHAT_SCROLL,
  CHAT_SHOTS,
  SCROLL_BOTTOM_PAD,
  avatarTopToBubble,
} from './design'
import {
  BUBBLE_FONT_SIZE,
  BUBBLE_LINE_HEIGHT,
  BUBBLE_MIN_H,
  BUBBLE_MIN_W,
  BUBBLE_PAD_X,
  BUBBLE_PAD_Y,
  BUBBLE_SINGLE_LINE_H,
  LOADING_RECT,
} from '../utils/measure'
import { PANEL, PANEL_EDGE_MASK_H, PANEL_TOP_DECO_H, PANEL_TOP_DECO_W } from './panel'
import { CHARACTER_LIST_TOP, TOP_PAD } from './characterCard'
import { extraInputH } from '../composables/useInputHeight'

/** 均为画布坐标；行级布局由 useChatRows 转成滚动相对坐标 */
export interface ChatGeometry {
  // 顶部聊天条（strip）
  stripX: number
  stripY: number
  stripW: number
  stripH: number
  /** 移动端 true：左右段素材拼接；桌面 false：单图原样 */
  stripSegmented: boolean
  /** 头图原图高度，chat_strip_v*_l/r 均为 66 */
  stripImgH: number
  // 聊天框（detail / frame）
  detailX: number
  detailY: number
  detailW: number
  detailH: number
  /** 移动端已扣掉软键盘，面板按它算高度，键盘弹出也不会盖住输入框 */
  viewportH: number
  // 滚动容器
  scrollX: number
  scrollY: number
  scrollW: number
  scrollH: number
  // 消息锚点
  anchorAvatarTop: number
  otherAvatarX: number
  mineAvatarX: number
  otherBubbleX: number
  mineBubbleRight: number
  avatarBox: number
  avatarTopToBubble: Record<'other' | 'mine', number>
  // 消息间距
  gapSame: number
  gapCross: number
  gapSpeaker: number
  // 底部面板
  panelLeft: number
  panelWidth: number
  panelHeight: number
  panelTop: number
  panelEdgeMaskH: number
  panelTopDecoW: number
  panelTopDecoH: number
  // 装饰
  bottomDecoX: number
  bottomDecoY: number
  bottomDecoW: number
  bottomDecoH: number
  cornerDecoX: number
  cornerDecoY: number
  // 起始页区域（移动端不渲染，沿用桌面值）
  emptyTop: number
  emptyBottom: number
  // 气泡测量
  bubbleMaxW: number
  bubbleInnerMaxW: number
  // 滚动内容尾部
  endDecoW: number
  endDecoH: number
  endDecoGap: number
  scrollBottomPad: number
  dotsSize: number
  // 气泡测量与渲染参数
  /** 群聊「新话题」提示行，比气泡正文小一档 */
  topicFontSize: number
  topicLineHeight: number
  /** 括号描写居中行的左右内缩，避免长句顶到聊天框边缘 */
  centerTextPadX: number
  bubbleFontSize: number
  bubbleLineHeight: number
  bubblePadX: number
  bubblePadY: number
  bubbleMinW: number
  bubbleMinH: number
  /** rect 的 rx / ry */
  bubbleRadius: number
  loadingRectW: number
  /** 行高 + 上下 padding */
  bubbleSingleLineH: number
}

/** 起始页区域顶：与第一张一级卡片顶端对齐 */
const EMPTY_TOP = CHARACTER_LIST_TOP + TOP_PAD
/** 起始页区域底：与 chat_strip_detail 底边相同 */
const EMPTY_BOTTOM = CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h

export const DESKTOP_GEOM: ChatGeometry = {
  stripX: CHAT_SHOTS.strip.x,
  stripY: CHAT_SHOTS.strip.y,
  stripW: CHAT_SHOTS.strip.w,
  stripH: CHAT_SHOTS.strip.h,
  stripSegmented: false,
  stripImgH: 66,
  detailX: CHAT_SHOTS.detail.x,
  detailY: CHAT_SHOTS.detail.y,
  detailW: CHAT_SHOTS.detail.w,
  detailH: CHAT_SHOTS.detail.h,
  viewportH: CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h,
  scrollX: CHAT_SCROLL.x,
  scrollY: CHAT_SCROLL.y,
  scrollW: CHAT_SCROLL.w,
  scrollH: CHAT_SCROLL.h,
  anchorAvatarTop: CHAT.anchorAvatarTop,
  otherAvatarX: CHAT.otherAvatarX,
  mineAvatarX: CHAT.mineAvatarX,
  otherBubbleX: CHAT.otherBubbleX,
  mineBubbleRight: CHAT.mineBubbleRight,
  avatarBox: CHAT.avatarBox,
  avatarTopToBubble: avatarTopToBubble(CHAT.avatarBox),
  gapSame: CHAT_GAP.same,
  gapCross: CHAT_GAP.cross,
  gapSpeaker: CHAT_GAP.speaker,
  panelLeft: PANEL.left,
  panelWidth: PANEL.width,
  panelHeight: 80,
  panelTop: CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h - 80 - 3,
  panelEdgeMaskH: PANEL_EDGE_MASK_H,
  panelTopDecoW: PANEL_TOP_DECO_W,
  panelTopDecoH: PANEL_TOP_DECO_H,
  bottomDecoX: CHAT_BOTTOM_DECO.x,
  bottomDecoY: CHAT_BOTTOM_DECO.y,
  bottomDecoW: CHAT_BOTTOM_DECO.w,
  bottomDecoH: CHAT_BOTTOM_DECO.h,
  // 由原 CSS right: calc(100% - 1769.02px) + width 150px 换算（容器 0 宽）
  cornerDecoX: 1619.02,
  cornerDecoY: 139.44,
  emptyTop: EMPTY_TOP,
  emptyBottom: EMPTY_BOTTOM,
  bubbleMaxW: 660,
  bubbleInnerMaxW: 660 - 13 * 2,
  endDecoW: CHAT_END_DECO.w,
  endDecoH: CHAT_END_DECO.h,
  endDecoGap: CHAT_END_DECO.gap,
  scrollBottomPad: SCROLL_BOTTOM_PAD,
  dotsSize: CHAT_DOTS_SIZE,
  topicFontSize: 16,
  topicLineHeight: 24,
  // 纯居中文本（无气泡、无两侧细线）
  centerTextPadX: 30,
  bubbleFontSize: BUBBLE_FONT_SIZE,
  bubbleLineHeight: BUBBLE_LINE_HEIGHT,
  bubblePadX: BUBBLE_PAD_X,
  bubblePadY: BUBBLE_PAD_Y,
  bubbleMinW: BUBBLE_MIN_W,
  bubbleMinH: BUBBLE_MIN_H,
  bubbleRadius: 13.65,
  loadingRectW: LOADING_RECT.w,
  bubbleSingleLineH: BUBBLE_SINGLE_LINE_H,
}

/**
 * 移动端几何：strip → 滚动区 → 底部输入面板，气泡按视口宽度流式换行、字号 16px。
 * extraInput 是输入框因文本变长而增高的量；「展开成 2/3 屏大输入框」是浮层，不走这里。
 */
export function mobileGeometry(
  w: number,
  h: number,
  extraInput = 0,
): ChatGeometry {
  // 键盘过渡时 w/h 可能瞬时为 0，给最小可用尺寸兜底
  const safeW = Math.max(w, 320)
  const safeH = Math.max(h, 300)
  const padX = 12
  // 80 偏大，72 居中；对方与我方同尺寸
  const avatarBox = 72
  const stripH = 50
  const grow = Math.max(0, extraInput)
  const panelH = 50 + grow
  const scrollX = 0
  // 头图与聊天框之间留 6px 缝隙
  const scrollY = stripH + 6
  const scrollW = safeW
  // 延伸到视口底部，让 chat-frame 包住底部输入面板
  const detailH = safeH - scrollY
  const scrollH = Math.max(120, safeH - stripH - 6 - panelH)

  const otherAvatarX = padX
  const mineAvatarX = safeW - padX - avatarBox
  // 与桌面同语义：other 侧气泡左缘微压头像盒圆角外空白（视觉间距≈0）；mine 侧右缘贴紧头像盒
  const otherBubbleX = padX + avatarBox - 7.84
  const mineBubbleRight = mineAvatarX

  // 比桌面 660 紧凑：扣掉两侧头像与边距
  const bubbleMaxW = Math.max(140, scrollW - 130)
  const panelTop = safeH - panelH

  return {
    stripX: 0,
    stripY: 0,
    stripW: safeW,
    stripH,
    stripSegmented: true,
    stripImgH: 67,
    detailX: 0,
    detailY: scrollY,
    detailW: safeW,
    detailH,
    viewportH: safeH,
    scrollX,
    scrollY,
    scrollW,
    scrollH,
    // 首条头像顶固定 16（滚动相对由 useChatRows 转换）
    anchorAvatarTop: scrollY + 16,
    otherAvatarX,
    mineAvatarX,
    otherBubbleX,
    mineBubbleRight,
    avatarBox,
    avatarTopToBubble: avatarTopToBubble(avatarBox),
    gapSame: 12,
    gapCross: 26,
    gapSpeaker: 42,
    panelLeft: CHAT_FRAME.line,
    panelWidth: safeW - CHAT_FRAME.line * 2,
    panelHeight: panelH - CHAT_FRAME.line,
    panelTop,
    panelEdgeMaskH: 20,
    panelTopDecoW: safeW,
    panelTopDecoH: 16,
    bottomDecoX: (safeW - 219) / 2,
    bottomDecoY: (scrollY + scrollH) - 13 - 13,
    bottomDecoW: 219,
    bottomDecoH: 13,
    cornerDecoX: safeW - 150 - 12,
    cornerDecoY: 12,
    emptyTop: EMPTY_TOP,
    emptyBottom: EMPTY_BOTTOM,
    bubbleMaxW,
    bubbleInnerMaxW: bubbleMaxW - 10 * 2,
    endDecoW: 0,
    endDecoH: 0,
    endDecoGap: 16,
    scrollBottomPad: 48,
    dotsSize: CHAT_DOTS_SIZE,
    topicFontSize: 12,
    topicLineHeight: 18,
    // 窄屏内缩收一档
    centerTextPadX: 16,
    bubbleFontSize: 14,
    bubbleLineHeight: 20,
    bubblePadX: 10,
    bubblePadY: 7,
    bubbleMinW: 40,
    bubbleMinH: 34,
    bubbleRadius: 10,
    loadingRectW: 80,
    bubbleSingleLineH: 24 + 7 * 2,
  }
}

/** 默认值 = 全局响应式几何；ChatExportStage 覆盖为 DESKTOP_GEOM */
export const chatGeometryKey: InjectionKey<ComputedRef<ChatGeometry> | ChatGeometry> =
  Symbol('chatGeometry')

/**
 * DESKTOP_GEOM 是静态常量不能就地改，输入框增高量却是响应式的，故在此派生一份。
 * 底部装饰是设计稿固定坐标，不随面板变高移动。
 */
export function desktopGeometry(extraInput = 0): ChatGeometry {
  const grow = Math.max(0, extraInput)
  if (grow <= 0) return DESKTOP_GEOM
  return {
    ...DESKTOP_GEOM,
    panelHeight: DESKTOP_GEOM.panelHeight + grow,
    panelTop: DESKTOP_GEOM.panelTop - grow,
    scrollH: Math.max(120, DESKTOP_GEOM.scrollH - grow),
  }
}

export const globalChatGeometry = computed<ChatGeometry>(() => {
  const grow = extraInputH.value
  if (!isMobileView.value) return desktopGeometry(grow)
  // 用可视视口高度而非布局视口：iOS 软键盘弹出时 innerHeight 不变
  // 再用「聊天页可用高度」（扣掉状态栏 / 导航栏安全区）——
  // 边到边机型上输入面板因此落在系统导航栏上方，2026-11-08 真机修
  return mobileGeometry(viewportWidth.value, chatLayoutHeight.value, grow)
})
