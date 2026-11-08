<script setup lang="ts">
// PanelTopMask —— 面板上方的遮罩横条，消息贴近面板时先渐隐再消失
// ⚠️ 不能与 PanelShell 合并成单根：PanelShell 被包在 <Transition> 内，多根组件
// 不会获得 Transition 类，必须保持「双根兄弟」结构。
import { computed, inject, toValue } from 'vue'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'

const props = defineProps<{
  /** 面板顶(px,相对 .chat-area);遮罩底边 = 面板顶,向上延展遮罩高 */
  top: number
}>()

/** 注入几何(面板位置/遮罩高;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 遮罩横条坐标:与面板同宽,底边对齐面板上边缘,向上延展遮罩高 */
const maskStyle = computed(() => ({
  left: `${geom.value.panelLeft}px`,
  width: `${geom.value.panelWidth}px`,
  top: `${props.top - geom.value.panelEdgeMaskH}px`,
  height: `${geom.value.panelEdgeMaskH}px`,
}))
</script>

<template>
  <div class="panel-top-mask" :style="maskStyle" />
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 面板上方遮罩横条:背景同色,从面板顶向上渐隐(底部实心→顶部透明)
.panel-top-mask {
  position: absolute;
  // 高于 .chat-scroll(z3)压在消息之上;低于面板(z10)
  z-index: 4;
  pointer-events: none;
  user-select: none;
  background: $color-panel-bg;
  -webkit-mask-image: linear-gradient(to top, #000 0%, #000 40%, transparent 100%);
  mask-image: linear-gradient(to top, #000 0%, #000 40%, transparent 100%);
}
</style>
