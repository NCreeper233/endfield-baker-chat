<script setup lang="ts">
// =============================================================================
// 应用背景层
// -----------------------------------------------------------------------------
// 默认:模糊化的游戏背景图 + 半透明遮罩。
// 自定义:用户通过右侧工具栏"自定义背景"按钮上传图片,替换原背景图
// (customUrl 传入 data URL 时优先渲染,同样覆盖 + 模糊)。
// =============================================================================
import { MATERIALS } from '../../constants/materials'
import { APP_MASK_BG } from '../../constants/colors'

defineProps<{
  /** 自定义背景图(data URL,非空时替代默认游戏背景) */
  customUrl?: string | null
  /**
   * 是否以 absolute 形态铺满所在相对容器(默认 false = fixed 铺满视口)
   *
   * 供 ChatExportStage 离屏画布复用:stage 独立于视口定位,背景需随 stage 铺开。
   */
  absolute?: boolean
}>()

/** 遮罩背景色(inline 注入) */
const maskStyle = {
  background: APP_MASK_BG,
}
</script>

<template>
  <div class="app-bg" :class="{ 'app-bg--absolute': absolute }">
    <img v-if="!customUrl" class="app-bg__img" :src="MATERIALS.bgApp" alt="" />
    <img v-else class="app-bg__img" :src="customUrl" alt="" />
    <div class="app-bg__mask" :style="maskStyle" />
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.app-bg {
  position: fixed;
  inset: 0;
  z-index: 0;

  // 离屏导出画布形态:absolute 铺满 stage(而非 fixed 视口)
  &--absolute {
    position: absolute;
  }

  &__img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(16px);
    transform: scale(1.15);
  }

  &__mask {
    position: absolute;
    inset: 0;
  }
}
</style>
