<script setup lang="ts">
// =============================================================================
// 顶部标题 "//BAKER/会话消息"
// -----------------------------------------------------------------------------
// 原点容器:零尺寸 + 绝对定位,仅承载 deco/title 两个绝对定位子元素,
// 不拦截事件命中。
// =============================================================================
import { MATERIALS } from '../../constants/materials'
</script>

<template>
  <header class="header">
    <img class="header__deco" :src="MATERIALS.headerDeco" alt="" />
    <p class="header__title">//BAKER/会话消息</p>
  </header>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

.header {
  @include origin-container;

  &__deco {
    position: absolute;
    left: 43px;
    top: 18.92px;
    width: 63px;
    height: 12px;
  }

  &__title {
    position: absolute;
    left: 43px;
    top: 32.83px;
    line-height: 1;
    white-space: nowrap;
    color: $color-text-primary;
    font-size: $font-size-title;
    font-weight: 500;
    letter-spacing: -0.5px;
    user-select: text;
  }
}
</style>
