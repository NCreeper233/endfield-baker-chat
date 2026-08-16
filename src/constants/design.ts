// =============================================================================
// 设计稿坐标常量与头像几何计算
// -----------------------------------------------------------------------------
// 所有数值来自原 SVG 设计稿测量,精度保留至小数点后两位。
// 修改任意值都会导致 UI 像素级位移,严禁随意调整。
// =============================================================================

/** 设计稿宽度(px) */
export const DESIGN_W = 1920
/** 设计稿高度(px) */
export const DESIGN_H = 1080

/**
 * 聊天区核心坐标
 *
 * 字段说明:
 * - `bubbleOffset`: 头像可见中线相对气泡顶部的偏移(用于气泡对齐头像嘴部)
 * - `avatarBox`: 头像容器尺寸(正方形)
 * - `anchorAvatarTop`: 首条消息头像顶部 y 坐标
 * - `otherAvatarX` / `mineAvatarX`: 左右两侧头像 x 坐标
 * - `otherBubbleX` / `mineBubbleRight`: 左侧气泡起点 x / 右侧气泡右边界 x
 */
export const CHAT = {
  bubbleOffset: 3,
  avatarBox: 98,
  anchorAvatarTop: 243.42,
  otherAvatarX: 554.48,
  mineAvatarX: 1746.4592,
  otherBubbleX: 644.64,
  mineBubbleRight: 1746.34,
} as const

/** 消息间距:同方向连续消息 / 跨方向切换 / 同方向换说话人(群聊) */
export const CHAT_GAP = {
  /** 同一说话人连续消息(头像堆叠,不重复显示) */
  same: 14,
  /** 跨方向切换(换侧接话) */
  cross: 33,
  /**
   * 同方向换说话人(群聊换人)
   *
   * 换人后新头像要落在前一个头像(容器 98px)之下,避免重叠:
   * 间距 ≥ 98 - 单行气泡高(49.32) ≈ 48.7,取 60 留 ~11px 余量。
   */
  speaker: 60,
} as const

/** 聊天滚动容器:位置 + 尺寸 */
export const CHAT_SCROLL = {
  x: 546.02,
  y: 188.84,
  w: 1312,
  h: 831,
} as const

/** 聊天条(strip)/ 详情容器(detail)位置 */
export const CHAT_SHOTS = {
  strip: { x: 546.02, y: 114.44, w: 1323, h: 67.67 },
  detail: { x: 546.02, y: 188.84, w: 1323, h: 831 },
} as const

/**
 * 聊天框装饰(CSS 绘制,替代 chat_strip_detail.png)
 *
 * 框本体 = CHAT_SHOTS.detail 矩形;以下数值全部相对框右缘定位,
 * 原值 1:1 照搬,不随框宽缩放。
 */
export const CHAT_FRAME = {
  /** 框线宽(px) */
  line: 1.5,
  /** 顶部线右侧缺口(px) */
  gap: 264,
  /** 缺口内右端小段宽(px) */
  segW: 32,
  /** SVG 凹口宽(px) */
  notchW: 232,
  /** SVG 凹口高(px) */
  notchH: 10,
  /** 三色条距框右缘(px) */
  barsRight: 44,
  /** 单条装饰条宽(px) */
  barW: 64,
  /** 装饰条间距(px) */
  barGap: 8,
  /** 装饰条高(px) */
  barH: 2,
  /** 框线 / 凹口折线描边颜色(内联到 SVG path,避免 scoped 样式在导出时丢失) */
  color: 'rgb(202, 201, 201)',
} as const

/**
 * 聊天底部装饰(原硬编码于 ChatArea.vue)
 *
 * 位置在 .chat-area(非 .chat-scroll)内,固定贴在画布右下区域。
 */
export const CHAT_BOTTOM_DECO = {
  x: 1092.52,
  y: 993.84,
  w: 219,
  h: 13,
} as const

/**
 * 聊天末尾装饰(原散落于 utils/chatPosition.ts,与 CHAT_BOTTOM_DECO 同类)
 *
 * 位置在 .chat-scroll 滚动内容末尾,水平相对滚动容器居中。
 */
export const CHAT_END_DECO = {
  /** 装饰图宽(px) */
  w: 1252,
  /** 装饰图高(px) */
  h: 26,
  /** 装饰与其上方内容 / 与尾部留白的间距(px) */
  gap: 32,
  /** 水平居中:相对滚动容器宽度求偏移 */
  left: (CHAT_SCROLL.w - 1252) / 2,
} as const

/** 聊天滚动容器尾部留白(px) */
export const SCROLL_BOTTOM_PAD = 100

/**
 * 聊天内容尾部空间(px):gap + 装饰高 + gap + 尾部留白
 *
 * 即使末尾装饰未显示,padTop 仍按此空间预留滚动高度。
 */
