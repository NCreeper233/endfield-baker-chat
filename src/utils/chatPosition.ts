// =============================================================================
// 聊天区绝对定位工具
// -----------------------------------------------------------------------------
// 纯函数 + 常量,无任何状态:
//  - pos():生成 { left/top/width/height } 样式对象(所有模板定位共用)
//  - speakerNameStyle():角色名称悬浮(带头像消息的气泡上方)【已注释停用】
// 供 ChatArea.vue / ChatMessageRow.vue 共享,避免组件内重复定义。
// 聊天布局常量(末尾装饰 / 尾部留白)收敛于 constants/design.ts。
// =============================================================================

import type { CSSProperties } from 'vue'

/**
 * 绝对定位盒的 style 对象
 *
 * 兼容 Vue 模板 :style 的 StyleValue 类型约束。
 */
export type BoxStyle = CSSProperties

/**
 * 生成绝对定位盒的 style 对象
 *
 * @param x  left
 * @param y  top
 * @param w  width
 * @param h  height
 */
export function pos(x: number, y: number, w: number, h: number): BoxStyle {
  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}

// ---- 角色名称悬浮(带头像消息的气泡上方)---------------------------------------
// 【已注释停用】角色名称显示功能整体停用,以下常量与函数一并注释保留,便于日后恢复。
// /** 名称行高(px,须与 .chat-speaker-name 的 font-size/line-height 一致) */
// export const SPEAKER_NAME_LINE = 15
// /** 名称下方留白(px):名称底边与气泡顶部的间距 */
// export const SPEAKER_NAME_GAP = 2
// /** 名称额外上移量(px):在气泡上方空隙内再抬高,视觉居中于空隙 */
// export const SPEAKER_NAME_LIFT = 7
// /** 我方名称向头像方向水平偏移(px):mine 侧名称右缘锚定气泡右缘后,再向右侧(头像侧)平移 */
// export const SPEAKER_NAME_MINE_AVATAR_OFFSET = 15
//
// /**
//  * 角色名称悬浮样式:锚定在气泡上缘上方、贴气泡侧缘,悬浮于消息间空隙
//  *
//  * 名称不占布局(absolute),靠每行带头像前的间距(跨方向 33 / 换人 60)容纳,
//  * 故无需改动布局常量。方向锚定跟随气泡:
//  * - other:左缘起向右排(left)
//  * - mine:右缘起向左排(text-align:right + translateX(-100%)),并再向头像侧平移 15px
//  *
//  * @param side         消息方向
//  * @param bubbleLeft   气泡盒左缘(滚动坐标)
//  * @param bubbleRight  气泡盒右缘(滚动坐标)
//  * @param bubbleTop    气泡盒顶部(滚动坐标)
//  */
// export function speakerNameStyle(
//   side: 'other' | 'mine',
//   bubbleLeft: number,
//   bubbleRight: number,
//   bubbleTop: number,
// ): BoxStyle {
//   const left = side === 'other' ? bubbleLeft : bubbleRight + SPEAKER_NAME_MINE_AVATAR_OFFSET
//   return {
//     left: `${left}px`,
//     top: `${bubbleTop - SPEAKER_NAME_LINE - SPEAKER_NAME_GAP - SPEAKER_NAME_LIFT}px`,
//     transform: side === 'other' ? 'none' : 'translateX(-100%)',
//     textAlign: side === 'other' ? 'left' : 'right',
//   }
// }