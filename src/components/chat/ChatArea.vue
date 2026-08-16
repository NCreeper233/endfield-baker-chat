<script setup lang="ts">
// =============================================================================
// 右侧聊天区
// -----------------------------------------------------------------------------
// 职责:
// 1. 渲染顶部聊天条(strip + name + detail + tint)
// 2. 渲染滚动容器 chat-scroll(双 mask + chat-in 动画)
// 3. 计算每条已发送消息的布局(left/top/avatarTop/showAvatar/stack)
// 4. 末尾按需渲染 LoadingBubble(AI 回复加载占位)
// 5. 渲染末尾装饰 + 尾部留白 + 固定底部装饰
//
// AI 聊天:消息流来自 store.playedMessages(当前对话全部消息)。
//   AI 回复加载中(loading 阶段)末尾渲染 LoadingBubble,
//   方向取 pendingAiSpeaker 的 side。
//
// 尺寸过渡链:
//   加载气泡(100×单行高) → 首条 chunk → 文字气泡(prevRect=加载气泡尺寸)
//   → 文字气泡停留 → 下一条 AI 回复的加载气泡(prevRect=上一文字气泡尺寸)
//   每个气泡出现都从上一气泡尺寸平滑过渡到自身尺寸(见 ChatBubble)。
//
// 关键交互:`:key="chatStore.activeSub"` 强制 chat-scroll 重新挂载,
// 触发 chat-in 入场动画(必须保留)。重挂载时所有气泡首屏无 prevRect。
// =============================================================================
import { computed, inject, nextTick, onMounted, ref, toValue, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useBubbleMeasure } from '../../composables/useBubbleMeasure'
import { useChatRows } from '../../composables/useChatRows'
import { CHAT_FRAME } from '../../constants/design'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { MATERIALS } from '../../constants/materials'
import {
  pos,
  // speakerNameStyle, // 【已注释停用】角色名称显示功能整体停用
  type BoxStyle,
} from '../../utils/chatPosition'
import type { ChatRow } from '../../types/chat'
import ChatAvatar from './ChatAvatar.vue'
import ChatMessageRow from './ChatMessageRow.vue'
import LoadingBubble from './LoadingBubble.vue'
import ChatInput from './ChatInput.vue'

const chatStore = useChatStore()

/** 注入几何(默认全局:桌面 = 设计稿,移动端 = 视口;导出模式由 ChatExportStage 覆盖为桌面)。
 * 注意:inject 必须在 setup 期间立即调用;在 computed getter 内惰性调用会在
 * 组件上下文之外求值时返回 undefined(键盘重渲染时触发,导致子树崩溃)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/**
 * 导出模式(离屏截图表现层)
 *
 * - 仅表现差异,不动数据:仍读同一 store。
 * - 关闭 loading 气泡 / 滚动条,滚动区溢出可见 + 高度自适应内容,
 *   聊天框高度与底部装饰跟随内容生长(由 ChatExportStage 测量后 provide 注入)。
 */
const props = defineProps<{
  exportMode?: boolean
}>()

const emit = defineEmits<{
  /** API 未配置时请求打开设置弹窗(上抛到 App) */
  (e: 'open-settings'): void
}>()
/** 导出模式下聊天框高度(px):由 ChatExportStage 测量注入,未注入时用几何层固定高 */
const injectedFrameH = inject<Ref<number> | null>('exportFrameH', null)
const exportFrameH = computed(() => injectedFrameH?.value ?? geom.value.detailH)

/** 聊天框三色装饰条(品红 / 黄 / 青,样式见 .chat-frame__bar--*) */
const CHAT_FRAME_BARS = ['magenta', 'yellow', 'cyan'] as const

/** 顶部聊天条三图点击循环切换(默认 v1) */
const stripVariants = [
  MATERIALS.chatStripV1,
  MATERIALS.chatStripV2,
  MATERIALS.chatStripV3,
] as const
/** 当前聊天条图片下标(存于 store:导出模式 ChatArea 实例共享同一状态) */
const stripSource = computed(() => stripVariants[chatStore.stripVariantIndex % stripVariants.length])

/** 点击聊天条:切换到下一张(导出模式不循环) */
function cycleStrip(): void {
  if (props.exportMode) return
  chatStore.cycleStrip()
}

