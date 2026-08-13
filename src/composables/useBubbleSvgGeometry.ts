// =============================================================================
// 气泡 SVG 几何(useBubbleSvgGeometry)
// -----------------------------------------------------------------------------
// ChatBubble / LoadingBubble 渲染同一套 SVG 范式(rect + 尾巴 + foreignObject),
// 其中与几何相关的推导完全一致,收敛于此:
//   - svgW:当前 SVG 总宽 = 尾巴偏移 + 当前 rect 宽(+ mine 侧再补一个尾巴偏移)
//     随 curW 变化:容器跟随过渡尺寸,rect 永不超出 svg 边界
//     (svg overflow:hidden 不会把超出部分直线裁掉,避免过渡中出现"直角边")
//   - svgH:真实 SVG 总高 = rect 高(固定,不随过渡变化)
//   - rectX:rect 固定 x = 尾巴偏移
//   - rectTransform:恒 none。svg 宽跟随 curW 时,rect 右缘天然贴住
//     svg 右缘 - 尾巴区(OVER),mine 侧不再需要 translateX 平移
//   - tailTransform:mine 侧尾巴镜像到右侧(平移量跟随当前 svg 宽)
//   - fillColor:气泡填充色(mine / other 各一色)
//
// 签名说明:curW 为"当前 rect 宽"(尺寸过渡中可变)。
// 两组件各自保留过渡状态(curW 与双 rAF),本组合只提供纯几何推导。
// =============================================================================
import { computed, isRef, ref } from 'vue'
import type { MaybeRef } from 'vue'
import { BUBBLE_TAIL_OFFSET, bubbleSvgWidth } from '../utils/measure'
import { BUBBLE_FILL_MINE, BUBBLE_FILL_OTHER } from '../constants/colors'
import type { MessageSide } from '../types/chat'

/** 把数值或 ref 统一归一化为 ref(供 computed 追踪) */
function toRefValue(v: MaybeRef<number>): { value: number } {
  return isRef(v) ? v : ref(v)
}

export function useBubbleSvgGeometry(
  /** 发送方向,决定尾巴方向与配色 */
  side: MaybeRef<MessageSide>,
  /** 真实 rect 高(px,SVG 总高固定用此值) */
  realH: MaybeRef<number>,
  /** 当前 rect 宽(px,尺寸过渡中可变) */
  curW: MaybeRef<number>,
) {
  const sideRef = isRef(side) ? side : ref(side)
  const realHRef = toRefValue(realH)
  const curWRef = toRefValue(curW)

  /** 尾巴偏移 */
  const OVER = BUBBLE_TAIL_OFFSET

  /**
   * 当前 SVG 总宽(随 curW 变化)
   *
   * 容器跟随过渡尺寸:rect 右缘 = svgW - OVER(mine 另有右侧尾巴区),
   * 任何时刻 rect 都在 svg 内,不会被 overflow:hidden 直线裁切出直角边。
   */
  const svgW = computed(() => bubbleSvgWidth(curWRef.value, sideRef.value))
  /** SVG 总高 = 真实 rect 高(固定) */
  const svgH = computed(() => realHRef.value)

  /** rect x 坐标(固定 OVER,不随过渡平移) */
  const rectX = OVER

  /** rect 变换:恒 none(见文件头注释) */
  const rectTransform = computed(() => undefined)

  /**
   * 尾巴 transform(CSS 形式,供 path 的 style 绑定)
   *
   * mine 侧镜像到右侧:平移量跟随当前 svg 宽,尾巴任何时刻都贴住
   * rect 右缘(svgW - OVER)并露出 OVER 尖角。必须用 CSS 形式(带 px 单位),
   * 配合组件的 transform-box: view-box + transform-origin: 0 0 走 CSS transition,
   * 过渡期间尾巴随 rect 右缘平滑移动;
   * 若用 SVG 属性 transform(无过渡),值会瞬间跳到最终位置,
   * 尾巴在过渡早期被 rect 盖住/超界裁剪,末段才露出("先矩形后尾巴"缺陷)。
   * other 侧无需变换(尾巴固定于 svg 左侧,天然全程可见)。
   */
  const tailTransform = computed(() =>
    sideRef.value === 'mine'
      ? `translate(${svgW.value}px, 0px) scale(-1, 1)`
      : undefined,
  )

  /** 气泡填充色 */
  const fillColor = computed(() =>
    sideRef.value === 'mine' ? BUBBLE_FILL_MINE : BUBBLE_FILL_OTHER,
  )

  return { svgW, svgH, rectX, rectTransform, tailTransform, fillColor }
}
