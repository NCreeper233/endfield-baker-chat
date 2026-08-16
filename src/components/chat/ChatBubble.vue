<script setup lang="ts">
// =============================================================================
// 聊天气泡(SVG 渲染,带尺寸过渡动画)
// -----------------------------------------------------------------------------
// 结构:
//   <svg>
//     <rect>          主体圆角矩形(width/height 走 CSS transition)
//     <path>          左侧尾巴(mine 侧通过 transform 镜像到右侧)
//     <foreignObject>  内嵌 HTML 文字(过渡完成后淡入)
//
// 尺寸过渡设计:
//   - rect 的 width/height 用 CSS transition 平滑过渡(非 transform: scale)
//   - 圆角 rx/ry 固定 13.65 不变,避免 scale 导致圆角变形
//   - 文字气泡从 prevRect(加载气泡尺寸 100×单行高)过渡到真实尺寸
//   - 过渡过半后文字 opacity 0→1 淡入
//
// 关键:svg 容器宽度跟随 rect 过渡(useBubbleSvgGeometry.svgW)
//   - svg overflow:hidden 会把超出容器的部分直线裁掉;若容器固定为最终宽度,
//     过渡起点(加载气泡 100 宽)会超界,被裁出"直角边",宽度缩回时才消失
//   - 容器随 curW 过渡后,rect 任何时刻都在 svg 内,裁切线贴着 rect 边缘,
//     全程完整圆角
//   - mine 侧右缘固定:left = props.left + (finalSvgW - svgW)(必为加号)
//     当前宽 < 最终宽 时左缘位于最终位右侧,过渡中向左滑回
// =============================================================================
import { computed, inject, onMounted, onUnmounted, ref, toValue, watch } from 'vue'
import { type BubbleBox, bubbleSvgWidth, BUBBLE_FONT } from '../../utils/measure'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { BUBBLE_TEXT_MINE, BUBBLE_TEXT_OTHER } from '../../constants/colors'
import { emojiToHtml } from '../../constants/emoji'
import { useBubbleSvgGeometry } from '../../composables/useBubbleSvgGeometry'
import type { MessageSide } from '../../types/chat'

const props = defineProps<{
  /** 消息文本(支持 \n 换行) */
  text?: string
  /**
   * 气泡尺寸测量结果(由父组件 ChatArea 统一 measure 后传入)
   *
   * ChatBubble 不再自己调用 measureBubble,避免重复的 ruler DOM 重排。
   */
  box: BubbleBox
  /** 发送方向,决定气泡朝向与配色 */
  side: MessageSide
  /** 气泡左上角 x(相对 .chat-scroll 内坐标) */
  left: number
  /** 气泡左上角 y(相对 .chat-scroll 内坐标) */
  top: number
  /**
   * 过渡起始尺寸(默认加载气泡尺寸 100×单行高)
   *
   * - AI 流式追加新消息:传入加载气泡尺寸,从该尺寸过渡到真实尺寸
   * - 切换对话首屏:不传,直接真实尺寸(整体走 chat-in 入场)
   */
  prevRect?: { w: number; h: number }
}>()

/** 注入几何(气泡字号/边距/圆角;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 当前 rect 尺寸(响应式,过渡用)
 *
 * - 初始:若有 prevRect 用 prevRect,否则用真实尺寸
 * - onMounted 后用双 rAF 切到真实尺寸,触发 CSS transition
 */
const curW = ref(props.prevRect ? props.prevRect.w : props.box.rectW)
const curH = ref(props.prevRect ? props.prevRect.h : props.box.rectH)

/** rect 实际渲染宽度(curW:走尺寸过渡) */
const rectW = computed(() => curW.value)
const rectH = computed(() => curH.value)

/** 文字是否可见(过渡过半后置 true) */
const textVisible = ref(!props.prevRect)

/** 尺寸过渡时长(ms),与 CSS transition 一致 */
const TRANSITION_MS = 100

/**
 * 过渡期间用到的 rAF / setTimeout 句柄
 *
 * triggerTransition 内的双层 rAF 与 setTimeout 句柄都保存到这里,
 * 组件卸载时统一清理,避免已卸载组件的 ref 被回调写入。
 */
let raf1 = 0
let raf2 = 0
let textTimer: number | null = null

