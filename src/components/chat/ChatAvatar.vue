<script setup lang="ts">
// =============================================================================
// 聊天头像(bg + portrait + ring 三层)
// -----------------------------------------------------------------------------
// 独立组件,接收 side/stack/baseX/baseY,内部计算 img 相对偏移,
// 与消息循环解耦。
//
// 容器位置与尺寸(left/top/width/height)由父组件通过 :style fallthrough 设置
// (依赖 row 数据,ChatArea 计算)。
// =============================================================================
import { computed, inject, toValue } from 'vue'
import { MATERIALS } from '../../constants/materials'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import type { AvatarStack } from '../../constants/design'

const props = defineProps<{
  /** 头像三层槽位(绝对坐标,由 avatarStack 计算) */
  stack: AvatarStack
  /** 头像容器左上 x(绝对坐标,用于换算 img 相对偏移) */
  baseX: number
  /** 头像容器左上 y(绝对坐标,用于换算 img 相对偏移) */
  baseY: number
  /**
   * portrait 头像 URL(本地资源)
   *
   * 由父组件按 side 与当前对话派生传入:
   *   - other : 当前对话对方干员的头像 URL(来自 character.ts,本地托管)
   *   - mine  : 我方默认头像 URL
   */
  portraitUrl: string
}>()

/** 圆形头像(portrait)相对容器/头像框的 x 位移(仅移动圆形头像,不动头像框与背景) */
const PORTRAIT_X_ADJ = 1

/**
 * 头像圆心(相对头像容器坐标)
 *
 * 这是整个头像的基准点:白框(含阴影)、底图都以它为准 ——
 * 必须带上 PORTRAIT_X_ADJ,因为 portraitStyle 把头像整体右移了 1px 做视觉微调,
 * 沿用未偏移的 stack.portrait.x 会让其它层与头像错开 1px。
 */
const avatarCenter = computed(() => {
  const p = props.stack.portrait
  return {
    cx: p.x - props.baseX + PORTRAIT_X_ADJ + p.w / 2,
    cy: p.y - props.baseY + p.h / 2,
  }
})

/**
 * bg 层样式:以**头像圆心**为基准绝对居中(不再贴容器左上角)
 *
 * 容器(avatarBox)与头像圆心并不重合 —— 圆心相对容器中心偏右下约 3px,
 * 贴容器排版会让底图与头像/白框整体错开。尺寸仍取 bg 槽位原值,只改定位。
 */
