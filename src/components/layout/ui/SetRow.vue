<script setup lang="ts">
// SetRow —— 一行设置：左标题 + 说明，右控件
// stack 为真时控件换行铺满（输入框 / 文本域 / 整行按钮组用）；off 为真时整行文字压淡。

withDefaults(
  defineProps<{
    /** 标题 */
    label: string
    /** 标题下的补充说明(短句) */
    desc?: string
    /** 提示行(长说明;tone 决定颜色) */
    hint?: string
    /** 提示行语气 */
    tone?: '' | 'ok' | 'warn' | 'keep'
    /** 整行置灰 */
    off?: boolean
    /** 控件独占一行 */
    stack?: boolean
  }>(),
  { desc: '', hint: '', tone: '', off: false, stack: false },
)
</script>

<template>
  <div class="pn-row" :class="{ 'is-off': off, 'pn-row--stack': stack }">
    <!-- 行内底纹:只有左端一小段极淡的等高线 -->
    <div class="pn-row__deco" aria-hidden="true">
      <i class="pn-row__deco-b"></i>
    </div>

    <div class="pn-row__main">
      <span class="pn-row__label">{{ label }}</span>
      <span v-if="desc" class="pn-row__desc">{{ desc }}</span>
      <span v-if="hint" class="pn-hint" :class="tone ? `pn-hint--${tone}` : ''">{{ hint }}</span>
    </div>

    <div class="pn-row__ctl">
      <slot />
    </div>
  </div>
</template>