/**
 * 移动端头图分段素材表(变体 → 左/右段原尺寸,66px 高):
 * 用户切图 chat_strip_v{1,2,3}_{l,r}.png + 公共中段 chat_strip_c.png。
 * 布局:l 左端贴屏左缘、r 右端贴屏右缘、中间空隙用 c 图自适应裁剪(cover)填充,
 * 三张图均不拉伸不变形。
 */
const STRIP_SEGS = [
  { lW: 25, rW: 440, l: MATERIALS.chatStripV1L, r: MATERIALS.chatStripV1R },
  { lW: 19, rW: 458, l: MATERIALS.chatStripV2L, r: MATERIALS.chatStripV2R },
  { lW: 21, rW: 451, l: MATERIALS.chatStripV3L, r: MATERIALS.chatStripV3R },
] as const

/** 当前变体的分段素材(随 stripVariantIndex 切换) */
const stripSeg = computed(
  () => STRIP_SEGS[chatStore.stripVariantIndex % STRIP_SEGS.length],
)

/** 左右段缩放系数:高度统一为几何 stripH(66k),宽度按原宽等比,无拉伸变形 */
const segK = computed(() =>
  geom.value.stripSegmented ? geom.value.stripH / geom.value.stripImgH : 1,
)

/** 左段样式:左端贴屏幕左缘 */
const segLStyle = computed(() => ({
  left: '0px',
  top: '0px',
  width: `${stripSeg.value.lW * segK.value}px`,
  height: `${geom.value.stripH}px`,
}))

/** 右段样式:右端贴屏幕右缘 */
const segRStyle = computed(() => ({
  right: '0px',
  top: '0px',
  width: `${stripSeg.value.rW * segK.value}px`,
  height: `${geom.value.stripH}px`,
}))

/**
 * 中段样式:l/r 之间的空隙,用 chat_strip_c.png 自适应裁剪填充。
 * object-fit: cover —— 保持原比例不变形,超出部分水平裁切(纯色条裁剪无感)。
 */
const segCStyle = computed(() => ({
  left: `${stripSeg.value.lW * segK.value}px`,
  right: `${stripSeg.value.rW * segK.value}px`,
  top: '0px',
  height: `${geom.value.stripH}px`,
}))

const {
  playedMessages,
  isLoading,
  // showCharacterNames, // 【已注释停用】角色名称显示功能整体停用
} = storeToRefs(chatStore)
const { measure } = useBubbleMeasure()

/**
 * 消息行布局管线(rows / LoadingBubble 布局 / 滚动内容底部)
 *
 * layoutContext.fresh 由下方 watcher 翻转(切换对话 → true;首条加载气泡 → false)。
 */
const {
  layoutContext,
  rows,
  loadingLayout,
  showLoadingAvatar,
  endDecoTop,
  padTop,
  chatScrollHeight,
  resolveSpeakerAvatar,
  // resolveSpeakerName, // 【已注释停用】角色名称显示功能整体停用
} = useChatRows({ measure })

// ---- 头像点击:mine 侧切换管理员性别 ----------------------------------------
function onMessageAvatarClick(row: ChatRow) {
  if (row.msg.side === 'mine') {
    chatStore.toggleMyGender()
  }
}

/** chat-scroll 容器 ref(用于自动滚动到底部) */
const scrollRef = ref<HTMLElement | null>(null)

/** 滚动到底部(AI 回复加载 / 新消息追加后) */
function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 消息数变化或 loading 状态变化时,滚动到底部
watch([playedMessages, isLoading], () => {
  scrollToBottom()
})

// 挂载时也滚动一次(切换对话重挂载场景)
onMounted(() => {
  scrollToBottom()
})

/** 聊天条名字的绝对定位样式 */
const stripNameStyle = computed(() => ({
  left: geom.value.stripX + 48 + 'px',
  top: geom.value.stripY + (geom.value.stripH - 24.12) / 2 + 'px',
}))