const bgStyle = computed(() => {
  const { cx, cy } = avatarCenter.value
  const b = props.stack.bg
  return {
    left: `${cx - b.w / 2}px`,
    top: `${cy - b.h / 2}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  }
})

/** portrait 层样式:相对容器偏移 = 绝对坐标 - baseX/baseY
 *
 * left 再叠加 PORTRAIT_X_ADJ:圆形头像相对头像框/背景左移 2px(视觉微调,非裁剪位置)
 * top:头像框在聊天区域整体垂直对齐(视觉微调,非裁剪位置) */
const portraitStyle = computed(() => ({
  left: `${props.stack.portrait.x - props.baseX + PORTRAIT_X_ADJ}px`,
  top: `${props.stack.portrait.y - props.baseY}px`,
  width: `${props.stack.portrait.w}px`,
  height: `${props.stack.portrait.h}px`,
}))

// ---- 头像框(圆环)与阴影:自绘、两个独立元素 ---------------------------------
//
// 原 bg_snscharentry_head_Line.webp 已弃用。几何**完全由头像反推**,头像自身的
// 大小与位置一律不动(仍取 stack.portrait 原值):
//   - 白框与头像同心:描边中线椭圆的圆心 = 头像椭圆的圆心
//   - 内缘距头像 ringGap:中线半径 = 头像半径 + ringGap + 描边宽 / 2
//   - 描边粗细 = ringStroke(按成品显示尺寸给的 px,不再走 89 单位那套缩放值;
//                            桌面 2px / 移动端 1px)
//
// 白框与阴影刻意拆成**两个元素**(而非同一个 svg 里的两个图形):
// 白框元素的盒子正好贴住描边外缘,于是"盒子中心 = 白框中心",居中与否可以直接
// 用元素盒子核对,不必再从"盒子 = 白框 + 阴影留白"里去推断。
// 两边的 viewBox 都与各自盒子 1:1(单位都是 px),故 stroke-width 即成品像素值。

/**
 * 注入几何:只用来判断"是不是移动端"
 *
 * 判据与 ChatInput / ChoicePanel / GroupFlowControl 一致(几何层 stripSegmented),
 * 不另用视口宽度 —— 两套判据在临界宽度下会打架。
 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/**
 * 头像框描边宽度(px,成品显示尺寸)
 *
 * 移动端刻意细一档:小尺寸头像上 2px 描边显得笨重,1px 更精神。
 * 桌面端保持 2px(视觉粗细是按桌面尺寸定的)。
 */
const ringStroke = computed(() => (geom.value.stripSegmented ? 1 : 2))

/**
 * 头像边缘与圆环内缘之间的间隙(px)
 *
 * 移动端再收紧 1px:头像本身更小,同样的 4px 看上去框离人太远。
 */
const ringGap = computed(() => (geom.value.stripSegmented ? 3 : 4))

/** 左上角黑色阴影:向左上偏移(px)、不透明度、模糊半径(px) */
const RING_SHADOW_OFFSET = 2
const RING_SHADOW_OPACITY = 0.55
const RING_SHADOW_BLUR = 2.5

/**
 * 三段等分圆弧:每段 104°、缺口 16°;缺口中心彼此相隔 120°
 *
 * 角度约定:0° 指向右(+x)、90° 向下(+y)—— 即屏幕坐标。
 * 取 30° / 150° / 270°,使**正上方(270°)正中有一个缺口**。
 */
const RING_GAP_CENTERS = [30, 150, 270]
const RING_GAP_HALF = 8

/**
 * 白框几何
 *
 * 头像槽位是 60.8 × 60.19(并非严格正方),所以按**椭圆**处理 ——
 * 这样"四周间隙都为 ringGap"才严格成立。
 * boxW / boxH 是描边的**外接**尺寸(不含阴影),其中心即白框中心。
 */
const ringShape = computed(() => {
  const p = props.stack.portrait
  const rx = p.w / 2
  const ry = p.h / 2
  // 圆心与底图共用同一个基准点(见 avatarCenter)
  const { cx, cy } = avatarCenter.value
  const rxMid = rx + ringGap.value + ringStroke.value / 2
  const ryMid = ry + ringGap.value + ringStroke.value / 2
  return {
    cx,
    cy,
    rxMid,
    ryMid,
    boxW: 2 * (rxMid + ringStroke.value / 2),
    boxH: 2 * (ryMid + ringStroke.value / 2),
  }
})

/** 三段圆弧的 path:用椭圆参数方程取端点,弧命令的 rx/ry 即中线半径 */
const ringPaths = computed(() => {
  const s = ringShape.value
  const lcx = s.boxW / 2
  const lcy = s.boxH / 2
  const pt = (deg: number) => {
    const t = (deg * Math.PI) / 180
    const x = (lcx + s.rxMid * Math.cos(t)).toFixed(2)
    const y = (lcy + s.ryMid * Math.sin(t)).toFixed(2)
    return `${x} ${y}`
  }
  return RING_GAP_CENTERS.map(
    (c) =>
      `M${pt(c + RING_GAP_HALF)}A${s.rxMid.toFixed(2)} ${s.ryMid.toFixed(2)} 0 0 1 ${pt(c + 120 - RING_GAP_HALF)}`,
  )
})

/** 白框元素样式:盒子中心 = 头像圆心 */
const ringStyle = computed(() => {
  const s = ringShape.value
  return {
    left: `${s.cx - s.boxW / 2}px`,
    top: `${s.cy - s.boxH / 2}px`,
    width: `${s.boxW}px`,
    height: `${s.boxH}px`,
  }
})

/** viewBox 与盒子 1:1,故无任何缩放失真 */
const ringViewBox = computed(() => `0 0 ${ringShape.value.boxW} ${ringShape.value.boxH}`)

/** 阴影盒子:比白框盒子四周各大 RING_SHADOW_BLUR × 2,用来容下模糊溢出 */
const RING_SHADOW_PAD = RING_SHADOW_BLUR * 2
const shadowBox = computed(() => {
  const s = ringShape.value
  return { w: s.boxW + 2 * RING_SHADOW_PAD, h: s.boxH + 2 * RING_SHADOW_PAD }
})

/** 阴影元素样式:整个元素相对白框向左上平移 RING_SHADOW_OFFSET(偏移交给定位,图形本身居中) */
const shadowStyle = computed(() => {
  const s = ringShape.value
  const b = shadowBox.value
  return {
    left: `${s.cx - RING_SHADOW_OFFSET - b.w / 2}px`,
    top: `${s.cy - RING_SHADOW_OFFSET - b.h / 2}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  }
})

