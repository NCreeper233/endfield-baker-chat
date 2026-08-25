<script setup lang="ts">
// =============================================================================
// 首次打开公告弹窗(NoticeDialog)
// -----------------------------------------------------------------------------
// 每次打开应用弹出,直到用户点击"不再提醒"(持久化标记)。
// 点"确认"仅关闭本次,下次仍弹。
// 正文来源: 优先使用 App 从网络公告源(notice.peilika.beer 的 JSON/TXT)读取的
//           内容(prop content/title),读取失败/离线时回退内置常量。
// 样式: 迁移自网站迁移公告弹窗(MigrationNoticeDialog)的 dialog-shell 外壳
//       (用户选定样式:深色直角面板 + 网格纹理 + 居中按钮)。
// =============================================================================
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import {
  NOTICE_TITLE,
  NOTICE_CONTENT,
  NOTICE_CONFIRM_TEXT,
  NOTICE_DISMISS_TEXT,
} from '../../constants/notice'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 弹窗正文(App 从网络公告源读取;缺省回退内置常量) */
  content?: string
  /** 弹窗标题(网络公告源 JSON 的 title;空则回退内置标题) */
  title?: string
}>()

const emit = defineEmits<{
  (e: 'confirm'): void   // 确认(本次关闭)
  (e: 'dismiss'): void   // 不再提醒(永久)
}>()

/** 展示标题:网络 JSON 的 title 优先,为空回退内置常量 */
const displayTitle = computed(() => props.title?.trim() || NOTICE_TITLE)

/** 展示正文:外部公告源优先(响应式跟随),为空/失败时回退内置常量 */
const displayContent = computed(() => props.content?.trim() || NOTICE_CONTENT)

/** 确认:仅关闭本次弹窗(由父级复位 open) */
function onConfirm() {
  if (confirmCooldown.value > 0) return
  emit('confirm')
}

/** 不再提醒:永久关闭(由父级写入持久化标记) */
function onDismiss() {
  if (dismissCooldown.value > 0) return
  emit('dismiss')
}

// ---- 冷却逻辑 ---------------------------------------------------------------
const CONFIRM_COOLDOWN = 5
const DISMISS_COOLDOWN = 10

/** 确定按钮剩余冷却秒数 */
const confirmCooldown = ref(0)
/** 不再提醒按钮剩余冷却秒数 */
const dismissCooldown = ref(0)

let cooldownTimer: ReturnType<typeof setInterval> | null = null

function startCooldown() {
  clearCooldown()
  confirmCooldown.value = CONFIRM_COOLDOWN
  dismissCooldown.value = DISMISS_COOLDOWN
  cooldownTimer = setInterval(() => {
    if (confirmCooldown.value > 0) confirmCooldown.value--
    if (dismissCooldown.value > 0) dismissCooldown.value--
    if (confirmCooldown.value <= 0 && dismissCooldown.value <= 0) {
      clearCooldown()
    }
  }, 1000)
}

function clearCooldown() {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
}

watch(() => props.open, (val) => {
  if (val) startCooldown()
  else clearCooldown()
}, { immediate: true })

onBeforeUnmount(() => clearCooldown())
</script>

<template>
  <Transition name="mn">
    <div v-if="open" class="mn">
      <div class="mn__panel">
        <h2 class="mn__title">{{ displayTitle }}</h2>

        <p class="mn__text">{{ displayContent }}</p>

        <div class="mn__actions">
          <button
            class="mn__btn mn__btn--primary"
            type="button"
            :disabled="confirmCooldown > 0"
            @click="onConfirm"
          >
            {{ confirmCooldown > 0 ? `（${confirmCooldown}秒后可点击）` : NOTICE_CONFIRM_TEXT }}
          </button>
          <button
            class="mn__btn"
            type="button"
            :disabled="dismissCooldown > 0"
            @click="onDismiss"
          >
            {{ dismissCooldown > 0 ? `（${dismissCooldown}秒后可点击）` : NOTICE_DISMISS_TEXT }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 公告弹窗外壳:与迁移公告弹窗同款(dialog-shell 深色直角面板 + 网格纹理)
@include dialog-shell(mn, 380px, 12px);

.mn {
  // 正文保留换行(常量/TXT 中的 \n 生效),长文本可滚动
  &__text {
    white-space: pre-line;
    max-height: 55vh;
    overflow-y: auto;
  }

  // 按钮水平居中(与迁移公告弹窗一致)
  &__actions {
    justify-content: center;
  }

  // 冷却中按钮样式
  &__btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    filter: none;

    &:hover {
      filter: none;
    }
  }
}
</style>
