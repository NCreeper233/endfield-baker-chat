<script setup lang="ts">
// ChatBubble —— SVG 气泡（rect 主体 + 尾巴 path + foreignObject 文字）
// 尺寸过渡走 rect 的 width/height transition（不用 scale，圆角才不会变形）。
// ⚠️ svg 容器宽度必须随 rect 一起过渡：overflow:hidden 下容器若固定为最终宽度，
// 过渡起点（100 宽的加载气泡）会超界被裁成直角边。
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
  /**
   * 是否画选中描边(「导出选中消息」模式)
   *
   * 描的是**气泡自身的轮廓**:圆角矩形 + 尾巴各自用同一套几何描一遍,
   * 而不是套一个矩形框 —— 尾巴那段因此也在轮廓里。
   */
  picked?: boolean
}>()

/** 注入几何(气泡字号/边距/圆角;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/**
 * 内文 HTML(HTML 转义 + 表情 token → <img>)
 *
 * 必须走 computed:模板里直接调用 emojiToHtml(text) 会在**每次组件渲染**时
 * 重新做全量转义 + 正则替换(流式时每个 chunk 都要重算一遍整段文本)。
 * computed 只在 text 真正变化时重算,其余渲染(尺寸变化等)直接复用结果。
 */
const innerHtml = computed(() => emojiToHtml(props.text ?? ''))

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

/** 选中描边(「导出选中消息」模式):强调黄,沿气泡外轮廓 2px */
const PICK_COLOR = '#ffef00'
const PICK_W = 2

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
 * CSS transition 只在值变化时触发，所以要先用双层 rAF：第一帧让浏览器画出初始
 * width=prev，第二帧再改成 real，过渡才会生效。
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
 * 宽度随 rectW 过渡，rect 任何时刻都在 svg 内，overflow:hidden 不会裁出直角边。
 * mine 侧右缘固定：left 锚定最终右缘，再用 translateX(-当前宽) 把左缘推到位。
 */
const svgStyle = computed(() => {
  const mine = props.side === 'mine'
  return {
    // mine 侧把**最终右缘**作为 left 锚点,再用 translateX(-当前宽) 把整个 svg
    // 往左推:宽度过渡时右缘不动、左缘滑动,与原 left = props.left + (finalW - svgW)
    // 的坐标完全等价,但位置变化改由 transform 承担(合成器插值,不再每帧 layout)。
    // 注意 left 仍保留 —— 它是静态锚点(mineBubbleRight),不随宽度过渡变化。
    left: mine ? `${props.left + finalSvgW.value}px` : `${props.left}px`,
    top: `${props.top}px`,
    width: `${svgW.value}px`,
    height: `${svgH.value}px`,
    transform: mine ? `translateX(-${svgW.value}px)` : undefined,
    // width/height 必须保留过渡:圆角 rx/ry 固定,用 scale 代替会把圆角拉变形。
    // 只把位置从 left 换成 transform(见上),避免每帧为 left 重排版。
    transition: `width ${TRANSITION_MS}ms ease-out, transform ${TRANSITION_MS}ms ease-out`,
    // 选中描边画在形状**外侧**,默认的 overflow:hidden 会把它沿 svg 边缘切掉;
    // 只在选中时放开(此时没有尺寸过渡,不存在原注释里"过渡中被裁出直角边"的问题)
    overflow: props.picked ? 'visible' : 'hidden',
  }
})

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
 * 尾巴必须用 CSS transform：SVG 属性 transform 会瞬间跳变，过渡早期尾巴被更宽的
 * rect 盖住，直到末段才露出（「先矩形、再长出尾巴」）。transform-box: view-box +
 * transform-origin: 0 0 让 CSS 与 SVG 属性等价（以视口原点镜像）。
 */
const tailStyle = computed(() => ({
  transform: tailTransform.value,
  'transform-box': 'view-box' as const,
  'transform-origin': '0 0',
  transition: `transform ${TRANSITION_MS}ms ease-out`,
}))

/**
 * 内文：固定真实内宽/高 + 文字淡入。布局关键样式必须 inline ——
 * html-to-image 对 SVG 根是深克隆，scoped CSS 不会进入克隆子树，inline 才会被复制。
 */
/**
 * 外框：flex 垂直居中 + 文字淡入。⚠️ flex 里只能有一个子元素 ——
 * 文字直接挂在这里会让「文本 + <img> + 文本」变成多个 flex item，一段文字排成一列。
 */
const textStyle = computed(() => ({
  display: 'flex',
  alignItems: 'center',
  width: `${props.box.innerW}px`,
  height: `${props.box.rectH}px`,
  justifyContent: props.side === 'mine' ? 'flex-end' : 'flex-start',
  opacity: textVisible.value ? 1 : 0,
  transition: `opacity ${TRANSITION_MS / 2}ms ease`,
}))

