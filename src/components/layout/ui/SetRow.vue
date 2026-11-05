<script setup lang="ts">
// =============================================================================
// 设置行(SetRow)
// -----------------------------------------------------------------------------
// 面板设计系统里的一行设置:左边标题 + 说明(可带提示行),右边控件。
// 行底有一层装饰(左侧斜纹块 + 等高线 + 右侧斜纹块),与面板整体同一视觉语言。
//
// 用法:
//   <SetRow label="智能消息分条" :hint="xxx">
//     <SegControl ... />
//   </SetRow>
//
// `stack` 为真时控件换到下一行并铺满(输入框 / 文本域 / 整行按钮组用),
// `off` 为真时整行文字压淡(当前配置下不生效的开关)。
// =============================================================================

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
