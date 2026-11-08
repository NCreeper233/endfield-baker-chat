<script setup lang="ts">
// DesignCanvas —— 1920×1080 设计稿的等比缩放容器
// 用 zoom 而非 transform: scale，避免影响文字选择与命中测试。
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
