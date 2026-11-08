<script setup lang="ts">
// ExitConfirmDialog —— 退出确认：电脑版点关窗、手机版按返回键、网页版后退时弹出
// 「保存并退出」会先把按钮文字换成「正在保存」，停留片刻再退出（纯视觉过渡）。
import { ref, watch } from 'vue'

import VersionDialogShell from './VersionDialogShell.vue'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void     // 保存并退出
  (e: 'cancel'): void   // 取消退出
}>()

/** 是否处于"正在保存"状态(用于切换按钮文案与旋转圈) */
const saving = ref(false)

// 每次打开时复位状态
watch(
  () => props.open,
  (val) => {
    if (val) saving.value = false
  },
)

/** 点击「保存并退出」:切换为保存中状态并通知父级 */
function onSave(): void {
  if (saving.value) return
  saving.value = true
  emit('save')
}
</script>

<template>
  <VersionDialogShell
    :open="open"
    title="确定要退出吗？"
    kind="alert"
    :closable="!saving"
    :layer="900"
    @close="emit('cancel')"
  >
    <p class="xd__text">退出后会保存当前进度，下次打开可以继续。</p>

    <template #actions>
      <button class="pn-btn pn-btn--light" type="button" :disabled="saving" @click="emit('cancel')">
        <span class="pn-btn__label">取消</span>
      </button>

      <button class="pn-btn" type="button" :disabled="saving" @click="onSave">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label xd__label">
          <span>{{ saving ? '正在保存' : '保存并退出' }}</span>
          <span v-if="saving" class="xd__spinner" aria-hidden="true"></span>
        </span>
      </button>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.xd {
  &__text {
    margin: 0;
    color: #111827;
    font-family: $font-harmony;
    font-size: 14px;
    line-height: 1.75;
  }

  // 保存中:文字 + 旋转圈横排
  &__label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  &__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(254, 252, 252, 0.35);
    border-top-color: #fefcfc;
    border-radius: 50%;
    animation: xd-spin 0.7s linear infinite;
  }
}

@keyframes xd-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