export const TAIL_SPACE = CHAT_END_DECO.gap * 2 + CHAT_END_DECO.h + SCROLL_BOTTOM_PAD

/** 起始页 10×10 点阵图尺寸(px,正方形;越小点越密集) */
export const CHAT_DOTS_SIZE = 140

/**
 * 图片消息显示上限(px)
 *
 * 纯图片消息(无气泡)按自然尺寸等比显示,超过上限时等比缩小,
 * 小图按原尺寸显示(不放大)。
 */
export const CHAT_IMAGE = {
  w: 320,
  h: 240,
} as const

// ---- 头像几何 -------------------------------------------------------------
// 头像由 bg/portrait/ring 三层组成,需精确计算各层位置以贴合 ring 圆环。
// 桌面端 avatarBox = 98(设计稿值);移动端传入更小的 avatarBox,
// ring/portrait 按比例推导,保持同构视觉。

const RING_W = 76
const RING_H = 75.24
// 圆环为细环(内孔直径约为环宽的 0.85),portrait 圆心与 ring 槽位中心重合:
// 两者都取 0.5,保证头像裁剪圆在 bg_snscharentry_head_Line.png 的正中间
const RING_CX = 0.47 // ring 内圆心 x(略偏左,让头像稍微靠左一点)
const RING_CY = 0.458 // ring 内圆心 y(略偏上,让头像稍微靠上一点)
// 头像肖像相对 ring 的缩放比:比圆环内孔小一圈(留出约一个环宽的空隙)
const PORTRAIT_SCALE = 0.8

/** ring 尺寸(随 avatarBox 等比缩放;桌面 98px 时与设计稿一致) */
function ringSize(avatarBox: number): { w: number; h: number } {
  return {
    w: (RING_W * avatarBox) / CHAT.avatarBox,
    h: (RING_H * avatarBox) / CHAT.avatarBox,
  }
}

/** 头像可见顶部(肖像在 avatarBox 内的可见顶部 y) */
function portraitVisibleTop(avatarBox: number): number {
  const ring = ringSize(avatarBox)
  return (
    (avatarBox - ring.h) / 2 +
    ring.h * RING_CY -
    (ring.h * PORTRAIT_SCALE) / 2
  )
}

/**
 * 头像顶部到气泡顶部的偏移(随 avatarBox 等比推导)
 *
 * other/mine 当前共用同一公式,返回 Record 是为后续差异化铺路。
 */
export function avatarTopToBubble(avatarBox: number): Record<'other' | 'mine', number> {
  const offset = portraitVisibleTop(avatarBox) + CHAT.bubbleOffset
  return { other: offset, mine: offset }
}

/** 桌面端头像→气泡偏移(98px 头像盒,与历史行为一致) */
export const AVATAR_TOP_TO_BUBBLE = avatarTopToBubble(CHAT.avatarBox)

/**
 * 由头像顶部 y 推算气泡顶部 y
 *
 * @param avatarTop  头像容器顶部 y
 * @param side       消息方向
 * @param avatarBox  头像盒尺寸(默认桌面 98)
 */
export function avatarBubbleTop(
  avatarTop: number,
  side: 'other' | 'mine',
  avatarBox: number = CHAT.avatarBox,
): number {
  return avatarTop + avatarTopToBubble(avatarBox)[side]
}

/** 矩形槽位(坐标 + 尺寸) */
interface RectSlot {
  x: number
  y: number
  w: number
  h: number
}

/** 头像三层(bg / portrait / ring)槽位计算结果 */
export interface AvatarStack {
  bg: RectSlot
  ring: RectSlot
  portrait: RectSlot
}

/**
 * 计算头像三层槽位(avatarBox 可参数化:桌面 98 / 移动端更小)
 *
 * @param baseX     头像容器左上 x
 * @param baseY     头像容器左上 y
 * @param avatarBox 头像容器边长(默认桌面 98)
 * @returns         bg / portrait / ring 三个矩形的绝对坐标
 */
export function avatarStack(
  baseX: number,
  baseY: number,
  avatarBox: number = CHAT.avatarBox,
): AvatarStack {
  const ring = ringSize(avatarBox)
  const bg: RectSlot = { x: baseX, y: baseY, w: avatarBox, h: avatarBox }
  const ringSlot: RectSlot = {
    x: baseX + (avatarBox - ring.w) / 2,
    y: baseY + (avatarBox - ring.h) / 2,
    w: ring.w,
    h: ring.h,
  }
  const pw = ring.w * PORTRAIT_SCALE
  const ph = ring.h * PORTRAIT_SCALE
  return {
    bg,
    ring: ringSlot,
    portrait: {
      x: ringSlot.x + ring.w * RING_CX - pw / 2,
      y: ringSlot.y + ring.h * RING_CY - ph / 2,
      w: pw,
      h: ph,
    },
  }
}
