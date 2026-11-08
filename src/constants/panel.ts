// panel —— 底部面板共用几何（ChatInput / ChatArea）

import { CHAT_SHOTS } from './design'

/** detail 区域左右各内缩 2px，避免与边框重叠 */
export const PANEL = {
  left: CHAT_SHOTS.detail.x + 2,
  width: CHAT_SHOTS.detail.w - 4,
} as const

/** 上缘渐隐过渡带高度（px）：消息贴近面板时淡出 */
export const PANEL_EDGE_MASK_H = 60

/** 顶部装饰图原始尺寸（px） */
export const PANEL_TOP_DECO_W = 1312
export const PANEL_TOP_DECO_H = 16

/** 面板顶 = detail 底边 - 面板高 - 3px */
export function panelTop(height: number): number {
  return CHAT_SHOTS.detail.y + CHAT_SHOTS.detail.h - height - 3
}

/** 装饰图相对面板：距上端 5px，水平居中 */
export const PANEL_TOP_DECO_REL = {
  top: -PANEL_TOP_DECO_H - 5,
  left: (PANEL.width - PANEL_TOP_DECO_W) / 2,
} as const
