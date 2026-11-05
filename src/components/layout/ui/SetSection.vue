<script setup lang="ts">
// =============================================================================
// 设置分组(SetSection)
// -----------------------------------------------------------------------------
// 一个分类标题 + 若干设置行。标题是面板里唯一的黄色文字:左侧 4px 黄条、
// 底部一条半透明白细分隔线、右侧三段小装饰 —— 与相邻分类划清界线,
// 又不需要整块卡片包起来。
// =============================================================================

withDefaults(
  defineProps<{
    /** 分组标题 */
    title: string
  }>(),
  {},
)
</script>

<template>
  <section class="pn-sec">
    <div class="pn-sec__head">
      <span class="pn-sec__text">{{ title }}</span>
      <span class="pn-sec__deco" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
    </div>
    <div class="pn-rows">
      <slot />
    </div>
  </section>
</template>
