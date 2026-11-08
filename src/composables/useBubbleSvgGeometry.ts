// useBubbleSvgGeometry —— 气泡 SVG 的纯几何推导
// ChatBubble 与 LoadingBubble 用同一套 rect + 尾巴 + foreignObject，几何必须一致。
// 两组件各自保留过渡状态（curW 与双 rAF），这里只算尺寸。

import { computed, isRef, ref } from 'vue'
import type { MaybeRef } from 'vue'
import { BUBBLE_TAIL_OFFSET, bubbleSvgWidth } from '../utils/measure'
import { BUBBLE_FILL_MINE, BUBBLE_FILL_OTHER } from '../constants/colors'
import type { MessageSide } from '../types/chat'

/** 数值或 ref 统一成 ref，供 computed 追踪 */
function toRefValue(v: MaybeRef<number>): { value: number } {
  return isRef(v) ? v : ref(v)
}

export function useBubbleSvgGeometry(
  side: MaybeRef<MessageSide>,
  /** 真实 rect 高：SVG 总高固定用它 */
  realH: MaybeRef<number>,
  /** 当前 rect 宽：尺寸过渡中可变 */
  curW: MaybeRef<number>,
) {
  const sideRef = isRef(side) ? side : ref(side)
  const realHRef = toRefValue(realH)
  const curWRef = toRefValue(curW)

  const OVER = BUBBLE_TAIL_OFFSET

  /** SVG 总宽随 curW 变化，rect 任何时刻都在 svg 内，不会溢出被裁出直角边 */
  const svgW = computed(() => bubbleSvgWidth(curWRef.value, sideRef.value))
  const svgH = computed(() => realHRef.value)

  const rectX = OVER

  const rectTransform = computed(() => undefined)

  /**
   * 尾巴位移（CSS 形式，带 px）
   *
   * 必须走 CSS 而不是 SVG 属性 transform：后者不参与过渡，值会瞬间跳到终点，
   * 过渡早期尾巴被 rect 盖住，末段才露出。配合组件的 transform-box: view-box
   * + transform-origin: 0 0，尾巴才能贴着 rect 右缘平滑移动。
   */
  const tailTransform = computed(() =>
    sideRef.value === 'mine'
      ? `translate(${svgW.value}px, 0px) scale(-1, 1)`
      : undefined,
  )

  const fillColor = computed(() =>
    sideRef.value === 'mine' ? BUBBLE_FILL_MINE : BUBBLE_FILL_OTHER,
  )

  return { svgW, svgH, rectX, rectTransform, tailTransform, fillColor }
}
