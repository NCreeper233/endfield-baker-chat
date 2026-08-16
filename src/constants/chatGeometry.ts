// =============================================================================
// 聊天区几何层(chatGeometry)
// -----------------------------------------------------------------------------
// 所有聊天区布局数值的唯一出口,替代各组件里对 design.ts / panel.ts 常量的
// 直接引用:
//   - DESKTOP_GEOM:桌面端几何(数值与 design.ts / panel.ts 现有常量完全一致)
//   - mobileGeometry(w, h):移动端按视口推导(字号不变、气泡按视口宽度换行)
//   - chatGeometryKey:provide/inject 键,默认值 = 全局响应式几何
//     (ChatExportStage 注入 DESKTOP_GEOM,保证手机端导出仍按设计稿布局)
//   - globalChatGeometry:由 useMobile 驱动的全局响应式几何
//
// 布局管线消费方:useChatRows / ChatArea / ChatMessageRow / ChatInput /
// PanelShell / PanelTopMask,全部改为 inject 几何。
// =============================================================================

import { computed, type ComputedRef, type InjectionKey } from 'vue'
import {
  isMobileView,
  viewportHeight,
  viewportWidth,
} from '../composables/useMobile'
import {
  CHAT,
  CHAT_BOTTOM_DECO,
  CHAT_DOTS_SIZE,
  CHAT_END_DECO,
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

/** 聊天区几何(全部为"画布坐标",行级布局由 useChatRows 内部转滚动相对) */
export interface ChatGeometry {
  // 顶部聊天条(strip)
  stripX: number
  stripY: number
  stripW: number
  stripH: number
  /** 头图是否分段渲染(移动端 true:左右段素材 l/r 拼接;桌面 false:单图原样) */
  stripSegmented: boolean
  /** 头图原图高度(px,chat_strip_v*_l/r.png 均为 66 高) */
  stripImgH: number
  // 聊天框(detail/frame)
  detailX: number
  detailY: number
  detailW: number
  detailH: number
  // 滚动容器
  scrollX: number
  scrollY: number
  scrollW: number
  scrollH: number
  // 消息锚点(画布坐标)
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
  // 起始页(empty)区域(移动端不渲染,沿用桌面值)
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
  bubbleFontSize: number
  bubbleLineHeight: number
  bubblePadX: number
  bubblePadY: number
  bubbleMinW: number
  bubbleMinH: number
  /** 气泡圆角(px,rect rx/ry) */
  bubbleRadius: number
  /** 加载气泡 rect 宽(px) */
  loadingRectW: number
  /** 单行气泡高(px)= 行高 + 上下 padding */
  bubbleSingleLineH: number
}

/** 起始页区域顶(顶端对齐第一张一级卡片顶端) */
const EMPTY_TOP = CHARACTER_LIST_TOP + TOP_PAD
/** 起始页区域底(与 chat_strip_detail 底边相同) */
const EMPTY_BOTTOM = CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h

/**
 * 桌面端几何:直接映射 design.ts / panel.ts 现有常量,数值零变化。
 */
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
  // 桌面 corner-deco 原 CSS:right: calc(100% - 1769.02px) + width 150px,
  // 容器 0 宽 → left = 1619.02,top 139.44
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
 * 移动端几何:按视口推导。
 *
 * 布局规则(竖屏 375×667 示例):
 *   上下结构:strip(头图,占位高) → 滚动区(消息) → 底部输入面板
 *   消息区:左右边距 + 头像(56px) + 头像→气泡间距;气泡按视口宽度流式换行
 *   气泡字号 16px(桌面 20.88),整体比桌面紧凑;头像保留可辨识尺寸
 *
 * @param w 视口宽
 * @param h 视口高
 */
export function mobileGeometry(w: number, h: number): ChatGeometry {
  // 视口尺寸兜底:键盘过渡等场景传入的 w/h 可能瞬时异常(0/极小),
  // 用最小可用尺寸保证布局不塌缩(头图缩放系数/锚点/面板始终在可视区域内)。
  const safeW = Math.max(w, 320)
  const safeH = Math.max(h, 300)
  const padX = 12 // 消息区左右边距
  const avatarBox = 72 // 移动端头像盒(80 偏大,72 居中;我方/对方一致)
  const stripImgH = 66 // 头图 l/r 素材高度(px,各变体一致)
  // 左右段素材原宽合计(各变体:25+440 / 19+458 / 21+451,取最大值保证任意变体可完整放下)
  const STRIP_SEGS_MAX_TOTAL_W = 477
  // 左右段优先完整等比放下:k = min(1, 视口宽 / 左右段最大总宽)
  const stripK = Math.min(1, safeW / STRIP_SEGS_MAX_TOTAL_W)
  const stripH = stripImgH * stripK // 头图占位高(左右段等比)
  const panelH = 56 // 底部输入面板高
  const scrollX = 0
  // 头部与聊天框之间留 6px 缝隙:滚动区整体下移 6px,高度相应减 6px
  const scrollY = stripH + 6
  const scrollW = safeW
  const scrollH = Math.max(120, safeH - stripH - 6 - panelH)

  const otherAvatarX = padX
  const mineAvatarX = safeW - padX - avatarBox
  // 与桌面几何同语义:
  // - other 侧气泡左缘 = 头像盒右缘 - 7.84(微压圆形头像盒的圆角外空白,视觉间距≈0)
  // - mine 侧气泡右缘 = 头像盒左缘(贴紧,与桌面 mineBubbleRight≈mineAvatarX 一致)
  const otherBubbleX = padX + avatarBox - 7.84
  const mineBubbleRight = mineAvatarX

  // 气泡最大宽:两侧(头像 + 边距 + 尾巴)余量,比桌面紧凑(桌面 660)
  const bubbleMaxW = Math.max(140, scrollW - 130)
  // 面板贴底(基于 safeH,异常高度时也不会跑到屏幕外)
  const panelTop = safeH - panelH

  return {
    stripX: 0,
    stripY: 0,
    stripW: safeW,
    stripH,
    stripSegmented: true,
    stripImgH,
    detailX: 0,
    detailY: scrollY,
    detailW: safeW,
    detailH: scrollH,
    scrollX,
    scrollY,
    scrollW,
    scrollH,
    anchorAvatarTop: scrollY + 16, // 滚动区内首条头像顶 = 16(滚动相对由 useChatRows 转换)
    otherAvatarX,
    mineAvatarX,
    otherBubbleX,
    mineBubbleRight,
    avatarBox,
    avatarTopToBubble: avatarTopToBubble(avatarBox),
    gapSame: 12,
    gapCross: 26,
    gapSpeaker: 42,
    panelLeft: 0,
    panelWidth: safeW,
    panelHeight: panelH,
    panelTop,
    panelEdgeMaskH: 40,
    panelTopDecoW: safeW,
    panelTopDecoH: 16,
    // 底部装饰:底边距 detail 底 13px(与桌面语义一致)
    bottomDecoX: (safeW - 219) / 2,
    bottomDecoY: (scrollY + scrollH) - 13 - 13,
    bottomDecoW: 219,
    bottomDecoH: 13,
    // 角落装饰:strip 右上角
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
    // 移动端气泡:字号 16 / 行高 24 / 边距 10×7 / 最小 40×34 / 圆角 10 / 加载气泡 80 宽
    bubbleFontSize: 16,
    bubbleLineHeight: 24,
    bubblePadX: 10,
    bubblePadY: 7,
    bubbleMinW: 40,
    bubbleMinH: 34,
    bubbleRadius: 10,
    loadingRectW: 80,
    bubbleSingleLineH: 24 + 7 * 2,
  }
}

/** 几何注入键:默认值 = 全局响应式几何;ChatExportStage 覆盖为 DESKTOP_GEOM */
export const chatGeometryKey: InjectionKey<ComputedRef<ChatGeometry> | ChatGeometry> =
  Symbol('chatGeometry')

/** 全局响应式几何(useMobile 模块级 refs 驱动:移动端 → 移动几何,桌面 → 桌面几何) */
export const globalChatGeometry = computed<ChatGeometry>(() =>
  isMobileView.value
    ? mobileGeometry(viewportWidth.value, viewportHeight.value)
    : DESKTOP_GEOM,
)