// ---- 尺寸过渡链状态 -------------------------------------------------------
// 文字气泡出现时,从加载气泡尺寸(100×单行高)过渡到真实尺寸。
// 加载气泡出现时,从宽度 0 展开到 100(自身逻辑,无需 prevRect)。
//
// prevRect 传递规则:
//   - chat-in 期间(layoutContext.fresh=true):无 LoadingBubble,无文字气泡,空状态
//   - chat-in 结束后(layoutContext.fresh=false):文字气泡 prevRect=LOADING_RECT
//
// layoutContext.fresh 清除时机:首条 LoadingBubble 显示时(post flush)
//   保证首条文字气泡 advance 出现时 fresh 已 false,正确拿到 prevRect
// --------------------------------------------------------------------------
watch(
  () => chatStore.activeSub,
  () => {
    layoutContext.fresh = true
  },
  { immediate: true },
)

// isLoading 变为 true(首条 LoadingBubble 显示)后:清除 layoutContext.fresh
// 这样首条文字气泡 advance 时 fresh 已 false,能正确走 prevRect 过渡
watch(
  () => chatStore.isLoading,
  (loading) => {
    if (loading) layoutContext.fresh = false
  },
  { flush: 'post' },
)

/**
 * 起始页面(未选中对话)遮罩 + 占位图的几何
 *
 * 顶端对齐第一张一级卡片顶端,底边保持与正常对话页面 chat_strip_detail
 * 底边相同;宽度 / 左侧沿用 chat_strip_detail,与正常对话页面保持一致。
 * (移动端未选中时走列表视图,不渲染聊天区;数值沿用桌面几何兜底)
 */
const emptyTop = computed(() => geom.value.emptyTop)
const emptyBottom = computed(() => geom.value.emptyBottom)
const emptyHeight = computed(() => emptyBottom.value - emptyTop.value)

/**
 * 聊天区域半透明白色遮罩几何:只覆盖 chat_strip_detail.png 区域
 * (与 detail 矩形完全重合,不含顶部聊天条);高度随 frameHeight
 * (导出模式随内容生长,普通模式固定设计稿高)。
 */
const overlayLeft = computed(() => geom.value.detailX)
const overlayTop = computed(() => geom.value.detailY)
const overlayWidth = computed(() => geom.value.detailW)

// ---- 导出模式表现(exportMode) ---------------------------------------------
// 只改表现不动数据:滚动区溢出可见 + 高度自适应、聊天框随内容生长、
// 底部装饰贴新帧底、末尾装饰仅导出模式显示、动画全部关闭(见文件尾非 scoped 块)。

/** 末尾装饰可见性:仅导出模式显示(正常聊天窗口不显示) */
const endDecoVisible = computed(() => props.exportMode)

/** 末尾装饰左缘(相对滚动容器水平居中) */
const endDecoLeft = computed(() => (geom.value.scrollW - geom.value.endDecoW) / 2)

/** 滚动容器样式:导出模式高度自适应内容(auto,内联不写死高度) */
const scrollStyle = computed<BoxStyle>(() => {
  const g = geom.value
  if (props.exportMode) {
    return {
      left: `${g.scrollX}px`,
      top: `${g.scrollY}px`,
      width: `${g.scrollW}px`,
      height: 'auto',
    }
  }
  return pos(g.scrollX, g.scrollY, g.scrollW, chatScrollHeight.value)
})

/** 聊天框高度:导出模式随内容生长,否则几何层固定高 */
const frameHeight = computed(() =>
  props.exportMode ? exportFrameH.value : geom.value.detailH,
)

/**
 * 底部装饰 top:导出模式跟随新帧底定位
 *
 * 装饰底边恒距帧底 13px(与固定态 bottomDecoY 相对 detail 底边一致),
 * 故帧底移动量 = 装饰移动量,换算为 top = 帧底 + 固定偏移 − 装饰高。
 */
const decoTop = computed(() => {
  if (!props.exportMode) return geom.value.bottomDecoY
  const g = geom.value
  const frameBottom = g.detailY + exportFrameH.value
  // 固定态:装饰底边相对帧底的偏移(负值 = 在帧底上方)
  const decoBottomOffset = g.bottomDecoY + g.bottomDecoH - (g.detailY + g.detailH)
  return frameBottom + decoBottomOffset - g.bottomDecoH
})
</script>

