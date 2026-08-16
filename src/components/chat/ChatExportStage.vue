<script setup lang="ts">
// =============================================================================
// 离屏聊天导出画布(ChatExportStage)
// -----------------------------------------------------------------------------
// 直接对 DOM 用 html-to-image 截图;不用 SVG
// foreignObject 方案(字体内联 / data URL 转换 / canvas taint 等一堆问题)。
//
// 实现:离屏渲染 ChatArea(export-mode) + AppBackground(absolute),复用主界面
// 同一套渲染逻辑(消息流 / 气泡 / 头像 / 装饰),用 captureRegion(toPng +
// canvas 裁剪)按 region(strip 顶 → 帧底)导出 PNG。
//
// 关键点:
//   - ChatArea(export-mode) 关闭动画/交互,只渲染静态全量消息
//   - 所有消息元素按设计坐标绝对定位(不依赖 chat-scroll 高度撑开),
//     stage 给定明确尺寸即可正确渲染
//   - frameH / region 由 useChatRows 预先计算,provide 给 ChatArea
// =============================================================================
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue'
import { useBubbleMeasure } from '../../composables/useBubbleMeasure'
import { useChatRows } from '../../composables/useChatRows'
import {
  CHAT_SCROLL,
  CHAT_SHOTS,
  DESIGN_W,
  TAIL_SPACE,
} from '../../constants/design'
import {
  chatGeometryKey,
  DESKTOP_GEOM,
} from '../../constants/chatGeometry'
import { captureRegion, type CaptureRegion } from '../../utils/captureImage'
import ChatArea from './ChatArea.vue'
import AppBackground from '../layout/AppBackground.vue'

const props = defineProps<{
  /** 截图倍率(1×/2×/3×/4×),变化即重新截图 */
  scale: number
  /** 自定义背景图(data URL,与应用背景一致) */
  customBgUrl?: string | null
}>()

// 导出画布强制桌面几何:即使当前视口是移动端,导出图仍按 1920 设计稿布局
// (本组件子树内的 ChatArea / useChatRows / ChatInput 等 inject 到的都是桌面几何)
provide(chatGeometryKey, DESKTOP_GEOM)

const { measure } = useBubbleMeasure()

/** rows 仅取 lastRow 用于推算 frameH / region(渲染由 ChatArea 自身完成) */
const { lastRow } = useChatRows({ measure })

/**
 * 聊天框导出高度 = max(设计稿滚动高, 内容高 + 尾部空间)
 *
 * 内容底 = lastRow.bottom(useChatRows 输出已为滚动容器相对坐标,
 * 桌面几何下相对 = 画布 - CHAT_SCROLL.y,与原公式等价),再 + TAIL_SPACE
 * 盖住末尾装饰 + 留白。
 */
const frameH = computed(() =>
  Math.max(
    CHAT_SCROLL.h,
    (lastRow.value?.bottom ?? 0) + TAIL_SPACE,
  ),
)

/** 把帧高 provide 给 ChatArea(export-mode) 的 inject('exportFrameH') */
provide('exportFrameH', frameH)

/** 裁剪区域(相对 stage 设计坐标):strip 顶 → 帧底 */
const region = computed<CaptureRegion>(() => ({
  x: CHAT_SHOTS.strip.x,
  y: CHAT_SHOTS.strip.y,
  w: CHAT_SHOTS.detail.w,
  h: CHAT_SHOTS.detail.y + frameH.value - CHAT_SHOTS.strip.y,
}))

/** stage 尺寸:宽 = 设计稿宽,高 = 帧底(需盖住 region 右下角) */
const stageSize = computed(() => ({
  w: DESIGN_W,
  h: CHAT_SHOTS.detail.y + frameH.value,
}))

/** stage DOM ref(截图目标) */
const stageRef = ref<HTMLElement | null>(null)

/** 截图状态 */
const capturing = ref(false)
const imageSrc = ref<string | null>(null)
const error = ref<string | null>(null)

/** 是否已可截图(stage 挂载 + 渲染稳定) */
const ready = ref(false)

/** 双 rAF:等两次浏览器绘制,确保布局/字体/图片就绪后定格 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/** 挂载后:等渲染稳定 → 标记截图可用 */
onMounted(async () => {
  // 仅用 nextTick 确保 DOM 更新完成;captureRegion 内已包含 nextPaint,
  // 避免重复等待 2 次 rAF。
  await nextTick()
  ready.value = true
})

/** 截图 DOM → 栅格化 PNG(toPng + canvas 裁剪 region) */
async function capture(scale: number): Promise<string | null> {
  const el = stageRef.value
  if (!el) return null
  capturing.value = true
  error.value = null
  try {
    const dataUrl = await captureRegion(el, region.value, scale)
    imageSrc.value = dataUrl
    return dataUrl
  } catch (err) {
    error.value = err instanceof Error ? err.message : '导出失败'
    // 失败时保留上一次成功预览,不清空 imageSrc
    // imageSrc.value = null
    return null
  } finally {
    capturing.value = false
  }
}

// 就绪后按当前倍率截图;倍率变化同样重新截图
watch([ready, () => props.scale], () => {
  if (ready.value) void capture(props.scale)
})

defineExpose({ imageSrc, capturing, error, ready })
</script>

<template>
  <div class="export-stage" aria-hidden="true">
    <div
      ref="stageRef"
      class="export-stage__canvas"
      :style="{ width: stageSize.w + 'px', height: stageSize.h + 'px' }"
    >
      <!-- 背景(模糊图 + 遮罩,absolute 铺满 stage) -->
      <AppBackground :custom-url="customBgUrl" absolute />
      <!-- 聊天区(export-mode:复用主界面同一套渲染,关闭动画/交互) -->
      <ChatArea export-mode />
    </div>
  </div>
</template>

<style scoped lang="scss">
// 离屏画布:fixed 拖出视口、不拦截事件。stage 内坐标 = 设计坐标(zoom=1)。
.export-stage {
  position: fixed;
  left: -10000px;
  top: 0;
  overflow: hidden;
  pointer-events: none;

  &__canvas {
    position: relative;
    overflow: hidden;
  }
}
</style>
