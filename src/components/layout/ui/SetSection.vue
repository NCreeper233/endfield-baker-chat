<script setup lang="ts">
// SetSection —— 设置分组：分类标题（左侧黄条 + 分隔线 + 小装饰）+ 若干设置行

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