<template>
  <section class="chat-area" :class="{ 'chat-area--export': exportMode }">
    <!-- 顶部聊天条:chat_strip / chat_strip_detail 仅在选中对话时显示,遮罩始终渲染。
         移动端(几何层 stripSegmented):l 贴屏左缘 + c 中段自适应裁剪 + r 贴屏右缘,
         三图均不拉伸不变形;桌面端:单图原样显示 -->
    <div
      v-if="chatStore.activeSub !== null && geom.stripSegmented"
      class="chat-shot chat-shot--strip chat-shot--segmented"
      :style="pos(geom.stripX, geom.stripY, geom.stripW, geom.stripH)"
      @click="cycleStrip"
    >
      <img class="chat-shot__seg chat-shot__seg--l" :style="segLStyle" :src="stripSeg.l" alt="" />
      <img class="chat-shot__seg chat-shot__seg--c" :style="segCStyle" :src="MATERIALS.chatStripC" alt="" />
      <img class="chat-shot__seg chat-shot__seg--r" :style="segRStyle" :src="stripSeg.r" alt="" />
    </div>
    <img
      v-else-if="chatStore.activeSub !== null"
      class="chat-shot chat-shot--strip"
      :style="pos(geom.stripX, geom.stripY, geom.stripW, geom.stripH)"
      :src="stripSource"
      alt=""
      @click="cycleStrip"
    />
    <!-- 聊天框(CSS 绘制,替代 chat_strip_detail.png):框线 + 顶部线缺口 + SVG 凹口 + 三色装饰条
         仅选中对话时显示,层级高于滚动内容(z3)/底部装饰(z4),低于输入面板(z10) -->
    <div
      v-if="chatStore.activeSub !== null"
      class="chat-frame"
      :style="pos(geom.detailX, geom.detailY, geom.detailW, frameHeight)"
    >
      <!-- 底部 / 左 / 右 1.5px 边框线 -->
      <div
        class="chat-frame__box"
        :style="{
          borderLeftWidth: CHAT_FRAME.line + 'px',
          borderRightWidth: CHAT_FRAME.line + 'px',
          borderBottomWidth: CHAT_FRAME.line + 'px',
        }"
      />
      <!-- 顶部左边线(留出右侧缺口) -->
      <div
        class="chat-frame__tl"
        :style="{ right: CHAT_FRAME.gap + 'px', height: CHAT_FRAME.line + 'px' }"
      />
      <!-- 顶部右端小段 -->
      <div
        class="chat-frame__tr"
        :style="{ width: CHAT_FRAME.segW + 'px', height: CHAT_FRAME.line + 'px' }"
      />
      <!-- SVG 凹口:缺口中一条中间下沉的折线 -->
      <div
        class="chat-frame__notch"
        :style="{
          right: CHAT_FRAME.segW + 'px',
          width: CHAT_FRAME.notchW + 'px',
          height: CHAT_FRAME.notchH + 'px',
        }"
      >
        <svg width="100%" height="100%" viewBox="0 0 232 10" preserveAspectRatio="none">
          <path
            d="M0,0 L16,6 L216,6 L232,0"
            fill="none"
            :stroke="CHAT_FRAME.color"
            :stroke-width="CHAT_FRAME.line"
            vector-effect="non-scaling-stroke"
          />
        </svg>
      </div>
      <!-- 三色装饰条:品红 / 黄 / 青,各有发光阴影 + 斜切 clip-path -->
      <div
        class="chat-frame__bars"
        :style="{
          right: CHAT_FRAME.barsRight + 'px',
          height: CHAT_FRAME.barH + 'px',
          gap: CHAT_FRAME.barGap + 'px',
        }"
      >
        <span
          v-for="bar in CHAT_FRAME_BARS"
          :key="bar"
          class="chat-frame__bar"
          :class="'chat-frame__bar--' + bar"
          :style="{ width: CHAT_FRAME.barW + 'px', height: CHAT_FRAME.barH + 'px' }"
        />
      </div>
    </div>
    <!-- 聊天区域半透明白色遮罩层(选中对话时):只盖 chat_strip_detail 背景图
         (倒数第二层,背景图 z2 之上、滚动内容 z3 之下),不拦截事件 -->
    <div
      v-if="chatStore.activeSub !== null"
      class="chat-overlay"
      :style="pos(overlayLeft, overlayTop, overlayWidth, frameHeight)"
    />
    <!-- 起始页遮罩:单独控制,位置大小与 chat_empty_placeholder.png 完全一致,无圆角 -->
    <div
      v-else
      class="chat-overlay chat-overlay--empty"
      :style="pos(geom.detailX, emptyTop, geom.detailW, emptyHeight)"
    />
    <div
      class="chat-tint"
      :class="{ 'chat-tint--gradient': chatStore.activeSub === null }"
      :style="chatStore.activeSub === null
        ? pos(geom.detailX, emptyTop, geom.detailW, emptyHeight)
        : pos(geom.detailX, geom.detailY, geom.detailW, frameHeight)"
    />
    <!-- 起始页占位图:未选中对话时显示,顶端对齐第一张一级卡片,底边贴 chat_strip_detail 底边 -->
    <img
      v-if="chatStore.activeSub === null"
      class="chat-empty-placeholder"
      :style="pos(geom.detailX, emptyTop, geom.detailW, emptyHeight)"
      :src="MATERIALS.chatEmptyPlaceholder"
      alt=""
    />
    <!-- 起始页中心 10×10 圆形点阵装饰(z-index 1,在占位图之下、遮罩层之上;与提示文字同坐标) -->
    <div
      v-if="chatStore.activeSub === null"
      class="chat-empty-dots"
      :style="pos(geom.detailX, emptyTop, geom.detailW, emptyHeight)"
    >
      <svg :width="geom.dotsSize" :height="geom.dotsSize" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
        <circle
          v-for="(_, i) in 100"
          :key="i"
          :cx="(i % 10) + 0.5"
          :cy="Math.floor(i / 10) + 0.5"
          r="0.08"
          fill="rgba(255, 255, 255, 0.2)"
        />
      </svg>
    </div>
    <!-- 起始页提示文字:垂直水平居中于占位图区域,两端 - 不透明,中间文字半透明 -->
    <p
      v-if="chatStore.activeSub === null"
      class="chat-empty-hint"
      :style="pos(geom.detailX, emptyTop, geom.detailW, emptyHeight)"
    >
      <span class="chat-empty-hint__dash">-</span><span class="chat-empty-hint__text">请选择会话</span><span class="chat-empty-hint__dash">-</span>
    </p>
    <!-- 聊天条名字:只读显示动态名 -->
    <p class="chat-strip-name" :style="stripNameStyle">
      {{ chatStore.counterpartName }}
    </p>
    <!-- 聊天窗口右上角装饰:左右镜像,位于遮罩之上、其他元素之下(起始页不显示) -->
    <img
      v-if="chatStore.activeSub !== null"
      class="chat-corner-deco"
      :style="{
        left: geom.cornerDecoX + 'px',
        top: geom.cornerDecoY + 'px',
      }"
      :src="MATERIALS.chatCornerDeco45"
      alt=""
    />

    <!-- 滚动容器:key=activeSub 强制重挂载触发 chat-in 动画(未选中时 key='empty') -->
    <div
      ref="scrollRef"
      :key="chatStore.activeSub ?? 'empty'"
      class="chat-scroll"
      :class="{ 'chat-scroll--export': exportMode }"
      :style="scrollStyle"
    >
      <!-- 角色名称悬浮功能已注释停用:原先的 :resolve-speaker-name / :show-character-names 属性绑定与加载气泡上方的名称 span 一并停用 -->
      <ChatMessageRow
        v-for="row in rows"
        :key="row.msg.id"
        :row="row"
        :resolve-speaker-avatar="resolveSpeakerAvatar"
        @avatar-click="onMessageAvatarClick"
      />

      <!-- AI 回复加载占位 -->
      <template v-if="loadingLayout">
        <ChatAvatar
          v-if="showLoadingAvatar"
          :stack="loadingLayout.stack"
          :base-x="loadingLayout.avatarX"
          :base-y="loadingLayout.avatarTop"
          :portrait-url="loadingLayout.portraitUrl"
          :style="pos(loadingLayout.avatarX, loadingLayout.avatarTop, geom.avatarBox, geom.avatarBox)"
        />
        <!-- 角色名称悬浮:加载气泡上方也显示下一条消息的说话人名(与真实气泡位置一致)【已注释停用】 -->
        <!-- <span
          v-if="showLoadingAvatar && showCharacterNames"
          class="chat-speaker-name"
          :style="speakerNameStyle(loadingLayout.side, loadingLayout.left, loadingLayout.left + loadingLayout.loadW, loadingLayout.top)"
        >{{ loadingLayout.speakerName }}</span> -->
        <LoadingBubble
          :side="loadingLayout.side"
          :left="loadingLayout.left"
          :top="loadingLayout.top"
        />
      </template>

      <img
        v-if="endDecoVisible"
        class="chat-end-deco"
        :style="pos(endDecoLeft, endDecoTop, geom.endDecoW, geom.endDecoH)"
        :src="MATERIALS.chatEndDeco"
        alt=""
      />
      <div class="chat-pad chat-pad--bottom" :style="pos(0, padTop, 1, geom.scrollBottomPad)" />
    </div>

    <!-- 固定底部装饰(在 .chat-area 内,非 .chat-scroll);导出模式跟随新帧底 -->
    <img
      class="chat-bottom-deco"
      :style="pos(geom.bottomDecoX, decoTop, geom.bottomDecoW, geom.bottomDecoH)"
      :src="MATERIALS.chatBottomDeco"
      alt=""
    />

    <!-- AI 聊天输入框(非导出模式且选中对话时显示) -->
    <ChatInput v-if="!exportMode && chatStore.activeSub !== null" @open-settings="emit('open-settings')" />
  </section>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

