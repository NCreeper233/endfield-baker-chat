<script setup lang="ts">
// =============================================================================
// 面板上方遮罩横条(PanelTopMask)
// -----------------------------------------------------------------------------
// ChatInput 底部面板渲染同一套"面板上方遮罩横条"几何:与面板同宽,
// 底边贴面板上边缘,向上延展 EDGE_MASK_H;背景同色 + scroll-mask 上缘渐隐,
// 消息滚动贴近面板时先渐隐再消失(与聊天区上缘遮罩观感一致)。
//
// 注意:不得与 PanelShell 合并成单根——面板组件被包在 <Transition> 之内,
// Vue 对多根组件不施加 Transition 类(实测确认,现状即无过渡动画),两者必须
// 以"双根兄弟"结构呈现在消费者模板中才能与现状 DOM 一一对应。
// =============================================================================
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
@use '../../styles/mixins' as *;

// 面板上方遮罩横条:背景同色 + scroll-mask 顶部 0-51px 渐入,
// 51px 以下实心贴面板上缘,不裁右侧
.panel-top-mask {
  position: absolute;
  // 高于 .chat-scroll(z3)压在消息之上;低于面板(z10)
  z-index: 4;
  pointer-events: none;
  user-select: none;
  background: $color-panel-bg;
  @include scroll-mask(0px, 51px, calc(100% - 0px), calc(100% - 0px), 0px);
}
</style>
