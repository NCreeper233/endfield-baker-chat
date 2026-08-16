<script setup lang="ts">
// =============================================================================
// 加载气泡(AI 回复加载占位,从宽度 0 展开到 100)
// -----------------------------------------------------------------------------
// 结构:复用 ChatBubble 的 SVG 范式(rect + 尾巴 + foreignObject),
//   内文为三个方形 div 闪烁动画。
//
// 尺寸过渡设计:
//   - rect 几何尺寸固定 100×单行高,圆角 rx/ry 恒 13.65
//   - 展开用 clip-path: inset 裁剪动画(双 rAF:先 paint 全裁,再切到全显示)
//
// 为什么不用 width 过渡:
//   - SVG 会把 rx 钳制为 min(rx, width/2),宽度 < 27.3(2×rx)时圆角被压扁,
//     展开动画前段出现"直角条 → 圆角"的跳变(用户反馈的问题)
//   - clip-path 不改变几何宽度,任何时刻都是完整圆角的矩形被直线裁切揭示,
//     全程无直角
//   - other 侧尾巴在左,从左往右展开(裁右侧);mine 侧尾巴在右,从右往左展开(裁左侧)
// =============================================================================
import { computed, inject, onMounted, onUnmounted, ref, toValue } from 'vue'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { LOADING_DOT_COLOR_OTHER, LOADING_DOT_COLOR_MINE } from '../../constants/colors'
import { useBubbleSvgGeometry } from '../../composables/useBubbleSvgGeometry'
import type { MessageSide } from '../../types/chat'

const props = defineProps<{
  /** 加载气泡朝向,决定尾巴方向与配色(取下一条消息的 side) */
  side: MessageSide
  /** 气泡左上角 x(相对 .chat-scroll 内坐标) */
  left: number
  /** 气泡左上角 y(相对 .chat-scroll 内坐标) */
  top: number
}>()

/** 注入几何(加载气泡尺寸/圆角;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** rect 目标宽高(px):几何层提供(桌面 100×单行高,移动端更小) */
const RECT_W = computed(() => geom.value.loadingRectW)
const RECT_H = computed(() => geom.value.bubbleSingleLineH)

/** 尺寸过渡时长(ms),与 ChatBubble 一致 */
const TRANSITION_MS = 100

/**
 * 当前可见宽度(响应式,驱动 clip-path 裁切量;0→100)
 */
const curW = ref(0)

/**
 * 展开过渡期间的双层 rAF 句柄
 *
 * 保存到实例变量,组件卸载时统一 cancelAnimationFrame,
 * 避免已卸载组件的 curW 被回调写入。
 */
let raf1 = 0
let raf2 = 0

/**
 * 触发展开过渡:clip-path 从"全裁"切到"全显示"
 *
 * 双 rAF:先 paint 全裁状态,再切到全显示,触发 CSS transition
 */
function triggerExpand() {
  curW.value = 0
  if (raf1) cancelAnimationFrame(raf1)
  if (raf2) cancelAnimationFrame(raf2)
  raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(() => {
      curW.value = RECT_W.value
    })
  })
}

// 挂载时触发展开
onMounted(() => {
  triggerExpand()
})

// 卸载时清理未触发的 rAF,避免回调写入已卸载组件的 curW
onUnmounted(() => {
  if (raf1) cancelAnimationFrame(raf1)
  if (raf2) cancelAnimationFrame(raf2)
})

/**
 * clip-path 裁切量(px)
 *
 * - other 侧:裁右侧(inset 右值 RECT_W→0),从左往右展开
 * - mine 侧:裁左侧(inset 左值 RECT_W→0),从右往左展开
 * rect 几何宽度恒为 RECT_W,圆角不被 SVG 钳制,全程完整圆角
 */
const clipInset = computed(() => {
  const hidden = RECT_W.value - curW.value
  return props.side === 'other'
    ? `inset(0 ${hidden}px 0 0)`
    : `inset(0 0 0 ${hidden}px)`
})

/**
 * SVG 几何(与 ChatBubble 共用 useBubbleSvgGeometry):
 * 当前 svg 总宽(rect 恒为几何加载宽,故 svgW 恒定)、固定高、rect 固定 x、
 * 尾巴镜像、填充色。展开由 clip-path 驱动,几何尺寸不动。
 */
const { svgW, svgH, rectX, rectTransform, tailTransform, fillColor } =
  useBubbleSvgGeometry(
    computed(() => props.side),
    RECT_H,
    RECT_W,
  )

/** svg 尺寸固定真实值,不随过渡变化 */
const svgStyle = computed(() => ({
  left: `${props.left}px`,
  top: `${props.top}px`,
  width: `${svgW.value}px`,
  height: `${svgH.value}px`,
}))

/** 方形点颜色 */
const dotColor = computed(() =>
  props.side === 'mine' ? LOADING_DOT_COLOR_MINE : LOADING_DOT_COLOR_OTHER,
)

/** rect 样式:几何尺寸固定,clip-path 走 CSS transition(圆角恒定 13.65) */
const rectStyle = computed(() => ({
  clipPath: clipInset.value,
  transform: rectTransform.value,
  'transform-box': 'fill-box' as const,
  transition: `clip-path ${TRANSITION_MS}ms ease-out`,
}))

/** 尾巴样式:transform 恒定(CSS 形式,与 ChatBubble 同范式) */
const tailStyle = computed(() => ({
  transform: tailTransform.value,
  'transform-box': 'view-box' as const,
  'transform-origin': '0 0',
}))
</script>

<template>
  <svg
    class="loading-bubble"
    :class="`loading-bubble--${side}`"
    :style="svgStyle"
    xmlns="http://www.w3.org/2000/svg"
  >
    <!-- rect:几何尺寸固定(几何层加载宽×单行高),圆角恒为几何圆角;
         展开由 clip-path 揭示,任何时刻无直角 -->
    <rect
      :x="rectX"
      y="0"
      :width="RECT_W"
      :height="RECT_H"
      :rx="geom.bubbleRadius"
      :ry="geom.bubbleRadius"
      :fill="fillColor"
      :style="rectStyle"
    />
    <path
      d="M0,0s7.8,3.37,8.2,13.65S21.85,0,21.85,0H0Z"
      :style="tailStyle"
      :fill="fillColor"
    />
    <foreignObject :x="rectX" y="0" :width="RECT_W" :height="svgH">
      <!-- 三点与 rect 同步裁剪,避免展开前漂在矩形外 -->
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        class="loading-bubble__dots"
        :style="{ color: dotColor, clipPath: clipInset }"
      >
        <span class="loading-bubble__dot" />
        <span class="loading-bubble__dot" />
        <span class="loading-bubble__dot" />
      </div>
    </foreignObject>
  </svg>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.loading-bubble {
  position: absolute;
  display: block;
  // 与 ChatBubble 一致的气泡阴影观感
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));

  &__dots {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }

  // 三个方形点:纯透明度闪烁,通过 animation-delay 错开 0.2s
  &__dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    background: currentColor;
    animation: loading-dot 0.8s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.2s;
    }

    &:nth-child(3) {
      animation-delay: 0.4s;
    }
  }
}
</style>