.chat-area {
  @include origin-container;
}

.chat-scroll {
  position: absolute;
  overflow-y: auto;
  overflow-x: hidden;
  z-index: 3;
  scrollbar-width: thin;
  scrollbar-color: $color-scrollbar-chat transparent;
  animation: chat-in 0.3s ease;
  // 顶部 20-40px 渐隐 + 底部 40-80px 渐隐 + 右侧 14px 渐隐
  @include scroll-mask(20px, 40px, calc(100% - 80px), calc(100% - 40px), 14px);

  // 导出模式:滚动区展开到内容高度(高度由内联样式给 auto),
  // 去除滚动条 / 遮罩渐隐 / 入场动画
  &--export {
    overflow: visible;
    height: auto;
    scrollbar-width: none;
    -webkit-mask-image: none;
    mask-image: none;
    animation: none;
  }
}

.chat-strip-name {
  position: absolute;
  line-height: 1;
  white-space: nowrap;
  color: $color-text-primary;
  font-size: $font-size-name;
  font-weight: 500;
  z-index: 2;
  user-select: text;
}

.chat-tint {
  position: absolute;
  background: $color-chat-tint;
  pointer-events: none;

  // 起始页面:从上到下透明度渐变(顶端 100% → 底端 0%)
  &--gradient {
    background: linear-gradient(
      to bottom,
      $color-chat-tint 0%,
      rgba(255, 255, 255, 0) 100%
    );
  }
}

