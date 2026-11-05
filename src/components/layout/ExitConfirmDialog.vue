<script setup lang="ts">
// =============================================================================
// 退出确认弹窗(ExitConfirmDialog)
// -----------------------------------------------------------------------------
// 在各端检测到"想要退出"时弹出,先询问玩家是否退出:
//   电脑版 —— 点击窗口关闭按钮(Electron 主进程拦截后通知渲染进程)
//   手机版 —— 按下系统返回键(Capacitor WebView 触发 popstate)
//   网页版 —— 浏览器后退(同样走 popstate)
//
// 两个按钮:
//   保存并退出 —— 点击后按钮内文字变为「正在保存」并跟一个旋转圈,
//                 停留片刻后执行退出(纯视觉过渡,让关闭过程不显得卡顿)
//   取消       —— 关闭弹窗并停留在应用内
//
// 外观:与公告 / 提醒 / 更新同一副进入弹窗外壳(VersionDialogShell)。
// =============================================================================
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
