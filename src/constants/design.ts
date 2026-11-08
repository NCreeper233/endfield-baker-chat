// design —— 设计稿坐标常量与头像几何计算
// 数值按原 SVG 设计稿测量（精度到小数点后两位），改动任意值都会造成像素级位移。

export const DESIGN_W = 1920
export const DESIGN_H = 1080

/** 聊天区核心坐标（px） */
export const CHAT = {
  /** 头像可见中线相对气泡顶部的偏移，用于气泡对齐头像嘴部 */
  bubbleOffset: 3,
  avatarBox: 98,
  anchorAvatarTop: 243.42,
  otherAvatarX: 554.48,
  mineAvatarX: 1746.4592,
  otherBubbleX: 644.64,
  mineBubbleRight: 1746.34,
} as const

/** 消息间距（px）：同方向连续 / 跨方向切换 / 同方向换说话人 */
export const CHAT_GAP = {
  same: 14,
  cross: 33,
  /**
   * 群聊换人：新头像要落在前一个头像（容器 98px）之下。
   * 间距 ≥ 98 - 单行气泡高 49.32 ≈ 48.7，取 60 留约 11px 余量。
   */
  speaker: 60,
} as const

/** 聊天滚动容器 */
export const CHAT_SCROLL = {
  x: 546.02,
  y: 188.84,
  w: 1312,
  h: 831,
} as const

/** 聊天条（strip）与详情容器（detail） */
export const CHAT_SHOTS = {
  strip: { x: 546.02, y: 114.44, w: 1323, h: 67.67 },
  detail: { x: 546.02, y: 188.84, w: 1323, h: 831 },
} as const

/**
 * 聊天框装饰（CSS 绘制，替代 chat_strip_detail.png）
 *
 * 框本体 = CHAT_SHOTS.detail 矩形；以下数值全部相对框右缘定位，1:1 照搬、不随框宽缩放。
 */
export const CHAT_FRAME = {
  line: 1.5,
  /** 顶部线右侧缺口 */
  gap: 264,
  /** 缺口内右端小段宽 */
  segW: 32,
  notchW: 232,
  notchH: 10,
  /** 三色条距框右缘 */
  barsRight: 44,
  barW: 64,
  barGap: 8,
  barH: 2,
  /** 描边色须内联到 SVG path，否则导出图片时 scoped 样式会丢失 */
  color: 'rgb(202, 201, 201)',
} as const

/** 聊天底部装饰，位于 .chat-area 内、固定贴画布右下区域 */
export const CHAT_BOTTOM_DECO = {
  x: 1092.52,
  y: 993.84,
  w: 219,
  h: 13,
} as const

/** 聊天末尾装饰，位于滚动内容末尾、相对滚动容器水平居中 */
export const CHAT_END_DECO = {
  w: 1252,
  h: 26,
  /** 装饰与其上方内容 / 与尾部留白的间距 */
  gap: 32,
  left: (CHAT_SCROLL.w - 1252) / 2,
} as const

/** 聊天滚动容器尾部留白 */
export const SCROLL_BOTTOM_PAD = 100

/** 尾部空间 = gap + 装饰高 + gap + 尾部留白；装饰未显示时仍按此预留滚动高度 */
export const TAIL_SPACE = CHAT_END_DECO.gap * 2 + CHAT_END_DECO.h + SCROLL_BOTTOM_PAD

/** 起始页 10×10 点阵图边长（越小点越密集） */
export const CHAT_DOTS_SIZE = 140

/** 图片消息显示上限：超限等比缩小，小图按原尺寸显示（不放大） */
export const CHAT_IMAGE = {
  w: 320,
  h: 240,
} as const

// 头像由 bg / portrait / ring 三层叠成，各层位置按 ring 圆环精确推导；
// 移动端传入更小的 avatarBox，三层按比例缩放以保持同构。

const RING_W = 76
const RING_H = 75.24
/** ring 内圆心（归一化，略偏右偏下）：ring 图不旋转，坐标对应翻转（1 - 原值） */
const RING_CX = 0.53
const RING_CY = 0.542
/** 肖像比圆环内孔小一圈，留出约一个环宽的空隙 */
const PORTRAIT_SCALE = 0.8

/** 随 avatarBox 等比缩放；桌面 98px 时与设计稿一致 */
function ringSize(avatarBox: number): { w: number; h: number } {
  return {
    w: (RING_W * avatarBox) / CHAT.avatarBox,
    h: (RING_H * avatarBox) / CHAT.avatarBox,
  }
}

/** 肖像在 avatarBox 内的可见顶部 y */
function portraitVisibleTop(avatarBox: number): number {
  const ring = ringSize(avatarBox)
  return (
    (avatarBox - ring.h) / 2 +
    ring.h * RING_CY -
    (ring.h * PORTRAIT_SCALE) / 2
  )
}

/** 头像顶部到气泡顶部的偏移；other / mine 当前同值，返回 Record 是为后续差异化铺路 */
export function avatarTopToBubble(avatarBox: number): Record<'other' | 'mine', number> {
  const offset = portraitVisibleTop(avatarBox) + CHAT.bubbleOffset
  return { other: offset, mine: offset }
}

/** 由头像容器顶部 y 推算气泡顶部 y */
export function avatarBubbleTop(
  avatarTop: number,
  side: 'other' | 'mine',
  avatarBox: number = CHAT.avatarBox,
): number {
  return avatarTop + avatarTopToBubble(avatarBox)[side]
}

interface RectSlot {
  x: number
  y: number
  w: number
  h: number
}

export interface AvatarStack {
  bg: RectSlot
  ring: RectSlot
  portrait: RectSlot
}

/** 计算头像三层槽位：桌面 avatarBox = 98，移动端更小 */
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