/**
 * 触发尺寸过渡
 *
 * CSS transition 只在属性值"变化"时触发,不在元素首次渲染时触发。
 * 新挂载元素初始 width=prev,浏览器必须先 paint 这个初始值,
 * 再改变 width=real,transition 才会生效。
 *
 * 用双层 requestAnimationFrame:
 *   rAF1:浏览器准备 paint 初始尺寸
 *   rAF2:浏览器已 paint 初始尺寸,此时改 width=real,transition 触发
 */
function triggerTransition(prev: { w: number; h: number }) {
  curW.value = prev.w
  curH.value = prev.h
  textVisible.value = false
  // 清掉上一轮残留句柄(快速连续触发过渡时避免旧回调覆盖新值)
  if (raf1) cancelAnimationFrame(raf1)
  if (raf2) cancelAnimationFrame(raf2)
  if (textTimer !== null) clearTimeout(textTimer)
  raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(() => {
      curW.value = props.box.rectW
      curH.value = props.box.rectH
    })
  })
  // 过渡过半显示文字
  textTimer = window.setTimeout(() => {
    textVisible.value = true
    textTimer = null
  }, TRANSITION_MS / 2)
}

// 组件卸载时清理未触发的 rAF / setTimeout,避免回调写入已卸载组件的 ref
onUnmounted(() => {
  if (raf1) cancelAnimationFrame(raf1)
  if (raf2) cancelAnimationFrame(raf2)
  if (textTimer !== null) clearTimeout(textTimer)
})

// 挂载时:若有 prevRect,触发尺寸过渡
onMounted(() => {
  if (props.prevRect) {
    triggerTransition(props.prevRect)
  }
})

// prevRect 变化时:触发尺寸过渡(组件已挂载场景)
watch(
  () => props.prevRect,
  (prev) => {
    if (!prev) {
      curW.value = props.box.rectW
      curH.value = props.box.rectH
      textVisible.value = true
      return
    }
    triggerTransition(prev)
  },
)

/**
 * box 变化时(AI 流式文本增长)同步更新气泡尺寸
 *
 * curW/curH 不会自动跟随 box(仅 triggerTransition 会更新它们)。
 * AI 流式回复时每条 chunk 追加文本 → rows 重算 → box 尺寸变化,
 * 需要在此同步 curW/curH,否则气泡尺寸停留在初始值,文字溢出或格式错乱。
 * CSS transition(width/height)使尺寸变化平滑过渡(100ms)。
 */
watch(
  () => props.box.rectW,
  (w) => {
    curW.value = w
  },
)
watch(
  () => props.box.rectH,
  (h) => {
    curH.value = h
  },
)

/**
 * SVG 几何(与 LoadingBubble 共用 useBubbleSvgGeometry):
 * 当前 svg 总宽(随 rectW 过渡)、固定高、rect 固定 x、尾巴镜像、填充色。
 * rect 宽高过渡链(curW/rectW/rectH)仍在本组件内,组合只做纯几何推导。
 */
const { svgW, svgH, rectX, rectTransform, tailTransform, fillColor } =
  useBubbleSvgGeometry(
    computed(() => props.side),
    computed(() => props.box.rectH),
    rectW,
  )

/** 过渡完成后的 svg 总宽(用于 mine 侧左缘定位) */
const finalSvgW = computed(() => bubbleSvgWidth(props.box.rectW, props.side))

/**
 * svg 容器样式
 *
 * - 宽度跟随 rectW 过渡:rect 任何时刻都在 svg 内,不被 overflow:hidden
 *   直线裁切(不会出现"直角边")
 * - mine 侧右缘固定:left = props.left + (finalSvgW - svgW)
 *   右缘 = left + width = props.left + finalSvgW,任何时刻都锚定 mineBubbleRight,
 *   只让左缘随宽度过渡滑动(右缘不随宽度移动,无"弹跳")
 * - other 侧左缘固定,宽度向右伸缩
 */
const svgStyle = computed(() => ({
  left: props.side === 'mine'
    ? `${props.left + (finalSvgW.value - svgW.value)}px`
    : `${props.left}px`,
  top: `${props.top}px`,
  width: `${svgW.value}px`,
  height: `${svgH.value}px`,
  transition: `width ${TRANSITION_MS}ms ease-out, left ${TRANSITION_MS}ms ease-out`,
}))

/**
 * rect 样式
 *
 * width/height/transform 走 CSS transition(尺寸过渡)
 * 圆角 rx/ry 固定 13.65 不变,避免尺寸变化时圆角抽搐
 */