const shadowViewBox = computed(() => `0 0 ${shadowBox.value.w} ${shadowBox.value.h}`)

/** 阴影椭圆画在自己盒子的正中间 */
const shadowGeom = computed(() => ({
  lcx: shadowBox.value.w / 2,
  lcy: shadowBox.value.h / 2,
}))
</script>

<template>
  <div class="chat-avatar chat-avatar--stack">
    <img class="chat-avatar__bg" :style="bgStyle" :src="MATERIALS.avatarBase" alt="" />
    <!-- portrait 头像 wrapper:overflow:hidden + border-radius:50% 形成圆形裁剪夹层,
         内部 img 用 transform: scale 放大收紧裁剪范围(只保留脑袋部分) -->
    <div class="chat-avatar__portrait-wrap" :style="portraitStyle">
      <img
        class="chat-avatar__portrait"
        :src="portraitUrl"
        alt=""
      />
    </div>
    <!-- 阴影层:独立元素(原 bg_snscharentry_head_Line.webp 已弃用)。
         盒子比白框四周各大 RING_SHADOW_PAD 以容下模糊溢出,
         整个元素相对白框向左上平移 RING_SHADOW_OFFSET;图形本身画在盒子正中。 -->
    <svg
      class="chat-avatar__ring-shadow"
      :style="shadowStyle"
      :viewBox="shadowViewBox"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <!-- 模糊半径与 RING_SHADOW_BLUR 一致。
             注:stdDeviation 属性名大小写敏感,模板里无法安全地做动态绑定,故写死。 -->
        <filter id="chatAvatarRingShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
      <ellipse
        :cx="shadowGeom.lcx"
        :cy="shadowGeom.lcy"
        :rx="ringShape.rxMid"
        :ry="ringShape.ryMid"
        fill="none"
        stroke="#000"
        :stroke-width="ringStroke"
        :opacity="RING_SHADOW_OPACITY"
        filter="url(#chatAvatarRingShadow)"
      />
    </svg>

    <!-- 头像框(白框)层:只含三段等分圆弧。
         盒子正好贴住描边外缘 → "盒子中心 = 白框中心"。 -->
    <svg
      class="chat-avatar__ring"
      :style="ringStyle"
      :viewBox="ringViewBox"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g fill="none" stroke="#fff" :stroke-width="ringStroke" stroke-linecap="butt">
        <path v-for="(d, i) in ringPaths" :key="i" :d="d" />
      </g>
    </svg>
  </div>
</template>

<style scoped lang="scss">
.chat-avatar {
  position: absolute;
  transform-origin: 0 0;

  &--stack {
    z-index: 0;
  }

  // bg 层(头像底图):半透明,透出下层背景
  &__bg {
    position: absolute;
    z-index: 0;
    opacity: 0.5;
  }

  // 阴影层:压在底图之上、头像之下 —— 头像会盖住阴影向内的那半,
  // 只留外侧一圈,正是"外阴影"该有的观感
  &__ring-shadow {
    position: absolute;
    z-index: 1;
    pointer-events: none;
  }

  // portrait 头像 wrapper:绝对定位(由 portraitStyle 设置 left/top/width/height),
  // border-radius:50% + overflow:hidden 形成圆形裁剪夹层,内部 img 放大后只露出圆形范围
  &__portrait-wrap {
    position: absolute;
    z-index: 2;
    overflow: hidden;
    border-radius: 50%;
  }

  &__portrait {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    // 头像原图为竖长方形(如 456x564),取上端正方形区域显示;
    // 再 scale 放大收紧裁剪范围,只保留脑袋部分(去掉周围留白)
    object-position: center top;
    transform: scale(1.4);
    transform-origin: center 50%;
  }

  &__ring {
    position: absolute;
    z-index: 3;
  }
}
</style>
