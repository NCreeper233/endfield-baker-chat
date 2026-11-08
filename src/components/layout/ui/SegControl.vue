<script setup lang="ts">
// SegControl —— 面板设计系统的胶囊分段选择器（开/关、三选一、多档位都用它）
// 值统一用字符串（布尔开关由调用方映射成 'on' / 'off'），选项数直接算成 CSS 变量；
// 指示块位移交给 CSS transition，组件不参与动画计算。

/** 一个分段选项 */
export interface SegOption {
  /** 选项值(与 modelValue 比较) */
  value: string
  /** 选项文字 */
  label: string
}

const props = withDefaults(
  defineProps<{
    /** 当前选中值 */
    modelValue: string
    /** 选项列表(顺序即展示顺序) */
    options: SegOption[]
    /** 是否禁用(当前配置下不生效) */
    disabled?: boolean
    /** 禁用原因(悬停提示) */
    title?: string
    /** 无障碍标签 */
    ariaLabel?: string
    /** 是否按内容宽度收缩(默认铺满控件列) */
    auto?: boolean
  }>(),
  { disabled: false, title: '', ariaLabel: '', auto: false },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

/** 当前选中项下标(值不在列表里时退回 0,避免指示块跑出轨道) */
function currentIndex(): number {
  const i = props.options.findIndex((o) => o.value === props.modelValue)
  return i < 0 ? 0 : i
}

/** 点选:重复点当前项不发事件 */
function pick(value: string): void {
  if (props.disabled || value === props.modelValue) return
  emit('update:modelValue', value)
}
</script>

<template>
  <div
    class="pn-seg"
    :class="{ 'is-disabled': disabled, 'pn-seg--auto': auto }"
    :style="{ '--n': String(options.length), '--i': String(currentIndex()) }"
    :title="title || undefined"
    role="group"
    :aria-label="ariaLabel || undefined"
  >
    <span class="pn-seg__ind" aria-hidden="true"></span>
    <button
      v-for="o in options"
      :key="o.value"
      class="pn-seg__btn"
      :class="{ 'is-on': o.value === modelValue }"
      type="button"
      :disabled="disabled"
      :aria-pressed="o.value === modelValue"
      @click="pick(o.value)"
    >{{ o.label }}</button>
  </div>
</template>