/**
 * 文字块样式(真正的排版层)
 *
 * 布局关键样式(display/font/white-space/word-break 等)全部写入 inline style:
 * html-to-image 对 SVG 根元素是深克隆(cloneNode(true)),不递归 cloneChildren,
 * scoped CSS 样式不会进入克隆的 SVG 子树。把布局样式放 inline style 后,
 * 深克隆天然复制,导出图与屏幕观感一致,无需事后内联计算样式。
 */
const textInnerStyle = computed(() => ({
  display: 'block',
  width: '100%',
  fontFamily: BUBBLE_FONT,
  fontSize: `${geom.value.bubbleFontSize}px`,
  lineHeight: `${geom.value.bubbleLineHeight}px`,
  whiteSpace: 'pre-line',
  wordBreak: 'break-word' as const,
  userSelect: 'text' as const,
  // 玩家消息与对方一样**左对齐**。
  // 注意：这是 inline style —— 本组件用 <svg><foreignObject> 渲染，scoped CSS
  // 不会进入克隆子树，对齐必须内联，否则导出图与屏幕不一致。
  textAlign: 'left' as const,
  color: props.side === 'mine' ? BUBBLE_TEXT_MINE : BUBBLE_TEXT_OTHER,
  // html-to-image 的 cloneCSSStyle 会把外层容器的 computed style
  // (含 -webkit-text-fill-color: rgb(0,0,0))内联到克隆节点。该属性通过 CSS 继承
  // 传递给 foreignObject 内的文字 div,且优先级高于 color,导致对方气泡白字变黑。
  // 显式内联 webkitTextFillColor 覆盖继承值,确保导出图文字颜色与屏幕一致。
  '-webkit-text-fill-color': props.side === 'mine' ? BUBBLE_TEXT_MINE : BUBBLE_TEXT_OTHER,
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
    <!-- 选中描边:只描**并集的外轮廓**(含尾巴),不描内部接缝。
         做法(无需手写合并路径):
           ① 把同一组形状(圆角矩形 + 尾巴)整体外扩填成强调黄
           ② 再用气泡底色把并集的内部原样盖回来
         两层相减,剩下的正好是沿外轮廓的一圈;矩形左缘、尾巴直边这些
         "两图形相接处"都落在并集内部,被第②层盖掉,因此不会描到中间。 -->
    <template v-if="picked">
      <g :fill="PICK_COLOR" :stroke="PICK_COLOR" :stroke-width="PICK_W * 2">
        <rect
          :x="rectX"
          y="0"
          :rx="geom.bubbleRadius"
          :ry="geom.bubbleRadius"
          :style="rectStyle"
        />
        <path
          d="M0,0s7.8,3.37,8.2,13.65S21.85,0,21.85,0H0Z"
          :style="tailStyle"
        />
      </g>
      <g :fill="fillColor" :stroke="fillColor" stroke-width="0">
        <rect
          :x="rectX"
          y="0"
          :rx="geom.bubbleRadius"
          :ry="geom.bubbleRadius"
          :style="rectStyle"
        />
        <path
          d="M0,0s7.8,3.37,8.2,13.65S21.85,0,21.85,0H0Z"
          :style="tailStyle"
        />
      </g>
    </template>
    <foreignObject :x="rectX + geom.bubblePadX" y="0" :width="box.innerW" :height="box.rectH">
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        class="chat-bubble__text"
        :style="textStyle"
      >
        <!-- 真正的文字层:flex 容器只留这一个孩子,表情 <img> 在这里按内联流排版 -->
        <div class="chat-bubble__inner" :style="textInnerStyle" v-html="innerHtml"></div>
      </div>
    </foreignObject>
  </svg>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.chat-bubble {
  position: absolute;
  display: block;
  // 气泡四周阴影:柔和扩散,与聊天框阴影统一观感。
  //
  // 为什么不用 SVG <feDropShadow> 代替:
  //   ① 每个气泡 SVG 都需要自己的 <defs>+filter,filter id 必须唯一;而
  //      html-to-image 对 SVG 根是整棵深克隆,引用外部 defs 的写法在导出图里会丢;
  //   ② CSS drop-shadow 在 sRGB 下合成,feDropShadow 默认 linearRGB,阴影浓淡会变;
  //   ③ 滤镜区域随 width/height 每帧变化,换成 SVG filter 也省不掉这笔开销。
  // 位置动画已改为 transform(见 svgStyle),尺寸过渡期间这层小面积滤镜仍在重绘,
  // 但不再叠加 left 的逐帧排版。
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));

  &__text {
    // 注意:这里刻意不写 display/font/white-space —— 它们是排版关键样式,
    // 必须留在 inline style 里,否则 html-to-image 深克隆 SVG 时不会带上
    // (见脚本里 textInnerStyle 的注释)。
    box-sizing: border-box;
  }

  &__inner {
    // 同理,排版样式在 inline style;这里只留兜底
    box-sizing: border-box;
  }
}
</style>
