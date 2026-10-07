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
// 样式复用 dialog-shell 外壳,与站内其他弹窗保持一致。
// =============================================================================
import { ref, watch } from 'vue'

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
  <Transition name="xd">
    <div v-if="open" class="xd">
      <div class="xd__panel">
        <h2 class="xd__title">确定要退出吗？</h2>

        <p class="xd__text">
          退出后会保存当前进度，下次打开可以继续。
        </p>

        <div class="xd__actions">
          <!-- 保存并退出:点击后变为「正在保存」+ 旋转圈 -->
          <button
            class="xd__btn xd__btn--primary"
            type="button"
            :disabled="saving"
            @click="onSave"
          >
            <span>{{ saving ? '正在保存' : '保存并退出' }}</span>
            <span v-if="saving" class="xd__spinner" aria-hidden="true" />
          </button>

          <!-- 取消:不退出 -->
          <button
            class="xd__btn"
            type="button"
            :disabled="saving"
            @click="emit('cancel')"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 退出确认弹窗外壳:与站内其他弹窗同款
@include dialog-shell(xd, 460px, 14px);

.xd {
  // 说明文字
  &__text {
    margin-bottom: 4px;
  }

  // 按钮行居中
  &__actions {
    justify-content: center;
    margin-top: 22px;
  }

  // 保存中:按钮内容横向排列(文字 + 旋转圈)
  &__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &:disabled {
      cursor: default;
      opacity: 0.85;
    }
  }

  // 旋转加载圈
  // 注意:dialog-shell 会把面板内所有元素强制成直角(border-radius:0 !important),
  // 所以这里必须用 !important 把圆圈还原,否则会显示成一个方块。
  &__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    margin-left: 8px;
    border: 2px solid rgba(28, 28, 28, 0.25);
    border-top-color: #1c1c1c;
    border-radius: 50% !important;
    animation: xd-spin 0.7s linear infinite;
  }
}

@keyframes xd-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
