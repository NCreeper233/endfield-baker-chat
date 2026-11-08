// useEmojiGrid —— 表情弹窗的网格几何（纯计算，不碰 DOM）
// 组件侧仍持有展开态与插入动作，这里只算「长什么样」。

import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { EMOJIS } from '../../constants/emoji'
import type { ChatGeometry } from '../../constants/chatGeometry'

export const POP_PAD = 24
/** 单格边长档位：宽版（桌面设计稿）/ 窄版（手机） */
export const POP_CELL_WIDE = 60
export const POP_CELL_NARROW = 36
export const POP_GAP_WIDE = 16
export const POP_GAP_NARROW = 10

/**
 * 宽版网格连同左右内边距所需的最小面板宽：1248 = 16×60 + 15×16 + 2×24
 *
 * 面板更窄却仍按 16 列排，1200px 宽的网格会撑出弹窗、被 overflow-x 裁掉两端。
 * 所以判据是「面板放不放得下」，不能写成「是不是手机」。
 */
export const POP_WIDE_MIN_W = 16 * POP_CELL_WIDE + 15 * POP_GAP_WIDE + POP_PAD * 2

/** 表情网格的几何与样式 */
export function useEmojiGrid(geom: ComputedRef<ChatGeometry>) {
  const isNarrowPop = computed(() => geom.value.panelWidth < POP_WIDE_MIN_W)

  const POP_CELL = computed(() => (isNarrowPop.value ? POP_CELL_NARROW : POP_CELL_WIDE))
  const POP_GAP = computed(() => (isNarrowPop.value ? POP_GAP_NARROW : POP_GAP_WIDE))

  /** 每行表情数：取「占宽 ≤ 可用宽度」的最大列数并封顶 16（桌面 16 列，竖屏约 7 列） */
  const POP_COLS = computed(() => {
    const usable = Math.max(0, geom.value.panelWidth - POP_PAD * 2)
    const unit = POP_CELL.value + POP_GAP.value
    const fit = Math.floor((usable + POP_GAP.value) / unit)
    return Math.max(1, Math.min(16, fit))
  })

  const POP_ROWS = computed(() => Math.ceil(EMOJIS.length / POP_COLS.value))

  /** 弹窗高度：上下边距 + 行×格高 + 行距，正好不出现滚动条 */
  const POP_H_EMOTICON = computed(
    () => POP_PAD * 2 + POP_ROWS.value * POP_CELL.value + (POP_ROWS.value - 1) * POP_GAP.value,
  )

  /** 紧贴面板顶边向上延伸，与面板同宽 */
  const emojiPopStyle = computed(() => ({
    left: '0px',
    top: `-${POP_H_EMOTICON.value}px`,
    width: `${geom.value.panelWidth}px`,
    height: `${POP_H_EMOTICON.value}px`,
  }))

  /** inline 覆盖 scoped CSS 的默认网格 */
  const emojiGridStyle = computed(() => ({
    gridTemplateColumns: `repeat(${POP_COLS.value}, ${POP_CELL.value}px)`,
    columnGap: `${POP_GAP.value}px`,
    rowGap: `${POP_GAP.value}px`,
  }))

  return {
    POP_PAD,
    POP_CELL_WIDE,
    POP_CELL_NARROW,
    POP_GAP_WIDE,
    POP_GAP_NARROW,
    POP_WIDE_MIN_W,
    isNarrowPop,
    POP_CELL,
    POP_GAP,
    POP_COLS,
    POP_ROWS,
    POP_H_EMOTICON,
    emojiPopStyle,
    emojiGridStyle,
  }
}