const rectStyle = computed(() => ({
  width: `${rectW.value}px`,
  height: `${rectH.value}px`,
  transform: rectTransform.value,
  'transform-box': 'fill-box' as const,
  transition: `width ${TRANSITION_MS}ms ease-out, height ${TRANSITION_MS}ms ease-out, transform ${TRANSITION_MS}ms ease-out`,
}))

/**
 * 尾巴样式(CSS transform,带过渡)
 *
 * 尾巴必须跟随 rect 右缘平滑移动,不能用 SVG 属性 transform:
 * 属性值瞬间跳变会让尾巴在过渡早期被更宽的 rect 盖住(同色不可见),
 * 直到过渡末段 rect 缩到位才重新露出("先矩形、再长出尾巴"缺陷)。
 * CSS 形式 + transition,尾巴从第一帧起就贴住 rect 右缘露出尖角,
 * 与 rect 右缘同步平滑移动。
 *
 * transform-box: view-box + transform-origin: 0 0 保证 CSS transform
 * 与 SVG 属性 transform 等价(以视口原点镜像),平移量为用户单位。
 */
const tailStyle = computed(() => ({
  transform: tailTransform.value,
  'transform-box': 'view-box' as const,
  'transform-origin': '0 0',
  transition: `transform ${TRANSITION_MS}ms ease-out`,
}))

/**
 * 内文样式:固定真实内宽/真实高度 + 文字淡入
 *
 * 过渡期间文字 opacity=0 不可见,foreignObject 尺寸用真实值无影响;
 * 过渡完成后 curW=realW,foreignObject 与 rect 对齐,文字淡入显示。
 *
 * 布局关键样式(display/font/white-space/word-break 等)全部写入 inline style:
 * html-to-image 对 SVG 根元素是深克隆(cloneNode(true)),不递归 cloneChildren,
 * scoped CSS 样式不会进入克隆的 SVG 子树。把布局样式放 inline style 后,
 * 深克隆天然复制,导出图与屏幕观感一致,无需事后内联计算样式。
 */
const textStyle = computed(() => ({
  display: 'flex',
  alignItems: 'center',
  fontFamily: BUBBLE_FONT,
  fontSize: `${geom.value.bubbleFontSize}px`,
  lineHeight: `${geom.value.bubbleLineHeight}px`,
  whiteSpace: 'pre-line',
  wordBreak: 'break-word' as const,
  userSelect: 'text' as const,
  width: `${props.box.innerW}px`,
  height: `${props.box.rectH}px`,
  justifyContent: props.side === 'mine' ? 'flex-end' : 'flex-start',
  color: props.side === 'mine' ? BUBBLE_TEXT_MINE : BUBBLE_TEXT_OTHER,
  // html-to-image 的 cloneCSSStyle 会把外层容器的 computed style
  // (含 -webkit-text-fill-color: rgb(0,0,0))内联到克隆节点。该属性通过 CSS 继承
  // 传递给 foreignObject 内的文字 div,且优先级高于 color,导致对方气泡白字变黑。
  // 显式内联 webkitTextFillColor 覆盖继承值,确保导出图文字颜色与屏幕一致。
  '-webkit-text-fill-color': props.side === 'mine' ? BUBBLE_TEXT_MINE : BUBBLE_TEXT_OTHER,
  opacity: textVisible.value ? 1 : 0,
  transition: `opacity ${TRANSITION_MS / 2}ms ease`,
}))
</script>

<template>
  <svg
    class="chat-bubble"
    :class="`chat-bubble--${side}`"
    :style="svgStyle"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect
      :x="rectX"
      y="0"
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
    <foreignObject :x="rectX + geom.bubblePadX" y="0" :width="box.innerW" :height="box.rectH">
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        class="chat-bubble__text"
        :style="textStyle"
        v-html="emojiToHtml(text ?? '')"
      ></div>
    </foreignObject>
  </svg>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.chat-bubble {
  position: absolute;
  display: block;
  // 气泡四周阴影:柔和扩散,与聊天框阴影统一观感
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));

  &__text {
    display: flex;
    align-items: center;
    font-family: $font-bubble;
    font-size: $font-size-bubble;
    line-height: 1.5;
    white-space: pre-line;
    word-break: break-word;
    user-select: text;
  }
}
</style>
