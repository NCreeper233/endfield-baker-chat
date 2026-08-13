<script setup lang="ts">
// =============================================================================
// 等比缩放画布容器
// -----------------------------------------------------------------------------
// 设计稿 1920×1080,根据视口尺寸计算 zoom 系数等比铺满。
// 使用 `zoom` 而非 `transform: scale()`,避免影响文字选择与命中测试。
// =============================================================================
import { useCanvasZoom } from '../../composables/useCanvasZoom'
import { DESIGN_W, DESIGN_H } from '../../constants/design'

const { scale } = useCanvasZoom()
</script>

<template>
  <div class="design-canvas">
    <div
      class="design-canvas__inner"
      :style="{ width: DESIGN_W + 'px', height: DESIGN_H + 'px', zoom: String(scale) }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.design-canvas {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;

  &__inner {
    position: relative;
    flex: none;
    overflow: hidden;
  }
}
</style>
