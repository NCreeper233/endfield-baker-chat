// =============================================================================
// 底部面板共用几何(ChatInput / ChatArea)
// -----------------------------------------------------------------------------
// 三个模块此前各自硬编码同一套贴底公式与常量,收敛于此保证口径一致:
//   - 面板左/宽 = chat_strip_detail 左右各缩 2px
//   - 面板顶 = detail 底边 - 面板高 - 3px
//   - 顶部装饰图:距面板上端 5px,水平居中,悬浮于面板上边缘上方
//   - 面板上方遮罩横条:与面板同宽,底边贴面板上缘,向上延展 EDGE_MASK_H
// =============================================================================

import { CHAT_SHOTS } from './design'

/** 面板位置:左 = detail 左边界 + 2px,宽 = detail 宽 - 4px(左右各缩 2px) */
export const PANEL = {
  left: CHAT_SHOTS.detail.x + 2,
  width: CHAT_SHOTS.detail.w - 4,
} as const

/** 面板上方遮罩横条高度(px):消息贴近面板时渐隐的过渡带 */
export const PANEL_EDGE_MASK_H = 60
/** 顶部装饰图原始尺寸(px,用于绝对定位) */
export const PANEL_TOP_DECO_W = 1312
export const PANEL_TOP_DECO_H = 16

/**
 * 面板顶(px):detail 底边 - 面板高 - 3px(整体上移 3px)
 *
 * @param height 面板实际高度
 */
export function panelTop(height: number): number {
  return CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h - height - 3
}

/** 遮罩横条坐标:与面板同宽,底边对齐面板上边缘,向上延展 EDGE_MASK_H */
export const PANEL_EDGE_MASK = {
  left: PANEL.left,
  width: PANEL.width,
  height: PANEL_EDGE_MASK_H,
} as const

/** 顶部装饰图相对面板的偏移:距上端 5px,水平居中 */
export const PANEL_TOP_DECO_REL = {
  top: -PANEL_TOP_DECO_H - 5,
  left: (PANEL.width - PANEL_TOP_DECO_W) / 2,
} as const