// 聊天区域半透明白色遮罩层:只盖 chat_strip_detail 背景图
// 倒数第二层:与背景图同 z-index 但 DOM 靠后(渲染其上),滚动内容 z3 / 底部装饰 z4 都在其上方
// 下边两个角圆角(与底部面板 0 0 16px 16px 一致)
.chat-overlay {
  position: absolute;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 0 0 16px 16px;
  pointer-events: none;
  z-index: 2;

  // 起始页遮罩:无圆角(单独控制),背景从上到下渐隐(0.05 → 0)
  &--empty {
    border-radius: 0;
    background: linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.05) 0%,
      rgba(255, 255, 255, 0) 100%
    );
  }
}

.chat-empty-placeholder {
  position: absolute;
  object-fit: none;
  object-position: top center;
  pointer-events: none;
  z-index: 2;
}

.chat-empty-dots {
  position: absolute;
  pointer-events: none;
  z-index: 1;
  // 与提示文字使用相同的偏移(padding-top 30px + translateX(-25px))
  // 但 SVG 用 padding 会影响 viewBox 映射,这里改用 transform 对齐
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 30px;
  transform: translateX(-25px);
  box-sizing: border-box;
}

.chat-empty-hint {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'HarmonyOS Sans SC Medium', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 22px;
  letter-spacing: 2px;
  pointer-events: none;
  z-index: 3;
  padding-top: 30px;
  transform: translateX(-25px);

  &__dash {
    color: $color-text-primary;
  }

  &__text {
    color: rgba(255, 255, 255, 0.7);
  }
}

.chat-shot {
  position: absolute;
  pointer-events: none;

  &--strip {
    z-index: 1;
    // 始终可点击切换三张样式(导出模式由 cycleStrip 函数内守卫拦截)
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
  }

  // 移动端 l/c/r 分段头图:l 贴左、r 贴右、c 中段 cover 自适应裁剪,均不变形。
  // 三段都 pointer-events: none,点击落在容器上触发切换。
  &--segmented {
    overflow: hidden;
  }

  &__seg {
    position: absolute;
    display: block;
    pointer-events: none;
  }

  // 中段:保持原比例、超出部分水平裁切(纯色条裁剪无感)
  &__seg--c {
    object-fit: cover;
  }
}

// 聊天框(CSS 绘制边框,替代 chat_strip_detail.png):
// 框本体几何由 CHAT_FRAME / CHAT_SHOTS.detail 经内联样式注入,此处只处理视觉
.chat-frame {
  position: absolute;
  pointer-events: none;
  // 高于滚动内容(z3)/ 底部装饰(z4),低于输入面板(z10)
  z-index: 5;

  &__box {
    position: absolute;
    inset: 0;
    border-left: $color-chat-frame solid 1.5px;
    border-right: $color-chat-frame solid 1.5px;
    border-bottom: $color-chat-frame solid 1.5px;
    border-radius: 0 0 12px 12px;
  }

  &__tl,
  &__tr {
    position: absolute;
    top: 0;
    background: $color-chat-frame;
  }

  &__tl {
    left: 0;
  }

  &__tr {
    right: 0;
  }

  &__notch {
    position: absolute;
    // 凹口上移 6px,悬于框顶线上方
    top: -6px;

    // 凹口折线描边颜色由内联 :stroke 注入(CHAT_FRAME.color),
    // 避免 scoped 样式在 html-to-image 导出时丢失
  }

  &__bars {
    position: absolute;
    top: 0;
    display: flex;
    gap: 8px;
  }

  &__bar {
    display: block;
    flex-shrink: 0;

    &--magenta {
      background: $color-chat-bar-magenta;
      clip-path: polygon(0 0, 100% 0, 100% 100%, 8px 100%);
      box-shadow: 0 0 8px $color-chat-bar-magenta;
    }

    &--yellow {
      background: $color-chat-bar-yellow;
      box-shadow: 0 0 8px $color-chat-bar-yellow;
    }

    &--cyan {
      background: $color-chat-bar-cyan;
      clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
      box-shadow: 0 0 8px $color-chat-bar-cyan;
    }
  }
}

.chat-bottom-deco {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}

// 聊天窗口右上角装饰图(左右镜像)
.chat-corner-deco {
  position: absolute;
  // 定位(left/top)由几何层内联注入(cornerDecoX/cornerDecoY);
  // scaleX(-1) 以右边为轴翻转保持位置不变
  transform-origin: right center;
  transform: scaleX(-1);
  // 位于 chat_strip / chat_strip_detail 之下,chat-tint 之上
  z-index: 0;
  pointer-events: none;
  // 放大显示
  width: 150px;
  height: auto;
  opacity: 0.2;
}

.chat-end-deco {
  position: absolute;
  pointer-events: none;
  // 对话播完后从上到下入场
  animation: end-deco-in 0.2s ease-out;
}

.chat-pad {
  position: absolute;
  width: 1px;
  pointer-events: none;
}
</style>

<style>
/* 导出模式:全局关闭一切动画/过渡。
   html-to-image 截图瞬间定格,若捕捉到动画中间帧会残留半透明/半展开元素;
   子组件(气泡尺寸过渡等)的作用域样式管不到,
   故用非 scoped 块以 .chat-area--export 后代选择器统一关闭。 */
.chat-area--export * {
  animation: none !important;
  transition: none !important;
}
</style>
